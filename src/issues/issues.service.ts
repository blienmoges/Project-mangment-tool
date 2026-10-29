import { Injectable } from '@nestjs/common';
import { IssueStatus, IssueType, NotificationEvent, Prisma, ProjectRole, SeverityLevel } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { AutomationsService } from '../automations/automations.service';
import { CustomRulesService } from '../automations/custom-rules.service';
import { Errors } from '../common/app-exception';
import { pageArgs, toPage } from '../common/paging';
import { shortId } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService, ProjectWithSpace } from '../projects/project-access.service';
import { AssignIssueDto, CreateIssueDto, IssueListQuery, IssueStatusDto, UpdateIssueDto } from './dto/issue.dto';
import { checkIssueMove, OPEN_ISSUE_STATUSES } from './issue-rules';

type Tx = Prisma.TransactionClient;
const userBrief = { id: true, fullName: true, avatarUrl: true } as const;
const include = {
  reporter: { select: userBrief },
  assignee: { select: userBrief },
  task: { select: { id: true, number: true, title: true, assigneeId: true, status: { select: { name: true, category: true } } } },
  project: { select: { keyPrefix: true } },
} satisfies Prisma.IssueInclude;
type IssueRow = Prisma.IssueGetPayload<{ include: typeof include }>;

const TYPE_LABEL: Record<IssueType, string> = { bug: 'bug', blocker: 'blocker', question: 'question', risk: 'risk' };
const SEVERITY_LABEL: Record<SeverityLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

/**
 * Issues (SRS 3.6). Any project member (not a Guest) reports; the PM and the linked task's assignee are notified,
 * and for Critical issues the whole project team, including by SMS (FR-6.3). An open blocker linked to a task makes
 * the task "blocked" (FR-6.2): the tasks module refuses to move it forward until the issue is resolved.
 */
