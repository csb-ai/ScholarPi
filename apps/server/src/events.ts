import { EventEmitter } from 'node:events';
import type { RunEvent, RunSnapshot } from '../../../packages/contracts/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
export class RunEvents {
  readonly emitter = new EventEmitter();
  private seq = 0;
  readonly recent: RunEvent[] = [];
  constructor(readonly snapshot: RunSnapshot) {
    this.emitter.setMaxListeners(40);
  }
  emit(type: string, payload: unknown) {
    const e: RunEvent = { runId: this.snapshot.runId, seq: ++this.seq, type, payload };
    this.recent.push(e);
    if (this.recent.length > 512) this.recent.shift();
    fs.appendFileSync(
      path.join(ROOT, 'artifacts/runs', this.snapshot.runId + '.jsonl'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + '\n',
    );
    this.emitter.emit('event', e);
    return e;
  }
}
