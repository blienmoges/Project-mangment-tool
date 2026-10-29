import { NotificationEvent } from '@prisma/client';
import { EVENTS } from './events';

const SMS_MAX = 300; // about two SMS segments
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Where a notification's link opens in the web app. */
export function appLink(origin: string, linkType: string | null, linkId: string | null) {
  if (!linkType || !linkId) return `${origin}/notifications`;
  const paths: Record<string, string> = { task: 'tasks', project: 'projects', issue: 'issues', phase: 'projects' };
  return `${origin}/${paths[linkType] ?? linkType}/${linkId}`;
}

export function renderEmail(n: { eventType: NotificationEvent; body: string }, link: string, recipientName: string, workspaceName: string) {
  const label = EVENTS[n.eventType].label;
  const subject = `${label}: ${n.body.length > 70 ? `${n.body.slice(0, 67)}...` : n.body}`;
  const text = `Hello ${recipientName},\n\n${n.body}\n\nOpen it: ${link}\n\n${workspaceName} · You can change which emails you get in Settings → Notifications.`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px">
<p>Hello ${esc(recipientName)},</p><p>${esc(n.body)}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open in ${esc(workspaceName)}</a></p>
<p style="color:#6b7280;font-size:13px">You can change which emails you get in Settings → Notifications.</p></div>`;
  return { subject, text, html };
}

/** Short and self-contained: SMS is for urgent events only. */
export function renderSms(n: { body: string }, link: string) {
  const suffix = ` ${link}`;
  const room = SMS_MAX - suffix.length;
  const body = n.body.length > room ? `${n.body.slice(0, room - 3)}...` : n.body;
  return `${body}${suffix}`;
}
