import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
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
const tickets: any[] = []; const attached: any[] = [];
let synthCalls = 0, azureUp = true;
const aiCalls: any[] = []; const pushes: { tokens: string[]; data: Record<string, string> }[] = []; let deadTokens: string[] = []; let aiUp: 'ok' | 'down' | 'refuse' = 'ok';
const ADMIN = 'admin-test-token-123456';
const HOOK = 'hook-secret-123';

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-'));
  ({ db } = await cluster.newDb());
  mails.length = 0; tickets.length = 0; attached.length = 0; synthCalls = 0; azureUp = true; aiCalls.length = 0; aiUp = 'ok'; pushes.length = 0; deadTokens = [];
  const cfg = loadConfig({
    NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local',
    ADMIN_TOKEN: ADMIN, ETDUCKY_WEBHOOK_SECRET: HOOK, TTS_DAILY_CHARS_PER_DEVICE: 200, PUBLIC_URL: 'https://api.test', AI_DAILY_CALLS: 'draw-with-me:3,*:1', AI_MAX_PROMPT_CHARS: 500,
  });
  ({ app } = await buildServer(cfg, {
    db, logger: false,
    mailer: { async send(to, _s, text) { mails.push({ to, text }); } },
    synth: async (text) => { synthCalls++; await new Promise((r) => setTimeout(r, 20)); return azureUp ? Buffer.from(`mp3:${text}`) : null; },
    createTicket: async (t) => { tickets.push(t); return `T-${tickets.length}`; },
    attachToTicket: async (ticketId, url, contentType) => { attached.push({ ticketId, url, contentType }); return true; },
    push: async (tokens, data) => { pushes.push({ tokens, data }); return { sent: tokens.length, dead: tokens.filter((t) => deadTokens.includes(t)) }; },
    complete: async (r) => {
      aiCalls.push(r);
      if (aiUp === 'down') return null;
      if (aiUp === 'refuse') return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } };
      return { status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: r.model, content: [{ type: 'text', text: `{"name":"${r.messages[0].content}"}` }], stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 40 } } };
    },
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
    // Removal: the record goes, the tablet's token answers 410 from then on, and its push token is used once more.
    const d2 = await pair(a.auth);
    await app.inject({ method: 'POST', url: '/device/checkin', headers: d2.dev, payload: { pushToken: 'fcm-gone' } });
    expect((await app.inject({ method: 'DELETE', url: `/devices/${d2.deviceId}`, headers: b.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/devices/${d2.deviceId}`, headers: a.auth })).json().ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.at(-1)).toEqual({ tokens: ['fcm-gone'], data: { type: 'config-changed' } });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d2.dev })).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: '/devices', headers: a.auth })).json().devices.map((x: any) => x.id)).not.toContain(d2.deviceId);
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
    // ET Ducky's automation webhook cannot sign: the secret as a bearer token works too, a wrong one does not.
    expect((await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', authorization: 'Bearer not-it' }, payload: body })).statusCode).toBe(401);
    const unsigned = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK}` }, payload: body });
    expect(unsigned.json().updated).toBe(1);
    // A delivery that names an event is applied once; one without an eventId is applied as it comes.
    const again = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', 'x-etducky-signature': sig }, payload: body });
    expect(again.json()).toEqual({ updated: 1 });
    const withId = JSON.stringify({ eventId: 'evt-7', ticketId: 'T-1', status: 'Planned' });
    const sigId = createHmac('sha256', HOOK).update(withId).digest('hex');
    const h = { 'content-type': 'application/json', 'x-etducky-signature': sigId };
    expect((await app.inject({ method: 'POST', url: '/hooks/etducky', headers: h, payload: withId })).json().updated).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/hooks/etducky', headers: h, payload: withId })).json().duplicate).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0].status).toBe('planned');

    // Pictures: private in storage, read by the family's parents, and by ET Ducky through a signed link.
    const rid = req1.json().id;
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 7)]);
    const up = await app.inject({ method: 'POST', url: `/requests/${rid}/attachments`, headers: { ...p.auth, 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ requestId: rid, contentType: 'image/png', size: 72 });
    expect(attached).toHaveLength(1);
    expect(attached[0].ticketId).toBe('T-1');
    expect(attached[0].url).toMatch(new RegExp(`^https://api.test/requests/${rid}/attachments/att_[\\w-]+\\?exp=\\d+&sig=[0-9a-f]{32}$`));
    const listed = (await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0];
    expect(listed.attachments).toHaveLength(1);
    const path = listed.attachments[0].url.replace('https://api.test', '');
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    const mine = await app.inject({ method: 'GET', url: path, headers: p.auth });
    expect(mine.statusCode).toBe(200); expect(mine.headers['content-type']).toBe('image/png'); expect(mine.rawPayload.equals(png)).toBe(true);
    const other = await signIn('other@example.com');
    expect((await app.inject({ method: 'GET', url: path, headers: other.auth })).statusCode).toBe(404);
    const signed = await app.inject({ method: 'GET', url: attached[0].url.replace('https://api.test', '') });
    expect(signed.statusCode).toBe(200); expect(signed.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: 'GET', url: attached[0].url.replace('https://api.test', '').replace(/sig=[0-9a-f]{4}/, 'sig=0000') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/requests/${rid}/attachments`, headers: { ...p.auth, 'content-type': 'text/plain' }, payload: 'hello' })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: `/requests/${rid}/attachments`, headers: { ...other.auth, 'content-type': 'image/png' }, payload: png })).statusCode).toBe(404);
    for (let i = 0; i < 4; i++) expect((await app.inject({ method: 'POST', url: `/requests/${rid}/attachments`, headers: { ...p.auth, 'content-type': 'image/jpeg' }, payload: png })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/requests/${rid}/attachments`, headers: { ...p.auth, 'content-type': 'image/jpeg' }, payload: png })).statusCode).toBe(409);

    const shipped = await publish('dino-dig', '1.0.0', { request: req1.json().id });
    expect(shipped.json().installedFor).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().apps.map((a: any) => a.id)).toContain('dino-dig');
    expect((await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0].status).toBe('shipped');
    expect((await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Next idea', description: 'Now allowed again' } })).statusCode).toBe(200);
  });
});

