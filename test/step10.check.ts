/* Step-10 checks (custom rules, backup codes, push, templates) without a database. Run: npx ts-node test/step10.check.ts */
import { strict as assert } from 'node:assert';
import { CustomRulesService } from '../src/automations/custom-rules.service';
import { matches, render, RuleContext, validateRule } from '../src/automations/custom-rules';
import { TwoFactorService } from '../src/auth/two-factor.service';
import { channelsFor } from '../src/notifications/events';
import { TemplatesService } from '../src/projects/templates.service';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [TESTING, DONE, PROG, MERON, BLIEN, PHASE, SPRINT, QA] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8)];
const ctx: RuleContext = { statuses: [{ id: PROG, category: 'active' }, { id: TESTING, category: 'active' }, { id: DONE, category: 'closed' }], memberIds: [MERON, BLIEN], phaseIds: [PHASE], sprintIds: [SPRINT], teamIds: [QA] };
const good = {
  name: 'Tell QA when a task enters Testing',
  trigger: { event: 'task.status_changed', toStatusId: TESTING },
  conditions: [{ field: 'task.priority', operator: 'in', value: ['medium', 'high'] }, { field: 'task.assigneeId', operator: 'is_not_empty' }],
  actions: [{ type: 'notify', recipients: { teamId: QA, manager: true }, message: '{task} is ready for testing ({rule}).' }, { type: 'set_priority', priority: 'high' }],
};

