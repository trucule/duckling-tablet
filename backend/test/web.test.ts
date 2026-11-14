// The child web app (web/dist) in a real browser against a real API: a parent signs in and makes a pairing code,
// the browser pairs, sees the starter apps, installs one from the Library, sets the parent PIN, opens the parent
// area and removes the device. Skipped when web/dist or the publish tool's dependencies are missing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import { freePort, startCluster, type Cluster } from './pg.js';

// The starter set, read from the manifests so the tests follow it when an app joins or leaves the set.
const STARTERS = readdirSync(join(import.meta.dirname, '..', '..', 'apps')).filter((d) => existsSync(join(import.meta.dirname, '..', '..', 'apps', d, 'manifest.json')) && JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'apps', d, 'manifest.json'), 'utf8')).starter).sort();

const execFile = promisify(execFileCb);
const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'web', 'dist');
const TOOLS = join(ROOT, 'tools');
const ADMIN = 'admin-token-for-tests-0123456789';
const ready = existsSync(join(DIST, 'index.html')) && existsSync(join(TOOLS, 'node_modules', 'fflate'));

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, web: string, webServer: Server;
const mails: string[] = [];
let swVersion = '';

function serveDist(port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  return createServer((req, res) => {
    let p = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? (p.endsWith('.webmanifest') ? 'application/manifest+json' : 'application/octet-stream') });
    // A deploy of a new home screen version: the service worker's bytes change.
    if (p.endsWith('sw.js') && swVersion) return res.end(readFileSync(p, 'utf8') + `\n// ${swVersion}\n`);
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
  const cfg = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: 5000, STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: api, APP_URL: web });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(_to, _s, text) { mails.push(text); } }, synth: async () => null, createTicket: async () => null,
    // A website that publishes a touch icon, for the website tile.
    fetchUrl: async (url) => url === 'https://pbskids.org/' ? { status: 200, type: 'text/html', body: Buffer.from('<link rel="apple-touch-icon" href="/t.png">') }
      : url === 'https://pbskids.org/t.png' ? { status: 200, type: 'image/png', body: readFileSync(join(TOOLS, '..', 'site', 'logo.png')) } : { status: 404, type: '', body: Buffer.alloc(0) } }));
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
  if (dir && process.env.WEB_SHOTS) { const { cpSync } = await import('node:fs'); for (const f of ['home.png', 'home-bg.png', 'bg-card.png', 'site-tile.png', 'library.png', 'parent.png', 'ask.png', 'ask-sent.png']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(process.env.WEB_SHOTS, f)); }
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
    const routed = async () => {
      const c = await b2.newContext({ viewport: { width: 1280, height: 800 } });
      await c.route('https://api.ducklingtablet.com/**', async (route) => {
        const req = route.request();
        const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
        await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
      });
      return c;
    };
    const ctx = await routed();
    const p = await ctx.newPage();
    const errors: string[] = [], logs: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
    p.on('requestfailed', (r) => logs.push('failed ' + r.url() + ' ' + r.failure()?.errorText));
    await p.goto(web);

    // A parent who installed the app first sets up everything on the tablet: email, the six-digit code, the child.
    // (A second browser context, so the main flow below still exercises the pairing code from the website.)
    const fresh = await routed();
    const t = await fresh.newPage(); await t.goto(web);
    await t.getByPlaceholder('parent@example.com').fill('new@example.com');
    await t.getByRole('button', { name: 'Send the code' }).click();
    await t.getByRole('heading', { name: 'Type the code' }).waitFor();
    const six = mails.at(-1)!.match(/(\d{3}) (\d{3})/)!.slice(1).join('');
    await t.getByPlaceholder('000000').fill(six);
    await t.getByRole('button', { name: 'Next' }).click();
    await t.getByPlaceholder('Ada').fill('Noor');
    await t.getByPlaceholder('7').fill('5');
    await t.getByRole('button', { name: 'Finish setup' }).click();
    await t.getByRole('heading', { name: "Noor's tablet" }).waitFor();
    // The child's home screen tells the parent where the trial stands and what subscribing keeps.
    await t.getByText('Free trial: 7 days left', { exact: false }).waitFor();
    await t.getByText('request new apps at no charge', { exact: false }).waitFor();
    await t.getByRole('button', { name: 'Parent' }).click();
    for (const d of '1357') await t.getByRole('button', { name: d, exact: true }).click();
    for (const d of '1357') await t.getByRole('button', { name: d, exact: true }).click();
    await t.getByText('Free trial: 7 days left', { exact: false }).waitFor();
    await t.getByText('Ask for an app, at no extra cost.').waitFor();

    // The trial ends: the next check-in locks the home screen. The apps stay as greyed tiles, a tap only explains,
    // the Library is off, and the parent area still opens so a parent can subscribe.
    await db.system((q) => q.run("UPDATE entitlement SET current_period_end = now() - interval '1 minute' WHERE family_id = (SELECT family_id FROM parent WHERE email = 'new@example.com')"));
    await t.getByRole('button', { name: 'Sync with the website' }).click();
    await t.getByText('The free trial has ended', { exact: false }).waitFor();
    await t.getByRole('button', { name: 'Done' }).click();
    await t.getByText('The free trial has ended, so the apps are locked', { exact: false }).waitFor();
    await t.getByRole('button', { name: 'Word Wizard' }).click();
    await t.getByText('The apps are locked. Ask a parent to subscribe.').waitFor();
    expect(await t.getByRole('button', { name: 'Word Wizard' }).getAttribute('class')).toContain('off');
    await t.getByRole('button', { name: 'Library' }).click();
    await t.getByRole('heading', { name: "Noor's tablet" }).waitFor(); // still home, not the Library
    await t.getByRole('button', { name: 'Parent', exact: true }).click();
    for (const d of '1357') await t.getByRole('button', { name: d, exact: true }).click();
    await t.getByRole('heading', { name: 'Parent area' }).waitFor();
    await fresh.close();

    // Installable and offline-capable: manifest and service worker are served.
    const manifest = await (await fetch(`${web}/manifest.webmanifest`)).json();
    expect(manifest.name).toBe('Duckling Tablet');
    expect((await fetch(`${web}/sw.js`)).status).toBe(200);

    // Pair.
    await p.getByRole('button', { name: 'I have a code from the website' }).click();
    await p.getByPlaceholder('000000').fill(code);
    await p.getByRole('button', { name: 'Pair' }).click();
    try { await p.getByRole('heading', { name: "Ada's tablet" }).waitFor({ timeout: 8000 }); }
    catch (e) { console.log('PAGE TEXT:', (await p.textContent('body'))?.slice(0, 600), '\nERRORS:', errors, '\nLOGS:', logs); throw e; }
    // Starter apps arrive as tiles and the browser shell marks them installed.
    for (const name of ['Count With Me', 'Draw With Me', 'Music Box', 'Robot Path', 'Trace With Me', 'Word Wizard']) {
      await p.getByRole('button', { name }).waitFor();
    }
    await p.waitForFunction((n) => Object.keys(JSON.parse(localStorage.getItem('duckling.installed') || '{}')).length === n, STARTERS.length);
    const theme = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c1').trim());
    expect(theme).toBe('#ffb3c6');
    // A website tile shows the site's own icon.
    const [{ id: adaDevice }] = await db.system((q) => q.all("SELECT d.id FROM device d JOIN child c ON c.id = d.child_id WHERE c.first_name = 'Ada'"));
    await fetch(`${api}/devices/${adaDevice}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ allowlist: [{ host: 'pbskids.org', tile: { name: 'PBS KIDS', url: 'https://pbskids.org/' } }] }) });
    await p.evaluate(() => (window as any).DucklingWeb.onPush()); // what a push does: check in now
    await p.getByRole('button', { name: 'PBS KIDS' }).waitFor();
    await p.waitForFunction(() => { const i = document.querySelector('.art.site img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; });
    await p.getByRole('button', { name: 'PBS KIDS' }).screenshot({ path: join(dir, 'site-tile.png') });
    await p.screenshot({ path: join(dir, 'home.png') });
    // A new home screen version is deployed while the tablet is on: coming back from an app finds it, and the page
    // reloads into it without anyone restarting Duckling.
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await p.evaluate(() => { (window as any).oldVersion = true; });
    swVersion = 'v2';
    await p.evaluate(() => (window as any).DucklingWeb.onResume());
    await p.waitForFunction(() => !(window as any).oldVersion, null, { timeout: 20000 });
    await p.getByRole('button', { name: 'PBS KIDS' }).waitFor();
    // A picture she saved in an app becomes the home background (what KidTablet.setHomeBackground sends).
    const picture = await p.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 800; const g = c.getContext('2d')!;
      const sky = g.createLinearGradient(0, 0, 0, 800); sky.addColorStop(0, '#7cc8ff'); sky.addColorStop(1, '#ffe6a8'); g.fillStyle = sky; g.fillRect(0, 0, 1280, 800);
      g.fillStyle = '#ffcc33'; g.beginPath(); g.arc(1000, 180, 90, 0, 7); g.fill(); g.fillStyle = '#4caf50'; g.fillRect(0, 600, 1280, 200);
      return c.toDataURL('image/jpeg', 0.85);
    });
    const devToken = await p.evaluate(() => localStorage.getItem('duckling.token'));
    expect((await fetch(`${api}/device/child/background`, { method: 'PUT', headers: { authorization: `Device ${devToken}`, 'content-type': 'text/plain' }, body: picture })).status).toBe(200);
    await p.evaluate(() => (window as any).DucklingWeb.onPush());
    await p.waitForFunction(() => /background\?exp=/.test((document.querySelector('.screen.with-bg') as HTMLElement | null)?.style.backgroundImage ?? ''));
    await p.waitForTimeout(400);
    await p.screenshot({ path: join(dir, 'home-bg.png') });
    // The child's own character sits in a circle at the top (her first letter until My Avatar saves a portrait), and
    // tapping it opens My Avatar (the browser shell says apps run on the tablet).
    const avatar = p.getByRole('button', { name: 'Your avatar', exact: true });
    expect(await avatar.textContent()).toBe('A');
    const opened = new Promise<string>((resolve) => p.once('dialog', (d) => { resolve(d.message()); void d.accept(); }));
    await avatar.click();
    expect(await opened).toMatch(/Apps run on the tablet/);

    // Library: every starter app shows Open; removing one and installing it again round-trips through the server.
    await p.getByRole('button', { name: 'Library' }).click();
    await p.getByRole('heading', { name: 'Library' }).waitFor();
    expect(await p.getByRole('button', { name: 'Open' }).count()).toBe(STARTERS.length);
    p.once('dialog', (d) => d.accept());
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Remove' }).click();
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Install' }).waitFor();
    let cfg = await (await fetch(`${api}/devices`, { headers: auth })).json();
    const deviceId = cfg.devices[0].id;
    // The tablet removes first and tells the server right after, so wait for the server as the install below does.
    await expect.poll(async () => ((await (await fetch(`${api}/devices/${deviceId}`, { headers: auth })).json()).apps as { id: string }[]).map((a) => a.id)).not.toContain('music-box');
    let dev = await (await fetch(`${api}/devices/${deviceId}`, { headers: auth })).json();
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Install' }).click();
    await p.locator('.store-row', { hasText: 'Music Box' }).getByRole('button', { name: 'Open' }).waitFor();
    // The tablet installs first and tells the server right after.
    await expect.poll(async () => ((await (await fetch(`${api}/devices/${deviceId}`, { headers: auth })).json()).apps as { id: string }[]).map((a) => a.id)).toContain('music-box');
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
    // The first card points a phone at the parent portal: a QR code that is served, and the Sync button beside it.
    const headings = await p.locator('h2').allTextContents();
    expect(headings[0]).toBe('Manage this tablet from your phone');
    const qr = p.getByRole('img', { name: 'QR code for parents.ducklingtablet.com' });
    await expect.poll(() => qr.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await p.getByRole('button', { name: 'Sync with the website' }).waitFor();
    await p.screenshot({ path: join(dir, 'parent.png') });
    // Ask for an app from the tablet: sent with the child's grade, shown while it is in progress, withdrawn here.
    const ask = p.locator('.card.ask');
    await ask.getByLabel('Name for the app').fill('Dinosaur counting');
    await ask.getByLabel('What it should do').fill('Dinosaurs hatch from eggs and she counts them up to twenty.');
    await ask.scrollIntoViewIfNeeded();
    await p.screenshot({ path: join(dir, 'ask.png') });
    await ask.getByRole('button', { name: 'Send the request' }).click();
    await ask.getByText('Dinosaur counting', { exact: false }).first().waitFor();
    await ask.getByText(': Received.', { exact: false }).waitFor();
    const sent = await db.system((q) => q.one("SELECT title, child_grade, status FROM app_request WHERE title = 'Dinosaur counting'"));
    expect(sent).toEqual({ title: 'Dinosaur counting', child_grade: '1', status: 'requested' });
    await ask.scrollIntoViewIfNeeded();
    await p.screenshot({ path: join(dir, 'ask-sent.png') });
    await ask.getByRole('button', { name: 'Withdraw this request' }).click();
    await ask.getByRole('button', { name: 'Withdraw it' }).click();
    await ask.getByRole('button', { name: 'Send the request' }).waitFor();
    await ask.getByText('Last request: Dinosaur counting, withdrawn.').waitFor();
    // The parent area shows the home background and removes it; the home screen goes back to plain.
    const bgCard = p.locator('.card', { has: p.getByRole('heading', { name: 'Home background' }) });
    await bgCard.locator('img.bg-preview').waitFor();
    await bgCard.scrollIntoViewIfNeeded();
    await p.screenshot({ path: join(dir, 'bg-card.png') });
    await bgCard.getByRole('button', { name: 'Remove it' }).click();
    await bgCard.getByText('None. Your child can pick one', { exact: false }).waitFor();
    expect(await p.evaluate(() => document.querySelector('.with-bg'))).toBeNull();
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

    // Removed on the website: the server answers 410, the tablet keeps its apps and asks for a new pairing code in
    // the parent area; a code from the website links it to the family again, with the apps it had.
    const before = await (await fetch(`${api}/devices`, { headers: auth })).json();
    await fetch(`${api}/devices/${before.devices[0].id}`, { method: 'DELETE', headers: auth });
    // Music Box stops being a starter, so a fresh pairing would not list it; the relink adds it back from the tablet.
    await db.system((q) => q.run("UPDATE app SET starter = false WHERE id = 'music-box'"));
    await p.getByRole('button', { name: 'Sync with the website' }).click();
    await p.getByRole('heading', { name: 'Link this tablet to your family' }).waitFor();
    await p.getByRole('button', { name: 'Done' }).click();
    await p.getByText('This tablet is not linked to a family.').waitFor();
    await p.getByRole('button', { name: 'Word Wizard' }).waitFor(); // the tiles stay
    await p.reload();
    await p.getByText('This tablet is not linked to a family.').waitFor(); // and survive a restart
    await p.getByRole('button', { name: 'Parent', exact: true }).click();
    for (const d of '1357') await p.getByRole('button', { name: d, exact: true }).click();
    const { code: code2 } = await post('/devices/pairing-codes', { childId: child.id }, auth);
    await p.getByLabel('Pairing code').fill(code2);
    await p.getByLabel('Name for this tablet').fill('Kitchen tablet');
    await p.getByRole('button', { name: 'Link' }).click();
    await p.getByRole('heading', { name: 'Manage this tablet from your phone' }).waitFor();
    const relinked = await (await fetch(`${api}/devices`, { headers: auth })).json();
    expect(relinked.devices.map((d: { name: string; state: string }) => [d.name, d.state])).toEqual([['Kitchen tablet', 'active']]);
    const relinkedApps = (await (await fetch(`${api}/devices/${relinked.devices[0].id}`, { headers: auth })).json()).apps.map((a: { id: string }) => a.id);
    expect(relinkedApps).toContain('music-box');
    expect(relinkedApps.length).toBe(STARTERS.length);
    await db.system((q) => q.run("UPDATE app SET starter = true WHERE id = 'music-box'"));
    await p.getByRole('button', { name: 'Done' }).click();
    await p.getByRole('button', { name: 'Word Wizard' }).waitFor();
    await p.getByRole('button', { name: 'Parent', exact: true }).click();
    for (const d of '1357') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Parent area' }).waitFor();

    // Release: back to pairing, and the server shows the device as released.
    p.once('dialog', (d) => d.accept());
    await p.getByRole('button', { name: 'Remove Duckling from this device' }).click();
    await p.getByRole('heading', { name: 'Set up Duckling' }).waitFor();
    cfg = await (await fetch(`${api}/devices`, { headers: auth })).json();
    expect(cfg.devices[0].state).toBe('released');
    expect(errors).toEqual([]);
    await b2.close();
  }, 120_000);
});