describe('parent PIN and second parent', () => {
  it('a PIN set on the website reaches every tablet; the first tablet can set it once; online checks work', async () => {
    const p = await signIn('pin@example.com'); const d1 = await pair(p.auth);
    expect((await app.inject({ method: 'GET', url: '/family', headers: p.auth })).json().pinSet).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d1.dev })).json().pinHash).toBeNull();
    // The tablet sets it first.
    expect((await app.inject({ method: 'PUT', url: '/device/pin', headers: d1.dev, payload: { pin: '12' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/device/pin', headers: d1.dev, payload: { pin: '4321' } })).json().set).toBe(true);
    expect((await app.inject({ method: 'PUT', url: '/device/pin', headers: d1.dev, payload: { pin: '9999' } })).statusCode).toBe(409);
    const sha = (pin: string) => createHash('sha256').update(`duckling:${pin}`).digest('hex');
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d1.dev })).json().pinHash).toBe(sha('4321'));
    expect((await app.inject({ method: 'POST', url: '/device/pin/verify', headers: d1.dev, payload: { pin: '4321' } })).json().ok).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/device/pin/verify', headers: d1.dev, payload: { pin: '4322' } })).json().ok).toBe(false);
    // The website changes it; a second tablet gets the new one.
    expect((await app.inject({ method: 'PUT', url: '/family/pin', headers: p.auth, payload: { pin: '2468' } })).json().set).toBe(true);
    const d2 = await pair(p.auth);
    expect(d2.config.pinHash).toBe(sha('2468'));
    expect((await app.inject({ method: 'GET', url: '/family', headers: p.auth })).json().pinSet).toBe(true);
    expect((await app.inject({ method: 'PUT', url: '/family/pin', headers: p.auth, payload: { pin: 'abcd' } })).statusCode).toBe(400);
    // Another family's PIN is its own.
    const o = await signIn('other-pin@example.com'); const od = await pair(o.auth);
    expect(od.config.pinHash).toBeNull();
  });

  it('invites a second parent by email link, refuses an address that has its own family, and removes a parent', async () => {
    const p = await signIn('one@example.com');
    const inv = await app.inject({ method: 'POST', url: '/family/parents/invite', headers: p.auth, payload: { email: 'two@example.com' } });
    expect(inv.json().sent).toBe(true);
    const mail = mails.filter((m) => m.to === 'two@example.com').at(-1)!;
    expect(mail.text).toContain('one@example.com invited you');
    const token = mail.text.match(/token=([\w-]+)/)![1];
    const v = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(v.statusCode).toBe(200);
    expect(v.json().familyId).toBe(p.familyId); expect(v.json().newFamily).toBe(false);
    const two = { authorization: `Bearer ${v.json().sessionToken}` };
    const fam = (await app.inject({ method: 'GET', url: '/family', headers: two })).json();
    expect(fam.parents.map((x: any) => [x.email, x.role])).toEqual([['one@example.com', 'owner'], ['two@example.com', 'parent']]);
    // The link works once; a plain sign-in afterwards lands in the same family.
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } })).statusCode).toBe(401);
    expect((await signIn('two@example.com')).familyId).toBe(p.familyId);
    // An address with its own family cannot be pulled into another.
    const solo = await signIn('solo@example.com');
    await app.inject({ method: 'POST', url: '/family/parents/invite', headers: p.auth, payload: { email: 'solo@example.com' } });
    const t2 = mails.filter((m) => m.to === 'solo@example.com').at(-1)!.text.match(/token=([\w-]+)/)![1];
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: { token: t2 } })).statusCode).toBe(409);
    expect((await signIn('solo@example.com')).familyId).toBe(solo.familyId);
    expect((await app.inject({ method: 'POST', url: '/family/parents/invite', headers: p.auth, payload: { email: 'TWO@example.com' } })).statusCode).toBe(409);
    // Removal.
    const twoId = fam.parents[1].id;
    expect((await app.inject({ method: 'DELETE', url: `/family/parents/${twoId}`, headers: two })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/family/parents/${twoId}`, headers: solo.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/family/parents/${twoId}`, headers: p.auth })).json().ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/family', headers: two })).statusCode).toBe(401);
    expect((await signIn('two@example.com')).familyId).not.toBe(p.familyId);
  });
});

