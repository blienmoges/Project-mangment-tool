/**
 * True when "taskId depends on dependsOnTaskId" would close a loop, i.e. dependsOnTaskId already (directly or
 * through other tasks) depends on taskId. `edges` are the existing dependencies of the project.
 */
export function wouldCreateLoop(edges: { taskId: string; dependsOnTaskId: string }[], taskId: string, dependsOnTaskId: string) {
  if (taskId === dependsOnTaskId) return true;
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.dependsOnTaskId]);
  const seen = new Set<string>();
  const stack = [dependsOnTaskId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}
