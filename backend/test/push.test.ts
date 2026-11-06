// The FCM sender against a fake Google: a service-account JWT signed with the key in the file is exchanged for an
// access token, each tablet gets one data message, and a token Google no longer knows is reported back.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { makeFcm } from '../src/push.js';
import { freePort } from './pg.js';

describe('makeFcm', () => {
  it('authenticates with a signed JWT, sends one message per token, and reports unregistered tokens', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), 'duck-fcm-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    writeFileSync(join(dir, 'sa.json'), JSON.stringify({ project_id: 'duckling-tablet', client_email: 'push@duckling-tablet.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token` }));
    const seen: { url: string; auth: string | undefined; body: string }[] = [];
    let tokenRequests = 0;
    const server = createServer((req, res) => {
      let data = ''; req.on('data', (c) => { data += c; });
      req.on('end', () => {
        seen.push({ url: req.url!, auth: req.headers.authorization, body: data });
        if (req.url === '/token') {
          tokenRequests++;
          const assertion = new URLSearchParams(data).get('assertion')!;
          const [h, p, sig] = assertion.split('.');
          const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
          const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
          if (!ok || claims.scope !== 'https://www.googleapis.com/auth/firebase.messaging') { res.writeHead(401); return res.end(); }
          res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }));
        }
        const msg = JSON.parse(data).message;
        if (msg.token === 'gone') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })); }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: `projects/duckling-tablet/messages/${msg.token}` }));
      });
    }).listen(port, '127.0.0.1');
    try {
      const push = makeFcm(loadConfig({ NODE_ENV: 'test', FCM_SERVICE_ACCOUNT_FILE: join(dir, 'sa.json'), FCM_ENDPOINT: base }), () => {});
      const r = await push(['tok-a', 'gone', 'tok-b'], { type: 'config-changed' });
      expect(r).toEqual({ sent: 2, dead: ['gone'] });
      expect(tokenRequests).toBe(1);
      const sends = seen.filter((s) => s.url === '/v1/projects/duckling-tablet/messages:send');
      expect(sends).toHaveLength(3);
      expect(sends.every((s) => s.auth === 'Bearer at-1')).toBe(true);
      const first = JSON.parse(sends[0].body).message;
      expect(first).toMatchObject({ token: 'tok-a', data: { type: 'config-changed' }, android: { priority: 'high' } });
      expect(first.notification).toBeUndefined();
      // The access token is reused.
      await push(['tok-a'], { type: 'config-changed' });
      expect(tokenRequests).toBe(1);
      // No file: nothing is sent and nothing fails.
      const off = makeFcm(loadConfig({ NODE_ENV: 'test' }), () => {});
      expect(await off(['tok-a'], { type: 'x' })).toEqual({ sent: 0, dead: [] });
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
