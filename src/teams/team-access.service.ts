import { Injectable } from '@nestjs/common';
import { ChannelType, Prisma, ProjectMember, ProjectRole, SpaceMember, SpaceVisibility } from '@prisma/client';
import { syncProjectChannels } from '../projects/project-channel';

type Tx = Prisma.TransactionClient;

export interface AccessChange {
  spacesJoined: number;
  projectsJoined: number;
  spacesLeft: number;
  projectsLeft: number;
  unassignedTasks: number;
}

const emptyChange = (): AccessChange => ({ spacesJoined: 0, projectsJoined: 0, spacesLeft: 0, projectsLeft: 0, unassignedTasks: 0 });

/**
 * Keeps team-based access in sync (SRS FR-9.4, FR-10.3).
 *
 * When a team is added to a space or project, its members get `space_members` / `project_members` rows
 * with `added_via_team_id` set. People who were already members keep their own row (direct access wins).
 * When access through a team ends, a row is moved to another team that still gives the same access,
 * or removed if none does. Rules when removing:
 *  - The Project Manager's project row is never removed (only the team link is cleared).
 *  - A person who loses a project has their unfinished tasks in it unassigned.
 *  - A space row is kept while the person is still a member of one of the space's projects,
 *    because project members must be able to see the project's space.
 * Every method takes the transaction client, so callers can combine it with other changes.
 */
@Injectable()
export class TeamAccessService {
  /** A new team member gets the team's spaces, projects and team channel. */
  async grantMember(tx: Tx, teamId: string, userId: string): Promise<AccessChange> {
    const change = emptyChange();
    const [spaces, projects] = await Promise.all([
      tx.spaceTeam.findMany({ where: { teamId }, select: { spaceId: true } }),
      tx.projectTeam.findMany({ where: { teamId }, select: { projectId: true, project: { select: { spaceId: true, space: { select: { visibility: true } } } } } }),
    ]);
    // Projects in Private spaces also need space membership.
    const spaceIds = new Set(spaces.map((s) => s.spaceId));
    for (const p of projects) if (p.project.space.visibility === SpaceVisibility.private) spaceIds.add(p.project.spaceId);
    if (spaceIds.size) {
      const r = await tx.spaceMember.createMany({ data: [...spaceIds].map((spaceId) => ({ spaceId, userId, addedViaTeamId: teamId })), skipDuplicates: true });
      change.spacesJoined = r.count;
    }
    if (projects.length) {
      const r = await tx.projectMember.createMany({
        data: projects.map((p) => ({ projectId: p.projectId, userId, role: ProjectRole.team_member, addedViaTeamId: teamId })),
        skipDuplicates: true,
      });
      change.projectsJoined = r.count;
      await syncProjectChannels(tx, projects.map((p) => p.projectId));
    }
    await this.syncTeamChannel(tx, teamId, [userId], 'add');
    return change;
  }

  /** Call after deleting the team_members row: removes access the person had only through this team. */
  async revokeMember(tx: Tx, teamId: string, userId: string): Promise<AccessChange> {
    const change = emptyChange();
    const projectRows = await tx.projectMember.findMany({ where: { userId, addedViaTeamId: teamId } });
    await this.releaseProjectRows(tx, projectRows, teamId, change);
    await syncProjectChannels(tx, projectRows.map((r) => r.projectId));
    const spaceRows = await tx.spaceMember.findMany({ where: { userId, addedViaTeamId: teamId } });
    await this.releaseSpaceRows(tx, spaceRows, teamId, change);
    await this.syncTeamChannel(tx, teamId, [userId], 'remove');
    return change;
  }

  /** Adds a whole team to a space: every current member joins it, and future members will too. */
  async grantTeamToSpace(tx: Tx, spaceId: string, teamId: string): Promise<AccessChange> {
    const change = emptyChange();
    await tx.spaceTeam.createMany({ data: [{ spaceId, teamId }], skipDuplicates: true });
    const members = await tx.teamMember.findMany({ where: { teamId }, select: { userId: true } });
    if (members.length) {
      const r = await tx.spaceMember.createMany({ data: members.map((m) => ({ spaceId, userId: m.userId, addedViaTeamId: teamId })), skipDuplicates: true });
      change.spacesJoined = r.count;
    }
    return change;
  }

  async revokeTeamFromSpace(tx: Tx, spaceId: string, teamId: string): Promise<AccessChange> {
    const change = emptyChange();
    await tx.spaceTeam.deleteMany({ where: { spaceId, teamId } });
    const rows = await tx.spaceMember.findMany({ where: { spaceId, addedViaTeamId: teamId } });
    await this.releaseSpaceRows(tx, rows, teamId, change);
    return change;
  }

