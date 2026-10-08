import hashlib
import shutil
import json
from pathlib import Path
import pymupdf
from .store import BusinessError, uid


def confined_upload(store, path):
    candidate = Path(path).resolve()
    uploads = (store.data / 'uploads').resolve()
    if not candidate.is_relative_to(uploads) or not candidate.is_file() or candidate.suffix.lower() != '.pdf':
        raise BusinessError('INVALID_ARGUMENT', 'PDF must be an existing file in app/data/uploads')
    if candidate.stat().st_size > 100 * 1024 * 1024:
        raise BusinessError('INVALID_ARGUMENT', 'PDF exceeds 100 MiB; split into volumes')
    return candidate


def prepare(store, path, title=None, paper_id=None, original_name=None):
    path = confined_upload(store, path)
    original_name = Path(original_name).name if original_name else path.name
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    for paper in store.items('paper'):
        if paper['fileHash'] == digest:
            return paper, None
    with store.lock:
        history = store.db.execute("SELECT r.json FROM revisions r JOIN objects o ON o.id=r.id WHERE o.kind='paper' AND o.deleted=0").fetchall()
    for row in history:
        previous = json.loads(row[0])
        if previous.get('fileHash') == digest:
            return previous, None
    with pymupdf.open(path) as pdf:
        if pdf.is_encrypted or not 1 <= len(pdf) <= 300:
            raise BusinessError('INVALID_ARGUMENT', 'Encrypted PDF or unsupported page count (1–300)')
        count = len(pdf)
    pdfdir = store.data / 'pdf'
    pdfdir.mkdir(exist_ok=True)
    target = pdfdir / (digest + '.pdf')
    if not target.exists():
        shutil.copyfile(path, target)
    if paper_id:
        store.get(paper_id, 'paper')
    else:
        # Same filename is an explicit new revision of this local document identity.
        existing = next((p for p in store.items('paper') if p.get('originalName') == original_name), None)
        paper_id = existing['paperId'] if existing else uid()
    revision = uid()
    paper = dict(paperId=paper_id, revisionId=revision, title=title or path.stem, fileHash=digest, pageCount=count,
                 status='queued', coverage=dict(processedPages=[], pendingPages=list(range(1, count + 1)), scannedPages=[]), sections=[], originalName=original_name)
    with store.transaction():
        store.clear_index(paper_id)
        store.put(paper_id, 'paper', revision, paper)
        job = store.job(paper_id, revision, 'ingest')
    return paper, job


def reading_blocks(page):
    """Keep paragraphs intact; order clear two-column bands left then right.

    This conservative geometric fallback does not claim arbitrary-layout OCR.
    Wide headings/paragraphs separate bands; ambiguous layouts retain PyMuPDF order.
    """
    blocks = [b for b in page.get_text('blocks', sort=True) if b[6] == 0 and b[4].strip()]
    mid = page.cropbox.width / 2
    wide = [b for b in blocks if b[0] < mid - 10 and b[2] > mid + 10]
    columns = [b for b in blocks if b not in wide]
    left = [b for b in columns if (b[0] + b[2]) / 2 < mid]
    right = [b for b in columns if (b[0] + b[2]) / 2 >= mid]
    if len(left) < 2 or len(right) < 2 or max(b[2] for b in left) > min(b[0] for b in right):
        return blocks
    result = []
    remaining = columns[:]
    for anchor in sorted(wide, key=lambda b: (b[1], b[0])):
        band = [b for b in remaining if (b[1] + b[3]) / 2 < (anchor[1] + anchor[3]) / 2]
        result.extend(sorted(band, key=lambda b: ((b[0] + b[2]) / 2 >= mid, b[1], b[0])))
        remaining = [b for b in remaining if b not in band]
        result.append(anchor)
    result.extend(sorted(remaining, key=lambda b: ((b[0] + b[2]) / 2 >= mid, b[1], b[0])))
    return result


def published_pages_complete(paper):
    pages = paper.get('pages', [])
    return (len(pages) == paper['pageCount'] and
            {p.get('page') for p in pages} == set(range(1, paper['pageCount'] + 1)) and
            all(p.get('sourceRef') and isinstance(p.get('blocks'), list) and
                all(b.get('sourceRef') for b in p['blocks']) and
                all(ref.get('kind') == 'paper' and ref.get('objectId') == paper['paperId'] and
                    ref.get('revisionId') == paper['revisionId'] and ref.get('page') == p['page']
                    for ref in [p['sourceRef']] + [b['sourceRef'] for b in p['blocks']]) for p in pages))


