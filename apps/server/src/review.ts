import { fsrs, createEmptyCard, type Card, type CardInput, type Grade } from 'ts-fsrs';
export const REVIEW_VERSION = 'ts-fsrs-5;retention=0.9;fuzz=false';
const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });
export function emptyState(now = new Date()) {
  return JSON.parse(JSON.stringify(createEmptyCard(now))) as CardInput;
}
export function reviewState(value: unknown, rating: number, now = new Date()) {
  if (![1, 2, 3, 4].includes(rating)) throw Error('复习评级必须为 1—4');
  const card = (
    value && typeof value === 'object' && Object.keys(value).length ? value : emptyState(now)
  ) as CardInput;
  for (const key of [
    'stability',
    'difficulty',
    'elapsed_days',
    'scheduled_days',
    'learning_steps',
    'reps',
    'lapses',
  ] as const) {
    if (!Number.isFinite(card[key]) || card[key] < 0) throw Error('Invalid FSRS state: ' + key);
  }
  if (!Number.isFinite(new Date(card.due).getTime())) throw Error('Invalid FSRS due');
  const result = scheduler.repeat(card, now)[rating as Grade];
  return {
    fsrsState: JSON.parse(JSON.stringify(result.card)) as CardInput,
    due: result.card.due.toISOString(),
    review: JSON.parse(JSON.stringify(result.log)),
    reviewedAt: now.toISOString(),
    fsrsVersion: REVIEW_VERSION,
  };
}