  /** Adds a whole team to a project (used by the projects module, step 2). */
  async grantTeamToProject(tx: Tx, projectId: string, teamId: string): Promise<AccessChange> {
    const change = emptyChange();
    await tx.projectTeam.createMany({ data: [{ projectId, teamId }], skipDuplicates: true });
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { spaceId: true, space: { select: { visibility: true } } } });
    const members = await tx.teamMember.findMany({ where: { teamId }, select: { userId: true } });
    if (!members.length) return change;
    const r = await tx.projectMember.createMany({
      data: members.map((m) => ({ projectId, userId: m.userId, role: ProjectRole.team_member, addedViaTeamId: teamId })),
      skipDuplicates: true,
    });
    change.projectsJoined = r.count;
    await syncProjectChannels(tx, [projectId]);
    if (project.space.visibility === SpaceVisibility.private) {
      const s = await tx.spaceMember.createMany({ data: members.map((m) => ({ spaceId: project.spaceId, userId: m.userId, addedViaTeamId: teamId })), skipDuplicates: true });
      change.spacesJoined = s.count;
    }
    return change;
  }

  /** Removes a team from a project (used by the projects module, step 2). */
  async revokeTeamFromProject(tx: Tx, projectId: string, teamId: string): Promise<AccessChange> {
    const change = emptyChange();
    await tx.projectTeam.deleteMany({ where: { projectId, teamId } });
    const rows = await tx.projectMember.findMany({ where: { projectId, addedViaTeamId: teamId } });
    await this.releaseProjectRows(tx, rows, teamId, change);
    await syncProjectChannels(tx, [projectId]);
    // Space rows this team gave only for the project (Private space), unless the team is also added to the space itself.
    const { spaceId } = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { spaceId: true } });
    const linkedToSpace = await tx.spaceTeam.findUnique({ where: { spaceId_teamId: { spaceId, teamId } } });
    if (!linkedToSpace) {
      const spaceRows = await tx.spaceMember.findMany({ where: { spaceId, addedViaTeamId: teamId, userId: { in: rows.map((r) => r.userId) } } });
      await this.releaseSpaceRows(tx, spaceRows, teamId, change);
    }
    return change;
  }

  /** Before a team is deleted: removes access its members had only through it. */
  async revokeWholeTeam(tx: Tx, teamId: string): Promise<AccessChange> {
    const change = emptyChange();
    const projectRows = await tx.projectMember.findMany({ where: { addedViaTeamId: teamId } });
    await this.releaseProjectRows(tx, projectRows, teamId, change);
    await syncProjectChannels(tx, projectRows.map((r) => r.projectId));
    await this.releaseSpaceRows(tx, await tx.spaceMember.findMany({ where: { addedViaTeamId: teamId } }), teamId, change);
    return change;
  }

  // ───────────── internals ─────────────

  private async releaseProjectRows(tx: Tx, rows: ProjectMember[], teamId: string, change: AccessChange) {
    for (const row of rows) {
      const other = await tx.projectTeam.findFirst({
        where: { projectId: row.projectId, teamId: { not: teamId }, team: { members: { some: { userId: row.userId } } } },
        select: { teamId: true },
      });
      const where = { projectId_userId: { projectId: row.projectId, userId: row.userId } };
      if (other) {
        await tx.projectMember.update({ where, data: { addedViaTeamId: other.teamId } });
      } else if (row.role === ProjectRole.project_manager) {
        await tx.projectMember.update({ where, data: { addedViaTeamId: null } });
      } else {
        await tx.projectMember.delete({ where });
        const tasks = await tx.task.updateMany({
          where: { projectId: row.projectId, assigneeId: row.userId, completedAt: null },
          data: { assigneeId: null, acceptance: null, concernNote: null },
        });
        change.projectsLeft += 1;
        change.unassignedTasks += tasks.count;
      }
    }
  }

  private async releaseSpaceRows(tx: Tx, rows: SpaceMember[], teamId: string, change: AccessChange) {
    for (const row of rows) {
      const where = { spaceId_userId: { spaceId: row.spaceId, userId: row.userId } };
      const other = await tx.spaceTeam.findFirst({
        where: { spaceId: row.spaceId, teamId: { not: teamId }, team: { members: { some: { userId: row.userId } } } },
        select: { teamId: true },
      });
      if (other) {
        await tx.spaceMember.update({ where, data: { addedViaTeamId: other.teamId } });
        continue;
      }
      const stillInProject = await tx.projectMember.findFirst({ where: { userId: row.userId, project: { spaceId: row.spaceId } }, select: { addedViaTeamId: true } });
      if (stillInProject) {
        // Keep the space row for the project; credit the team that gives the project access, if any.
        const via = stillInProject.addedViaTeamId && stillInProject.addedViaTeamId !== teamId ? stillInProject.addedViaTeamId : null;
        await tx.spaceMember.update({ where, data: { addedViaTeamId: via } });
      } else {
        await tx.spaceMember.delete({ where });
        change.spacesLeft += 1;
      }
    }
  }

  /** Team chat (FR-10.4): keeps the team channel's members in step with the team, once the channel exists. */
  private async syncTeamChannel(tx: Tx, teamId: string, userIds: string[], op: 'add' | 'remove') {
    const channel = await tx.channel.findFirst({ where: { teamId, type: ChannelType.team }, select: { id: true } });
    if (!channel) return;
    if (op === 'add') {
      await tx.channelMember.createMany({ data: userIds.map((userId) => ({ channelId: channel.id, userId })), skipDuplicates: true });
    } else {
      await tx.channelMember.deleteMany({ where: { channelId: channel.id, userId: { in: userIds } } });
    }
  }
}
