import { Injectable } from '@nestjs/common';
import { ActorType, IssueStatus, IssueType, NotificationEvent, Prisma, PriorityLevel, ProjectRole, StatusCategory as C } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { shortId } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';

type Tx = Prisma.TransactionClient;
export type RuleKey = 'review_notify' | 'subtasks_done' | 'critical_priority' | 'pr_merged';

/** The ready-made rules (SRS FR-15.1, 15.2), worded as in the prototype. All start switched on. */
export const RULES: Record<RuleKey, { title: string; description: string; requiresGithub?: boolean }> = {
  review_notify: { title: 'Notify the Project Manager when a task moves to In review', description: 'Sends the PM an in-app and email notification.' },
  subtasks_done: { title: 'Move a parent task to In review when all its subtasks are done', description: 'Saves the PM from checking subtasks one by one.' },
  critical_priority: { title: 'Raise a linked task to High priority when a Critical issue is reported', description: 'Keeps urgent work at the top of lists.' },
  pr_merged: { title: 'Move a task to In review when its pull request is merged', description: 'Needs a connected GitHub repository.', requiresGithub: true },
};
const KEYS = Object.keys(RULES) as RuleKey[];

/**
 * Ready-made automations (SRS 3.15). The other modules ask `enabled()` or call the actions here. Actions are logged
 * with actor type "automation", and they never trigger other rules (API Design), so rules cannot loop.
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /projects/:id/automations */
  async list(projectId: string, userId: string) {
    await this.projectAccess.require(projectId, userId, 'member');
    const [rows, github] = await Promise.all([
      this.prisma.automationRule.findMany({ where: { projectId } }),
      this.prisma.projectRepository.count({ where: { projectId } }),
    ]);
    return {
      data: KEYS.map((key) => {
        const row = rows.find((r) => r.ruleKey === key);
        return { ruleKey: key, ...RULES[key], enabled: row?.enabled ?? true, available: !RULES[key].requiresGithub || github > 0, updatedAt: row?.updatedAt ?? null };
      }),
    };
  }

  /** PATCH /projects/:id/automations/:ruleKey — { "enabled": false } (PM, Admin). */
  async set(projectId: string, userId: string, ruleKey: string, enabled: boolean) {
    const { project } = await this.projectAccess.require(projectId, userId, 'manage');
    this.projectAccess.assertWritable(project);
    if (!KEYS.includes(ruleKey as RuleKey)) throw Errors.notFound('Automation rule');
    await this.prisma.automationRule.upsert({
      where: { projectId_ruleKey: { projectId, ruleKey } },
      create: { projectId, ruleKey, enabled },
      update: { enabled },
    });
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: projectId, action: 'automation_changed', newValue: { ruleKey, enabled } });
    return (await this.list(projectId, userId)).data.find((r) => r.ruleKey === ruleKey);
  }

  /** A rule with no row is on (the default). */
  async enabled(db: Tx | PrismaService, projectId: string, key: RuleKey) {
    const row = await db.automationRule.findUnique({ where: { projectId_ruleKey: { projectId, ruleKey: key } }, select: { enabled: true } });
    return row?.enabled ?? true;
  }

  /**
   * subtasks_done: after a subtask is closed, if every subtask of its parent is done, move the parent to the first
   * Review status — unless the parent is already in review or closed, is blocked, or still waits on a dependency.
   */
  async onSubtaskClosed(tx: Tx, parentTaskId: string) {
    const parent = await tx.task.findUnique({
      where: { id: parentTaskId },
      include: { status: true, project: { select: { id: true, keyPrefix: true, workspaceId: true, spaceId: true } } },
    });
    if (!parent || parent.status.category === C.review || parent.status.category === C.closed) return false;
    if (!(await this.enabled(tx, parent.projectId, 'subtasks_done'))) return false;
    const [open, blockers, waiting, review] = await Promise.all([
      tx.task.count({ where: { parentTaskId, completedAt: null } }),
      tx.issue.count({ where: { taskId: parentTaskId, type: IssueType.blocker, status: { in: [IssueStatus.open, IssueStatus.in_progress] } } }),
      tx.taskDependency.count({ where: { taskId: parentTaskId, dependsOn: { completedAt: null } } }),
      tx.workflowStatus.findFirst({ where: { spaceId: parent.project.spaceId, category: C.review }, orderBy: { position: 'asc' } }),
    ]);
    if (open || blockers || !review || (waiting && parent.status.category === C.not_started)) return false;
    await tx.task.update({ where: { id: parentTaskId }, data: { statusId: review.id } });
    await this.activity.log({
      workspaceId: parent.workspaceId, actorType: ActorType.automation, entityType: 'task', entityId: parentTaskId, action: 'status_moved',
      oldValue: { status: parent.status.name }, newValue: { status: review.name, rule: 'subtasks_done' },
    }, tx);
    const pm = await tx.projectMember.findFirst({ where: { projectId: parent.projectId, role: ProjectRole.project_manager }, select: { userId: true } });
    await this.notifications.notify(tx, {
      workspaceId: parent.workspaceId, eventType: NotificationEvent.review_requested, userIds: [pm?.userId, parent.assigneeId],
      body: `${shortId(parent.project.keyPrefix, parent.number)} ${parent.title} moved to ${review.name} automatically: all its subtasks are done.`,
      link: { type: 'task', id: parentTaskId },
    });
    return true;
  }

  /**
   * pr_merged: a merged pull request that mentions the task moves it to the first Review status, unless it is already
   * in review or closed, is blocked, or has not started and still waits on a dependency. The PM is told.
   */
  async onPullRequestMerged(tx: Tx, taskId: string, pr: string) {
    const task = await tx.task.findUnique({ where: { id: taskId }, include: { status: true, project: { select: { keyPrefix: true, spaceId: true } } } });
    if (!task || task.status.category === C.review || task.status.category === C.closed) return false;
    if (!(await this.enabled(tx, task.projectId, 'pr_merged'))) return false;
    const [blockers, waiting, review] = await Promise.all([
      tx.issue.count({ where: { taskId, type: IssueType.blocker, status: { in: [IssueStatus.open, IssueStatus.in_progress] } } }),
      tx.taskDependency.count({ where: { taskId, dependsOn: { completedAt: null } } }),
      tx.workflowStatus.findFirst({ where: { spaceId: task.project.spaceId, category: C.review }, orderBy: { position: 'asc' } }),
    ]);
    if (blockers || !review || (waiting && task.status.category === C.not_started)) return false;
    await tx.task.update({ where: { id: taskId }, data: { statusId: review.id } });
    await this.activity.log({
      workspaceId: task.workspaceId, actorType: ActorType.github, entityType: 'task', entityId: taskId, action: 'status_moved',
      oldValue: { status: task.status.name }, newValue: { status: review.name, rule: 'pr_merged', pullRequest: pr },
    }, tx);
    const pm = await tx.projectMember.findFirst({ where: { projectId: task.projectId, role: ProjectRole.project_manager }, select: { userId: true } });
    await this.notifications.notify(tx, {
      workspaceId: task.workspaceId, eventType: NotificationEvent.review_requested, userIds: [pm?.userId, task.assigneeId],
      body: `${shortId(task.project.keyPrefix, task.number)} ${task.title} moved to ${review.name}: pull request ${pr} was merged.`,
      link: { type: 'task', id: taskId },
    });
    return true;
  }

  /** critical_priority: a Critical issue raises its linked task to High priority. */
  async onCriticalIssue(tx: Tx, issue: { id: string; projectId: string; taskId: string | null; workspaceId: string }) {
    if (!issue.taskId || !(await this.enabled(tx, issue.projectId, 'critical_priority'))) return false;
    const task = await tx.task.findUnique({ where: { id: issue.taskId }, select: { priority: true, completedAt: true } });
    if (!task || task.completedAt || task.priority === PriorityLevel.high) return false;
    await tx.task.update({ where: { id: issue.taskId }, data: { priority: PriorityLevel.high } });
    await this.activity.log({
      workspaceId: issue.workspaceId, actorType: ActorType.automation, entityType: 'task', entityId: issue.taskId, action: 'updated',
      oldValue: { priority: task.priority }, newValue: { priority: PriorityLevel.high, rule: 'critical_priority', issueId: issue.id },
    }, tx);
    return true;
  }
}
