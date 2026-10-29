import { Injectable } from '@nestjs/common';
import { NotificationEvent, ProjectRole, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { mentionedIds, preview } from '../common/mentions';
import { shortId } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';

const authorBrief = { id: true, fullName: true, avatarUrl: true } as const;

/** Task comments (SRS FR-5.5). Members and the Admin comment; @mentions notify project members (FR-5.4). */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  async list(taskId: string, userId: string) {
    await this.access(taskId, userId);
    const rows = await this.prisma.comment.findMany({ where: { taskId }, include: { author: { select: authorBrief } }, orderBy: { createdAt: 'asc' } });
    return { data: rows.map(toApi) };
  }

  async create(taskId: string, userId: string, body: string) {
    const { task, project } = await this.access(taskId, userId);
    this.projectAccess.assertWritable(project);
    const text = body.trim();
    if (!text) throw Errors.validation({ body: 'must not be empty' });
    const comment = await this.prisma.tx(async (tx) => {
      const created = await tx.comment.create({ data: { taskId, authorId: userId, body: text }, include: { author: { select: authorBrief } } });
      await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'task', entityId: taskId, action: 'commented', newValue: { commentId: created.id } }, tx);
      const ids = mentionedIds(text);
      if (ids.length) {
        // Only people who can see the comment: project members who are not Guests, plus Workspace Admins.
        const [members, admins] = await Promise.all([
          tx.projectMember.findMany({ where: { projectId: task.projectId, userId: { in: ids }, role: { not: ProjectRole.guest } }, select: { userId: true } }),
          tx.workspaceMember.findMany({ where: { workspaceId: project.workspaceId, userId: { in: ids }, role: WorkspaceRole.admin }, select: { userId: true } }),
        ]);
        await this.notifications.notify(tx, {
          workspaceId: project.workspaceId, eventType: NotificationEvent.mention, userIds: [...members, ...admins].map((m) => m.userId), actorId: userId,
          body: `${created.author.fullName} mentioned you on ${shortId(project.keyPrefix, task.number)} ${task.title}: "${preview(text)}"`,
          link: { type: 'task', id: taskId },
        });
      }
      return created;
    });
    return toApi(comment);
  }

  /** The author edits their own comment. */
  async edit(commentId: string, userId: string, body: string) {
    const c = await this.own(commentId, userId);
    const text = body.trim();
    if (!text) throw Errors.validation({ body: 'must not be empty' });
    const updated = await this.prisma.comment.update({ where: { id: commentId }, data: { body: text, editedAt: new Date() }, include: { author: { select: authorBrief } } });
    await this.activity.log({ workspaceId: c.workspaceId, actorId: userId, entityType: 'task', entityId: c.taskId, action: 'comment_edited', newValue: { commentId } });
    return toApi(updated);
  }

  /** The author deletes their own comment. */
  async remove(commentId: string, userId: string) {
    const c = await this.own(commentId, userId);
    await this.prisma.comment.delete({ where: { id: commentId } });
    await this.activity.log({ workspaceId: c.workspaceId, actorId: userId, entityType: 'task', entityId: c.taskId, action: 'comment_deleted', oldValue: { commentId, body: preview(c.body, 200) } });
  }

  private async access(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, number: true, title: true } });
    if (!task) throw Errors.notFound('Task');
    const { project } = await this.projectAccess.require(task.projectId, userId, 'member', 'Task');
    return { task, project };
  }

  private async own(commentId: string, userId: string) {
    const c = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!c) throw Errors.notFound('Comment');
    const { project } = await this.access(c.taskId, userId);
    if (c.authorId !== userId) throw Errors.forbidden('You can only change your own comments.');
    this.projectAccess.assertWritable(project);
    return { ...c, workspaceId: project.workspaceId };
  }
}

function toApi(c: { id: string; taskId: string; body: string; editedAt: Date | null; createdAt: Date; author: { id: string; fullName: string; avatarUrl: string | null } }) {
  return { id: c.id, taskId: c.taskId, author: c.author, body: c.body, mentions: mentionedIds(c.body), editedAt: c.editedAt, createdAt: c.createdAt };
}
