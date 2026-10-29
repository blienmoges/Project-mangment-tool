/**
 * Helpers for ordered lists (workflow statuses, custom fields).
 * Positions are always stored as 0, 1, 2, ... after every change.
 */

/** Returns a copy of `list` with `item` placed at `index` (clamped to the list length). */
export function insertAt<T>(list: T[], item: T, index: number): T[] {
  const copy = [...list];
  copy.splice(Math.max(0, Math.min(index, copy.length)), 0, item);
  return copy;
}

/** The rows whose stored position differs from their index in `ordered`. */
export function changedPositions<T extends { id: string; position: number }>(ordered: T[]) {
  return ordered.map((row, index) => ({ id: row.id, from: row.position, to: index })).filter((c) => c.from !== c.to);
}