def repair_paper_index(store, paper, embedding):
    """Repair only current published paper's derived index; retain every source.

    Called inside a Store transaction. Existing canonical chunk boundaries remain
    unchanged even when a tokenizer has since warmed. Empty/scanned pages count
    as published pages, not a reason to generate new SourceRefs.
    """
    from .retrieval import MODEL_REVISION
    if not published_pages_complete(paper):
        raise BusinessError('INVALID_ARGUMENT', 'Complete published pages required for index repair')
    current = store.get(paper['paperId'], 'paper')
    if current['revisionId'] != paper['revisionId']:
        raise BusinessError('CONFLICT', 'Paper revision changed before index repair')
    oid, revision = paper['paperId'], paper['revisionId']
    blocks = {b['sourceRef']['sourceId']: b for p in paper['pages'] for b in p['blocks']}
    removed = 0
    for row in store.db.execute('SELECT id,source_id FROM chunks WHERE object_id=? AND revision=?', (oid, revision)).fetchall():
        if row['source_id'] not in blocks:
            store.db.execute('DELETE FROM fts WHERE id=?', (row['id'],))
            store.db.execute('DELETE FROM vectors WHERE id=?', (row['id'],))
            store.db.execute('DELETE FROM chunks WHERE id=?', (row['id'],))
            removed += 1
    added = 0
    for page in paper['pages']:
        refs = [(page['sourceRef'], page['text'])] + [(b['sourceRef'], b['text']) for b in page['blocks']]
        for ref, text in refs:
            if not store.db.execute('SELECT 1 FROM sources WHERE id=?', (ref['sourceId'],)).fetchone():
                store.add_source(ref, text)
        for block in page['blocks']:
            sid = block['sourceRef']['sourceId']
            if not store.db.execute('SELECT 1 FROM chunks WHERE object_id=? AND revision=? AND source_id=?', (oid, revision, sid)).fetchone():
                store.chunk(oid, revision, sid, block['text'], embedding.model.tokenizer if embedding.model else None)
                added += 1
    chunks = store.db.execute('SELECT * FROM chunks WHERE object_id=? AND revision=?', (oid, revision)).fetchall()
    for chunk in chunks:
        if not store.db.execute('SELECT 1 FROM fts WHERE id=?', (chunk['id'],)).fetchone():
            store.db.execute('INSERT INTO fts VALUES(?,?)', (chunk['id'], chunk['text']))
    missing = sum(not store.db.execute('SELECT 1 FROM vectors WHERE id=? AND revision=? AND model_revision=? AND dtype=? AND dim=1024 AND length(vector)=4096',
        (c['id'], revision, MODEL_REVISION, 'float32')).fetchone() for c in chunks)
    job = None
    if missing:
        jobs = [json.loads(r[0]) for r in store.db.execute('SELECT json FROM jobs WHERE object_id=? AND revision=?', (oid, revision))]
        candidates = [j for j in jobs if j['kind'] == 'index']
        job = next((j for j in candidates if j['status'] in ('pending', 'running')), None)
        if job is None:
            job = next((j for j in candidates if j['status'] in ('interrupted', 'failed', 'cancelled')), None)
            if job:
                job.update(status='pending', attempts=0)
                for key in ('error', 'retryAt', 'endedAt'):
                    job.pop(key, None)
                store.db.execute('UPDATE jobs SET json=? WHERE id=?', (json.dumps(job), job['jobId']))
            else:
                job = store.job(oid, revision)
    if paper.get('status') in ('processing', 'queued', 'failed'):
        paper['status'] = 'partial' if paper.get('parseWarning') or paper['coverage']['pendingPages'] else 'ready'
        store.put(oid, 'paper', revision, paper)
    return dict(paperId=oid, revisionId=revision, removedStaleChunks=removed,
                addedBlockIndexes=added, chunks=len(chunks), missingVectors=missing,
                indexJobId=job['jobId'] if job else None)