@Injectable()
export class IssuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly automations: AutomationsService,
    private readonly rules?: CustomRulesService,
  ) {}

  /** GET /projects/:id/issues — most severe first, then newest. */
  async list(projectId: string, userId: string, q: IssueListQuery) {
    await this.projectAccess.require(projectId, userId, 'member');
    const where: Prisma.IssueWhereInput = { projectId };
    if (q.status) where.status = q.status === 'unresolved' ? { in: OPEN_ISSUE_STATUSES } : (q.status as IssueStatus);
    if (q.type) where.type = q.type;
    if (q.severity) where.severity = q.severity;
    if (q.taskId) where.taskId = q.taskId;
    if (q.assigneeId) where.assigneeId = q.assigneeId === 'me' ? userId : q.assigneeId === 'none' ? null : q.assigneeId;
    if (q.q?.trim()) where.OR = [{ title: { contains: q.q.trim(), mode: 'insensitive' } }, { description: { contains: q.q.trim(), mode: 'insensitive' } }];
    const rows = await this.prisma.issue.findMany({ where, include, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], ...pageArgs(q) });
    return toPage(rows, q, (r) => this.brief(r));
  }

  /** POST /projects/:id/issues */
  async create(projectId: string, userId: string, dto: CreateIssueDto) {
    const { project } = await this.projectAccess.require(projectId, userId, 'member');
    this.projectAccess.assertWritable(project);
    if (dto.taskId) await this.checkTask(projectId, dto.taskId);
    const issue = await this.prisma.tx(async (tx) => {
      const created = await tx.issue.create({
        data: {
          workspaceId: project.workspaceId, projectId, reporterId: userId, title: dto.title.trim(), type: dto.type, severity: dto.severity,
          description: dto.description?.trim() || null, taskId: dto.taskId ?? null,
          stepsToReproduce: dto.stepsToReproduce?.trim() || null, expectedResult: dto.expectedResult?.trim() || null, actualResult: dto.actualResult?.trim() || null,
          device: dto.device?.trim() || null, operatingSystem: dto.operatingSystem?.trim() || null, appVersion: dto.appVersion?.trim() || null,
        },
        include,
      });
      await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'issue', entityId: created.id, action: 'reported', newValue: { title: created.title, type: created.type, severity: created.severity, taskId: created.taskId } }, tx);
      await this.announce(tx, project, created, userId, 'reported');
      await this.rules?.run(tx, 'issue.created', { projectId, issueId: created.id, taskId: created.taskId });
      return created;
    });
    return this.detail(issue.id, userId);
  }

  /** GET /issues/:id */
  async get(issueId: string, userId: string) {
    await this.load(issueId, userId);
    return this.detail(issueId, userId);
  }

  /** PATCH /issues/:id — reporter, PM, Admin. Raising the severity to Critical alerts the team. */
  async update(issueId: string, userId: string, dto: UpdateIssueDto) {
    const { issue, project, isManager } = await this.load(issueId, userId);
    if (!isManager && issue.reporterId !== userId) throw Errors.forbidden('Only the reporter or the Project Manager can edit this issue.');
    this.projectAccess.assertWritable(project);
    if (dto.taskId) await this.checkTask(issue.projectId, dto.taskId);
    const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    const data: Prisma.IssueUncheckedUpdateInput = {
      title: dto.title?.trim(), type: dto.type, severity: dto.severity, taskId: dto.taskId,
      description: text(dto.description), stepsToReproduce: text(dto.stepsToReproduce), expectedResult: text(dto.expectedResult),
      actualResult: text(dto.actualResult), device: text(dto.device), operatingSystem: text(dto.operatingSystem), appVersion: text(dto.appVersion),
    };
    await this.prisma.tx(async (tx) => {
      const updated = await tx.issue.update({ where: { id: issueId }, data, include });
      const changed = Object.keys(dto) as (keyof UpdateIssueDto)[];
      await this.activity.log({
        workspaceId: issue.workspaceId, actorId: userId, entityType: 'issue', entityId: issueId, action: 'updated',
        oldValue: Object.fromEntries(changed.map((k) => [k, (issue as Record<string, unknown>)[k] ?? null])) as Prisma.InputJsonValue,
        newValue: Object.fromEntries(changed.map((k) => [k, (updated as Record<string, unknown>)[k] ?? null])) as Prisma.InputJsonValue,
      }, tx);
      if (updated.severity === SeverityLevel.critical && issue.severity !== SeverityLevel.critical && OPEN_ISSUE_STATUSES.includes(updated.status)) {
        await this.announce(tx, project, updated, userId, 'raised to Critical');
      }
    });
    return this.detail(issueId, userId);
  }

  /** POST /issues/:id/assign — the PM chooses who fixes it (FR-6.4). */
  async assign(issueId: string, userId: string, dto: AssignIssueDto) {
    const { issue, project, isManager } = await this.load(issueId, userId);
    if (!isManager) throw Errors.forbidden('Only the Project Manager can choose who fixes an issue.');
    this.projectAccess.assertWritable(project);
    if (dto.userId === issue.assigneeId) return this.detail(issueId, userId);
    if (dto.userId) {
      const m = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: issue.projectId, userId: dto.userId } } });
      if (!m || m.role === ProjectRole.guest) throw Errors.unprocessable('NOT_PROJECT_MEMBER', 'Issues can only be assigned to members of the project (not Guests).');
    }
    await this.prisma.tx(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data: { assigneeId: dto.userId } });
      await this.activity.log({ workspaceId: issue.workspaceId, actorId: userId, entityType: 'issue', entityId: issueId, action: dto.userId ? 'assigned' : 'unassigned', oldValue: { assigneeId: issue.assigneeId }, newValue: { assigneeId: dto.userId } }, tx);
      if (dto.userId) {
        const actor = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } });
        await this.notifications.notify(tx, {
          workspaceId: issue.workspaceId, eventType: NotificationEvent.issue, userIds: [dto.userId], actorId: userId,
          body: `${actor?.fullName ?? 'The Project Manager'} asked you to fix the ${SEVERITY_LABEL[issue.severity]} ${TYPE_LABEL[issue.type]} "${issue.title}" in ${project.keyPrefix}.`,
          link: { type: 'issue', id: issueId },
        });
      }
    });
    return this.detail(issueId, userId);
  }

  /** POST /issues/:id/status — resolving notifies the reporter (FR-6.5) and, for a blocker, the task's assignee. */
  async setStatus(issueId: string, userId: string, dto: IssueStatusDto) {
    const { issue, project, isManager } = await this.load(issueId, userId);
    this.projectAccess.assertWritable(project);
    if (dto.status === issue.status) return this.detail(issueId, userId);
    const err = checkIssueMove(issue.status, dto.status, { isManager, isReporter: issue.reporterId === userId, isFixer: issue.assigneeId === userId });
    if (err) throw err;
    const now = new Date();
    const data: Prisma.IssueUpdateInput = { status: dto.status };
    if (dto.status === IssueStatus.resolved) data.resolvedAt = issue.resolvedAt ?? now;
    if (dto.status === IssueStatus.closed) { data.closedAt = now; data.resolvedAt = issue.resolvedAt ?? now; }
    if (OPEN_ISSUE_STATUSES.includes(dto.status)) { data.resolvedAt = null; data.closedAt = null; }
    await this.prisma.tx(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data });
      await this.activity.log({ workspaceId: issue.workspaceId, actorId: userId, entityType: 'issue', entityId: issueId, action: 'status_changed', oldValue: { status: issue.status }, newValue: { status: dto.status } }, tx);
      const nowSettled = dto.status === IssueStatus.resolved || dto.status === IssueStatus.closed;
      if (nowSettled && OPEN_ISSUE_STATUSES.includes(issue.status)) {
        const unblocks = issue.type === IssueType.blocker && issue.task;
        const actor = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } });
        await this.notifications.notify(tx, {
          workspaceId: issue.workspaceId, eventType: NotificationEvent.resolved, userIds: [issue.reporterId, unblocks ? issue.task!.assigneeId : null], actorId: userId,
          body: `${actor?.fullName ?? 'Someone'} ${dto.status} the issue "${issue.title}" in ${project.keyPrefix}.${unblocks ? ` ${shortId(project.keyPrefix, issue.task!.number)} is no longer blocked by it.` : ''}`,
          link: { type: 'issue', id: issueId },
        });
      }
    });
    return this.detail(issueId, userId);
  }

  // ───────────── helpers ─────────────

  private async load(issueId: string, userId: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id: issueId }, include });
    if (!issue) throw Errors.notFound('Issue');
    const access = await this.projectAccess.require(issue.projectId, userId, 'member', 'Issue');
    return { issue, project: access.project, isManager: access.isAdmin || access.isManager };
  }

  private async checkTask(projectId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task || task.projectId !== projectId) throw Errors.validation({ taskId: 'must be a task of the same project' });
  }

  /** FR-6.3: PM and the task's assignee; for Critical, every member of the project (not Guests), with SMS by default. */
  private async announce(tx: Tx, project: ProjectWithSpace, issue: IssueRow, actorId: string, what: 'reported' | 'raised to Critical') {
    const critical = issue.severity === SeverityLevel.critical;
    if (critical) await this.automations.onCriticalIssue(tx, issue); // critical_priority: linked task → High
    const recipients = await tx.projectMember.findMany({
      where: { projectId: issue.projectId, ...(critical ? { role: { not: ProjectRole.guest } } : { role: ProjectRole.project_manager }) },
      select: { userId: true },
    });
    const actor = await tx.user.findUnique({ where: { id: actorId }, select: { fullName: true } });
    const task = issue.task ? ` on ${shortId(project.keyPrefix, issue.task.number)} ${issue.task.title}` : '';
    const blocked = issue.type === IssueType.blocker && issue.task ? ` ${shortId(project.keyPrefix, issue.task.number)} is blocked until it is resolved.` : '';
    const body = what === 'reported'
      ? `${actor?.fullName ?? 'Someone'} reported a ${SEVERITY_LABEL[issue.severity]} ${TYPE_LABEL[issue.type]} in ${project.keyPrefix}${task}: "${issue.title}".${blocked}`
      : `The issue "${issue.title}" in ${project.keyPrefix}${task} was raised to Critical.${blocked}`;
    await this.notifications.notify(tx, {
      workspaceId: issue.workspaceId, eventType: critical ? NotificationEvent.critical : NotificationEvent.issue,
      userIds: [...recipients.map((r) => r.userId), issue.task?.assigneeId], actorId, body, link: { type: 'issue', id: issue.id },
    });
  }

  private brief(r: IssueRow) {
    return {
      id: r.id, projectId: r.projectId, title: r.title, type: r.type, severity: r.severity, status: r.status,
      task: r.task ? { id: r.task.id, shortId: shortId(r.project.keyPrefix, r.task.number), title: r.task.title, status: r.task.status } : null,
      reporter: r.reporter, assignee: r.assignee,
      /** An open blocker linked to a task blocks that task. */
      blocksTask: r.type === IssueType.blocker && !!r.task && OPEN_ISSUE_STATUSES.includes(r.status),
      createdAt: r.createdAt, updatedAt: r.updatedAt, resolvedAt: r.resolvedAt, closedAt: r.closedAt,
    };
  }

  private async detail(issueId: string, userId: string) {
    const { issue: r, project, isManager } = await this.load(issueId, userId);
    const writable = !project.archivedAt && !project.space.archivedAt;
    const actor = { isManager, isReporter: r.reporterId === userId, isFixer: r.assigneeId === userId };
    return {
      ...this.brief(r),
      description: r.description, stepsToReproduce: r.stepsToReproduce, expectedResult: r.expectedResult, actualResult: r.actualResult,
      device: r.device, operatingSystem: r.operatingSystem, appVersion: r.appVersion,
      permissions: {
        canEdit: writable && (isManager || actor.isReporter),
        canAssign: writable && isManager,
        /** Statuses POST /issues/:id/status accepts from the caller now. */
        allowedStatuses: writable ? Object.values(IssueStatus).filter((s) => s !== r.status && !checkIssueMove(r.status, s, actor)) : [],
      },
    };
  }
}
