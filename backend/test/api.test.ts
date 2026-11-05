import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { Db } from '../src/db.js';
import { startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string;
const mails: { to: string; text: string }[] = [];
const tickets: any[] = [];
let synthCalls = 0, azureUp = true;
const ADMIN = 'admin-test-token-123456';
const HOOK = 'hook-secret-123';

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-'));
  ({ db } = await cluster.newDb());
  mails.length = 0; tickets.length = 0; synthCalls = 0; azureUp = true;
  const cfg = loadConfig({
    NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local',
    ADMIN_TOKEN: ADMIN, ETDUCKY_WEBHOOK_SECRET: HOOK, TTS_DAILY_CHARS_PER_DEVICE: 200, PUBLIC_URL: 'https://api.test',
  });
  ({ app } = await buildServer(cfg, {
    db, logger: false,
    mailer: { async send(to, _s, text) { mails.push({ to, text }); } },
    synth: async (text) => { synthCalls++; await new Promise((r) => setTimeout(r, 20)); return azureUp ? Buffer.from(`mp3:${text}`) : null; },
    createTicket: async (t) => { tickets.push(t); return `T-${tickets.length}`; },
  }));
});
afterEach(async () => { await app.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

async function signIn(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email } });
  const token = mails.filter((m) => m.to === email).at(-1)!.text.match(/token=([\w-]+)/)![1];
  const r = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
  expect(r.statusCode).toBe(200);
  return { auth: { authorization: `Bearer ${r.json().sessionToken}` }, ...r.json() };
}
async function publish(id: string, version: string, opts: { starter?: boolean; request?: string } = {}) {
  await app.inject({ method: 'PUT', url: `/admin/apps/${id}`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: id, starter: !!opts.starter } });
  return app.inject({ method: 'POST', url: `/admin/apps/${id}/versions?version=${version}&signature=${'s'.repeat(64)}${opts.request ? `&request=${opts.request}` : ''}`,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/zip' }, payload: Buffer.alloc(100, 1) });
}
async function pair(auth: any, childId?: string) {
  const code = (await app.inject({ method: 'POST', url: '/devices/pairing-codes', headers: auth, payload: { childId } })).json().code;
  const r = await app.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'android', name: 'Tablet' } });
  expect(r.statusCode).toBe(200);
  return { dev: { authorization: `Device ${r.json().deviceToken}` }, ...r.json() };
}

describe('parent sign-in', () => {
  it('creates a family on first link and reuses it after; links work once', async () => {
    const a = await signIn('mom@example.com');
    expect(a.newFamily).toBe(true);
    const b = await signIn('MOM@example.com');
    expect(b.familyId).toBe(a.familyId);
    const token = mails.at(-1)!.text.match(/token=([\w-]+)/)![1];
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/family' })).statusCode).toBe(401);
  });
});

