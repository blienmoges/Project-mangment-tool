import { Injectable } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { unique } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Checks that a person belongs to a workspace and, optionally, has one of the given roles.
 * Non-members get 404 (so they cannot tell the workspace exists); wrong role gets 403.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async requireMember(workspaceId: string, userId: string, roles?: WorkspaceRole[]) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) throw Errors.notFound('Workspace');
    if (roles && !roles.includes(membership.role)) {
      throw Errors.forbidden(roles.length === 1 && roles[0] === WorkspaceRole.admin ? 'Only a Workspace Admin can do this.' : undefined);
    }
    return membership;
  }

  requireAdmin(workspaceId: string, userId: string) {
    return this.requireMember(workspaceId, userId, [WorkspaceRole.admin]);
  }

  /** "Any" in the API Design: Workspace Admin or Member, never Guest. */
  requireNonGuest(workspaceId: string, userId: string) {
    return this.requireMember(workspaceId, userId, [WorkspaceRole.admin, WorkspaceRole.member]);
  }

  /**
   * Checks that every id in `userIds` belongs to the workspace (and is not a Guest unless allowed).
   * Answers VALIDATION_FAILED on `field` otherwise. Returns the memberships.
   */
  async requireWorkspaceUsers(workspaceId: string, userIds: string[], field = 'userIds', opts: { allowGuests?: boolean } = {}) {
    const ids = unique(userIds);
    if (!ids.length) return [];
    const rows = await this.prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: ids } } });
    const found = new Set(rows.map((r) => r.userId));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw Errors.validation({ [field]: `not members of this workspace: ${missing.join(', ')}` });
    if (!opts.allowGuests) {
      const guests = rows.filter((r) => r.role === WorkspaceRole.guest).map((r) => r.userId);
      if (guests.length) throw Errors.validation({ [field]: `Guests cannot be added here: ${guests.join(', ')}` });
    }
    return rows;
  }
}
