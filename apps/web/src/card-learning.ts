import type { KnowledgeCard } from '../../../packages/contracts';

export type CardStage = 'new' | 'learning' | 'relearning' | 'due' | 'overdue' | 'scheduled';
export const cardStages: { key: CardStage; label: string }[] = [
  { key: 'new', label: '新卡' }, { key: 'learning', label: '学习中' }, { key: 'relearning', label: '重新学习' },
  { key: 'due', label: '今日待复习' }, { key: 'overdue', label: '已逾期' }, { key: 'scheduled', label: '已安排' },
];
export function cardStage(card: KnowledgeCard, clock = Date.now()): CardStage {
  const state = card.fsrsState as { state?: number; reps?: number };
  if (!state.reps || state.state === 0) return 'new';
  if (state.state === 1) return 'learning';
  if (state.state === 3) return 'relearning';
  const due = Date.parse(card.due || '');
  const today = new Date(clock); today.setHours(0, 0, 0, 0);
  if (Number.isFinite(due) && due < today.getTime()) return 'overdue';
  if (!Number.isFinite(due) || due <= clock) return 'due';
  return 'scheduled';
}
export function intervalText(seconds: number) {
  if (seconds < 60) return '不到 1 分钟';
  if (seconds < 3600) return `约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
  if (seconds < 86400) return `约 ${Math.round(seconds / 3600 * 10) / 10} 小时`;
  return `约 ${Math.round(seconds / 86400 * 10) / 10} 天`;
}
export function createdText(card: KnowledgeCard) {
  if (!card.createdAt || !Number.isFinite(Date.parse(card.createdAt))) return '历史卡片 · 创建时间未记录';
  return `${card.createdAtEstimated ? '约创建于' : '创建于'} ${new Date(card.createdAt).toLocaleDateString('zh-CN')}`;
}
export function dueText(card: KnowledgeCard, clock = Date.now()) {
  if (cardStage(card, clock) === 'new') return '首次自评后安排下次复习';
  const due = Date.parse(card.due || '');
  if (!Number.isFinite(due)) return '等待安排复习';
  if (due <= clock) return `现在可复习 · 原定 ${new Date(due).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  return `${intervalText((due - clock) / 1000)}后复习`;
}
export type ReviewPreview = {
  cardId: string; revision: number; calculatedAt: string;
  options: { rating: number; due: string; intervalSeconds: number }[];
};
