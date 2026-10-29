import { Injectable } from '@nestjs/common';
import { NotificationEvent, Prisma } from '@prisma/client';
import { Errors } from '../common/app-exception';
import { pageArgs, toPage } from '../common/paging';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationListQuery, PreferenceDto } from './dto/notification.dto';
import { defaultPreference, EVENTS } from './events';
import { toApi } from './notifications.service';

/** The notifications endpoints (API Design section 6) — always the caller's own. */
@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, q: NotificationListQuery) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(q.unread ? { readAt: null } : {}),
      ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      workspace: { members: { some: { userId } } }, // nothing from workspaces the person has left
    };
    const rows = await this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(q) });
    return toPage(rows, q, toApi);
  }

  /** The badge number (UI-3), in total and per workspace. */
  async unreadCount(userId: string) {
    const rows = await this.prisma.notification.groupBy({
      by: ['workspaceId'], where: { userId, readAt: null, workspace: { members: { some: { userId } } } }, _count: { _all: true },
    });
    return { count: rows.reduce((s, r) => s + r._count._all, 0), byWorkspace: Object.fromEntries(rows.map((r) => [r.workspaceId, r._count._all])) };
  }

  async markRead(userId: string, notificationId: string) {
    const r = await this.prisma.notification.updateMany({ where: { id: notificationId, userId, readAt: null }, data: { readAt: new Date() } });
    if (!r.count && !(await this.prisma.notification.findFirst({ where: { id: notificationId, userId }, select: { id: true } }))) {
      throw Errors.notFound('Notification');
    }
    return this.unreadCount(userId);
  }

  async markAllRead(userId: string, workspaceId?: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(workspaceId ? { workspaceId } : {}) }, data: { readAt: new Date() } });
    return this.unreadCount(userId);
  }

  /** GET /me/notification-preferences — every event type, with defaults filled in for missing rows. */
  async preferences(userId: string, workspaceId?: string) {
    const ws = await this.workspaceFor(userId, workspaceId);
    const [rows, user] = await Promise.all([
      this.prisma.notificationPreference.findMany({ where: { userId, workspaceId: ws } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } }),
    ]);
    return {
      workspaceId: ws,
      hasPhone: !!user.phone,
      data: Object.values(NotificationEvent).map((eventType) => {
        const row = rows.find((r) => r.eventType === eventType);
        const p = row ?? defaultPreference(eventType);
        return { eventType, label: EVENTS[eventType].label, email: p.email, sms: p.sms, push: p.push };
      }),
    };
  }

  /** PUT /me/notification-preferences — saves the rows sent; others keep their current value. */
  async savePreferences(userId: string, items: PreferenceDto[], workspaceId?: string) {
    const ws = await this.workspaceFor(userId, workspaceId);
    const seen = new Set<string>();
    for (const i of items) {
      if (seen.has(i.eventType)) throw Errors.validation({ eventType: `${i.eventType} is listed twice` });
      seen.add(i.eventType);
    }
    await this.prisma.tx(async (tx) => {
      for (const i of items) {
        const data = { email: i.email, sms: i.sms, push: i.push };
        await tx.notificationPreference.upsert({
          where: { userId_workspaceId_eventType: { userId, workspaceId: ws, eventType: i.eventType } },
          create: { userId, workspaceId: ws, eventType: i.eventType, ...data },
          update: data,
        });
      }
    });
    return this.preferences(userId, ws);
  }

  private async workspaceFor(userId: string, workspaceId?: string) {
    if (workspaceId) {
      const m = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!m) throw Errors.notFound('Workspace');
      return workspaceId;
    }
    const all = await this.prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true }, take: 2 });
    if (all.length === 1) return all[0].workspaceId;
    if (!all.length) throw Errors.notFound('Workspace');
    throw Errors.validation({ workspaceId: 'required: you belong to several workspaces' });
  }
}
