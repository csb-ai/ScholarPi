import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config, ROOT, cleanError } from './config.js';
import { knowledge, BusinessError } from './mcp.js';
import { scholar } from './runtime.js';
import { emptyState, reviewState } from './review.js';
import type {
  ReadingPlan,
  KnowledgeCard,
  RunEvent,
  RunSnapshot,
} from '../../../packages/contracts/index.js';
const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 5 });
await app.register(cors, {
  origin: (origin, callback) =>
    callback(null, !origin || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)),
});
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
app.addHook('onRequest', async (request, reply) => {
  const host = request.headers.host ?? '';
  const origin = request.headers.origin;
  if (
    !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
    (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  )
    return reply.code(403).send({ error: '本地来源校验失败' });
});
app.setErrorHandler((error, _request, reply) => {
  const code =
    error instanceof BusinessError
      ? error.code
      : ((error as { code?: string }).code ?? 'INTERNAL_ERROR');
  const status =
    code === 'CONFLICT'
      ? 409
      : code === 'SOURCE_NOT_FOUND'
        ? 404
        : code === 'INVALID_ARGUMENT'
          ? 400
          : code === 'FST_REQ_FILE_TOO_LARGE'
            ? 413
            : 500;
  reply.code(status).send({ error: cleanError(error), code });
});
type Params = { id: string; page?: string };
type Args = Record<string, unknown>;
function body(r: { body: unknown }): Args {
  if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body))
    throw new BusinessError('INVALID_ARGUMENT', '请求体必须为对象');
  return r.body as Args;
}
const op = (name: string, args: Args = {}) => knowledge.operation(name, args);
function confined(file: string) {
  const full = path.resolve(file),
    base = path.resolve(ROOT, 'data');
  if (!full.startsWith(base + path.sep))
    throw new BusinessError('INVALID_ARGUMENT', '文件不属于项目资料目录');
  return full;
}
app.get('/api/health', async () => ({
  status: 'ok',
  model: config.model,
  configured: !!config.apiKey,
  knowledge: await op('health'),
  protocol: 'JSON tools / Code Mode sandbox',
}));
app.get('/api/papers', async () => op('list_papers'));
app.post('/api/papers', async (request, reply) => {
  const file = await request.file();
  if (!file) throw new BusinessError('INVALID_ARGUMENT', '请选择PDF');
  const parts: Buffer[] = [];
  for await (const chunk of file.file) parts.push(chunk);
  if (file.file.truncated) throw new BusinessError('INVALID_ARGUMENT', 'PDF超过100MiB');
  const bytes = Buffer.concat(parts);
  if (bytes.subarray(0, 5).toString() !== '%PDF-')
    throw new BusinessError('INVALID_ARGUMENT', '文件不是有效PDF');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = path.join(ROOT, 'data/uploads', hash + '.pdf');
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
  const result = await knowledge.operation<{ duplicate: boolean }>('ingest', {
    path: target,
    title: file.filename.replace(/\.pdf$/i, ''),
    original_name: file.filename,
    idempotency_key: hash,
  });
  reply.code(result.duplicate ? 200 : 202);
  return result;
});
app.get<{ Params: Params }>('/api/jobs/:id', (r) => op('get_job', { job_id: r.params.id }));
app.post<{ Params: Params }>('/api/jobs/:id/retry', (r) =>
  op('index_retry', { job_id: r.params.id }),
);
app.get<{ Params: Params; Querystring: { revisionId?: string } }>('/api/papers/:id', (r) =>
  op('get_paper', { paper_id: r.params.id, revision_id: r.query.revisionId }));
