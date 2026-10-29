/* Step-8 checks (GitHub, activity) that need no database. Run: npx ts-node test/github.check.ts */
import { strict as assert } from 'node:assert';
import { createHmac, createVerify, generateKeyPairSync } from 'crypto';
import { appJwt, findTaskKeys, makeInstallState, readInstallState, verifyWebhookSignature } from '../src/github/github-signing';
import { WebhookService } from '../src/github/webhook.service';
import { PrismaService } from '../src/prisma/prisma.service';

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };
const SECRET = 'x'.repeat(40);

(async () => {
  await test('task keys are found in messages, branch names and PR text', () => {
    assert.deepEqual(findTaskKeys('MBA-3: add balance endpoint (also MBA-3, MBA-007)'), ['MBA-3', 'MBA-7']);
    assert.deepEqual(findTaskKeys('feature/mba-8-cache', 'fix_MBA_9'), ['MBA-8', 'MBA-9']);
    assert.deepEqual(findTaskKeys('X-1 ABCDEF-2 email@mba-3.com'), [], 'prefix of 2–5 characters; not inside words, emails or domains');
    assert.deepEqual(findTaskKeys(null, undefined, ''), []);
  });
  await test('webhook signatures: only the exact body with the right secret passes', () => {
    const body = Buffer.from('{"zen":"Keep it simple."}');
    const sig = `sha256=${createHmac('sha256', 'hook-secret').update(body).digest('hex')}`;
    assert.equal(verifyWebhookSignature('hook-secret', body, sig), true);
    assert.equal(verifyWebhookSignature('hook-secret', Buffer.from('{"zen":"Keep it  simple."}'), sig), false, 'one extra space');
    assert.equal(verifyWebhookSignature('other', body, sig), false);
    assert.equal(verifyWebhookSignature('hook-secret', body, undefined), false);
    assert.equal(verifyWebhookSignature('', body, sig), false, 'no secret configured: refuse everything');
  });
  await test('install state: signed, tied to one workspace and Admin, valid 30 minutes', () => {
    const now = Date.parse('2027-02-10T09:00:00Z');
    const state = makeInstallState(SECRET, 'ws-1', 'abel', now);
    assert.deepEqual(readInstallState(SECRET, state, now + 29 * 60_000), { workspaceId: 'ws-1', userId: 'abel' });
    assert.equal(readInstallState(SECRET, state, now + 31 * 60_000), null, 'expired');
    assert.equal(readInstallState('y'.repeat(40), state, now), null);
    const [payload, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ w: 'ws-2', u: 'abel', e: 9e9 })).toString('base64url');
    assert.equal(readInstallState(SECRET, `${forged}.${sig}`, now), null, 'workspace swapped');
    assert.equal(readInstallState(SECRET, `${payload}`, now), null);
  });
  await test('the GitHub App token is a valid RS256 JWT issued by the app', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const now = Date.parse('2027-02-10T09:00:00Z');
    const [h, p, s] = appJwt('123456', pem, now).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.equal(claims.iss, '123456');
    assert.equal(claims.exp - claims.iat, 600);
    assert.ok(claims.iat * 1000 < now, 'issued slightly in the past for clock drift');
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url'));
  });

  // ── the webhook handler over an in-memory database ──
  const world = () => {
    const links = new Map<string, any>();
    const merged: string[] = [];
    const tasks: Record<string, string> = { 'p-mba:3': 't3', 'p-mba:8': 't8', 'p-cpo:1': 'c1' };
    const db: any = {
      githubInstallation: { findUnique: async ({ where }: any) => (where.installationId === 77n ? { id: 'inst', workspaceId: 'ws' } : null) },
      repository: {
        upsert: async ({ where }: any) => ({ id: 'repo', installationId: 'inst', fullName: 'acme/mobile-banking',
          projects: where.githubRepoId === 501n ? [{ project: { id: 'p-mba', keyPrefix: 'MBA' } }] : [] }),
      },
      task: { findUnique: async ({ where }: any) => (tasks[`${where.projectId_number.projectId}:${where.projectId_number.number}`] ? { id: tasks[`${where.projectId_number.projectId}:${where.projectId_number.number}`] } : null) },
      codeLink: {
        findUnique: async ({ where }: any) => { const k = where.taskId_repositoryId_kind_externalId; return links.get(`${k.taskId}|${k.kind}|${k.externalId}`) ?? null; },
        upsert: async ({ create, update }: any) => { const key = `${create.taskId}|${create.kind}|${create.externalId}`; links.set(key, { ...(links.get(key) ?? create), ...update }); },
      },
    };
    db.tx = PrismaService.prototype.tx;
    db.$transaction = (fn: any) => fn(db);
    const automations: any = { onPullRequestMerged: async (_tx: unknown, taskId: string) => { merged.push(taskId); return true; } };
    return { svc: new WebhookService(db, automations, { log: async () => undefined } as any), links, merged };
  };
  const repo = { id: 501, html_url: 'https://github.com/acme/mobile-banking', full_name: 'acme/mobile-banking' };
  const push = {
    installation: { id: 77 }, repository: repo, ref: 'refs/heads/feature/MBA-8-cache',
    commits: [{ id: 'a1b2c3', message: 'MBA-3 balance endpoint\n\nAlso CPO-1 and MBA-99', url: 'https://github.com/acme/mobile-banking/commit/a1b2c3' }],
  };
  await test('push: the branch and the commit are linked to the tasks they name, in linked projects only', async () => {
    const w = world();
    assert.deepEqual(await w.svc.handle('push', push), { linked: 2, moved: 0 });
    assert.deepEqual([...w.links.keys()].sort(), ['t3|commit|a1b2c3', 't8|branch|feature/MBA-8-cache']);
    assert.equal(w.links.get('t3|commit|a1b2c3').title, 'MBA-3 balance endpoint', 'first line of the message');
    assert.deepEqual(await w.svc.handle('push', push), { linked: 0, moved: 0 }, "GitHub's redelivery changes nothing");
  });
  await test('pull request: open, then merged moves the task once (pr_merged)', async () => {
    const w = world();
    const pr = (merged: boolean) => ({
      installation: { id: 77 }, repository: repo, action: merged ? 'closed' : 'opened',
      pull_request: { number: 12, title: 'Account summary cache', body: 'Closes MBA-8', html_url: 'https://github.com/acme/mobile-banking/pull/12', state: merged ? 'closed' : 'open', merged, head: { ref: 'feature/cache' } },
    });
    assert.deepEqual(await w.svc.handle('pull_request', pr(false)), { linked: 1, moved: 0 });
    assert.equal(w.links.get('t8|pull_request|12').state, 'open');
    assert.deepEqual(await w.svc.handle('pull_request', pr(true)), { linked: 1, moved: 1 });
    assert.equal(w.links.get('t8|pull_request|12').state, 'merged');
    assert.deepEqual(w.merged, ['t8']);
    assert.deepEqual(await w.svc.handle('pull_request', pr(true)), { linked: 0, moved: 0 }, 'redelivered: not moved again');
  });
  await test('unknown installations, unlinked repositories and other events are ignored', async () => {
    const w = world();
    assert.equal((await w.svc.handle('push', { ...push, installation: { id: 999 } })).note, 'installation not connected to any workspace');
    assert.equal((await w.svc.handle('push', { ...push, repository: { ...repo, id: 502 } })).note, 'repository not linked to a project');
    assert.equal((await w.svc.handle('issues', push)).note, 'ignored issues');
    assert.equal((await w.svc.handle('ping', {})).note, 'pong');
    assert.equal(w.links.size, 0);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
