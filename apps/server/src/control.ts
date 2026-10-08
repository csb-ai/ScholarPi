import type { ReadingPlan, SourceRef } from '../../../packages/contracts/index.js';
export function sourceRef(value: unknown): value is SourceRef {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sourceId === 'string' &&
    typeof r.objectId === 'string' &&
    typeof r.revisionId === 'string' &&
    (r.kind === 'paper' || r.kind === 'note' || r.kind === 'card') &&
    (r.page === undefined || (Number.isInteger(r.page) && Number(r.page) > 0))
  );
}
export function claimEvidenceRefs(category: string, refs: SourceRef[]): SourceRef[] {
  // Personal explanations can be quoted as personal knowledge, never paper proof.
  return category === 'paper_fact' ? refs.filter((r) => r.kind === 'paper') : refs;
}
export function sourceRefs(value: unknown): SourceRef[] {
  const result = new Map<string, SourceRef>();
  function visit(v: unknown) {
    if (sourceRef(v)) {
      result.set(v.sourceId + '@' + v.revisionId, v);
      return;
    }
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  }
  visit(value);
  return [...result.values()];
}
export function validatePlan(plan: ReadingPlan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 12)
    throw Error('Reading plan requires 1–12 steps');
  if (new Set(plan.steps.map((s) => s.id)).size !== plan.steps.length)
    throw Error('Duplicate step IDs');
  for (const s of plan.steps) {
    if (
      !s.id ||
      !s.goal ||
      !s.rationale ||
      !Array.isArray(s.prerequisites) ||
      !Array.isArray(s.sourceRefs) ||
      !s.sourceRefs.every(sourceRef) ||
      !['pending', 'active', 'done', 'skipped'].includes(s.status)
    )
      throw Error('Invalid reading step');
  }
}
export function revisePlan(previous: ReadingPlan | undefined, next: ReadingPlan): ReadingPlan {
  validatePlan(next);
  if (previous) {
    for (const s of previous.steps) {
      if (s.status === 'done' || s.status === 'skipped') {
        const replacement = next.steps.find((x) => x.id === s.id);
        if (!replacement || replacement.goal !== s.goal || replacement.status !== s.status)
          throw Error('Completed/skipped reading steps cannot be rewritten by Agent');
      }
    }
  }
  return { ...next, revision: (previous?.revision ?? 0) + 1 };
}
export class ToolBudget {
  attempts = 0;
  executed = 0;
  constructor(readonly max: number) {}
  take() {
    this.attempts++;
    if (this.executed >= this.max) return false;
    this.executed++;
    return true;
  }
}
