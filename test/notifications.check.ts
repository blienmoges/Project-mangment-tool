/* Step-4 checks that need no database or Redis. Run: npx ts-node test/notifications.check.ts */
import { strict as assert } from 'node:assert';
import { NotificationEvent as E } from '@prisma/client';
import { latestOverdueMoment, localDate, nextOverdueMoment, phaseMoment, reminderIsCurrent, reminderMoment, zonedTime } from '../src/jobs/timing';
import { jobId } from '../src/jobs/queue.service';
import { channelsFor, defaultPreference, EVENTS } from '../src/notifications/events';
import { appLink, renderEmail, renderSms } from '../src/notifications/render';
import { afterCommit, PrismaService } from '../src/prisma/prisma.service';
import { defaultPreferenceRows } from '../src/workspaces/notification-defaults';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const A = 'Africa/Addis_Ababa';
const iso = (d: Date | null) => d?.toISOString() ?? null;

(async () => {
  await test('times are computed in the workspace time zone (Addis Ababa is UTC+3)', () => {
    assert.equal(iso(zonedTime('2027-02-11', { h: 9, m: 0 }, A)), '2027-02-11T06:00:00.000Z');
    assert.equal(localDate(new Date('2027-02-12T21:30:00Z'), A), '2027-02-13', 'already the next day in Addis');
  });
  await test('daylight-saving changes are handled (New York, March 2027)', () => {
    assert.equal(iso(zonedTime('2027-03-13', { h: 9, m: 0 }, 'America/New_York')), '2027-03-13T14:00:00.000Z');
    assert.equal(iso(zonedTime('2027-03-14', { h: 9, m: 0 }, 'America/New_York')), '2027-03-14T13:00:00.000Z');
  });
  await test('reminders at 09:00 on each reminder day; missed-phase check at 00:05 the next day', () => {
    assert.equal(iso(reminderMoment('2027-02-12', 2, A)), '2027-02-10T06:00:00.000Z');
    assert.equal(iso(reminderMoment('2027-02-12', 0, A)), '2027-02-12T06:00:00.000Z', '0 = on the due date');
    assert.equal(iso(phaseMoment('2027-02-12', A)), '2027-02-12T21:05:00.000Z');
  });
  await test('a reminder more than a day late is no longer sent', () => {
    const m = reminderMoment('2027-02-12', 2, A);
    assert.equal(reminderIsCurrent(m, new Date(m.getTime() - 1)), false, 'not yet');
    assert.equal(reminderIsCurrent(m, new Date(m.getTime() + 60_000)), true);
    assert.equal(reminderIsCurrent(m, new Date(m.getTime() + 25 * 3600_000)), false, 'stale');
  });
  await test('overdue: 00:00 the day after the due date, then 09:00 every following day', () => {
    const due = '2027-02-12';
    assert.equal(latestOverdueMoment(due, new Date('2027-02-12T20:59:00Z'), A), null, 'still the due date in Addis');
    assert.equal(iso(latestOverdueMoment(due, new Date('2027-02-12T21:00:00Z'), A)), '2027-02-12T21:00:00.000Z');
    assert.equal(iso(latestOverdueMoment(due, new Date('2027-02-13T07:00:00Z'), A)), '2027-02-12T21:00:00.000Z', 'no repeat on the first day');
    assert.equal(iso(latestOverdueMoment(due, new Date('2027-02-14T06:30:00Z'), A)), '2027-02-14T06:00:00.000Z');
    assert.equal(iso(nextOverdueMoment(due, new Date('2027-02-12T21:00:00Z'), A)), '2027-02-14T06:00:00.000Z');
    assert.equal(iso(nextOverdueMoment(due, new Date('2027-02-14T06:00:00Z'), A)), '2027-02-15T06:00:00.000Z');
  });
  await test('default channels: email for every event, SMS only for overdue and Critical issues (FR-4.5)', () => {
    const sms = Object.values(E).filter((e) => defaultPreference(e).sms);
    assert.deepEqual(sms.sort(), [E.critical, E.overdue]);
    assert.ok(Object.values(E).every((e) => EVENTS[e].label), 'every event has a label');
    assert.equal(defaultPreferenceRows('w', 'u').length, Object.values(E).length);
  });
  await test('SMS needs a phone number; settings override the defaults', () => {
    assert.deepEqual(channelsFor(E.overdue, undefined, { phone: '+251911000101' }), ['email', 'sms']);
    assert.deepEqual(channelsFor(E.overdue, undefined, { phone: null }), ['email']);
    assert.deepEqual(channelsFor(E.assigned, { email: false, sms: true, push: true }, { phone: '+251911000101' }), ['sms']);
  });
  await test('messages: links into the app, escaped HTML, SMS kept short', () => {
    const link = appLink('https://app.example.com', 'task', 't1');
    assert.equal(link, 'https://app.example.com/tasks/t1');
    const email = renderEmail({ eventType: E.overdue, body: 'MBA-9 <script> is overdue' }, link, 'Meron', 'Acme Software');
    assert.ok(email.subject.startsWith('Task overdue: '));
    assert.ok(email.html.includes('&lt;script&gt;') && !email.html.includes('<script>'));
    const sms = renderSms({ body: 'x'.repeat(500) }, link);
    assert.ok(sms.length <= 300 && sms.endsWith(link));
  });
  await test('job ids never contain ":" (BullMQ rule)', () => {
    assert.equal(jobId('rem', 'abc', 2, '2027-02-12'), 'rem_abc_2_2027-02-12');
  });
  await test('afterCommit hooks run after a commit, never after a rollback', async () => {
    const ran: string[] = [];
    const fake = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as PrismaService;
    const tx = PrismaService.prototype.tx.bind(fake);
    await tx(async () => { afterCommit(() => { ran.push('committed'); }); ran.push('inside'); });
    assert.deepEqual(ran, ['inside', 'committed']);
    await assert.rejects(tx(async () => { afterCommit(() => { ran.push('rolled back'); }); throw new Error('boom'); }));
    assert.ok(!ran.includes('rolled back'));
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
