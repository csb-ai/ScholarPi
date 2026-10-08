export type SourceRef = {
  sourceId: string;
  kind: 'paper' | 'note' | 'card';
  objectId: string;
  revisionId: string;
  page?: number;
  bbox?: [number, number, number, number];
  blockId?: string;
  quote?: string;
};
export type Paper = {
  paperId: string;
  revisionId: string;
  title: string;
  fileHash: string;
  pageCount: number;
  status: 'queued' | 'processing' | 'ready' | 'partial' | 'failed' | 'deleted';
  coverage: { processedPages: number[]; pendingPages: number[]; scannedPages: number[] };
  sections?: { title: string; page: number }[];
};
export type ReadingStep = {
  id: string;
  goal: string;
  rationale: string;
  prerequisites: string[];
  sourceRefs: SourceRef[];
  status: 'pending' | 'active' | 'done' | 'skipped';
};
export type ReadingPlan = {
  planId: string;
  paperId: string;
  paperRevisionId: string;
  mode: 'quick' | 'method' | 'figure_equation';
  revision: number;
  steps: ReadingStep[];
};
export type Note = {
  noteId: string;
  revisionId: string;
  paperId?: string;
  title: string;
  markdown: string;
  content?: unknown;
  sourceRefs: SourceRef[];
  ownSourceRef?: SourceRef;
  indexJobId?: string;
  keywords: string[];
  deleted?: boolean;
};
import type { CardInput } from 'ts-fsrs';
export type StoredFSRS = Omit<CardInput, 'due' | 'last_review'> & {
  due: string;
  last_review?: string;
};
export type KnowledgeCard = {
  cardId: string;
  revision: number;
  front: string;
  back: string;
  origin: 'keyword' | 'selection' | 'manual';
  ownSourceRef?: SourceRef;
  sourceRef?: SourceRef;
  keyword?: string;
  sourceStatus: 'active' | 'keyword_deleted' | 'source_deleted' | 'manual';
  fsrsState: StoredFSRS | Record<string, never>;
  due?: string;
};
export type EvidenceClaim = {
  claimId: string;
  text: string;
  category: 'paper_fact' | 'personal_note' | 'background';
  sourceRefs: SourceRef[];
  support: 'supported' | 'partial' | 'unsupported' | 'insufficient';
};
export type Evidence = {
  text: string;
  sourceRef: SourceRef;
  score?: number;
  lexicalRank?: number;
  denseRank?: number;
  path?: string[];
  contentKind?: 'paper' | 'note' | 'card';
  originSourceRef?: SourceRef;
};
export type GraphData = {
  nodes: { id: string; label: string; kind: string }[];
  edges: { id: string; source: string; target: string; type: string; sourceRef?: SourceRef }[];
};
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type RunSnapshot = {
  runId: string;
  sessionId: string;
  paperId?: string;
  paperRevisionId?: string;
  paperFileHash?: string;
  action?: string;
  depth?: string;
  resultKey?: string;
  cacheScope?: 'paper';
  status: RunStatus;
  text: string;
  plan?: ReadingPlan;
  claims?: EvidenceClaim[];
  evidence?: Evidence[];
  keywords?: { term: string; explanation: string; sourceRefs: SourceRef[] }[];
  quiz?: { question: string; answer: string; sourceRefs: SourceRef[] }[];
  error?: string;
  mode: 'function' | 'code';
  usage?: {
    input: number;
    output: number;
    calls: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalInput?: number;
  };
  createdAt: string;
  question?: string;
  endedAt?: string;
  stopReason?: string;
  requestKey?: string;
  requestDigest?: string;
};
export type RunEvent = { runId: string; seq: number; type: string; payload: unknown };
export type ReadingSummary = Pick<RunSnapshot, 'runId' | 'sessionId' | 'question' | 'action' | 'depth' | 'mode' | 'createdAt' | 'endedAt'>;
export type StoredRunEvent = RunEvent & { timestamp?: string };
