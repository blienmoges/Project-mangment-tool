import { Injectable } from '@nestjs/common';
import { Prisma, ProjectRole, StatusCategory as C, WorkflowStatus } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { AppException, Errors } from '../common/app-exception';
import { isoDate, shortId } from '../common/utils';
import { AutomationsService } from '../automations/automations.service';
import { CustomRulesService } from '../automations/custom-rules.service';
import { DeadlinesService } from '../jobs/deadlines.service';
import { TimeService } from '../time/time.service';
import { NotificationsService, TaskEventKind } from '../notifications/notifications.service';
import { afterCommit, PrismaService } from '../prisma/prisma.service';
import { ApproveDto, MoveStatusDto, ReopenDto, RequestChangesDto } from './dto/task.dto';
import { TaskAccessService } from './task-access.service';
import { TaskViewService } from './task-view.service';
import { TasksService } from './tasks.service';
import { checkMove, checkProgress, firstOf } from './task-workflow';

type Tx = Prisma.TransactionClient;
type Access = Awaited<ReturnType<TaskAccessService['require']>>;

/**
 * Status changes (API Design section 5, "Status changes" and "Workflow rules"; SRS FR-7.3, FR-11.4).
 * Only /approve closes a task; completedAt is set when a task enters a closed status and cleared when it is reopened.
 */
