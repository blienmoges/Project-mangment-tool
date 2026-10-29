/* Step-5 checks (sprints and issues) that need no database. Run: npx ts-node test/sprints-issues.check.ts */
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { IssueStatus as S } from '@prisma/client';
import { AppException } from '../src/common/app-exception';
import { validationExceptionFactory } from '../src/common/validation';
import { AssignIssueDto, CreateIssueDto, IssueListQuery } from '../src/issues/dto/issue.dto';
import { checkIssueMove } from '../src/issues/issue-rules';
import { IssuesService } from '../src/issues/issues.service';
import { CompleteSprintDto, CreateSprintDto } from '../src/sprints/dto/sprint.dto';
import { burndown, capacityStatus, defaultEndDate, isoWeekday, personCapacityHours, workingDaysIn } from '../src/sprints/sprint-math';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const code = (e: AppException | null) => (e ? e.body.code : 'ok');

(async () => {
  // ── sprints ──
  await test('a sprint lasts two weeks by default (Monday → the Sunday 13 days later)', () => {
    assert.equal(isoWeekday('2027-02-01'), 1, '1 Feb 2027 is a Monday');
    assert.equal(defaultEndDate('2027-02-01'), '2027-02-14');
    assert.equal(isoWeekday('2027-02-14'), 7);
  });
  await test('working days in a sprint follow the workspace setting', () => {
    assert.equal(workingDaysIn('2027-02-01', '2027-02-14', [1, 2, 3, 4, 5]), 10);
    assert.equal(workingDaysIn('2027-02-01', '2027-02-14', [1, 2, 3, 4, 5, 6]), 12);
  });
  await test('burndown: points left at the end of each day, ideal line from total to 0, future days empty', () => {
    const chart = burndown('2027-02-01', '2027-02-05', '2027-02-03', [
      { points: 5, doneOn: '2027-02-01' },
      { points: 3, doneOn: '2027-02-03' },
      { points: 8, doneOn: null },
      { points: 2, doneOn: '2027-01-30' }, // done before the sprint started
    ]);
    assert.equal(chart.totalPoints, 18);
    assert.deepEqual(chart.days.map((d) => d.remaining), [11, 11, 8, null, null]);
    assert.deepEqual(chart.days.map((d) => d.ideal), [18, 13.5, 9, 4.5, 0]);
  });
  await test('capacity: one person, other projects subtracted, status over / near / ok', () => {
    assert.equal(personCapacityHours(40, 10, 5, 0), 80, '40 h a week × 2 weeks');
    assert.equal(personCapacityHours(40, 10, 5, 12), 68, 'minus work due in other projects');
    assert.equal(personCapacityHours(20, 10, 5, 60), 0, 'never below zero');
    assert.equal(capacityStatus(31, 30), 'over');
    assert.equal(capacityStatus(27, 30), 'near');
    assert.equal(capacityStatus(26, 30), 'ok');
  });

  // ── issues ──
  const pm = { isManager: true, isReporter: false, isFixer: false };
  const reporter = { isManager: false, isReporter: true, isFixer: false };
  const fixer = { isManager: false, isReporter: false, isFixer: true };
  const other = { isManager: false, isReporter: false, isFixer: false };
  await test('the fixer and the reporter move an issue along; only the PM closes or reopens a closed one', () => {
    assert.equal(code(checkIssueMove(S.open, S.in_progress, fixer)), 'ok');
    assert.equal(code(checkIssueMove(S.in_progress, S.resolved, fixer)), 'ok');
    assert.equal(code(checkIssueMove(S.resolved, S.open, reporter)), 'ok', 'reporter: still broken');
    assert.equal(code(checkIssueMove(S.resolved, S.closed, fixer)), 'FORBIDDEN');
    assert.equal(code(checkIssueMove(S.resolved, S.closed, pm)), 'ok');
    assert.equal(code(checkIssueMove(S.closed, S.open, reporter)), 'FORBIDDEN');
    assert.equal(code(checkIssueMove(S.closed, S.open, pm)), 'ok');
  });
  await test('other members cannot move issues; a closed issue only goes back to open', () => {
    assert.equal(code(checkIssueMove(S.open, S.in_progress, other)), 'FORBIDDEN');
    assert.equal(code(checkIssueMove(S.closed, S.resolved, pm)), 'INVALID_STATUS_CHANGE');
  });

  // ── validation ──
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory });
  const fields = (body: object, metatype: new () => object, type: 'body' | 'query' = 'body') =>
    pipe.transform(body, { type, metatype }).then(() => ({})).catch((e: AppException) => e.body.fields ?? {});
  await test('complete a sprint: moveUnfinishedTo is "backlog" or a sprint id, and is required', async () => {
    assert.deepEqual(await fields({ moveUnfinishedTo: 'backlog' }, CompleteSprintDto), {});
    assert.deepEqual(await fields({ moveUnfinishedTo: '0b6f7f6e-1d1f-4c55-9c38-2c1f7c3c1a11' }, CompleteSprintDto), {});
    assert.ok('moveUnfinishedTo' in (await fields({ moveUnfinishedTo: 'next' }, CompleteSprintDto)));
    assert.ok('moveUnfinishedTo' in (await fields({}, CompleteSprintDto)));
    assert.ok('endDate' in (await fields({ name: 'S3', endDate: '14/02/2027' }, CreateSprintDto)));
  });
  await test('report an issue: type and severity are required and checked', async () => {
    const ok = { title: 'Login fails on Android 14', type: 'bug', severity: 'critical', device: 'Samsung A54', operatingSystem: 'Android 14' };
    assert.deepEqual(await fields(ok, CreateIssueDto), {});
    assert.deepEqual(Object.keys(await fields({ title: 'x', type: 'crash', severity: 'urgent' }, CreateIssueDto)).sort(), ['severity', 'type']);
    assert.deepEqual(await fields({ userId: null }, AssignIssueDto), {});
    assert.deepEqual(await fields({ status: 'unresolved', assigneeId: 'me', severity: 'critical' }, IssueListQuery, 'query'), {});
    assert.ok('status' in (await fields({ status: 'fixed' }, IssueListQuery, 'query')));
  });

  // ── who is notified about an issue (FR-6.3, acceptance criterion 9) ──
  const members = [
    { userId: 'blien', role: 'project_manager' }, { userId: 'dawit', role: 'team_member' },
    { userId: 'yonas', role: 'team_member' }, { userId: 'client', role: 'guest' },
  ];
  const raised: string[] = [];
  const makeService = (sent: { eventType: string; userIds: unknown[]; body: string }[]) => {
    const issues: Record<string, any> = {};
    const task = { id: 't4', number: 4, title: 'Push notification service', assigneeId: 'yonas', status: { name: 'In progress', category: 'active' } };
    const tx: any = {
      issue: {
        create: async ({ data }: any) => (issues.i1 = { id: 'i1', status: 'open', assigneeId: null, createdAt: new Date(), updatedAt: new Date(), resolvedAt: null, closedAt: null, ...data, task: data.taskId ? task : null, project: { keyPrefix: 'MBA' }, reporter: { id: data.reporterId }, assignee: null }),
        update: async ({ data }: any) => (issues.i1 = { ...issues.i1, ...data }), // Prisma returns a new object
      },
      projectMember: { findMany: async ({ where }: any) => members.filter((m) => (where.role.not ? m.role !== where.role.not : m.role === where.role)) },
      user: { findUnique: async ({ where }: any) => ({ fullName: where.id === 'dawit' ? 'Dawit Tesfaye' : 'Blien Moges' }) },
    };
    const prisma: any = { ...tx, tx: (fn: any) => fn(tx), task: { findUnique: async () => ({ projectId: 'p1' }) }, issue: { findUnique: async () => issues.i1 } };
    const project = { id: 'p1', keyPrefix: 'MBA', workspaceId: 'w1', archivedAt: null, space: { archivedAt: null } };
    const access: any = { require: async (_p: string, user: string) => ({ project, isAdmin: false, isManager: user === 'blien' }), assertWritable: () => undefined };
    const notifications: any = { notify: async (_tx: unknown, n: any) => { sent.push(n); return []; } };
    const automations: any = { onCriticalIssue: async (_tx: unknown, issue: any) => { raised.push(issue.taskId); return true; } };
    return new IssuesService(prisma, access, notifications, { log: async () => undefined } as any, automations);
  };
  await test('a normal issue notifies the PM and the task assignee', async () => {
    const sent: any[] = [];
    await makeService(sent).create('p1', 'dawit', { title: 'Crash on login', type: 'bug' as any, severity: 'high' as any, taskId: 't4' });
    assert.equal(sent[0].eventType, 'issue');
    assert.deepEqual(sent[0].userIds, ['blien', 'yonas']);
    assert.equal(sent[0].actorId, 'dawit', 'the reporter is not notified about their own report');
  });
  await test('a Critical blocker alerts the whole team (not Guests) and says the task is blocked', async () => {
    const sent: any[] = [];
    const svc = makeService(sent);
    const issue = await svc.create('p1', 'dawit', { title: 'Payments down', type: 'blocker' as any, severity: 'critical' as any, taskId: 't4' });
    assert.equal(sent[0].eventType, 'critical');
    assert.deepEqual(sent[0].userIds, ['blien', 'dawit', 'yonas', 'yonas']);
    assert.match(sent[0].body, /Dawit Tesfaye reported a Critical blocker in MBA on MBA-4 .*MBA-4 is blocked until it is resolved\./);
    assert.equal(issue.blocksTask, true);
    assert.deepEqual(raised, ['t4'], 'critical_priority ran for the linked task');
    await svc.setStatus('i1', 'blien', { status: 'resolved' as any });
    const resolved = sent.find((n) => n.eventType === 'resolved');
    assert.deepEqual(resolved.userIds, ['dawit', 'yonas'], 'reporter (FR-6.5) and the unblocked task\'s assignee');
    assert.match(resolved.body, /MBA-4 is no longer blocked/);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
