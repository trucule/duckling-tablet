import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { Db } from '../src/db.js';
import { startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string;
const mails: { to: string; subject?: string; text: string }[] = [];
const tickets: any[] = []; const attached: any[] = [];
let synthCalls = 0, azureUp = true, etduckyUp = true;
const aiCalls: any[] = []; const pushes: { tokens: string[]; data: Record<string, string> }[] = []; let deadTokens: string[] = []; let aiUp: 'ok' | 'down' | 'refuse' = 'ok';
const ADMIN = 'admin-test-token-123456';
const HOOK = 'hook-secret-123';

// A fake web for the site icon fetcher: pbskids.org links a touch icon behind a redirect; nothing else answers.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const siteFetches: string[] = [];
function fakeSite(url: string) {
  const html = (b: string) => ({ status: 200, type: 'text/html', body: Buffer.from(b) });
  if (url === 'https://pbskids.org/') return { status: 301, type: '', body: Buffer.alloc(0), location: 'https://pbskids.org/home' };
  if (url === 'https://pbskids.org/home') return html('<head><link rel="icon" href="/fav-16.png" sizes="16x16"><link rel=apple-touch-icon href="/touch.png?v=2&amp;x=1"></head>');
  if (url === 'https://pbskids.org/touch.png?v=2&x=1') return { status: 200, type: 'image/png', body: PNG };
  return { status: 404, type: 'text/html', body: Buffer.from('no') };
}

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-'));
  ({ db } = await cluster.newDb());
  mails.length = 0; tickets.length = 0; attached.length = 0; synthCalls = 0; azureUp = true; etduckyUp = true; aiCalls.length = 0; siteFetches.length = 0; aiUp = 'ok'; pushes.length = 0; deadTokens = [];
  const cfg = loadConfig({
    NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local',
    ADMIN_TOKEN: ADMIN, ETDUCKY_WEBHOOK_SECRET: HOOK, TTS_DAILY_CHARS_PER_DEVICE: 200, PUBLIC_URL: 'https://api.test', AI_DAILY_CALLS: 'draw-with-me:3,*:1', AI_MAX_PROMPT_CHARS: 500, STATS_EMAILS: ' Owner@Example.com ,other@example.com',
  });
  ({ app } = await buildServer(cfg, {
    db, logger: false,
    mailer: { async send(to, subject, text) { mails.push({ to, subject, text }); } },
    synth: async (text) => { synthCalls++; await new Promise((r) => setTimeout(r, 20)); return azureUp ? Buffer.from(`mp3:${text}`) : null; },
    createTicket: async (t) => { if (!etduckyUp) return null; tickets.push(t); return `T-${tickets.length}`; },
    attachToTicket: async (ticketId, url, contentType) => { attached.push({ ticketId, url, contentType }); return true; },
    fetchUrl: async (url) => { siteFetches.push(url); return fakeSite(url); },
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
    // The refusal names the field's own problem, and a pasted address is taken as its site name.
    expect(bad.json().issues[0]).toMatch(/Use a site name like pbskids.org/);
    const pasted = await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/settings`, headers: p.auth,
      payload: { allowlist: [{ host: 'https://www.Kleki.com/draw?x=1', tile: { name: 'Kleki', url: 'https://www.kleki.com/draw?x=1' } }, { host: '*.Example.org.' }] } });
    expect(pasted.statusCode).toBe(200);
    expect(pasted.json().allowlist.map((w: { host: string }) => w.host)).toEqual(['kleki.com', '*.example.org']);
    expect((await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/settings`, headers: p.auth,
      payload: { allowlist: [{ host: 'kleki.com', tile: { name: 'K', url: 'javascript:alert(1)' } }] } })).statusCode).toBe(400);
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/settings`, headers: p.auth,
      payload: { allowlist: [{ host: 'pbskids.org', tile: { name: 'PBS KIDS', url: 'https://pbskids.org/games' } }], limits: { dailyMinutes: 90 } } });
    expect(ok.json().allowlist[0].host).toBe('pbskids.org');
    // The tablet gets the hosts PBS KIDS plays its videos from, and nothing else outside the site.
    const media = (await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().mediaHosts;
    expect(media).toEqual(['kids.pbs-video.pbs.org', 'proxy.drm.pbs.org', 'urs-anonymous-detect.pbs.org', 'urs.pbs.org']);
    expect(media.some((h: string) => h === 'pbs.org' || /google|2mdn|sentry/.test(h))).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/travel`, headers: p.auth, payload: {} })).json().active).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/travel`, headers: p.auth, payload: { hours: 0 } })).json().active).toBe(false);
    await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/release`, headers: p.auth });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().state).toBe('release');
    await app.inject({ method: 'POST', url: '/device/released', headers: d.dev });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().state).toBe('released');
  });

  it('a website tile gets the site\'s own icon, fetched once, and only for allowed sites', async () => {
    expect((await app.inject({ method: 'GET', url: '/site-icon/pbskids.org' })).statusCode).toBe(404);
    expect(siteFetches).toEqual([]); // no family allows it yet, so nothing is fetched
    const p = await signIn('p@example.com'); const d = await pair(p.auth);
    await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/settings`, headers: p.auth,
      payload: { allowlist: [{ host: 'pbskids.org', tile: { name: 'PBS KIDS', url: 'https://pbskids.org/games' } }, { host: 'example.org', tile: { name: 'E', url: 'https://example.org' } }] } });
    const r = await app.inject({ method: 'GET', url: '/site-icon/pbskids.org' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload.equals(PNG)).toBe(true);
    const n = siteFetches.length;
    expect((await app.inject({ method: 'GET', url: '/site-icon/pbskids.org' })).statusCode).toBe(200);
    expect(siteFetches.length).toBe(n); // the stored copy, no second fetch
    expect((await app.inject({ method: 'GET', url: '/site-icon/example.org' })).statusCode).toBe(404);
    const m = siteFetches.length;
    expect((await app.inject({ method: 'GET', url: '/site-icon/example.org' })).statusCode).toBe(404);
    expect(siteFetches.length).toBe(m); // a miss is remembered
    expect((await app.inject({ method: 'GET', url: '/site-icon/127.0.0.1' })).statusCode).toBe(404);
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

  it('installs starters only at pairing: a later publish never adds an app to a paired tablet, it waits in the Library', async () => {
    await publish('music-box', '1.0.0', { starter: true });
    const p = await signIn('starter@example.com');
    const child = (await app.inject({ method: 'POST', url: '/family/children', headers: p.auth, payload: { firstName: 'Ada', age: 6 } })).json();
    const t = await pair(p.auth, child.id);
    const installed = async () => (await app.inject({ method: 'GET', url: '/device/config', headers: t.dev })).json().apps.map((a: any) => a.id).sort();
    expect(await installed()).toEqual(['music-box']);
    // A new app published after the tablet was paired, starter or not, stays out of its tiles and is in the catalog.
    await publish('my-avatar', '1.0.0');
    await publish('word-wizard', '1.0.0', { starter: true });
    expect(await installed()).toEqual(['music-box']);
    expect((await app.inject({ method: 'GET', url: '/catalog' })).json().apps.map((a: any) => a.id).sort()).toEqual(['music-box', 'my-avatar', 'word-wizard']);
    // Installing it from the Library puts the tile on; a later publish does not remove or re-add anything.
    expect((await app.inject({ method: 'PUT', url: '/device/apps/my-avatar', headers: t.dev })).statusCode).toBe(200);
    expect(await installed()).toEqual(['music-box', 'my-avatar']);
    await publish('my-avatar', '1.0.1', { starter: true });
    expect(await installed()).toEqual(['music-box', 'my-avatar']);
    // A tablet paired now gets every starter, including the ones published since.
    const t2 = await pair(p.auth, child.id);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t2.dev })).json().apps.map((a: any) => a.id).sort()).toEqual(['music-box', 'my-avatar', 'word-wizard']);
  });
});

describe('app about and demo', () => {
  it('keeps the About text and the recording on the catalog entry', async () => {
    const about = { concept: 'Sequencing.', progression: 'Turns, then repeats.', lifeSkills: ['Planning', 'Fixing mistakes'] };
    const h = { authorization: `Bearer ${ADMIN}` };
    await publish('robot-path', '1.0.0');
    expect((await app.inject({ method: 'PUT', url: '/admin/apps/robot-path', headers: h, payload: { name: 'Robot Path', about } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/admin/apps/robot-path', headers: h, payload: { name: 'Robot Path', about: { concept: 'x' } } })).statusCode).toBe(400);
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 0)]);
    expect((await app.inject({ method: 'PUT', url: '/admin/apps/robot-path/demo', headers: { ...h, 'content-type': 'image/gif' }, payload: Buffer.alloc(64, 0) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/admin/apps/robot-path/demo', headers: { ...h, 'content-type': 'image/gif' }, payload: gif })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/admin/apps/robot-path/demo', headers: { 'content-type': 'image/gif' }, payload: gif })).statusCode).toBe(401);
    const a = (await (await app.inject({ method: 'GET', url: '/catalog' })).json()).apps.find((x: any) => x.id === 'robot-path');
    expect(a.about).toEqual(about);
    expect(a.demoUrl).toMatch(/^https:\/\/api\.test\/files\/demos\/robot-path-[0-9a-f]{12}\.gif$/);
    expect((await app.inject({ method: 'GET', url: a.demoUrl.replace('https://api.test', '') })).statusCode).toBe(200);
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
  it('a tablet asks for an app in the same queue as the portal, with its child\'s grade, and can withdraw it', async () => {
    const p = await signIn('p@example.com');
    const child = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ada', grade: '2' } })).json();
    const d = await pair(p.auth, child.id);
    expect((await app.inject({ method: 'POST', url: '/device/requests', payload: { title: 'Dino', description: 'Counting dinosaurs to twenty.' } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/device/requests', headers: d.dev, payload: { title: 'Dino', description: 'Counting dinosaurs to twenty.', childGrade: '8' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ title: 'Dino', childGrade: '2', status: 'requested' });
    expect(tickets.at(-1)).toMatchObject({ title: 'Dino', childGrade: '2' });
    // The family's one open request: the portal and the tablet both see it, and neither can add a second.
    expect((await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Another', description: 'Another app for the queue.' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/device/requests', headers: d.dev })).json().requests.map((x: any) => x.title)).toEqual(['Dino']);
    // Another family's tablet sees none of it and cannot withdraw it.
    const o = await signIn('o@example.com'); const od = await pair(o.auth);
    expect((await app.inject({ method: 'GET', url: '/device/requests', headers: od.dev })).json().requests).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/device/requests/${r.json().id}/withdraw`, headers: od.dev })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/device/requests/${r.json().id}/withdraw`, headers: d.dev })).json().status).toBe('withdrawn');
    expect((await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests[0].status).toBe('withdrawn');
  });

  it('ET Ducky Resolved or Closed finishes the request: no Withdraw, the slot frees; other spellings map too', async () => {
    const p = await signIn('done@example.com'); await pair(p.auth);
    const hook = (ticketId: string, status: string) => app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK}` }, payload: { ticketId, status } });
    const make = async (title: string) => {
      const r = (await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title, description: 'An app for the queue test' } })).json();
      const [{ etducky_ticket_id: t }] = await db.system((q) => q.all('SELECT etducky_ticket_id FROM app_request WHERE id = $1', [r.id]));
      return { id: r.id as string, ticket: String(t) };
    };
    const statusOf = async (id: string) => (await app.inject({ method: 'GET', url: '/requests', headers: p.auth })).json().requests.find((x: any) => x.id === id).status;
    const a = await make('First app');
    expect((await hook(a.ticket, 'in_progress')).json().updated).toBe(1);
    expect(await statusOf(a.id)).toBe('building');
    expect((await hook(a.ticket, 'Resolved')).json().updated).toBe(1);
    expect(await statusOf(a.id)).toBe('done');
    expect((await app.inject({ method: 'POST', url: `/requests/${a.id}/withdraw`, headers: p.auth })).statusCode).toBe(409);
    const b = await make('Second app'); // the slot is free again
    expect((await hook(b.ticket, 'OnHold')).json().updated).toBe(1);
    expect(await statusOf(b.id)).toBe('planned');
    expect((await hook(b.ticket, 'CLOSED')).json().updated).toBe(1);
    expect(await statusOf(b.id)).toBe('done');
    expect((await hook(b.ticket, 'Escalated to vendor')).json()).toEqual({ ignored: true });
  });

  it('lets a parent withdraw a request in progress: the slot frees, the ticket no longer moves it, no ticket is sent later', async () => {
    const p = await signIn('wd@example.com'); await pair(p.auth);
    const first = (await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Test one', description: 'Just trying the form' } })).json();
    const w = await app.inject({ method: 'POST', url: `/requests/${first.id}/withdraw`, headers: p.auth });
    expect(w.json().status).toBe('withdrawn');
    expect((await app.inject({ method: 'POST', url: `/requests/${first.id}/withdraw`, headers: p.auth })).statusCode).toBe(409);
    const hook = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK}` }, payload: { ticketId: 'T-1', status: 'In Progress' } });
    expect(hook.json().updated).toBe(0);
    etduckyUp = false;
    const second = (await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Bird songs', description: 'Match the song to the bird' } })).json();
    expect(second.status).toBe('requested');
    await app.inject({ method: 'POST', url: `/requests/${second.id}/withdraw`, headers: p.auth });
    etduckyUp = true;
    expect((await app.inject({ method: 'POST', url: '/admin/requests/tickets', headers: { authorization: `Bearer ${ADMIN}` } })).json().created).toBe(0);
    // Another family cannot withdraw it.
    const other = await signIn('other-wd@example.com');
    expect((await app.inject({ method: 'POST', url: `/requests/${second.id}/withdraw`, headers: other.auth })).statusCode).toBe(404);
  });

  it('opens the ET Ducky ticket later for a request made while ET Ducky could not take it, with its pictures', async () => {
    const p = await signIn('late@example.com'); await pair(p.auth);
    etduckyUp = false;
    const r = await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Bird songs', description: 'Match the song to the bird' } });
    expect(r.statusCode).toBe(200);
    const rid = r.json().id;
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 7)]);
    expect((await app.inject({ method: 'POST', url: `/requests/${rid}/attachments`, headers: { ...p.auth, 'content-type': 'image/png' }, payload: png })).statusCode).toBe(200);
    expect(tickets).toHaveLength(0); expect(attached).toHaveLength(0);
    const admin = { authorization: `Bearer ${ADMIN}` };
    expect((await app.inject({ method: 'POST', url: '/admin/requests/tickets', headers: admin })).json()).toEqual({ configured: false, waiting: 1, created: 0 });
    etduckyUp = true;
    expect((await app.inject({ method: 'POST', url: '/admin/requests/tickets', headers: admin })).json()).toEqual({ configured: false, waiting: 0, created: 1 });
    expect(tickets[0]).toMatchObject({ requestId: rid, title: 'Bird songs' });
    expect(attached).toEqual([expect.objectContaining({ ticketId: 'T-1', contentType: 'image/png' })]);
    expect(attached[0].url).toMatch(new RegExp(`^https://api.test/requests/${rid}/attachments/att_`));
    // Nothing waits now; the ticket's status reaches the request as usual.
    expect((await app.inject({ method: 'POST', url: '/admin/requests/tickets', headers: admin })).json()).toEqual({ configured: false, waiting: 0, created: 0 });
    const hook = await app.inject({ method: 'POST', url: '/hooks/etducky', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK}` }, payload: { ticketId: 'T-1', status: 'Planned' } });
    expect(hook.json().updated).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/admin/requests/tickets' })).statusCode).toBe(401);
  });

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

describe('starting levels', () => {
  it('starts every subject two years below the child\'s age, lets the parent choose, and keeps the age right', async () => {
    const p = await signIn('levels@example.com');
    const seven = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ada', age: 7 } })).json();
    expect(seven.age).toBe(7);
    expect(seven.levels).toEqual({ reading: 0, math: 0, science: 0, logic: 0, art: 0, music: 0 }); // kindergarten level
    const four = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Bo', age: 4 } })).json();
    expect(four.levels.math).toBe(-1); // pre-K is the floor
    const teen = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Cy', age: 16 } })).json();
    expect(teen.levels.math).toBe(8); // 8th grade is the ceiling
    const chosen = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Di', age: 9, startGrade: 4, levels: { reading: 6 } } })).json();
    expect(chosen.levels).toMatchObject({ math: 4, reading: 6 });
    expect((await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ed', startGrade: 9 } })).statusCode).toBe(400);
    // Later changes: one subject, or every subject at once, and the age.
    const up = (await app.inject({ method: 'PUT', url: `/children/${seven.id}`, headers: p.auth, payload: { levels: { math: 2 } } })).json();
    expect(up.levels).toMatchObject({ math: 2, reading: 0 });
    const all = (await app.inject({ method: 'PUT', url: `/children/${seven.id}`, headers: p.auth, payload: { startGrade: 1, age: 8 } })).json();
    expect(all.levels).toEqual({ reading: 1, math: 1, science: 1, logic: 1, art: 1, music: 1 });
    expect(all.age).toBe(8);
    // A tablet sees the levels in its config.
    const d = await pair(p.auth, seven.id);
    expect(d.config.child.levels.math).toBe(1);
    expect(d.config.child.age).toBe(8);
  });
});

describe('one-device signup', () => {
  it('pairs a tablet from an emailed code, creating the family, the child and the free trial in one step', async () => {
    await publish('music-box', '1.0.0', { starter: true });
    expect((await app.inject({ method: 'POST', url: '/auth/code', payload: { email: 'code@example.com' } })).json().sent).toBe(true);
    const mail = mails.filter((m) => m.to === 'code@example.com').at(-1)!;
    const code = mail.subject!.match(/^(\d{3}) (\d{3}) is your/)!.slice(1).join('');
    expect(mail.text).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
    const tablet = { platform: 'android', name: 'Kitchen tablet', shellVersion: '1.0.0' };
    // Wrong codes count; the right one works once.
    expect((await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'code@example.com', code: code === '000000' ? '000001' : '000000', ...tablet } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'code@example.com', code, childFirstName: 'Ada', childAge: 6, ...tablet } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.newFamily).toBe(true);
    expect(j.config.child.firstName).toBe('Ada');
    expect(j.config.child.levels).toEqual({ reading: -1, math: -1, science: -1, logic: -1, art: -1, music: -1 });
    expect(j.config.child.age).toBe(6);
    expect(j.config.apps.map((a: any) => a.id)).toContain('music-box');
    expect(j.config.entitlement).toMatchObject({ status: 'trial', source: 'trial', daysLeft: 7 });
    expect((await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'code@example.com', code, ...tablet } })).statusCode).toBe(401);
    // The parent signs in to the portal later and finds the same family, child and trial.
    const p = await signIn('code@example.com');
    const fam = (await app.inject({ method: 'GET', url: '/family', headers: p.auth })).json();
    expect(fam.children.map((c: any) => c.firstName)).toEqual(['Ada']);
    expect(fam.devices.map((d: any) => d.name)).toEqual(['Kitchen tablet']);
    expect(fam.subscription).toMatchObject({ status: 'trial', daysLeft: 7 });
    // A second tablet with the same email and child name joins the existing family and child; five misses end a code.
    await app.inject({ method: 'POST', url: '/auth/code', payload: { email: 'code@example.com' } });
    const code2 = mails.filter((m) => m.to === 'code@example.com').at(-1)!.subject!.match(/^(\d{3}) (\d{3})/)!.slice(1).join('');
    const r2 = (await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'CODE@example.com', code: code2, childFirstName: 'ada', ...tablet, name: 'Car tablet' } })).json();
    expect(r2.newFamily).toBe(false);
    expect(r2.config.child.id).toBe(j.config.child.id);
    await app.inject({ method: 'POST', url: '/auth/code', payload: { email: 'code@example.com' } });
    const code3 = mails.filter((m) => m.to === 'code@example.com').at(-1)!.subject!.match(/^(\d{3}) (\d{3})/)!.slice(1).join('');
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'code@example.com', code: code3 === '111111' ? '111112' : '111111', ...tablet } });
    expect((await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'code@example.com', code: code3, ...tablet } })).statusCode).toBe(401);
    // A family made from the portal gets the trial too.
    const other = await signIn('portal-trial@example.com');
    expect((await app.inject({ method: 'GET', url: '/family', headers: other.auth })).json().subscription.status).toBe('trial');
  });

  it('locks the tablet when the trial ends: config says so, and installs, requests, the AI writer and narration are refused until a subscription', async () => {
    await publish('word-wizard', '1.0.0', { starter: true });
    await publish('music-box', '1.0.0');
    const p = await signIn('ends@example.com');
    const child = (await app.inject({ method: 'POST', url: '/family/children', headers: p.auth, payload: { firstName: 'Ada', age: 6 } })).json();
    const t = await pair(p.auth, child.id);
    const cfg = async () => (await app.inject({ method: 'GET', url: '/device/config', headers: t.dev })).json();
    expect((await cfg()).locked).toBe(false);
    const ai = () => app.inject({ method: 'POST', url: '/ai/messages', headers: { ...t.dev, 'x-duckling-app': 'draw-with-me' }, payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
    expect((await ai()).statusCode).toBe(200);
    // The trial ends.
    await db.system((q) => q.run("UPDATE entitlement SET current_period_end = now() - interval '1 minute' WHERE family_id = $1", [p.familyId]));
    const c = await cfg();
    expect(c.locked).toBe(true);
    expect(c.entitlement.status).toBe('ended');
    expect(c.apps.map((a: any) => a.id)).toEqual(['word-wizard']); // still listed: the tiles stay, greyed
    expect((await app.inject({ method: 'PUT', url: '/device/apps/music-box', headers: t.dev })).statusCode).toBe(402);
    expect((await ai()).statusCode).toBe(402);
    expect((await app.inject({ method: 'GET', url: '/tts?text=hello', headers: t.dev })).statusCode).toBe(402);
    expect((await app.inject({ method: 'POST', url: '/requests', headers: p.auth, payload: { title: 'Dinosaur dig', description: 'Fossils and measuring' } })).statusCode).toBe(402);
    // The parent can still reach the family, set the PIN, and the tablet still checks in (the lockdown must stay).
    expect((await app.inject({ method: 'GET', url: '/family', headers: p.auth })).json().subscription.status).toBe('ended');
    expect((await app.inject({ method: 'POST', url: '/device/checkin', headers: t.dev, payload: {} })).statusCode).toBe(200);
    // A subscription unlocks everything again.
    await db.system((q) => q.run("UPDATE entitlement SET status = 'active', source = 'google', current_period_end = now() + interval '30 days' WHERE family_id = $1", [p.familyId]));
    expect((await cfg()).locked).toBe(false);
    expect((await app.inject({ method: 'PUT', url: '/device/apps/music-box', headers: t.dev })).statusCode).toBe(200);
    expect((await ai()).statusCode).toBe(200);
  });

  it('lets the admin move a trial by a parent email: 0 days locks the tablet, 7 days gives it back, a subscriber is left alone', async () => {
    await publish('word-wizard', '1.0.0', { starter: true });
    const p = await signIn('trial@example.com');
    const child = (await app.inject({ method: 'POST', url: '/family/children', headers: p.auth, payload: { firstName: 'Ada', age: 6 } })).json();
    const t = await pair(p.auth, child.id);
    const admin = { authorization: `Bearer ${ADMIN}` };
    const move = (email: string, days: number) => app.inject({ method: 'PUT', url: '/admin/families/trial', headers: admin, payload: { email, days } });
    expect((await move('nobody@example.com', 0)).statusCode).toBe(404);
    const ended = await move('Trial@Example.com', 0);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().entitlement.status).toBe('ended');
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t.dev })).json().locked).toBe(true);
    const back = await move('trial@example.com', 7);
    expect(back.json().entitlement).toMatchObject({ status: 'trial', daysLeft: 7 });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t.dev })).json().locked).toBe(false);
    await db.system((q) => q.run("UPDATE entitlement SET status = 'active', source = 'google', current_period_end = now() + interval '30 days' WHERE family_id = $1", [p.familyId]));
    expect((await move('trial@example.com', 0)).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/admin/families/trial', payload: { email: 'trial@example.com', days: 0 } })).statusCode).toBe(401);
  });

  it('lets the admin grant a family a complimentary license that never ends, and take it back', async () => {
    await publish('word-wizard', '1.0.0', { starter: true });
    const p = await signIn('comp@example.com');
    const child = (await app.inject({ method: 'POST', url: '/family/children', headers: p.auth, payload: { firstName: 'Ada', age: 6 } })).json();
    const t = await pair(p.auth, child.id);
    const admin = { authorization: `Bearer ${ADMIN}` };
    const license = (email: string, complimentary: boolean) => app.inject({ method: 'PUT', url: '/admin/families/license', headers: admin, payload: { email, complimentary } });
    expect((await license('nobody@example.com', true)).statusCode).toBe(404);
    const on = await license('Comp@Example.com', true);
    expect(on.statusCode).toBe(200);
    expect(on.json().entitlement).toEqual({ status: 'active', source: 'complimentary', periodEnd: null, daysLeft: null });
    expect((await app.inject({ method: 'GET', url: '/family', headers: p.auth })).json().subscription.status).toBe('active');
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t.dev })).json().locked).toBe(false);
    const off = await license('comp@example.com', false);
    expect(off.json().entitlement.status).toBe('ended');
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t.dev })).json().locked).toBe(true);
  });

  it('signs the store review family in with the fixed code from the environment, sends it no mail, and is off when unset', async () => {
    // Off by default: the review address is an ordinary address.
    await app.inject({ method: 'POST', url: '/auth/code', payload: { email: 'review@example.com' } });
    expect(mails.filter((m) => m.to === 'review@example.com')).toHaveLength(1);
    const tablet = { platform: 'android', name: 'Review tablet' };
    expect((await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'review@example.com', code: '246810', ...tablet } })).statusCode).toBe(401);
    // On: with both values set, the address gets no mail, the fixed code signs it in, any other code does not, and
    // a different address still needs a real code.
    const cfg2 = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files2'), STORAGE: 'local', ADMIN_TOKEN: ADMIN, PUBLIC_URL: 'https://api.test',
      REVIEW_EMAIL: 'Review@Example.com', REVIEW_CODE: '246810' });
    const { app: app2 } = await buildServer(cfg2, { db, logger: false, mailer: { async send(to, subject, text) { mails.push({ to, subject, text }); } } });
    try {
      expect((await app2.inject({ method: 'POST', url: '/auth/code', payload: { email: 'review@example.com' } })).json().sent).toBe(true);
      expect(mails.filter((m) => m.to === 'review@example.com')).toHaveLength(1);
      expect((await app2.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'review@example.com', code: '000000', ...tablet } })).statusCode).toBe(401);
      const r = await app2.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'review@example.com', code: '246810', childFirstName: 'Sam', childAge: 7, ...tablet } });
      expect(r.statusCode).toBe(200);
      expect(r.json().config.child.firstName).toBe('Sam');
      expect(r.json().config.entitlement.daysLeft).toBeGreaterThan(3000);
      // The fixed code keeps working for that address (a reviewer may pair more than once).
      expect((await app2.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'review@example.com', code: '246810', ...tablet, name: 'Second' } })).statusCode).toBe(200);
      expect((await app2.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'someone@example.com', code: '246810', ...tablet } })).statusCode).toBe(401);
      // The parents' website, in a browser (which would get a link) and as a home-screen app: no email, the code box,
      // and the fixed code signs in to the same family the tablet made.
      const sent = mails.length;
      for (const delivery of ['link', 'code']) {
        expect((await app2.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'Review@example.com', delivery } })).json()).toEqual({ sent: true, delivery: 'code' });
      }
      expect(mails.length).toBe(sent);
      expect((await app2.inject({ method: 'POST', url: '/auth/code/verify', payload: { email: 'review@example.com', code: '000000' } })).statusCode).toBe(401);
      const web = await app2.inject({ method: 'POST', url: '/auth/code/verify', payload: { email: 'review@example.com', code: '246810' } });
      expect(web.statusCode).toBe(200);
      const fam = (await app2.inject({ method: 'GET', url: '/family', headers: { authorization: `Bearer ${web.json().sessionToken}` } })).json();
      expect(fam.children.map((c: any) => c.firstName)).toContain('Sam');
    } finally { await app2.close(); }
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

describe('child avatar and stars', () => {
  it('keeps the avatar, portrait and stars on the child profile, shared by her tablets and shown to parents', async () => {
    const p = await signIn('avatar@example.com');
    const ada = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ada' } })).json();
    const t1 = await pair(p.auth, ada.id), t2 = await pair(p.auth, ada.id), none = await pair(p.auth);
    // Nothing yet.
    expect((await app.inject({ method: 'GET', url: '/device/child/avatar', headers: t1.dev })).json()).toEqual({ design: null, owned: [], spent: 0, savedAt: 0, earned: 0, earnedByApp: {} });
    expect((await app.inject({ method: 'PUT', url: '/device/child/avatar', headers: none.dev, payload: { design: {} } })).statusCode).toBe(409);
    // Stars from two apps, the larger value wins on a repeat, and the total is per child.
    expect((await app.inject({ method: 'POST', url: '/device/child/stars', headers: t1.dev, payload: { appId: 'count-with-me', earned: 7 } })).json().earned).toBe(7);
    expect((await app.inject({ method: 'POST', url: '/device/child/stars', headers: t2.dev, payload: { appId: 'word-wizard', earned: 5 } })).json().earned).toBe(12);
    expect((await app.inject({ method: 'POST', url: '/device/child/stars', headers: t1.dev, payload: { appId: 'count-with-me', earned: 3 } })).json().earned).toBe(12);
    // The avatar saved on one tablet is read on the other; an older save does not overwrite a newer one.
    const design = { hair: 'hair-bob', hairColor: '#3b2a1a', outfit: 'astronaut', place: 'moon' };
    expect((await app.inject({ method: 'PUT', url: '/device/child/avatar', headers: t1.dev, payload: { design, owned: ['hair-bob', 'astronaut'], spent: 4, savedAt: 2000 } })).json().saved).toBe(true);
    await app.inject({ method: 'PUT', url: '/device/child/avatar', headers: t2.dev, payload: { design: { hair: 'old' }, savedAt: 1000 } });
    const got = (await app.inject({ method: 'GET', url: '/device/child/avatar', headers: t2.dev })).json();
    expect(got).toMatchObject({ design, owned: ['hair-bob', 'astronaut'], spent: 4, savedAt: 2000, earned: 12, earnedByApp: { 'count-with-me': 7, 'word-wizard': 5 } });
    expect((await app.inject({ method: 'PUT', url: '/device/child/avatar', headers: t1.dev, payload: { design: { x: 'y'.repeat(40000) } } })).statusCode).toBe(413);
    // The portrait: a PNG data URL in, a signed link out, the same picture for parents and in the device config.
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 9)]);
    expect((await app.inject({ method: 'PUT', url: '/device/child/portrait', headers: { ...t1.dev, 'content-type': 'text/plain' }, payload: 'data:image/jpeg;base64,AAAA' })).statusCode).toBe(415);
    const up = await app.inject({ method: 'PUT', url: '/device/child/portrait', headers: { ...t1.dev, 'content-type': 'text/plain' }, payload: `data:image/png;base64,${png.toString('base64')}` });
    expect(up.statusCode).toBe(200);
    const link: string = up.json().portraitUrl;
    expect(link).toMatch(new RegExp(`^https://api.test/children/${ada.id}/portrait\\?exp=\\d+&sig=[0-9a-f]{32}&v=[0-9a-f]{12}$`));
    const signed = await app.inject({ method: 'GET', url: link.replace('https://api.test', '') });
    expect(signed.statusCode).toBe(200); expect(signed.headers['content-type']).toBe('image/png'); expect(signed.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: 'GET', url: link.replace('https://api.test', '').replace(/sig=[0-9a-f]{4}/, 'sig=0000') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/children/${ada.id}/portrait` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/children/${ada.id}/portrait`, headers: p.auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/children/${ada.id}/portrait`, headers: (await signIn('else@example.com')).auth })).statusCode).toBe(404);
    const cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: t2.dev })).json();
    expect(cfg.child.stars).toEqual({ earned: 12, spent: 4, balance: 8 });
    expect(cfg.child.portraitUrl).toMatch(/\/portrait\?exp=/);
    const fam = (await app.inject({ method: 'GET', url: '/family', headers: p.auth })).json();
    expect(fam.children[0]).toMatchObject({ firstName: 'Ada', stars: { earned: 12, spent: 4, balance: 8 } });
    expect(fam.children[0].portraitUrl).toMatch(/\/portrait\?exp=/);
    // A new portrait replaces the old file.
    const png2 = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 1)]);
    const up2 = await app.inject({ method: 'PUT', url: '/device/child/portrait', headers: { ...t1.dev, 'content-type': 'text/plain' }, payload: `data:image/png;base64,${png2.toString('base64')}` });
    expect((await app.inject({ method: 'GET', url: up2.json().portraitUrl.replace('https://api.test', '') })).rawPayload.equals(png2)).toBe(true);
    expect((await app.inject({ method: 'GET', url: link.replace('https://api.test', '') })).statusCode).toBe(404);
  });

  it('keeps her home background on her profile: set from a tablet, on every tablet of hers, cleared, and deleted with her', async () => {
    const p = await signIn('bg@example.com');
    const ada = (await app.inject({ method: 'POST', url: '/children', headers: p.auth, payload: { firstName: 'Ada' } })).json();
    const t1 = await pair(p.auth, ada.id), t2 = await pair(p.auth, ada.id), none = await pair(p.auth);
    const files = () => readdirSync(join(dir, 'files', 'backgrounds')).length;
    const put = (dev: any, body: string) => app.inject({ method: 'PUT', url: '/device/child/background', headers: { ...dev, 'content-type': 'text/plain' }, payload: body });
    const jpg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(400_000, 3)]); // a large painting
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 5)]);
    // Refused: no child on the tablet, a type that does not match its bytes, something that is not an image, too large.
    expect((await put(none.dev, `data:image/png;base64,${png.toString('base64')}`)).statusCode).toBe(409);
    expect((await put(t1.dev, `data:image/png;base64,${jpg.toString('base64')}`)).statusCode).toBe(400);
    expect((await put(t1.dev, 'data:image/gif;base64,R0lGODlh')).statusCode).toBe(415);
    expect((await put(t1.dev, `data:image/jpeg;base64,${Buffer.concat([jpg, Buffer.alloc(1_200_000)]).toString('base64')}`)).statusCode).toBe(400);
    // Set on one tablet: a signed link, in the config of both of her tablets, served as JPEG.
    const up = await put(t1.dev, `data:image/jpeg;base64,${jpg.toString('base64')}`);
    expect(up.statusCode).toBe(200);
    const link: string = up.json().backgroundUrl;
    expect(link).toMatch(new RegExp(`^https://api.test/children/${ada.id}/background\\?exp=\\d+&sig=[0-9a-f]{32}&v=[0-9a-f]{12}$`));
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t2.dev })).json().child.backgroundUrl).toMatch(/\/background\?exp=/);
    // Every check-in hands out the same link for the same picture, and the picture can be kept by the browser.
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t2.dev })).json().child.backgroundUrl).toBe(link);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t1.dev })).json().child.backgroundUrl).toBe(link);
    expect((await app.inject({ method: 'GET', url: link.replace('https://api.test', '') })).headers['cache-control']).toBe('private, max-age=2592000, immutable');
    const got = await app.inject({ method: 'GET', url: link.replace('https://api.test', '') });
    expect(got.headers['content-type']).toBe('image/jpeg'); expect(got.rawPayload.equals(jpg)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/children/${ada.id}/background`, headers: (await signIn('else2@example.com')).auth })).statusCode).toBe(404);
    // A new one replaces the old file; clearing removes it and the link stops working.
    const up2 = await put(t2.dev, `data:image/png;base64,${png.toString('base64')}`);
    expect(files()).toBe(1);
    expect((await app.inject({ method: 'GET', url: link.replace('https://api.test', '') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/device/child/background', headers: t1.dev })).json()).toEqual({ backgroundUrl: null });
    expect(files()).toBe(0);
    expect((await app.inject({ method: 'GET', url: up2.json().backgroundUrl.replace('https://api.test', '') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: t1.dev })).json().child.backgroundUrl).toBeNull();
    // Deleting the child, and deleting the account, remove her pictures from storage too.
    await put(t1.dev, `data:image/png;base64,${png.toString('base64')}`);
    await app.inject({ method: 'PUT', url: '/device/child/portrait', headers: { ...t1.dev, 'content-type': 'text/plain' }, payload: `data:image/png;base64,${png.toString('base64')}` });
    const portraits = () => readdirSync(join(dir, 'files', 'portraits')).filter((f) => f.startsWith(ada.id)).length;
    expect([files(), portraits()]).toEqual([1, 1]);
    expect((await app.inject({ method: 'DELETE', url: `/children/${ada.id}`, headers: p.auth })).statusCode).toBe(200);
    expect([files(), portraits()]).toEqual([0, 0]);
    const q = await signIn('bg2@example.com');
    const bea = (await app.inject({ method: 'POST', url: '/children', headers: q.auth, payload: { firstName: 'Bea' } })).json();
    const tb = await pair(q.auth, bea.id);
    await put(tb.dev, `data:image/png;base64,${png.toString('base64')}`);
    expect(files()).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: '/family', headers: q.auth, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(files()).toBe(0);
  });
});

describe('other apps and travel', () => {
  it('lists the tablet\'s own apps for the parent, applies the allowance, window and sites, and counts use per local day', async () => {
    const p = await signIn('other@example.com'); const d = await pair(p.auth);
    const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const reported = await app.inject({ method: 'POST', url: '/device/apps-installed', headers: d.dev, payload: { apps: [
      { package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids', icon }, { package: 'org.khanacademy.kids', label: 'Khan Kids' }, { package: 'bad name', label: 'x' }] } });
    expect(reported.statusCode).toBe(400); // one bad package name fails the whole report
    await app.inject({ method: 'POST', url: '/device/apps-installed', headers: d.dev, payload: { apps: [
      { package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids', icon }, { package: 'org.khanacademy.kids', label: 'Khan Kids' }] } });
    // Nothing is allowed yet: the tablet sees none, the parent sees both.
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().otherApps).toEqual([]);
    const seen = (await app.inject({ method: 'GET', url: `/devices/${d.deviceId}`, headers: p.auth })).json().otherApps;
    expect(seen.map((a: any) => [a.label, a.allowed, a.icon])).toEqual([['Khan Kids', false, null], ['YouTube Kids', false, icon]]);
    // The parent allows one with 30 minutes a day, a window, and the sites it needs.
    const set = await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/other-apps/com.google.android.apps.youtube.kids`, headers: p.auth,
      payload: { allowed: true, dailyMinutes: 30, window: { start: '15:00', end: '18:30' }, hosts: ['youtubekids.com', '*.ytimg.com'] } });
    expect(set.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/other-apps/org.khanacademy.kids`, headers: p.auth, payload: { window: { start: '25:00', end: '18:00' } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/other-apps/com.nope.app`, headers: p.auth, payload: { allowed: true } })).statusCode).toBe(404);
    const cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json();
    expect(cfg.otherApps).toEqual([{ package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids', icon, allowed: true, dailyMinutes: 30, window: { start: '15:00', end: '18:30' }, hosts: ['youtubekids.com', '*.ytimg.com'], usedSecondsToday: 0 }]);
    // Use is counted on the day the tablet names; a second session adds to it; another day starts at zero.
    const today = new Date().toISOString().slice(0, 10);
    await app.inject({ method: 'POST', url: '/device/other-app-usage', headers: d.dev, payload: { package: 'com.google.android.apps.youtube.kids', seconds: 600, day: today } });
    const after2 = (await app.inject({ method: 'POST', url: '/device/other-app-usage', headers: d.dev, payload: { package: 'com.google.android.apps.youtube.kids', seconds: 300, day: today } })).json();
    expect(after2.otherApps[0].usedSecondsToday).toBe(900);
    const other = (await app.inject({ method: 'POST', url: '/device/other-app-usage', headers: d.dev, payload: { package: 'com.google.android.apps.youtube.kids', seconds: 60, day: '2030-01-01' } })).json();
    expect(other.otherApps[0].usedSecondsToday).toBe(60);
    // A report without an app keeps the parent's settings and marks it absent; it comes back on the next report.
    await app.inject({ method: 'POST', url: '/device/apps-installed', headers: d.dev, payload: { apps: [{ package: 'org.khanacademy.kids', label: 'Khan Kids' }] } });
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().otherApps).toEqual([]);
    await app.inject({ method: 'POST', url: '/device/apps-installed', headers: d.dev, payload: { apps: [{ package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids' }] } });
    const back = (await app.inject({ method: 'GET', url: '/device/config', headers: d.dev })).json().otherApps[0];
    expect(back).toMatchObject({ allowed: true, dailyMinutes: 30, icon, hosts: ['youtubekids.com', '*.ytimg.com'] });
    // Another family's parent cannot touch it.
    const b = await signIn('other-b@example.com');
    expect((await app.inject({ method: 'PUT', url: `/devices/${d.deviceId}/other-apps/com.google.android.apps.youtube.kids`, headers: b.auth, payload: { allowed: false } })).statusCode).toBe(404);
    // Travel mode takes minutes now; hours still work.
    const t = (await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/travel`, headers: p.auth, payload: { minutes: 45 } })).json();
    expect(t.active).toBe(true);
    expect(new Date(t.until).getTime() - Date.now()).toBeGreaterThan(44 * 60_000);
    expect(new Date(t.until).getTime() - Date.now()).toBeLessThan(46 * 60_000);
    expect((await app.inject({ method: 'POST', url: `/devices/${d.deviceId}/travel`, headers: p.auth, payload: { minutes: 0 } })).json().active).toBe(false);
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
    // Haiku 4.5 is no longer served: a tablet still on an older app version that asks for it gets the default.
    // The third call is the last one today for this app on this device; the fourth is refused without reaching Anthropic.
    expect((await call('draw-with-me', { model: 'claude-haiku-4-5-20251001' })).statusCode).toBe(200);
    expect(aiCalls[2].model).toBe('claude-haiku-5-5');
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

  it('a sign-in from the portal on an iPhone home screen gets a code that signs in once; a browser gets the link', async () => {
    await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'browser@example.com' } });
    expect(mails.at(-1)!.subject).toBe('Your Duckling Tablet sign-in link');
    expect(mails.at(-1)!.text).toMatch(/signin\?token=/);
    const sent = await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'Phone@Example.com', delivery: 'code' } });
    expect(sent.json()).toEqual({ sent: true, delivery: 'code' });
    const mail = mails.at(-1)!;
    const code = mail.subject!.match(/^(\d{3}) (\d{3}) is your Duckling Tablet sign-in code$/)!.slice(1).join('');
    expect(mail.text).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(mail.text).not.toContain('token=');
    const verify = (c: string, email = 'phone@example.com') => app.inject({ method: 'POST', url: '/auth/code/verify', payload: { email, code: c } });
    expect((await verify(code === '000000' ? '111111' : '000000')).statusCode).toBe(401);
    expect((await verify(code, 'other@example.com')).statusCode).toBe(401);
    const r = await verify(code);
    expect(r.statusCode).toBe(200);
    expect(r.json().newFamily).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/family', headers: { authorization: `Bearer ${r.json().sessionToken}` } })).statusCode).toBe(200);
    expect((await verify(code)).statusCode).toBe(401); // used up
    // Five wrong guesses end a code.
    await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'phone@example.com', delivery: 'code' } });
    const c2 = mails.at(-1)!.subject!.match(/^(\d{3}) (\d{3})/)!.slice(1).join('');
    const wrong = c2 === '000000' ? '111111' : '000000';
    for (let k = 0; k < 5; k++) await verify(wrong);
    expect((await verify(c2)).statusCode).toBe(401);
    // A tablet-started email stays a link for another device.
    await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'tab@example.com', source: 'tablet', delivery: 'code' } });
    expect(mails.at(-1)!.subject).toBe('Set up your Duckling Tablet family');
  });

  it('production settings refuse to run without SMTP, so sign-in links never go to the log', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), ADMIN_TOKEN: 'y'.repeat(40), DATABASE_URL_APP: 'postgresql://a:b@db.internal:25060/duckling', DATABASE_URL_SYSTEM: 'postgresql://c:d@db.internal:25060/duckling' };
    expect(() => loadConfig({ ...prod, SMTP_HOST: '' })).toThrow(/SMTP_HOST/);
    expect(() => loadConfig({ ...prod, SMTP_HOST: 'smtp.sendgrid.net' })).not.toThrow();
    expect(() => loadConfig({ ...prod, SMTP_HOST: 'smtp.sendgrid.net', DATABASE_URL_APP: 'postgresql://duckling_app:duckling@127.0.0.1:5432/duckling' })).toThrow(/DATABASE_URL_APP/);
  });
});

describe('language', () => {
  it('starts a family in the tablet language, writes its emails in it, and lets parents and children change it', async () => {
    // The code email follows the tablet's language before any family exists.
    await app.inject({ method: 'POST', url: '/auth/code', payload: { email: 'es@example.com', language: 'es-MX' } });
    const mail = mails.filter((m) => m.to === 'es@example.com').at(-1)!;
    const code = mail.subject!.match(/^(\d{3}) (\d{3}) es tu código/)!.slice(1).join('');
    expect(mail.text).toContain('Escribe este código en la tableta');
    const r = await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { email: 'es@example.com', code, childFirstName: 'Lucía', platform: 'android', name: 'Tableta', language: 'es-MX' } });
    expect(r.statusCode).toBe(200);
    const dev = { authorization: `Device ${r.json().deviceToken}` };
    expect(r.json().config).toMatchObject({ language: 'es', familyLanguage: 'es', narratorVoice: 'es-MX-MarinaNeural' });

    // Anything Duckling does not speak yet is English.
    await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'fr@example.com', language: 'fr-FR' } });
    expect(mails.filter((m) => m.to === 'fr@example.com').at(-1)!.subject).toBe('Your Duckling Tablet sign-in link');
    await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email: 'es@example.com', language: 'es' } });
    const link = mails.filter((m) => m.to === 'es@example.com').at(-1)!;
    expect(link.subject).toBe('Tu enlace para entrar a Duckling Tablet');
    const s = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token: link.text.match(/token=([\w-]+)/)![1] } });
    const auth = { authorization: `Bearer ${s.json().sessionToken}` };
    const fam = (await app.inject({ method: 'GET', url: '/family', headers: auth })).json();
    expect(fam.language).toBe('es');

    // The invite goes out in the family's language.
    await app.inject({ method: 'POST', url: '/family/parents/invite', headers: auth, payload: { email: 'abuela@example.com' } });
    expect(mails.filter((m) => m.to === 'abuela@example.com').at(-1)!.subject).toBe('Te invitaron a una familia de Duckling Tablet');

    // A child can have her own language; the tablet follows her, and the family setting follows the parent.
    const childId = fam.children[0].id;
    expect((await app.inject({ method: 'PUT', url: `/children/${childId}`, headers: auth, payload: { language: 'en' } })).json().language).toBe('en');
    let cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json();
    expect(cfg).toMatchObject({ language: 'en', familyLanguage: 'es', narratorVoice: 'en-US-AnaNeural' });
    expect((await app.inject({ method: 'PUT', url: `/children/${childId}`, headers: auth, payload: { language: null } })).json().language).toBeNull();
    expect((await app.inject({ method: 'PUT', url: '/family/language', headers: auth, payload: { language: 'en' } })).statusCode).toBe(200);
    cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json();
    expect(cfg.language).toBe('en');
    // The tablet's parent area sets the family's language too; unknown languages are refused.
    expect((await app.inject({ method: 'PUT', url: '/device/language', headers: dev, payload: { language: 'es' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/family', headers: auth })).json().language).toBe('es');
    expect((await app.inject({ method: 'PUT', url: '/device/language', headers: dev, payload: { language: 'fr' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/family/language', headers: auth, payload: { language: 'xx' } })).statusCode).toBe(400);
  });
});

describe('owner stats', () => {
  it('counts app opens and minutes per tablet and day, for the tablet only', async () => {
    await publish('robot-path', '1.0.0', { starter: true });
    const p = await signIn('p@example.com'); const d = await pair(p.auth);
    const day = new Date().toISOString().slice(0, 10);
    for (const seconds of [120, 300]) expect((await app.inject({ method: 'POST', url: '/device/app-usage', headers: d.dev, payload: { app: 'robot-path', seconds, day } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/device/app-usage', headers: d.dev, payload: { app: 'Robot Path!', seconds: 1, day } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/device/app-usage', headers: d.dev, payload: { app: 'robot-path', seconds: 7 * 3600, day } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/device/app-usage', headers: p.auth, payload: { app: 'robot-path', seconds: 1, day } })).statusCode).toBe(401);
    const rows = await db.system((q) => q.all('SELECT app_id, opens, seconds FROM app_usage'));
    expect(rows).toEqual([{ app_id: 'robot-path', opens: 2, seconds: 420 }]);
  });

  it('is offered to the STATS_EMAILS parents and the admin token, and to no one else', async () => {
    const plain = await signIn('p@example.com');
    expect((await app.inject({ method: 'GET', url: '/family', headers: plain.auth })).json().stats).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/stats', headers: plain.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/stats' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/stats', headers: { authorization: 'Bearer wrong-token' } })).statusCode).toBe(401);
    const owner = await signIn('owner@example.com');
    expect((await app.inject({ method: 'GET', url: '/family', headers: owner.auth })).json().stats).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/stats', headers: owner.auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/stats', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode).toBe(200);
  });

  it('adds up every family without naming any', async () => {
    await publish('robot-path', '1.0.0', { starter: true });
    await publish('word-wizard', '1.0.0');
    // The tablet sends its own day; here the database's, so the daily series has today's figures.
    const day = (await db.system((q) => q.one<{ d: string }>('SELECT current_date::text d')))!.d;
    const a = await signIn('a@example.com');
    const ada = (await app.inject({ method: 'POST', url: '/children', headers: a.auth, payload: { firstName: 'Ada', startGrade: 2 } })).json();
    const da = await pair(a.auth, ada.id);
    await app.inject({ method: 'POST', url: '/device/app-usage', headers: da.dev, payload: { app: 'robot-path', seconds: 600, day } });
    const b = await signIn('b@example.com');
    await app.inject({ method: 'PUT', url: '/family/language', headers: b.auth, payload: { language: 'es' } });
    const db2 = await pair(b.auth);
    await app.inject({ method: 'POST', url: '/device/checkin', headers: db2.dev, payload: { battery: 50 } });
    await app.inject({ method: 'POST', url: '/device/app-usage', headers: db2.dev, payload: { app: 'robot-path', seconds: 300, day } });
    await app.inject({ method: 'POST', url: '/device/app-usage', headers: db2.dev, payload: { app: 'robot-path', seconds: 0, day } });
    await app.inject({ method: 'POST', url: '/requests', headers: b.auth, payload: { title: 'Bugs', description: 'An app about bugs' } });

    const r = await app.inject({ method: 'GET', url: '/stats', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const s = r.json();
    expect(s.families).toMatchObject({ total: 2, new7: 2, new30: 2, withTablet: 2, spanish: 1 });
    expect(s.children).toMatchObject({ total: 1, spanish: 0 });
    expect(s.tablets.total).toBe(2);
    expect(s.tablets.platforms).toEqual([{ platform: 'android', total: 2, seen7: expect.any(Number) }]);
    const rp = s.apps.find((x: any) => x.id === 'robot-path');
    expect(rp).toMatchObject({ installs: 2, opens7: 3, minutes7: 15, tablets7: 2, opens30: 3, minutes30: 15 });
    expect(s.apps.find((x: any) => x.id === 'word-wizard')).toMatchObject({ installs: 0, opens7: 0 });
    expect(s.days).toHaveLength(30);
    expect(s.days.at(-1)).toMatchObject({ families: 2, tablets: 2, active: 2, minutes: 15 });
    expect(s.levels.filter((l: any) => l.subject === 'math')).toEqual([{ subject: 'math', grade: 2, n: 1 }]);
    expect(s.requests.new30).toBe(1);
    expect(s.subscriptions.byStatus.reduce((t: number, x: any) => t + x.n, 0)).toBe(2);
    // Counts only: no email, name or id from any family is in the answer.
    for (const secret of ['a@example.com', 'b@example.com', 'Ada', a.familyId, b.familyId, da.deviceId, db2.deviceId]) expect(r.body).not.toContain(secret);
  });
});
