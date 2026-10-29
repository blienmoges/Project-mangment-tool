/* Step-3 checks that need no database. Run: npx ts-node test/tasks.check.ts */
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { SkillLevel as L, StatusCategory as C } from '@prisma/client';
import { AppException } from '../src/common/app-exception';
import { validateArray, validationExceptionFactory } from '../src/common/validation';
import { wouldCreateLoop } from '../src/tasks/dependencies';
import { AssignDto, RequiredSkillDto, TaskListQuery } from '../src/tasks/dto/task.dto';
import { Candidate, evaluate, rank } from '../src/tasks/suggestions';
import { allowedTargets, checkMove, checkProgress, firstOf } from '../src/tasks/task-workflow';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const code = (e: AppException | null) => (e ? e.body.code : 'ok');

// Mobile apps workflow: To do, In progress, Testing, In review, Done
const s = (id: string, category: C, position: number) => ({ id, name: id, category, position });
const todo = s('todo', C.not_started, 0), prog = s('prog', C.active, 1), testing = s('testing', C.active, 2), review = s('review', C.review, 3), done = s('done', C.closed, 4);
const flow = [todo, prog, testing, review, done];
const pm = { isManager: true, isAssignee: false };
const dev = { isManager: false, isAssignee: true };
const other = { isManager: false, isAssignee: false };
const free = { blocked: false, unfinishedDependencies: 0 };

