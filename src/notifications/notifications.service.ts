import { Injectable } from '@nestjs/common';
import { NotificationEvent, Prisma } from '@prisma/client';
import { afterCommit } from '../prisma/prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { DeliveryService } from './delivery.service';
import { channelsFor } from './events';

type Tx = Prisma.TransactionClient;

export interface NotifyInput {
  workspaceId: string;
  eventType: NotificationEvent;
  /** Duplicates, nulls and the actor are dropped; people no longer in the workspace are skipped. */
  userIds: (string | null | undefined)[];
  actorId?: string | null;
  body: string;
  link?: { type: 'task' | 'project' | 'issue'; id: string };
  /** When the alert was due (reminders, overdue); defaults to now. Used to measure NFR-2. */
  triggeredAt?: Date;
}

/** Task events raised by the tasks module (step 3 call sites). */
export type TaskEventKind =
  | 'task_assigned' | 'task_accepted' | 'task_concern' | 'task_submitted' | 'task_approved'
  | 'changes_requested' | 'task_reopened' | 'due_date_changed' | 'dependency_done';

export interface TaskEvent {
  kind: TaskEventKind;
  workspaceId: string;
  actorId: string;
  recipientIds: (string | null | undefined)[];
  task: { id: string; shortId: string; title: string };
  note?: string;
  /** For due_date_changed: the new date ("YYYY-MM-DD") or null when it was removed. */
  dueDate?: string | null;
}

const EVENT_FOR: Record<TaskEventKind, NotificationEvent> = {
  task_assigned: NotificationEvent.assigned,
  task_accepted: NotificationEvent.task_accepted,
  task_concern: NotificationEvent.task_concern,
  task_submitted: NotificationEvent.review_requested,
  task_approved: NotificationEvent.task_approved,
  changes_requested: NotificationEvent.changes_requested,
  task_reopened: NotificationEvent.task_reopened,
  due_date_changed: NotificationEvent.due_date_changed,
  dependency_done: NotificationEvent.ready_to_start,
};

export const formatDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Creates notifications (SRS 3.4): the in-app notification always, plus one delivery row per outside channel the
 * person chose (email, SMS). After the transaction commits, the person's open app gets "notification.created" over
 * the WebSocket and the deliveries are queued for sending.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly delivery: DeliveryService,
  ) {}

  async notify(tx: Tx, input: NotifyInput) {
    const ids = [...new Set(input.userIds.filter((id): id is string => !!id && id !== input.actorId))];
    if (!ids.length) return [];
    const [members, prefs] = await Promise.all([
      tx.workspaceMember.findMany({ where: { workspaceId: input.workspaceId, userId: { in: ids } }, include: { user: { select: { id: true, phone: true, _count: { select: { pushSubscriptions: true } } } } } }),
      tx.notificationPreference.findMany({ where: { workspaceId: input.workspaceId, eventType: input.eventType, userId: { in: ids } } }),
    ]);
    if (!members.length) return [];
    const triggeredAt = input.triggeredAt ?? new Date();
    const created = await tx.notification.createManyAndReturn({
      data: members.map((m) => ({
        workspaceId: input.workspaceId, userId: m.userId, eventType: input.eventType, body: input.body,
        linkType: input.link?.type ?? null, linkId: input.link?.id ?? null, triggeredAt,
      })),
    });
    const deliveries = created.flatMap((n) => {
      const member = members.find((m) => m.userId === n.userId)!;
      return channelsFor(input.eventType, prefs.find((p) => p.userId === n.userId), { phone: member.user.phone, hasPush: (member.user._count?.pushSubscriptions ?? 0) > 0 }).map((channel) => ({ notificationId: n.id, channel }));
    });
    const rows = deliveries.length ? await tx.notificationDelivery.createManyAndReturn({ data: deliveries, select: { id: true } }) : [];
    afterCommit(() => this.publish(created, rows.map((r) => r.id)));
    return created.map((n) => n.id);
  }

  /** Task events from the tasks module, turned into notifications with readable text. */
  async taskEvent(tx: Tx, e: TaskEvent) {
    const actor = await tx.user.findUnique({ where: { id: e.actorId }, select: { fullName: true } });
    const who = actor?.fullName ?? 'Someone';
    const t = `${e.task.shortId} ${e.task.title}`;
    const note = e.note ? `: "${e.note}"` : '.';
    const text: Record<TaskEventKind, string> = {
      task_assigned: `${who} assigned you ${t}. Please accept it or flag a concern.`,
      task_accepted: `${who} accepted ${t}.`,
      task_concern: `${who} flagged a concern on ${t}${note}`,
      task_submitted: `${who} submitted ${t} for your approval.`,
      task_approved: `${who} approved ${t}. It is done.`,
      changes_requested: `${who} requested changes on ${t}${note}`,
      task_reopened: `${who} reopened ${t}.`,
      due_date_changed: e.dueDate ? `${who} changed the due date of ${t} to ${formatDay(e.dueDate)}.` : `${who} removed the due date of ${t}.`,
      dependency_done: `${t} can start now: the tasks it was waiting for are done.`,
    };
    return this.notify(tx, {
      workspaceId: e.workspaceId, eventType: EVENT_FOR[e.kind], userIds: e.recipientIds,
      actorId: e.kind === 'dependency_done' ? null : e.actorId, body: text[e.kind], link: { type: 'task', id: e.task.id },
    });
  }

  /** After commit: live update for each person, then queue the email / SMS deliveries. */
  private async publish(created: { id: string; userId: string; workspaceId: string }[], deliveryIds: string[]) {
    for (const n of created) {
      if (!this.realtime.connectionCount()) break;
      const [notification, unreadCount] = await Promise.all([
        this.prisma.notification.findUnique({ where: { id: n.id } }),
        this.prisma.notification.count({ where: { userId: n.userId, readAt: null } }),
      ]);
      if (notification) this.realtime.emitToUser(n.userId, 'notification.created', { notification: toApi(notification), unreadCount });
    }
    for (const id of deliveryIds) await this.delivery.dispatch(id);
  }
}

/** The notification as the API returns it. */
export function toApi(n: { id: string; workspaceId: string; eventType: NotificationEvent; body: string; linkType: string | null; linkId: string | null; triggeredAt: Date; readAt: Date | null; createdAt: Date }) {
  return {
    id: n.id, workspaceId: n.workspaceId, eventType: n.eventType, body: n.body,
    link: n.linkType && n.linkId ? { type: n.linkType, id: n.linkId } : null,
    triggeredAt: n.triggeredAt, readAt: n.readAt, createdAt: n.createdAt,
  };
}
