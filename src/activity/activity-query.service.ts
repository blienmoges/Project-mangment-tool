import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Prisma } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { addDays, zonedTime } from '../jobs/timing';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

export class ActivityQuery {
  @IsOptional() @IsUUID()
  actorId?: string;

  /** task, project, issue, sprint, phase, space, team, workspace_member... */
  @IsOptional() @IsString() @MaxLength(30)
  entityType?: string;

  /** First day included (workspace time zone). */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date such as 2027-02-01' }) @IsISO8601({ strict: true })
  from?: string;

  /** Last day included. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date such as 2027-02-28' }) @IsISO8601({ strict: true })
  to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  /** nextCursor of the previous page. */
  @IsOptional() @Matches(/^\d{1,19}$/, { message: 'cursor must be the nextCursor of the previous page' })
  cursor?: string;
}

/** Reading the activity log (NFR-9): who changed what and when, newest first. Nobody can change or delete entries. */
@Injectable()
export class ActivityQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  /** GET /workspaces/:id/activity (Admin) */
  async workspace(workspaceId: string, userId: string, q: ActivityQuery) {
    await this.access.requireAdmin(workspaceId, userId);
    const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { timezone: true } });
    return this.page({ workspaceId }, q, ws.timezone);
  }

  /** GET /projects/:id/activity (PM, Admin): the project and its tasks, issues, sprints and phases. */
  async project(projectId: string, userId: string, q: ActivityQuery) {
    const { project } = await this.projectAccess.require(projectId, userId, 'manage');
    const [tasks, issues, sprints, phases] = await Promise.all([
      this.prisma.task.findMany({ where: { projectId }, select: { id: true } }),
      this.prisma.issue.findMany({ where: { projectId }, select: { id: true } }),
      this.prisma.sprint.findMany({ where: { projectId }, select: { id: true } }),
      this.prisma.phase.findMany({ where: { projectId }, select: { id: true } }),
    ]);
    const ids = [projectId, ...[tasks, issues, sprints, phases].flat().map((r) => r.id)];
    return this.page({ workspaceId: project.workspaceId, entityId: { in: ids } }, q, project.workspace.timezone);
  }

  /** GET /tasks/:id/activity (Members, Admin): the history of one task. */
  async task(taskId: string, userId: string, q: ActivityQuery) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw Errors.notFound('Task');
    const { project } = await this.projectAccess.require(task.projectId, userId, 'member', 'Task');
    return this.page({ workspaceId: project.workspaceId, entityType: 'task', entityId: taskId }, q, project.workspace.timezone);
  }

  private async page(base: Prisma.ActivityLogWhereInput, q: ActivityQuery, tz: string) {
    const limit = q.limit ?? 50;
    const where: Prisma.ActivityLogWhereInput = {
      ...base,
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.entityType && !base.entityType ? { entityType: q.entityType } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: zonedTime(q.from, { h: 0, m: 0 }, tz) } : {}), ...(q.to ? { lt: zonedTime(addDays(q.to, 1), { h: 0, m: 0 }, tz) } : {}) } } : {}),
      ...(q.cursor ? { id: { lt: BigInt(q.cursor) } } : {}),
    };
    const rows = await this.prisma.activityLog.findMany({ where, include: { actor: { select: { id: true, fullName: true, avatarUrl: true } } }, orderBy: { id: 'desc' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        id: r.id.toString(), actor: { type: r.actorType, user: r.actor }, entityType: r.entityType, entityId: r.entityId,
        action: r.action, oldValue: r.oldValue, newValue: r.newValue, createdAt: r.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id.toString() : null,
    };
  }
}