describe('push', () => {
  it('tells the tablets concerned after a parent change, and forgets tokens FCM no longer knows', async () => {
    const p = await signIn('push@example.com'); const d1 = await pair(p.auth); const d2 = await pair(p.auth);
    await app.inject({ method: 'POST', url: '/device/checkin', headers: d1.dev, payload: { pushToken: 'fcm-1' } });
    await app.inject({ method: 'POST', url: '/device/checkin', headers: d2.dev, payload: { pushToken: 'fcm-2' } });
    await publish('music-box', '1.0.0');
    const settle = () => new Promise((r) => setTimeout(r, 50));
    // One device: only its token.
    await app.inject({ method: 'PUT', url: `/devices/${d1.deviceId}/hidden/music-box`, headers: p.auth, payload: {} });
    await settle();
    expect(pushes).toEqual([{ tokens: ['fcm-1'], data: { type: 'config-changed' } }]);
    // The family PIN: every device.
    await app.inject({ method: 'PUT', url: '/family/pin', headers: p.auth, payload: { pin: '1234' } });
    await settle();
    expect(pushes.at(-1)!.tokens.sort()).toEqual(['fcm-1', 'fcm-2']);
    // A child's profile: every device. A dead token is forgotten and not pushed again.
    deadTokens = ['fcm-2'];
    const child = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ada' } })).json();
    await app.inject({ method: 'PUT', url: `/children/${child.id}`, headers: p.auth, payload: { firstName: 'Ada B' } });
    await settle();
    expect(pushes.at(-1)!.tokens.sort()).toEqual(['fcm-1', 'fcm-2']);
    await app.inject({ method: 'POST', url: `/devices/${d2.deviceId}/travel`, headers: p.auth, payload: { hours: 2 } });
    await settle();
    expect(pushes).toHaveLength(3);
    // A device without a token, or a released one, gets nothing; a device's own check-in pushes nothing.
    await app.inject({ method: 'POST', url: `/devices/${d1.deviceId}/release`, headers: p.auth, payload: {} });
    await settle();
    expect(pushes).toHaveLength(4);
    await app.inject({ method: 'POST', url: '/device/released', headers: d1.dev });
    await app.inject({ method: 'PUT', url: '/family/pin', headers: p.auth, payload: { pin: '4321' } });
    await settle();
    expect(pushes).toHaveLength(4);
  });
});

