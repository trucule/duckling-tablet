// Continue with Google on a tablet and in the portal, in the built web app and portal against the real API, with the
// providers' key sets replaced by a test key. A fake Android shell answers the sign-in with a token for the nonce the
// page asked for; the tablet joins a new family. In the portal the parent signs in with the same Google account and
// reaches that family, then links a Microsoft account from Sign-in methods through the popup, whose provider page
// the test stands in for. Screenshots go to WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { JWKS_URLS } from '../src/idtoken.js';
import type { Db } from '../src/db.js';
import { freePort, startCluster, type Cluster } from './pg.js';

const ROOT = join(import.meta.dirname, '..', '..');
const WEB_DIST = join(ROOT, 'web', 'dist'), PORTAL_DIST = join(ROOT, 'portal', 'dist');
const ready = existsSync(join(WEB_DIST, 'index.html')) && existsSync(join(PORTAL_DIST, 'index.html'));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const fetchJwks = async (url: string) => { if (!Object.values(JWKS_URLS).includes(url)) throw new Error(url); return KEYS; };
const ISS = { google: 'https://accounts.google.com', microsoft: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' };
const AUD = { google: 'web-client.apps.googleusercontent.com', microsoft: '11111111-2222-3333-4444-555555555555' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(provider: keyof typeof ISS, claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ iss: ISS[provider], aud: AUD[provider], iat: now, exp: now + 600, ...claims })}`;
  return `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}`;
}

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, web: string, portal: string, servers: Server[] = [];

function serve(dist: string, port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  return createServer((req, res) => {
    let p = join(dist, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
}

// An Android shell signed in to Google. signIn() waits for the test to answer through DucklingWeb.onSignIn.
const FAKE_SHELL = `(() => {
  const st = { token: localStorage.getItem('b.token') || '', pin: '' };
  window.__signIns = [];
  window.DucklingShell = {
    platform: () => 'android', shellVersion: () => '1.1.0',
    getDeviceToken: () => st.token, setDeviceToken: (t) => { st.token = t; localStorage.setItem('b.token', t); }, pushToken: () => '',
    installedApps: () => '{}', installApp: () => {}, uninstallApp: () => {}, openApp: () => {},
    hasPin: () => !!st.pin, setPin: (p) => { st.pin = p; }, verifyPin: (p) => p === st.pin, setPinHash: () => {},
    lockdownStatus: () => JSON.stringify({ homeRole: false, deviceSecure: false, pinned: false, lockdownOn: false }),
    requestHomeRole: () => {}, openSecuritySettings: () => {}, networkStatus: () => 'wifi',
    setLockdown: () => {}, setAllowedHosts: () => {}, setSignInHosts: () => {}, setChildInfo: () => {}, setChildLevels: () => {}, setChildId: () => {},
    setLanguage: () => {}, release: () => {}, installedPackages: () => '[]', launchPackage: () => {}, canDrawOverlays: () => true, openOverlaySettings: () => {}, setAppAccountToken: () => {},
    signInProviders: () => 'google',
    signIn: (provider, nonce, clientId) => { window.__signIns.push({ provider, nonce, clientId }); },
  };
})();`;

beforeAll(async () => {
  if (!ready) return;
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-signin-web-'));
  ({ db } = await cluster.newDb());
  const [apiPort, webPort, portalPort] = [await freePort(), await freePort(), await freePort()];
  api = `http://127.0.0.1:${apiPort}`; web = `http://127.0.0.1:${webPort}`; portal = `http://127.0.0.1:${portalPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: 5000, STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), PUBLIC_URL: api, APP_URL: web, PORTAL_URL: portal,
    GOOGLE_SIGNIN_CLIENT_IDS: AUD.google, MICROSOFT_SIGNIN_CLIENT_IDS: AUD.microsoft });
  ({ app } = await buildServer(cfg, { db, logger: false, fetchJwks, mailer: { async send() {} }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  servers = [serve(WEB_DIST, webPort), serve(PORTAL_DIST, portalPort)];
}, 120_000);
afterAll(async () => {
  for (const s of servers) s.close();
  await app?.close(); await db?.close(); await cluster?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)('Continue with Google and Sign-in methods', () => {
  it('sets a tablet up with the device account, signs in to the portal with it, and links Microsoft', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
      const req = route.request();
      const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
      await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    });
    // The providers' sign-in pages: answer at once by returning to the page the portal named, as the provider would.
    for (const [provider, host] of [['google', 'https://accounts.google.com/**'], ['microsoft', 'https://login.microsoftonline.com/**']] as const) {
      await ctx.route(host, async (route) => {
        const u = new URL(route.request().url());
        const q = u.searchParams;
        expect(q.get('client_id')).toBe(AUD[provider]);
        const claims = provider === 'google' ? { sub: 'g-1', email: 'mom@example.com', email_verified: true, nonce: q.get('nonce') } : { sub: 'ms-1', email: 'mom@outlook.example', nonce: q.get('nonce') };
        await route.fulfill({ status: 302, headers: { location: `${q.get('redirect_uri')}#id_token=${token(provider, claims)}&state=${q.get('state')}` } });
      });
    }
    const errors: string[] = [];

    // The tablet: one press on Continue with Google, then the child's name.
    const tab = await ctx.newPage();
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.addInitScript(FAKE_SHELL);
    await tab.goto(web);
    const cont = tab.getByRole('button', { name: 'Continue with Google' });
    await cont.waitFor();
    if (process.env.WEB_SHOTS) await tab.screenshot({ path: join(process.env.WEB_SHOTS, 'signin-tablet.png') });
    await cont.click();
    await tab.waitForFunction(() => (window as unknown as { __signIns: unknown[] }).__signIns.length === 1);
    const asked = await tab.evaluate(() => (window as unknown as { __signIns: { provider: string; nonce: string; clientId: string }[] }).__signIns[0]);
    expect(asked).toMatchObject({ provider: 'google', clientId: AUD.google });
    const idToken = token('google', { sub: 'g-1', email: 'Mom@Example.com', email_verified: true, nonce: asked.nonce });
    await tab.evaluate((t) => (window as unknown as { DucklingWeb: { onSignIn(s: string, t: string, m: string): void } }).DucklingWeb.onSignIn('ok', t, ''), idToken);
    await tab.getByRole('heading', { name: 'Who is this tablet for?' }).waitFor();
    await tab.getByLabel("Child's first name").fill('Ada');
    await tab.getByLabel('Age').fill('7');
    await tab.getByRole('button', { name: 'Finish setup' }).click();
    await tab.getByRole('heading', { name: 'Choose a parent PIN' }).waitFor();
    expect(await tab.evaluate(() => localStorage.getItem('b.token'))).toMatch(/\S{20,}/);
    // After the PIN the tablet lands on its home screen, whose banner says it is not locked down yet.
    for (const d of '24682468') await tab.getByRole('button', { name: d, exact: true }).click();
    const banner = tab.getByText('This tablet is not locked down yet.');
    await banner.waitFor();
    if (process.env.WEB_SHOTS) await tab.screenshot({ path: join(process.env.WEB_SHOTS, 'signin-home.png') });
    await banner.click();
    await tab.getByRole('heading', { name: /^Set up / }).waitFor();

    // The portal: the same Google account reaches the family with that tablet.
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => void d.accept());
    await p.goto(portal);
    const google = p.getByRole('button', { name: 'Continue with Google' });
    await google.waitFor();
    expect(await p.getByRole('button', { name: 'Continue with Microsoft' }).count()).toBe(1);
    if (process.env.WEB_SHOTS) await p.locator('.card').first().screenshot({ path: join(process.env.WEB_SHOTS, 'signin-portal.png') });
    await google.click();
    await p.getByText('Ada', { exact: true }).first().waitFor();
    const card = p.locator('.card', { has: p.getByRole('heading', { name: 'Sign-in methods' }) });
    await card.locator('li', { hasText: 'Google' }).getByText('mom@example.com').waitFor();
    await card.locator('li', { hasText: 'Microsoft' }).getByText('not linked').waitFor();
    // Every Link button looks the same: plain, whichever company it is for.
    expect(await card.locator('button.signin').count()).toBe(0);
    await card.locator('li', { hasText: 'Microsoft' }).getByRole('button', { name: 'Link' }).click();
    await card.getByText('Linked. A tablet set up with that account joins this family.').waitFor();
    await card.locator('li', { hasText: 'Microsoft' }).getByText('mom@outlook.example').waitFor();
    if (process.env.WEB_SHOTS) await card.screenshot({ path: join(process.env.WEB_SHOTS, 'signin-methods.png') });

    // A tablet set up with the linked Microsoft account joins the same family.
    const ms = await (await fetch(`${api}/auth/provider/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'microsoft', idToken: token('microsoft', { sub: 'ms-1', email: 'other@outlook.example' }), platform: 'windows', name: 'Surface', childFirstName: 'Ada' }) })).json();
    expect(ms.newFamily).toBe(false);
    const devices = await (await fetch(`${api}/device/config`, { headers: { authorization: `Device ${ms.deviceToken}` } })).json();
    expect(devices.child.firstName).toBe('Ada');

    // Removing the sign-in leaves the parent signed in.
    await card.locator('li', { hasText: 'Microsoft' }).getByRole('button', { name: 'Remove' }).click();
    await card.locator('li', { hasText: 'Microsoft' }).getByText('not linked').waitFor();
    await p.reload();
    await card.waitFor();
    expect(await card.locator('li', { hasText: 'Google' }).getByText('mom@example.com').count()).toBe(1);
    expect(errors).toEqual([]);
    await browser.close();
  }, 120_000);
});
