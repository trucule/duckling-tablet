// The child web app (web/dist) in a real browser against a real API: a parent signs in and makes a pairing code,
// the browser pairs, sees the starter apps, installs one from the Library, sets the parent PIN, opens the parent
// area and removes the device. Skipped when web/dist or the publish tool's dependencies are missing.
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
const DIST = join(ROOT, 'web', 'dist');
const TOOLS = join(ROOT, 'tools');
const ADMIN = 'admin-token-for-tests-0123456789';
const ready = existsSync(join(DIST, 'index.html')) && existsSync(join(TOOLS, 'node_modules', 'fflate'));

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, web: string, webServer: Server;
const mails: string[] = [];

function serveDist(port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  return createServer((req, res) => {
    let p = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? (p.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream') });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
}

beforeAll(async () => {
  if (!ready) return;
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-web-'));
  ({ db } = await cluster.newDb());
  const apiPort = await freePort(), webPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`; web = `http://127.0.0.1:${webPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: api, APP_URL: web });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(_to, _s, text) { mails.push(text); } }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  webServer = serveDist(webPort);
  // The catalog: starter apps, published by the tool with a throwaway key.
  const { stdout: keygen } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'keygen']);
  const key = keygen.match(/^PACKAGE_SIGNING_KEY=(\S+)/m)![1];
  await execFile('node', [join(TOOLS, 'publish.mjs'), 'all', '--starter'], { env: { ...process.env, API_URL: api, ADMIN_TOKEN: ADMIN, PACKAGE_SIGNING_KEY: key, DOTENV_CONFIG_PATH: join(dir, 'none') }, maxBuffer: 1 << 24 });
}, 180_000);
afterAll(async () => {
  webServer?.close(); await app?.close(); await db?.close(); await cluster?.stop();
  // Keep the screenshots when asked (WEB_SHOTS=/some/dir), otherwise clean up.
  if (dir && process.env.WEB_SHOTS) { const { cpSync } = await import('node:fs'); for (const f of ['home.png', 'library.png', 'parent.png']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(process.env.WEB_SHOTS, f)); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)('child web app', () => {
  it('pairs, shows starter apps, installs from the Library, guards the parent area with a PIN, and releases', async () => {
    const { chromium } = await import('playwright');
    // The parent: sign in, add a child, make a pairing code.
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return r.json();
    };
    await post('/auth/email-link', { email: 'parent@example.com' });
    const token = mails.at(-1)!.match(/token=([\w-]+)/)![1];
    const { sessionToken } = await post('/auth/verify', { token });
    const auth = { authorization: `Bearer ${sessionToken}` };
    const child = await post('/children', { firstName: 'Ada', grade: '1', theme: { colors: ['#ffb3c6', '#b3e5ff'] } }, auth);
    const { code } = await post('/devices/pairing-codes', { childId: child.id }, auth);

    // The build points at api.ducklingtablet.com; requests to that host are rewritten to the local API.
    const b2 = await chromium.launch();
    const ctx = await b2.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
      const req = route.request();
      const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
      await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    });
    const p = await ctx.newPage();
    const errors: string[] = [], logs: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
    p.on('requestfailed', (r) => logs.push('failed ' + r.url() + ' ' + r.failure()?.errorText));
    await p.goto(web);

    // A parent who installed the app first: the tablet sends them the set-up email, worded for the phone.
    await p.getByPlaceholder('parent@example.com').fill('new@example.com');
    await p.getByRole('button', { name: 'Send me the link' }).click();
    await p.getByText('Sent. Check your email').waitFor();
    expect(mails.at(-1)).toMatch(/Open this link on your phone/);
    expect(mails.at(-1)).toMatch(/press Add a device/);

    // Installable and offline-capable: manifest and service worker are served.
    const manifest = await (await fetch(`${web}/manifest.webmanifest`)).json();
    expect(manifest.name).toBe('Duckling Tablet');
    expect((await fetch(`${web}/sw.js`)).status).toBe(200);

    // Pair.
    await p.getByPlaceholder('000000').fill(code);
    await p.getByRole('button', { name: 'Pair' }).click();
    try { await p.getByRole('heading', { name: "Ada's tablet" }).waitFor({ timeout: 8000 }); }
    catch (e) { console.log('PAGE TEXT:', (await p.textContent('body'))?.slice(0, 600), '\nERRORS:', errors, '\nLOGS:', logs); throw e; }
    // Starter apps arrive as tiles and the browser shell marks them installed.
    for (const name of ['Count With Me', 'Draw With Me', 'Music Box', 'Robot Path', 'Trace With Me', 'Word Wizard']) {
      await p.getByRole('button', { name }).waitFor();
    }
    await p.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('duckling.installed') || '{}')).length === 7);
    const theme = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c1').trim());
    expect(theme).toBe('#ffb3c6');
    await p.screenshot({ path: join(dir, 'home.png') });

    // Library: every starter app shows Open; removing one and installing it again round-trips through the server.
    await p.getByRole('button', { name: 'Library' }).click();
    await p.getByRole('heading', { name: 'Library' }).waitFor();
    expect(await p.getByRole('button', { name: 'Open' }).count()).toBe(7);
    p.once('dialog', (d) => d.accept());
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Remove' }).click();
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Install' }).waitFor();
    let cfg = await (await fetch(`${api}/devices`, { headers: auth })).json();
    const deviceId = cfg.devices[0].id;
    let dev = await (await fetch(`${api}/devices/${deviceId}`, { headers: auth })).json();
    expect(dev.apps.map((a: { id: string }) => a.id)).not.toContain('music-box');
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Install' }).click();
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Open' }).waitFor();
    dev = await (await fetch(`${api}/devices/${deviceId}`, { headers: auth })).json();
    expect(dev.apps.map((a: { id: string }) => a.id)).toContain('music-box');
    await p.screenshot({ path: join(dir, 'library.png') });

    // Parent area: the PIN is set on first use, and a direct jump to #/parent goes back to the PIN screen.
    await p.getByRole('button', { name: 'Home' }).click();
    await p.getByRole('button', { name: 'Parent' }).click();
    await p.getByRole('heading', { name: 'Choose a parent PIN' }).waitFor();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Type it again' }).waitFor();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Parent area' }).waitFor();
    await p.getByRole('button', { name: 'Done' }).click();
    await p.goto(`${web}/#/parent`);
    try { await p.getByRole('heading', { name: 'Parent PIN' }).waitFor({ timeout: 5000 }); } catch (e) { console.log('URL', p.url(), 'TEXT', (await p.textContent('body'))?.slice(0, 300), 'LOGS', logs.slice(-5)); throw e; }
    for (const d of '1111') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByText('That is not the PIN.').waitFor();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Parent area' }).waitFor();
    await p.getByRole('button', { name: 'Sync with the website' }).waitFor();
    await p.screenshot({ path: join(dir, 'parent.png') });
    // The PIN typed on the tablet became the family PIN; a change on the website reaches the tablet at its next check-in.
    expect((await (await fetch(`${api}/family`, { headers: auth })).json()).pinSet).toBe(true);
    await fetch(`${api}/family/pin`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ pin: '1357' }) });
    await p.getByRole('button', { name: 'Done' }).click();
    await p.reload();
    await p.getByRole('button', { name: 'Parent' }).click();
    await p.getByRole('heading', { name: 'Parent PIN' }).waitFor();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByText('That is not the PIN.').waitFor();
    for (const d of '1357') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Parent area' }).waitFor();

    // Release: back to pairing, and the server shows the device as released.
    p.once('dialog', (d) => d.accept());
    await p.getByRole('button', { name: 'Remove Duckling from this device' }).click();
    await p.getByRole('heading', { name: 'Pair this tablet' }).waitFor();
    cfg = await (await fetch(`${api}/devices`, { headers: auth })).json();
    expect(cfg.devices[0].state).toBe('released');
    expect(errors).toEqual([]);
    await b2.close();
  }, 120_000);
});
