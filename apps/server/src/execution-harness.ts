export type ModelStage = 'main' | 'verification' | 'correction';
export const MODEL_STAGE_LIMITS = { main: 8, verification: 1, correction: 1 } as const;

export class HarnessStop extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A reading owns its wait and requests, not the shared document-indexing job. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason ?? new HarnessStop('user_cancel', '阅读已停止')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    // Always observe work, including when the caller was already cancelled.
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

export class ExecutionHarness {
  readonly counts = { main: 0, verification: 0, correction: 0 };
  private readonly expires: number;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly clock: () => number;
  constructor(private readonly options: {
    controller: AbortController; timeoutMs: number; maxModels: number;
    onStop: (reason: HarnessStop) => void; now?: () => number; schedule?: boolean;
  }) {
    this.clock = options.now ?? (() => performance.now());
    this.expires = this.clock() + options.timeoutMs;
    if (options.schedule !== false) {
      this.timer = setTimeout(() => this.stop('deadline', '阅读执行超时，已保留生成内容'), options.timeoutMs);
      this.timer.unref();
    }
  }
  get signal() { return this.options.controller.signal; }
  get remainingMs() { return Math.max(0, this.expires - this.clock()); }
  check() {
    if (this.remainingMs <= 0 && !this.signal.aborted) this.stop('deadline', '阅读执行超时');
    this.signal.throwIfAborted();
  }
  takeModel(stage: ModelStage) {
    this.check();
    const total = this.counts.main + this.counts.verification + this.counts.correction;
    if (total >= this.options.maxModels || this.counts[stage] >= MODEL_STAGE_LIMITS[stage]) {
      this.stop('model_budget', `模型调用预算耗尽（本轮总上限${this.options.maxModels}次）`);
      this.signal.throwIfAborted();
    }
    this.counts[stage]++;
  }
  stageSignal(timeoutMs: number) {
    this.check();
    return AbortSignal.any([this.signal, AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, Math.ceil(this.remainingMs))))]);
  }
  cancel() { this.stop('user_cancel', '用户停止本次阅读'); }
  private stop(code: string, message: string) {
    if (this.stopped || this.signal.aborted) return;
    this.stopped = true;
    const reason = new HarnessStop(code, message);
    this.options.controller.abort(reason);
    this.options.onStop(reason);
  }
  dispose() { clearTimeout(this.timer); }
}
