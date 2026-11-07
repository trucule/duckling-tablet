// The parent portal (portal/dist) in a real browser against a real API: sign in through the emailed link, add a
// child, make a pairing code, see the paired device, hide an app and allow a website on it, release it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import { freePort, startCluster, type Cluster } from './pg.js';

const execFile = promisify(execFileCb);
const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'portal', 'dist');
const TOOLS = join(ROOT, 'tools');
const ADMIN = 'admin-token-for-tests-0123456789';
const ready = existsSync(join(DIST, 'index.html')) && existsSync(join(TOOLS, 'node_modules', 'fflate'));

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, portal: string, server: Server;
const mails: string[] = [];
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  if (!ready) return;
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-portal-'));
  ({ db } = await cluster.newDb());
  const apiPort = await freePort(), portalPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`; portal = `http://127.0.0.1:${portalPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: api, PORTAL_URL: portal });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(_to, _s, text) { mails.push(text); } }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  server = createServer((req, res) => {
    let p = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? (p.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream') });
    createReadStream(p).pipe(res);
  }).listen(portalPort, '127.0.0.1');
  const { stdout: keygen } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'keygen']);
  const key = keygen.match(/^PACKAGE_SIGNING_KEY=(\S+)/m)![1];
  await execFile('node', [join(TOOLS, 'publish.mjs'), 'all', '--starter'], { env: { ...process.env, API_URL: api, ADMIN_TOKEN: ADMIN, PACKAGE_SIGNING_KEY: key, DOTENV_CONFIG_PATH: join(dir, 'none') }, maxBuffer: 1 << 24 });
}, 180_000);
afterAll(async () => {
  server?.close(); await app?.close(); await db?.close(); await cluster?.stop();
  if (dir && process.env.WEB_SHOTS) { const { cpSync } = await import('node:fs'); for (const f of ['portal-family.png', 'portal-device.png']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(process.env.WEB_SHOTS, f)); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)('parent portal', () => {
  it('signs in by email link, adds a child, pairs a device by code, manages and releases it', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
      const req = route.request();
      const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
      await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));

    const manifest = await (await fetch(`${portal}/manifest.webmanifest`)).json();
    expect(manifest.display).toBe('standalone');
    expect((await fetch(`${portal}/sw.js`)).status).toBe(200);

    await p.goto(portal);
    await p.getByLabel('Email').fill('mom@example.com');
    await p.getByRole('button', { name: 'Send me a link' }).click();
    await p.getByText('Check your email').waitFor();
    const link = mails.at(-1)!.match(/(http\S+signin\?token=[\w-]+)/)![1];
    expect(link.startsWith(portal)).toBe(true);
    await p.goto(link);
    await p.getByRole('heading', { name: 'Children' }).waitFor();
    expect(p.url()).not.toContain('token=');

    await p.getByPlaceholder('First name').fill('Ada');
    await p.getByRole('button', { name: 'Add child' }).click();
    await p.locator('.list li', { hasText: 'Ada' }).waitFor();

    await p.locator('select').nth(2).selectOption({ label: 'Ada' });
    await p.getByRole('button', { name: 'Make a pairing code' }).click();
    const code = (await p.locator('.code').textContent())!.trim();
    expect(code).toMatch(/^\d{6}$/);

    // A tablet redeems the code.
    const paired = await (await fetch(`${api}/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, platform: 'android', name: 'Kitchen tablet' }) })).json();
    expect(paired.deviceToken).toBeTruthy();
    expect(paired.config.child.firstName).toBe('Ada');
    expect(paired.config.apps.length).toBe(7);
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.getByText('Kitchen tablet').waitFor();
    await p.screenshot({ path: join(dir, 'portal-family.png'), fullPage: true });

    // The device page: hide an app, allow a website, release.
    await p.getByRole('button', { name: 'Open' }).click();
    await p.getByRole('heading', { name: 'Kitchen tablet' }).waitFor();
    await p.locator('.t', { hasText: 'Music Box' }).getByRole('button', { name: 'Hide' }).click();
    await p.locator('.t', { hasText: 'Music Box' }).getByRole('button', { name: 'Unhide' }).waitFor();
    await p.getByPlaceholder('pbskids.org').fill('pbskids.org');
    await p.getByPlaceholder('Name on the tile').fill('PBS Kids');
    await p.getByRole('button', { name: 'Allow site' }).click();
    await p.getByText('pbskids.org', { exact: true }).waitFor();
    await p.screenshot({ path: join(dir, 'portal-device.png'), fullPage: true });
    const cfg = await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } })).json();
    expect(cfg.hidden).toEqual(['music-box']);
    expect(cfg.apps.map((a: { id: string }) => a.id)).not.toContain('music-box');
    expect(cfg.allowlist[0]).toMatchObject({ host: 'pbskids.org', tile: { name: 'PBS Kids', url: 'https://pbskids.org' } });

    p.once('dialog', (d) => d.accept());
    await p.getByRole('button', { name: 'Remove this tablet' }).click();
    await p.getByRole('heading', { name: 'Devices' }).waitFor();
    await p.getByText('Keep this page on your phone').waitFor();
    const after = await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } });
    expect(after.status).toBe(410);

    // The family PIN: set here, carried to a tablet in its config.
    await p.getByRole('heading', { name: 'Parent PIN' }).waitFor();
    await p.getByPlaceholder('PIN (4 to 6 digits)').fill('2468');
    await p.getByPlaceholder('Again').fill('2468');
    await p.getByRole('button', { name: 'Set PIN' }).click();
    await p.getByText('Saved.', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Change PIN' }).waitFor();
    await p.getByRole('button', { name: 'Make a pairing code' }).click();
    const code2 = (await p.locator('.code').textContent())!.trim();
    const paired2 = await (await fetch(`${api}/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code2, platform: 'android', name: 'Second tablet' }) })).json();
    expect(paired2.config.pinHash).toMatch(/^[0-9a-f]{64}$/);

    // A second parent gets an invite link.
    await p.getByPlaceholder("Another parent's email").fill('dad@example.com');
    await p.getByRole('button', { name: 'Invite' }).click();
    await p.getByText('Invitation sent to dad@example.com', { exact: false }).waitFor();
    expect(mails.at(-1)).toContain('mom@example.com invited you');

    // An app request with a picture, listed with its status and the picture shown.
    await p.getByPlaceholder('A short name, like Dinosaur dig').fill('Dinosaur dig');
    await p.getByPlaceholder('What should it do', { exact: false }).fill('Fossils, brushing sand away, measuring bones.');
    await p.locator('input[type=file]').first().setInputFiles({ name: 'drawing.png', mimeType: 'image/png', buffer: PNG });
    await p.getByText('1 picture chosen').waitFor();
    await p.getByRole('button', { name: 'Send the request' }).click();
    await p.getByText('Received', { exact: false }).waitFor();
    await p.locator('img[src^="blob:"]').waitFor();
    await p.getByText('A new request can be made once this one is finished.').waitFor();
    const reqs = await (await fetch(`${api}/requests`, { headers: { authorization: `Bearer ${await p.evaluate(() => localStorage.getItem('duckling.session'))}` } })).json();
    expect(reqs.requests[0].attachments).toHaveLength(1);
    expect(reqs.requests[0].attachments[0]).toMatchObject({ contentType: 'image/png', size: PNG.length });
    await p.screenshot({ path: join(dir, 'portal-family-after.png'), fullPage: true });
    expect(errors).toEqual([]);
    await browser.close();
  }, 120_000);
});
