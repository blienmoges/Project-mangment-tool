/* Checks for step-1 logic that does not need a database. Run: npx ts-node test/logic.check.ts */
import { strict as assert } from 'node:assert';
import { FieldType, ProjectRole, SpaceVisibility, StatusCategory as C } from '@prisma/client';
import { changedPositions, insertAt } from '../src/common/ordering';
import { todayInTimeZone } from '../src/common/utils';
import { checkFieldValue } from '../src/spaces/custom-field-values';
import { allowedRange, isCategoryOrdered, missingCategories } from '../src/spaces/workflow';
import { TeamAccessService } from '../src/teams/team-access.service';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };

(async () => {
  // ── workflow ordering ──
  const mobile = [C.not_started, C.active, C.active, C.review, C.closed].map((category) => ({ category })); // To do, In progress, Testing, In review, Done
  await test('new Active status goes between In progress/Testing and In review', () => assert.deepEqual(allowedRange(mobile, C.active), { min: 1, max: 3 }));
  await test('new Closed status can only go at the end', () => assert.deepEqual(allowedRange(mobile, C.closed), { min: 4, max: 5 }));
  await test('new Not started status goes first', () => assert.deepEqual(allowedRange(mobile, C.not_started), { min: 0, max: 1 }));
  await test('category order detection', () => {
    assert.equal(isCategoryOrdered(mobile), true);
    assert.equal(isCategoryOrdered([{ category: C.closed }, { category: C.active }]), false);
  });
  await test('missing categories', () => assert.deepEqual(missingCategories([{ category: C.active }]), [C.not_started, C.review, C.closed]));
  await test('insertAt and changedPositions renumber 0..n-1', () => {
    const rows = [{ id: 'a', position: 0 }, { id: 'b', position: 1 }, { id: 'c', position: 2 }];
    const out = insertAt(rows, { id: 'n', position: 1 }, 1);
    assert.deepEqual(out.map((r) => r.id), ['a', 'n', 'b', 'c']);
    assert.deepEqual(changedPositions(out), [{ id: 'b', from: 1, to: 2 }, { id: 'c', from: 2, to: 3 }]);
  });

  // ── custom field values ──
  const dd = { fieldType: FieldType.dropdown, options: [{ id: 'ios', label: 'iOS' }, { id: 'and', label: 'Android' }] } as never;
  await test('dropdown value must be a choice id', () => { assert.equal(checkFieldValue(dd, 'ios'), null); assert.notEqual(checkFieldValue(dd, 'iOS'), null); });
  await test('number, checkbox, date, text, null', () => {
    assert.equal(checkFieldValue({ fieldType: FieldType.number, options: null }, 3.5), null);
    assert.notEqual(checkFieldValue({ fieldType: FieldType.number, options: null }, '3'), null);
    assert.equal(checkFieldValue({ fieldType: FieldType.checkbox, options: null }, false), null);
    assert.equal(checkFieldValue({ fieldType: FieldType.date, options: null }, '2027-02-26'), null);
    assert.notEqual(checkFieldValue({ fieldType: FieldType.date, options: null }, '26/02/2027'), null);
    assert.notEqual(checkFieldValue({ fieldType: FieldType.text, options: null }, 'x'.repeat(2001)), null);
    assert.equal(checkFieldValue({ fieldType: FieldType.text, options: null }, null), null);
  });
  await test('today uses the workspace time zone', () => {
    const lateUtc = new Date('2027-02-10T22:30:00Z'); // 01:30 on the 11th in Addis Ababa (UTC+3)
    assert.equal(todayInTimeZone('Africa/Addis_Ababa', lateUtc), '2027-02-11');
    assert.equal(todayInTimeZone('UTC', lateUtc), '2027-02-10');
  });

  // ── team access sync, against an in-memory database ──
  const db = fakeDb();
  const svc = new TeamAccessService();
  const tx = db as never;
  // Space S1 (private) with project P1; space S2 (open). Teams: backend {dawit, meron}, mobile {meron}.
  db.projects.push({ id: 'P1', spaceId: 'S1', visibility: SpaceVisibility.private });
  db.teamMembers.push({ teamId: 'backend', userId: 'dawit' }, { teamId: 'backend', userId: 'meron' }, { teamId: 'mobile', userId: 'meron' });
  db.projectMembers.push({ projectId: 'P1', userId: 'blien', role: ProjectRole.project_manager, addedViaTeamId: null });
  db.spaceMembers.push({ spaceId: 'S1', userId: 'blien', addedViaTeamId: null });

  await test('adding a team to a space adds its members via the team', async () => {
    await svc.grantTeamToSpace(tx, 'S2', 'backend');
    assert.deepEqual(db.spaceRow('S2', 'dawit')?.addedViaTeamId, 'backend');
    assert.deepEqual(db.spaceRow('S2', 'meron')?.addedViaTeamId, 'backend');
  });
  await test('adding a team to a project in a private space also adds space access', async () => {
    const c = await svc.grantTeamToProject(tx, 'P1', 'backend');
    assert.equal(c.projectsJoined, 2);
    assert.equal(db.projectRow('P1', 'dawit')?.role, ProjectRole.team_member);
    assert.equal(db.spaceRow('S1', 'dawit')?.addedViaTeamId, 'backend');
  });
  await test('a second team covering the same project takes over when the first link ends', async () => {
    await svc.grantTeamToProject(tx, 'P1', 'mobile'); // meron already a member through backend: row unchanged
    assert.equal(db.projectRow('P1', 'meron')?.addedViaTeamId, 'backend');
    db.tasks.push({ projectId: 'P1', assigneeId: 'dawit', completedAt: null }, { projectId: 'P1', assigneeId: 'dawit', completedAt: new Date() });
    const c = await svc.revokeTeamFromProject(tx, 'P1', 'backend');
    assert.equal(db.projectRow('P1', 'meron')?.addedViaTeamId, 'mobile', 'meron keeps access through the Mobile team');
    assert.equal(db.projectRow('P1', 'dawit'), undefined, 'dawit loses the project');
    assert.equal(c.unassignedTasks, 1, 'only the unfinished task is unassigned');
    assert.equal(db.spaceRow('S1', 'dawit'), undefined, 'dawit loses the private space too');
    assert.ok(db.spaceRow('S1', 'meron'), 'meron keeps the space because she is still in P1');
    assert.equal(db.spaceRow('S2', 'dawit')?.addedViaTeamId, 'backend', 'the other space is untouched');
  });
  await test('the Project Manager is never removed by a team change', async () => {
    db.teamMembers.push({ teamId: 'mobile', userId: 'blien' });
    await svc.grantMember(tx, 'mobile', 'blien');
    db.teamMembers.splice(db.teamMembers.findIndex((m) => m.teamId === 'mobile' && m.userId === 'blien'), 1);
    await svc.revokeMember(tx, 'mobile', 'blien');
    assert.equal(db.projectRow('P1', 'blien')?.role, ProjectRole.project_manager);
  });
  await test('a new team member joins the team’s spaces and projects', async () => {
    db.teamMembers.push({ teamId: 'mobile', userId: 'yonas' });
    const c = await svc.grantMember(tx, 'mobile', 'yonas');
    assert.equal(c.projectsJoined, 1);
    assert.ok(db.spaceRow('S1', 'yonas'), 'private space of the project');
  });
  await test('direct members keep their own row', async () => {
    db.spaceMembers.push({ spaceId: 'S2', userId: 'sara', addedViaTeamId: null });
    db.teamMembers.push({ teamId: 'backend', userId: 'sara' });
    await svc.grantMember(tx, 'backend', 'sara');
    assert.equal(db.spaceRow('S2', 'sara')?.addedViaTeamId, null);
    db.teamMembers.pop();
    await svc.revokeMember(tx, 'backend', 'sara');
    assert.ok(db.spaceRow('S2', 'sara'), 'still in the space');
  });
  await test('removing a team from a space removes people only it gave access', async () => {
    const c = await svc.revokeTeamFromSpace(tx, 'S2', 'backend');
    assert.equal(c.spacesLeft, 2);
    assert.equal(db.spaceRow('S2', 'dawit'), undefined);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });

// Minimal stand-in for the Prisma transaction client: only the calls TeamAccessService makes.
function fakeDb() {
  type SM = { spaceId: string; userId: string; addedViaTeamId: string | null; createdAt?: Date };
  type PM = { projectId: string; userId: string; role: ProjectRole; addedViaTeamId: string | null };
  const d = {
    spaceTeams: [] as { spaceId: string; teamId: string }[],
    projectTeams: [] as { projectId: string; teamId: string }[],
    teamMembers: [] as { teamId: string; userId: string }[],
    spaceMembers: [] as SM[],
    projectMembers: [] as PM[],
    projects: [] as { id: string; spaceId: string; visibility: SpaceVisibility }[],
    tasks: [] as { projectId: string; assigneeId: string | null; completedAt: Date | null }[],
    spaceRow: (s: string, u: string) => d.spaceMembers.find((r) => r.spaceId === s && r.userId === u),
    projectRow: (p: string, u: string) => d.projectMembers.find((r) => r.projectId === p && r.userId === u),
  };
  const removeWhere = <T,>(arr: T[], pred: (r: T) => boolean) => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1); };
  const inTeam = (teamId: string, w: any) => !w?.members?.some?.userId || d.teamMembers.some((m) => m.teamId === teamId && m.userId === w.members.some.userId);
  const matchLink = (key: 'spaceId' | 'projectId') => (r: any, w: any) =>
    (w[key] === undefined || r[key] === w[key]) && (w.teamId === undefined || (typeof w.teamId === 'string' ? r.teamId === w.teamId : r.teamId !== w.teamId.not)) && inTeam(r.teamId, w.team);
  const createMany = (arr: any[], keys: string[]) => async ({ data }: any) => {
    let count = 0;
    for (const row of data) if (!arr.some((r) => keys.every((k) => r[k] === row[k]))) { arr.push({ addedViaTeamId: null, ...row }); count++; }
    return { count };
  };
  const matchMember = (key: 'spaceId' | 'projectId') => (r: any, w: any) =>
    (w[key] === undefined || r[key] === w[key]) && (w.userId === undefined || (typeof w.userId === 'string' ? r.userId === w.userId : w.userId.in.includes(r.userId))) &&
    (w.addedViaTeamId === undefined || r.addedViaTeamId === w.addedViaTeamId) &&
    (w.project?.spaceId === undefined || d.projects.find((p) => p.id === r.projectId)?.spaceId === w.project.spaceId);
  const ms = matchMember('spaceId'), mp = matchMember('projectId');
  const project = (id: string) => { const p = d.projects.find((x) => x.id === id)!; return { spaceId: p.spaceId, space: { visibility: p.visibility } }; };
  return Object.assign(d, {
    spaceTeam: {
      createMany: createMany(d.spaceTeams, ['spaceId', 'teamId']),
      findMany: async ({ where }: any) => d.spaceTeams.filter((r) => matchLink('spaceId')(r, where)),
      findFirst: async ({ where }: any) => d.spaceTeams.find((r) => matchLink('spaceId')(r, where)) ?? null,
      findUnique: async ({ where }: any) => d.spaceTeams.find((r) => r.spaceId === where.spaceId_teamId.spaceId && r.teamId === where.spaceId_teamId.teamId) ?? null,
      deleteMany: async ({ where }: any) => { removeWhere(d.spaceTeams as any[], (r: any) => matchLink('spaceId')(r, where)); },
    },
    projectTeam: {
      createMany: createMany(d.projectTeams, ['projectId', 'teamId']),
      findMany: async ({ where }: any) => d.projectTeams.filter((r) => matchLink('projectId')(r, where)).map((r) => ({ ...r, project: project(r.projectId) })),
      findFirst: async ({ where }: any) => d.projectTeams.find((r) => matchLink('projectId')(r, where)) ?? null,
      deleteMany: async ({ where }: any) => { removeWhere(d.projectTeams as any[], (r: any) => matchLink('projectId')(r, where)); },
    },
    teamMember: { findMany: async ({ where }: any) => d.teamMembers.filter((m) => m.teamId === where.teamId) },
    spaceMember: {
      createMany: createMany(d.spaceMembers, ['spaceId', 'userId']),
      findMany: async ({ where }: any) => d.spaceMembers.filter((r) => ms(r, where)),
      update: async ({ where, data }: any) => Object.assign(d.spaceRow(where.spaceId_userId.spaceId, where.spaceId_userId.userId)!, data),
      delete: async ({ where }: any) => { removeWhere(d.spaceMembers as any[], (r: any) => (r.spaceId === where.spaceId_userId.spaceId && r.userId === where.spaceId_userId.userId)); },
    },
    projectMember: {
      createMany: createMany(d.projectMembers, ['projectId', 'userId']),
      findMany: async ({ where }: any) => d.projectMembers.filter((r) => mp(r, where)),
      findFirst: async ({ where }: any) => d.projectMembers.find((r) => mp(r, where)) ?? null,
      update: async ({ where, data }: any) => Object.assign(d.projectRow(where.projectId_userId.projectId, where.projectId_userId.userId)!, data),
      delete: async ({ where }: any) => { removeWhere(d.projectMembers as any[], (r: any) => (r.projectId === where.projectId_userId.projectId && r.userId === where.projectId_userId.userId)); },
    },
    project: { findUniqueOrThrow: async ({ where }: any) => project(where.id) },
    task: {
      updateMany: async ({ where, data }: any) => {
        const rows = d.tasks.filter((t) => t.projectId === where.projectId && t.assigneeId === where.assigneeId && t.completedAt === null);
        rows.forEach((t) => Object.assign(t, { assigneeId: data.assigneeId }));
        return { count: rows.length };
      },
    },
    channel: { findFirst: async () => null },
  });
}
