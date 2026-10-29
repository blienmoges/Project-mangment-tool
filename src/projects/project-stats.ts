import { Prisma } from '@prisma/client';
import { dateOnly, todayInTimeZone } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

export interface TaskStats {
  totalTasks: number;
  doneTasks: number;
  overdueTasks: number;
  /** Percentage of tasks done (SRS FR-1.4). */
  progress: number;
}

export const emptyStats = (): TaskStats => ({ totalTasks: 0, doneTasks: 0, overdueTasks: 0, progress: 0 });

/** The start of "today" in the workspace's time zone, as stored in `@db.Date` columns. */
export const todayFor = (timezone: string) => dateOnly(todayInTimeZone(timezone));

/** Where-clause for overdue tasks: not done and due before today (SRS FR-7.4: a flag, not a status). */
export const overdueWhere = (today: Date): Prisma.TaskWhereInput => ({ completedAt: null, dueDate: { lt: today } });

/**
 * Task counts grouped by project or by phase. "Done" means the task reached a closed status (completedAt is set).
 */
export async function taskStatsBy(
  db: PrismaService | Prisma.TransactionClient,
  key: 'projectId' | 'phaseId',
  ids: string[],
  today: Date,
): Promise<Map<string, TaskStats>> {
  const result = new Map<string, TaskStats>(ids.map((id) => [id, emptyStats()]));
  if (!ids.length) return result;
  const count = (where: Prisma.TaskWhereInput) =>
    db.task.groupBy({ by: [key], where: { [key]: { in: ids }, ...where }, _count: { _all: true } }) as unknown as Promise<
      ({ projectId?: string; phaseId?: string | null } & { _count: { _all: number } })[]
    >;
  const [total, done, overdue] = await Promise.all([count({}), count({ completedAt: { not: null } }), count(overdueWhere(today))]);
  const add = (rows: Awaited<ReturnType<typeof count>>, field: keyof Omit<TaskStats, 'progress'>) => {
    for (const r of rows) {
      const id = r[key];
      if (id && result.has(id)) result.get(id)![field] = r._count._all;
    }
  };
  add(total, 'totalTasks');
  add(done, 'doneTasks');
  add(overdue, 'overdueTasks');
  for (const s of result.values()) s.progress = s.totalTasks ? Math.round((s.doneTasks / s.totalTasks) * 100) : 0;
  return result;
}
