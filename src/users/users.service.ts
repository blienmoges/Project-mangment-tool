import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import { AppException, Errors } from '../common/app-exception';
import { StorageService } from '../files/storage.service';
import { AVATAR_NAME, AVATAR_PATH, AVATAR_TYPES, imageType, MAX_AVATAR_BYTES } from './avatar';
import { publicUser } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { SetSkillDto, UpdateMeDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** POST /me/avatar — replaces the profile photo; the old file is deleted. */
  async setAvatar(userId: string, file?: { buffer: Buffer; size: number }) {
    if (!file?.buffer?.length) throw Errors.validation({ file: 'send one image in the "file" field (multipart/form-data)' });
    if (file.size > MAX_AVATAR_BYTES) throw new AppException(413, { code: 'FILE_TOO_LARGE', message: 'Profile photos can be up to 2 MB.' });
    const type = imageType(file.buffer);
    if (!type) throw Errors.validation({ file: 'must be a PNG, JPEG or WebP image' });
    const name = await this.storage.saveAvatar(file.buffer, type);
    const { avatarUrl: oldUrl } = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarUrl: true } });
    const user = await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: `${AVATAR_PATH}${name}` } });
    if (oldUrl !== user.avatarUrl) await this.removeAvatarFile(oldUrl);
    return publicUser(user);
  }

  /** DELETE /me/avatar */
  async deleteAvatar(userId: string) {
    const { avatarUrl: oldUrl } = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarUrl: true } });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    await this.removeAvatarFile(oldUrl);
  }

  /** GET /avatars/:name — public, so <img> tags work; the random name is unguessable and never reused. */
  sendAvatar(name: string, res: Response) {
    if (!AVATAR_NAME.test(name)) throw Errors.notFound('Photo');
    const ext = name.split('.').pop() as keyof typeof AVATAR_TYPES;
    res.set({
      'Content-Type': AVATAR_TYPES[ext], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    const stream = this.storage.open(`avatars/${name}`);
    stream.on('error', () => { if (!res.headersSent) res.status(404).set('Cache-Control', 'no-store'); res.end(); });
    stream.pipe(res);
  }

  private async removeAvatarFile(url: string | null) {
    const name = url?.startsWith(AVATAR_PATH) ? url.slice(AVATAR_PATH.length) : null;
    if (name && AVATAR_NAME.test(name)) await this.storage.remove(`avatars/${name}`);
  }

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

