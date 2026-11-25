// The parent area's Blocked on websites card and Report a problem, in the built web app with a fake Android shell
// against the real API. The shell has refused a video host on an allowed site; its Video blocked button opens the
// parent area at #/parent-blocked behind the PIN, a parent allows the host, and the tablet's next config lets it
// through. Then the parent sends diagnostics with a note and the ticket carries the summary. Screenshots go to
// WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import type { TicketInput } from '../src/etducky.js';
import { freePort, startCluster, type Cluster } from './pg.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'web', 'dist');
const ready = existsSync(join(DIST, 'index.html'));

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, web: string, webServer: Server;
const mails: string[] = [];
const tickets: TicketInput[] = [];

function serveDist(port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  return createServer((req, res) => {
    let p = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
}

// An Android shell that has refused hosts on getepic.com: a video playlist host and an analytics host.
const FAKE_SHELL = `(() => {
  const calls = window.__calls = [];
  const st = { token: localStorage.getItem('b.token') || '', pin: localStorage.getItem('b.pin') || '' };
  const save = () => { localStorage.setItem('b.token', st.token); localStorage.setItem('b.pin', st.pin); };
  const rec = (name, f) => (...a) => { calls.push([name, ...a]); return f ? f(...a) : undefined; };
  // What the shell refused while a website showed; the test puts it here once the site is allowed.
  window.__refuse = () => localStorage.setItem('b.refused', JSON.stringify([
    { page: 'www.getepic.com', host: 'www.getepicapi.example', media: true, hits: 4 },
    { page: 'www.getepic.com', host: 'www.googletagmanager.com', media: false, hits: 2 },
  ]));
  window.DucklingShell = {
    platform: () => 'android', shellVersion: () => '1.1.0',
    getDeviceToken: () => st.token, setDeviceToken: rec('setDeviceToken', (t) => { st.token = t; save(); }), pushToken: () => '',
    installedApps: () => '{}', installApp: () => {}, uninstallApp: () => {}, openApp: () => {},
    hasPin: () => !!st.pin, setPin: (p) => { st.pin = p; save(); }, verifyPin: (p) => p === st.pin, setPinHash: () => {},
    lockdownStatus: () => JSON.stringify({ homeRole: true, deviceSecure: true, pinned: true, lockdownOn: true }),
    requestHomeRole: () => {}, openSecuritySettings: () => {}, openWifiSettings: () => {}, networkStatus: () => 'wifi',
    mediaAccess: () => JSON.stringify({ microphone: 'on', camera: 'on' }), clearWebsiteData: () => {},
    takeBlockedHosts: rec('takeBlockedHosts', () => { const r = localStorage.getItem('b.refused') || '[]'; localStorage.removeItem('b.refused'); return r; }),
    setQuietHosts: rec('setQuietHosts'), shellLog: () => 'shell started\\nwebview ready',
    setLockdown: () => {}, setAllowedHosts: rec('setAllowedHosts'), setSignInHosts: () => {}, setChildInfo: () => {}, setChildLevels: () => {}, setChildId: () => {},
    setLanguage: () => {}, release: () => {}, installedPackages: () => '[]', launchPackage: () => {}, canDrawOverlays: () => true, openOverlaySettings: () => {}, setAppAccountToken: () => {},
  };
})();`;

beforeAll(async () => {
  if (!ready) return;
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-blocked-'));
  ({ db } = await cluster.newDb());
  const apiPort = await freePort(), webPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`; web = `http://127.0.0.1:${webPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: 5000, STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), PUBLIC_URL: api, APP_URL: web });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(_to, _s, text) { mails.push(text); } }, synth: async () => null,
    createTicket: async (t) => { tickets.push(t); return `T-${tickets.length}`; } }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  webServer = serveDist(webPort);
}, 120_000);
afterAll(async () => {
  webServer?.close(); await app?.close(); await db?.close(); await cluster?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)('blocked addresses and diagnostics in the parent area', () => {
  it('opens at the refused hosts behind the PIN, allows a video host, and sends a diagnostics report', async () => {
    const { chromium } = await import('playwright');
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') => {
      const r = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return r.json();
    };
    await post('/auth/email-link', { email: 'blocked@example.com' });
    const token = mails.at(-1)!.match(/token=([\w-]+)/)![1];
    const { sessionToken } = await post('/auth/verify', { token });
    const auth = { authorization: `Bearer ${sessionToken}` };
    const child = await post('/children', { firstName: 'Scarlett', age: 7 }, auth);
    const { code } = await post('/devices/pairing-codes', { childId: child.id }, auth);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
      const req = route.request();
      const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
      await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    });
    await ctx.addInitScript(FAKE_SHELL);
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => void d.accept());
    await p.goto(web);
    await p.getByRole('button', { name: 'I have a code from the website' }).click();
    await p.getByPlaceholder('000000').fill(code);
    await p.getByRole('button', { name: 'Pair' }).click();
    await p.getByRole('heading', { name: 'Choose a parent PIN' }).waitFor();
    for (const d of '24682468') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Parent area' }).waitFor();
    const deviceId = (await (await fetch(`${api}/devices`, { headers: auth })).json()).devices[0].id;
    await post(`/devices/${deviceId}/settings`, { allowlist: [{ host: 'getepic.com', tile: { name: 'Epic', url: 'https://www.getepic.com/app' } }] }, auth, 'PUT');
    await p.getByRole('button', { name: 'Done' }).click();
    await p.evaluate(() => (window as unknown as { __refuse: () => void }).__refuse());

    // The shell's Video blocked button: the web app opens at #/parent-blocked, asks for the PIN, and shows the hosts.
    await p.goto(`${web}/#/parent-blocked`);
    await p.getByRole('heading', { name: 'Parent PIN' }).waitFor();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    const card = p.locator('.card', { has: p.getByRole('heading', { name: 'Blocked on websites' }) });
    await card.getByText('www.getepicapi.example').waitFor();
    // It is the first card, above the rest of the parent area.
    expect(await p.locator('.card').first().getByRole('heading', { name: 'Blocked on websites' }).count()).toBe(1);
    // The analytics host is folded away until asked for.
    expect(await card.getByText('www.googletagmanager.com').count()).toBe(0);
    await card.getByRole('button', { name: 'Show 1 advertising or analytics address' }).waitFor();
    if (process.env.WEB_SHOTS) await card.screenshot({ path: join(process.env.WEB_SHOTS, 'blocked-card.png') });
    await card.locator('li', { hasText: 'www.getepicapi.example' }).getByRole('button', { name: 'Allow' }).click();
    await card.getByText('Allowed', { exact: true }).waitFor();
    // The tablet's next config lets it through, for that site, and the shell has it among the allowed hosts.
    const cfg = await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${await p.evaluate(() => localStorage.getItem('b.token'))}` } })).json();
    expect(cfg.mediaHosts).toContain('www.getepicapi.example');
    const calls = await p.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls);
    expect(calls.filter((c) => c[0] === 'setAllowedHosts').at(-1)![1]).toContain('www.getepicapi.example');
    expect(calls.some((c) => c[0] === 'setQuietHosts' && String(c[1]).includes('googletagmanager.com'))).toBe(true);
    if (process.env.WEB_SHOTS) await card.screenshot({ path: join(process.env.WEB_SHOTS, 'blocked-allowed.png') });

    // Report a problem: the note and the report reach a ticket.
    const report = p.locator('.card', { has: p.getByRole('heading', { name: 'Report a problem' }) });
    await report.getByLabel('What happened? (optional)').fill('Epic videos would not play for Scarlett.');
    await report.getByRole('button', { name: 'Send diagnostics' }).click();
    await report.getByText(/^Sent\. The reference is diag_/).waitFor();
    if (process.env.WEB_SHOTS) await report.screenshot({ path: join(process.env.WEB_SHOTS, 'diagnostics-sent.png') });
    const t = tickets.at(-1)! as Extract<TicketInput, { kind: 'diagnostics' }>;
    expect(t.kind).toBe('diagnostics');
    expect(t.title).toBe('Diagnostics: android 1.1.0: Epic videos would not play for [name].');
    expect(t.body).toContain('getepic.com > www.getepicapi.example (video) x4 [allowed]');
    expect(t.body).toContain('Lockdown: on true, pinned true');
    expect(t.body).not.toContain('Scarlett');
    const full = await (await fetch(t.body.match(/(http:\/\/127\.0\.0\.1:\d+\/diagnostics\/\S+)/)![1])).json();
    expect(full.client.shellLog).toContain('webview ready');
    expect(full.client.app.build).toMatch(/\S+ \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
    expect(JSON.stringify(full)).not.toContain('Scarlett');
    expect(errors).toEqual([]);
    await browser.close();
  }, 120_000);
});