app.get<{ Params: Params; Querystring: { revisionId?: string } }>('/api/papers/:id/readings', async (r) => {
  const paper = await knowledge.operation<import('../../../packages/contracts/index.js').Paper>('get_paper', {
    paper_id: r.params.id, revision_id: r.query.revisionId,
  });
  const { items } = await knowledge.operation<{ items: RunSnapshot[] }>('list_runs');
  const seen = new Set<string>();
  return { items: items.filter(x => x.paperId === paper.paperId && x.paperRevisionId === paper.revisionId &&
    x.status === 'completed' && x.text.trim() && !x.error).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter(x => { const key = JSON.stringify([x.question?.normalize('NFKC').trim().replace(/\s+/g, ' '), x.action, x.depth, x.mode]); if (seen.has(key)) return false; seen.add(key); return true; })
    .map(({ runId, sessionId, question, action, depth, mode, createdAt, endedAt }) =>
      ({ runId, sessionId, question, action, depth, mode, createdAt, endedAt })) };
});
app.get<{ Params: Params }>('/api/runs/:id/trace', async (r) => scholar.trace(r.params.id));
app.delete<{ Params: Params }>('/api/papers/:id', (r) =>
  op('delete_paper', { paper_id: r.params.id }),
);
app.get<{ Params: Params; Querystring: { revisionId?: string } }>(
  '/api/papers/:id/pdf',
  async (r, reply) => {
    const result = (await op('get_pdf', {
      paper_id: r.params.id,
      revision_id: r.query.revisionId,
    })) as { path: string };
    return reply.type('application/pdf').send(fs.createReadStream(confined(result.path)));
  },
);
app.get<{ Params: Params; Querystring: { revisionId?: string } }>(
  '/api/papers/:id/pages/:page/image',
  async (r, reply) => {
    const result = (await op('get_page', {
      paper_id: r.params.id,
      revision_id: r.query.revisionId,
      page: Number(r.params.page),
    })) as { path: string; mimeType?: string };
    return reply
      .type(result.mimeType ?? 'image/png')
      .send(fs.createReadStream(confined(result.path)));
  },
);
app.get<{ Params: Params; Querystring: { revisionId?: string } }>('/api/sources/:id', (r) =>
  op('get_source', { source_id: r.params.id, revision_id: r.query.revisionId }),
);
app.post('/api/sessions', async (r) => {
  const b = body(r);
  const h = await scholar.open(
    String(b.paperId ?? ''),
    b.revisionId as string | undefined,
    b.fresh === true,
  );
  return sessionView(h);
});
async function sessionView(h: Awaited<ReturnType<typeof scholar.get>>) {
  const runs = (await knowledge.operation<{ items: RunSnapshot[] }>('list_runs')).items
    .filter((r) => r.sessionId === h.binding.sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const saved = runs
    .filter((r) => r.question)
    .flatMap((r) => [
      { role: 'user', text: r.question! },
      ...(r.text ? [{ role: 'assistant', text: r.text, run: r }] : []),
    ]);
  const fallback = h.session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      let text =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((x) => x.type === 'text')
              .map((x) => x.text)
              .join('\n');
      if (m.role === 'user' && text.startsWith('当前论文 ') && text.includes('\n用户问题：'))
        text = text.slice(text.indexOf('\n用户问题：') + 6);
      return { role: m.role, text };
    })
    .filter((m) => m.text.trim());
  return {
    ...h.binding,
    plan: h.plan,
    messages: saved.length ? saved : fallback,
    activeRunId: h.current?.snapshot.runId,
  };
}
app.get<{ Params: Params }>('/api/sessions/:id', async (r) =>
  sessionView(await scholar.get(r.params.id)),
);
app.put<{ Params: Params }>('/api/sessions/:id/plan', async (r) =>
  scholar.setPlan(r.params.id, body(r).plan as ReadingPlan),
);
app.post<{ Params: Params }>('/api/sessions/:id/turns', async (r, reply) => {
  const b = body(r);
  if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 20000)
    throw new BusinessError('INVALID_ARGUMENT', '问题必须为1—20000字符');
  if (b.mode !== undefined && !['function', 'code'].includes(String(b.mode)))
    throw new BusinessError('INVALID_ARGUMENT', '工具模式无效');
  if (b.depth !== undefined && !['simple', 'standard', 'technical'].includes(String(b.depth)))
    throw new BusinessError('INVALID_ARGUMENT', '讲解效果无效');
  const result = await scholar.submit(
    r.params.id,
    b as { question: string; action?: string; mode?: 'function' | 'code'; idempotencyKey?: string },
  );
  reply.code(result.reused ? 200 : 202);
  return result;
});
app.get<{ Params: Params }>('/api/runs/:id', (r) => scholar.snapshot(r.params.id));
app.post<{ Params: Params }>('/api/runs/:id/cancel', (r) => scholar.cancel(r.params.id));
app.get<{ Params: Params }>('/api/runs/:id/events', async (r, reply) => {
  const run = scholar.runs.get(r.params.id);
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': r.headers.origin ?? 'http://127.0.0.1:5173',
  });
  const send = (e: RunEvent) => reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  let listener: ((e: RunEvent) => void) | undefined;
  if (!run) {
    send({
      runId: r.params.id,
      seq: 0,
      type: 'reset',
      payload: await scholar.snapshot(r.params.id),
    });
    reply.raw.end();
    return;
  }
  const last = Number(r.headers['last-event-id'] ?? 0);
  if (last && run.recent.length && last < run.recent[0].seq - 1)
    send({ runId: r.params.id, seq: last, type: 'reset', payload: run.snapshot });
  else for (const e of run.recent) if (e.seq > last) send(e);
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.snapshot.status)) {
    send({
      runId: r.params.id,
      seq: (run.recent.at(-1)?.seq ?? 0) + 1,
      type: 'done',
      payload: run.snapshot,
    });
    reply.raw.end();
    return;
  }
  listener = (e) => {
    send(e);
    if (e.type === 'done') reply.raw.end();
  };
  run.emitter.on('event', listener);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
  reply.raw.on('close', () => {
    clearInterval(heartbeat);
    if (listener) run.emitter.off('event', listener);
  });
});
app.get<{ Querystring: { paperId?: string } }>('/api/notes', (r) =>
  op('list_notes', { paper_id: r.query.paperId }),
);
app.get<{ Params: Params }>('/api/notes/:id', (r) => op('get_note', { note_id: r.params.id }));
app.post('/api/notes', (r) => op('save_note', body(r)));
app.put<{ Params: Params }>('/api/notes/:id', (r) =>
  op('save_note', { ...body(r), note_id: r.params.id }),
);
app.delete<{ Params: Params }>('/api/notes/:id', (r) =>
  op('delete_note', { note_id: r.params.id }),
);
app.get('/api/cards', () => op('list_cards'));
app.post('/api/cards', async (r) => {
  const b = body(r);
  const key = b.idempotencyKey ?? b.idempotency_key;
  if (typeof key !== 'string' || !key)
    throw new BusinessError('INVALID_ARGUMENT', '创建卡片需要幂等标识');
  const fingerprint = createHash('sha256').update(JSON.stringify(b)).digest('hex');
  const old = (await op('idempotency_lookup', {
    operation: 'create_card',
    idempotency_key: key,
    client_request_hash: fingerprint,
  })) as { found: boolean; result?: unknown };
  if (old.found) return old.result;
  const state = emptyState();
  return op('create_card', {
    ...b,
    client_request_hash: fingerprint,
    fsrs_state: state,
    due: new Date(state.due).toISOString(),
  });
});
app.put<{ Params: Params }>('/api/cards/:id', (r) =>
  op('edit_card', { ...body(r), card_id: r.params.id }),
);
app.put('/api/cards', (r) => op('edit_card', body(r)));
app.delete<{ Params: Params }>('/api/cards/:id', (r) =>
  op('delete_card', { card_id: r.params.id }),
);
app.post<{ Params: Params }>('/api/cards/:id/reviews', async (r) => {
  const b = body(r);
  const key = b.idempotencyKey ?? b.idempotency_key;
  if (typeof key !== 'string' || !key)
    throw new BusinessError('INVALID_ARGUMENT', '复习需要幂等标识');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ cardId: r.params.id, ...b }))
    .digest('hex');
  const old = (await op('idempotency_lookup', {
    operation: 'review_card',
    idempotency_key: key,
    client_request_hash: fingerprint,
  })) as { found: boolean; result?: unknown };
  if (old.found) return old.result;
  const list = await knowledge.operation<{ items: KnowledgeCard[] }>('list_cards');
  const card = list.items.find((x) => x.cardId === r.params.id);
  if (!card) throw new BusinessError('SOURCE_NOT_FOUND', '卡片不存在');
  const review = reviewState(card.fsrsState, Number(b.rating));
  return op('review_card', {
    ...b,
    client_request_hash: fingerprint,
    card_id: card.cardId,
    fsrs_state: review.fsrsState,
    due: review.due,
    reviewed_at: review.reviewedAt,
    fsrs_version: review.fsrsVersion,
  });
});
app.get<{ Querystring: { query?: string; objectId?: string } }>('/api/graph', (r) =>
  op('graph', { concept: r.query.query, object_id: r.query.objectId }),
);
app.post('/api/graph/aliases', (r) => op('merge_concept', body(r)));
app.post('/api/graph/relations', (r) => op('link_objects', body(r)));
app.get<{ Querystring: { q: string; graph?: string; kind?: string } }>('/api/search', (r) => {
  if (r.query.kind && !['paper', 'note', 'card'].includes(r.query.kind))
    throw new BusinessError('INVALID_ARGUMENT', '未知检索对象类型');
  return op('search_knowledge', {
    query: r.query.q,
    limit: 6,
    use_graph: r.query.graph !== 'false',
    kinds: r.query.kind ? [r.query.kind] : undefined,
  });
});
await scholar.initialize();
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`ScholarPi API http://127.0.0.1:${config.port}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await scholar.close();
  process.exit();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
