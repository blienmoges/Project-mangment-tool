import { StatusCategory } from '@prisma/client';

/** Workflow every new space starts with (SRS FR-11.1). */
export const DEFAULT_WORKFLOW: { name: string; category: StatusCategory; color: string }[] = [
  { name: 'To do', category: StatusCategory.not_started, color: '#9CA3AF' },
  { name: 'In progress', category: StatusCategory.active, color: '#3B82F6' },
  { name: 'In review', category: StatusCategory.review, color: '#F59E0B' },
  { name: 'Done', category: StatusCategory.closed, color: '#10B981' },
];

/** Statuses are always kept in this category order, so every task passes review before it is closed. */
export const CATEGORY_ORDER: StatusCategory[] = [StatusCategory.not_started, StatusCategory.active, StatusCategory.review, StatusCategory.closed];

export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  not_started: 'Not started',
  active: 'Active',
  review: 'Review',
  closed: 'Closed',
};

const rank = (c: StatusCategory) => CATEGORY_ORDER.indexOf(c);

/**
 * Where a status of `category` may be inserted into `others` (the workflow without that status), as
 * 0-based indexes from `min` to `max` inclusive. `others` must already be in category order.
 */
export function allowedRange(others: { category: StatusCategory }[], category: StatusCategory) {
  const min = others.filter((s) => rank(s.category) < rank(category)).length;
  const max = min + others.filter((s) => s.category === category).length;
  return { min, max };
}

/** True when the list is in Not started → Active → Review → Closed order. */
export function isCategoryOrdered(list: { category: StatusCategory }[]) {
  return list.every((s, i) => i === 0 || rank(list[i - 1].category) <= rank(s.category));
}

/** The categories that have no status in the list (a valid workflow has none missing). */
export function missingCategories(list: { category: StatusCategory }[]) {
  return CATEGORY_ORDER.filter((c) => !list.some((s) => s.category === c));
}
