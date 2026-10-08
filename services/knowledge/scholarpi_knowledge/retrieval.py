import re
import os
import threading
import numpy as np
from .store import BusinessError

MODEL = 'Qwen/Qwen3-Embedding-0.6B'
MODEL_REVISION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
# Standard HTTP downloads are more predictable than Xet's native transfer
# runtime on Windows. This does not alter system networking or credentials.
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '30')


def rrf(lexical, dense):
    result = {}
    for field, ranking in [('lexicalRank', lexical), ('denseRank', dense)]:
        for rank, cid in enumerate(ranking, 1):
            item = result.setdefault(cid, {'score': 0})
            item['score'] += 1 / (60 + rank)
            item[field] = rank
    return sorted(result.items(), key=lambda x: (-x[1]['score'], x[0]))


class Embedding:
    def __init__(self):
        self.model = None
        self.status = 'not_loaded'
        self.error = None
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if self.model is not None:
                return
            self.status = 'loading'
            try:
                from sentence_transformers import SentenceTransformer
                self.model = SentenceTransformer(MODEL, revision=MODEL_REVISION, device='cpu', model_kwargs={'torch_dtype': 'float32'})
                self.model.max_seq_length = 1024
                self.status = 'ready'
                self.error = None
            except Exception as exc:
                self.status = 'unavailable'
                self.error = type(exc).__name__ + ': model download or CPU initialization failed'
                raise BusinessError('RETRYABLE_FAILURE', self.error) from exc

    def encode(self, texts, query=False):
        self.load()
        if query:
            texts = ['Instruct: Given a scientific question, retrieve relevant paper passages and personal notes\nQuery: ' + t for t in texts]
        return np.asarray(self.model.encode(texts, normalize_embeddings=True, show_progress_bar=False, batch_size=8), dtype=np.float32)

    def info(self):
        return dict(status=self.status, model=MODEL, modelRevision=MODEL_REVISION, device='cpu', error=self.error)


def search(store, embedding, query, limit=6, kinds=None, use_graph=True):
    if not query.strip() or not 1 <= limit <= 6:
        raise BusinessError('INVALID_ARGUMENT', 'Query required; evidence limit is 1–6')
    words = re.findall(r'\w+', query, re.UNICODE)
    match = ' OR '.join('"' + w.replace('"', '') + '"' for w in words)
    with store.lock:
        rows = store.db.execute('SELECT c.*,o.kind FROM chunks c JOIN objects o ON o.id=c.object_id WHERE o.deleted=0 AND o.revision=c.revision').fetchall()
        allowed = {r['id']: r for r in rows if not kinds or r['kind'] in kinds}
        lexical_rows = store.db.execute('SELECT id FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) ASC LIMIT 100', (match,)).fetchall() if match else []
        lexical = [r[0] for r in lexical_rows if r[0] in allowed][:10]
        dense = []
        vectors = store.db.execute('SELECT * FROM vectors WHERE model_revision=?', (MODEL_REVISION,)).fetchall()
    if embedding.status == 'ready' and vectors:
        q = embedding.encode([query], query=True)[0]
        scores = [(v['id'], float(np.frombuffer(v['vector'], dtype=np.float32) @ q)) for v in vectors if v['id'] in allowed and v['dim'] == len(q) and v['revision'] == allowed[v['id']]['revision']]
        dense = [cid for cid, _ in sorted(scores, key=lambda x: -x[1])[:10]]
    ranked = rrf(lexical, dense)
    paths = {}
    entrances = []
    if use_graph:
        # Query-conditioned concept entrances; only explicit versioned provenance.
        with store.lock:
            mentions = store.db.execute('SELECT * FROM mentions').fetchall()
            edges = store.db.execute('SELECT * FROM edges').fetchall()
            active = {r['object_id']:r['revision'] for r in allowed.values()}
            names = {m['concept'] for m in mentions if active.get(m['object_id']) == m['revision']}
            entrances = sorted((c for c in names if c in query.lower()), key=lambda c:(-len(c),c))[:3]
            frontier = {}
            for m in mentions:
                if m['concept'] in entrances and active.get(m['object_id']) == m['revision'] and len(frontier) < 10:
                    frontier[m['object_id']] = ['concept:' + m['concept'], m['object_id']]
            for _hop in range(2):
                added = {}
                for e in edges:
                    if len(frontier) + len(added) >= 10:
                        break
                    if e['source'] not in active or e['target'] not in active:
                        continue
                    if not store.source(e['source_id'])['available']:
                        continue
                    for src,dst in [(e['source'],e['target']),(e['target'],e['source'])]:
                        if src in frontier and dst not in frontier and dst not in added:
                            added[dst] = frontier[src] + [e['type'],dst]
                if not added:
                    break
                frontier.update(added)
            candidates = []
            for cid,row in allowed.items():
                if row['object_id'] in frontier:
                    overlap = sum(w.lower() in row['text'].lower() for w in words)
                    if overlap:
                        candidates.append((overlap,cid))
                        paths[cid] = frontier[row['object_id']] + [row['source_id']]
            graph_ids = [cid for _,cid in sorted(candidates,reverse=True)[:10]]
        merged = {cid:dict(rank) for cid,rank in ranked}
        for graph_rank,cid in enumerate(graph_ids,1):
            item=merged.setdefault(cid,{'score':0})
            overlap=sum(w.lower() in allowed[cid]['text'].lower() for w in words)
            item['score']+=overlap/max(1,len(words))/(60+graph_rank)
        ranked=sorted(merged.items(),key=lambda item:(-item[1]['score'],item[0]))
    evidence, seen = [], set()
    for cid, rank in ranked:
        row = allowed[cid]
        source = store.source(row['source_id'])
        if not source['available']:
            continue
        ref = source['sourceRef']
        if (ref['kind'], ref['objectId'], ref['revisionId']) != (row['kind'], row['object_id'], row['revision']):
            # Fail closed for legacy misattributed card chunks until migration;
            # a ranking must never relabel personal text as another object.
            continue
        key = (row['source_id'], source['sourceRef']['revisionId'])
        if key in seen:
            continue
        seen.add(key)
        card = store.get(row['object_id']) if row['kind'] == 'card' else None
        extra = dict(origin=card['origin'], contentCategory='personal_note',
                     **({'originSourceRef': card['sourceRef']} if card.get('sourceRef') else {})) if card else {}
        evidence.append(dict(text=row['text'], sourceRef=source['sourceRef'], **rank, **extra,
                             **({'path': paths[cid]} if cid in paths else {})))
        if len(evidence) >= limit:
            break
    overviews = []
    for oid in dict.fromkeys(e['sourceRef']['objectId'] for e in evidence):
        obj = store.get(oid)
        overviews.append(dict(objectId=oid, title=obj.get('title', obj.get('front','')), revisionId=obj.get('revisionId',str(obj.get('revision'))), keywords=obj.get('keywords', [])))
    return dict(evidence=evidence, items=evidence, navigation=dict(overviews=overviews, topics=entrances, recordSourceIds=[e['sourceRef']['sourceId'] for e in evidence]), indexStatus=embedding.info(), method='fts5+rrf' if not dense else 'fts5+dense+rrf')
