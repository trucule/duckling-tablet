// The child web app as the Windows shell runs it: a fake window.DucklingShell with platform "windows" (the calls and
// callbacks windows/src/Duckling.Shell/ShellBridge.cs provides) against the real API. A parent pairs, sets the PIN,
// walks the three lockdown steps, joins Wi-Fi, subscribes with a card in the parent browser, and the home screen
// offers the restart Windows needs for a newly allowed app. Screenshots go to WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import type { Stripe } from '../src/stripe.js';
import { freePort, startCluster, type Cluster } from './pg.js';

const execFile = promisify(execFileCb);
const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'web', 'dist');
const TOOLS = join(ROOT, 'tools');
const ADMIN = 'admin-token-for-tests-0123456789';
const ready = existsSync(join(DIST, 'index.html')) && existsSync(join(TOOLS, 'node_modules', 'fflate'));

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, web: string, webServer: Server;
const mails: string[] = [];
const checkouts: string[] = [];
const stripe: Stripe = {
  async checkout(o) { checkouts.push(o.familyId); return 'https://checkout.stripe.com/c/pay/cs_test_windows'; },
  async portal() { return 'https://billing.stripe.com/p/session/test'; },
  async subscription() { return null; },
  async subscriptionsOf() { return []; },
  async cancel() {},
};

