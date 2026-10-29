import { Injectable } from '@nestjs/common';
import { ProjectRole, WorkspaceRole } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { ActivityService } from '../activity/activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';

/** The workspace's skills catalog (managed by the Workspace Admin). */
@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly activity: ActivityService,
  ) {}

  async list(workspaceId: string, userId: string) {
    await this.access.requireMember(workspaceId, userId);
    const data = await this.prisma.skill.findMany({ where: { workspaceId }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    return { data };
  }

  async create(workspaceId: string, userId: string, dto: CreateSkillDto) {
    await this.access.requireAdmin(workspaceId, userId);
    const skill = await this.prisma.skill.create({ data: { workspaceId, name: dto.name.trim(), category: dto.category?.trim() } });
    await this.activity.log({ workspaceId, actorId: userId, entityType: 'skill', entityId: skill.id, action: 'created', newValue: { name: skill.name } });
    return skill;
  }

  private async findOrFail(skillId: string) {
    const skill = await this.prisma.skill.findUnique({ where: { id: skillId } });
    if (!skill) throw Errors.notFound('Skill');
    return skill;
  }

  async update(skillId: string, userId: string, dto: UpdateSkillDto) {
    const skill = await this.findOrFail(skillId);
    await this.access.requireAdmin(skill.workspaceId, userId);
    return this.prisma.skill.update({ where: { id: skillId }, data: { name: dto.name?.trim(), category: dto.category?.trim() } });
  }

  /**
   * POST/DELETE /users/:userId/skills/:skillId/verify (FR-10.2): the Workspace Admin, or the PM of a project the person
   * works in, confirms (or withdraws) the level the person gave themselves. Nobody verifies their own skills.
   * Verified skills rank higher when suggestions tie; changing the level clears the verification.
   */
  async verify(targetUserId: string, skillId: string, actorId: string, verified: boolean) {
    const skill = await this.findOrFail(skillId);
    const actor = await this.access.requireNonGuest(skill.workspaceId, actorId);
    if (targetUserId === actorId) throw Errors.forbidden('You cannot verify your own skills.');
    if (actor.role !== WorkspaceRole.admin) {
      const sharedProject = await this.prisma.project.findFirst({
        where: { workspaceId: skill.workspaceId, AND: [{ members: { some: { userId: actorId, role: ProjectRole.project_manager } } }, { members: { some: { userId: targetUserId } } }] },
        select: { id: true },
      });
      if (!sharedProject) throw Errors.forbidden('Only the Workspace Admin or the Project Manager of a project this person works in can verify their skills.');
    }
    const row = await this.prisma.userSkill.findUnique({ where: { userId_skillId: { userId: targetUserId, skillId } } });
    if (!row) throw Errors.notFound("This skill on the person's profile");
    const updated = await this.prisma.userSkill.update({
      where: { userId_skillId: { userId: targetUserId, skillId } },
      data: verified ? { verifiedById: actorId, verifiedAt: new Date() } : { verifiedById: null, verifiedAt: null },
      include: { verifiedBy: { select: { id: true, fullName: true } } },
    });
    await this.activity.log({
      workspaceId: skill.workspaceId, actorId, entityType: 'user_skill', entityId: targetUserId, action: verified ? 'skill_verified' : 'skill_unverified',
      newValue: { skillId, skill: skill.name, level: row.level },
    });
    return { userId: targetUserId, skillId, name: skill.name, level: updated.level, verified: !!updated.verifiedAt, verifiedBy: updated.verifiedBy, verifiedAt: updated.verifiedAt };
  }

  /** GET /workspaces/:id/members/:userId/skills — a colleague's skills in this workspace, for verifying them. */
  async memberSkills(workspaceId: string, targetUserId: string, actorId: string) {
    await this.access.requireNonGuest(workspaceId, actorId);
    await this.access.requireWorkspaceUsers(workspaceId, [targetUserId], 'userId', { allowGuests: true });
    const rows = await this.prisma.userSkill.findMany({
      where: { userId: targetUserId, skill: { workspaceId } },
      include: { skill: true, verifiedBy: { select: { id: true, fullName: true } } },
      orderBy: { skill: { name: 'asc' } },
    });
    return { data: rows.map((r) => ({ skillId: r.skillId, name: r.skill.name, category: r.skill.category, level: r.level, verified: !!r.verifiedAt, verifiedBy: r.verifiedBy, verifiedAt: r.verifiedAt })) };
  }

  async remove(skillId: string, userId: string) {
    const skill = await this.findOrFail(skillId);
    await this.access.requireAdmin(skill.workspaceId, userId);
    await this.prisma.skill.delete({ where: { id: skillId } });
    await this.activity.log({ workspaceId: skill.workspaceId, actorId: userId, entityType: 'skill', entityId: skillId, action: 'deleted', oldValue: { name: skill.name } });
  }
}

