import { Injectable } from '@nestjs/common';
import { StatusCategory, WorkflowStatus } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { AppException, Errors } from '../common/app-exception';
import { DomainEventsService, TaskEventType } from '../events/domain-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { TaskAccessService } from './task-access.service';
import { TaskViewService } from './task-view.service';
import { checkApprove, checkReopen, checkRequestChanges, checkStatusMove, firstOf, MoveContext, RuleError } from './workflow-rules';

/**
 * Status changes (API Design, "Status changes" and "Workflow rules"). Each action checks the rules in
 * workflow-rules.ts, then changes the status in one transaction, writes the activity log and emits an event.
 * completedAt is set only by approve and cleared only by reopen.
 */
@Injectable()
export class TaskStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly taskAccess: TaskAccessService,
    private readonly view: TaskViewService,
    private readonly activity: ActivityService,
    private readonly events: DomainEventsService,
  ) {}

  /** POST /tasks/:id/status { statusId } — never into a closed status (403 APPROVAL_REQUIRED). */
  async move(taskId: string, userId: string, statusId: string) {
    const c = await this.context(taskId, userId);
    const to = this.statusOf(c.statuses, statusId);
    if (to.id === c.from.id) return this.view.detail(taskId, userId, c.access);
    this.ok(checkStatusMove(c.ctx, to));
    const event: TaskEventType = to.category === StatusCategory.review ? 'task.submitted' : 'task.status_changed';
    return this.apply(c, to, 'status_changed', event);
  }

  /** POST /tasks/:id/submit — to the first review status. */
  async submit(taskId: string, userId: string) {
    const c = await this.context(taskId, userId);
    const to = firstOf(c.statuses, StatusCategory.review)!;
    if (c.from.category === StatusCategory.review) return this.view.detail(taskId, userId, c.access);
    this.ok(checkStatusMove(c.ctx, to));
    return this.apply(c, to, 'submitted', 'task.submitted');
  }

  /** POST /tasks/:id/approve { statusId? } — the only way into a closed status; sets completedAt. */
  async approve(taskId: string, userId: string, statusId?: string) {
    const c = await this.context(taskId, userId);
    const to = statusId ? this.statusOf(c.statuses, statusId) : firstOf(c.statuses, StatusCategory.closed)!;
    this.ok(checkApprove(c.ctx, to));
    return this.apply(c, to, 'approved', 'task.approved', { completedAt: new Date() });
  }

  /** POST /tasks/:id/request-changes { note?, statusId? } — back to the first active status; the note becomes a comment. */
  async requestChanges(taskId: string, userId: string, note?: string, statusId?: string) {
    const c = await this.context(taskId, userId);
    const to = statusId ? this.statusOf(c.statuses, statusId) : firstOf(c.statuses, StatusCategory.active)!;
    this.ok(checkRequestChanges(c.ctx, to));
    return this.apply(c, to, 'changes_requested', 'task.changes_requested', {}, note?.trim());
  }

  /** POST /tasks/:id/reopen { statusId? } — a finished task goes back to the first active status; clears completedAt. */
  async reopen(taskId: string, userId: string, statusId?: string) {
    const c = await this.context(taskId, userId);
    const to = statusId ? this.statusOf(c.statuses, statusId) : firstOf(c.statuses, StatusCategory.active)!;
    this.ok(checkReopen(c.ctx, to));
    return this.apply(c, to, 'reopened', 'task.reopened', { completedAt: null });
  }

  // ───────────── helpers ─────────────

  private async context(taskId: string, userId: string) {
    const { task, access } = await this.taskAccess.require(taskId, userId, 'member');
    this.projectAccess.assertWritable(access.project);
    const [statuses, blocked, dependenciesDone] = await Promise.all([
      this.prisma.workflowStatus.findMany({ where: { spaceId: access.project.spaceId }, orderBy: { position: 'asc' } }),
      this.taskAccess.blockedIds([taskId]),
      this.taskAccess.dependenciesDone(taskId),
    ]);
    const from = statuses.find((s) => s.id === task.statusId)!;
    const ctx: MoveContext = {
      from,
      isManager: access.isAdmin || access.isManager,
      isAssignee: task.assigneeId === userId,
      blocked: blocked.has(taskId),
      dependenciesDone,
    };
    return { task, access, statuses, from, ctx, userId };
  }

  private statusOf(statuses: WorkflowStatus[], statusId: string) {
    const s = statuses.find((x) => x.id === statusId);
    if (!s) throw Errors.validation({ statusId: "must be a status of this project's space" });
    return s;
  }

  private ok(error: RuleError | null) {
    if (error) throw new AppException(error.status, { code: error.code, message: error.message });
  }

  private async apply(
    c: Awaited<ReturnType<TaskStatusService['context']>>,
    to: WorkflowStatus,
    action: string,
    event: TaskEventType,
    extra: { completedAt?: Date | null } = {},
    note?: string,
  ) {
    const { task, from, userId } = c;
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { statusId: to.id, ...extra } });
      if (note) await tx.comment.create({ data: { taskId: task.id, authorId: userId, body: `Changes requested: ${note}` } });
      await this.activity.log(
        {
          workspaceId: task.workspaceId, actorId: userId, entityType: 'task', entityId: task.id, action,
          oldValue: { statusId: from.id, status: from.name }, newValue: { statusId: to.id, status: to.name, ...(note ? { note } : {}) },
        },
        tx,
      );
    });
    this.events.emit({
      type: event, workspaceId: task.workspaceId, projectId: task.projectId, taskId: task.id, actorId: userId,
      data: { fromStatusId: from.id, toStatusId: to.id, fromCategory: from.category, toCategory: to.category, assigneeId: task.assigneeId, ...(note ? { note } : {}) },
    });
    return this.view.detail(task.id, userId, c.access);
  }
}
