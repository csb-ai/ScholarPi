import type { SourceRef } from '../../../packages/contracts/index.js';
export function completedText(stopReason: string, text: string) {
  return stopReason === 'stop' && !!text.trim();
}
export function normalizeSourceLinks(text: string, resolve: (id: string) => SourceRef | undefined) {
  return text.replace(
    /(?:<source:([a-zA-Z0-9:_-]+)>|\[source:([a-zA-Z0-9:_-]+)\])/g,
    (original, a: string, b: string) => {
      const id = a ?? b,
        ref = resolve(id);
      if (!ref) return original;
      return `[${ref.kind === 'note' ? '笔记' : ref.kind === 'card' ? '卡片' : `p.${ref.page ?? '?'}`}](source:${id})`;
    },
  );
}
