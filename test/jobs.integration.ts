/*
 * Step-4 integration checks against a real Redis (BullMQ) and a real WebSocket server; the database is an in-memory
 * stand-in. Needs Redis; uses TEST_REDIS_URL (default redis://localhost:6379/15), which it empties. Run: npm run test:integration
 */
import { strict as assert } from 'node:assert';
import { NotificationEvent as E, ProjectRole } from '@prisma/client';
import { Job } from 'bullmq';
import IORedis from 'ioredis';
import { WebSocket } from 'ws';
import { DeadlinesService } from '../src/jobs/deadlines.service';
import { QueueService } from '../src/jobs/queue.service';
import { addDays, localDate, zonedTime } from '../src/jobs/timing';
import { DeliveryService } from '../src/notifications/delivery.service';
import { NotifyInput, NotificationsService } from '../src/notifications/notifications.service';
import { RealtimeService } from '../src/realtime/realtime.service';

// Database 15, so the flush below never touches the development server's jobs (database 0).
const REDIS = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
const A = 'Africa/Addis_Ababa';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const config = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as never;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ───────────── in-memory database for DeadlinesService ─────────────
type T = { id: string; number: number; title: string; dueDate: Date | null; assigneeId: string | null; completedAt: Date | null; overdueNotifiedAt: Date | null; projectId: string; phaseId: string | null };
function fakeDb() {
  const workspace = { id: 'w1', timezone: A, reminderDays: [2, 1] };
  const project = { id: 'p1', keyPrefix: 'MBA', archivedAt: null as Date | null, workspaceId: 'w1', space: { archivedAt: null }, members: [{ userId: 'blien', role: ProjectRole.project_manager }] };
  const tasks: T[] = [];
  const reminders: { taskId: string; daysBefore: number }[] = [];
  const phases: { id: string; name: string; dueDate: Date | null; overdueNotifiedAt: Date | null; projectId: string }[] = [];
  const full = (t: T) => ({ ...t, workspaceId: 'w1', workspace, project: { ...project, workspace, members: project.members.filter((m) => m.role === ProjectRole.project_manager) }, reminders: reminders.filter((r) => r.taskId === t.id) });
  const isOpen = (t: T) => !t.completedAt && !project.archivedAt;
  const dateMatch = (d: Date | null, w: any) => {
    if (w === undefined) return true;
    if (w instanceof Date) return !!d && d.getTime() === w.getTime();
    if (w?.not === null) return d !== null;
    if (!d) return false;
    return (!w.gte || d >= w.gte) && (!w.lte || d <= w.lte) && (!w.lt || d < w.lt);
  };
  const taskMatch = (t: T, w: any) =>
    (!w.id || t.id === w.id) && (w.completedAt !== null || isOpen(t)) && (w.assigneeId?.not !== null || t.assigneeId !== null) &&
    (w.phaseId === undefined || t.phaseId === w.phaseId) && dateMatch(t.dueDate, w.dueDate) &&
    (!w.OR || w.OR.some((o: any) => (o.overdueNotifiedAt === null ? t.overdueNotifiedAt === null : !!t.overdueNotifiedAt && t.overdueNotifiedAt < o.overdueNotifiedAt.lt)));
  const db: any = {
    workspace: { findMany: async () => [workspace], findUnique: async () => workspace },
    task: {
      findUnique: async ({ where }: any) => { const t = tasks.find((x) => x.id === where.id); return t ? full(t) : null; },
      findFirst: async ({ where }: any) => { const t = tasks.find((x) => taskMatch(x, where)); return t ? full(t) : null; },
      findMany: async ({ where }: any) => tasks.filter((t) => taskMatch(t, where)).map(full),
      count: async ({ where }: any) => tasks.filter((t) => taskMatch(t, where)).length,
      updateMany: async ({ where, data }: any) => { const rows = tasks.filter((t) => taskMatch(t, where)); rows.forEach((t) => Object.assign(t, data)); return { count: rows.length }; },
    },
    taskReminder: {
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const r of data) if (!reminders.some((x) => x.taskId === r.taskId && x.daysBefore === r.daysBefore)) { reminders.push(r); count++; }
        return { count };
      },
    },
    phase: {
      findUnique: async ({ where }: any) => { const p = phases.find((x) => x.id === where.id); return p ? { ...p, project: { ...project, workspace, members: project.members } } : null; },
      findMany: async ({ where }: any) => phases.filter((p) => p.overdueNotifiedAt === null && dateMatch(p.dueDate, where.dueDate)),
      updateMany: async ({ where, data }: any) => { const rows = phases.filter((p) => p.id === where.id && p.overdueNotifiedAt === null); rows.forEach((p) => Object.assign(p, data)); return { count: rows.length }; },
    },
    notificationDelivery: { findMany: async () => [] },
    invitation: { deleteMany: async () => ({ count: 0 }) },
  };
  db.tx = (fn: any) => fn(db);
  return { db, tasks, reminders, phases, project };
}