(async () => {
  await test('a valid rule is accepted and cleaned', () => {
    const { fields, rule } = validateRule(good, ctx);
    assert.deepEqual(fields, {});
    assert.equal(rule!.trigger.toStatusId, TESTING);
    assert.deepEqual(rule!.actions[0], { type: 'notify', message: '{task} is ready for testing ({rule}).', recipients: { manager: true, teamId: QA } });
  });
  await test('every problem is reported with its place (422 INVALID_AUTOMATION_RULE)', () => {
    const { fields } = validateRule({
      name: 'x',
      trigger: { event: 'task.deleted' },
      conditions: [{ field: 'issue.severity', operator: 'equals', value: 'critical' }, { field: 'task.priority', operator: 'in', value: 'high' }, { field: 'task.assigneeId', operator: 'equals', value: U(99) }],
      actions: [{ type: 'move_status', statusId: DONE }, { type: 'notify', recipients: { reporter: true }, message: '' }, { type: 'assign', userId: MERON }],
    }, ctx);
    assert.deepEqual(Object.keys(fields).sort(), ['actions.0.statusId', 'actions.1.message', 'actions.1.recipients', 'actions.2.type', 'conditions.0.field', 'conditions.1.value', 'conditions.2.value', 'name', 'trigger.event']);
    assert.match(fields['actions.0.statusId'], /only the Project Manager closes tasks/);
    assert.ok(validateRule({ ...good, actions: Array(6).fill(good.actions[1]) }, ctx).fields.actions, 'at most 5 actions');
    assert.ok(validateRule({ ...good, trigger: { event: 'task.created', toStatusId: TESTING } }, ctx).fields['trigger.toStatusId']);
  });
  await test('conditions: all must hold; render fills the placeholders', () => {
    const c = validateRule(good, ctx).rule!.conditions;
    assert.equal(matches(c, { 'task.priority': 'high', 'task.assigneeId': MERON }), true);
    assert.equal(matches(c, { 'task.priority': 'low', 'task.assigneeId': MERON }), false);
    assert.equal(matches(c, { 'task.priority': 'high', 'task.assigneeId': null }), false);
    assert.equal(render('{task} in {project} ({rule})', { taskShortId: 'MBA-6', taskTitle: 'Login screen', project: 'MBA Mobile Banking App', rule: 'QA' }), 'MBA-6 Login screen in MBA Mobile Banking App (QA)');
  });

  // ── the engine, over an in-memory database ──
  const engine = (opts: { blocked?: boolean; rules: any[] }) => {
    const out = { notified: [] as any[], updates: [] as any[], comments: [] as any[], log: [] as any[] };
    const task = { id: 't6', number: 6, title: 'Login screen', priority: 'medium', assigneeId: MERON, phaseId: null, sprintId: SPRINT, statusId: TESTING, completedAt: null, status: { id: TESTING, name: 'Testing', category: 'active', position: 2 }, project: { keyPrefix: 'MBA', name: 'Mobile Banking App', spaceId: 's1', workspaceId: 'w1' } };
    const tx: any = {
      automationRule: { findMany: async () => opts.rules.filter((r) => r.enabled).map((r, i) => ({ id: `r${i}`, config: { rule: validateRule(r, ctx).rule, createdById: BLIEN } })) },
      task: { findUnique: async () => task, update: async (a: any) => { out.updates.push(a.data); Object.assign(task, a.data); } },
      issue: { findUnique: async () => null, count: async () => (opts.blocked ? 1 : 0) },
      taskDependency: { count: async () => 0 },
      projectMember: { findFirst: async () => ({ userId: BLIEN }) },
      teamMember: { findMany: async () => [{ userId: 'sara' }] },
      workflowStatus: { findFirst: async ({ where }: any) => ctx.statuses.map((s, i) => ({ ...s, name: ['In progress', 'Testing', 'Done'][i], position: [1, 2, 4][i] })).find((s) => s.id === where.id) ?? null },
      workspaceMember: { findUnique: async () => ({ role: 'admin' }) },
      comment: { create: async (a: any) => out.comments.push(a.data.body) },
    };
    const svc = new CustomRulesService({} as any, {} as any, { notify: async (_t: unknown, n: any) => { out.notified.push(n); return []; } } as any, { log: async (e: any) => out.log.push(e) } as any);
    return { run: (event: any, toStatusId?: string) => svc.run(tx, event, { projectId: 'p1', taskId: 't6', toStatusId }), out, task };
  };
  await test('a matching rule runs all its actions and is logged as an automation', async () => {
    const e = engine({ rules: [{ ...good, enabled: true }] });
    assert.equal(await e.run('task.status_changed', TESTING), 1);
    assert.deepEqual(e.out.notified[0].userIds.sort(), [BLIEN, 'sara'].sort());
    assert.equal(e.out.notified[0].eventType, 'automation');
    assert.equal(e.out.notified[0].body, 'MBA-6 Login screen is ready for testing (Tell QA when a task enters Testing).');
    assert.deepEqual(e.out.updates, [{ priority: 'high' }]);
    assert.equal(e.out.log[0].actorType, 'automation');
    assert.deepEqual(e.out.log[0].newValue.actions, ['notify', 'priority:high']);
  });
  await test('rules for other events, other statuses, or switched off do not run', async () => {
    assert.equal(await engine({ rules: [{ ...good, enabled: true }] }).run('task.status_changed', PROG), 0, 'entered another status');
    assert.equal(await engine({ rules: [{ ...good, enabled: true }] }).run('task.created'), 0);
    assert.equal(await engine({ rules: [{ ...good, enabled: false }] }).run('task.status_changed', TESTING), 0);
  });
  await test('move_status keeps the workflow rules: a blocked task is not moved forward', async () => {
    const moveBack = { name: 'Back to progress', trigger: { event: 'task.assigned' }, actions: [{ type: 'move_status', statusId: PROG }, { type: 'add_comment', text: 'Reassigned: please review {task.shortId}.' }] };
    const fwd = engine({ blocked: true, rules: [{ ...moveBack, actions: [{ type: 'move_status', statusId: TESTING }], enabled: true }] });
    fwd.task.statusId = PROG; fwd.task.status = { id: PROG, name: 'In progress', category: 'active', position: 1 } as any;
    await fwd.run('task.assigned');
    assert.deepEqual(fwd.out.updates, [], 'blocked: not moved');
    const back = engine({ blocked: true, rules: [{ ...moveBack, enabled: true }] });
    await back.run('task.assigned');
    assert.deepEqual(back.out.updates, [{ statusId: PROG }], 'moving back is allowed even when blocked');
    assert.deepEqual(back.out.comments, ['Automation "Back to progress": Reassigned: please review MBA-6.']);
  });

  // ── backup codes ──
  await test('backup codes: 10, shown once, each works once, stored only as hashes, regenerating replaces them', async () => {
    const user: any = { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] };
    const prisma: any = { user: {
      findUniqueOrThrow: async () => ({ ...user }),
      update: async ({ data }: any) => Object.assign(user, data),
      updateMany: async ({ where, data }: any) => (user.twoFactorBackupCodes.includes(where.twoFactorBackupCodes.has) ? (Object.assign(user, data), { count: 1 }) : { count: 0 }),
    } };
    const tf = new TwoFactorService(prisma, { get: (k: string) => (k === 'JWT_ACCESS_SECRET' ? 'x'.repeat(40) : undefined) } as any);
    (tf as any).check = () => undefined; // the app code itself is tested in account.check.ts
    user.twoFactorSecret = 'sealed';
    const { backupCodes } = (await tf.confirm('u', '123456')) as any;
    assert.equal(backupCodes.length, 10);
    assert.ok(backupCodes.every((c: string) => /^[a-z2-7]{4}-[a-z2-7]{6}$/.test(c)));
    assert.ok(!user.twoFactorBackupCodes.some((h: string) => backupCodes.some((c: string) => h.includes(c.replace('-', '')))), 'stored as hashes');
    assert.equal(await tf.useBackupCode('u', backupCodes[3].toUpperCase()), 9, 'case and dash do not matter');
    assert.equal(await tf.useBackupCode('u', backupCodes[3]), null, 'used once');
    assert.equal(await tf.useBackupCode('u', '123456'), null);
    const fresh = (await tf.regenerateBackupCodes('u')).backupCodes;
    assert.equal(await tf.useBackupCode('u', backupCodes[0]), null, 'old codes stop working');
    assert.equal(await tf.useBackupCode('u', fresh[0]), 9);
  });

  // ── push channel ──
  await test('push is sent only to people who chose it and allowed it in a browser', () => {
    assert.deepEqual(channelsFor('assigned', { email: true, sms: false, push: true }, { phone: null, hasPush: true }), ['email', 'push']);
    assert.deepEqual(channelsFor('assigned', { email: true, sms: false, push: true }, { phone: null, hasPush: false }), ['email']);
    assert.deepEqual(channelsFor('assigned', undefined, { phone: null, hasPush: true }), ['email'], 'off by default');
  });

  // ── templates ──
  await test('a template rebuilds phases and tasks from the new start date, subtasks after parents', async () => {
    const made: any = { phases: [], tasks: [], skills: [], deps: [], next: 0 };
    const tx: any = {
      phase: { create: async ({ data }: any) => (made.phases.push(data), { id: `ph${made.phases.length}` }) },
      workflowStatus: { findFirst: async () => ({ id: 'todo' }) },
      skill: { findMany: async () => [{ id: 'new-node', name: 'Node.js' }] },
      task: { create: async ({ data }: any) => (made.tasks.push(data), { id: `t${made.tasks.length}` }) },
      taskSkill: { createMany: async ({ data }: any) => made.skills.push(...data) },
      taskDependency: { createMany: async ({ data }: any) => made.deps.push(...data) },
      project: { update: async ({ data }: any) => { made.next = data.nextTaskNumber; } },
    };
    const content: any = {
      version: 1, durationDays: 30,
      phases: [{ name: 'Design', dueOffset: 9 }, { name: 'Build', dueOffset: null }],
      tasks: [
        { ref: 2, parentRef: 1, title: 'Subtask', description: null, priority: 'low', estimatedHours: 2, storyPoints: 1, startOffset: null, dueOffset: 3, phase: 0, skills: [], dependsOn: [] },
        { ref: 1, parentRef: null, title: 'Parent', description: null, priority: 'high', estimatedHours: 8, storyPoints: 3, startOffset: 0, dueOffset: 5, phase: 0, skills: [{ skillId: 'old-node', name: 'Node.js', minLevel: 'expert' }], dependsOn: [] },
        { ref: 3, parentRef: null, title: 'After', description: null, priority: 'medium', estimatedHours: null, storyPoints: null, startOffset: null, dueOffset: null, phase: 1, skills: [{ skillId: 'gone', name: 'Cobol', minLevel: 'beginner' }], dependsOn: [1] },
      ],
    };
    const svc = new TemplatesService({} as any, {} as any, {} as any, {} as any);
    const r = await svc.apply(tx, { id: 'p', workspaceId: 'w', spaceId: 's', startDate: new Date('2027-03-01T00:00:00Z') }, content, 'blien');
    assert.deepEqual(made.tasks.map((t: any) => [t.number, t.title, t.parentTaskId]), [[1, 'Parent', null], [2, 'After', null], [3, 'Subtask', 't1']]);
    assert.equal(made.tasks[0].dueDate.toISOString().slice(0, 10), '2027-03-06');
    assert.equal(made.phases[0].dueDate.toISOString().slice(0, 10), '2027-03-10');
    assert.deepEqual(made.skills, [{ taskId: 't1', skillId: 'new-node', minLevel: 'expert' }], 'matched by name; unknown skills left out');
    assert.deepEqual(made.deps, [{ taskId: 't2', dependsOnTaskId: 't1' }]);
    assert.equal(made.next, 4);
    assert.deepEqual([r.tasks, r.datedTaskIds.length, r.datedPhaseIds], [3, 2, ['ph1']]);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
