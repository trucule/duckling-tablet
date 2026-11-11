// The parent portal (portal/dist) in a real browser against a real API: sign in through the emailed link, add a
// child, make a pairing code, see the paired device, remove and install an app and allow a website on it, remove it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
const APPS = join(ROOT, 'apps');
const STARTERS = readdirSync(APPS).filter((d) => existsSync(join(APPS, d, 'manifest.json')) && JSON.parse(readFileSync(join(APPS, d, 'manifest.json'), 'utf8')).starter);
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
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
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
  if (dir && process.env.WEB_SHOTS) { const { cpSync } = await import('node:fs'); for (const f of ['portal-family.png', 'portal-apps.png', 'portal-apps-ask.png', 'portal-other-apps.png']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(process.env.WEB_SHOTS, f)); }
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
    await p.getByPlaceholder('Age').fill('7');
    await p.getByRole('button', { name: 'Add child' }).click();
    // Seven years old: every subject starts at kindergarten level; one subject can be moved on its own.
    await p.getByText('age 7 · Kindergarten level', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Levels' }).click();
    await p.locator('label', { hasText: 'Math' }).locator('select').selectOption('2');
    await p.getByText('mixed levels', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Done' }).click();
    await p.locator('.list li', { hasText: 'Ada' }).waitFor();

    await p.locator('#devices select').first().selectOption({ label: 'Ada' });
    await p.getByRole('button', { name: 'Make a pairing code' }).click();
    const code = (await p.locator('.code').textContent())!.trim();
    expect(code).toMatch(/^\d{6}$/);

    // A tablet redeems the code.
    const paired = await (await fetch(`${api}/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, platform: 'android', name: 'Kitchen tablet' }) })).json();
    expect(paired.deviceToken).toBeTruthy();
    expect(paired.config.child.firstName).toBe('Ada');
    expect(paired.config.apps.length).toBe(STARTERS.length);
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.getByText('Kitchen tablet').waitFor();
    await p.screenshot({ path: join(dir, 'portal-family.png'), fullPage: true });

    // Section buttons jump down the page; Back to top appears once scrolled.
    await p.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Websites' }).click();
    await expect.poll(() => p.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await p.getByRole('button', { name: 'Back to top' }).click();
    await expect.poll(() => p.evaluate(() => window.scrollY)).toBe(0);

    // Apps across the family: a search with no results offers an app request, with the search words as the name.
    await p.getByPlaceholder('Search apps', { exact: false }).fill('volcano eruptions');
    await p.getByText('No app matches "volcano eruptions".', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Ask for this app' }).click();
    await expect.poll(() => p.getByPlaceholder('A short name, like Dinosaur dig').inputValue()).toBe('Volcano eruptions');
    await expect.poll(() => p.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    await p.screenshot({ path: join(dir, 'portal-apps-ask.png'), fullPage: false });
    await p.getByPlaceholder('Search apps', { exact: false }).fill('');
    // One tablet: Remove takes a starter off it (and out of its Library) with no picker; then Remove is greyed and
    // Install brings it back.
    const music = p.locator('.list.apps li', { hasText: 'Music Box' });
    await music.getByText('On Kitchen tablet').waitFor();
    await expect.poll(() => music.getByRole('button', { name: 'Install' }).isDisabled()).toBe(true);
    await music.getByRole('button', { name: 'Remove' }).click();
    await music.getByText('Removed from Kitchen tablet').waitFor();
    await expect.poll(() => music.getByRole('button', { name: 'Remove' }).isDisabled()).toBe(true);
    let cfg = await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } })).json();
    expect(cfg.hidden).toEqual(['music-box']);
    expect(cfg.apps.map((a: { id: string }) => a.id)).not.toContain('music-box');
    await music.getByRole('button', { name: 'Install' }).click();
    await music.getByText('On Kitchen tablet').waitFor();
    cfg = await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } })).json();
    expect(cfg.hidden).toEqual([]);
    expect(cfg.apps.map((a: { id: string }) => a.id)).toContain('music-box');

    // Websites: allowed for the family's tablets, listed once each.
    await p.getByPlaceholder('pbskids.org').fill('pbskids.org');
    await p.getByPlaceholder('Name on the tile').fill('PBS Kids');
    await p.getByRole('button', { name: 'Allow site' }).click();
    await p.getByText('pbskids.org', { exact: true }).waitFor();
    await p.screenshot({ path: join(dir, 'portal-apps.png'), fullPage: true });
    cfg = await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } })).json();
    expect(cfg.allowlist[0]).toMatchObject({ host: 'pbskids.org', tile: { name: 'PBS Kids', url: 'https://pbskids.org' } });

    // Every site for a custom time: 90 minutes.
    await p.getByPlaceholder('3').fill('90');
    await p.locator('#websites select').selectOption('minutes');
    await p.locator('#websites').getByRole('button', { name: 'Allow', exact: true }).click();
    await p.getByText('On until', { exact: false }).waitFor();
    const travel = (await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } })).json()).travel;
    expect(new Date(travel.until).getTime() - Date.now()).toBeGreaterThan(85 * 60_000);
    await p.getByRole('button', { name: 'End now' }).click();
    await p.getByText('Off.', { exact: false }).waitFor();

    // The tablet's own apps: reported by the tablet, allowed here with minutes, hours and sites.
    await fetch(`${api}/device/apps-installed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Device ${paired.deviceToken}` },
      body: JSON.stringify({ apps: [{ package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids' }, { package: 'com.example.puzzles', label: 'Puzzle Pals' }] }) });
    await p.reload();
    await p.getByRole('heading', { name: 'Other apps' }).waitFor();
    const row = p.locator('#other-apps li', { hasText: 'YouTube Kids' });
    await row.getByRole('button', { name: 'Allow' }).click();
    await row.getByText('0 of 30 min used today').waitFor();
    await row.locator('select').selectOption('60');
    await row.getByText('0 of 60 min used today').waitFor();
    await row.locator('input[type=time]').first().fill('15:00');
    await row.locator('input[type=time]').last().fill('18:00');
    await row.getByRole('button', { name: 'Set hours' }).click();
    await row.getByPlaceholder('Websites it needs', { exact: false }).fill('youtubekids.com, ytimg.com');
    await row.getByRole('button', { name: 'Save sites' }).click();
    await expect.poll(async () => (await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } })).json()).otherApps).toEqual([
      { package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids', icon: null, allowed: true, dailyMinutes: 60, window: { start: '15:00', end: '18:00' }, hosts: ['youtubekids.com', 'ytimg.com'], usedSecondsToday: 0 }]);
    await p.screenshot({ path: join(dir, 'portal-other-apps.png'), fullPage: true });

    // Removing the tablet from the Devices section: its next contact answers 410.
    p.once('dialog', (d) => d.accept());
    await p.locator('#devices li', { hasText: 'Kitchen tablet' }).getByRole('button', { name: 'Remove' }).click();
    await p.getByText('No devices yet.').waitFor();
    await p.getByText('Keep this page on your phone').waitFor();
    const after = await fetch(`${api}/device/config`, { headers: { authorization: `Device ${paired.deviceToken}` } });
    expect(after.status).toBe(410);

    // Finding an app: words match the About text, chips narrow by subject.
    await p.locator('.list.apps li').first().waitFor();
    await p.getByPlaceholder('Search apps', { exact: false }).first().fill('robot arrow');
    await expect.poll(() => p.locator('.list.apps li').count()).toBe(1);
    expect(await p.locator('.list.apps li strong').first().textContent()).toBe('Robot Path');
    await p.getByPlaceholder('Search apps', { exact: false }).first().fill('');
    await p.getByRole('button', { name: 'Music' }).first().click();
    expect(await p.locator('.list.apps li strong').allTextContents()).toEqual(['Music Box']);
    await p.getByRole('button', { name: 'All subjects' }).first().click();
    await p.getByPlaceholder('Search apps', { exact: false }).first().fill('knitting');
    await p.getByRole('button', { name: 'Ask for this app' }).click();
    await expect.poll(() => p.getByPlaceholder('A short name, like Dinosaur dig').inputValue()).toBe('Knitting');
    await p.getByPlaceholder('A short name, like Dinosaur dig').fill('');
    await p.getByPlaceholder('Search apps', { exact: false }).first().fill('');

    // The About page for an app: the recording and the three sections.
    await p.goto(`${portal}/#/app/robot-path`);
    await p.getByRole('heading', { name: 'Robot Path' }).waitFor();
    await p.getByRole('heading', { name: 'What it trains' }).waitFor();
    await p.getByRole('heading', { name: 'How it grows with your child' }).waitFor();
    await p.getByText('Planning a sequence of actions').waitFor();
    await p.locator('img.demo').waitFor();
    await p.getByText('Back').first().click();
    await p.getByRole('heading', { name: 'Parent PIN' }).waitFor();

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

    // Two tablets: Remove and Install ask which tablet; the website list says which tablets allow a site.
    await p.getByRole('button', { name: 'Make a pairing code' }).click();
    let code3 = '';
    await expect.poll(async () => (code3 = (await p.locator('.code').textContent())!.trim())).not.toBe(code2);
    await fetch(`${api}/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code3, platform: 'ios', name: 'Third tablet' }) });
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.locator('#devices li', { hasText: 'Third tablet' }).waitFor();
    const music2 = p.locator('.list.apps li', { hasText: 'Music Box' });
    await music2.getByText('On every tablet').waitFor();
    await music2.getByRole('button', { name: 'Remove' }).click();
    await music2.getByText('Remove from').waitFor();
    await music2.getByRole('button', { name: 'Third tablet' }).click();
    await music2.getByText('On Second tablet').waitFor();
    await music2.getByRole('button', { name: 'Install' }).click();
    await music2.getByText('On every tablet').waitFor();
    await p.locator('#websites').getByRole('button', { name: 'Second tablet' }).click();
    await p.getByPlaceholder('pbskids.org').fill('starfall.com');
    await p.getByRole('button', { name: 'Allow site' }).click();
    await p.locator('#websites li', { hasText: 'starfall.com' }).waitFor();
    await p.locator('#websites').getByRole('button', { name: 'Every tablet' }).click();
    await p.locator('#websites li', { hasText: 'starfall.com · Second tablet' }).waitFor();
    await p.getByRole('button', { name: 'Back to top' }).click();

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
    // Withdrawing asks once on the page, then frees the request slot.
    const ask = p.locator('#ask-for-an-app');
    await ask.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await ask.screenshot({ path: join(process.env.SHOT_DIR ?? dir, 'portal-withdraw-confirm.png') });
    await ask.getByRole('button', { name: 'Withdraw it' }).click();
    await ask.getByText('Withdrawn', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Send the request' }).waitFor();
    await ask.screenshot({ path: join(process.env.SHOT_DIR ?? dir, 'portal-withdrawn.png') });
    expect(errors).toEqual([]);
    await browser.close();
  }, 120_000);
});
