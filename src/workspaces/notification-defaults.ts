import { NotificationEvent, Prisma } from '@prisma/client';
import { defaultPreference } from '../notifications/events';

/** Default notification settings for a new workspace member: email for everything, SMS only for urgent events. */
export function defaultPreferenceRows(workspaceId: string, userId: string): Prisma.NotificationPreferenceCreateManyInput[] {
  return Object.values(NotificationEvent).map((eventType) => ({ userId, workspaceId, eventType, ...defaultPreference(eventType) }));
}
