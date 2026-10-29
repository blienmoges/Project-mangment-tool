/* Step-2 checks that need no database. Run: npx ts-node test/projects.check.ts */
import { strict as assert } from 'node:assert';
import { ValidationPipe } from '@nestjs/common';
import { FieldType, ProjectRole, SpaceVisibility, StatusCategory as C, WorkflowStatus, WorkspaceRole } from '@prisma/client';
import { AppException } from '../src/common/app-exception';
import { validationExceptionFactory } from '../src/common/validation';
import { CreateProjectDto } from '../src/projects/dto/project.dto';
import { mapFields, mapStatuses } from '../src/projects/move-mapping';
import { ProjectAccessService } from '../src/projects/project-access.service';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const st = (id: string, name: string, category: C, position: number) => ({ id, name, category, position, spaceId: 's', color: null, createdAt: new Date(), updatedAt: new Date() }) as WorkflowStatus;

(async () => {
  // Mobile apps (with Testing) → Web (no Testing, has "Won't do" as a second closed status)
  const mobile = [st('m1', 'To do', C.not_started, 0), st('m2', 'In progress', C.active, 1), st('m3', 'Testing', C.active, 2), st('m4', 'In review', C.review, 3), st('m5', 'Done', C.closed, 4)];
  const web = [st('w1', 'Backlog', C.not_started, 0), st('w2', 'In progress', C.active, 1), st('w3', 'In review', C.review, 2), st('w4', "Won't do", C.closed, 3), st('w5', 'Done', C.closed, 4)];

  await test('statuses map by name first, then by first status of the category', () => {
    const { map, errors } = mapStatuses(mobile, web);
    assert.deepEqual(errors, {});
    assert.equal(map.get('m1')!.id, 'w1', 'To do → Backlog (category)');
    assert.equal(map.get('m2')!.id, 'w2', 'same name');
    assert.equal(map.get('m3')!.id, 'w2', 'Testing → first active status');
    assert.equal(map.get('m5')!.id, 'w5', "Done → Done by name, not the first closed status (Won't do)");
  });
  await test('statusMapping wins, but closed must stay closed', () => {
    assert.equal(mapStatuses(mobile, web, { m3: 'w3' }).map.get('m3')!.id, 'w3');
    assert.ok(mapStatuses(mobile, web, { m2: 'w5' }).errors['statusMapping.m2'], 'open → closed refused');
    assert.ok(mapStatuses(mobile, web, { m5: 'w2' }).errors['statusMapping.m5'], 'closed → open refused');
    assert.ok(mapStatuses(mobile, web, { m1: 'nope' }).errors['statusMapping.m1'], 'unknown target');
    assert.ok(mapStatuses(mobile, web, { x: 'w1' }).errors['statusMapping.x'], 'unknown source');
  });
  await test('a same-name status of the wrong kind is skipped', () => {
    const odd = [st('o1', 'To do', C.not_started, 0), st('o2', 'Active', C.active, 1), st('o3', 'In review', C.review, 2), st('o4', 'Done', C.closed, 3)];
    const src = [st('s1', 'Done', C.active, 0)]; // an open status called "Done"
    assert.equal(mapStatuses(src, odd).map.get('s1')!.id, 'o2');
  });

  await test('custom fields carry over by name and type; dropdown choices by label', () => {
    const f = (id: string, name: string, fieldType: FieldType, options: unknown = null) => ({ id, name, fieldType, options, spaceId: 's', position: 0, createdAt: new Date(), updatedAt: new Date() }) as never;
    const m = mapFields(
      [f('a', 'Platform', FieldType.dropdown, [{ id: 'x1', label: 'iOS' }, { id: 'x2', label: 'Android' }]), f('b', 'Risk', FieldType.number), f('c', 'Notes', FieldType.text)],
      [f('A', 'platform', FieldType.dropdown, [{ id: 'y1', label: 'android' }]), f('B', 'Risk', FieldType.text)],
    );
    assert.equal(m.get('a')!.target!.id, 'A');
    assert.deepEqual([...m.get('a')!.options], [['x2', 'y1']], 'only Android has a match');
    assert.equal(m.get('b')!.target, null, 'different type');
    assert.equal(m.get('c')!.target, null, 'no such field');
  });

  // ── access rules, against a tiny fake database ──
  const db = {
    project: { findUnique: async () => ({ id: 'p', workspaceId: 'w', spaceId: 's', archivedAt: null, space: { id: 's', name: 'Web', visibility: visibility(), archivedAt: null }, workspace: { timezone: 'UTC', workingDays: [1] } }) },
    workspaceMember: { findUnique: async ({ where }: any) => people[where.workspaceId_userId.userId]?.ws ?? null },
    projectMember: { findUnique: async ({ where }: any) => people[where.projectId_userId.userId]?.pm ?? null },
    spaceMember: { findUnique: async ({ where }: any) => (people[where.spaceId_userId.userId]?.space ? {} : null) },
  };
  let vis: SpaceVisibility = SpaceVisibility.open;
  function visibility() { return vis; }
  const ws = (role: WorkspaceRole) => ({ role, workspaceId: 'w', canManageProjects: false });
  const people: Record<string, { ws: object; pm?: object; space?: boolean }> = {
    admin: { ws: ws(WorkspaceRole.admin) },
    pm: { ws: ws(WorkspaceRole.member), pm: { role: ProjectRole.project_manager }, space: true },
    dev: { ws: ws(WorkspaceRole.member), pm: { role: ProjectRole.team_member } },
    outsider: { ws: ws(WorkspaceRole.member) },
    guest: { ws: ws(WorkspaceRole.guest), pm: { role: ProjectRole.guest }, space: true },
  };
  const svc = new ProjectAccessService(db as never);
  const code = async (user: string, need: any) => {
    try { await svc.require('p', user, need); return 'ok'; } catch (e) { return (e as AppException).body.code; }
  };
  await test('who may read, work in and manage a project (open space)', async () => {
    assert.deepEqual(await Promise.all(['admin', 'pm', 'dev', 'outsider', 'guest', 'stranger'].map((u) => code(u, 'read'))), ['ok', 'ok', 'ok', 'FORBIDDEN', 'ok', 'NOT_FOUND']);
    assert.deepEqual(await Promise.all(['admin', 'pm', 'dev', 'guest'].map((u) => code(u, 'member'))), ['ok', 'ok', 'ok', 'FORBIDDEN']);
    assert.deepEqual(await Promise.all(['admin', 'pm', 'dev'].map((u) => code(u, 'manage'))), ['ok', 'ok', 'FORBIDDEN']);
    assert.deepEqual(await Promise.all(['admin', 'pm'].map((u) => code(u, 'admin'))), ['ok', 'FORBIDDEN']);
  });
  await test('in a Private space, people who cannot see the space get 404', async () => {
    vis = SpaceVisibility.private;
    assert.equal(await code('outsider', 'read'), 'NOT_FOUND');
    assert.equal(await code('dev', 'read'), 'NOT_FOUND', 'project member without the space row');
    assert.equal(await code('pm', 'read'), 'ok');
    vis = SpaceVisibility.open;
  });
  await test('archived space or project is read-only', () => {
    const base = { space: { name: 'Web', archivedAt: null }, archivedAt: null } as never as Parameters<typeof svc.assertWritable>[0];
    assert.doesNotThrow(() => svc.assertWritable(base));
    assert.throws(() => svc.assertWritable({ ...base, archivedAt: new Date() }), (e: AppException) => e.body.code === 'PROJECT_ARCHIVED');
    assert.throws(() => svc.assertWritable({ ...base, space: { ...base.space, archivedAt: new Date() } }), (e: AppException) => e.body.code === 'SPACE_ARCHIVED');
  });

  // ── request validation, through the same ValidationPipe settings as main.ts ──
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory });
  const validate = (body: object) => pipe.transform(body, { type: 'body', metatype: CreateProjectDto });
  await test('keyPrefix is upper-cased and checked; dates must be real dates', async () => {
    const ok = await validate({ name: 'Mobile Banking App', keyPrefix: ' mba ', startDate: '2027-01-10', endDate: '2027-04-30' });
    assert.equal(ok.keyPrefix, 'MBA');
    const bad = await validate({ name: 'X1', keyPrefix: '1AB', startDate: '2027-02-30', endDate: 'soon', templateId: 'x' }).catch((e: AppException) => e.body.fields!);
    assert.deepEqual(Object.keys(bad).sort(), ['endDate', 'keyPrefix', 'startDate', 'templateId']);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
