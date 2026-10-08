import { createHash } from 'node:crypto';
import type { Paper, RunSnapshot } from '../../../packages/contracts/index.js';

export type ReadingInput = {
  question: string;
  action?: string;
  mode?: 'function' | 'code';
  depth?: string;
  force?: boolean;
};

// Only independent, read-only paper tasks are reusable across conversations.
// Follow-ups, private knowledge queries and writes must execute with live context.
export function reusablePaperTask(input: ReadingInput) {
  return ['quick', 'method', 'figure_equation'].includes(input.action ?? '') &&
    !/刚才|上次|此前|之前|前面|历史|笔记|卡片|保存|创建|删除|对比.*论文|比较.*论文|另一篇/.test(input.question);
}

export function readingResultKey(paper: Paper, input: ReadingInput, engine: string) {
  return createHash('sha256').update(JSON.stringify({
    fileHash: paper.fileHash,
    paperId: paper.paperId,
    revisionId: paper.revisionId,
    question: input.question.normalize('NFKC').trim().replace(/\s+/g, ' '),
    action: input.action ?? 'question',
    depth: input.depth ?? 'standard',
    mode: input.mode ?? 'function',
    engine,
  })).digest('hex');
}

export function reusableResult(runs: RunSnapshot[], key: string) {
  return runs.filter(r => r.resultKey === key && r.cacheScope === 'paper' &&
    r.status === 'completed' && !r.error && r.text.trim() && r.plan?.steps.length)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
