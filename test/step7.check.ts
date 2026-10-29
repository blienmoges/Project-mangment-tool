/* Step-7 checks (time tracking, views, automations) that need no database. Run: npx ts-node test/step7.check.ts */
import { strict as assert } from 'node:assert';
import { AutomationsService } from '../src/automations/automations.service';
import { csvCell, toCsv } from '../src/time/csv';
import { timerMinutes } from '../src/time/time.service';
import { calendarPeriod, loadStatus, mondayOf, spreadHours, weekCapacity } from '../src/views/view-math';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const MON_FRI = [1, 2, 3, 4, 5];

(async () => {
  await test('calendar: weeks start on Monday; a month view is whole weeks', () => {
    assert.equal(mondayOf('2027-02-10'), '2027-02-08');
    assert.deepEqual(calendarPeriod('week', '2027-02-14'), { start: '2027-02-08', end: '2027-02-14' }, 'Sunday belongs to the week before');
    assert.deepEqual(calendarPeriod('month', '2027-02-10'), { start: '2027-02-01', end: '2027-02-28' }, 'Feb 2027 is exactly four weeks');
    assert.deepEqual(calendarPeriod('month', '2027-03-20'), { start: '2027-03-01', end: '2027-04-04' });
    assert.deepEqual(calendarPeriod('month', '2027-12-05'), { start: '2027-11-29', end: '2028-01-02' }, 'across the year end');
  });
  await test('workload: estimates spread over working days up to the due date', () => {
    const r = spreadHours({ hours: 10, startDate: null, dueDate: '2027-02-12' }, '2027-02-08', MON_FRI);
    assert.deepEqual([...r.perDay.values()], [2, 2, 2, 2, 2], 'Mon–Fri');
    const later = spreadHours({ hours: 6, startDate: '2027-02-15', dueDate: '2027-02-17' }, '2027-02-08', MON_FRI);
    assert.deepEqual([...later.perDay.keys()], ['2027-02-15', '2027-02-16', '2027-02-17'], 'not before its start date');
    assert.deepEqual([...spreadHours({ hours: 8, startDate: null, dueDate: '2027-02-01' }, '2027-02-08', MON_FRI).perDay], [['2027-02-08', 8]], 'overdue: all today');
    assert.equal(spreadHours({ hours: 5, startDate: null, dueDate: null }, '2027-02-08', MON_FRI).unscheduled, 5);
    assert.deepEqual([...spreadHours({ hours: 4, startDate: '2027-02-13', dueDate: '2027-02-14' }, '2027-02-08', MON_FRI).perDay], [['2027-02-14', 4]], 'weekend-only task');
  });
  await test('workload: this week counts only the working days still ahead; status near at 85%', () => {
    assert.equal(weekCapacity(40, '2027-02-08', '2027-02-10', MON_FRI), 24, 'from Wednesday: 3 of 5 days');
    assert.equal(weekCapacity(40, '2027-02-15', '2027-02-10', MON_FRI), 40);
    assert.deepEqual([loadStatus(41, 40), loadStatus(34, 40), loadStatus(33, 40)], ['over', 'near', 'ok']);
  });
  await test('CSV: quotes and commas escaped, formulas neutralised, UTF-8 for Excel', () => {
    assert.equal(csvCell('Fix "login", then test'), '"Fix ""login"", then test"');
    assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
    assert.equal(csvCell('-1'), "'-1");
    const csv = toCsv(['Person', 'Hours'], [['Meron Alemu', 1.5]]);
    assert.ok(csv.startsWith('\uFEFFPerson,Hours\r\nMeron Alemu,1.5'));
  });
  await test('timers save whole minutes, at least one', () => {
    const t = new Date('2027-02-10T09:00:00Z');
    assert.equal(timerMinutes(t, new Date('2027-02-10T10:29:40Z')), 90);
    assert.equal(timerMinutes(t, new Date('2027-02-10T09:00:10Z')), 1);
  });

  // ── automations over an in-memory database ──
  const world = (o: { parentCategory?: string; openSubtasks?: number; blockers?: number; waiting?: number; disabled?: string[]; priority?: string } = {}) => {
    const updates: any[] = [];
    const notified: any[] = [];
    const tx: any = {
      automationRule: { findUnique: async ({ where }: any) => (o.disabled?.includes(where.projectId_ruleKey.ruleKey) ? { enabled: false } : null) },
      task: {
        findUnique: async ({ where }: any) => (where.id === 'parent'
          ? { id: 'parent', number: 7, title: 'Biometric login', projectId: 'p1', workspaceId: 'w1', assigneeId: 'hana', status: { name: 'In progress', category: o.parentCategory ?? 'active' }, project: { id: 'p1', keyPrefix: 'MBA', workspaceId: 'w1', spaceId: 's1' } }
          : { priority: o.priority ?? 'medium', completedAt: null }),
        count: async () => o.openSubtasks ?? 0,
        update: async (a: any) => { updates.push(a); return a; },
      },
      issue: { count: async () => o.blockers ?? 0 },
      taskDependency: { count: async () => o.waiting ?? 0 },
      workflowStatus: { findFirst: async () => ({ id: 'review', name: 'In review' }) },
      projectMember: { findFirst: async () => ({ userId: 'blien' }) },
    };
    const svc = new AutomationsService({} as any, {} as any, { notify: async (_t: unknown, n: any) => { notified.push(n); return []; } } as any, { log: async () => undefined } as any);
    return { svc, tx, updates, notified };
  };
  await test('subtasks_done: the last subtask done moves the parent to In review and tells the PM', async () => {
    const w = world();
    assert.equal(await w.svc.onSubtaskClosed(w.tx, 'parent'), true);
    assert.deepEqual(w.updates[0], { where: { id: 'parent' }, data: { statusId: 'review' } });
    assert.deepEqual(w.notified[0].userIds, ['blien', 'hana']);
    assert.match(w.notified[0].body, /MBA-7 Biometric login moved to In review automatically/);
  });
  await test('subtasks_done does nothing while subtasks are open, the parent is blocked or in review, or the rule is off', async () => {
    for (const o of [{ openSubtasks: 1 }, { blockers: 1 }, { parentCategory: 'review' }, { waiting: 1, parentCategory: 'not_started' }, { disabled: ['subtasks_done'] }]) {
      const w = world(o);
      assert.equal(await w.svc.onSubtaskClosed(w.tx, 'parent'), false, JSON.stringify(o));
      assert.equal(w.updates.length, 0);
    }
  });
  await test('critical_priority raises the linked task to High once, and respects the switch', async () => {
    const issue = { id: 'i1', projectId: 'p1', taskId: 't4', workspaceId: 'w1' };
    const w = world();
    assert.equal(await w.svc.onCriticalIssue(w.tx, issue), true);
    assert.deepEqual(w.updates[0].data, { priority: 'high' });
    assert.equal(await world({ priority: 'high' }).svc.onCriticalIssue(world({ priority: 'high' }).tx, issue), false);
    const off = world({ disabled: ['critical_priority'] });
    assert.equal(await off.svc.onCriticalIssue(off.tx, issue), false);
    assert.equal(await w.svc.onCriticalIssue(w.tx, { ...issue, taskId: null }), false, 'no linked task');
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
