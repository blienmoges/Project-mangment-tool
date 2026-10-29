import { Injectable } from '@nestjs/common';
import { Prisma, Space, SpaceVisibility, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';

export interface SpaceAccess {
  space: Space;
  membership: WorkspaceMember;
  isAdmin: boolean;
  isSpaceMember: boolean;
}

/**
 * Space access (API Design, access rule 4): an Open space is visible to every non-Guest member,
 * a Private space only to its members and the Workspace Admin. Guests see only spaces they were added to.
 * Anyone who cannot see a space gets 404, so they cannot tell it exists.
 */
@Injectable()
export class SpaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async requireSpace(spaceId: string, userId: string): Promise<SpaceAccess> {
    const space = await this.prisma.space.findUnique({ where: { id: spaceId } });
    if (!space) throw Errors.notFound('Space');
    const membership = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: space.workspaceId, userId } } });
    if (!membership) throw Errors.notFound('Space');
    const isAdmin = membership.role === WorkspaceRole.admin;
    const isSpaceMember = !!(await this.prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId } } }));
    const canSee = isAdmin || isSpaceMember || (membership.role === WorkspaceRole.member && space.visibility === SpaceVisibility.open);
    if (!canSee) throw Errors.notFound('Space');
    return { space, membership, isAdmin, isSpaceMember };
  }

  /** Space settings, members, statuses and custom fields are managed by the Workspace Admin only. */
  async requireSpaceAdmin(spaceId: string, userId: string): Promise<SpaceAccess> {
    const access = await this.requireSpace(spaceId, userId);
    if (!access.isAdmin) throw Errors.forbidden('Only a Workspace Admin can do this.');
    return access;
  }

  /** Filter for the spaces a workspace member can see. */
  visibleSpacesWhere(membership: WorkspaceMember): Prisma.SpaceWhereInput {
    const base = { workspaceId: membership.workspaceId };
    if (membership.role === WorkspaceRole.admin) return base;
    if (membership.role === WorkspaceRole.guest) return { ...base, members: { some: { userId: membership.userId } } };
    return { ...base, OR: [{ visibility: SpaceVisibility.open }, { members: { some: { userId: membership.userId } } }] };
  }
}
