/* Step-3 checks that need no database. Run: npx ts-node test/tasks.check.ts */
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { SkillLevel as L, StatusCategory as C } from '@prisma/client';
import { AppException } from '../src/common/app-exception';
import { validationExceptionFactory } from '../src/common/validation';
import { AssignDto, CreateTaskDto, TaskListQuery } from '../src/tasks/dto/task.dto';
import { rankCandidates, skillScore } from '../src/tasks/suggestions';
import { wouldCreateLoop } from '../src/tasks/tasks.service';
import { checkApprove, checkReopen, checkRequestChanges, checkStatusMove, MoveContext, StatusRef } from '../src/tasks/workflow-rules';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };

(async () => {
  // ── ranking: the API Design's examples ──
  const node = { skillId: 'node', name: 'Node.js', minLevel: L.intermediate };
  const redis = { skillId: 'redis', name: 'Redis', minLevel: L.intermediate };
  await test('per-skill score: at/above = 1, below = 0.6 × ratio, none = 0', () => {
    assert.equal(skillScore(L.expert, L.intermediate), 1);
    assert.equal(skillScore(L.beginner, L.intermediate), 0.3);
    assert.equal(Math.round(skillScore(L.intermediate, L.expert) * 100) / 100, 0.4);
    assert.equal(skillScore(undefined, L.beginner), 0);
  });
  await test('API example: Node.js Expert + Redis Beginner scores 65', () => {
    const [r] = rankCandidates([node, redis], [{ id: 'x', fullName: 'X', openHours: 0, capacityHours: 40, skills: [{ skillId: 'node', level: L.expert, verified: false }, { skillId: 'redis', level: L.beginner, verified: false }] }]);
    assert.equal(r.skillMatch, 65);
    assert.deepEqual(r.matchedSkills, ['Node.js · Expert']);
    assert.deepEqual(r.belowLevelSkills, ['Redis · Beginner (needs Intermediate)']);
  });
  await test('API Example 3: Meron (8 h) ranks above Dawit (30 h), both 100% skill match', () => {
    const full = (lvl: L) => [{ skillId: 'node', level: L.expert, verified: true }, { skillId: 'redis', level: lvl, verified: false }];
    const r = rankCandidates([node, redis], [
      { id: 'd', fullName: 'Dawit Tesfaye', openHours: 30, capacityHours: 40, skills: full(L.expert) },
      { id: 'm', fullName: 'Meron Alemu', openHours: 8, capacityHours: 40, skills: full(L.intermediate) },
    ]);
    assert.deepEqual(r.map((x) => [x.fullName, x.skillMatch, x.workloadHours, x.score, x.rank]), [['Meron Alemu', 100, 8, 95, 1], ['Dawit Tesfaye', 100, 30, 81.3, 2]]);
  });
  await test('skills weigh three times as much as free time', () => {
    const r = rankCandidates([node], [
      { id: 'idle', fullName: 'Idle Beginner', openHours: 0, capacityHours: 40, skills: [{ skillId: 'node', level: L.beginner, verified: false }] },
      { id: 'busy', fullName: 'Busy Expert', openHours: 30, capacityHours: 40, skills: [{ skillId: 'node', level: L.expert, verified: false }] },
    ]);
    assert.equal(r[0].userId, 'busy'); // 75 + 6.25 = 81.3 vs 0.75 × 30 + 25 = 47.5
  });
  await test('no required skills: everyone gets 100 and workload decides; flags at 85% and over 100%', () => {
    const r = rankCandidates([], [
      { id: 'a', fullName: 'A', openHours: 34, capacityHours: 40, skills: [] },
      { id: 'b', fullName: 'B', openHours: 50, capacityHours: 40, skills: [] },
      { id: 'c', fullName: 'C', openHours: 4, capacityHours: 40, skills: [] },
    ]);
    assert.deepEqual(r.map((x) => x.userId), ['c', 'a', 'b']);
    assert.ok(r.every((x) => x.skillMatch === 100));
    assert.deepEqual(r.map((x) => [x.nearCapacity, x.overCapacity]), [[false, false], [true, false], [true, true]]);
  });
  await test('ties: fewer open hours, then more verified matched skills, then name', () => {
    const p = (id: string, name: string, hours: number, verified: boolean) => ({ id, fullName: name, openHours: hours, capacityHours: 40, skills: [{ skillId: 'node', level: L.expert, verified }] });
    // Over capacity, everyone's free-time part is 0, so scores tie at 75.
    const r = rankCandidates([node], [p('z', 'Zed', 60, true), p('y', 'Yonas', 50, false), p('b', 'Bet', 50, true), p('a', 'Abel', 50, true)]);
    assert.deepEqual(r.map((x) => x.userId), ['a', 'b', 'y', 'z']);
  });

  // ── workflow rules ──
  const S = {
    todo: { id: 'todo', name: 'To do', category: C.not_started, position: 0 },
    prog: { id: 'prog', name: 'In progress', category: C.active, position: 1 },
    test: { id: 'test', name: 'Testing', category: C.active, position: 2 },
    review: { id: 'review', name: 'In review', category: C.review, position: 3 },
    done: { id: 'done', name: 'Done', category: C.closed, position: 4 },
    wont: { id: 'wont', name: "Won't do", category: C.closed, position: 5 },
  } satisfies Record<string, StatusRef>;
  const ctx = (from: StatusRef, o: Partial<MoveContext> = {}): MoveContext => ({ from, isManager: false, isAssignee: true, blocked: false, dependenciesDone: true, ...o });
  const code = (e: { code: string } | null) => e?.code ?? 'ok';
  await test('only approval closes a task (403 APPROVAL_REQUIRED), even for the PM', () => {
    assert.equal(code(checkStatusMove(ctx(S.review), S.done)), 'APPROVAL_REQUIRED');
    assert.equal(code(checkStatusMove(ctx(S.prog, { isManager: true }), S.done)), 'APPROVAL_REQUIRED');
  });
  await test('assignee moves between not started and active both ways, and into review', () => {
    assert.equal(code(checkStatusMove(ctx(S.todo), S.prog)), 'ok');
    assert.equal(code(checkStatusMove(ctx(S.test), S.todo)), 'ok');
    assert.equal(code(checkStatusMove(ctx(S.test), S.review)), 'ok');
  });
  await test('during review only the PM acts; others cannot move it', () => {
    assert.equal(code(checkStatusMove(ctx(S.review), S.prog)), 'FORBIDDEN');
    assert.equal(code(checkStatusMove(ctx(S.review, { isManager: true, isAssignee: false }), S.prog)), 'ok');
  });
  await test('someone who is neither assignee nor PM cannot move the task', () => {
    assert.equal(code(checkStatusMove(ctx(S.todo, { isAssignee: false }), S.prog)), 'FORBIDDEN');
  });
  await test('blocked tasks move back but not forward (409 TASK_BLOCKED)', () => {
    assert.equal(code(checkStatusMove(ctx(S.prog, { blocked: true }), S.test)), 'TASK_BLOCKED');
    assert.equal(code(checkStatusMove(ctx(S.prog, { blocked: true }), S.review)), 'TASK_BLOCKED');
    assert.equal(code(checkStatusMove(ctx(S.prog, { blocked: true }), S.todo)), 'ok');
    assert.equal(code(checkApprove(ctx(S.review, { blocked: true, isManager: true }), S.done)), 'TASK_BLOCKED');
  });
  await test('a task cannot leave not started until its dependencies are closed', () => {
    assert.equal(code(checkStatusMove(ctx(S.todo, { dependenciesDone: false }), S.prog)), 'DEPENDENCY_NOT_DONE');
    assert.equal(code(checkStatusMove(ctx(S.prog, { dependenciesDone: false }), S.test)), 'ok', 'already started');
  });
  await test('approve: PM only, only from review, into a closed status', () => {
    assert.equal(code(checkApprove(ctx(S.review), S.done)), 'FORBIDDEN');
    assert.equal(checkApprove(ctx(S.review), S.done)!.message, 'Only the Project Manager can approve tasks.');
    assert.equal(code(checkApprove(ctx(S.todo, { isManager: true }), S.done)), 'INVALID_STATUS_CHANGE', 'To do straight to Done');
    assert.equal(code(checkApprove(ctx(S.review, { isManager: true }), S.wont)), 'ok');
    assert.equal(code(checkApprove(ctx(S.review, { isManager: true }), S.prog)), 'VALIDATION_FAILED');
  });
  await test('request changes and reopen', () => {
    assert.equal(code(checkRequestChanges(ctx(S.review, { isManager: true }), S.prog)), 'ok');
    assert.equal(code(checkRequestChanges(ctx(S.prog, { isManager: true }), S.todo)), 'INVALID_STATUS_CHANGE');
    assert.equal(code(checkReopen(ctx(S.done, { isManager: true }), S.prog)), 'ok');
    assert.equal(code(checkReopen(ctx(S.done, { isManager: true }), S.review)), 'VALIDATION_FAILED');
    assert.equal(code(checkReopen(ctx(S.done), S.prog)), 'FORBIDDEN');
    assert.equal(code(checkStatusMove(ctx(S.done, { isManager: true }), S.prog)), 'INVALID_STATUS_CHANGE', 'must use reopen');
  });

  // ── dependencies ──
  await test('dependency loops are found, directly and through other tasks', () => {
    const edges = [{ taskId: 'b', dependsOnTaskId: 'a' }, { taskId: 'c', dependsOnTaskId: 'b' }];
    assert.equal(wouldCreateLoop(edges, 'a', 'c'), true, 'a → c → b → a');
    assert.equal(wouldCreateLoop(edges, 'a', 'b'), true);
    assert.equal(wouldCreateLoop(edges, 'c', 'a'), false, 'c already waits for a indirectly; adding it directly is fine');
    assert.equal(wouldCreateLoop(edges, 'd', 'c'), false);
  });

  // ── request validation ──
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory });
  const fields = (metatype: any, body: object, type: 'body' | 'query' = 'body') => pipe.transform(body, { type, metatype }).then(() => ({}), (e: AppException) => e.body.fields!);
  await test('task input checks', async () => {
    assert.deepEqual(await fields(CreateTaskDto, { title: 'Overdue alert scheduler', estimatedHours: 16, storyPoints: 8, dueDate: '2027-02-26', requiredSkills: [{ skillId: '6f1f3c8e-4b5a-4c1e-9d2a-1b2c3d4e5f60', minLevel: 'intermediate' }] }), {});
    const bad = await fields(CreateTaskDto, { title: '', estimatedHours: 1.234, storyPoints: -1, dueDate: '26-02-2027', requiredSkills: [{ skillId: 'x', minLevel: 'guru' }] });
    assert.deepEqual(Object.keys(bad).sort(), ['dueDate', 'estimatedHours', 'requiredSkills.0.minLevel', 'requiredSkills.0.skillId', 'storyPoints', 'title']);
  });
  await test('assign accepts a user id or null, but not a missing userId', async () => {
    assert.deepEqual(await fields(AssignDto, { userId: null }), {});
    assert.deepEqual(Object.keys(await fields(AssignDto, {})), ['userId']);
  });
  await test('list filters accept me/none/backlog and reject junk', async () => {
    assert.deepEqual(await fields(TaskListQuery, { assigneeId: 'me', sprintId: 'backlog', phaseId: 'none', overdue: 'true', sort: '-dueDate', limit: '50' }, 'query'), {});
    assert.deepEqual(Object.keys(await fields(TaskListQuery, { assigneeId: 'someone', sort: 'title', limit: '500' }, 'query')).sort(), ['assigneeId', 'limit', 'sort']);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
