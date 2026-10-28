import { NotificationEvent, Prisma } from '@prisma/client';

/** Default notification settings for a new workspace member: email for everything, SMS only for urgent events. */
export function defaultPreferenceRows(workspaceId: string, userId: string): Prisma.NotificationPreferenceCreateManyInput[] {
  return Object.values(NotificationEvent).map((eventType) => ({
    userId,
    workspaceId,
    eventType,
    email: true,
    sms: eventType === NotificationEvent.overdue || eventType === NotificationEvent.critical,
    push: false,
  }));
}

