import { Injectable } from '@nestjs/common';
import { IssueStatus, IssueType, Prisma, ProjectRole, ProjectStatus, SeverityLevel, SprintState, StatusCategory, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { dateOnly, isoDate, shortId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { SpaceAccessService } from '../spaces/space-access.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { CreateProjectDto, ProjectListQuery, UpdateProjectDto } from './dto/project.dto';
import { ProjectAccessService } from './project-access.service';
import { createProjectChannel } from './project-channel';
import { emptyStats, overdueWhere, taskStatsBy, todayFor } from './project-stats';

const userBrief = { id: true, fullName: true, avatarUrl: true } as const;
const OPEN_ISSUE: IssueStatus[] = [IssueStatus.open, IssueStatus.in_progress];
const ATTENTION_LIMIT = 10;

/** Projects (SRS 3.1): created inside a space; the creator, or the person they name, becomes the Project Manager. */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly spaceAccess: SpaceAccessService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /spaces/:id/projects — projects in the space the caller can open, with progress. */
  async list(spaceId: string, userId: string, query: ProjectListQuery) {
    const { membership, space } = await this.spaceAccess.requireSpace(spaceId, userId);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: space.workspaceId }, select: { timezone: true } });
    const projects = await this.prisma.project.findMany({
      where: {
        spaceId,
        ...this.projectAccess.visibleProjectsWhere(membership),
        ...(query.includeArchived || query.status === ProjectStatus.archived ? {} : { archivedAt: null }),
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        members: { where: { OR: [{ role: ProjectRole.project_manager }, { userId }] }, include: { user: { select: userBrief } } },
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
    const stats = await taskStatsBy(this.prisma, 'projectId', projects.map((p) => p.id), todayFor(workspace.timezone));
    return {
      data: projects.map(({ members, _count, ...p }) => ({
        ...this.dates(p),
        manager: members.find((m) => m.role === ProjectRole.project_manager)?.user ?? null,
        myRole: members.find((m) => m.userId === userId)?.role ?? null,
        memberCount: _count.members,
        ...(stats.get(p.id) ?? emptyStats()),
      })),
    };
  }

  /** POST /spaces/:id/projects — Admin, or a Member with canManageProjects who can see the space. */
  async create(spaceId: string, actorId: string, dto: CreateProjectDto) {
    const { space, membership, isAdmin } = await this.spaceAccess.requireSpace(spaceId, actorId);
    if (membership.role === WorkspaceRole.guest) throw Errors.forbidden('Guests have read-only access.');
    if (!isAdmin && !membership.canManageProjects) {
      throw Errors.forbidden('You do not have permission to create projects. Ask the Workspace Admin to give it to you.');
    }
    if (space.archivedAt) throw Errors.conflict('SPACE_ARCHIVED', 'This space is archived, so no projects can be added to it.');
    this.checkDates(dto.startDate, dto.endDate);

    const managerId = dto.managerId ?? actorId;
    if (managerId !== actorId) {
      const [manager] = await this.access.requireWorkspaceUsers(space.workspaceId, [managerId], 'managerId');
      if (manager.role !== WorkspaceRole.admin && !manager.canManageProjects) {
        throw Errors.validation({ managerId: 'must be someone the Workspace Admin has allowed to manage projects' });
      }
    }
    await this.ensureKeyFree(space.workspaceId, dto.keyPrefix);

    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          workspaceId: space.workspaceId,
          spaceId,
          name: dto.name.trim(),
          keyPrefix: dto.keyPrefix,
          description: dto.description?.trim() || null,
          priority: dto.priority ?? undefined,
          startDate: dateOnly(dto.startDate),
          endDate: dateOnly(dto.endDate),
          createdById: actorId,
        },
      });
      const members: Prisma.ProjectMemberCreateManyInput[] = [{ projectId: created.id, userId: managerId, role: ProjectRole.project_manager }];
      // A Member who names someone else as PM stays in the project as a Team Member, so they can still open it.
      if (managerId !== actorId && !isAdmin) members.push({ projectId: created.id, userId: actorId, role: ProjectRole.team_member });
      await tx.projectMember.createMany({ data: members });
      // Project members must be able to see the space.
      await tx.spaceMember.createMany({ data: members.map((m) => ({ spaceId, userId: m.userId })), skipDuplicates: true });
      await createProjectChannel(tx, space.workspaceId, created.id);
      await this.activity.log(
        {
          workspaceId: space.workspaceId, actorId, entityType: 'project', entityId: created.id, action: 'created',
          newValue: { name: created.name, keyPrefix: created.keyPrefix, spaceId, managerId },
        },
        tx,
      );
      return created;
    });
    // TODO (notifications module): tell the named PM when managerId is someone else.
    return this.get(project.id, actorId);
  }

  /** GET /projects/:id — details, the space's workflow (board columns) and custom fields, teams and progress. */
  async get(projectId: string, userId: string) {
    const { project, isAdmin, isManager, projectMember } = await this.projectAccess.require(projectId, userId, 'read');
    const [manager, memberCount, teams, statuses, customFields, stats] = await Promise.all([
      this.prisma.projectMember.findFirst({ where: { projectId, role: ProjectRole.project_manager }, include: { user: { select: userBrief } } }),
      this.prisma.projectMember.count({ where: { projectId } }),
      this.prisma.projectTeam.findMany({ where: { projectId }, include: { team: { select: { id: true, name: true } } } }),
      this.prisma.workflowStatus.findMany({ where: { spaceId: project.spaceId }, orderBy: { position: 'asc' } }),
      this.prisma.customField.findMany({ where: { spaceId: project.spaceId }, orderBy: { position: 'asc' } }),
      taskStatsBy(this.prisma, 'projectId', [projectId], todayFor(project.workspace.timezone)),
    ]);
    const { space, workspace, nextTaskNumber, ...rest } = project;
    const writable = !space.archivedAt && !project.archivedAt;
    return {
      ...this.dates(rest),
      space: { id: space.id, name: space.name, visibility: space.visibility, archived: !!space.archivedAt },
      manager: manager?.user ?? null,
      memberCount,
      teams: teams.map((t) => t.team),
      statuses,
      customFields,
      ...(stats.get(projectId) ?? emptyStats()),
      myRole: projectMember?.role ?? null,
      permissions: {
        canManage: (isAdmin || isManager) && writable,
        canWork: (isAdmin || (!!projectMember && projectMember.role !== ProjectRole.guest)) && writable,
        canMove: isAdmin,
        readOnly: !writable,
      },
    };
  }

  /** PATCH /projects/:id — PM or Admin. The space is changed with the move action, the key prefix never. */
  async update(projectId: string, actorId: string, dto: UpdateProjectDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    const restoring = !!project.archivedAt && dto.status !== undefined && dto.status !== ProjectStatus.archived;
    if (!restoring) this.projectAccess.assertWritable(project);
    else if (project.space.archivedAt) this.projectAccess.assertWritable(project); // a project in an archived space stays read-only

    const start = dto.startDate ?? isoDate(project.startDate)!;
    const end = dto.endDate ?? isoDate(project.endDate)!;
    if (dto.startDate || dto.endDate) this.checkDates(start, end);

    const data: Prisma.ProjectUpdateInput = {};
    if (dto.name) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.priority) data.priority = dto.priority;
    if (dto.startDate) data.startDate = dateOnly(dto.startDate);
    if (dto.endDate) data.endDate = dateOnly(dto.endDate);
    if (dto.status) {
      data.status = dto.status;
      data.archivedAt = dto.status === ProjectStatus.archived ? (project.archivedAt ?? new Date()) : null;
    }
    const updated = await this.prisma.project.update({ where: { id: projectId }, data });
    const fields = ['name', 'description', 'status', 'priority', 'startDate', 'endDate'] as const;
    const pick = (p: typeof updated) => Object.fromEntries(fields.map((f) => [f, p[f] instanceof Date ? isoDate(p[f] as Date) : p[f]]));
    await this.activity.log({
      workspaceId: project.workspaceId, actorId, entityType: 'project', entityId: projectId,
      action: dto.status && dto.status !== project.status ? 'status_changed' : 'updated',
      oldValue: pick(project), newValue: pick(updated),
    });
    return this.get(projectId, actorId);
  }

  /** GET /projects/:id/dashboard — progress, overdue, open issues, phases and the Needs attention list (FR-1.4). */
  async dashboard(projectId: string, userId: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'member');
    const today = todayFor(project.workspace.timezone);
    const taskSelect = {
      id: true, number: true, title: true, dueDate: true, concernNote: true,
      status: { select: { id: true, name: true, category: true } },
      assignee: { select: userBrief },
    } as const;
    const open = { projectId, completedAt: null } as const;
    const [stats, openIssues, criticalIssues, phases, phaseStats, activeSprint, overdue, review, concern, unassigned] = await Promise.all([
      taskStatsBy(this.prisma, 'projectId', [projectId], today),
      this.prisma.issue.count({ where: { projectId, status: { in: OPEN_ISSUE } } }),
      this.prisma.issue.count({ where: { projectId, status: { in: OPEN_ISSUE }, severity: SeverityLevel.critical } }),
      this.prisma.phase.findMany({ where: { projectId }, orderBy: { position: 'asc' } }),
      this.prisma.phase.findMany({ where: { projectId }, select: { id: true } }).then((ph) => taskStatsBy(this.prisma, 'phaseId', ph.map((p) => p.id), today)),
      this.prisma.sprint.findFirst({ where: { projectId, state: SprintState.active }, select: { id: true, name: true, startDate: true, endDate: true } }),
      this.prisma.task.findMany({ where: { projectId, ...overdueWhere(today) }, select: taskSelect, orderBy: { dueDate: 'asc' }, take: ATTENTION_LIMIT }),
      this.prisma.task.findMany({ where: { ...open, status: { category: StatusCategory.review } }, select: taskSelect, orderBy: { updatedAt: 'asc' }, take: ATTENTION_LIMIT }),
      this.prisma.task.findMany({ where: { ...open, acceptance: 'concern' }, select: taskSelect, orderBy: { updatedAt: 'asc' }, take: ATTENTION_LIMIT }),
      this.prisma.task.findMany({ where: { ...open, assigneeId: null, parentTaskId: null }, select: taskSelect, orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }], take: ATTENTION_LIMIT }),
    ]);
    const item = (kind: string) => (t: (typeof overdue)[number]) => ({
      kind,
      task: { id: t.id, shortId: shortId(project.keyPrefix, t.number), title: t.title, dueDate: isoDate(t.dueDate), status: t.status, assignee: t.assignee },
      ...(kind === 'concern' ? { note: t.concernNote } : {}),
    });
    const blockedTaskIds = await this.prisma.issue.findMany({
      where: { projectId, type: IssueType.blocker, status: { in: OPEN_ISSUE }, taskId: { not: null } }, select: { taskId: true }, distinct: ['taskId'],
    });
    return {
      ...(stats.get(projectId) ?? emptyStats()),
      openIssues,
      criticalIssues,
      blockedTasks: blockedTaskIds.length,
      activeSprint: activeSprint ? { ...activeSprint, startDate: isoDate(activeSprint.startDate), endDate: isoDate(activeSprint.endDate) } : null,
      phases: phases.map((p) => {
        const s = phaseStats.get(p.id) ?? emptyStats();
        return { id: p.id, name: p.name, dueDate: isoDate(p.dueDate), ...s, overdue: !!p.dueDate && p.dueDate < today && s.doneTasks < s.totalTasks };
      }),
      // Same kinds as the prototype: Overdue, Awaiting approval, Concern flagged, Unassigned.
      needsAttention: [
        ...overdue.map(item('overdue')),
        ...review.map(item('awaiting_approval')),
        ...concern.map(item('concern')),
        ...unassigned.map(item('unassigned')),
      ],
    };
  }

  // ───────────── helpers ─────────────

  private checkDates(start: string, end: string) {
    if (end <= start) throw Errors.validation({ endDate: 'must be after startDate' });
  }

  private async ensureKeyFree(workspaceId: string, keyPrefix: string) {
    if (await this.prisma.project.findUnique({ where: { workspaceId_keyPrefix: { workspaceId, keyPrefix } } })) {
      throw Errors.conflict('ALREADY_EXISTS', `Another project already uses the key prefix ${keyPrefix}.`);
    }
  }

  /** Sends @db.Date columns as "YYYY-MM-DD". */
  private dates<T extends { startDate: Date; endDate: Date }>(p: T) {
    return { ...p, startDate: isoDate(p.startDate), endDate: isoDate(p.endDate) };
  }
}
