import contextlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def uid():
    return uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat()


class BusinessError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class Store:
    def __init__(self, data):
        self.data = Path(data).resolve()
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.data / 'knowledge.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL,revision TEXT NOT NULL,json TEXT NOT NULL,deleted INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS revisions(id TEXT,revision TEXT,json TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,object_id TEXT,revision TEXT,json TEXT,text TEXT);
        CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,object_id TEXT,revision TEXT,source_id TEXT,text TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED,text, tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY,revision TEXT,model_revision TEXT,dim INTEGER,dtype TEXT,vector BLOB);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,object_id TEXT,revision TEXT,json TEXT);
        CREATE TABLE IF NOT EXISTS idem(key TEXT PRIMARY KEY,operation TEXT,request TEXT,result TEXT);
        CREATE TABLE IF NOT EXISTS mentions(concept TEXT,object_id TEXT,revision TEXT,source_id TEXT,PRIMARY KEY(concept,object_id,revision,source_id));
        CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY,canonical TEXT);
        CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY,source TEXT,target TEXT,type TEXT,source_id TEXT);
        CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,card_id TEXT,json TEXT);
        PRAGMA user_version=1;
        ''')
        with self.transaction():
            for row in self.db.execute("SELECT * FROM objects WHERE kind='run'").fetchall():
                item = json.loads(row['json'])
                if item.get('status') in ('queued', 'running'):
                    item.update(status='interrupted', endedAt=now(), error='Service restarted before run settled')
                    self.put(row['id'], 'run', row['revision'], item)
            for row in self.db.execute('SELECT * FROM jobs').fetchall():
                item = json.loads(row['json'])
                if item['status'] == 'running':
                    item.update(status='interrupted', error='Worker interrupted; retry available')
                    self.db.execute('UPDATE jobs SET json=? WHERE id=?', (json.dumps(item), row['id']))

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            try:
                yield
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def get(self, oid, kind=None, revision=None, include_deleted=False):
        with self.lock:
            row = self.db.execute('SELECT * FROM objects WHERE id=?', (oid,)).fetchone()
            if not row or (kind and row['kind'] != kind) or (row['deleted'] and not include_deleted):
                raise BusinessError('SOURCE_NOT_FOUND', 'Object is missing or deleted')
            if revision and revision != row['revision']:
                old = self.db.execute('SELECT json FROM revisions WHERE id=? AND revision=?', (oid, revision)).fetchone()
                if not old:
                    raise BusinessError('SOURCE_NOT_FOUND', 'Revision does not exist')
                return json.loads(old[0])
            return json.loads(row['json'])

    def put(self, oid, kind, revision, item, deleted=False):
        data = json.dumps(item, ensure_ascii=False)
        self.db.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?)', (oid, kind, str(revision), data, int(deleted)))
        self.db.execute('INSERT OR REPLACE INTO revisions VALUES(?,?,?)', (oid, str(revision), data))

    def items(self, kind):
        with self.lock:
            return [json.loads(r[0]) for r in self.db.execute('SELECT json FROM objects WHERE kind=? AND deleted=0', (kind,))]

    def source(self, sid, revision=None):
        with self.lock:
            row = self.db.execute('SELECT * FROM sources WHERE id=?', (sid,)).fetchone()
            if not row or (revision and row['revision'] != revision):
                raise BusinessError('SOURCE_NOT_FOUND', 'Source or revision does not exist')
            ref = json.loads(row['json'])
            try:
                obj = self.get(row['object_id'])
                status = 'active' if obj.get('revisionId', str(obj.get('revision'))) == row['revision'] else 'superseded'
            except BusinessError:
                status = 'source_deleted'
            provenance = {}
            if ref['kind'] == 'card':
                try:
                    snapshot = self.get(row['object_id'], 'card', row['revision'], include_deleted=True)
                    provenance['origin'] = snapshot.get('origin', 'manual')
                    if snapshot.get('sourceRef'):
                        provenance['originSourceRef'] = snapshot['sourceRef']
                except BusinessError:
                    pass
            return dict(sourceRef=ref, text=row['text'], available=status != 'source_deleted', sourceStatus=status, **provenance)

    def add_source(self, ref, text):
        self.db.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?)', (ref['sourceId'], ref['objectId'], ref['revisionId'], json.dumps(ref), text))

    def clear_index(self, oid, preserve_edges=False):
        ids = [r[0] for r in self.db.execute('SELECT id FROM chunks WHERE object_id=?', (oid,))]
        for cid in ids:
            self.db.execute('DELETE FROM fts WHERE id=?', (cid,))
            self.db.execute('DELETE FROM vectors WHERE id=?', (cid,))
        self.db.execute('DELETE FROM chunks WHERE object_id=?', (oid,))
        self.db.execute('DELETE FROM mentions WHERE object_id=?', (oid,))
        if not preserve_edges:
            self.db.execute('DELETE FROM edges WHERE source=? OR target=?', (oid, oid))

    def chunk(self, oid, revision, source_id, text, tokenizer=None):
        # Actual 600-token/80-token overlap when loaded. The cold fallback
        # limits to 150 Unicode characters (up to 600 UTF-8 byte tokens).
        tokens = tokenizer.encode(text, add_special_tokens=False) if tokenizer else list(text)
        window, stride = (600, 520) if tokenizer else (150, 130)
        for offset in range(0, len(tokens), stride):
            part = tokens[offset:offset + window]
            value = tokenizer.decode(part) if tokenizer else ''.join(part)
            cid = uid()
            self.db.execute('INSERT INTO chunks VALUES(?,?,?,?,?)', (cid, oid, revision, source_id, value))
            self.db.execute('INSERT INTO fts VALUES(?,?)', (cid, value))

    def job(self, oid, revision, kind='index'):
        jid = uid()
        item = dict(jobId=jid, objectId=oid, revisionId=revision, kind=kind, status='pending', attempts=0, createdAt=now())
        self.db.execute('INSERT INTO jobs VALUES(?,?,?,?)', (jid, oid, revision, json.dumps(item)))
        return item

    def get_job(self, jid):
        with self.lock:
            row = self.db.execute('SELECT json FROM jobs WHERE id=?', (jid,)).fetchone()
            if not row:
                raise BusinessError('SOURCE_NOT_FOUND', 'Job not found')
            return json.loads(row[0])

    def update_job(self, job):
        with self.transaction():
            self.db.execute('UPDATE jobs SET json=? WHERE id=?', (json.dumps(job), job['jobId']))

    def idempotent(self, operation, args, action):
        key = args.get('idempotency_key')
        request = args.get('client_request_hash') or json.dumps(args, sort_keys=True, ensure_ascii=False)
        with self.transaction():
            if key:
                row = self.db.execute('SELECT * FROM idem WHERE key=?', (key,)).fetchone()
                if row:
                    if row['operation'] != operation or row['request'] != request:
                        raise BusinessError('CONFLICT', 'Idempotency key reused for different input')
                    return json.loads(row['result'])
            result = action()
            if key:
                self.db.execute('INSERT INTO idem VALUES(?,?,?,?)', (key, operation, request, json.dumps(result)))
            return result
