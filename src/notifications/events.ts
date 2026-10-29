import { DeliveryChannel, NotificationEvent as E } from '@prisma/client';

/**
 * Every notification type, with its label (used in email subjects and the settings screen) and its default channels.
 * SRS FR-4.5 and constraint 2.5: email for everything by default, SMS only for urgent events (overdue, Critical issues).
 */
export const EVENTS: Record<E, { label: string; sms: boolean }> = {
  assigned: { label: 'Task assigned to you', sms: false },
  reminder: { label: 'Deadline reminder', sms: false },
  overdue: { label: 'Task overdue', sms: true },
  issue: { label: 'Issue reported', sms: false },
  critical: { label: 'Critical issue', sms: true },
  resolved: { label: 'Issue resolved', sms: false },
  mention: { label: 'You were mentioned', sms: false },
  task_accepted: { label: 'Task accepted', sms: false },
  task_concern: { label: 'Concern flagged on a task', sms: false },
  review_requested: { label: 'Task awaiting your approval', sms: false },
  task_approved: { label: 'Task approved', sms: false },
  changes_requested: { label: 'Changes requested', sms: false },
  task_reopened: { label: 'Task reopened', sms: false },
  due_date_changed: { label: 'Due date changed', sms: false },
  ready_to_start: { label: 'Task ready to start', sms: false },
  phase_overdue: { label: 'Phase deadline missed', sms: false },
  added_to_project: { label: 'Added to a project', sms: false },
  made_manager: { label: 'You are now Project Manager', sms: false },
  project_moved: { label: 'Project moved', sms: false },
  member_removed: { label: 'Member removed', sms: false },
  sprint_started: { label: 'Sprint started', sms: false },
  automation: { label: 'Automation rule', sms: false },
};

export interface Preference {
  email: boolean;
  sms: boolean;
  push: boolean;
}

export const defaultPreference = (event: E): Preference => ({ email: true, sms: EVENTS[event].sms, push: false });

/**
 * Outside channels a person gets for an event (the in-app notification is always created).
 * A missing preference row means the defaults; SMS needs a phone number; push needs a browser that allowed it.
 */
export function channelsFor(event: E, pref: Preference | undefined, user: { phone: string | null; hasPush?: boolean }): DeliveryChannel[] {
  const p = pref ?? defaultPreference(event);
  const out: DeliveryChannel[] = [];
  if (p.email) out.push(DeliveryChannel.email);
  if (p.sms && user.phone) out.push(DeliveryChannel.sms);
  if (p.push && user.hasPush) out.push(DeliveryChannel.push);
  return out;
}
