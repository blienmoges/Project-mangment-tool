import { Injectable } from '@nestjs/common';
import { NotificationEvent, ProjectRole, SpaceVisibility, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { unique } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TeamAccessService } from '../teams/team-access.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AddProjectMembersDto, ChangeProjectRoleDto } from './dto/project.dto';
import { ProjectAccessService } from './project-access.service';
import { syncProjectChannels } from './project-channel';

const userFields = { id: true, fullName: true, email: true, jobTitle: true, avatarUrl: true, weeklyCapacityHours: true } as const;

/**
 * Project members (SRS FR-1.2, FR-10.3). Rules:
 *  - Every project has exactly one Project Manager; it can be handed over, never left empty (409 PROJECT_MANAGER_REQUIRED).
 *  - Workspace Guests always have the guest project role (read-only); others are PM or Team Member.
 *  - Removed people have their unfinished tasks in the project unassigned.
 *  - In a Private space, project members are also added to the space; Guests are always added to it.
 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly projectAccess: ProjectAccessService,
    private readonly teamAccess: TeamAccessService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  async list(projectId: string, userId: string) {
    await this.projectAccess.require(projectId, userId, 'member');
    const [rows, teams, open] = await Promise.all([
      this.prisma.projectMember.findMany({ where: { projectId }, include: { user: { select: userFields }, addedViaTeam: { select: { id: true, name: true } } } }),
      this.prisma.projectTeam.findMany({ where: { projectId }, include: { team: { select: { id: true, name: true, _count: { select: { members: true } } } } } }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where: { projectId, completedAt: null, assigneeId: { not: null } }, _count: { _all: true } }),
    ]);
    const roleOrder: Record<ProjectRole, number> = { project_manager: 0, team_member: 1, guest: 2 };
    return {
      data: rows
        .map((r) => ({
          ...r.user,
          role: r.role,
          addedViaTeam: r.addedViaTeam,
          addedAt: r.addedAt,
          openTasksInProject: open.find((o) => o.assigneeId === r.userId)?._count._all ?? 0,
        }))
        .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.fullName.localeCompare(b.fullName)),
      teams: teams.map((t) => ({ id: t.team.id, name: t.team.name, memberCount: t.team._count.members, addedAt: t.createdAt })),
    };
  }

  /** POST /projects/:id/members — add people and/or whole teams (PM, Admin). */
  async add(projectId: string, actorId: string, dto: AddProjectMembersDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const userIds = unique(dto.userIds ?? []);
    const teamIds = unique(dto.teamIds ?? []);
    if (!userIds.length && !teamIds.length) throw Errors.validation({ userIds: 'send userIds, teamIds, or both' });
    const memberships = await this.access.requireWorkspaceUsers(project.workspaceId, userIds, 'userIds', { allowGuests: true });
    if (teamIds.length) {
      const found = await this.prisma.team.findMany({ where: { id: { in: teamIds }, workspaceId: project.workspaceId }, select: { id: true } });
      const missing = teamIds.filter((id) => !found.some((t) => t.id === id));
      if (missing.length) throw Errors.validation({ teamIds: `not teams of this workspace: ${missing.join(', ')}` });
    }
    const isGuest = new Map(memberships.map((m) => [m.userId, m.role === WorkspaceRole.guest]));
    await this.prisma.tx(async (tx) => {
      const before = new Set((await tx.projectMember.findMany({ where: { projectId }, select: { userId: true } })).map((m) => m.userId));
      if (userIds.length) {
        // Adding someone directly makes their membership independent of any team.
        await tx.projectMember.updateMany({ where: { projectId, userId: { in: userIds } }, data: { addedViaTeamId: null } });
        await tx.projectMember.createMany({
          data: userIds.map((userId) => ({ projectId, userId, role: isGuest.get(userId) ? ProjectRole.guest : ProjectRole.team_member })),
          skipDuplicates: true,
        });
        const needSpace = userIds.filter((id) => project.space.visibility === SpaceVisibility.private || isGuest.get(id));
        if (needSpace.length) await tx.spaceMember.createMany({ data: needSpace.map((userId) => ({ spaceId: project.spaceId, userId })), skipDuplicates: true });
      }
      for (const teamId of teamIds) await this.teamAccess.grantTeamToProject(tx, projectId, teamId);
      await syncProjectChannels(tx, [projectId]);
      await this.activity.log(
        { workspaceId: project.workspaceId, actorId, entityType: 'project', entityId: projectId, action: 'members_added', newValue: { userIds, teamIds } },
        tx,
      );
      // Roles guide P2: "members are notified and the project appears in their sidebar".
      const added = (await tx.projectMember.findMany({ where: { projectId }, select: { userId: true } })).map((m) => m.userId).filter((id) => !before.has(id));
      await this.notifications.notify(tx, {
        workspaceId: project.workspaceId, eventType: NotificationEvent.added_to_project, userIds: added, actorId,
        body: `You were added to the project ${project.name} (${project.keyPrefix}).`, link: { type: 'project', id: projectId },
      });
    });
    return this.list(projectId, actorId);
  }

  /** PATCH /projects/:id/members/:userId — Admin changes a project role, e.g. hands over the PM role. */
  async changeRole(projectId: string, actorId: string, userId: string, dto: ChangeProjectRoleDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'admin');
    this.projectAccess.assertWritable(project);
    const row = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!row) throw Errors.notFound('Project member');
    if (row.role === dto.role) return this.list(projectId, actorId);
    const ws = await this.prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } } });
    if (ws.role === WorkspaceRole.guest) throw Errors.validation({ role: 'workspace Guests can only have the guest project role' });
    if (dto.role === ProjectRole.guest) throw Errors.validation({ role: 'only workspace Guests have the guest project role' });
    if (row.role === ProjectRole.project_manager) {
      throw Errors.conflict('PROJECT_MANAGER_REQUIRED', 'Every project needs a Project Manager. Make someone else the Project Manager instead; this person then becomes a Team Member.');
    }
    if (dto.role === ProjectRole.project_manager && ws.role !== WorkspaceRole.admin && !ws.canManageProjects) {
      throw Errors.validation({ role: 'this person is not allowed to manage projects; the Workspace Admin can switch on canManageProjects first' });
    }
    await this.prisma.tx(async (tx) => {
      let previousManager: string | null = null;
      if (dto.role === ProjectRole.project_manager) {
        const current = await tx.projectMember.findFirst({ where: { projectId, role: ProjectRole.project_manager } });
        if (current) {
          previousManager = current.userId;
          // Demote first: the database allows only one PM per project.
          await tx.projectMember.update({ where: { projectId_userId: { projectId, userId: current.userId } }, data: { role: ProjectRole.team_member } });
        }
      }
      await tx.projectMember.update({ where: { projectId_userId: { projectId, userId } }, data: { role: dto.role } });
      await this.activity.log(
        {
          workspaceId: project.workspaceId, actorId, entityType: 'project_member', entityId: userId, action: 'role_changed',
          oldValue: { projectId, role: row.role }, newValue: { projectId, role: dto.role, previousManager },
        },
        tx,
      );
      if (dto.role === ProjectRole.project_manager) {
        await this.notifications.notify(tx, {
          workspaceId: project.workspaceId, eventType: NotificationEvent.made_manager, userIds: [userId], actorId,
          body: `You are now the Project Manager of ${project.name} (${project.keyPrefix}).`, link: { type: 'project', id: projectId },
        });
      }
    });
    return this.list(projectId, actorId);
  }

  /** DELETE /projects/:id/members/:userId — their unfinished tasks in the project become unassigned. */
  async remove(projectId: string, actorId: string, userId: string) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const row = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: { select: { fullName: true } }, addedViaTeam: { select: { name: true } } },
    });
    if (!row) throw Errors.notFound('Project member');
    if (row.role === ProjectRole.project_manager) {
      throw Errors.conflict('PROJECT_MANAGER_REQUIRED', 'The Project Manager cannot be removed. The Workspace Admin can first make someone else the Project Manager.');
    }
    if (row.addedViaTeam) {
      throw Errors.conflict('MEMBER_VIA_TEAM', `${row.user.fullName} is in this project through the ${row.addedViaTeam.name}. Remove the team from the project, or remove them from the team.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
      const tasks = await tx.task.updateMany({
        where: { projectId, assigneeId: userId, completedAt: null },
        data: { assigneeId: null, acceptance: null, concernNote: null },
      });
      await syncProjectChannels(tx, [projectId]);
      await this.activity.log(
        { workspaceId: project.workspaceId, actorId, entityType: 'project_member', entityId: userId, action: 'removed', newValue: { projectId, unassignedTasks: tasks.count } },
        tx,
      );
    });
  }

  /** DELETE /projects/:id/teams/:teamId — people who were in the project only through the team leave it. */
  async removeTeam(projectId: string, actorId: string, teamId: string) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const link = await this.prisma.projectTeam.findUnique({ where: { projectId_teamId: { projectId, teamId } } });
    if (!link) throw Errors.notFound('Team in this project');
    await this.prisma.$transaction(async (tx) => {
      const change = await this.teamAccess.revokeTeamFromProject(tx, projectId, teamId);
      await this.activity.log(
        { workspaceId: project.workspaceId, actorId, entityType: 'project', entityId: projectId, action: 'team_removed', newValue: { teamId, ...change } },
        tx,
      );
    });
  }
}