function serveDist(port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  return createServer((req, res) => {
    let p = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
}

// The Windows shell, as the web app sees it. Every call is recorded in window.__calls.
const FAKE_SHELL = `(() => {
  const calls = window.__calls = [];
  const st = { token: localStorage.getItem('w.token') || '', pin: localStorage.getItem('w.pin') || '', installed: JSON.parse(localStorage.getItem('w.inst') || '{}'),
    childAccount: '', lockdownOn: false, pinned: false, mic: 'off' };
  window.__setMic = (v) => { st.mic = v; };
  const save = () => { localStorage.setItem('w.token', st.token); localStorage.setItem('w.pin', st.pin); localStorage.setItem('w.inst', JSON.stringify(st.installed)); };
  const later = (f, ms = 60) => setTimeout(f, ms);
  const cb = (kind, ok, msg) => later(() => window.DucklingWeb.onWindows(kind, ok, msg));
  const status = () => ({ homeRole: !!st.childAccount, deviceSecure: true, pinned: st.pinned, lockdownOn: st.lockdownOn,
    windows: { edition: 'Professional', productName: 'Windows 11 Pro', build: 26100, kioskSupported: true, accounts: [{ name: 'Chris', fullName: 'Chris' }],
      childAccount: st.childAccount, autoSignInUser: st.childAccount, kioskApplied: st.lockdownOn, otherKiosk: !st.lockdownOn, oldKidTablet: !st.lockdownOn, currentUser: 'Chris', parentPresent: true } });
  const rec = (name, f) => (...a) => { calls.push([name, ...a]); return f ? f(...a) : undefined; };
  window.DucklingShell = {
    platform: () => 'windows', shellVersion: () => '1.0.0',
    getDeviceToken: () => st.token, setDeviceToken: rec('setDeviceToken', (t) => { st.token = t; save(); }), pushToken: () => '',
    installedApps: () => JSON.stringify(st.installed),
    installApp: rec('installApp', (id, v) => later(() => { st.installed[id] = v; save(); window.DucklingWeb.onInstall(id, true, ''); })),
    uninstallApp: rec('uninstallApp', (id) => { delete st.installed[id]; save(); }), openApp: rec('openApp'),
    hasPin: () => !!st.pin, setPin: rec('setPin', (p) => { st.pin = p; save(); }), verifyPin: (p) => p === st.pin, setPinHash: rec('setPinHash'),
    lockdownStatus: () => JSON.stringify(status()), requestHomeRole: () => {}, openSecuritySettings: () => {}, openWifiSettings: () => {},
    networkStatus: () => 'wifi',
    mediaAccess: () => JSON.stringify({ microphone: st.mic, camera: 'on' }),
    setLockdown: rec('setLockdown', (on) => { st.lockdownOn = on; cb('lockdown', true, on ? 'on' : 'off'); }),
    setAllowedHosts: rec('setAllowedHosts'), setChildInfo: rec('setChildInfo'), setChildLevels: () => {}, setChildId: () => {},
    release: rec('release'),
    installedPackages: () => JSON.stringify([{ package: 'win.app.h0123456789abcdef', label: 'Tux Paint' }]),
    launchPackage: rec('launchPackage', (pkg) => later(() => window.DucklingWeb.onOtherApp(pkg, 0, 'restart'))),
    canDrawOverlays: () => true, openOverlaySettings: () => {}, setAppAccountToken: () => {},
    setChildAccount: rec('setChildAccount', (name) => { st.childAccount = name; cb('account', true, name); }),
    restartDevice: rec('restartDevice', () => cb('restart', true, '')),
    restartSession: rec('restartSession', () => cb('restartSession', true, '')),
    wifiNetworks: rec('wifiNetworks', () => cb('wifi', true, JSON.stringify([{ ssid: 'Home', signal: 90, secured: true, connected: true }, { ssid: 'Hotel Guest', signal: 70, secured: true, connected: false }, { ssid: 'Plane', signal: 40, secured: false, connected: false }]))),
    connectWifi: rec('connectWifi', (ssid) => cb('wifiConnect', true, ssid)),
    openParentPage: rec('openParentPage', (url) => cb('parentPage', true, (url.includes('checkout') ? 'purchased ' : 'returned ') + url)),
    setOtherApps: rec('setOtherApps'), endParent: rec('endParent'), exitShell: rec('exitShell'), isChildSession: () => false,
  };
})();`;

beforeAll(async () => {
  if (!ready) return;
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-winweb-'));
  ({ db } = await cluster.newDb());
  const apiPort = await freePort(), webPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`; web = `http://127.0.0.1:${webPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: 5000, STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: api, APP_URL: web });
  ({ app } = await buildServer(cfg, { db, logger: false, stripe, mailer: { async send(_to, _s, text) { mails.push(text); } }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  webServer = serveDist(webPort);
  const { stdout: keygen } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'keygen']);
  const key = keygen.match(/^PACKAGE_SIGNING_KEY=(\S+)/m)![1];
  await execFile('node', [join(TOOLS, 'publish.mjs'), 'all', '--starter'], { env: { ...process.env, API_URL: api, ADMIN_TOKEN: ADMIN, PACKAGE_SIGNING_KEY: key, DOTENV_CONFIG_PATH: join(dir, 'none') }, maxBuffer: 1 << 24 });
}, 180_000);
afterAll(async () => {
  webServer?.close(); await app?.close(); await db?.close(); await cluster?.stop();
  if (dir && process.env.WEB_SHOTS) for (const f of ['win-setup.png', 'win-done.png', 'win-home.png']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(process.env.WEB_SHOTS, f));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)('web app on Windows', () => {
  it('walks the Windows lockdown, Wi-Fi, a card subscription and the restart for a newly allowed app', async () => {
    const { chromium } = await import('playwright');
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') => {
      const r = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return r.json();
    };
    await post('/auth/email-link', { email: 'win@example.com' });
    const token = mails.at(-1)!.match(/token=([\w-]+)/)![1];
    const { sessionToken } = await post('/auth/verify', { token });
    const auth = { authorization: `Bearer ${sessionToken}` };
    const child = await post('/children', { firstName: 'Scarlett', age: 7 }, auth);
    const { code } = await post('/devices/pairing-codes', { childId: child.id }, auth);

    const browser = await chromium.launch();
    // STORE_SHOTS=<folder> also saves Microsoft Store screenshots (1366 x 768 at 2x).
    const store = process.env.STORE_SHOTS;
    const ctx = await browser.newContext(store ? { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } });
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
    const calls = async () => p.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls);
    await p.goto(web);

    await p.getByRole('button', { name: 'I have a code from the website' }).click();
    await p.getByPlaceholder('000000').fill(code);
    await p.getByRole('button', { name: 'Pair' }).click();
    // A tablet goes straight on to the PIN.
    await p.getByRole('heading', { name: 'Choose a parent PIN' }).waitFor();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    for (const d of '2468') await p.getByRole('button', { name: d, exact: true }).click();
    await p.getByRole('heading', { name: 'Set up this device' }).waitFor();
    await p.getByText('Duckling is a window like any other').waitFor();
    await p.getByText('The older Kid Tablet setup on this device is moved aside', { exact: false }).waitFor();
    // Step 1: the account is named after the child unless one is chosen.
    expect(await p.getByLabel('Account name').inputValue()).toBe('Scarlett');
    // The box keeps what the parent types, even empty, instead of jumping back to the suggestion.
    await p.getByLabel('Account name').fill('');
    expect(await p.getByLabel('Account name').inputValue()).toBe('');
    await p.getByLabel('Account name').fill('Scarlett');
    expect(await p.getByRole('button', { name: 'Turn on' }).isDisabled()).toBe(true);
    await p.screenshot({ path: join(dir, 'win-setup.png'), fullPage: true });
    await p.getByRole('button', { name: 'Make this account' }).click();
    await p.getByText('Scarlett signs in by itself when the device starts.').waitFor();
    // A different account can be chosen afterwards.
    await p.getByRole('button', { name: 'Change' }).click();
    await p.getByLabel('Account name').fill('Kid');
    await p.getByRole('button', { name: 'Make this account' }).click();
    await p.getByText('Kid signs in by itself when the device starts.').waitFor();
    // Step 2, then step 3.
    await p.getByRole('button', { name: 'Turn on' }).click();
    await p.getByRole('button', { name: 'Turn off' }).waitFor();
    await p.getByRole('button', { name: 'Restart', exact: true }).click();
    await expect.poll(async () => (await calls()).map((c) => c[0])).toContain('restartDevice');
    expect((await calls()).filter((c) => c[0] === 'setChildAccount')).toEqual([['setChildAccount', 'Scarlett', 'Scarlett'], ['setChildAccount', 'Kid', 'Scarlett']]);
    expect((await calls()).find((c) => c[0] === 'setLockdown')).toEqual(['setLockdown', true]);
    await p.getByRole('heading', { name: 'Parent area' }).waitFor();
    if (store) { await p.getByRole('heading', { name: 'Lockdown' }).evaluate((h) => h.scrollIntoView({ block: 'start' })); await p.screenshot({ path: join(store, 'win-lockdown.png') }); }

    // Microphone and camera: Windows' switch is off for the microphone, so the card says where to turn it on, and the
    // row turns to a check mark once the switch is on.
    const media = p.locator('.card', { has: p.getByRole('heading', { name: 'Microphone and camera' }) });
    await media.getByText('Let desktop apps access it').waitFor();
    expect(await media.locator('.dot').allTextContents()).toEqual(['!', '✓']);
    if (process.env.WEB_SHOTS) await media.screenshot({ path: join(process.env.WEB_SHOTS, 'win-media.png') });
    await p.evaluate(() => (window as any).__setMic('on'));
    await p.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => /Microphone and camera/.test(c.textContent ?? '') && c.querySelectorAll('.dot.done').length === 2));
    expect(await media.getByText('Let desktop apps access it').count()).toBe(0);
    // Wi-Fi: pick a network, type its password, join.
    await p.getByRole('button', { name: 'Choose a Wi-Fi network' }).click();
    await p.getByRole('button', { name: 'Hotel Guest' }).click();
    await p.getByPlaceholder('Password').fill('guest1234');
    await p.getByRole('button', { name: 'Join' }).click();
    await p.getByText('Joining Hotel Guest.', { exact: false }).waitFor();
    expect((await calls()).find((c) => c[0] === 'connectWifi')).toEqual(['connectWifi', 'Hotel Guest', 'guest1234']);
    expect(await p.getByRole('button', { name: 'Home' }).isDisabled()).toBe(true);

    // A card subscription opens Stripe in the parent browser; the family is billed when the trial ends.
    await p.getByText('starting when the free trial ends', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Subscribe with a card, $5 a month' }).click();
    await p.getByText('Thank you. The subscription is starting.').waitFor();
    expect((await calls()).find((c) => c[0] === 'openParentPage')).toEqual(['openParentPage', 'https://checkout.stripe.com/c/pay/cs_test_windows']);
    expect(checkouts.length).toBe(1);
    await p.screenshot({ path: join(dir, 'win-done.png'), fullPage: true });
    if (store) { await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: join(store, 'win-parent.png') }); }

    // A parent allows an app the device reported; the shell is told, and the first tap asks for the restart.
    const devices = await (await fetch(`${api}/devices`, { headers: auth })).json();
    const id = devices.devices[0].id;
    await expect.poll(async () => ((await (await fetch(`${api}/devices/${id}`, { headers: auth })).json()).otherApps as { package: string }[]).map((a) => a.package)).toContain('win.app.h0123456789abcdef');
    await post(`/devices/${id}/other-apps/win.app.h0123456789abcdef`, { allowed: true, dailyMinutes: 30 }, auth, 'PUT');
    await p.getByRole('button', { name: 'Sync with the website' }).click();
    await expect.poll(async () => (await calls()).filter((c) => c[0] === 'setOtherApps').map((c) => c[1]).at(-1)).toBe('win.app.h0123456789abcdef');
    // A parent allows PBS KIDS: the shell is told the site and the hosts its videos come from, and no tile shows for those.
    await post(`/devices/${id}/settings`, { allowlist: [{ host: 'pbskids.org', tile: { name: 'PBS KIDS', url: 'https://pbskids.org/' } }] }, auth, 'PUT');
    await p.getByRole('button', { name: 'Sync with the website' }).click();
    await expect.poll(async () => String((await calls()).filter((c) => c[0] === 'setAllowedHosts').map((c) => c[1]).at(-1)).split(',').sort())
      .toEqual(['kids.pbs-video.pbs.org', 'pbskids.org', 'proxy.drm.pbs.org', 'urs-anonymous-detect.pbs.org', 'urs.pbs.org']);
    await p.getByRole('button', { name: 'Done' }).click();
    expect((await calls()).map((c) => c[0])).toContain('endParent');
    await p.getByRole('button', { name: 'Tux Paint' }).click();
    await p.getByText('Tux Paint is ready.', { exact: false }).waitFor();
    await p.screenshot({ path: join(dir, 'win-home.png'), fullPage: true });
    await p.getByText('Tux Paint is ready.', { exact: false }).click();
    await expect.poll(async () => (await calls()).map((c) => c[0])).toContain('restartSession');
    expect(errors).toEqual([]);
    await browser.close();
  }, 120_000);
});