describe('ai proxy', () => {
  it('forwards Messages calls with the server key, limits calls per app per day, and gives failed calls back', async () => {
    const p = await signIn('ai@example.com'); const d = await pair(p.auth);
    const call = (appId: string, over: Record<string, unknown> = {}, headers: Record<string, string> = d.dev) => app.inject({
      method: 'POST', url: '/ai/messages', headers: { ...headers, 'x-duckling-app': appId },
      payload: { model: 'claude-sonnet-5-5', max_tokens: 3000, system: 'You make drawing lessons.', messages: [{ role: 'user', content: 'a monkey' }], ...over },
    });
    const r1 = await call('draw-with-me');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().content[0].text).toBe('{"name":"a monkey"}');
    expect(r1.headers['cache-control']).toBe('private, no-store');
    expect(aiCalls[0]).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 3000, system: 'You make drawing lessons.', messages: [{ role: 'user', content: 'a monkey' }] });
    // A model outside the allowlist is served with the default model.
    expect((await call('draw-with-me', { model: 'claude-3-opus-20240229' })).statusCode).toBe(200);
    expect(aiCalls[1].model).toBe('claude-haiku-5-5');
    // The third call is the last one today for this app on this device; the fourth is refused without reaching Anthropic.
    expect((await call('draw-with-me')).statusCode).toBe(200);
    expect((await call('draw-with-me')).statusCode).toBe(429);
    expect(aiCalls).toHaveLength(3);
    // Another app has its own allowance; a second device too.
    expect((await call('story-maker')).statusCode).toBe(200);
    expect((await call('story-maker')).statusCode).toBe(429);
    const d2 = await pair(p.auth);
    expect((await call('draw-with-me', {}, d2.dev)).statusCode).toBe(200);
    // Counts only: the admin sees calls and tokens, never prompts.
    const stats = (await app.inject({ method: 'GET', url: '/admin/stats', headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(stats.aiToday).toEqual([{ appId: 'draw-with-me', calls: 4, inputTokens: 480, outputTokens: 160 }, { appId: 'story-maker', calls: 1, inputTokens: 120, outputTokens: 40 }]);
    expect(JSON.stringify(stats)).not.toContain('monkey');

    // Validation: the app header, the body shape, sizes, the device token.
    expect((await app.inject({ method: 'POST', url: '/ai/messages', headers: d2.dev, payload: { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } })).statusCode).toBe(400);
    expect((await call('music-box', { max_tokens: 99999 }, d2.dev)).statusCode).toBe(400);
    expect((await call('music-box', { messages: [{ role: 'user', content: 'x'.repeat(400) }], system: 'y'.repeat(200) }, d2.dev)).statusCode).toBe(413);
    expect((await call('music-box', { tools: [] }, d2.dev)).statusCode).toBe(400);
    expect((await call('music-box', {}, {})).statusCode).toBe(401);
    expect(aiCalls).toHaveLength(5);

    // Upstream down or refusing: the child's allowance is not spent.
    aiUp = 'down';
    expect((await call('music-box', {}, d2.dev)).statusCode).toBe(503);
    aiUp = 'refuse';
    expect((await call('music-box', {}, d2.dev)).statusCode).toBe(502);
    aiUp = 'ok';
    expect((await call('music-box', {}, d2.dev)).statusCode).toBe(200);
    expect((await call('music-box', {}, d2.dev)).statusCode).toBe(429);
  });
});

