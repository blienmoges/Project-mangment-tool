import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Attachment, Prisma } from '@prisma/client';
import { Response } from 'express';
import { ActivityService } from '../activity/activity.service';
import { AppException, Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { DOWNLOAD_LINK_SECONDS, makeDownloadToken, readDownloadToken } from './download-token';
import { StorageService } from './storage.service';

type Tx = Prisma.TransactionClient;

/** 20 MB, as in the API Design and the attachments_max_size CHECK. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Shown in the browser; every other type is downloaded, so an uploaded HTML or SVG file can never run script. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const uploaderBrief = { id: true, fullName: true } as const;

export type UploadedFile = Pick<Express.Multer.File, 'originalname' | 'mimetype' | 'size' | 'buffer'>;
type Parent = { taskId: string } | { issueId: string } | { messageId: string };

/** Files on tasks, issues and messages (SRS FR-2.3, FR-5.4, FR-6.1; SI-3). */
@Injectable()
export class AttachmentsService {
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('JWT_ACCESS_SECRET') ?? '';
  }

  // ───────────── uploads ─────────────

  async uploadToTask(taskId: string, userId: string, file?: UploadedFile) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw Errors.notFound('Task');
    const { project } = await this.projectAccess.require(task.projectId, userId, 'member', 'Task');
    this.projectAccess.assertWritable(project);
    return this.toApi(await this.prisma.tx((tx) => this.store(tx, project.workspaceId, { taskId }, userId, this.check(file))));
  }

  async uploadToIssue(issueId: string, userId: string, file?: UploadedFile) {
    const issue = await this.prisma.issue.findUnique({ where: { id: issueId }, select: { projectId: true } });
    if (!issue) throw Errors.notFound('Issue');
    const { project } = await this.projectAccess.require(issue.projectId, userId, 'member', 'Issue');
    this.projectAccess.assertWritable(project);
    return this.toApi(await this.prisma.tx((tx) => this.store(tx, project.workspaceId, { issueId }, userId, this.check(file))));
  }

  /** Used by the messaging module inside its own transaction (the message and its files are saved together). */
  async attachToMessage(tx: Tx, workspaceId: string, messageId: string, userId: string, files: UploadedFile[]) {
    const out: Attachment[] = [];
    for (const f of files) out.push(await this.store(tx, workspaceId, { messageId }, userId, this.check(f)));
    return out;
  }

  // ───────────── reading ─────────────

  async listForTask(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw Errors.notFound('Task');
    await this.projectAccess.require(task.projectId, userId, 'read', 'Task');
    return { data: (await this.prisma.attachment.findMany({ where: { taskId }, include: { uploadedBy: { select: uploaderBrief } }, orderBy: { createdAt: 'asc' } })).map((a) => this.toApi(a)) };
  }

  async listForIssue(issueId: string, userId: string) {
    const issue = await this.prisma.issue.findUnique({ where: { id: issueId }, select: { projectId: true } });
    if (!issue) throw Errors.notFound('Issue');
    await this.projectAccess.require(issue.projectId, userId, 'member', 'Issue');
    return { data: (await this.prisma.attachment.findMany({ where: { issueId }, include: { uploadedBy: { select: uploaderBrief } }, orderBy: { createdAt: 'asc' } })).map((a) => this.toApi(a)) };
  }

  /** GET /attachments/:id — a download link valid for 5 minutes, for anyone who can see the parent. */
  async link(attachmentId: string, userId: string) {
    const a = await this.findOrFail(attachmentId);
    await this.requireParent(a, userId, 'read');
    const { token, expiresAt } = makeDownloadToken(this.secret, a.id);
    return { ...this.toApi(a), url: `/api/v1/files/${token}`, expiresAt, expiresInSeconds: DOWNLOAD_LINK_SECONDS };
  }

  /** GET /files/:token — no login needed; the signed token is the permission. */
  async download(token: string, res: Response) {
    const id = readDownloadToken(this.secret, token);
    if (!id) throw Errors.gone('LINK_EXPIRED', 'This download link has expired. Open the file again to get a new one.');
    const a = await this.prisma.attachment.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('File');
    const inline = INLINE_TYPES.has(a.mimeType);
    res.set({
      'Content-Type': inline ? a.mimeType : 'application/octet-stream',
      'Content-Length': String(a.sizeBytes),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': `private, max-age=${DOWNLOAD_LINK_SECONDS}`,
    });
    const stream = this.storage.open(a.storageKey);
    stream.on('error', () => { if (!res.headersSent) res.status(404); res.end(); });
    stream.pipe(res);
  }

  /** DELETE /attachments/:id — the uploader, the project's PM or the Admin. */
  async remove(attachmentId: string, userId: string) {
    const a = await this.findOrFail(attachmentId);
    const { canManage, project } = await this.requireParent(a, userId, a.messageId ? 'read' : 'member');
    if (a.uploadedById !== userId && !canManage) throw Errors.forbidden('Only the person who uploaded the file or the Project Manager can remove it.');
    if (project) this.projectAccess.assertWritable(project);
    await this.prisma.tx(async (tx) => {
      await tx.attachment.delete({ where: { id: attachmentId } });
      await this.activity.log({ workspaceId: a.workspaceId, actorId: userId, entityType: 'attachment', entityId: attachmentId, action: 'deleted', oldValue: { fileName: a.fileName, taskId: a.taskId, issueId: a.issueId, messageId: a.messageId } }, tx);
    });
    await this.storage.remove(a.storageKey);
  }

  /** Deletes stored files of attachments that were removed together with their parent (call after the delete). */
  async removeFiles(keys: string[]) {
    for (const k of keys) await this.storage.remove(k);
  }

  toApi(a: Attachment & { uploadedBy?: { id: string; fullName: string } }) {
    return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, uploadedBy: a.uploadedBy ?? { id: a.uploadedById }, createdAt: a.createdAt };
  }

  // ───────────── internals ─────────────

  private check(file?: UploadedFile) {
    if (!file?.buffer?.length) throw Errors.validation({ file: 'send one non-empty file in the "file" field (multipart/form-data)' });
    if (file.size > MAX_FILE_BYTES) throw new AppException(413, { code: 'FILE_TOO_LARGE', message: 'Files can be up to 20 MB.' });
    return file;
  }

  private async store(tx: Tx, workspaceId: string, parent: Parent, userId: string, file: UploadedFile) {
    const key = await this.storage.save(workspaceId, file.buffer);
    try {
      return await tx.attachment.create({
        data: { workspaceId, ...parent, fileName: cleanName(file.originalname), storageKey: key, mimeType: (file.mimetype || 'application/octet-stream').slice(0, 100), sizeBytes: file.size, uploadedById: userId },
        include: { uploadedBy: { select: uploaderBrief } },
      });
    } catch (e) {
      await this.storage.remove(key); // no row, no file
      throw e;
    }
  }

  private async findOrFail(id: string) {
    const a = await this.prisma.attachment.findUnique({ where: { id }, include: { uploadedBy: { select: uploaderBrief } } });
    if (!a) throw Errors.notFound('File');
    return a;
  }

  /** "Anyone who can see the parent": task (Guests too), issue (members), message (channel members). */
  private async requireParent(a: Attachment, userId: string, need: 'read' | 'member') {
    if (a.messageId) {
      const msg = await this.prisma.message.findUnique({ where: { id: a.messageId }, select: { channelId: true } });
      const member = msg && (await this.prisma.channelMember.findUnique({ where: { channelId_userId: { channelId: msg.channelId, userId } } }));
      if (!member) throw Errors.notFound('File');
      const ws = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: a.workspaceId, userId } } });
      return { canManage: ws?.role === 'admin', project: null };
    }
    const parent = a.taskId
      ? await this.prisma.task.findUnique({ where: { id: a.taskId }, select: { projectId: true } })
      : await this.prisma.issue.findUnique({ where: { id: a.issueId! }, select: { projectId: true } });
    if (!parent) throw Errors.notFound('File');
    const access = await this.projectAccess.require(parent.projectId, userId, a.issueId ? 'member' : need, 'File');
    return { canManage: access.isAdmin || access.isManager, project: access.project };
  }
}

/** Keeps the name readable but harmless: no folders, no control characters, at most 255 characters. */
export function cleanName(name: string) {
  const base = (name || 'file').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (base || 'file').slice(-255);
}
