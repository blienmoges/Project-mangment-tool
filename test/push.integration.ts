/*
 * Step-10 check: real Web Push (encryption + VAPID signature) against a local stand-in push service over HTTPS.
 * Needs the openssl command for a throw-away certificate; skipped without it. Run: npm run test:integration
 */
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createECDH, randomBytes } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { readFileSync } from 'fs';
import * as webpush from 'web-push';
import { PushService } from '../src/notifications/push.service';
(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'));
  try {
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${join(dir, 'key.pem')} -out ${join(dir, 'cert.pem')} -days 1 -subj "/CN=127.0.0.1"`, { stdio: 'ignore' });
  } catch {
    console.log('  skipped: openssl is not installed\n\n0 checks passed');
    return;
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // trust the throw-away certificate, in this test process only
  const seen: { path: string; headers: http.IncomingHttpHeaders; bytes: number }[] = [];
  const server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    let n = 0; req.on('data', (c) => (n += c.length));
    req.on('end', () => { seen.push({ path: req.url!, headers: req.headers, bytes: n }); res.writeHead(req.url === '/gone' ? 410 : 201); res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `https://127.0.0.1:${(server.address() as any).port}`;
  const vapid = webpush.generateVAPIDKeys();
  const browserKey = () => createECDH('prime256v1').generateKeys('base64url');
  const subs = [
    { id: 's1', endpoint: `${base}/ok`, p256dh: browserKey(), auth: randomBytes(16).toString('base64url') },
    { id: 's2', endpoint: `${base}/gone`, p256dh: browserKey(), auth: randomBytes(16).toString('base64url') },
  ];
  const deleted: string[] = [];
  const prisma: any = { pushSubscription: { findMany: async () => subs, deleteMany: async ({ where }: any) => deleted.push(where.id) } };
  const svc = new PushService(prisma, { get: (k: string) => ({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:admin@example.com' } as any)[k] } as any);
  const r = await svc.sendToUser('u1', { title: 'Task overdue', body: 'MBA-9 is overdue', url: 'https://app/tasks/9' });
  const ok = seen.find((s) => s.path === '/ok')!;
  assert.equal(ok.headers['content-encoding'], 'aes128gcm', 'payload encrypted as browsers expect');
  assert.match(String(ok.headers.authorization), /^vapid t=.+, k=.+$/, 'signed with the VAPID key');
  assert.ok(ok.bytes > 100 && ok.bytes < 400);
  console.log('  ok   web push: encrypted, signed and delivered to the push service');
  assert.equal(r.providerMessageId, 'push:1/2');
  assert.deepEqual(deleted, ['s2']);
  console.log('  ok   a subscription the browser withdrew (410) is deleted; the others still get it');
  server.close();
  console.log('\n2 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
