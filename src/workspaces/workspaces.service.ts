import { Injectable } from '@nestjs/common';
import { ProjectRole, WorkspaceRole } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { randomToken, slugify } from '../common/utils';
import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { syncProjectChannels } from '../projects/project-channel';
import { ChangeRoleDto, CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';
import { defaultPreferenceRows } from './notification-defaults';
import { WorkspaceAccessService } from './workspace-access.service';

const memberUserFields = { id: true, fullName: true, email: true, jobTitle: true, avatarUrl: true } as const;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** FR-8.1: create a workspace; the creator becomes its Workspace Admin. */
  async create(userId: string, dto: CreateWorkspaceDto) {
    let slug = dto.slug ?? slugify(dto.name);
    if (await this.prisma.workspace.findUnique({ where: { slug } })) {
      if (dto.slug) throw Errors.conflict('ALREADY_EXISTS', 'This web address (slug) is already taken.');
      slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    }
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name: dto.name.trim(), slug, createdById: userId } });
      await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role: WorkspaceRole.admin, canManageProjects: true } });
      await tx.notificationPreference.createMany({ data: defaultPreferenceRows(workspace.id, userId) });
      await this.activity.log({ workspaceId: workspace.id, actorId: userId, entityType: 'workspace', entityId: workspace.id, action: 'created' }, tx);
      return { ...workspace, myRole: WorkspaceRole.admin };
    });
  }

  async get(workspaceId: string, userId: string) {
    const membership = await this.access.requireMember(workspaceId, userId);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return { ...workspace, myRole: membership.role };
  }

  async update(workspaceId: string, userId: string, dto: UpdateWorkspaceDto) {
    await this.access.requireAdmin(workspaceId, userId);
    const before = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const updated = await this.prisma.workspace.update({ where: { id: workspaceId }, data: dto });
    await this.activity.log({
      workspaceId, actorId: userId, entityType: 'workspace', entityId: workspaceId, action: 'updated',
      oldValue: { name: before.name, reminderDays: before.reminderDays }, newValue: { ...dto },
    });
    return updated;
  }

  async members(workspaceId: string, userId: string) {
    await this.access.requireMember(workspaceId, userId);
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: memberUserFields } },
      orderBy: { joinedAt: 'asc' },
    });
    return { data: rows.map((m) => ({ ...m.user, role: m.role, canManageProjects: m.canManageProjects, joinedAt: m.joinedAt })) };
  }

  /** Stops the last Workspace Admin from being demoted or removed. */
  private async ensureNotLastAdmin(workspaceId: string, targetUserId: string) {
    const target = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } } });
    if (!target) throw Errors.notFound('Member');
    if (target.role === WorkspaceRole.admin) {
      const admins = await this.prisma.workspaceMember.count({ where: { workspaceId, role: WorkspaceRole.admin } });
      if (admins <= 1) throw Errors.conflict('LAST_ADMIN', 'A workspace needs at least one Workspace Admin. Make someone else Admin first.');
    }
    return target;
  }

  /** Every project needs a Project Manager, so the PM role must be handed over first. */
  private async ensureNotProjectManager(workspaceId: string, userId: string, what: string) {
    const managed = await this.prisma.project.findMany({
      where: { workspaceId, members: { some: { userId, role: ProjectRole.project_manager } } },
      select: { keyPrefix: true },
    });
    if (managed.length) {
      throw Errors.conflict(
        'PROJECT_MANAGER_REQUIRED',
        `This person is the Project Manager of ${managed.map((p) => p.keyPrefix).join(', ')}, so they cannot be ${what}. Make someone else the Project Manager first.`,
      );
    }
  }

  /** Changes a person's workspace role and/or whether they may create projects. */
  async changeRole(workspaceId: string, actorId: string, targetUserId: string, dto: ChangeRoleDto) {
    await this.access.requireAdmin(workspaceId, actorId);
    if (dto.role === undefined && dto.canManageProjects === undefined) {
      throw Errors.validation({ role: 'send role, canManageProjects, or both' });
    }
    const demoting = dto.role !== undefined && dto.role !== WorkspaceRole.admin;
    const target = demoting
      ? await this.ensureNotLastAdmin(workspaceId, targetUserId)
      : await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } } });
    if (!target) throw Errors.notFound('Member');
    const role = dto.role ?? target.role;
    // Guests can never create projects.
    const canManageProjects = role === WorkspaceRole.guest ? false : (dto.canManageProjects ?? target.canManageProjects);
    const toGuest = role === WorkspaceRole.guest && target.role !== WorkspaceRole.guest;
    const fromGuest = target.role === WorkspaceRole.guest && role !== WorkspaceRole.guest;
    if (toGuest) {
      await this.ensureNotProjectManager(workspaceId, targetUserId, 'made a Guest');
      const teams = await this.prisma.teamMember.findMany({ where: { userId: targetUserId, team: { workspaceId } }, select: { team: { select: { name: true } } } });
      if (teams.length) {
        throw Errors.conflict('STILL_TEAM_MEMBER', `Guests cannot be in teams. Remove this person from these teams first: ${teams.map((t) => t.team.name).join(', ')}.`);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: { role, canManageProjects },
      });
      let unassignedTasks = 0;
      if (toGuest || fromGuest) {
        // Project roles follow the workspace role: Guests are read-only in every project they belong to.
        const rows = await tx.projectMember.findMany({ where: { userId: targetUserId, project: { workspaceId } }, select: { projectId: true, project: { select: { spaceId: true } } } });
        await tx.projectMember.updateMany({
          where: { userId: targetUserId, project: { workspaceId } },
          data: { role: toGuest ? ProjectRole.guest : ProjectRole.team_member },
        });
        if (toGuest) {
          unassignedTasks = (await tx.task.updateMany({ where: { workspaceId, assigneeId: targetUserId, completedAt: null }, data: { assigneeId: null, acceptance: null, concernNote: null } })).count;
          // Guests see only spaces they belong to, so keep the spaces of their projects.
          if (rows.length) await tx.spaceMember.createMany({ data: rows.map((r) => ({ spaceId: r.project.spaceId, userId: targetUserId })), skipDuplicates: true });
        }
        await syncProjectChannels(tx, rows.map((r) => r.projectId));
      }
      await this.activity.log(
        {
          workspaceId, actorId, entityType: 'workspace_member', entityId: targetUserId, action: 'permissions_changed',
          oldValue: { role: target.role, canManageProjects: target.canManageProjects }, newValue: { role, canManageProjects, unassignedTasks },
        },
        tx,
      );
      return updated;
    });
  }

  /** Removes a person; their unfinished tasks become unassigned (SRS FR-8.2). */
  async removeMember(workspaceId: string, actorId: string, targetUserId: string) {
    await this.access.requireAdmin(workspaceId, actorId);
    await this.ensureNotLastAdmin(workspaceId, targetUserId);
    await this.ensureNotProjectManager(workspaceId, targetUserId, 'removed');
    await this.prisma.$transaction(async (tx) => {
      const unassigned = await tx.task.updateMany({
        where: { workspaceId, assigneeId: targetUserId, completedAt: null },
        data: { assigneeId: null, acceptance: null },
      });
      await tx.projectMember.deleteMany({ where: { userId: targetUserId, project: { workspaceId } } });
      await tx.spaceMember.deleteMany({ where: { userId: targetUserId, space: { workspaceId } } });
      await tx.teamMember.deleteMany({ where: { userId: targetUserId, team: { workspaceId } } });
      await tx.channelMember.deleteMany({ where: { userId: targetUserId, channel: { workspaceId } } });
      await tx.notificationPreference.deleteMany({ where: { userId: targetUserId, workspaceId } });
      await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } } });
      await this.activity.log(
        { workspaceId, actorId, entityType: 'workspace_member', entityId: targetUserId, action: 'removed', newValue: { unassignedTasks: unassigned.count } },
        tx,
      );
    });
  }
}

