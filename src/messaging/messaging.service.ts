import { Injectable } from '@nestjs/common';
import { ChannelType, NotificationEvent, Prisma, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { mentionedIds, preview } from '../common/mentions';
import { AttachmentsService, UploadedFile } from '../files/attachments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { afterCommit, PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { EditMessageDto, MessageListQuery, OpenDirectDto, SearchQuery } from './dto/messaging.dto';

const userBrief = { id: true, fullName: true, avatarUrl: true } as const;
const messageInclude = { sender: { select: userBrief }, attachments: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true } } } satisfies Prisma.MessageInclude;
type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;
const MAX_FILES = 5;

/**
 * Messaging (SRS 3.5): direct conversations, one channel per project (FR-5.2) and per team (FR-10.4). Messages go
 * through the REST API; the WebSocket pushes message.created / message.updated / message.deleted and channel.read to
 * the channel's members (FR-5.3). Guests cannot message (Roles guide). Membership of project and team channels follows
 * the project and the team automatically (steps 1–2).
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly attachments: AttachmentsService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /channels — the caller's channels with name, last message and unread count, most recent first. */
  async list(userId: string, workspaceId?: string) {
    const memberships = await this.prisma.workspaceMember.findMany({ where: { userId, ...(workspaceId ? { workspaceId } : {}) }, select: { workspaceId: true, role: true } });
    if (workspaceId && !memberships.length) throw Errors.notFound('Workspace');
    await this.ensureTeamChannels(memberships.filter((m) => m.role !== WorkspaceRole.guest).map((m) => m.workspaceId));
    const rows = await this.prisma.channelMember.findMany({
      where: { userId, channel: { workspaceId: { in: memberships.map((m) => m.workspaceId) } } },
      include: {
        channel: {
          include: {
            project: { select: { id: true, name: true, keyPrefix: true, archivedAt: true } },
            team: { select: { id: true, name: true } },
            members: { where: { userId: { not: userId } }, take: 1, include: { user: { select: userBrief } } },
          },
        },
      },
    });
    const ids = rows.map((r) => r.channelId);
    if (!ids.length) return { data: [] };
    const [unread, last] = await Promise.all([
      this.prisma.$queryRaw<{ channel_id: string; unread: number }[]>`
        SELECT cm.channel_id, count(m.id)::int AS unread
        FROM channel_members cm
        JOIN messages m ON m.channel_id = cm.channel_id AND m.sender_id <> cm.user_id
          AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)
        WHERE cm.user_id = ${userId}::uuid AND cm.channel_id = ANY(${ids}::uuid[])
        GROUP BY cm.channel_id`,
      this.prisma.$queryRaw<{ id: string; channel_id: string; sender_id: string; body: string; created_at: Date }[]>`
        SELECT DISTINCT ON (channel_id) id, channel_id, sender_id, body, created_at
        FROM messages WHERE channel_id = ANY(${ids}::uuid[])
        ORDER BY channel_id, created_at DESC`,
    ]);
    const data = rows.map((r) => {
      const c = r.channel;
      const lastMsg = last.find((l) => l.channel_id === c.id);
      const other = c.type === ChannelType.direct ? c.members[0]?.user ?? null : null;
      return {
        id: c.id, workspaceId: c.workspaceId, type: c.type,
        name: c.type === ChannelType.project ? `${c.project?.keyPrefix} · ${c.project?.name}` : c.type === ChannelType.team ? c.team?.name : other?.fullName ?? 'Conversation',
        project: c.project ? { id: c.project.id, name: c.project.name, keyPrefix: c.project.keyPrefix, archived: !!c.project.archivedAt } : null,
        team: c.team, otherUser: other,
        lastMessage: lastMsg ? { id: lastMsg.id, senderId: lastMsg.sender_id, preview: preview(lastMsg.body, 80), createdAt: lastMsg.created_at } : null,
        unreadCount: unread.find((u) => u.channel_id === c.id)?.unread ?? 0,
        lastReadAt: r.lastReadAt,
        activityAt: lastMsg?.created_at ?? c.createdAt,
      };
    });
    data.sort((a, b) => b.activityAt.getTime() - a.activityAt.getTime());
    return { data };
  }

  /** POST /channels/direct — opens the conversation with someone, creating it the first time (FR-5.1). */
  async openDirect(userId: string, dto: OpenDirectDto) {
    if (dto.userId === userId) throw Errors.validation({ userId: 'choose someone other than yourself' });
    const shared = await this.prisma.workspaceMember.findMany({
      where: { userId, ...(dto.workspaceId ? { workspaceId: dto.workspaceId } : {}), workspace: { members: { some: { userId: dto.userId } } } },
      select: { workspaceId: true, role: true },
    });
    if (!shared.length) throw Errors.notFound('Person');
    if (shared.length > 1) throw Errors.validation({ workspaceId: 'required: you share several workspaces with this person' });
    const workspaceId = shared[0].workspaceId;
    const other = await this.prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId: dto.userId } } });
    if (shared[0].role === WorkspaceRole.guest || other.role === WorkspaceRole.guest) throw Errors.forbidden('Guests cannot send or receive messages.');
    const channel = await this.prisma.tx(async (tx) => {
      // Serialises "open" for this pair, so two clicks at once never create two conversations.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${['dm', workspaceId, ...[userId, dto.userId].sort()].join(':')}))`;
      const existing = await tx.channel.findFirst({
        where: { workspaceId, type: ChannelType.direct, AND: [{ members: { some: { userId } } }, { members: { some: { userId: dto.userId } } }] },
      });
      if (existing) return existing;
      const created = await tx.channel.create({ data: { workspaceId, type: ChannelType.direct } });
      await tx.channelMember.createMany({ data: [{ channelId: created.id, userId }, { channelId: created.id, userId: dto.userId }] });
      return created;
    });
    const otherUser = await this.prisma.user.findUniqueOrThrow({ where: { id: dto.userId }, select: userBrief });
    return { id: channel.id, workspaceId, type: channel.type, name: otherUser.fullName, otherUser, createdAt: channel.createdAt };
  }

  /** GET /channels/:id/messages — newest first; ?before=<messageId> for older ones. */
  async messages(channelId: string, userId: string, q: MessageListQuery) {
    await this.requireMember(channelId, userId);
    const limit = q.limit ?? 50;
    let before: Date | undefined;
    if (q.before) {
      const ref = await this.prisma.message.findFirst({ where: { id: q.before, channelId }, select: { createdAt: true } });
      if (!ref) throw Errors.validation({ before: 'must be a message of this channel' });
      before = ref.createdAt;
    }
    const rows = await this.prisma.message.findMany({
      where: { channelId, ...(before ? { createdAt: { lt: before } } : {}) },
      include: messageInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { data: page.map(toApi), nextBefore: rows.length > limit ? page[page.length - 1].id : null };
  }

  /** POST /channels/:id/messages — text and/or up to 5 files; @mentions notify the people named. */
  async send(channelId: string, userId: string, body: string | undefined, files: UploadedFile[] = []) {
    const channel = await this.requireMember(channelId, userId);
    const text = (body ?? '').trim();
    if (!text && !files.length) throw Errors.validation({ body: 'write a message or attach a file' });
    if (files.length > MAX_FILES) throw Errors.validation({ files: `at most ${MAX_FILES} files per message` });
    await this.assertProjectOpen(channel.projectId);
    const message = await this.prisma.tx(async (tx) => {
      const created = await tx.message.create({ data: { channelId, senderId: userId, body: text } });
      if (files.length) await this.attachments.attachToMessage(tx, channel.workspaceId, created.id, userId, files);
      await tx.channelMember.update({ where: { channelId_userId: { channelId, userId } }, data: { lastReadAt: new Date() } }); // own messages are read
      const full = await tx.message.findUniqueOrThrow({ where: { id: created.id }, include: messageInclude });
      const members = (await tx.channelMember.findMany({ where: { channelId }, select: { userId: true } })).map((m) => m.userId);
      const mentioned = mentionedIds(text).filter((id) => members.includes(id));
      if (mentioned.length) {
        await this.notifications.notify(tx, {
          workspaceId: channel.workspaceId, eventType: NotificationEvent.mention, userIds: mentioned, actorId: userId,
          body: `${full.sender.fullName} mentioned you in ${await this.channelLabel(tx, channelId)}: "${preview(text)}"`,
          ...(channel.projectId ? { link: { type: 'project' as const, id: channel.projectId } } : {}),
        });
      }
      afterCommit(() => this.realtime.emitToUsers(members, 'message.created', { message: toApi(full) }));
      return full;
    });
    return toApi(message);
  }

  /** PATCH /messages/:id — the sender edits their own message. */
  async edit(messageId: string, userId: string, dto: EditMessageDto) {
    const msg = await this.ownMessage(messageId, userId);
    await this.assertProjectOpen(msg.channel.projectId);
    const updated = await this.prisma.message.update({ where: { id: messageId }, data: { body: dto.body.trim(), editedAt: new Date() }, include: messageInclude });
    const members = await this.memberIds(msg.channelId);
    this.realtime.emitToUsers(members, 'message.updated', { message: toApi(updated) });
    return toApi(updated);
  }

  /** DELETE /messages/:id — the sender deletes their own message and its files. */
  async remove(messageId: string, userId: string) {
    const msg = await this.ownMessage(messageId, userId);
    const keys = (await this.prisma.attachment.findMany({ where: { messageId }, select: { storageKey: true } })).map((a) => a.storageKey);
    await this.prisma.tx(async (tx) => {
      await tx.message.delete({ where: { id: messageId } }); // attachments go with it (ON DELETE CASCADE)
      await this.activity.log({ workspaceId: msg.channel.workspaceId, actorId: userId, entityType: 'message', entityId: messageId, action: 'deleted' }, tx);
    });
    await this.attachments.removeFiles(keys);
    this.realtime.emitToUsers(await this.memberIds(msg.channelId), 'message.deleted', { messageId, channelId: msg.channelId });
  }

  /** POST /channels/:id/read — marks everything up to now as read; members see "Seen" (FR-5.3). */
  async markRead(channelId: string, userId: string) {
    await this.requireMember(channelId, userId);
    const lastReadAt = new Date();
    await this.prisma.channelMember.update({ where: { channelId_userId: { channelId, userId } }, data: { lastReadAt } });
    this.realtime.emitToUsers(await this.memberIds(channelId), 'channel.read', { channelId, userId, lastReadAt });
    return { channelId, lastReadAt };
  }

  /** GET /messages/search?q= — words in the caller's own conversations (FR-5.6), newest first. */
  async search(userId: string, q: SearchQuery) {
    const words = q.q.trim();
    const hits = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM messages m
      JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ${userId}::uuid
      JOIN channels c ON c.id = m.channel_id
      JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = ${userId}::uuid
      WHERE m.search_vector @@ plainto_tsquery('simple', ${words})
        ${q.workspaceId ? Prisma.sql`AND c.workspace_id = ${q.workspaceId}::uuid` : Prisma.empty}
      ORDER BY m.created_at DESC LIMIT 50`;
    const rows = await this.prisma.message.findMany({ where: { id: { in: hits.map((h) => h.id) } }, include: messageInclude });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { data: hits.map((h) => byId.get(h.id)).filter((r): r is MessageRow => !!r).map(toApi) };
  }

  // ───────────── helpers ─────────────

  private async requireMember(channelId: string, userId: string) {
    const member = await this.prisma.channelMember.findUnique({ where: { channelId_userId: { channelId, userId } }, include: { channel: true } });
    if (!member) throw Errors.notFound('Channel');
    return member.channel;
  }

  private async memberIds(channelId: string) {
    return (await this.prisma.channelMember.findMany({ where: { channelId }, select: { userId: true } })).map((m) => m.userId);
  }

  private async ownMessage(messageId: string, userId: string) {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId }, include: { channel: true } });
    if (!msg) throw Errors.notFound('Message');
    const member = await this.prisma.channelMember.findUnique({ where: { channelId_userId: { channelId: msg.channelId, userId } } });
    if (!member) throw Errors.notFound('Message');
    if (msg.senderId !== userId) throw Errors.forbidden('You can only change your own messages.');
    return msg;
  }

  /** The channel of an archived project stays readable but takes no new messages (SRS 6.2). */
  private async assertProjectOpen(projectId: string | null) {
    if (!projectId) return;
    const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { archivedAt: true, space: { select: { archivedAt: true } } } });
    if (p?.archivedAt || p?.space.archivedAt) throw Errors.conflict('PROJECT_ARCHIVED', 'This project is archived, so its channel is read-only.');
  }

  private async channelLabel(tx: Prisma.TransactionClient, channelId: string) {
    const c = await tx.channel.findUniqueOrThrow({ where: { id: channelId }, include: { project: { select: { keyPrefix: true } }, team: { select: { name: true } } } });
    return c.type === ChannelType.project ? `the ${c.project?.keyPrefix} channel` : c.type === ChannelType.team ? `the ${c.team?.name} channel` : 'a direct message';
  }

  /** FR-10.4: every team has a channel. Created on first use, so teams made before this step get one too. */
  private async ensureTeamChannels(workspaceIds: string[]) {
    if (!workspaceIds.length) return;
    const missing = await this.prisma.team.findMany({ where: { workspaceId: { in: workspaceIds }, channels: { none: {} } }, select: { id: true, workspaceId: true, members: { select: { userId: true } } } });
    for (const t of missing) {
      await this.prisma.tx(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`team-channel:${t.id}`}))`;
        if (await tx.channel.findFirst({ where: { teamId: t.id, type: ChannelType.team } })) return;
        const c = await tx.channel.create({ data: { workspaceId: t.workspaceId, type: ChannelType.team, teamId: t.id } });
        if (t.members.length) await tx.channelMember.createMany({ data: t.members.map((m) => ({ channelId: c.id, userId: m.userId })), skipDuplicates: true });
      });
    }
  }
}

function toApi(m: MessageRow) {
  return {
    id: m.id, channelId: m.channelId, sender: m.sender, body: m.body, mentions: mentionedIds(m.body),
    attachments: m.attachments, editedAt: m.editedAt, createdAt: m.createdAt,
  };
}
