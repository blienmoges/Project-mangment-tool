/**
 * When deadline alerts are due (API Design, "Background jobs"; SRS FR-4.2–4.4, NFR-2), in the workspace's time zone:
 *  - reminder for "d days before": 09:00 on (due date − d)
 *  - first overdue alert: 00:00 on the day after the due date
 *  - repeats: 09:00 every following day while the task stays open
 *  - missed phase: 00:05 on the day after the phase's due date
 * Pure functions on "YYYY-MM-DD" dates and IANA time zones, so they can be tested alone.
 */

export const REMINDER_TIME = { h: 9, m: 0 };
export const OVERDUE_TIME = { h: 0, m: 0 };
export const REPEAT_TIME = { h: 9, m: 0 };
export const PHASE_TIME = { h: 0, m: 5 };
/** A reminder whose moment passed more than this long ago is no longer sent (it would be stale). */
export const REMINDER_GRACE_MS = 24 * 60 * 60 * 1000;

export function addDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The local date ("YYYY-MM-DD") of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** Offset of the time zone from UTC at an instant, in minutes (Addis Ababa: +180). */
function offsetMinutes(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** The instant when the clock in `timeZone` shows `isoDate` at h:m. */
export function zonedTime(isoDate: string, time: { h: number; m: number }, timeZone: string) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, time.h, time.m);
  // Two passes handle daylight-saving changes between the guess and the answer.
  let t = wall - offsetMinutes(new Date(wall), timeZone) * 60000;
  t = wall - offsetMinutes(new Date(t), timeZone) * 60000;
  return new Date(t);
}

export const reminderMoment = (due: string, daysBefore: number, tz: string) => zonedTime(addDays(due, -daysBefore), REMINDER_TIME, tz);
export const firstOverdueMoment = (due: string, tz: string) => zonedTime(addDays(due, 1), OVERDUE_TIME, tz);
export const phaseMoment = (due: string, tz: string) => zonedTime(addDays(due, 1), PHASE_TIME, tz);

/** The most recent overdue alert moment at or before `now`, or null if the task is not overdue yet. */
export function latestOverdueMoment(due: string, now: Date, tz: string): Date | null {
  const first = firstOverdueMoment(due, tz);
  if (now < first) return null;
  const today = localDate(now, tz);
  for (const day of [today, addDays(today, -1)]) {
    if (day < addDays(due, 2)) continue; // repeats start on the second day after the due date
    const m = zonedTime(day, REPEAT_TIME, tz);
    if (m <= now) return m;
  }
  return first;
}

/** The next overdue alert moment strictly after `after`. */
export function nextOverdueMoment(due: string, after: Date, tz: string): Date {
  const first = firstOverdueMoment(due, tz);
  if (after < first) return first;
  let day = localDate(after, tz);
  if (day < addDays(due, 2)) day = addDays(due, 2);
  let m = zonedTime(day, REPEAT_TIME, tz);
  if (m <= after) m = zonedTime(addDays(day, 1), REPEAT_TIME, tz);
  return m;
}

/** A reminder is still worth sending if its moment has come and is not more than a day old. */
export const reminderIsCurrent = (moment: Date, now: Date) => moment <= now && now.getTime() - moment.getTime() < REMINDER_GRACE_MS;