describe('children, devices and apps', () => {
  it('pairs a device with a child, installs starters, lets the child install and uninstall freely', async () => {
    await publish('word-wizard', '1.0.0', { starter: true });
    await publish('robot-path', '1.0.0');
    const p = await signIn('dad@example.com');
    const child = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ada', grade: '2', levels: { reading: 4, math: 5 } } })).json();
    expect(child.levels.math).toBe(5);
    const d = await pair(p.auth, child.id);
    expect(d.config.child.firstName).toBe('Ada');
    expect(d.config.apps.map((a: any) => a.id)).toEqual(['word-wizard']);
    expect((await app.inject({ method: 'PUT', url: '/device/apps/robot-path', headers: d.dev })).statusCode).toBe(200);
    let cfg = (await app.inject({ method: 'POST', url: '/device/checkin', headers: d.dev, payload: { battery: 80 } })).json();
    expect(cfg.apps.map((a: any) => a.id).sort()).toEqual(['robot-path', 'word-wizard']);
    expect(cfg.apps[0].url).toMatch(/^https:\/\/api\.test\/files\/packages\//);
    await app.inject({ method: 'DELETE', url: '/device/apps/robot-path', headers: d.dev });
    cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json();
    expect(cfg.apps.map((a: any) => a.id)).toEqual(['word-wizard']);
  });

  it('a hidden app is removed and cannot be reinstalled by the child', async () => {
    await publish('robot-path', '1.0.0', { starter: true });
    const p = await signIn('p@example.com'); const d = await pair(p.auth);
    await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/hidden/robot-path`, headers: p.auth });
    expect((await app.inject({ method: 'PUT', url: '/device/apps/robot-path', headers: d.dev })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().apps).toEqual([]);
  });

  it('settings, travel mode and release', async () => {
    const p = await signIn('p@example.com'); const d = await pair(p.auth);
    const bad = await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/settings`, headers: p.auth, payload: { allowlist: [{ host: 'not a host' }] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/settings`, headers: p.auth,
      payload: { allowlist: [{ host: 'pbskids.org', tile: { name: 'PBS KIDS', url: 'https://pbskids.org/games' } }], limits: { dailyMinutes: 90 } } });
    expect(ok.json().allowlist[0].host).toBe('pbskids.org');
    expect((await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/travel`, headers: p.auth, payload: {} })).json().active).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/travel`, headers: p.auth, payload: { hours: 0 } })).json().active).toBe(false);
    await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/release`, headers: p.auth });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().state).toBe('release');
    await app.inject({ method: 'POST', url: '/device/released', headers: d.dev });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().state).toBe('released');
  });

  it('one family cannot touch another family\'s device or child', async () => {
    const a = await signIn('a@example.com'); const b = await signIn('b@example.com');
    const d = await pair(a.auth);
    const child = (await app.inject({ method: 'POST', url: '/children', headers: a.auth, payload: { firstName: 'Kid' } })).json();
    expect((await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/release`, headers: b.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/children/${child.id}`, headers: b.auth, payload: { firstName: 'X' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/devices/pairing-codes', headers: b.auth, payload: { childId: child.id } })).statusCode).toBe(404);
  });

  it('pairing codes work once', async () => {
    const p = await signIn('p@example.com');
    const code = (await app.inject({ method: 'POST', url: '/devices/pairing-codes', headers: p.auth, payload: {} })).json().code;
    expect((await app.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'ios', name: 'iPad' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'ios', name: 'iPad' } })).statusCode).toBe(400);
  });
});

describe('catalog and publishing', () => {
  it('needs the admin token, requires increasing versions, lists the newest', async () => {
    expect((await app.inject({ method: 'PUT', url: '/admin/apps/x-app', payload: { name: 'X' } })).statusCode).toBe(401);
    expect((await publish('circuit-lab', '1.0.0')).statusCode).toBe(200);
    expect((await publish('circuit-lab', '1.2.0')).statusCode).toBe(200);
    expect((await publish('circuit-lab', '1.1.0')).statusCode).toBe(400);
    const cat = (await app.inject({ method: 'GET', url: '/catalog' })).json();
    expect(cat.apps[0].latest.version).toBe('1.2.0');
    expect((await app.inject({ method: 'GET', url: '/files/packages/circuit-lab/1.2.0.zip' })).statusCode).toBe(200);
  });
});

