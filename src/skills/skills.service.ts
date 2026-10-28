import { Injectable } from '@nestjs/common';
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

  async remove(skillId: string, userId: string) {
    const skill = await this.findOrFail(skillId);
    await this.access.requireAdmin(skill.workspaceId, userId);
    await this.prisma.skill.delete({ where: { id: skillId } });
    await this.activity.log({ workspaceId: skill.workspaceId, actorId: userId, entityType: 'skill', entityId: skillId, action: 'deleted', oldValue: { name: skill.name } });
  }
}

