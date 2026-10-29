/* Step-6 checks (messaging, comments, files) that need no database. Run: npx ts-node test/messaging.check.ts */
import { strict as assert } from 'node:assert';
import { AppException } from '../src/common/app-exception';
import { mentionedIds, plainText, preview } from '../src/common/mentions';
import { cleanName } from '../src/files/attachments.service';
import { makeDownloadToken, readDownloadToken } from '../src/files/download-token';
import { MessagingService } from '../src/messaging/messaging.service';
import { PrismaService } from '../src/prisma/prisma.service';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const MERON = '6f1d2c3b-4a59-4e8f-9d0c-1b2a3c4d5e6f';
const SARA = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

(async () => {
  await test('mentions are found by id, once each, and shown as @Name in plain text', () => {
    const text = `Hi @[Meron Alemu](${MERON}) and @[Sara Kebede](${SARA}), thanks @[Meron Alemu](${MERON.toUpperCase()})! email@example.com @nobody`;
    assert.deepEqual(mentionedIds(text), [MERON, SARA]);
    assert.equal(plainText(text), 'Hi @Meron Alemu and @Sara Kebede, thanks @Meron Alemu! email@example.com @nobody');
    assert.equal(preview('a'.repeat(200), 20), `${'a'.repeat(17)}...`);
  });
  await test('download links: work for 5 minutes, refuse tampering and expiry', () => {
    const secret = 'x'.repeat(40);
    const now = Date.parse('2027-02-10T09:00:00Z');
    const { token, expiresAt } = makeDownloadToken(secret, 'att-1', now);
    assert.equal(expiresAt.toISOString(), '2027-02-10T09:05:00.000Z');
    assert.equal(readDownloadToken(secret, token, now + 60_000), 'att-1');
    assert.equal(readDownloadToken(secret, token, now + 6 * 60_000), null, 'expired');
    assert.equal(readDownloadToken('y'.repeat(40), token, now), null, 'other secret');
    const [id, exp, sig] = token.split('.');
    assert.equal(readDownloadToken(secret, `att-2.${exp}.${sig}`, now), null, 'other file');
    assert.equal(readDownloadToken(secret, `${id}.${Number(exp) + 3600}.${sig}`, now), null, 'longer life');
    assert.equal(readDownloadToken(secret, 'garbage', now), null);
  });
  await test('file names keep no folders or control characters', () => {
    assert.equal(cleanName('../../etc/passwd'), 'passwd');
    assert.equal(cleanName('C:\\Users\\Hana\\screen shot "1".png'), 'screen shot 1.png');
    assert.equal(cleanName(''), 'file');
    assert.equal(cleanName(`${'a'.repeat(300)}.log`).length, 255);
  });

  // ── sending a message, over an in-memory database ──
  const channel = { id: 'c1', workspaceId: 'w1', type: 'project', projectId: 'p1', teamId: null, createdAt: new Date() };
  const members = ['blien', 'yonas', MERON];
  const make = (opts: { archived?: boolean } = {}) => {
    const notified: any[] = [];
    const pushed: any[] = [];
    const messages: any[] = [];
    const tx: any = {
      message: {
        create: async ({ data }: any) => { const m = { id: `m${messages.length + 1}`, editedAt: null, createdAt: new Date(), ...data }; messages.push(m); return m; },
        findUniqueOrThrow: async ({ where }: any) => ({ ...messages.find((m) => m.id === where.id), sender: { id: 'yonas', fullName: 'Yonas Bekele', avatarUrl: null }, attachments: [] }),
      },
      channelMember: { update: async () => ({}), findMany: async () => members.map((userId) => ({ userId })) },
      channel: { findUniqueOrThrow: async () => ({ ...channel, project: { keyPrefix: 'MBA' }, team: null }) },
    };
    const prisma: any = {
      channelMember: { findUnique: async ({ where }: any) => (members.includes(where.channelId_userId.userId) ? { channel } : null) },
      project: { findUnique: async () => ({ archivedAt: opts.archived ? new Date() : null, space: { archivedAt: null } }) },
      tx: PrismaService.prototype.tx,
      $transaction: (fn: any) => fn(tx),
    };
    const realtime: any = { emitToUsers: (ids: string[], event: string, data: any) => { pushed.push({ ids, event, data }); return ids.length; } };
    const notifications: any = { notify: async (_tx: unknown, n: any) => { notified.push({ ...n, pushedBefore: pushed.length }); return []; } };
    const svc = new MessagingService(prisma, realtime, {} as any, notifications, {} as any);
    return { svc, notified, pushed };
  };
  await test('sending: members get message.created after the commit; mentions notify only channel members', async () => {
    const { svc, notified, pushed } = make();
    const msg = await svc.send('c1', 'yonas', `Build ready @[Meron Alemu](${MERON}) and @[Sara Kebede](${SARA})`);
    assert.deepEqual(msg.mentions, [MERON, SARA]);
    assert.equal(notified.length, 1);
    assert.deepEqual(notified[0].userIds, [MERON], 'Sara is not in this channel');
    assert.equal(notified[0].eventType, 'mention');
    assert.match(notified[0].body, /Yonas Bekele mentioned you in the MBA channel: "Build ready @Meron Alemu and @Sara Kebede"/);
    assert.equal(notified[0].pushedBefore, 0, 'nothing pushed before the commit');
    assert.deepEqual(pushed.map((p) => [p.event, p.ids]), [['message.created', members]]);
  });
  await test('outsiders get 404; empty messages and archived projects are refused', async () => {
    const { svc } = make();
    await assert.rejects(svc.send('c1', 'stranger', 'hi'), (e: AppException) => e.body.code === 'NOT_FOUND');
    await assert.rejects(svc.send('c1', 'yonas', '   '), (e: AppException) => e.body.code === 'VALIDATION_FAILED');
    await assert.rejects(make({ archived: true }).svc.send('c1', 'yonas', 'hi'), (e: AppException) => e.body.code === 'PROJECT_ARCHIVED');
  });
  await test('direct messages: not with yourself, not with Guests', async () => {
    const prisma: any = {
      workspaceMember: {
        findMany: async () => [{ workspaceId: 'w1', role: 'member' }],
        findUniqueOrThrow: async () => ({ role: 'guest' }),
      },
    };
    const svc = new MessagingService(prisma, {} as any, {} as any, {} as any, {} as any);
    await assert.rejects(svc.openDirect('yonas', { userId: 'yonas' }), (e: AppException) => e.body.code === 'VALIDATION_FAILED');
    await assert.rejects(svc.openDirect('yonas', { userId: 'client' }), (e: AppException) => e.body.code === 'FORBIDDEN');
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
