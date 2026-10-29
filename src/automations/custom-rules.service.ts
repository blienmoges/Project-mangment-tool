import { Injectable } from '@nestjs/common';
import { ActorType, IssueStatus, IssueType, NotificationEvent, Prisma, ProjectRole, StatusCategory as C } from '@prisma/client';
import { randomBytes } from 'crypto';
import { ActivityService } from '../activity/activity.service';
import { AppException, Errors } from '../common/app-exception';
import { shortId } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { checkProgress } from '../tasks/task-workflow';
import { Facts, matches, render, RuleContext, RuleDefinition, Trigger, validateRule } from './custom-rules';

type Tx = Prisma.TransactionClient;
const PREFIX = 'c_';
const MAX_RULES = 50;

export interface RuleEvent { projectId: string; taskId?: string | null; issueId?: string; toStatusId?: string }

/** Custom automation rules: managed by the Workspace Admin, run inside the change that triggers them. */
@Injectable()
export class CustomRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  async list(projectId: string, userId: string) {
    await this.projectAccess.require(projectId, userId, 'member');
    const rows = await this.prisma.automationRule.findMany({ where: { projectId, ruleKey: { startsWith: PREFIX } }, orderBy: { createdAt: 'asc' } });
    return { data: rows.map((r) => this.out(r)) };
  }

  async get(ruleId: string, userId: string) {
    const row = await this.find(ruleId);
    await this.projectAccess.require(row.projectId, userId, 'member', 'Rule');
    return this.out(row);
  }

  /** POST /automations/validate — { projectId, rule }: the problems, without saving. */
  async check(projectId: string, userId: string, rule: unknown) {
    await this.projectAccess.require(projectId, userId, 'admin');
    const { fields } = validateRule(rule, await this.context(projectId));
    return { valid: !Object.keys(fields).length, problems: fields };
  }

  async create(projectId: string, userId: string, body: unknown) {
    const { project } = await this.projectAccess.require(projectId, userId, 'admin');
    this.projectAccess.assertWritable(project);
    if ((await this.prisma.automationRule.count({ where: { projectId, ruleKey: { startsWith: PREFIX } } })) >= MAX_RULES) {
      throw Errors.conflict('TOO_MANY_RULES', `A project can have at most ${MAX_RULES} custom rules.`);
    }
    const rule = await this.validOrThrow(projectId, body);
    const row = await this.prisma.automationRule.create({
      data: { projectId, ruleKey: PREFIX + randomBytes(16).toString('hex'), enabled: (body as { enabled?: boolean })?.enabled !== false, config: { rule, createdById: userId } as unknown as Prisma.InputJsonValue },
    });
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: projectId, action: 'automation_created', newValue: { ruleId: row.id, name: rule.name } });
    return this.out(row);
  }

  /** PATCH /automations/:id — a whole new definition, and/or { "enabled": false }. */
  async update(ruleId: string, userId: string, body: unknown) {
    const row = await this.find(ruleId);
    const { project } = await this.projectAccess.require(row.projectId, userId, 'admin', 'Rule');
    this.projectAccess.assertWritable(project);
    const b = (body ?? {}) as Record<string, unknown>;
    const onlyToggle = Object.keys(b).every((k) => k === 'enabled');
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw this.invalid({ enabled: 'must be true or false' });
    const config = row.config as unknown as { rule: RuleDefinition; createdById: string };
    const rule = onlyToggle ? config.rule : await this.validOrThrow(row.projectId, b);
    const updated = await this.prisma.automationRule.update({
      where: { id: ruleId },
      data: { ...(b.enabled !== undefined ? { enabled: b.enabled as boolean } : {}), config: { ...config, rule } as unknown as Prisma.InputJsonValue },
    });
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: row.projectId, action: 'automation_updated', newValue: { ruleId, name: rule.name, enabled: updated.enabled } });
    return this.out(updated);
  }

  async remove(ruleId: string, userId: string) {
    const row = await this.find(ruleId);
    const { project } = await this.projectAccess.require(row.projectId, userId, 'admin', 'Rule');
    await this.prisma.automationRule.delete({ where: { id: ruleId } });
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: row.projectId, action: 'automation_deleted', oldValue: { ruleId, name: (row.config as unknown as { rule: RuleDefinition }).rule.name } });
  }

  /**
   * Runs the project's enabled rules for an event, inside the caller's transaction. Rule actions write directly and
   * never raise events, so no rule can trigger another. Returns how many rules ran.
   */
  async run(tx: Tx, event: Trigger, e: RuleEvent) {
    const rows = await tx.automationRule.findMany({ where: { projectId: e.projectId, enabled: true, ruleKey: { startsWith: PREFIX } }, orderBy: { createdAt: 'asc' } });
    const rules = rows.map((r) => ({ id: r.id, ...(r.config as unknown as { rule: RuleDefinition; createdById: string }) }))
      .filter((r) => r.rule.trigger.event === event && (!r.rule.trigger.toStatusId || r.rule.trigger.toStatusId === e.toStatusId));
    if (!rules.length) return 0;
    let ran = 0;
    for (const r of rules) {
      // Facts are read again for every rule, so a rule sees what the rules before it changed.
      const task = e.taskId ? await tx.task.findUnique({ where: { id: e.taskId }, include: { status: true, project: { select: { keyPrefix: true, name: true, spaceId: true, workspaceId: true } } } }) : null;
      const issue = e.issueId ? await tx.issue.findUnique({ where: { id: e.issueId } }) : null;
      const facts: Facts = {
        'task.priority': task?.priority ?? null, 'task.assigneeId': task?.assigneeId ?? null, 'task.phaseId': task?.phaseId ?? null,
        'task.sprintId': task?.sprintId ?? null, 'task.statusCategory': task?.status.category ?? null,
        'issue.severity': issue?.severity ?? null, 'issue.type': issue?.type ?? null,
      };
      if (!matches(r.rule.conditions, facts)) continue;
      const workspaceId = task?.project.workspaceId ?? issue?.workspaceId;
      if (!workspaceId) continue;
      const project = task?.project ?? (await tx.project.findUniqueOrThrow({ where: { id: e.projectId }, select: { keyPrefix: true, name: true, spaceId: true, workspaceId: true } }));
      const values = { taskShortId: task ? shortId(project.keyPrefix, task.number) : undefined, taskTitle: task?.title, issueTitle: issue?.title, project: `${project.keyPrefix} ${project.name}`, rule: r.rule.name };
      const done: string[] = [];
      for (const a of r.rule.actions) {
        if (a.type === 'notify') {
          const ids = new Set<string>(a.recipients.userIds ?? []);
          if (a.recipients.assignee && task?.assigneeId) ids.add(task.assigneeId);
          if (a.recipients.reporter && issue) ids.add(issue.reporterId);
          if (a.recipients.manager) {
            const pm = await tx.projectMember.findFirst({ where: { projectId: e.projectId, role: ProjectRole.project_manager }, select: { userId: true } });
            if (pm) ids.add(pm.userId);
          }
          if (a.recipients.teamId) (await tx.teamMember.findMany({ where: { teamId: a.recipients.teamId }, select: { userId: true } })).forEach((m) => ids.add(m.userId));
          await this.notifications.notify(tx, {
            workspaceId, eventType: NotificationEvent.automation, userIds: [...ids], body: render(a.message, values),
            link: task ? { type: 'task', id: task.id } : issue ? { type: 'issue', id: issue.id } : { type: 'project', id: e.projectId },
          });
          done.push('notify');
        } else if (a.type === 'set_priority' && task && !task.completedAt && task.priority !== a.priority) {
          await tx.task.update({ where: { id: task.id }, data: { priority: a.priority } });
          done.push(`priority:${a.priority}`);
        } else if (a.type === 'move_status' && task && task.status.category !== C.closed && task.statusId !== a.statusId) {
          const to = await tx.workflowStatus.findFirst({ where: { id: a.statusId, spaceId: project.spaceId } });
          if (!to || to.category === C.closed) continue; // deleted or changed since the rule was saved
          const [blockers, waiting] = await Promise.all([
            tx.issue.count({ where: { taskId: task.id, type: IssueType.blocker, status: { in: [IssueStatus.open, IssueStatus.in_progress] } } }),
            tx.taskDependency.count({ where: { taskId: task.id, dependsOn: { completedAt: null } } }),
          ]);
          if (checkProgress(task.status, to, { blocked: blockers > 0, unfinishedDependencies: waiting })) continue; // workflow rules still apply
          await tx.task.update({ where: { id: task.id }, data: { statusId: to.id } });
          done.push(`status:${to.name}`);
        } else if (a.type === 'add_comment' && task) {
          const author = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: r.createdById } } });
          if (!author) continue; // the Admin who made the rule has left the workspace
          await tx.comment.create({ data: { taskId: task.id, authorId: r.createdById, body: `Automation "${r.rule.name}": ${render(a.text, values)}` } });
          done.push('comment');
        }
      }
      ran++;
      await this.activity.log({
        workspaceId, actorType: ActorType.automation, entityType: task ? 'task' : 'issue', entityId: (task?.id ?? issue?.id)!,
        action: 'automation_ran', newValue: { ruleId: r.id, rule: r.rule.name, event, actions: done },
      }, tx);
    }
    return ran;
  }

  private async context(projectId: string): Promise<RuleContext> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { spaceId: true, workspaceId: true } });
    const [statuses, members, phases, sprints, teams] = await Promise.all([
      this.prisma.workflowStatus.findMany({ where: { spaceId: project.spaceId }, select: { id: true, category: true } }),
      this.prisma.projectMember.findMany({ where: { projectId, role: { not: ProjectRole.guest } }, select: { userId: true } }),
      this.prisma.phase.findMany({ where: { projectId }, select: { id: true } }),
      this.prisma.sprint.findMany({ where: { projectId }, select: { id: true } }),
      this.prisma.team.findMany({ where: { workspaceId: project.workspaceId }, select: { id: true } }),
    ]);
    return { statuses, memberIds: members.map((m) => m.userId), phaseIds: phases.map((p) => p.id), sprintIds: sprints.map((s) => s.id), teamIds: teams.map((t) => t.id) };
  }

  private async validOrThrow(projectId: string, body: unknown) {
    const { fields, rule } = validateRule(body, await this.context(projectId));
    if (!rule) throw this.invalid(fields);
    return rule;
  }

  private invalid(fields: Record<string, string>) {
    return new AppException(422, { code: 'INVALID_AUTOMATION_RULE', message: 'The rule has problems; see fields.', fields });
  }

  private async find(id: string) {
    const row = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!row || !row.ruleKey.startsWith(PREFIX)) throw Errors.notFound('Rule');
    return row;
  }

  private out(r: { id: string; projectId: string; enabled: boolean; config: Prisma.JsonValue; createdAt: Date; updatedAt: Date }) {
    const c = r.config as unknown as { rule: RuleDefinition; createdById: string };
    return { id: r.id, projectId: r.projectId, enabled: r.enabled, ...c.rule, createdById: c.createdById, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
}
