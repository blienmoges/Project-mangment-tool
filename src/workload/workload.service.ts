import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface OpenWork {
  openTasks: number;
  openHours: number;
}

/**
 * Open work per person: unfinished tasks (completedAt is empty) and their estimated hours.
 * Used by team workload (FR-10.5) now, and by assignment suggestions and the workload view later.
 * Only tasks of the given workspace are counted, so one organization's data never shows in another.
 */
@Injectable()
export class WorkloadService {
  constructor(private readonly prisma: PrismaService) {}

  async openWork(workspaceId: string, userIds: string[]): Promise<Map<string, OpenWork>> {
    const result = new Map<string, OpenWork>(userIds.map((id) => [id, { openTasks: 0, openHours: 0 }]));
    if (!userIds.length) return result;
    const rows = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { workspaceId, assigneeId: { in: userIds }, completedAt: null },
      _sum: { estimatedHours: true },
      _count: { _all: true },
    });
    for (const r of rows) {
      if (r.assigneeId) result.set(r.assigneeId, { openTasks: r._count._all, openHours: Number(r._sum.estimatedHours ?? 0) });
    }
    return result;
  }

  /** Open hours as a percentage of weekly capacity (the API Design's loadPercent). */
  static loadPercent(openHours: number, capacityHours: number) {
    return capacityHours > 0 ? Math.round((openHours / capacityHours) * 100) : 0;
  }
}