@Injectable()
export class TaskStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskAccess: TaskAccessService,
    private readonly tasks: TasksService,
    private readonly view: TaskViewService,
    private readonly notifications: NotificationsService,
    private readonly deadlines: DeadlinesService,
    private readonly automations: AutomationsService,
    private readonly time: TimeService,
    private readonly activity: ActivityService,
    private readonly rules: CustomRulesService,
  ) {}

  /** POST /tasks/:id/status — assignee, PM or Admin. */
  async move(taskId: string, userId: string, dto: MoveStatusDto) {
    const a = await this.load(taskId, userId);
    const to = this.findStatus(a.statuses, dto.statusId);
    if (to.id === a.task.statusId) return this.tasks.detailFor(taskId, userId);
    await this.check(a, to, checkMove(a.task.status, to, a.actor));
    await this.transition(a, to, 'moved');
    return this.tasks.detailFor(taskId, userId);
  }

  /** POST /tasks/:id/submit — moves the task to the first Review status ("Submit for review"). */
  async submit(taskId: string, userId: string) {
    const a = await this.load(taskId, userId);
    if (a.task.status.category === C.review) throw Errors.conflict('INVALID_STATUS_CHANGE', 'This task is already in review.');
    const to = firstOf(a.statuses, C.review)!;
    await this.check(a, to, checkMove(a.task.status, to, a.actor));
    await this.transition(a, to, 'submitted');
    return this.tasks.detailFor(taskId, userId);
  }

  /** POST /tasks/:id/approve — PM or Admin; the only way into a closed status. */
  async approve(taskId: string, userId: string, dto: ApproveDto) {
    const a = await this.load(taskId, userId, true);
    if (a.task.status.category !== C.review) {
      throw Errors.conflict('INVALID_STATUS_CHANGE', 'Only a task in review can be approved. It has to be submitted for review first.');
    }
    const to = dto.statusId ? this.findStatus(a.statuses, dto.statusId) : firstOf(a.statuses, C.closed)!;
    if (to.category !== C.closed) throw Errors.validation({ statusId: 'must be a closed status, such as Done' });
    await this.check(a, to, null);
    await this.transition(a, to, 'approved');
    return this.tasks.detailFor(taskId, userId);
  }

  /** POST /tasks/:id/request-changes — PM or Admin; back to the first Active status (or statusId), with a note. */
  async requestChanges(taskId: string, userId: string, dto: RequestChangesDto) {
    const a = await this.load(taskId, userId, true);
    if (a.task.status.category !== C.review) throw Errors.conflict('INVALID_STATUS_CHANGE', 'Changes can only be requested for a task in review.');
    const to = dto.statusId ? this.findStatus(a.statuses, dto.statusId) : firstOf(a.statuses, C.active)!;
    if (to.category !== C.active && to.category !== C.not_started) throw Errors.validation({ statusId: 'must be a Not started or Active status' });
    await this.transition(a, to, 'changes_requested', dto.note.trim());
    return this.tasks.detailFor(taskId, userId);
  }

  /** POST /tasks/:id/reopen — PM or Admin; a finished task goes back to the first Active status (or statusId). */
  async reopen(taskId: string, userId: string, dto: ReopenDto) {
    const a = await this.load(taskId, userId, true);
    if (a.task.status.category !== C.closed) throw Errors.conflict('INVALID_STATUS_CHANGE', 'This task is not finished, so it cannot be reopened.');
    const to = dto.statusId ? this.findStatus(a.statuses, dto.statusId) : firstOf(a.statuses, C.active)!;
    if (to.category === C.closed) throw Errors.validation({ statusId: 'must be a status that is not closed' });
    await this.transition(a, to, 'reopened');
    return this.tasks.detailFor(taskId, userId);
  }

  // ───────────── internals ─────────────

  private async load(taskId: string, userId: string, managerOnly = false) {
    const access = await this.taskAccess.require(taskId, userId, managerOnly ? 'manage' : 'member');
    this.taskAccess.assertWritable(access);
    const statuses = await this.prisma.workflowStatus.findMany({ where: { spaceId: access.project.spaceId }, orderBy: { position: 'asc' } });
    return { ...access, statuses, actor: { isManager: access.canManage, isAssignee: access.isAssignee } };
  }

  private findStatus(statuses: WorkflowStatus[], id: string) {
    const s = statuses.find((x) => x.id === id);
    if (!s) throw Errors.validation({ statusId: "must be a status of the task's space" });
    return s;
  }

  /** Throws the role error first, then the blocker / dependency rules (which apply to everyone). */
  private async check(a: Access & { statuses: WorkflowStatus[] }, to: WorkflowStatus, roleError: AppException | null) {
    if (roleError) throw roleError;
    const flags = await this.view.flags([a.task.id]);
    const err = checkProgress(a.task.status, to, { blocked: flags.blocked.has(a.task.id), unfinishedDependencies: flags.waitingOn.get(a.task.id) ?? 0 });
    if (err) throw err;
  }

  private async transition(a: Access, to: WorkflowStatus, action: 'moved' | 'submitted' | 'approved' | 'changes_requested' | 'reopened', note?: string) {
    const { task, project } = a;
    const ref = { id: task.id, shortId: shortId(project.keyPrefix, task.number), title: task.title };
    const wasClosed = task.status.category === C.closed;
    const nowClosed = to.category === C.closed;
    await this.prisma.tx(async (tx) => {
      // Finished tasks get no more reminders or overdue alerts; reopened ones get them again.
      if (nowClosed && !wasClosed) afterCommit(() => this.deadlines.cancelTask(task.id, isoDate(task.dueDate), task.workspaceId));
      if (wasClosed && !nowClosed) afterCommit(() => this.deadlines.scheduleTask(task.id));
      await tx.task.update({
        where: { id: task.id },
        data: { statusId: to.id, ...(nowClosed && !wasClosed ? { completedAt: new Date() } : {}), ...(wasClosed && !nowClosed ? { completedAt: null } : {}) },
      });
      if (nowClosed && !wasClosed) {
        await this.time.stopTimersOnTask(tx, task.id); // nobody keeps timing finished work
        if (task.parentTaskId) await this.automations.onSubtaskClosed(tx, task.parentTaskId);
      }
      if (note) await tx.comment.create({ data: { taskId: task.id, authorId: a.membership.userId, body: `Changes requested: ${note}` } });
      await this.activity.log(
        {
          workspaceId: task.workspaceId, actorId: a.membership.userId, entityType: 'task', entityId: task.id, action: `status_${action}`,
          oldValue: { statusId: task.statusId, status: task.status.name }, newValue: { statusId: to.id, status: to.name, ...(note ? { note } : {}) },
        },
        tx,
      );
      await this.notify(tx, a, to, action, ref, note);
      await this.rules.run(tx, 'task.status_changed', { projectId: task.projectId, taskId: task.id, toStatusId: to.id });
    });
  }

  private async notify(tx: Tx, a: Access, to: WorkflowStatus, action: string, ref: { id: string; shortId: string; title: string }, note?: string) {
    const base = { workspaceId: a.task.workspaceId, actorId: a.membership.userId, task: ref, note };
    const intoReview = to.category === C.review && a.task.status.category !== C.review;
    if (intoReview && (await this.automations.enabled(tx, a.task.projectId, 'review_notify'))) {
      const pm = await tx.projectMember.findFirst({ where: { projectId: a.task.projectId, role: ProjectRole.project_manager }, select: { userId: true } });
      await this.notifications.taskEvent(tx, { ...base, kind: 'task_submitted', recipientIds: [pm?.userId] });
    }
    const toAssignee: Record<string, TaskEventKind> = { approved: 'task_approved', changes_requested: 'changes_requested', reopened: 'task_reopened' };
    if (toAssignee[action]) await this.notifications.taskEvent(tx, { ...base, kind: toAssignee[action], recipientIds: [a.task.assigneeId] });
    if (action === 'approved') {
      // "Tasks waiting on this one can now start": tell the assignees of tasks that no longer wait on anything.
      const dependents = await tx.taskDependency.findMany({ where: { dependsOnTaskId: a.task.id }, select: { task: { select: { id: true, number: true, title: true, assigneeId: true } } } });
      for (const { task } of dependents) {
        const stillWaiting = await tx.taskDependency.count({ where: { taskId: task.id, dependsOn: { completedAt: null } } });
        if (!stillWaiting) {
          await this.notifications.taskEvent(tx, {
            ...base, kind: 'dependency_done', recipientIds: [task.assigneeId],
            task: { id: task.id, shortId: shortId(a.project.keyPrefix, task.number), title: task.title },
          });
        }
      }
    }
  }
}
