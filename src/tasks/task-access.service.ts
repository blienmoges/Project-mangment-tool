import { Injectable } from '@nestjs/common';
import { Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService, ProjectNeed } from '../projects/project-access.service';

/** Loads a task and checks the caller's access to its project (404 "Task not found." when they cannot see it). */
@Injectable()
export class TaskAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async require(taskId: string, userId: string, need: ProjectNeed = 'read') {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { status: true } });
    if (!task) throw Errors.notFound('Task');
    const access = await this.projectAccess.require(task.projectId, userId, need, 'Task');
    return {
      ...access,
      task,
      /** Workspace Admin or the project's PM. */
      canManage: access.isAdmin || access.isManager,
      isAssignee: !!task.assigneeId && task.assigneeId === userId,
    };
  }

  /** Same as ProjectAccessService.assertWritable, for task actions. */
  assertWritable(access: { project: Parameters<ProjectAccessService['assertWritable']>[0] }) {
    this.projectAccess.assertWritable(access.project);
  }
}
