import { Injectable } from '@nestjs/common';
import { AcceptanceState, ProjectRole, StatusCategory } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { shortId } from '../common/utils';
import { DomainEventsService } from '../events/domain-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { WorkloadService } from '../workload/workload.service';
import { AssignDto, ConcernDto, SuggestionsQuery } from './dto/task.dto';
import { rankCandidates } from './suggestions';
import { TaskAccessService } from './task-access.service';
import { TaskViewService } from './task-view.service';

/**
 * Skills-based assignment (SRS 3.3). The server only suggests; the Project Manager always confirms (FR-3.4),
 * and the assignee then accepts the task or flags a concern (FR-3.5).
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly taskAccess: TaskAccessService,
    private readonly view: TaskViewService,
    private readonly workload: WorkloadService,
    private readonly activity: ActivityService,
    private readonly events: DomainEventsService,
  ) {}

  /** GET /tasks/:id/suggestions — ranked project members (API Design, "How suggestions are ranked"). */
  async suggestions(taskId: string, userId: string, q: SuggestionsQuery) {
    const { task, access } = await this.taskAccess.require(taskId, userId, 'manage');
    const required = (await this.prisma.taskSkill.findMany({ where: { taskId }, include: { skill: { select: { name: true } } } }))
      .map((r) => ({ skillId: r.skillId, name: r.skill.name, minLevel: r.minLevel }));

    let teamMemberIds: Set<string> | null = null;
    if (q.teamId) {
      const team = await this.prisma.team.findUnique({ where: { id: q.teamId }, include: { members: { select: { userId: true } } } });
      if (!team || team.workspaceId !== task.workspaceId) throw Errors.validation({ teamId: 'must be a team of this workspace' });
      teamMemberIds = new Set(team.members.map((m) => m.userId));
    }
    const members = await this.prisma.projectMember.findMany({
      where: {
        projectId: task.projectId,
        role: q.includeManager ? { not: ProjectRole.guest } : ProjectRole.team_member,
        ...(teamMemberIds ? { userId: { in: [...teamMemberIds] } } : {}),
      },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true, jobTitle: true, weeklyCapacityHours: true } } },
    });
    const ids = members.map((m) => m.userId);
    const [skills, work] = await Promise.all([
      this.prisma.userSkill.findMany({ where: { userId: { in: ids }, skillId: { in: required.map((r) => r.skillId) } } }),
      this.workload.openWork(task.workspaceId, ids),
    ]);
    // Do not count this task against the person who already has it.
    const ownHours = task.assigneeId && !task.completedAt ? Number(task.estimatedHours ?? 0) : 0;
    const ranked = rankCandidates(
      required,
      members.map((m) => ({
        id: m.userId,
        fullName: m.user.fullName,
        capacityHours: m.user.weeklyCapacityHours,
        openHours: Math.max(0, (work.get(m.userId)?.openHours ?? 0) - (m.userId === task.assigneeId ? ownHours : 0)),
        skills: skills.filter((s) => s.userId === m.userId).map((s) => ({ skillId: s.skillId, level: s.level, verified: !!s.verifiedAt })),
      })),
    );
    const byId = new Map(members.map((m) => [m.userId, m.user]));
    return {
      task: { id: task.id, shortId: shortId(access.project.keyPrefix, task.number), title: task.title, requiredSkills: required },
      considered: ranked.length,
      data: ranked.slice(0, q.limit ?? 10).map(({ userId: id, fullName, ...rest }) => {
        const u = byId.get(id)!;
        return { user: { id, fullName, avatarUrl: u.avatarUrl, jobTitle: u.jobTitle }, ...rest, isCurrentAssignee: id === task.assigneeId };
      }),
    };
  }

  /** POST /tasks/:id/assign — the PM confirms an assignee ({ userId }), or removes one ({ userId: null }). */
  async assign(taskId: string, actorId: string, dto: AssignDto) {
    const { task, access } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(access.project);
    if (task.completedAt) throw Errors.conflict('TASK_CLOSED', 'This task is finished. Reopen it before changing the assignee.');
    if (dto.userId === task.assigneeId) return this.view.detail(taskId, actorId, access);
    if (dto.userId) {
      const member = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: task.projectId, userId: dto.userId } } });
      if (!member || member.role === ProjectRole.guest) {
        throw Errors.unprocessable('NOT_PROJECT_MEMBER', 'Tasks can only be assigned to members of the project (not Guests). Add the person to the project first.');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { assigneeId: dto.userId, acceptance: dto.userId ? AcceptanceState.pending : null, concernNote: null },
      });
      await this.activity.log(
        { workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: dto.userId ? 'assigned' : 'unassigned', oldValue: { assigneeId: task.assigneeId }, newValue: { assigneeId: dto.userId } },
        tx,
      );
    });
    this.events.emit({
      type: dto.userId ? 'task.assigned' : 'task.unassigned',
      workspaceId: task.workspaceId, projectId: task.projectId, taskId, actorId,
      data: { assigneeId: dto.userId, previousAssigneeId: task.assigneeId },
    });
    return this.view.detail(taskId, actorId, access);
  }

  /** POST /tasks/:id/accept — the assignee accepts. */
  async accept(taskId: string, userId: string) {
    const { task, access } = await this.assigneeOnly(taskId, userId, 'accept');
    if (task.acceptance === AcceptanceState.accepted) return this.view.detail(taskId, userId, access);
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { acceptance: AcceptanceState.accepted, concernNote: null } });
      await this.activity.log({ workspaceId: task.workspaceId, actorId: userId, entityType: 'task', entityId: taskId, action: 'accepted', oldValue: { acceptance: task.acceptance } }, tx);
    });
    this.events.emit({ type: 'task.accepted', workspaceId: task.workspaceId, projectId: task.projectId, taskId, actorId: userId });
    return this.view.detail(taskId, userId, access);
  }

  /** POST /tasks/:id/concern — the assignee flags a concern for the PM ({ note }). */
  async concern(taskId: string, userId: string, dto: ConcernDto) {
    const { task, access } = await this.assigneeOnly(taskId, userId, 'flag a concern about');
    const note = dto.note.trim();
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { acceptance: AcceptanceState.concern, concernNote: note } });
      await this.activity.log({ workspaceId: task.workspaceId, actorId: userId, entityType: 'task', entityId: taskId, action: 'concern_flagged', newValue: { note } }, tx);
    });
    this.events.emit({ type: 'task.concern', workspaceId: task.workspaceId, projectId: task.projectId, taskId, actorId: userId, data: { note } });
    return this.view.detail(taskId, userId, access);
  }

  private async assigneeOnly(taskId: string, userId: string, verb: string) {
    const loaded = await this.taskAccess.require(taskId, userId, 'member');
    this.projectAccess.assertWritable(loaded.access.project);
    if (loaded.task.assigneeId !== userId) throw Errors.forbidden(`Only the assignee can ${verb} this task.`);
    const status = await this.prisma.workflowStatus.findUniqueOrThrow({ where: { id: loaded.task.statusId } });
    if (status.category === StatusCategory.closed) throw Errors.conflict('TASK_CLOSED', 'This task is already finished.');
    return loaded;
  }
}
