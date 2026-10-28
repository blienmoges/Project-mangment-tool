import { Injectable } from '@nestjs/common';
import { IssueStatus, IssueType, Task } from '@prisma/client';
import { AppException, Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccess, ProjectAccessService, ProjectNeed } from '../projects/project-access.service';

export const OPEN_ISSUE_STATUSES: IssueStatus[] = [IssueStatus.open, IssueStatus.in_progress];

/** Loads a task and checks the caller's access to its project. Unknown tasks and hidden projects answer 404. */
@Injectable()
export class TaskAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async require(taskId: string, userId: string, need: ProjectNeed = 'read'): Promise<{ task: Task; access: ProjectAccess }> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw Errors.notFound('Task');
    try {
      return { task, access: await this.projectAccess.require(task.projectId, userId, need) };
    } catch (e) {
      // Say "Task not found", not "Project not found", for tasks the caller cannot see.
      if (e instanceof AppException && e.body.code === 'NOT_FOUND') throw Errors.notFound('Task');
      throw e;
    }
  }

  /** Tasks with an open blocker issue linked (SRS FR-6.2). */
  async blockedIds(taskIds: string[]): Promise<Set<string>> {
    if (!taskIds.length) return new Set();
    const rows = await this.prisma.issue.findMany({
      where: { taskId: { in: taskIds }, type: IssueType.blocker, status: { in: OPEN_ISSUE_STATUSES } },
      select: { taskId: true },
      distinct: ['taskId'],
    });
    return new Set(rows.map((r) => r.taskId!));
  }

  /** True when every task this one depends on is closed. */
  async dependenciesDone(taskId: string) {
    const open = await this.prisma.taskDependency.count({ where: { taskId, dependsOn: { completedAt: null } } });
    return open === 0;
  }
}