describe('voice cache', () => {
  it('synthesizes a line once for every device, keeps private lines out of the cache, caps uncached text', async () => {
    const p = await signIn('p@example.com'); const d1 = await pair(p.auth); const d2 = await pair(p.auth);
    const url = '/tts?text=' + encodeURIComponent('Spell the word cat.');
    const [r1, r2] = await Promise.all([app.inject({ method: 'GET', url, headers: d1.dev }), app.inject({ method: 'GET', url, headers: d2.dev })]);
    expect(r1.statusCode).toBe(302); expect(r2.statusCode).toBe(302);
    expect(r1.headers.location).toBe(r2.headers.location);
    expect(synthCalls).toBe(1);
    const r3 = await app.inject({ method: 'GET', url, headers: d1.dev });
    expect(r3.statusCode).toBe(302); expect(synthCalls).toBe(1);
    expect((await app.inject({ method: 'GET', url: r1.headers.location!.replace('https://api.test', '') })).body).toBe('mp3:Spell the word cat.');

    const priv = await app.inject({ method: 'GET', url: '/tts?private=1&text=' + encodeURIComponent('Great job, Ada!'), headers: d1.dev });
    expect(priv.statusCode).toBe(200); expect(priv.headers['content-type']).toBe('audio/mpeg');
    const stats = (await app.inject({ method: 'GET', url: '/admin/stats', headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(stats.voiceClips.n).toBe(1);

    const long = 'x'.repeat(190);
    expect((await app.inject({ method: 'GET', url: '/tts?text=' + long, headers: d1.dev })).statusCode).toBe(429);
    azureUp = false;
    expect((await app.inject({ method: 'GET', url: '/tts?text=Hello', headers: d2.dev })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/tts?text=Hello&voice=bad', headers: d2.dev })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/tts?text=Hello' })).statusCode).toBe(401);
  });

  it('pre-generates an app\'s lines', async () => {
    const r = await app.inject({ method: 'POST', url: '/admin/voice/pregenerate', headers: { authorization: `Bearer ${ADMIN}` },
      payload: { lines: [{ text: 'Hello' }, { text: 'Hello ' }, { text: 'Bye' }] } });
    expect(r.json()).toEqual({ created: 2, cached: 1, failed: 0 });
  });
});

describe('app requests', () => {
  it('creates an ET Ducky ticket, allows one open request, follows ticket status, ships and installs', async () => {
    const p = await signIn('p@example.com'); const d = await pair(p.auth);
    const req1 = await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Dinosaur dig', description: 'Fossils and measuring', childGrade: '2' } });
    expect(req1.statusCode).toBe(200);
    expect(tickets[0].title).toBe('Dinosaur dig');
    expect((await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Another one', description: 'Second request here' } })).statusCode).toBe(409);

    const body = JSON.stringify({ ticketId: 'T-1', status: 'In Progress' });
    const bad = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', 'x-etducky-signature': 'nope' }, payload: body });
    expect(bad.statusCode).toBe(401);
    const sig = createHmac('sha256', HOOK).update(body).digest('hex');
    const good = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', 'x-etducky-signature': sig }, payload: body });
    expect(good.json().updated).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0].status).toBe('building');
    // A redelivery of the same event changes nothing, whether identified by eventId, by the delivery header or by body.
    const again = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', 'x-etducky-signature': sig }, payload: body });
    expect(again.json()).toEqual({ duplicate: true, updated: 0 });
    const withId = JSON.stringify({ eventId: 'evt-7', ticketId: 'T-1', status: 'Planned' });
    const sigId = createHmac('sha256', HOOK).update(withId).digest('hex');
    const h = { 'content-type': 'application/json', 'x-etducky-signature': sigId };
    expect((await app.inject({ method: 'POST', url: '/hooks/etducky', headers: h, payload: withId })).json().updated).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/hooks/etducky', headers: h, payload: withId })).json().duplicate).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0].status).toBe('planned');

    const shipped = await publish('dino-dig', '1.0.0', { request: req1.json().id });
    expect(shipped.json().installedFor).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().apps.map((a: any) => a.id)).toContain('dino-dig');
    expect((await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0].status).toBe('shipped');
    expect((await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Next idea', description: 'Now allowed again' } })).statusCode).toBe(200);
  });
});

describe('account deletion', () => {
  it('deletes the family and tells its devices to release', async () => {
    const p = await signIn('p@example.com'); const d = await pair(p.auth);
    expect((await app.inject({ method: 'DELETE', url: '/family', headers: p.auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/family', headers: p.auth, payload: { confirm: 'DELETE' } })).json().deleted).toBe(true);
    const r = await app.inject({ method: 'GET', url: '/device/config', headers: d.dev });
    expect(r.statusCode).toBe(410); expect(r.json().error).toBe('release');
    expect((await app.inject({ method: 'GET', url: '/family', headers: p.auth })).statusCode).toBe(401);
  });
});

describe('logs', () => {
  it('carry no tokens, query strings, child names or email bodies', async () => {
    const lines: string[] = [];
    const stream = { write(chunk: string) { lines.push(chunk); } };
    const { db: db2 } = await cluster.newDb();
    const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files2'), STORAGE: 'local', ADMIN_TOKEN: ADMIN, TTS_DAILY_CHARS_PER_DEVICE: 200 });
    const { app: app2 } = await buildServer(cfg, {
      db: db2, logger: { level: 'info', stream },
      mailer: { async send(to, _s, text) { mails.push({ to, text }); } },
      synth: async (text) => Buffer.from(`mp3:${text}`), createTicket: async () => null,
    });
    // A 500 is logged without the driver's detail text (which can carry row values).
    app2.get('/boom', async () => { const e = new Error('duplicate key value violates unique constraint') as Error & { detail?: string }; e.detail = 'Key (email)=(logs@example.com) already exists.'; throw e; });
    let token = '', session = '', code = '', deviceToken = '';
    try {
      await app2.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'logs@example.com' } });
      token = mails.filter((m) => m.to === 'logs@example.com').at(-1)!.text.match(/token=([\w-]+)/)![1];
      const v = await app2.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
      session = v.json().sessionToken as string;
      const auth = { authorization: `Bearer ${session}`, cookie: `dt_session=${session}` };
      const child = (await app2.inject({ method: 'POST', url: '/children', headers: auth, payload: { firstName: 'Scarlettina' } })).json();
      code = (await app2.inject({ method: 'POST', url: '/devices/pairing-codes', headers: auth, payload: { childId: child.id } })).json().code;
      deviceToken = (await app2.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'android', name: 'Tablet' } })).json().deviceToken;
      await app2.inject({ method: 'GET', url: '/tts?text=' + encodeURIComponent('Hello Scarlettina, spell cat.'), headers: { authorization: `Device ${deviceToken}` } });
      await app2.inject({ method: 'GET', url: '/nope?token=' + token, headers: { authorization: 'Bearer leaked-token-value-123456' } });
      expect((await app2.inject({ method: 'GET', url: '/boom?pin=1234' })).statusCode).toBe(500);
    } finally { await app2.close(); await db2.close(); }

    const out = lines.join('');
    expect(out).toContain('"url":"/auth/verify"');
    expect(out).toContain('"url":"/tts"');
    expect(out).toContain('request failed');
    expect(out).toContain('route not found');
    expect(out).toContain('duplicate key value');
    expect(token && session && code && deviceToken).toBeTruthy();
    for (const secret of [token, session, deviceToken, code, 'leaked-token-value-123456', 'Scarlettina', 'logs@example.com', 'pin=1234', 'Tap this link', 'already exists']) {
      expect(out, `log output must not contain ${secret}`).not.toContain(secret);
    }
  });

  it('production settings refuse to run without SMTP, so sign-in links never go to the log', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), ADMIN_TOKEN: 'y'.repeat(40), DATABASE_URL_APP: 'postgresql://a:b@db.internal:25060/duckling', DATABASE_URL_SYSTEM: 'postgresql://c:d@db.internal:25060/duckling' };
    expect(() => loadConfig({ ...prod, SMTP_HOST: '' })).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...prod, SMTP_HOST: 'smtp.sendgrid.net' })).not.toThrow();
    expect(() => loadConfig({ ...prod, SMTP_HOST: 'smtp.sendgrid.net', DATABASE_URL_APP: 'postgresql://duckling_app:duckling@127.0.0.1:5432/duckling' })).toThrow(/DATABASE_URL_APP/);
  });
});
