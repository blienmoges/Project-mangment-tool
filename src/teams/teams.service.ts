import { Injectable } from '@nestjs/common';
import { Prisma, SkillLevel, SpaceVisibility, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { unique } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { WorkloadService } from '../workload/workload.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AddTeamMembersDto, CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { TeamAccessService } from './team-access.service';

const memberUser = { id: true, fullName: true, email: true, jobTitle: true, avatarUrl: true, weeklyCapacityHours: true } as const;
const LEVEL_RANK: Record<SkillLevel, number> = { beginner: 1, intermediate: 2, expert: 3 };

/** Teams (SRS 3.10): reusable groups of people that can be added to spaces and projects in one step. */
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly teamAccess: TeamAccessService,
    private readonly workload: WorkloadService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /workspaces/:id/teams — teams with their members and workload (FR-10.5). */
  async list(workspaceId: string, userId: string) {
    await this.access.requireNonGuest(workspaceId, userId);
    const teams = await this.prisma.team.findMany({
      where: { workspaceId },
      include: { members: { include: { user: { select: memberUser } } }, _count: { select: { spaces: true, projects: true } } },
      orderBy: { name: 'asc' },
    });
    const work = await this.workload.openWork(workspaceId, unique(teams.flatMap((t) => t.members.map((m) => m.userId))));
    return {
      data: teams.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        spaceCount: t._count.spaces,
        projectCount: t._count.projects,
        ...this.withWorkload(t.members.map((m) => m.user), work),
        createdAt: t.createdAt,
      })),
    };
  }

  /** GET /teams/:teamId — one team with members, workload, skills coverage and where it has access. */
  async get(teamId: string, userId: string) {
    const team = await this.findOrFail(teamId);
    const me = await this.access.requireNonGuest(team.workspaceId, userId);
    const full = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      include: {
        members: { include: { user: { select: memberUser } } },
        spaces: { where: { space: this.visibleSpaces(me) }, include: { space: { select: { id: true, name: true, visibility: true, archivedAt: true } } } },
        projects: {
          where: { project: { space: this.visibleSpaces(me) } },
          include: { project: { select: { id: true, name: true, keyPrefix: true, status: true, spaceId: true } } },
        },
      },
    });
    const userIds = full.members.map((m) => m.userId);
    const work = await this.workload.openWork(team.workspaceId, userIds);
    return {
      id: full.id,
      workspaceId: full.workspaceId,
      name: full.name,
      description: full.description,
      ...this.withWorkload(full.members.map((m) => m.user), work),
      skills: await this.skillsCoverage(team.workspaceId, userIds),
      spaces: full.spaces.map((s) => s.space),
      projects: full.projects.map((p) => p.project),
      createdAt: full.createdAt,
      updatedAt: full.updatedAt,
    };
  }

  async create(workspaceId: string, actorId: string, dto: CreateTeamDto) {
    await this.access.requireAdmin(workspaceId, actorId);
    const name = dto.name.trim();
    await this.ensureNameFree(workspaceId, name);
    const memberIds = unique(dto.memberIds ?? []);
    await this.access.requireWorkspaceUsers(workspaceId, memberIds, 'memberIds');
    const team = await this.prisma.$transaction(async (tx) => {
      const created = await tx.team.create({ data: { workspaceId, name, description: dto.description?.trim() || null } });
      if (memberIds.length) await tx.teamMember.createMany({ data: memberIds.map((userId) => ({ teamId: created.id, userId })) });
      await this.activity.log(
        { workspaceId, actorId, entityType: 'team', entityId: created.id, action: 'created', newValue: { name, memberIds } },
        tx,
      );
      return created;
    });
    return this.get(team.id, actorId);
  }

  async update(teamId: string, actorId: string, dto: UpdateTeamDto) {
    const team = await this.findOrFail(teamId);
    await this.access.requireAdmin(team.workspaceId, actorId);
    const name = dto.name?.trim();
    if (name && name.toLowerCase() !== team.name.toLowerCase()) await this.ensureNameFree(team.workspaceId, name, teamId);
    const data: Prisma.TeamUpdateInput = {};
    if (name) data.name = name;
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    const updated = await this.prisma.team.update({ where: { id: teamId }, data });
    await this.activity.log({
      workspaceId: team.workspaceId, actorId, entityType: 'team', entityId: teamId, action: 'updated',
      oldValue: { name: team.name, description: team.description }, newValue: { name: updated.name, description: updated.description },
    });
    return updated;
  }

  /** Deletes a team. Unless keepAccess is true, access its members had only through the team is removed. */
  async remove(teamId: string, actorId: string, keepAccess = false) {
    const team = await this.findOrFail(teamId);
    await this.access.requireAdmin(team.workspaceId, actorId);
    await this.prisma.$transaction(async (tx) => {
      const change = keepAccess ? null : await this.teamAccess.revokeWholeTeam(tx, teamId);
      // With keepAccess, the database turns the remaining rows into direct memberships (added_via_team_id → NULL).
      await tx.team.delete({ where: { id: teamId } });
      await this.activity.log(
        { workspaceId: team.workspaceId, actorId, entityType: 'team', entityId: teamId, action: 'deleted', oldValue: { name: team.name }, newValue: { keepAccess, ...(change ?? {}) } },
        tx,
      );
    });
  }

  /** POST /teams/:teamId/members — new members also join the team's spaces and projects (FR-10.3). */
  async addMembers(teamId: string, actorId: string, dto: AddTeamMembersDto) {
    const team = await this.findOrFail(teamId);
    await this.access.requireAdmin(team.workspaceId, actorId);
    const ids = unique(dto.userIds);
    await this.access.requireWorkspaceUsers(team.workspaceId, ids);
    const existing = await this.prisma.teamMember.findMany({ where: { teamId, userId: { in: ids } }, select: { userId: true } });
    const already = new Set(existing.map((e) => e.userId));
    const toAdd = ids.filter((id) => !already.has(id));
    const results = await this.prisma.$transaction(async (tx) => {
      const out = [];
      for (const userId of toAdd) {
        await tx.teamMember.create({ data: { teamId, userId } });
        const change = await this.teamAccess.grantMember(tx, teamId, userId);
        await this.activity.log(
          { workspaceId: team.workspaceId, actorId, entityType: 'team_member', entityId: userId, action: 'added', newValue: { teamId, teamName: team.name, ...change } },
          tx,
        );
        out.push({ userId, spacesJoined: change.spacesJoined, projectsJoined: change.projectsJoined });
      }
      return out;
    });
    return { added: results, alreadyInTeam: [...already] };
  }

  /** DELETE /teams/:teamId/members/:userId — also removes access the person had only through this team. */
  async removeMember(teamId: string, actorId: string, userId: string) {
    const team = await this.findOrFail(teamId);
    await this.access.requireAdmin(team.workspaceId, actorId);
    const row = await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (!row) throw Errors.notFound('Team member');
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
      const change = await this.teamAccess.revokeMember(tx, teamId, userId);
      await this.activity.log(
        { workspaceId: team.workspaceId, actorId, entityType: 'team_member', entityId: userId, action: 'removed', newValue: { teamId, teamName: team.name, ...change } },
        tx,
      );
    });
  }

  // ───────────── helpers ─────────────

  private async findOrFail(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw Errors.notFound('Team');
    return team;
  }

  private async ensureNameFree(workspaceId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.team.findFirst({
      where: { workspaceId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw Errors.conflict('ALREADY_EXISTS', 'A team with this name already exists.');
  }

  /** Same visibility rule as spaces: the Admin sees all, others see Open spaces and those they belong to. */
  private visibleSpaces(me: WorkspaceMember): Prisma.SpaceWhereInput {
    if (me.role === WorkspaceRole.admin) return {};
    return { OR: [{ visibility: SpaceVisibility.open }, { members: { some: { userId: me.userId } } }] };
  }

  private withWorkload(users: Prisma.UserGetPayload<{ select: typeof memberUser }>[], work: Map<string, { openTasks: number; openHours: number }>) {
    const members = users
      .map((u) => {
        const w = work.get(u.id) ?? { openTasks: 0, openHours: 0 };
        const { weeklyCapacityHours, ...profile } = u;
        return { ...profile, openTasks: w.openTasks, openHours: w.openHours, capacityHours: weeklyCapacityHours, loadPercent: WorkloadService.loadPercent(w.openHours, weeklyCapacityHours) };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const openHours = members.reduce((s, m) => s + m.openHours, 0);
    const capacityHours = members.reduce((s, m) => s + m.capacityHours, 0);
    return {
      memberCount: members.length,
      members,
      workload: { openTasks: members.reduce((s, m) => s + m.openTasks, 0), openHours, capacityHours, loadPercent: WorkloadService.loadPercent(openHours, capacityHours) },
    };
  }

  /** Skills coverage (FR-10.5): each skill in the team, how many people have it and the best level. */
  private async skillsCoverage(workspaceId: string, userIds: string[]) {
    if (!userIds.length) return [];
    const rows = await this.prisma.userSkill.findMany({
      where: { userId: { in: userIds }, skill: { workspaceId } },
      include: { skill: { select: { id: true, name: true, category: true } } },
    });
    const bySkill = new Map<string, { skillId: string; name: string; category: string | null; people: number; verifiedPeople: number; bestLevel: SkillLevel }>();
    for (const r of rows) {
      const entry = bySkill.get(r.skillId) ?? { skillId: r.skillId, name: r.skill.name, category: r.skill.category, people: 0, verifiedPeople: 0, bestLevel: r.level };
      entry.people += 1;
      if (r.verifiedAt) entry.verifiedPeople += 1;
      if (LEVEL_RANK[r.level] > LEVEL_RANK[entry.bestLevel]) entry.bestLevel = r.level;
      bySkill.set(r.skillId, entry);
    }
    return [...bySkill.values()].sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
  }
}
