import json
import hashlib
import os
import re
import threading
import time
from pathlib import Path
from .store import Store, BusinessError, uid, now
from .retrieval import Embedding, MODEL_REVISION, search
from .documents import prepare, parse, enrich, render


def normalize_args(args):
    return {re.sub(r'(?<!^)(?=[A-Z])', '_', k).lower(): v for k, v in args.items()}


class KnowledgeService:
    def __init__(self, data=None, start_worker=True):
        self.store = Store(data or os.environ.get('SCHOLARPI_DATA_DIR') or Path(__file__).resolve().parents[3] / 'data')
        self.embedding = Embedding()
        self.stop = threading.Event()
        self.worker = None
        self.workers = []
        if start_worker:
            for kind in ('ingest', 'index', 'enrich'):
                worker = threading.Thread(target=self.work, args=(kind,), daemon=True)
                self.workers.append(worker)
                worker.start()
            self.worker = self.workers[0]
            if self.store.db.execute('SELECT COUNT(*) FROM vectors').fetchone()[0]:
                def warm():
                    try:
                        self.embedding.load()
                    except BusinessError:
                        pass  # FTS remains available and health reports the actual error.
                threading.Thread(target=warm, daemon=True).start()

    def close(self):
        self.stop.set()
        for worker in self.workers:
            worker.join(timeout=2)
        if not any(worker.is_alive() for worker in self.workers):
            self.store.db.close()

    def work(self, kind):
        while not self.stop.wait(.3):
            with self.store.lock:
                jobs = [json.loads(r[0]) for r in self.store.db.execute('SELECT json FROM jobs')]
            for job in jobs:
                if self.stop.is_set():
                    return
                if job['kind'] != kind or job['status'] != 'pending' or job.get('retryAt', 0) > time.time():
                    continue
                self.execute_job(job)

    def execute_job(self, job):
        job.update(status='running', attempts=job.get('attempts', 0) + 1)
        self.store.update_job(job)
        try:
            obj = self.store.get(job['objectId'])
            if obj.get('revisionId', str(obj.get('revision'))) != job['revisionId']:
                job['status'] = 'superseded'
            elif job['kind'] == 'ingest':
                obj['status'] = 'processing'
                with self.store.transaction():
                    self.store.put(obj['paperId'], 'paper', obj['revisionId'], obj)
                job['status'] = 'done' if parse(self.store, obj, self.embedding) else 'superseded'
            elif job['kind'] == 'enrich':
                job['status'] = 'done' if enrich(self.store, obj) else 'superseded'
            else:
                with self.store.lock:
                    chunks = self.store.db.execute('SELECT * FROM chunks WHERE object_id=? AND revision=?', (job['objectId'], job['revisionId'])).fetchall()
                if not chunks:
                    job['status'] = 'done'
                else:
                    vectors = self.embedding.encode([c['text'] for c in chunks])
                    with self.store.transaction():
                        current = self.store.get(job['objectId'])
                        if current.get('revisionId', str(current.get('revision'))) != job['revisionId'] or self.stop.is_set():
                            job['status'] = 'superseded' if not self.stop.is_set() else 'cancelled'
                        else:
                            for chunk, vector in zip(chunks, vectors):
                                self.store.db.execute('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)', (chunk['id'], chunk['revision'], MODEL_REVISION, len(vector), 'float32', vector.tobytes()))
                            job['status'] = 'done'
            job['endedAt'] = now()
        except Exception as exc:
            job['error'] = str(exc) if isinstance(exc, BusinessError) else type(exc).__name__ + ': worker failed'
            job['status'] = 'pending' if job['kind'] == 'index' and job['attempts'] < 3 else 'failed'
            job['retryAt'] = time.time() + 2 ** job['attempts']
            if job['kind'] == 'ingest':
                try:
                    with self.store.transaction():
                        obj = self.store.get(job['objectId'])
                        if obj['revisionId'] == job['revisionId']:
                            obj.update(status='failed', parseWarning=job['error'])
                            self.store.put(obj['paperId'], 'paper', obj['revisionId'], obj)
                except BusinessError:
                    pass
        self.store.update_job(job)

    def paper(self, paper_id, revision_id=None):
        return self.store.get(paper_id, 'paper', revision_id)

    def index_health(self):
        # A loaded model does not imply that every published current chunk was indexed.
        # Keep this snapshot under the Store lock so counts and fingerprint agree.
        with self.store.lock:
            rows = self.store.db.execute('''
                SELECT c.*, v.model_revision, v.dim, v.dtype, v.vector,
                    v.revision AS vector_revision
                FROM chunks c JOIN objects o ON o.id=c.object_id
                LEFT JOIN vectors v ON v.id=c.id
                WHERE o.deleted=0 AND o.revision=c.revision ORDER BY c.id
            ''').fetchall()
            indexed = 0
            fingerprint = hashlib.sha256()
            for row in rows:
                valid = (row['vector_revision'] == row['revision'] and
                         row['model_revision'] == MODEL_REVISION and
                         row['dim'] == 1024 and row['dtype'] == 'float32' and
                         row['vector'] is not None and len(row['vector']) == 4096)
                indexed += int(valid)
                fingerprint.update(json.dumps([
                    row['id'], row['object_id'], row['revision'], row['source_id'],
                    hashlib.sha256(row['text'].encode('utf-8')).hexdigest(),
                    hashlib.sha256(row['vector']).hexdigest() if valid else None,
                ], ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            return dict(activeChunks=len(rows), indexedChunks=indexed,
                        missingChunks=len(rows)-indexed, complete=indexed == len(rows),
                        searchableObjects=len({r['object_id'] for r in rows}),
                        modelRevision=MODEL_REVISION, dimension=1024, dtype='float32',
                        corpusFingerprint=fingerprint.hexdigest())

    def card_status(self, card):
        ref = card.get('sourceRef')
        if not ref:
            card['sourceStatus'] = 'manual'
            return card
        try:
            obj = self.store.get(ref['objectId'])
            if card.get('keyword') and obj.get('noteId') and card['keyword'] not in obj.get('keywords', []):
                card['sourceStatus'] = 'keyword_deleted'
            else:
                card['sourceStatus'] = 'active'
        except BusinessError:
            card['sourceStatus'] = 'source_deleted'
        return card

    def save_note(self, **args):
        def action():
            oid = args.get('note_id') or uid()
            old = None
            if args.get('note_id'):
                old = self.store.get(oid, 'note')
                if str(args.get('expected_revision')) != old['revisionId']:
                    raise BusinessError('CONFLICT', 'Note changed; reload before saving')
            markdown = args.get('markdown', '')
            if not isinstance(markdown, str):
                raise BusinessError('INVALID_ARGUMENT', 'markdown must be a string')
            refs = args.get('source_refs', old.get('sourceRefs', []) if old else [])
            for ref in refs:
                self.store.source(ref['sourceId'], ref['revisionId'])
            revision = uid()
            keywords = list(dict.fromkeys(args.get('keywords', [])))
            item = dict(noteId=oid, revisionId=revision, title=args.get('title', 'Untitled note'), markdown=markdown, content=args.get('content'), sourceRefs=refs, keywords=keywords)
            if args.get('paper_id'):
                self.store.get(args['paper_id'], 'paper')
                item['paperId'] = args['paper_id']
            self.store.clear_index(oid, preserve_edges=True)
            # Updating this note replaces only its own automatic citations.
            # Incoming card/note provenance and explicit user links survive.
            self.store.db.execute('DELETE FROM edges WHERE source=? AND type<>?', (oid, '用户关联'))
            self.store.put(oid, 'note', revision, item)
            ref = dict(sourceId=uid(), kind='note', objectId=oid, revisionId=revision, quote=markdown)
            self.store.add_source(ref, markdown)
            self.store.chunk(oid, revision, ref['sourceId'], markdown, self.embedding.model.tokenizer if self.embedding.model else None)
            for keyword in keywords:
                concept = ' '.join(keyword.lower().split())
                alias = self.store.db.execute('SELECT canonical FROM aliases WHERE alias=?', (concept,)).fetchone()
                concept = alias[0] if alias else concept
                self.store.db.execute('INSERT INTO mentions VALUES(?,?,?,?)', (concept, oid, revision, ref['sourceId']))
            for original in {r['sourceId']: r for r in refs}.values():
                self.store.db.execute('INSERT INTO edges VALUES(?,?,?,?,?)', (uid(), oid, original['objectId'], '引用自', original['sourceId']))
                src = self.store.source(original['sourceId'], original['revisionId'])
                for word in keywords:
                    if word.lower() in src['text'].lower():
                        concept = ' '.join(word.lower().split())
                        mapped = self.store.db.execute('SELECT canonical FROM aliases WHERE alias=?', (concept,)).fetchone()
                        self.store.db.execute('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)', (mapped[0] if mapped else concept, original['objectId'], original['revisionId'], original['sourceId']))
            item['indexJobId'] = self.store.job(oid, revision)['jobId']
            item['ownSourceRef'] = ref
            self.store.put(oid, 'note', revision, item)
            return item
        return self.store.idempotent('save_note', args, action)

    def create_card(self, **args):
        def action():
            if args.get('origin', 'manual') not in ('manual', 'keyword', 'selection'):
                raise BusinessError('INVALID_ARGUMENT', 'Unsupported card origin')
            if not args.get('front') or not args.get('back'):
                raise BusinessError('INVALID_ARGUMENT', 'front and back are required')
            ref = args.get('source_ref')
            if ref:
                self.store.source(ref['sourceId'], ref['revisionId'])
            oid = uid()
            # Only library-compatible empty metadata here; scheduling remains ts-fsrs in Node.
            initial = dict(due=now(), stability=0, difficulty=0, elapsed_days=0, scheduled_days=0, learning_steps=0, reps=0, lapses=0, state=0)
            item = dict(cardId=oid, revision=1, front=args['front'], back=args['back'], origin=args.get('origin', 'manual'), sourceStatus='active' if ref else 'manual', fsrsState=args.get('fsrs_state') or initial)
            if ref:
                item['sourceRef'] = ref
            if args.get('keyword'):
                item['keyword'] = args['keyword']
            if args.get('due'):
                item['due'] = args['due']
            else:
                item['due'] = item['fsrsState']['due']
            self.store.put(oid, 'card', '1', item)
            self.index_card(item)
            return self.card_status(item)
        return self.store.idempotent('create_card', args, action)

    def index_card(self, card):
        """Inside the caller's transaction, publish a card's personal snapshot.

        Keep creating provenance and existing user associations independently.
        The same revision has a stable source identity, including offline retry.
        """
        oid, revision = card['cardId'], str(card['revision'])
        text = card['front'] + '\n' + card['back']
        own = card.get('ownSourceRef')
        if not own or (own.get('kind'), own.get('objectId'), own.get('revisionId')) != ('card', oid, revision):
            own = dict(sourceId=f'card:{oid}:{revision}', kind='card', objectId=oid, revisionId=revision)
        previous = self.store.db.execute('SELECT text FROM sources WHERE id=?', (own['sourceId'],)).fetchone()
        if previous and previous[0] != text:
            raise BusinessError('CONFLICT', 'Card content changed without a new revision')
        self.store.clear_index(oid, preserve_edges=True)
        self.store.add_source(own, text)
        self.store.chunk(oid, revision, own['sourceId'], text, self.embedding.model.tokenizer if self.embedding.model else None)
        concept = ' '.join((card.get('keyword') or card['front']).lower().split())
        mapped = self.store.db.execute('SELECT canonical FROM aliases WHERE alias=?', (concept,)).fetchone()
        self.store.db.execute('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)', (mapped[0] if mapped else concept, oid, revision, own['sourceId']))
        edge_id = 'card-origin:' + oid
        self.store.db.execute('DELETE FROM edges WHERE id=?', (edge_id,))
        original = card.get('sourceRef')
        if original:
            # The edge is asserted by this card; its target is the creating
            # source object. Original SourceRef remains separately navigable.
            self.store.db.execute('INSERT INTO edges VALUES(?,?,?,?,?)',
                (edge_id, oid, original['objectId'], '引用自', own['sourceId']))
        card['ownSourceRef'] = own
        card['indexJobId'] = self.store.job(oid, revision)['jobId']
        self.store.put(oid, 'card', revision, card)

    def review_card(self, **args):
        def action():
            card = self.store.get(args['card_id'], 'card')
            if args.get('expected_revision') is not None and str(args['expected_revision']) != str(card['revision']):
                raise BusinessError('CONFLICT', 'Card revision changed')
            if args.get('rating') not in (1, 2, 3, 4) or not args.get('fsrs_state') or not args.get('due'):
                raise BusinessError('INVALID_ARGUMENT', 'Review requires rating, TS-calculated FSRS state and due')
            card.update(revision=card['revision'] + 1, fsrsState=args['fsrs_state'], due=args['due'])
            self.store.put(card['cardId'], 'card', str(card['revision']), card)
            self.index_card(card)
            rid = uid()
            review = dict(reviewId=rid, cardId=card['cardId'], rating=args['rating'], reviewedAt=args.get('reviewed_at', now()), fsrsVersion=args.get('fsrs_version', 'ts-fsrs-default'), due=args['due'])
            self.store.db.execute('INSERT INTO reviews VALUES(?,?,?)', (rid, card['cardId'], json.dumps(review)))
            return self.card_status(card)
        return self.store.idempotent('review_card', args, action)

    def graph(self, object_id=None, concept=None, max_hops=2, limit=10, **_):
        if not 0 <= max_hops <= 2 or not 1 <= limit <= 10:
            raise BusinessError('INVALID_ARGUMENT', 'Graph allows 0–2 hops and 1–10 objects')
        active = {x['noteId']: x for x in self.store.items('note')}
        active.update({x['paperId']: x for x in self.store.items('paper')})
        active.update({x['cardId']: x for x in self.store.items('card')})
        nodes, edges = {}, []
        frontier = {object_id} if object_id else set()
        with self.store.lock:
            mentions = self.store.db.execute('SELECT * FROM mentions').fetchall()
            raw_edges = self.store.db.execute('SELECT * FROM edges').fetchall()
        chosen = [m for m in mentions if m['object_id'] in active and str(active[m['object_id']].get('revisionId', active[m['object_id']].get('revision'))) == m['revision'] and (not concept or m['concept'] == ' '.join(concept.lower().split()))]
        entrances = list(dict.fromkeys(m['concept'] for m in chosen if not object_id or m['object_id'] == object_id))[:3]
        chosen = [m for m in chosen if m['concept'] in entrances]
        for mention in chosen:
            if len(frontier) >= limit:
                break
            if concept or not object_id:
                frontier.add(mention['object_id'])
        visited = set()
        for hop in range(max_hops + 1):
            current = frontier - visited
            for oid in sorted(current):
                if oid not in active or len(visited) >= limit:
                    continue
                visited.add(oid)
                item = active[oid]
                kind = 'card' if 'cardId' in item else 'note' if 'noteId' in item else 'paper'
                own = item.get('ownSourceRef') or next((p['sourceRef'] for p in item.get('pages', []) if p.get('sourceRef')), None)
                nodes[oid] = dict(id=oid, label=item.get('title', item.get('front', '')), kind=kind,
                    **({'sourceRef': own} if own else {}),
                    **({'originSourceRef': item['sourceRef'], 'origin': item['origin']} if kind == 'card' and item.get('sourceRef') else {}))
                for mention in chosen:
                    if mention['object_id'] != oid:
                        continue
                    cid = 'concept:' + mention['concept']
                    nodes[cid] = dict(id=cid, label=mention['concept'], kind='concept')
                    edges.append(dict(id=cid + ':' + oid, source=cid, target=oid, type='出现于', sourceRef=self.store.source(mention['source_id'])['sourceRef']))
                    if hop < max_hops:
                        frontier.update(m['object_id'] for m in chosen if m['concept'] == mention['concept'])
                for edge in raw_edges:
                    if oid in (edge['source'], edge['target']) and edge['source'] in active and edge['target'] in active:
                        if hop < max_hops:
                            frontier.update((edge['source'], edge['target']))
                        src = self.store.source(edge['source_id'])
                        if src['available']:
                            origin = active[edge['source']].get('sourceRef') if edge['id'].startswith('card-origin:') else None
                            edges.append(dict(id=edge['id'], source=edge['source'], target=edge['target'], type=edge['type'], sourceRef=src['sourceRef'],
                                              **({'originSourceRef': origin} if origin else {})))
        return dict(nodes=list(nodes.values()), edges=list({e['id']: e for e in edges if e['source'] in nodes and e['target'] in nodes}.values()))

    def operation(self, operation, args):
        a = normalize_args(args)
        s = self.store
        if operation == 'health':
            return dict(status='ready', sqlite='wal', embedding=self.embedding.info(),
                        index=self.index_health())
        if operation == 'idempotency_lookup':
            with s.lock:
                row = s.db.execute('SELECT operation,request,result FROM idem WHERE key=?', (a['idempotency_key'],)).fetchone()
            if row and row['operation'] != a['operation']:
                raise BusinessError('CONFLICT', 'Idempotency key belongs to another operation')
            if row and a.get('client_request_hash') and row['request'] != a['client_request_hash']:
                raise BusinessError('CONFLICT', 'Idempotency key reused for different input')
            return dict(found=bool(row), **({'result': json.loads(row['result'])} if row else {}))
        if operation == 'remember_turn':
            return s.idempotent('reading_turn', a, lambda: a['result'])
        if operation == 'list_papers':
            return dict(items=s.items('paper'))
        if operation == 'list_sessions':
            return dict(items=s.items('session'))
        if operation == 'list_runs':
            return dict(items=s.items('run'))
        if operation == 'ingest':
            with s.lock:
                paper, job = prepare(s, a['path'], a.get('title'), a.get('paper_id'), a.get('original_name'))
                duplicate = job is None
                if not job:
                    jobs = [json.loads(r[0]) for r in s.db.execute('SELECT json FROM jobs WHERE object_id=? AND revision=?', (paper['paperId'], paper['revisionId']))]
                    job = next((j for j in jobs if j['kind'] == 'ingest'), None)
            return dict(paperId=paper['paperId'], revisionId=paper['revisionId'], jobId=job['jobId'] if job else None,
                        duplicate=duplicate, fileHash=paper['fileHash'], hashAlgorithm='SHA-256', paper=paper)
        if operation == 'get_job':
            return s.get_job(a.get('job_id') or a.get('id'))
        if operation in ('get_paper', 'paper_overview'):
            paper = self.paper(a['paper_id'], a.get('revision_id'))
            if operation == 'paper_overview':
                metadata = {k:v for k,v in paper.items() if k not in ('pages','documentTree')}
                tree = dict(sections=paper.get('sections', []), pages=[dict(page=p['page'], sourceRef=p['sourceRef'], scanned=p['scanned'], imagesAvailable=True) for p in paper.get('pages', [])])
                return dict(paper=metadata, documentTree=tree, sourceRefs=[p['sourceRef'] for p in paper.get('pages', [])])
            return paper
        if operation == 'read_paper_text':
            paper = self.paper(a['paper_id'], a.get('revision_id'))
            start, end = a.get('start_page', 1), a.get('end_page', paper['pageCount'])
            if not 1 <= start <= end <= paper['pageCount']:
                raise BusinessError('INVALID_ARGUMENT', 'Invalid physical page range')
            pages = [p for p in paper.get('pages', []) if start <= p['page'] <= end]
            return dict(text='\n\n'.join(f"[Page {p['page']}; source {p['sourceRef']['sourceId']}]\n" + ('[模型转写；须核对原图]\n' if p.get('visionProcessed') else '') + '\n'.join(f"[source:{b['sourceRef']['sourceId']}] {b['text']}" for b in p['blocks']) for p in pages), sourceRefs=[p['sourceRef'] for p in pages]+[b['sourceRef'] for p in pages for b in p['blocks']], coverage=paper['coverage'], startPage=start, endPage=end, complete=len(pages) == end - start + 1 and not any(p['scanned'] and not p.get('visionProcessed') for p in pages))
        if operation in ('get_page', 'read_page'):
            paper = self.paper(a['paper_id'], a.get('revision_id'))
            return render(s, a['paper_id'], paper['revisionId'], a['page'], a.get('bbox'))
        if operation == 'get_pdf':
            paper = self.paper(a['paper_id'], a.get('revision_id'))
            return dict(path=str(s.data / 'pdf' / (paper['fileHash'] + '.pdf')), mimeType='application/pdf')
        if operation == 'vision_get':
            try:
                return dict(job=s.get(a['paper_id'] + ':' + a['revision_id'], 'vision'))
            except BusinessError:
                return dict(job=None)
        if operation == 'vision_put':
            job = args['job']
            with s.transaction():
                s.put(job['paperId'] + ':' + job['revisionId'], 'vision', job['revisionId'], job)
            return job
        if operation == 'vision_page':
            paper = self.paper(a['paper_id'], a['revision_id'])
            if self.paper(a['paper_id'])['revisionId'] != a['revision_id']:
                raise BusinessError('CONFLICT', 'Scan job revision is stale')
            page = next((p for p in paper.get('pages', []) if p['page'] == a['page']), None)
            if not page or not page['scanned']:
                raise BusinessError('INVALID_ARGUMENT', 'Only scanned pages accept explicit model transcription')
            page.update(text=a['text'], visionProcessed=True, transcription='model; verify against original image')
            ref = page['sourceRef']
            page['blocks'] = [dict(text=a['text'], sourceRef=ref)]
            paper['coverage']['pendingPages'] = [n for n in paper['coverage']['pendingPages'] if n != a['page']]
            paper['coverage']['processedPages'] = sorted(set(paper['coverage']['processedPages'] + [a['page']]))
            paper['status'] = 'ready' if not paper['coverage']['pendingPages'] else 'partial'
            with s.transaction():
                s.add_source(ref, a['text'])
                s.put(paper['paperId'], 'paper', paper['revisionId'], paper)
                s.chunk(paper['paperId'], paper['revisionId'], ref['sourceId'], a['text'], self.embedding.model.tokenizer if self.embedding.model else None)
                s.job(paper['paperId'], paper['revisionId'])
            return dict(page=a['page'],sourceRef=ref,coverage=paper['coverage'])
        if operation == 'get_source':
            return s.source(a.get('source_id') or a.get('id'), a.get('revision_id'))
        if operation == 'validate_sources':
            items = []
            for ref in a.get('source_refs', []):
                sid = ref.get('sourceId')
                try:
                    src = s.source(sid, ref.get('revisionId'))
                    saved = src['sourceRef']
                    exact = all(ref.get(k) == saved.get(k) for k in ('kind', 'objectId', 'revisionId'))
                    position = all(k not in ref or ref[k] == saved.get(k) for k in ('page', 'bbox', 'blockId'))
                    quote = ref.get('quote')
                    quote_match = not quote or ' '.join(__import__('unicodedata').normalize('NFKC', quote).split()) in ' '.join(__import__('unicodedata').normalize('NFKC', src['text']).split())
                    valid = src['available'] and exact and position and quote_match
                    items.append(dict(sourceId=sid, valid=valid, status=src['sourceStatus'] if valid else 'invalid_reference', ref=saved, text=src['text']))
                except (BusinessError, TypeError):
                    items.append(dict(sourceId=sid, valid=False, status='source_not_found', ref=ref, text=''))
            return dict(items=items)
        if operation in ('delete_paper', 'delete_note', 'delete_card'):
            kind = operation.removeprefix('delete_')
            oid = a.get(kind + '_id') or a.get('id')
            with s.transaction():
                item = s.get(oid, kind)
                item['deleted'] = True
                if kind == 'paper':
                    item['status'] = 'deleted'
                s.put(oid, kind, item.get('revisionId', item.get('revision')), item, True)
                s.clear_index(oid)
            return dict(deleted=True)
        if operation == 'list_notes':
            return dict(items=[n for n in s.items('note') if not a.get('paper_id') or n.get('paperId') == a['paper_id']])
        if operation == 'get_note':
            return s.get(a.get('note_id') or a.get('id'), 'note', a.get('revision_id'))
        if operation == 'get_card':
            return self.card_status(s.get(a.get('card_id') or a.get('id'), 'card', a.get('revision_id')))
        if operation == 'save_note':
            return self.save_note(**a)
        if operation == 'list_cards':
            items = [self.card_status(c) for c in s.items('card')]
            if a.get('due_only'):
                items = [c for c in items if not c.get('due') or c['due'] <= now()]
            return dict(items=items)
        if operation == 'create_card':
            return self.create_card(**a)
        if operation == 'review_card':
            return self.review_card(**a)
        if operation == 'edit_card':
            with s.transaction():
                card = s.get(a['card_id'], 'card')
                if a.get('expected_revision') is not None and str(a['expected_revision']) != str(card['revision']):
                    raise BusinessError('CONFLICT', 'Card changed')
                card.update(front=a.get('front', card['front']), back=a.get('back', card['back']), revision=card['revision'] + 1)
                s.put(card['cardId'], 'card', str(card['revision']), card)
                self.index_card(card)
                return self.card_status(card)
        if operation in ('graph', 'query_source_graph'):
            return self.graph(**a)
        if operation == 'search_knowledge':
            return search(s, self.embedding, a['query'], a.get('limit', 6), a.get('kinds') or a.get('object_types'), a.get('use_graph', True))
        if operation in ('session_get', 'run_get'):
            kind = operation.split('_')[0]
            return s.get(a.get(kind + '_id') or a.get('id'), kind)
        if operation in ('session_put', 'run_put'):
            kind = operation.split('_')[0]
            item = a.get('snapshot') or a.get('session') or a.get('run') or args
            oid = item.get(kind + 'Id') or a.get(kind + '_id')
            if not oid:
                raise BusinessError('INVALID_ARGUMENT', 'Metadata ID required')
            with s.transaction():
                s.put(oid, kind, str(item.get('revision', 1)), item)
            return item
        if operation == 'list_interrupted':
            return dict(items=[r for r in s.items('run') if r['status'] == 'interrupted'])
        if operation == 'index_retry':
            job = s.get_job(a['job_id'])
            if job['status'] not in ('failed', 'interrupted', 'cancelled'):
                raise BusinessError('CONFLICT', 'Job is not retryable')
            job.update(status='pending', attempts=0, retryAt=0)
            s.update_job(job)
            return job
        if operation == 'cancel_job':
            job = s.get_job(a['job_id'])
            if job['status'] == 'running':
                raise BusinessError('CONFLICT', 'Parsing is atomic; running work cannot be cancelled mid-commit')
            if job['status'] == 'pending':
                job['status'] = 'cancelled'
                s.update_job(job)
            return job
        if operation == 'merge_concept':
            alias, canonical = ' '.join(a['alias'].lower().split()), ' '.join(a['canonical'].lower().split())
            with s.transaction():
                s.db.execute('INSERT OR REPLACE INTO aliases VALUES(?,?)', (alias, canonical))
                # Rebuild from original user keywords so a mistaken mapping is reversible.
                s.db.execute('DELETE FROM mentions')
                for note in s.items('note'):
                    for word in note.get('keywords', []):
                        name = ' '.join(word.lower().split())
                        mapped = s.db.execute('SELECT canonical FROM aliases WHERE alias=?', (name,)).fetchone()
                        name = mapped[0] if mapped else name
                        ref = note.get('ownSourceRef')
                        if ref:
                            s.db.execute('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)', (name, note['noteId'], note['revisionId'], ref['sourceId']))
                        for original in note.get('sourceRefs', []):
                            src = s.source(original['sourceId'], original['revisionId'])
                            if src['available'] and word.lower() in src['text'].lower():
                                s.db.execute('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)', (name, original['objectId'], original['revisionId'], original['sourceId']))
                for card in s.items('card'):
                    ref = card.get('ownSourceRef')
                    if ref:
                        name = ' '.join((card.get('keyword') or card['front']).lower().split())
                        mapped = s.db.execute('SELECT canonical FROM aliases WHERE alias=?', (name,)).fetchone()
                        s.db.execute('INSERT OR IGNORE INTO mentions VALUES(?,?,?,?)',
                            (mapped[0] if mapped else name, card['cardId'], str(card['revision']), ref['sourceId']))
            return dict(alias=alias, canonical=canonical)
        if operation == 'link_objects':
            source, target, ref = a['source_object_id'], a['target_object_id'], a['source_ref']
            if source == target or ref.get('objectId') != source:
                raise BusinessError('INVALID_ARGUMENT', 'Relation requires distinct objects and a source belonging to the source object')
            s.get(source); s.get(target)
            src = s.source(ref['sourceId'], ref['revisionId'])
            if not src['available']:
                raise BusinessError('SOURCE_NOT_FOUND', 'Relation source is unavailable')
            with s.transaction():
                eid = uid()
                s.db.execute('INSERT INTO edges VALUES(?,?,?,?,?)', (eid, source, target, '用户关联', ref['sourceId']))
            return dict(id=eid, source=source, target=target, type='用户关联', sourceRef=src['sourceRef'])
        raise BusinessError('INVALID_ARGUMENT', 'Unknown operation')