describe('cross-origin access', () => {
  it('lets the portal and the web app use every verb, and no other origin', async () => {
    const portal = 'https://parents.ducklingtablet.com';
    for (const [method, url] of [['DELETE', '/devices/dev_x'], ['PUT', '/devices/dev_x/apps/music-box'], ['POST', '/requests'], ['GET', '/family']]) {
      const r = await app.inject({ method: 'OPTIONS', url, headers: { origin: portal, 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' } });
      expect(r.statusCode, `${method} ${url}`).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(portal);
      expect(String(r.headers['access-control-allow-methods'])).toContain(method);
      expect(String(r.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');
    }
    const other = await app.inject({ method: 'OPTIONS', url: '/family', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
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
      complete: async () => ({ status: 400, body: { type: 'error', error: { message: 'prompt-echo-Scarlettina' } } }),
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
      // A refused AI call is logged by status only: no prompt, no upstream message.
      const ai = await app2.inject({ method: 'POST', url: '/ai/messages', headers: { authorization: `Device ${deviceToken}`, 'x-duckling-app': 'draw-with-me' },
        payload: { model: 'm', max_tokens: 10, system: 'secret-system-prompt', messages: [{ role: 'user', content: 'Draw Scarlettina a cat' }] } });
      expect(ai.statusCode).toBe(502); expect(ai.body).not.toContain('prompt-echo');
      expect((await app2.inject({ method: 'GET', url: '/boom?pin=1234' })).statusCode).toBe(500);
    } finally { await app2.close(); await db2.close(); }

    const out = lines.join('');
    expect(out).toContain('"url":"/auth/verify"');
    expect(out).toContain('"url":"/tts"');
    expect(out).toContain('request failed');
    expect(out).toContain('route not found');
    expect(out).toContain('duplicate key value');
    expect(token && session && code && deviceToken).toBeTruthy();
    for (const secret of [token, session, deviceToken, code, 'leaked-token-value-123456', 'Scarlettina', 'logs@example.com', 'pin=1234', 'Tap this link', 'already exists', 'secret-system-prompt', 'prompt-echo']) {
      expect(out, `log output must not contain ${secret}`).not.toContain(secret);
    }
  });

  it('a failing mail server gives a 503 and leaks nothing into the log', async () => {
    const lines: string[] = [];
    const { db: db2 } = await cluster.newDb();
    const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files3'), STORAGE: 'local', ADMIN_TOKEN: ADMIN });
    const { app: app2 } = await buildServer(cfg, {
      db: db2, logger: { level: 'info', stream: { write(c: string) { lines.push(c); } } },
      mailer: { async send() { const e = new Error('connect ETIMEDOUT 1.2.3.4:587') as Error & { code?: string }; e.code = 'ETIMEDOUT'; throw e; } },
      synth: async () => null, createTicket: async () => null,
    });
    try {
      const r = await app2.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'nobody@example.com' } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/try again/);
    } finally { await app2.close(); await db2.close(); }
    const out = lines.join('');
    expect(out).toContain('sign-in email failed');
    expect(out).toContain('ETIMEDOUT');
    expect(out).not.toContain('nobody@example.com');
    expect(out).not.toContain('token=');
  });

  it('production settings refuse to run without SMTP, so sign-in links never go to the log', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), ADMIN_TOKEN: 'y'.repeat(40), DATABASE_URL_APP: 'postgresql://a:b@db.internal:25060/duckling', DATABASE_URL_SYSTEM: 'postgresql://c:d@db.internal:25060/duckling' };
    expect(() => loadConfig({ ...prod, SMTP_HOST: '' })).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...prod, SMTP_HOST: 'smtp.sendgrid.net' })).not.toThrow();
    expect(() => loadConfig({ ...prod, SMTP_HOST: 'smtp.sendgrid.net', DATABASE_URL_APP: 'postgresql://duckling_app:duckling@127.0.0.1:5432/duckling' })).toThrow(/DATABASE_URL_APP/);
  });
});
