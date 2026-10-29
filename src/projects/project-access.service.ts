import { Injectable } from '@nestjs/common';
import { Prisma, ProjectMember, ProjectRole, SpaceVisibility, WorkspaceMember, WorkspaceRole } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What the caller needs to be:
 *  read   — Admin, or anyone in project_members (including Guests)
 *  member — Admin, the PM or a Team Member (not a Guest)
 *  manage — Admin or the project's PM
 *  admin  — Workspace Admin only
 */
export type ProjectNeed = 'read' | 'member' | 'manage' | 'admin';

const projectInclude = { space: true, workspace: { select: { timezone: true, workingDays: true } } } as const;
export type ProjectWithSpace = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

export interface ProjectAccess {
  project: ProjectWithSpace;
  membership: WorkspaceMember;
  projectMember: ProjectMember | null;
  isAdmin: boolean;
  isManager: boolean;
}

/**
 * Project access, checked in the API Design's order: workspace member (else 404), Guest limits (403),
 * space access (404), project role (403). Other modules (tasks, sprints, issues...) use it too.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** `what` names the record in 404 messages ("Task not found." when called for a task). */
  async require(projectId: string, userId: string, need: ProjectNeed = 'read', what = 'Project'): Promise<ProjectAccess> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, include: projectInclude });
    if (!project) throw Errors.notFound(what);
    const membership = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } } });
    if (!membership) throw Errors.notFound(what);
    const isAdmin = membership.role === WorkspaceRole.admin;
    if (membership.role === WorkspaceRole.guest && need !== 'read') throw Errors.forbidden('Guests have read-only access.');

    const [projectMember, spaceMember] = await Promise.all([
      this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } }),
      isAdmin ? null : this.prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: project.spaceId, userId } } }),
    ]);
    if (!isAdmin) {
      const seesSpace = !!spaceMember || (membership.role === WorkspaceRole.member && project.space.visibility === SpaceVisibility.open);
      if (!seesSpace) throw Errors.notFound(what);
    }
    const isManager = projectMember?.role === ProjectRole.project_manager;
    const ok =
      isAdmin ||
      (need === 'read' && !!projectMember) ||
      (need === 'member' && !!projectMember && projectMember.role !== ProjectRole.guest) ||
      (need === 'manage' && isManager);
    if (!ok) {
      throw Errors.forbidden(
        need === 'admin' ? 'Only a Workspace Admin can do this.'
          : need === 'manage' ? 'Only the Project Manager or a Workspace Admin can do this.'
            : 'You are not a member of this project.',
      );
    }
    return { project, membership, projectMember, isAdmin, isManager };
  }

  /** Archived spaces and archived projects are read-only (SRS FR-9.6, 6.2). */
  assertWritable(project: ProjectWithSpace) {
    if (project.space.archivedAt) throw Errors.conflict('SPACE_ARCHIVED', `The space "${project.space.name}" is archived, so its projects are read-only.`);
    if (project.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived, so it is read-only. Change its status to restore it.');
  }

  /** Projects a workspace member can open: all for the Admin, otherwise those they belong to. */
  visibleProjectsWhere(membership: WorkspaceMember): Prisma.ProjectWhereInput {
    return membership.role === WorkspaceRole.admin ? {} : { members: { some: { userId: membership.userId } } };
  }
}
