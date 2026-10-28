import { Injectable } from '@nestjs/common';
import { Errors } from '../common/app-exception';
import { publicUser } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { SetSkillDto, UpdateMeDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /me: my profile plus the workspaces I belong to and my role in each. */
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { workspace: { select: { id: true, name: true, slug: true, logoUrl: true } } } } },
    });
    if (!user) throw Errors.unauthenticated();
    const { memberships, ...rest } = user;
    return {
      ...publicUser(rest),
      workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    };
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { ...dto, fullName: dto.fullName?.trim() } });
    return publicUser(user);
  }

  async mySkills(userId: string) {
    const rows = await this.prisma.userSkill.findMany({
      where: { userId },
      include: { skill: true, verifiedBy: { select: { id: true, fullName: true } } },
      orderBy: { skill: { name: 'asc' } },
    });
    return {
      data: rows.map((r) => ({
        skillId: r.skillId,
        name: r.skill.name,
        category: r.skill.category,
        workspaceId: r.skill.workspaceId,
        level: r.level,
        verified: !!r.verifiedAt,
        verifiedBy: r.verifiedBy,
        verifiedAt: r.verifiedAt,
      })),
    };
  }

  /** Add a skill or change its level. Changing the level clears any verification. */
  async setSkill(userId: string, skillId: string, dto: SetSkillDto) {
    const skill = await this.prisma.skill.findUnique({ where: { id: skillId } });
    if (!skill) throw Errors.notFound('Skill');
    const member = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: skill.workspaceId, userId } } });
    if (!member) throw Errors.notFound('Skill');
    const existing = await this.prisma.userSkill.findUnique({ where: { userId_skillId: { userId, skillId } } });
    const levelChanged = !existing || existing.level !== dto.level;
    return this.prisma.userSkill.upsert({
      where: { userId_skillId: { userId, skillId } },
      create: { userId, skillId, level: dto.level },
      update: { level: dto.level, ...(levelChanged ? { verifiedById: null, verifiedAt: null } : {}) },
    });
  }

  async removeSkill(userId: string, skillId: string) {
    await this.prisma.userSkill.deleteMany({ where: { userId, skillId } });
  }
}