(async () => {
  const redis = new IORedis(REDIS);
  await redis.flushdb();

  // ── 1. The real queue layer ──
  const queues = new QueueService(config({ REDIS_URL: REDIS }));
  const seen: Job[] = [];
  const attemptsDuringRun: number[] = [];
  let failuresLeft = 2;
  queues.process('deadlines', async (job) => { seen.push(job); });
  queues.process('notifications', async (job) => {
    if (job.name === 'flaky') attemptsDuringRun.push(job.attemptsMade);
    if (job.name === 'flaky' && failuresLeft-- > 0) throw new Error('provider down');
    seen.push(job);
  });
  queues.onApplicationBootstrap();
  const dq = (queues as any).queues.get('deadlines');

  await test('delayed jobs wait, and a repeated job id is only queued once', async () => {
    assert.equal(await queues.add('deadlines', 'reminder', { n: 1 }, { jobId: 'rem_x_2_2027-01-01', delay: 60_000 }), true);
    await queues.add('deadlines', 'reminder', { n: 2 }, { jobId: 'rem_x_2_2027-01-01', delay: 60_000 });
    const delayed = await dq.getDelayed();
    assert.equal(delayed.length, 1);
    assert.deepEqual(delayed[0].data, { n: 1 });
  });
  await test('pending jobs can be removed by id', async () => {
    await queues.remove('deadlines', 'rem_x_2_2027-01-01');
    assert.equal((await dq.getDelayed()).length, 0);
  });
  await test('a job fires when its moment comes', async () => {
    await queues.add('deadlines', 'overdue', { taskId: 't' }, { jobId: 'ovd_t_1', delay: 300 });
    await sleep(1500);
    assert.ok(seen.some((j) => j.id === 'ovd_t_1'));
  });
  await test('failed sends are retried with growing waits', async () => {
    await queues.add('notifications', 'flaky', {}, { jobId: 'del_flaky', attempts: 4, backoff: { type: 'exponential', delay: 100 } });
    await sleep(2500);
    assert.ok(seen.some((j) => j.id === 'del_flaky'), 'succeeded in the end');
    // DeliveryService treats attemptsMade + 1 >= attempts as the last try; attemptsMade counts earlier failures.
    assert.deepEqual(attemptsDuringRun, [0, 1, 2]);
  });
  await test('the safety sweep is registered once, however often the app starts', async () => {
    await queues.every('deadlines', 'safety-sweep', 15 * 60_000, 'sweep');
    await queues.every('deadlines', 'safety-sweep', 15 * 60_000, 'sweep');
    assert.equal((await dq.getJobSchedulers()).length, 1);
  });
  await test('adding a job never hangs the API when Redis is unreachable', async () => {
    const dead = new QueueService(config({ REDIS_URL: 'redis://127.0.0.1:6390' }));
    const t0 = Date.now();
    assert.equal(await dead.add('deadlines', 'reminder', {}, { jobId: 'x' }), false);
    assert.ok(Date.now() - t0 < 3000);
    await dead.onModuleDestroy();
  });

  // ── 2. Deadline alerts, end to end over the in-memory database ──
  const { db, tasks, reminders, phases, project } = fakeDb();
  const sent: NotifyInput[] = [];
  const notifications = { notify: async (_tx: unknown, n: NotifyInput) => { sent.push(n); return []; } } as unknown as NotificationsService;
  const deadlines = new DeadlinesService(db, queues, notifications, {} as DeliveryService);
  const now = new Date();
  const today = localDate(now, A);
  const base = { title: 'Overdue alert scheduler', completedAt: null, overdueNotifiedAt: null, projectId: 'p1', phaseId: null };

  await test('scheduling a task queues its reminders and first overdue alert at the exact moments', async () => {
    await redis.flushdb();
    const due = addDays(today, 5);
    tasks.push({ ...base, id: 't1', number: 9, dueDate: day(due), assigneeId: 'meron' });
    await deadlines.scheduleTask('t1');
    const jobs = (await dq.getDelayed()).map((j: Job) => ({ id: j.id, at: j.timestamp + (j.opts.delay ?? 0) }));
    const at = (id: string) => jobs.find((j: { id: string }) => j.id === id)?.at;
    assert.equal(jobs.length, 3);
    assert.ok(Math.abs(at(`rem_t1_2_${due}`)! - zonedTime(addDays(due, -2), { h: 9, m: 0 }, A).getTime()) < 2000);
    assert.ok(Math.abs(at(`rem_t1_1_${due}`)! - zonedTime(addDays(due, -1), { h: 9, m: 0 }, A).getTime()) < 2000);
    assert.ok(jobs.some((j: { id: string }) => j.id.startsWith(`ovd_t1_${due}_`)));
  });
  await test('a new due date removes the old jobs and schedules new ones', async () => {
    const old = addDays(today, 5);
    const due = addDays(today, 8);
    tasks[0].dueDate = day(due);
    await deadlines.scheduleTask('t1', old);
    const ids = (await dq.getDelayed()).map((j: Job) => j.id);
    assert.ok(ids.every((id: string) => id.includes(due)), `only new-date jobs remain: ${ids}`);
  });
  await test('overdue: assignee and PM are alerted once; the sweep does not repeat it the same day', async () => {
    await redis.flushdb();
    const due = addDays(today, -3);
    tasks.push({ ...base, id: 't2', number: 10, dueDate: day(due), assigneeId: 'meron' });
    const at = zonedTime(today, { h: 10, m: 0 }, A); // 10:00 today in Addis: today's 09:00 repeat is due
    const counts = await deadlines.sweep(at);
    assert.equal(counts.overdue, 1);
    const alert = sent.find((n) => n.eventType === E.overdue)!;
    assert.deepEqual(alert.userIds, ['meron', 'blien']);
    assert.match(alert.body, /MBA-10 .* is overdue: it was due on .* \(3 days ago\)/);
    assert.equal(alert.triggeredAt!.toISOString(), zonedTime(today, { h: 9, m: 0 }, A).toISOString());
    assert.equal((await deadlines.sweep(at)).overdue, 0, 'already sent');
    assert.equal(await deadlines.runOverdue('t2', due, at), false, 'the exact-time job finds it claimed too');
    const next = (await dq.getDelayed()).find((j: Job) => j.id!.startsWith('ovd_t2_'));
    assert.ok(Math.abs(next.timestamp + next.opts.delay - zonedTime(addDays(today, 1), { h: 9, m: 0 }, A).getTime()) < 1000, 'next repeat tomorrow 09:00');
  });
  await test('the daily repeat goes out the next morning (FR-4.4)', async () => {
    const before = sent.length;
    const tomorrow = zonedTime(addDays(today, 1), { h: 9, m: 1 }, A);
    assert.equal(await deadlines.runOverdue('t2', addDays(today, -3), tomorrow), true);
    assert.equal(sent.length, before + 1);
  });
  await test('reminders: sent once at 09:00 on the reminder day, not when stale, not for unassigned tasks', async () => {
    const due = addDays(today, 1);
    tasks.push({ ...base, id: 't3', number: 11, title: 'Login screen', dueDate: day(due), assigneeId: 'yonas' });
    tasks.push({ ...base, id: 't4', number: 12, title: 'Unassigned', dueDate: day(due), assigneeId: null });
    const at = zonedTime(today, { h: 9, m: 3 }, A);
    assert.equal((await deadlines.sweep(at)).reminders, 1);
    const r = sent.find((n) => n.eventType === E.reminder)!;
    assert.deepEqual(r.userIds, ['yonas']);
    assert.match(r.body, /MBA-11 Login screen is due tomorrow/);
    assert.equal((await deadlines.sweep(at)).reminders, 0, 'claimed');
    assert.equal(await deadlines.runReminder('t3', 1, due, new Date(at.getTime() + 26 * 3600_000)), false, 'stale');
    assert.deepEqual(reminders, [{ taskId: 't3', daysBefore: 1 }]);
  });
  await test('finished tasks and archived projects get no alerts; old due dates are ignored', async () => {
    tasks.push({ ...base, id: 't5', number: 13, dueDate: day(addDays(today, -2)), assigneeId: 'sara', completedAt: new Date() });
    const at = zonedTime(today, { h: 10, m: 0 }, A);
    assert.equal(await deadlines.runOverdue('t5', addDays(today, -2), at), false);
    assert.equal(await deadlines.runOverdue('t2', addDays(today, -9), at), false, 'job from an old due date');
    project.archivedAt = new Date();
    assert.equal((await deadlines.sweep(new Date(at.getTime() + 2 * 86_400_000))).overdue, 0);
    project.archivedAt = null;
  });
  await test('missed phase: the PM is told once, only while tasks are unfinished', async () => {
    phases.push({ id: 'ph1', name: 'Backend API', dueDate: day(addDays(today, -2)), overdueNotifiedAt: null, projectId: 'p1' });
    tasks.push({ ...base, id: 't6', number: 14, dueDate: null, assigneeId: 'dawit', phaseId: 'ph1' });
    const at = zonedTime(today, { h: 0, m: 10 }, A);
    assert.equal((await deadlines.sweep(at)).phases, 1);
    const p = sent.find((n) => n.eventType === E.phase_overdue)!;
    assert.deepEqual(p.userIds, ['blien']);
    assert.match(p.body, /Phase "Backend API" of MBA .* still has 1 unfinished task\./);
    assert.equal((await deadlines.sweep(at)).phases, 0);
  });

  // ── 3. Email / SMS delivery bookkeeping ──
  await test('a failed send is retried; the last failure is recorded as failed', async () => {
    const rows: Record<string, any> = { d1: { id: 'd1', status: 'queued', channel: 'sms', notification: { eventType: E.overdue, body: 'MBA-10 is overdue', linkType: 'task', linkId: 't2', user: { fullName: 'Meron', email: 'm@x', phone: '+251911000101' }, workspace: { name: 'Acme' } } } };
    const prisma = { notificationDelivery: { findUnique: async ({ where }: any) => rows[where.id] ?? null, update: async ({ where, data }: any) => Object.assign(rows[where.id], data) } };
    const svc = new DeliveryService(prisma as never, queues, config({ NODE_ENV: 'development' }), {} as never);
    (svc as any).sms = { name: 'broken', send: async () => { throw new Error('gateway timeout'); } };
    await assert.rejects(svc.send('d1', false));
    assert.equal(rows.d1.status, 'queued');
    assert.equal(rows.d1.error, 'gateway timeout');
    await assert.rejects(svc.send('d1', true));
    assert.equal(rows.d1.status, 'failed');
    rows.d2 = { ...rows.d1, id: 'd2', status: 'queued', error: null };
    (svc as any).sms = { name: 'ok', send: async (m: { text: string }) => { assert.ok(m.text.endsWith('/tasks/t2')); return { providerMessageId: 'SM123' }; } };
    await svc.send('d2', false);
    assert.equal(rows.d2.status, 'sent');
    assert.equal(rows.d2.providerMessageId, 'SM123');
  });

  // ── 4. Notifications: channels per person, live push after commit ──
  await test('notify: in-app for everyone, email/SMS by settings, actor and ex-members left out, pushed live', async () => {
    const created: any[] = [];
    const deliveries: any[] = [];
    const tx: any = {
      workspaceMember: { findMany: async ({ where }: any) => [{ userId: 'meron', user: { id: 'meron', phone: '+251911000101' } }, { userId: 'blien', user: { id: 'blien', phone: null } }].filter((m) => where.userId.in.includes(m.userId)) },
      notificationPreference: { findMany: async () => [{ userId: 'blien', email: false, sms: true, push: false }] },
      notification: { createManyAndReturn: async ({ data }: any) => data.map((d: any, i: number) => { const n = { id: `n${i}`, readAt: null, createdAt: new Date(), ...d }; created.push(n); return n; }) },
      notificationDelivery: { createManyAndReturn: async ({ data }: any) => data.map((d: any, i: number) => { deliveries.push(d); return { id: `del${i}` }; }) },
    };
    const realtime = new RealtimeService();
    const pushed: any[] = [];
    realtime.emitToUser = ((userId: string, event: string, data: unknown) => { pushed.push({ userId, event, data }); return 1; }) as never;
    (realtime as any).connectionCount = () => 1;
    const dispatched: string[] = [];
    const prisma = { notification: { findUnique: async ({ where }: any) => created.find((n) => n.id === where.id), count: async () => 4 } };
    const svc = new NotificationsService(prisma as never, realtime, { dispatch: async (id: string) => { dispatched.push(id); } } as never);
    const { PrismaService } = await import('../src/prisma/prisma.service');
    const run = PrismaService.prototype.tx.bind({ $transaction: (fn: any) => fn(tx) } as never);
    await run((t) => svc.notify(t, { workspaceId: 'w1', eventType: E.overdue, userIds: ['meron', 'blien', 'abel', 'left-workspace', null], actorId: 'abel', body: 'MBA-10 is overdue' }));
    assert.deepEqual(created.map((n) => n.userId), ['meron', 'blien'], 'actor and former members skipped');
    assert.deepEqual(deliveries.map((d) => d.channel), ['email', 'sms'], 'Meron: defaults (email + SMS for overdue); Blien: SMS chosen but no phone, email off');
    assert.deepEqual(pushed.map((p) => [p.userId, p.event, p.data.unreadCount]), [['meron', 'notification.created', 4], ['blien', 'notification.created', 4]]);
    assert.deepEqual(dispatched, ['del0', 'del1'], 'queued after the commit');
  });

  // ── 5. The WebSocket endpoint ──
  await test('WebSocket /ws: token required, notification pushed to the right person, ping answered', async () => {
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(40);
    process.env.JOBS_ENABLED = 'false';
    const { PrismaService } = await import('../src/prisma/prisma.service');
    PrismaService.prototype.onModuleInit = async () => {};
    PrismaService.prototype.onModuleDestroy = async () => {};
    const { NestFactory } = await import('@nestjs/core');
    const { WsAdapter } = await import('@nestjs/platform-ws');
    const { JwtService } = await import('@nestjs/jwt');
    const { AppModule } = await import('../src/app.module');
    const app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const port = (app.getHttpServer().address() as { port: number }).port;
    const token = await app.get(JwtService).signAsync({ sub: 'meron' }, { expiresIn: 60 });

    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws?token=nope`);
    const badClose = await new Promise<number>((r) => bad.on('close', (code) => r(code)));
    assert.equal(badClose, 4401);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    await new Promise((r) => ws.on('open', r));
    await sleep(200);
    assert.deepEqual(messages[0], { event: 'ready', data: { userId: 'meron' } });
    const realtime = app.get(RealtimeService);
    assert.equal(realtime.emitToUser('blien', 'notification.created', {}), 0, 'not for someone else');
    assert.equal(realtime.emitToUser('meron', 'notification.created', { unreadCount: 1 }), 1);
    ws.send(JSON.stringify({ event: 'ping' }));
    await sleep(200);
    assert.deepEqual(messages[1], { event: 'notification.created', data: { unreadCount: 1 } });
    assert.equal(messages[2].event, 'pong');
    ws.close();
    await app.close();
  });

  await queues.onModuleDestroy();
  await redis.flushdb();
  redis.disconnect();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