(async () => {
  await test('nobody can move a task into a closed status (403 APPROVAL_REQUIRED)', () => {
    assert.equal(code(checkMove(review, done, pm)), 'APPROVAL_REQUIRED');
    assert.equal(code(checkMove(prog, done, dev)), 'APPROVAL_REQUIRED');
  });
  await test('assignee moves between Not started / Active either way, and into review', () => {
    assert.equal(code(checkMove(todo, prog, dev)), 'ok');
    assert.equal(code(checkMove(testing, todo, dev)), 'ok');
    assert.equal(code(checkMove(prog, review, dev)), 'ok');
  });
  await test('during review only the PM / Admin can change the task', () => {
    assert.equal(code(checkMove(review, prog, dev)), 'FORBIDDEN');
    assert.equal(code(checkMove(review, prog, pm)), 'ok');
  });
  await test("others cannot move someone else's task; a closed task needs reopen", () => {
    assert.equal(code(checkMove(todo, prog, other)), 'FORBIDDEN');
    assert.equal(code(checkMove(done, prog, pm)), 'INVALID_STATUS_CHANGE');
  });
  await test('blocked tasks cannot move forward or into review, but can move back', () => {
    const blocked = { blocked: true, unfinishedDependencies: 0 };
    assert.equal(code(checkProgress(prog, testing, blocked)), 'TASK_BLOCKED');
    assert.equal(code(checkProgress(prog, review, blocked)), 'TASK_BLOCKED');
    assert.equal(code(checkProgress(review, done, blocked)), 'TASK_BLOCKED', 'approval is forward too');
    assert.equal(code(checkProgress(testing, prog, blocked)), 'ok');
  });
  await test('a task cannot leave Not started while a dependency is unfinished', () => {
    const waiting = { blocked: false, unfinishedDependencies: 2 };
    assert.equal(code(checkProgress(todo, prog, waiting)), 'DEPENDENCY_NOT_DONE');
    assert.equal(code(checkProgress(prog, testing, waiting)), 'ok', 'once started, the rule no longer applies');
  });
  await test('allowed moves offered to each role', () => {
    assert.deepEqual(allowedTargets(flow, prog, dev, free), ['todo', 'testing', 'review']);
    assert.deepEqual(allowedTargets(flow, review, dev, free), []);
    assert.deepEqual(allowedTargets(flow, review, pm, free), ['todo', 'prog', 'testing']);
    assert.deepEqual(allowedTargets(flow, todo, dev, { blocked: false, unfinishedDependencies: 1 }), []);
    assert.equal(firstOf(flow, C.active)!.id, 'prog');
  });

  // ── ranking ──
  const person = (name: string, skills: [string, L, boolean?][], openHours: number, capacity = 40): Candidate => ({
    user: { id: name, fullName: name, avatarUrl: null, jobTitle: null },
    capacityHours: capacity, openHours, openTasks: 1, isCurrentAssignee: false,
    skills: new Map(skills.map(([id, level, verified]) => [id, { level, verified: !!verified }])),
  });
  const nodeRedis = [{ skillId: 'node', name: 'Node.js', minLevel: L.intermediate }, { skillId: 'redis', name: 'Redis', minLevel: L.intermediate }];
  await test("the API Design's example: Node.js Expert + Redis Beginner scores 65", () => {
    const r = evaluate(person('x', [['node', L.expert], ['redis', L.beginner]], 0), nodeRedis);
    assert.equal(r.skillMatch, 65);
    assert.deepEqual(r.matchedSkills, ['Node.js · Expert']);
    assert.deepEqual(r.partialSkills, ['Redis · Beginner (needs Intermediate)']);
  });
  await test('score = 0.75 × skillMatch + 0.25 × free capacity; flags', () => {
    const meron = evaluate(person('Meron', [['node', L.expert], ['redis', L.intermediate]], 8), nodeRedis);
    assert.equal(meron.score, 95);
    const busy = evaluate(person('Busy', [['node', L.expert], ['redis', L.expert]], 36), nodeRedis);
    assert.equal(busy.loadPercent, 90);
    assert.equal(busy.nearCapacity, true);
    assert.equal(busy.overCapacity, false);
    const over = evaluate(person('Over', [], 50), nodeRedis);
    assert.equal(over.overCapacity, true);
    assert.equal(over.score, 0, 'no skills and no free time');
    assert.deepEqual(over.missingSkills, ['Node.js · Intermediate', 'Redis · Intermediate']);
  });
  await test('no required skills: everyone has skillMatch 100, so workload decides', () => {
    const r = rank([person('A', [], 30), person('B', [], 10)], []);
    assert.deepEqual(r.map((x) => [x.user.fullName, x.skillMatch, x.rank]), [['B', 100, 1], ['A', 100, 2]]);
  });
  await test('ties: higher skillMatch, fewer hours, more verified skills, then name', () => {
    // Identical skills and hours, so score, skillMatch and hours tie; verified skills decide.
    const sameScore = rank([person('Zed', [['node', L.expert, true], ['redis', L.expert, true]], 20), person('Amy', [['node', L.expert, false], ['redis', L.expert, false]], 20)], nodeRedis);
    assert.equal(sameScore[0].user.fullName, 'Zed', 'more verified matched skills wins');
    const byName = rank([person('Zed', [], 0), person('Amy', [], 0)], []);
    assert.equal(byName[0].user.fullName, 'Amy');
  });
  await test('at most `limit` people are returned, flagged but never hidden', () => {
    const many = Array.from({ length: 15 }, (_, i) => person(`P${String(i).padStart(2, '0')}`, [], 60 + i));
    const r = rank(many, [], 10);
    assert.equal(r.length, 10);
    assert.ok(r.every((x) => x.overCapacity));
  });

  // ── dependencies ──
  await test('dependency loops are detected, including long ones', () => {
    const edges = [{ taskId: 'b', dependsOnTaskId: 'a' }, { taskId: 'c', dependsOnTaskId: 'b' }];
    assert.equal(wouldCreateLoop(edges, 'a', 'c'), true, 'a → c → b → a');
    assert.equal(wouldCreateLoop(edges, 'c', 'a'), false);
    assert.equal(wouldCreateLoop(edges, 'a', 'a'), true, 'self');
  });

  // ── validation ──
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory });
  const fields = (p: Promise<unknown>) => p.then(() => ({})).catch((e: AppException) => e.body.fields ?? {});
  await test('assign accepts a user id or null, but not a missing userId', async () => {
    assert.deepEqual(await fields(pipe.transform({ userId: null }, { type: 'body', metatype: AssignDto })), {});
    assert.ok('userId' in (await fields(pipe.transform({}, { type: 'body', metatype: AssignDto }))));
  });
  await test('list filters accept ids or keywords (me, none, backlog, categories)', async () => {
    const ok = { status: 'review', assigneeId: 'me', phaseId: 'none', sprintId: 'backlog', overdue: 'true', sort: '-dueDate', limit: '50' };
    const q = (await pipe.transform(ok, { type: 'query', metatype: TaskListQuery })) as TaskListQuery;
    assert.equal(q.overdue, true);
    assert.equal(q.limit, 50);
    const bad = await fields(pipe.transform({ status: 'finished', assigneeId: 'someone', sort: 'title' }, { type: 'query', metatype: TaskListQuery }));
    assert.deepEqual(Object.keys(bad).sort(), ['assigneeId', 'sort', 'status']);
  });
  await test('PUT /skills validates every item of the array', async () => {
    const id = '0b6f7f6e-1d1f-4c55-9c38-2c1f7c3c1a11';
    assert.equal((await validateArray([{ skillId: id, minLevel: 'expert' }], RequiredSkillDto)).length, 1);
    const bad = await fields(validateArray([{ skillId: 'x', minLevel: 'guru' }], RequiredSkillDto));
    assert.deepEqual(Object.keys(bad).sort(), ['0.minLevel', '0.skillId']);
    assert.ok('body' in (await fields(validateArray({}, RequiredSkillDto))));
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
