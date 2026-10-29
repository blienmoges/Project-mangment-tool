import { Injectable } from '@nestjs/common';
import { Prisma, SpaceVisibility, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { isoDate, unique } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { emptyStats, taskStatsBy, todayFor } from '../projects/project-stats';
import { TeamAccessService } from '../teams/team-access.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AddSpaceMembersDto, CreateSpaceDto, UpdateSpaceDto } from './dto/space.dto';
import { SpaceAccessService } from './space-access.service';
import { DEFAULT_WORKFLOW } from './workflow';

const userFields = { id: true, fullName: true, email: true, jobTitle: true, avatarUrl: true } as const;

/** Spaces (SRS 3.9): groups of related projects that control who can see them. */
@Injectable()
export class SpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly spaceAccess: SpaceAccessService,
    private readonly teamAccess: TeamAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /workspaces/:id/spaces — the spaces the caller can see. */
  async list(workspaceId: string, userId: string, includeArchived = false) {
    const membership = await this.access.requireMember(workspaceId, userId);
    const spaces = await this.prisma.space.findMany({
      where: { ...this.spaceAccess.visibleSpacesWhere(membership), ...(includeArchived ? {} : { archivedAt: null }) },
      include: {
        _count: { select: { members: true, teams: true, projects: { where: { archivedAt: null } } } },
        members: { where: { userId }, select: { userId: true } },
      },
      orderBy: { name: 'asc' },
    });
    return {
      data: spaces.map(({ _count, members, ...s }) => ({
        ...s,
        projectCount: _count.projects,
        memberCount: _count.members,
        teamCount: _count.teams,
        isMember: members.length > 0,
      })),
    };
  }

  /** POST /workspaces/:id/spaces — the space starts with the default workflow (To do, In progress, In review, Done). */
  async create(workspaceId: string, actorId: string, dto: CreateSpaceDto) {
    await this.access.requireAdmin(workspaceId, actorId);
    const name = dto.name.trim();
    await this.ensureNameFree(workspaceId, name);
    const space = await this.prisma.$transaction(async (tx) => {
      const created = await tx.space.create({
        data: { workspaceId, name, description: dto.description?.trim() || null, visibility: dto.visibility ?? SpaceVisibility.open },
      });
      await tx.workflowStatus.createMany({ data: DEFAULT_WORKFLOW.map((s, position) => ({ ...s, spaceId: created.id, position })) });
      await this.activity.log(
        { workspaceId, actorId, entityType: 'space', entityId: created.id, action: 'created', newValue: { name, visibility: created.visibility } },
        tx,
      );
      return created;
    });
    return this.get(space.id, actorId);
  }

  /** GET /spaces/:id — space details, workflow, teams and its projects with progress (FR-9.5). */
  async get(spaceId: string, userId: string, includeArchived = false) {
    const { space, membership, isAdmin, isSpaceMember } = await this.spaceAccess.requireSpace(spaceId, userId);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: space.workspaceId }, select: { timezone: true } });
    const [statuses, teams, memberCount, customFieldCount, projects] = await Promise.all([
      this.prisma.workflowStatus.findMany({ where: { spaceId }, orderBy: { position: 'asc' } }),
      this.prisma.spaceTeam.findMany({ where: { spaceId }, include: { team: { select: { id: true, name: true } } } }),
      this.prisma.spaceMember.count({ where: { spaceId } }),
      this.prisma.customField.count({ where: { spaceId } }),
      this.prisma.project.findMany({
        // Only projects the caller can open: all for the Admin, otherwise those they belong to.
        where: {
          spaceId,
          ...(membership.role === WorkspaceRole.admin ? {} : { members: { some: { userId } } }),
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        select: { id: true, name: true, keyPrefix: true, status: true, priority: true, startDate: true, endDate: true, archivedAt: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const progress = await taskStatsBy(this.prisma, 'projectId', projects.map((p) => p.id), todayFor(workspace.timezone));
    return {
      ...space,
      memberCount,
      customFieldCount,
      isMember: isSpaceMember,
      canManage: isAdmin,
      statuses,
      teams: teams.map((t) => t.team),
      projects: projects.map((p) => ({ ...p, startDate: isoDate(p.startDate), endDate: isoDate(p.endDate), ...(progress.get(p.id) ?? emptyStats()) })),
    };
  }

  /** PATCH /spaces/:id — rename, change visibility, archive or restore. */
  async update(spaceId: string, actorId: string, dto: UpdateSpaceDto) {
    const { space } = await this.spaceAccess.requireSpaceAdmin(spaceId, actorId);
    const name = dto.name?.trim();
    if (name && name.toLowerCase() !== space.name.toLowerCase()) await this.ensureNameFree(space.workspaceId, name, spaceId);
    const data: Prisma.SpaceUpdateInput = {};
    if (name) data.name = name;
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.visibility) data.visibility = dto.visibility;
    if (dto.archived !== undefined) data.archivedAt = dto.archived ? (space.archivedAt ?? new Date()) : null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.space.update({ where: { id: spaceId }, data });
      if (dto.visibility === SpaceVisibility.private && space.visibility !== SpaceVisibility.private) {
        // Members of the space's projects must keep seeing them.
        const rows = await tx.projectMember.findMany({ where: { project: { spaceId } }, select: { userId: true, addedViaTeamId: true } });
        if (rows.length) await tx.spaceMember.createMany({ data: rows.map((r) => ({ spaceId, userId: r.userId, addedViaTeamId: r.addedViaTeamId })), skipDuplicates: true });
      }
      return result;
    });
    await this.activity.log({
      workspaceId: space.workspaceId, actorId, entityType: 'space', entityId: spaceId,
      action: dto.archived === true && !space.archivedAt ? 'archived' : dto.archived === false && space.archivedAt ? 'restored' : 'updated',
      oldValue: { name: space.name, visibility: space.visibility, archived: !!space.archivedAt },
      newValue: { name: updated.name, visibility: updated.visibility, archived: !!updated.archivedAt },
    });
    return updated;
  }

  /** GET /spaces/:id/members — people in the space and how they joined (directly or through a team). */
  async members(spaceId: string, userId: string) {
    await this.spaceAccess.requireSpace(spaceId, userId);
    const [rows, teams] = await Promise.all([
      this.prisma.spaceMember.findMany({
        where: { spaceId },
        include: { user: { select: userFields }, addedViaTeam: { select: { id: true, name: true } } },
      }),
      this.prisma.spaceTeam.findMany({ where: { spaceId }, include: { team: { select: { id: true, name: true, _count: { select: { members: true } } } } } }),
    ]);
    return {
      data: rows
        .map((r) => ({ ...r.user, addedViaTeam: r.addedViaTeam, addedAt: r.createdAt }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      teams: teams.map((t) => ({ id: t.team.id, name: t.team.name, memberCount: t.team._count.members, addedAt: t.createdAt })),
    };
  }

  /** POST /spaces/:id/members — add people (userIds) and/or whole teams (teamIds). */
  async addMembers(spaceId: string, actorId: string, dto: AddSpaceMembersDto) {
    const { space } = await this.spaceAccess.requireSpaceAdmin(spaceId, actorId);
    const userIds = unique(dto.userIds ?? []);
    const teamIds = unique(dto.teamIds ?? []);
    if (!userIds.length && !teamIds.length) throw Errors.validation({ userIds: 'send userIds, teamIds, or both' });
    await this.access.requireWorkspaceUsers(space.workspaceId, userIds, 'userIds', { allowGuests: true });
    if (teamIds.length) {
      const found = await this.prisma.team.findMany({ where: { id: { in: teamIds }, workspaceId: space.workspaceId }, select: { id: true } });
      const missing = teamIds.filter((id) => !found.some((t) => t.id === id));
      if (missing.length) throw Errors.validation({ teamIds: `not teams of this workspace: ${missing.join(', ')}` });
    }
    await this.prisma.$transaction(async (tx) => {
      if (userIds.length) {
        // Adding someone directly makes their access independent of any team.
        await tx.spaceMember.updateMany({ where: { spaceId, userId: { in: userIds } }, data: { addedViaTeamId: null } });
        await tx.spaceMember.createMany({ data: userIds.map((userId) => ({ spaceId, userId })), skipDuplicates: true });
      }
      for (const teamId of teamIds) await this.teamAccess.grantTeamToSpace(tx, spaceId, teamId);
      await this.activity.log(
        { workspaceId: space.workspaceId, actorId, entityType: 'space', entityId: spaceId, action: 'members_added', newValue: { userIds, teamIds } },
        tx,
      );
    });
    return this.members(spaceId, actorId);
  }

  /** DELETE /spaces/:id/members/:userId — remove a person who was added directly. */
  async removeMember(spaceId: string, actorId: string, userId: string) {
    const { space } = await this.spaceAccess.requireSpaceAdmin(spaceId, actorId);
    const row = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      include: { addedViaTeam: { select: { name: true } }, user: { select: { fullName: true } } },
    });
    if (!row) throw Errors.notFound('Space member');
    if (row.addedViaTeam) {
      throw Errors.conflict(
        'MEMBER_VIA_TEAM',
        `${row.user.fullName} is in this space through the ${row.addedViaTeam.name}. Remove the team from the space, or remove them from the team.`,
      );
    }
    const projects = await this.prisma.project.findMany({ where: { spaceId, members: { some: { userId } } }, select: { keyPrefix: true } });
    if (projects.length) {
      throw Errors.conflict(
        'STILL_PROJECT_MEMBER',
        `${row.user.fullName} is still a member of these projects in the space: ${projects.map((p) => p.keyPrefix).join(', ')}. Remove them from those projects first.`,
      );
    }
    await this.prisma.spaceMember.delete({ where: { spaceId_userId: { spaceId, userId } } });
    await this.activity.log({ workspaceId: space.workspaceId, actorId, entityType: 'space_member', entityId: userId, action: 'removed', oldValue: { spaceId } });
  }

  /** DELETE /spaces/:id/teams/:teamId — remove a team; people who were in the space only through it leave. */
  async removeTeam(spaceId: string, actorId: string, teamId: string) {
    const { space } = await this.spaceAccess.requireSpaceAdmin(spaceId, actorId);
    const link = await this.prisma.spaceTeam.findUnique({ where: { spaceId_teamId: { spaceId, teamId } } });
    if (!link) throw Errors.notFound('Team in this space');
    await this.prisma.$transaction(async (tx) => {
      const change = await this.teamAccess.revokeTeamFromSpace(tx, spaceId, teamId);
      await this.activity.log(
        { workspaceId: space.workspaceId, actorId, entityType: 'space', entityId: spaceId, action: 'team_removed', newValue: { teamId, membersRemoved: change.spacesLeft } },
        tx,
      );
    });
  }

  // ───────────── helpers ─────────────

  private async ensureNameFree(workspaceId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.space.findFirst({
      where: { workspaceId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw Errors.conflict('ALREADY_EXISTS', 'A space with this name already exists.');
  }
}