def parse(store, paper, embedding):
    with store.transaction():
        current = store.get(paper['paperId'], 'paper')
        if current['revisionId'] != paper['revisionId']:
            return False
        if published_pages_complete(current):
            repair_paper_index(store, current, embedding)
            return True
    path = store.data / 'pdf' / (paper['fileHash'] + '.pdf')
    structure = None
    issue = 'Docling structure processing; PyMuPDF text and page sources available'
    pages = []
    refs = []
    sections = []
    with pymupdf.open(path) as pdf:
        for number, page in enumerate(pdf, 1):
            blocks = []
            for n, block in enumerate(reading_blocks(page)):
                if block[6] != 0 or not block[4].strip():
                    continue
                rect = pymupdf.Rect(block[:4]) * page.rotation_matrix
                bbox = [max(0, min(1, rect.x0 / page.rect.width)), max(0, min(1, rect.y0 / page.rect.height)), max(0, min(1, rect.x1 / page.rect.width)), max(0, min(1, rect.y1 / page.rect.height))]
                ref = dict(sourceId=uid(), kind='paper', objectId=paper['paperId'], revisionId=paper['revisionId'], page=number, bbox=bbox, blockId=f'p{number}b{n}', quote=block[4].strip())
                blocks.append(dict(text=block[4], sourceRef=ref))
                refs.append(ref)
            text = '\n'.join(b['text'] for b in blocks)
            page_ref = dict(sourceId=uid(), kind='paper', objectId=paper['paperId'], revisionId=paper['revisionId'], page=number, bbox=[0, 0, 1, 1], blockId=f'p{number}')
            pages.append(dict(page=number, text=text, blocks=blocks, sourceRef=page_ref, scanned=len(text.strip()) < 20, rotation=page.rotation))
        sections = [dict(title=t[1], page=t[2]) for t in pdf.get_toc() if t[2] > 0]
    if structure:
        for text in structure.get('texts', []):
            if text.get('label') in ('section_header', 'title') and text.get('prov'):
                sections.append(dict(title=text.get('text', ''), page=text['prov'][0]['page_no']))
    paper.update(status='partial' if issue or any(p['scanned'] for p in pages) else 'ready', sections=sections,
                 coverage=dict(processedPages=[p['page'] for p in pages if not p['scanned']], pendingPages=[p['page'] for p in pages if p['scanned']], scannedPages=[p['page'] for p in pages if p['scanned']]),
                 parser='docling+pymupdf' if structure else 'pymupdf-fallback', parseWarning=issue, pages=pages, documentTree=structure)
    with store.transaction():
        current = store.get(paper['paperId'], 'paper')
        if current['revisionId'] != paper['revisionId']:
            return False
        # Another attempt may have published this revision while PDF extraction
        # ran. Its immutable sources win; discard this attempt's unpublished IDs.
        if published_pages_complete(current):
            repair_paper_index(store, current, embedding)
            return True
        store.put(paper['paperId'], 'paper', paper['revisionId'], paper)
        for p in pages:
            store.add_source(p['sourceRef'], p['text'])
            for block in p['blocks']:
                store.add_source(block['sourceRef'], block['text'])
                store.chunk(paper['paperId'], paper['revisionId'], block['sourceRef']['sourceId'], block['text'], embedding.model.tokenizer if embedding.model else None)
        store.job(paper['paperId'], paper['revisionId'])
        store.job(paper['paperId'], paper['revisionId'], 'enrich')
    return True


def enrich(store, paper):
    path = store.data / 'pdf' / (paper['fileHash'] + '.pdf')
    sections = list(paper.get('sections', []))
    structure = None
    issue = None
    # Publish complete text and immutable page/block sources before a cold
    # Docling model download. Enrichment never replaces existing SourceRefs.
    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
        options = PdfPipelineOptions(do_ocr=False, do_table_structure=True)
        converted = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options, backend=PyPdfiumDocumentBackend)}).convert(path)
        structure = converted.document.export_to_dict()
        issue = None
        for text in structure.get('texts', []):
            if text.get('label') in ('section_header', 'title') and text.get('prov'):
                sections.append(dict(title=text.get('text', ''), page=text['prov'][0]['page_no']))
    except Exception as exc:
        issue = type(exc).__name__ + ': Docling failed; PyMuPDF text fallback used'
    paper.update(status='partial' if issue or paper['coverage']['pendingPages'] else 'ready',
                 sections=sections, documentTree=structure, parser='docling+pymupdf' if structure else 'pymupdf-fallback', parseWarning=issue)
    with store.transaction():
        current = store.get(paper['paperId'], 'paper')
        if current['revisionId'] != paper['revisionId']:
            return False
        # Scan transcription may have committed while Docling enriched structure.
        paper['pages'] = current['pages']
        paper['coverage'] = current['coverage']
        paper['status'] = 'partial' if issue or paper['coverage']['pendingPages'] else 'ready'
        store.put(paper['paperId'], 'paper', paper['revisionId'], paper)
    return True


def render(store, paper_id, revision_id, page, bbox=None):
    paper = store.get(paper_id, 'paper', revision_id)
    if not isinstance(page, int) or not 1 <= page <= paper['pageCount']:
        raise BusinessError('INVALID_ARGUMENT', 'Page outside document')
    if bbox and (len(bbox) != 4 or not all(0 <= v <= 1 for v in bbox) or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]):
        raise BusinessError('INVALID_ARGUMENT', 'bbox must be ordered normalized coordinates')
    folder = store.data / 'rendered'
    folder.mkdir(exist_ok=True)
    key = hashlib.sha256(str((paper['fileHash'], page, bbox)).encode()).hexdigest()
    target = folder / (key + '.png')
    if not target.exists():
        with pymupdf.open(store.data / 'pdf' / (paper['fileHash'] + '.pdf')) as pdf:
            p = pdf[page - 1]
            clip = pymupdf.Rect(bbox[0] * p.rect.width, bbox[1] * p.rect.height, bbox[2] * p.rect.width, bbox[3] * p.rect.height) if bbox else None
            p.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), clip=clip).save(target)
    source = next((p['sourceRef'] for p in paper.get('pages', []) if p['page'] == page), dict(sourceId=f'{revision_id}:page:{page}', kind='paper', objectId=paper_id, revisionId=revision_id, page=page))
    try:
        store.source(source['sourceId'], revision_id)
    except BusinessError:
        with store.transaction():
            store.add_source(source, '')
    return dict(path=str(target), sourceRef=source, mimeType='image/png')
