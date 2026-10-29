/*
 * Step-6 checks through the real HTTP server and WebSocket (uploads, download links, typing). The database is stubbed;
 * files are written to a temporary folder. Run: npm run test:integration
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log('  ok  ', name); };

(async () => {
  const uploads = mkdtempSync(join(tmpdir(), 'pm-uploads-'));
  process.env.JWT_ACCESS_SECRET = 'x'.repeat(40);
  process.env.JOBS_ENABLED = 'false';
  process.env.UPLOAD_DIR = uploads;
  process.env.GITHUB_WEBHOOK_SECRET = 'hook-secret';
  process.env.WEB_ORIGIN = 'https://app.example.com';
  const { PrismaService } = await import('../src/prisma/prisma.service');
  PrismaService.prototype.onModuleInit = async () => {};
  PrismaService.prototype.onModuleDestroy = async () => {};
  const { NestFactory } = await import('@nestjs/core');
  const { WsAdapter } = await import('@nestjs/platform-ws');
  const { JwtService } = await import('@nestjs/jwt');
  const { AppModule } = await import('../src/app.module');
  const { AllExceptionsFilter } = await import('../src/common/all-exceptions.filter');
  const { ProjectAccessService } = await import('../src/projects/project-access.service');
  const app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new WsAdapter(app));

  // ── stand-ins for the database ──
  const WS = '11111111-1111-4111-8111-111111111111';
  const TASK = '22222222-2222-4222-8222-222222222222';
  const rows: Record<string, any> = {};
  const prisma: any = app.get(PrismaService);
  prisma.task = { findUnique: async () => ({ projectId: 'p1' }) };
  prisma.attachment = {
    create: async ({ data }: any) => { const id = `33333333-3333-4333-8333-${String(Object.keys(rows).length).padStart(12, '0')}`; rows[id] = { id, createdAt: new Date(), uploadedBy: { id: data.uploadedById, fullName: 'Yonas' }, ...data }; return rows[id]; },
    findUnique: async ({ where }: any) => rows[where.id] ?? null,
  };
  prisma.$transaction = (fn: any) => fn(prisma);
  prisma.githubInstallation = { findUnique: async () => null };
  const people: Record<string, any> = { yonas: { id: 'yonas', email: 'yonas@company.com', fullName: 'Yonas', avatarUrl: null, twoFactorEnabled: false, twoFactorSecret: null, passwordHash: 'x' } };
  prisma.user = {
    findUniqueOrThrow: async ({ where }: any) => ({ ...people[where.id] }), // Prisma returns a new object
    update: async ({ where, data }: any) => ({ ...Object.assign(people[where.id], data) }),
  };
  prisma.channelMember = { findMany: async ({ where }: any) => (where.channelId === 'c1c1c1c1-0000-4000-8000-000000000001' ? [{ userId: 'yonas' }, { userId: 'meron' }] : []) };
  const access = app.get(ProjectAccessService);
  (access as any).require = async () => ({ project: { workspaceId: WS, keyPrefix: 'MBA', startDate: new Date('2027-02-01T00:00:00Z'), archivedAt: null, space: { archivedAt: null }, workspace: { timezone: 'Africa/Addis_Ababa' } }, isAdmin: false, isManager: true });
  prisma.timeEntry = {
    findMany: async () => [
      { userId: 'u1', taskId: 't1', minutes: 90, source: 'timer', note: '=SUM(A1)', startedAt: new Date('2027-02-10T07:00:00Z'), user: { id: 'u1', fullName: 'Meron Alemu' }, task: { id: 't1', number: 3, title: 'Balance API, v2', sprint: { id: 's2', name: 'Sprint 2' } } },
    ],
  };

  await app.listen(0);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const jwt = app.get(JwtService);
  const token = (sub: string) => jwt.signAsync({ sub }, { expiresIn: 60 });
  const auth = { Authorization: `Bearer ${await token('yonas')}` };
  const upload = (bytes: Uint8Array, name: string, type: string) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(bytes)], { type }), name);
    return fetch(`${base}/api/v1/tasks/${TASK}/attachments`, { method: 'POST', headers: auth, body: form });
  };

  await test('uploads over 20 MB are refused with 413 FILE_TOO_LARGE, and nothing is stored', async () => {
    const res = await upload(new Uint8Array(20 * 1024 * 1024 + 1), 'huge.zip', 'application/zip');
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as any).error.code, 'FILE_TOO_LARGE');
    assert.equal(readdirSync(uploads).length, 0);
  });
  await test('a request without a file gets a clear validation error', async () => {
    const res = await fetch(`${base}/api/v1/tasks/${TASK}/attachments`, { method: 'POST', headers: auth, body: new FormData() });
    assert.equal(res.status, 400);
    assert.ok('file' in ((await res.json()) as any).error.fields);
  });
  let pngId = '';
  await test('upload, get a short-lived link, download without logging in', async () => {
    const bytes = new TextEncoder().encode('\x89PNG fake image bytes');
    const res = await upload(bytes, '../screen shot.png', 'image/png');
    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.fileName, 'screen shot.png');
    pngId = body.id;
    assert.equal(readdirSync(join(uploads, WS)).length, 1, 'stored under the workspace folder');
    const link = (await (await fetch(`${base}/api/v1/attachments/${pngId}`, { headers: auth })).json()) as any;
    assert.match(link.url, /^\/api\/v1\/files\/.+\..+\..+$/);
    assert.equal(link.expiresInSeconds, 300);
    const file = await fetch(`${base}${link.url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.match(file.headers.get('content-disposition')!, /^inline;/);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  });
  await test('a tampered link is refused with 410 LINK_EXPIRED', async () => {
    const link = (await (await fetch(`${base}/api/v1/attachments/${pngId}`, { headers: auth })).json()) as any;
    const res = await fetch(`${base}${link.url.slice(0, -2)}xx`);
    assert.equal(res.status, 410);
    assert.equal(((await res.json()) as any).error.code, 'LINK_EXPIRED');
  });
  await test('an uploaded SVG or HTML file is downloaded, never shown, so it cannot run script', async () => {
    const res = await upload(new TextEncoder().encode('<svg onload="alert(1)"/>'), 'logo.svg', 'image/svg+xml');
    const { id } = (await res.json()) as any;
    const link = (await (await fetch(`${base}/api/v1/attachments/${id}`, { headers: auth })).json()) as any;
    const file = await fetch(`${base}${link.url}`);
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.match(file.headers.get('content-disposition')!, /^attachment;/);
    assert.match(file.headers.get('content-security-policy')!, /sandbox/);
  });
  await test('time report: ?format=csv downloads a safe CSV file', async () => {
    const res = await fetch(`${base}/api/v1/projects/${TASK}/time-report?format=csv&from=2027-02-01&to=2027-02-28`, { headers: auth });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/csv/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="MBA-time-2027-02-01-to-2027-02-28.csv"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte-order mark, so Excel reads names correctly');
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes); // fetch's .text() would hide the mark
    assert.equal(text, '\uFEFFDate,Person,Task,Title,Sprint,Hours,Source,Note\r\n2027-02-10,Meron Alemu,MBA-3,"Balance API, v2",Sprint 2,1.5,timer,\'=SUM(A1)\r\n');
    const json = (await (await fetch(`${base}/api/v1/projects/${TASK}/time-report?from=2027-02-01&to=2027-02-28`, { headers: auth })).json()) as any;
    assert.equal(json.totalHours, 1.5);
    assert.deepEqual(json.byPerson, [{ user: { id: 'u1', fullName: 'Meron Alemu' }, hours: 1.5 }]);
  });
  await test('GitHub webhook: checked against the exact bytes GitHub signed', async () => {
    const { createHmac } = await import('crypto');
    const body = '{ "zen": "Design for failure.",\n  "installation": { "id": 1 } }'; // GitHub's own spacing
    const sig = (b: string) => `sha256=${createHmac('sha256', 'hook-secret').update(b).digest('hex')}`;
    const send = (b: string, signature: string) => fetch(`${base}/api/v1/webhooks/github`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': signature }, body: b });
    const ok = await send(body, sig(body));
    assert.equal(ok.status, 202);
    assert.equal(((await ok.json()) as any).note, 'installation not connected to any workspace');
    assert.equal((await send(body, sig(body.replace('  ', ' ')))).status, 401, 'signature of a re-serialised body');
    assert.equal((await send(body, 'sha256=00')).status, 401);
  });
  await test('GitHub callback: a forged or expired state goes back to the app with an error', async () => {
    const res = await fetch(`${base}/api/v1/github/callback?installation_id=77&state=forged.state`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location')!, /^https:\/\/app\.example\.com\/settings\/github\?status=error&message=/);
  });
  await test('GitHub API client: app token, installation token reused, all pages of repositories', async () => {
    const http = await import('http');
    const { generateKeyPairSync, createVerify } = await import('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      const json = (code: number, v: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (req.method === 'POST' && req.url === '/app/installations/77/access_tokens') {
        const [h, p, sgn] = auth.replace('Bearer ', '').split('.');
        if (!createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sgn, 'base64url')) return json(401, {});
        tokenRequests++;
        return json(201, { token: 'ghs_install', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (req.url?.startsWith('/installation/repositories') && auth === 'Bearer ghs_install') {
        const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
        const n = page === 1 ? 100 : 3;
        return json(200, { repositories: Array.from({ length: n }, (_, i) => ({ id: page * 1000 + i, full_name: `acme/repo-${page}-${i}`, private: true, html_url: 'https://github.com/acme' })) });
      }
      json(404, {});
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { GithubClient } = await import('../src/github/github-client');
    const cfg: any = { get: (k: string) => ({ GITHUB_API_URL: `http://127.0.0.1:${(server.address() as any).port}`, GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString().replace(/\n/g, '\\n') } as any)[k] };
    const client = new GithubClient(cfg);
    assert.equal((await client.repositories(77)).length, 103);
    assert.equal((await client.repositories(77)).length, 103);
    assert.equal(tokenRequests, 1, 'the installation token is reused');
    server.close();
  });
  await test('profile photo: a real PNG is stored and served publicly; old photo removed on replace', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a tiny png')]);
    const send = (bytes: Buffer, name: string, type: string) => { const f = new FormData(); f.append('file', new Blob([new Uint8Array(bytes)], { type }), name); return fetch(`${base}/api/v1/me/avatar`, { method: 'POST', headers: auth, body: f }); };
    const first = (await (await send(png, 'me.png', 'image/png')).json()) as any;
    assert.match(first.avatarUrl, /^\/api\/v1\/avatars\/[0-9a-f-]{36}\.png$/);
    const img = await fetch(`${base}${first.avatarUrl}`); // no login needed
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control')!, /immutable/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
    const second = (await (await send(png, 'new.png', 'image/png')).json()) as any;
    assert.notEqual(second.avatarUrl, first.avatarUrl);
    assert.equal((await fetch(`${base}${first.avatarUrl}`)).status, 404, 'old photo deleted');
  });
  await test('profile photo: SVG pretending to be PNG is refused; over 2 MB is 413; bad names are 404', async () => {
    const f = new FormData(); f.append('file', new Blob([new Uint8Array(Buffer.from('<svg onload="alert(1)"/>'))], { type: 'image/png' }), 'evil.png');
    const svg = await fetch(`${base}/api/v1/me/avatar`, { method: 'POST', headers: auth, body: f });
    assert.equal(svg.status, 400);
    const big = new FormData(); big.append('file', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }), 'big.png');
    assert.equal((await fetch(`${base}/api/v1/me/avatar`, { method: 'POST', headers: auth, body: big })).status, 413);
    assert.equal((await fetch(`${base}/api/v1/avatars/..%2F..%2Fetc%2Fpasswd`)).status, 404);
  });
  await test('two-factor setup returns a scannable QR code (PNG) and the otpauth link', async () => {
    const res = await fetch(`${base}/api/v1/me/2fa/enable`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.match(body.qrCode, /^data:image\/png;base64,/);
    assert.ok(Buffer.from(body.qrCode.split(',')[1], 'base64').subarray(1, 4).toString() === 'PNG');
    assert.match(body.otpauthUrl, /^otpauth:\/\/totp\/PM%20Platform:yonas%40company\.com\?secret=[A-Z2-7]{32}&issuer=PM%20Platform&algorithm=SHA1&digits=6&period=30$/);
    assert.ok(people.yonas.twoFactorSecret.startsWith('v1.'), 'stored encrypted');
    assert.equal(people.yonas.twoFactorEnabled, false, 'not on until confirmed');
  });
  await test('typing reaches the other channel members only, and only from members', async () => {
    const connect = async (user: string) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${await token(user)}`);
      const got: any[] = [];
      ws.on('message', (m) => got.push(JSON.parse(String(m))));
      await new Promise((r) => ws.on('open', r));
      return { ws, got };
    };
    const [yonas, meron, outsider] = await Promise.all([connect('yonas'), connect('meron'), connect('outsider')]);
    await sleep(150);
    yonas.ws.send(JSON.stringify({ event: 'typing', data: { channelId: 'c1c1c1c1-0000-4000-8000-000000000001' } }));
    outsider.ws.send(JSON.stringify({ event: 'typing', data: { channelId: 'c1c1c1c1-0000-4000-8000-000000000001' } }));
    await sleep(300);
    const typing = (c: { got: any[] }) => c.got.filter((m) => m.event === 'typing');
    assert.deepEqual(typing(meron).map((m) => m.data.userId), ['yonas']);
    assert.equal(typing(yonas).length, 0, 'not echoed to the sender');
    assert.equal(typing(outsider).length, 0);
    [yonas, meron, outsider].forEach((c) => c.ws.close());
  });

  await app.close();
  rmSync(uploads, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
