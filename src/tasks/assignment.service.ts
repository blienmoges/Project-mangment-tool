import { Injectable } from '@nestjs/common';
import { AcceptanceState, ProjectRole, StatusCategory } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { shortId } from '../common/utils';
import { CustomRulesService } from '../automations/custom-rules.service';
import { DeadlinesService } from '../jobs/deadlines.service';
import { NotificationsService } from '../notifications/notifications.service';
import { afterCommit, PrismaService } from '../prisma/prisma.service';
import { WorkloadService } from '../workload/workload.service';
import { AssignDto, ConcernDto, SuggestionsQuery } from './dto/task.dto';
import { Candidate, rank } from './suggestions';
import { TaskAccessService } from './task-access.service';
import { TasksService } from './tasks.service';

/**
 * Skills-based assignment (SRS 3.3). The server only suggests; the Project Manager always confirms (FR-3.4),
 * and the assignee then accepts the task or flags a concern (FR-3.5).
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskAccess: TaskAccessService,
    private readonly tasks: TasksService,
    private readonly workload: WorkloadService,
    private readonly notifications: NotificationsService,
    private readonly deadlines: DeadlinesService,
    private readonly activity: ActivityService,
    private readonly rules: CustomRulesService,
  ) {}

  /** GET /tasks/:id/suggestions — ranked by the API Design's formula. */
  async suggestions(taskId: string, userId: string, q: SuggestionsQuery) {
    const { task, project } = await this.taskAccess.require(taskId, userId, 'manage');
    let teamMemberIds: string[] | null = null;
    if (q.teamId) {
      const team = await this.prisma.team.findFirst({ where: { id: q.teamId, workspaceId: task.workspaceId }, include: { members: { select: { userId: true } } } });
      if (!team) throw Errors.notFound('Team');
      teamMemberIds = team.members.map((m) => m.userId);
    }
    const roles = q.includeManager ? [ProjectRole.team_member, ProjectRole.project_manager] : [ProjectRole.team_member];
    const members = await this.prisma.projectMember.findMany({
      where: { projectId: task.projectId, role: { in: roles }, ...(teamMemberIds ? { userId: { in: teamMemberIds } } : {}) },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true, jobTitle: true, weeklyCapacityHours: true } } },
    });
    const required = (await this.prisma.taskSkill.findMany({ where: { taskId }, include: { skill: { select: { name: true } } } }))
      .map((s) => ({ skillId: s.skillId, name: s.skill.name, minLevel: s.minLevel }));
    const userIds = members.map((m) => m.userId);
    const [userSkills, work] = await Promise.all([
      required.length
        ? this.prisma.userSkill.findMany({ where: { userId: { in: userIds }, skillId: { in: required.map((r) => r.skillId) } } })
        : Promise.resolve([]),
      this.workload.openWork(task.workspaceId, userIds),
    ]);
    const ownHours = task.completedAt ? 0 : Number(task.estimatedHours ?? 0);
    const candidates: Candidate[] = members.map((m) => {
      const w = work.get(m.userId) ?? { openHours: 0, openTasks: 0 };
      const isCurrent = task.assigneeId === m.userId;
      return {
        user: { id: m.user.id, fullName: m.user.fullName, avatarUrl: m.user.avatarUrl, jobTitle: m.user.jobTitle },
        capacityHours: m.user.weeklyCapacityHours,
        // Compare fairly when reassigning: the current assignee's load does not include this task.
        openHours: Math.max(0, w.openHours - (isCurrent ? ownHours : 0)),
        openTasks: w.openTasks - (isCurrent && !task.completedAt ? 1 : 0),
        skills: new Map(userSkills.filter((s) => s.userId === m.userId).map((s) => [s.skillId, { level: s.level, verified: !!s.verifiedAt }])),
        isCurrentAssignee: isCurrent,
      };
    });
    return {
      task: { id: task.id, shortId: shortId(project.keyPrefix, task.number), title: task.title, requiredSkills: required },
      considered: candidates.length,
      data: rank(candidates, required, q.limit ?? 10),
    };
  }

  /** POST /tasks/:id/assign — the PM confirms an assignee (or null to unassign). The person must accept it. */
  async assign(taskId: string, actorId: string, dto: AssignDto) {
    const { task, project } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.taskAccess.assertWritable({ project });
    if (task.status.category === StatusCategory.closed) throw Errors.conflict('TASK_CLOSED', 'This task is finished. Reopen it before assigning it.');
    if (dto.userId === task.assigneeId) return this.tasks.detailFor(taskId, actorId);
    if (dto.userId) {
      const member = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: task.projectId, userId: dto.userId } } });
      if (!member || member.role === ProjectRole.guest) {
        throw Errors.unprocessable('NOT_PROJECT_MEMBER', 'Tasks can only be assigned to members of the project (not Guests). Add the person to the project first.');
      }
    }
    await this.prisma.tx(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { assigneeId: dto.userId, acceptance: dto.userId ? AcceptanceState.pending : null, concernNote: null },
      });
      await this.activity.log(
        { workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: dto.userId ? 'assigned' : 'unassigned', oldValue: { assigneeId: task.assigneeId }, newValue: { assigneeId: dto.userId } },
        tx,
      );
      if (dto.userId) {
        await this.notifications.taskEvent(tx, {
          kind: 'task_assigned', workspaceId: task.workspaceId, actorId, recipientIds: [dto.userId],
          task: { id: task.id, shortId: shortId(project.keyPrefix, task.number), title: task.title },
        });
      }
      // Reminders go to whoever is assigned when they fire; scheduling again is harmless (jobs have fixed ids).
      if (dto.userId) {
        await this.rules.run(tx, 'task.assigned', { projectId: task.projectId, taskId });
        afterCommit(() => this.deadlines.scheduleTask(taskId));
      }
    });
    return this.tasks.detailFor(taskId, actorId);
  }

  /** POST /tasks/:id/accept — assignee only. */
  accept(taskId: string, userId: string) {
    return this.respond(taskId, userId, AcceptanceState.accepted);
  }

  /** POST /tasks/:id/concern — assignee only; the PM sees it under Needs attention. */
  concern(taskId: string, userId: string, dto: ConcernDto) {
    return this.respond(taskId, userId, AcceptanceState.concern, dto.note.trim());
  }

  private async respond(taskId: string, userId: string, answer: AcceptanceState, note?: string) {
    const { task, project, isAssignee } = await this.taskAccess.require(taskId, userId, 'member');
    if (!isAssignee) throw Errors.forbidden('Only the person the task is assigned to can do this.');
    this.taskAccess.assertWritable({ project });
    if (task.status.category === StatusCategory.closed) throw Errors.conflict('TASK_CLOSED', 'This task is already finished.');
    if (answer === AcceptanceState.accepted && task.acceptance === AcceptanceState.accepted) return this.tasks.detailFor(taskId, userId);
    const manager = await this.prisma.projectMember.findFirst({ where: { projectId: task.projectId, role: ProjectRole.project_manager }, select: { userId: true } });
    await this.prisma.tx(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { acceptance: answer, concernNote: note ?? null } });
      await this.activity.log(
        { workspaceId: task.workspaceId, actorId: userId, entityType: 'task', entityId: taskId, action: answer === AcceptanceState.accepted ? 'accepted' : 'concern_flagged', newValue: note ? { note } : undefined },
        tx,
      );
      await this.notifications.taskEvent(tx, {
        kind: answer === AcceptanceState.accepted ? 'task_accepted' : 'task_concern',
        workspaceId: task.workspaceId, actorId: userId, recipientIds: [manager?.userId], note,
        task: { id: task.id, shortId: shortId(project.keyPrefix, task.number), title: task.title },
      });
    });
    return this.tasks.detailFor(taskId, userId);
  }
}
