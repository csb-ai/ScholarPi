import type { RunDiagnostics, RunEvent } from '../../../packages/contracts/index.js';

/** Additive statistics only: never changes an answer or calls a provider. */
export class RunDiagnosticsCollector {
  readonly value: RunDiagnostics = {
    version: 1, phases: [], calls: [], models: { main: 0, verification: 0, correction: 0 },
    tools: { business: 0, control: 0, backend: 0, failed: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknownResponses: 0 },
    finished: false,
  };
  private readonly began: number;
  private phaseAt: number;
  private phase = 'queued';
  private calls = new Map<string, { start: number; row: RunDiagnostics['calls'][number] }>();
  constructor(private readonly now: () => number = () => performance.now()) {
    this.began = this.phaseAt = now();
  }
  observe(event: RunEvent) {
    if (this.value.finished) return;
    const p = event.payload as Record<string, any>;
    const at = this.now();
    if (event.type === 'phase' && p.stage !== this.phase) {
      this.value.phases.push({ name: this.phase, durationMs: Math.max(0, at - this.phaseAt) });
      this.phase = String(p.stage); this.phaseAt = at;
    }
    if (event.type === 'text_delta' && p.delta && this.value.firstTextMs === undefined)
      this.value.firstTextMs = Math.max(0, at - this.began);
    if (event.type === 'cancel_requested') this.value.cancelRequestedMs = at - this.began;
    if (event.type === 'shared_job') this.value.sharedJobId = p.jobId;
    if (event.type === 'model_call' && p.status === 'started') {
      if (p.stage in this.value.models) this.value.models[p.stage as keyof typeof this.value.models]++;
      this.start(String(p.callId), 'model', String(p.stage), at);
    }
    if (event.type === 'model_call' && p.status !== 'started') this.end(String(p.callId), String(p.status), at);
    if (event.type === 'tool' && p.status === 'started') {
      const kind = String(p.name).startsWith('mcp__') ? 'business' : 'control';
      this.value.tools[kind]++;
      this.start(String(p.callId), kind, String(p.name), at, p.parentCallId);
    }
    if (event.type === 'tool' && p.status !== 'started') {
      this.end(String(p.callId), String(p.status), at);
      if (p.status === 'failed') this.value.tools.failed++;
    }
    if (event.type === 'backend_call' && p.status === 'started') {
      this.value.tools.backend++;
      this.start(String(p.callId), 'backend', String(p.name), at);
    }
    if (event.type === 'backend_call' && p.status !== 'started') this.end(String(p.callId), String(p.status), at);
    if (event.type === 'usage' || event.type === 'verification_usage' || event.type === 'correction') {
      const u = event.type === 'correction' ? p.usage : p;
      if (!u || ['error', 'aborted'].includes(p.stopReason ?? p.status) ||
          ![u.input, u.output, u.cacheRead, u.cacheWrite].some(n => Number(n) > 0)) {
        this.value.tokens.unknownResponses++;
      } else {
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          this.value.tokens[field] += Math.max(0, Number(u[field]) || 0);
      }
    }
  }
  private start(id: string, kind: string, name: string, at: number, parentCallId?: string) {
    const row = { callId: id, kind, name, status: 'started', parentCallId };
    this.value.calls.push(row); this.calls.set(id, { start: at, row });
  }
  private end(id: string, status: string, at: number) {
    const call = this.calls.get(id);
    if (!call) return;
    call.row.status = status; call.row.durationMs = Math.max(0, at - call.start);
    this.calls.delete(id);
  }
  finish() {
    if (this.value.finished) return this.value;
    const at = this.now();
    this.value.phases.push({ name: this.phase, durationMs: Math.max(0, at - this.phaseAt) });
    for (const id of this.calls.keys()) this.end(id, 'unfinished', at);
    this.value.workMs = Math.max(0, at - this.began);
    if (this.value.cancelRequestedMs !== undefined)
      this.value.cancelSettleMs = Math.max(0, this.value.workMs - this.value.cancelRequestedMs);
    this.value.finished = true;
    return this.value;
  }
}
