// App Store screenshots for the iPad, 13-inch landscape (2752 x 2064): the home screen, five apps, the Library and
// the parent area, in English or Spanish. Runs only when asked:
//
//   cd backend && IPAD_SHOTS=/some/folder IPAD_LANG=es npx vitest run test/store-shots.test.ts
//
// The home screen, Library and parent area are the built web app (web/dist) against a real API, as an iPad shell
// shows them (a fake window.DucklingShell with platform "ios"). The apps are served from apps/<id> with the compat
// script and a DucklingApp bridge, as the shells run them. Math.random is seeded, so a run gives the same pictures.
import { describe, it, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
const OUT = process.env.IPAD_SHOTS ?? '';
const LANG = process.env.IPAD_LANG === 'es' ? 'es' : 'en';
const ES = LANG === 'es';
const CHILD = ES ? 'Lucía' : 'Ada';
const ready = !!OUT && existsSync(join(DIST, 'index.html')) && existsSync(join(TOOLS, 'node_modules', 'fflate'));
// The home screen's apps (the English screenshots' set) and the stars she has earned.
const HOME_APPS = ['chemistry-lab', 'count-with-me', 'draw-with-me', 'fraction-pizza', 'music-box', 'my-avatar', 'planet-explorer', 'read-it-say-it-make-it', 'robot-path', 'story-maker', 'trace-with-me', 'word-wizard'];
const STARS: Record<string, number> = { 'word-wizard': 12, 'count-with-me': 9, 'planet-explorer': 7, 'draw-with-me': 6 };
const VIEW = { viewport: { width: 1376, height: 1032 }, deviceScaleFactor: 2, locale: ES ? 'es-MX' : 'en-US' };
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const SEED = `(() => { let a = 20261121; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();`;
// Narration ends at once, so apps that wait for a line keep moving.
const VOICE_STUB = `(() => { const ss = window.speechSynthesis; if (!ss) return; ss.speak = (u) => { setTimeout(() => { try { u.dispatchEvent(new Event('start')); } catch (e) {} setTimeout(() => { try { u.dispatchEvent(new Event('end')); } catch (e) {} }, 250); }, 10); }; ss.cancel = () => {}; ss.getVoices = () => []; })();`;

// The iPad shell as the web app sees it (ios/DucklingTablet/Shell/shell.js): installs succeed, the lockdown steps
// are done, the microphone and camera are on.
const FAKE_IPAD = `(() => {
  const st = { token: localStorage.getItem('i.token') || '', pin: localStorage.getItem('i.pin') || '', installed: JSON.parse(localStorage.getItem('i.inst') || '{}') };
  const save = () => { localStorage.setItem('i.token', st.token); localStorage.setItem('i.pin', st.pin); localStorage.setItem('i.inst', JSON.stringify(st.installed)); };
  window.DucklingShell = {
    platform: () => 'ios', shellVersion: () => '1.1.0',
    getDeviceToken: () => st.token, setDeviceToken: (t) => { st.token = t; save(); }, pushToken: () => '',
    installedApps: () => JSON.stringify(st.installed),
    installApp: (id, v) => setTimeout(() => { st.installed[id] = v; save(); window.DucklingWeb.onInstall(id, true, ''); }, 30),
    uninstallApp: (id) => { delete st.installed[id]; save(); }, openApp: () => {},
    hasPin: () => !!st.pin, setPin: (p) => { st.pin = p; save(); }, verifyPin: (p) => p === st.pin, setPinHash: () => {},
    lockdownStatus: () => JSON.stringify({ homeRole: true, deviceSecure: true, pinned: true, lockdownOn: true, screenTime: true, otherApps: 0 }),
    requestHomeRole: () => {}, openSecuritySettings: () => {}, openWifiSettings: () => {}, networkStatus: () => 'wifi',
    mediaAccess: () => JSON.stringify({ microphone: 'on', camera: 'on' }),
    setLockdown: () => {}, setAllowedHosts: () => {}, setSignInHosts: () => {}, setChildInfo: () => {}, setChildLevels: () => {}, setChildId: () => {}, setLanguage: () => {},
    release: () => {}, installedPackages: () => '[]', chooseOtherApps: () => {}, launchPackage: () => {},
    canDrawOverlays: () => false, openOverlaySettings: () => {}, setAppAccountToken: () => {}, subscriptionPrice: () => '$4.99',
  };
})();`;

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, web: string, webServer: Server;
const mails: string[] = [];

function serveDist(port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  return createServer((req, res) => {
    let p = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
}

// One app from its folder, with the compat script and a bridge giving the child's name, voice, language and grades.
function serveApp(id: string): Promise<{ url: string; close: () => void }> {
  const root = join(ROOT, 'apps', id), compat = readFileSync(join(TOOLS, 'duckling-compat.js'), 'utf8');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' };
  const levels = JSON.stringify({ reading: 2, math: 2, science: 3, logic: 2, art: 2, music: 2 });
  const srv = createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (u === '/' || u === '/index.html') {
      const bridge = `window.DucklingApp={appId:()=>${JSON.stringify(id)},deviceToken:()=>'t',apiUrl:()=>location.origin+'/api',childName:()=>${JSON.stringify(CHILD)},childId:()=>'c1',voice:()=>${JSON.stringify(ES ? 'es-MX-DaliaNeural' : 'en-US-AnaNeural')},language:()=>${JSON.stringify(LANG)},levels:()=>${JSON.stringify(levels)}};`;
      const html = readFileSync(join(root, 'index.html'), 'utf8').replace(/<script src="voice-config\.js"><\/script>/, '').replace(/<!-- KID-VOICE START -->[\s\S]*?<!-- KID-VOICE END -->/, '')
        .replace(/<head>/i, `<head><script>${bridge}</script><script>${compat.replace(/<\/script/g, '<\\/script')}</script>`);
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
    }
    const f = join(root, u);
    if (!f.startsWith(root) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }); createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/`, close: () => srv.close() })));
}

// What each app shows: the screen the English screenshots show, reached the same way.
type Page = import('playwright').Page;
const challenges = (p: Page) => p.getByRole('button', { name: ES ? /Retos/ : /Challenges/ }).first().click();
const ACT: Record<string, (p: Page) => Promise<void>> = {
  'music-box': challenges,
  'draw-with-me': async (p) => {
    await challenges(p); await p.waitForTimeout(2500);
    const ask = (await p.locator('body').innerText()).toLowerCase();
    const shape = async (pts: number[][]) => { await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down(); for (const q of pts.slice(1)) await p.mouse.move(q[0], q[1], { steps: pts.length > 10 ? 3 : 25 }); await p.mouse.up(); };
    const square = (x: number, y: number, r: number) => shape([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r], [x - r, y - r + 2]]);
    const color = async (warm: boolean) => { await p.mouse.click(warm ? 612 : 812, 994); await p.waitForTimeout(200); };
    if (/izquierda|left/.test(ask) && /derecha|right/.test(ask)) { await color(true); await square(640, 530, 120); await color(false); await square(1010, 530, 120); return; }
    await color(!/frío|cold/.test(ask));
    const cx = 825, cy = 540, r = 170;
    if (/triáng|triang/.test(ask)) await shape([[cx, cy - r], [cx + r, cy + r * 0.8], [cx - r, cy + r * 0.8], [cx, cy - r]]);
    else if (/círculo|circle/.test(ask)) await shape(Array.from({ length: 41 }, (_, i) => [cx + r * Math.cos((i / 40) * 2 * Math.PI), cy + r * Math.sin((i / 40) * 2 * Math.PI)]));
    else await square(cx, cy, r);
  },
};

beforeAll(async () => {
  if (!ready) return;
  mkdirSync(OUT, { recursive: true });
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-shots-'));
  ({ db } = await cluster.newDb());
  const apiPort = await freePort(), webPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`; web = `http://127.0.0.1:${webPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: 5000, STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: api, APP_URL: web });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(_to, _s, text) { mails.push(text); } }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  webServer = serveDist(webPort);
  // Every app, so the Library shows the whole catalog.
  const { stdout: keygen } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'keygen']);
  const key = keygen.match(/^PACKAGE_SIGNING_KEY=(\S+)/m)![1];
  await execFile('node', [join(TOOLS, 'publish.mjs'), 'all'], { env: { ...process.env, API_URL: api, ADMIN_TOKEN: ADMIN, PACKAGE_SIGNING_KEY: key, DOTENV_CONFIG_PATH: join(dir, 'none') }, maxBuffer: 1 << 26 });
}, 600_000);
afterAll(async () => {
  webServer?.close(); await app?.close(); await db?.close(); await cluster?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)(`iPad App Store screenshots (${LANG})`, () => {
  it('takes the home screen, five apps, the Library and the parent area', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ args: ARGS });

    // The apps, and her portrait from My Avatar for the home screen.
    let portrait = '';
    for (const [n, id] of [[2, 'word-wizard'], [3, 'music-box'], [4, 'draw-with-me'], [7, 'planet-explorer'], [8, 'my-avatar']] as const) {
      const s = await serveApp(id);
      const ctx = await browser.newContext({ ...VIEW, permissions: ['microphone', 'camera'] });
      await ctx.addInitScript(VOICE_STUB); await ctx.addInitScript(SEED);
      const p = await ctx.newPage();
      await p.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"design":null,"owned":[],"spent":0,"savedAt":0,"earned":0,"earnedByApp":{},"content":[{"type":"text","text":"{}"}]}' }));
      await p.goto(s.url); await p.waitForTimeout(4000);
      if (ACT[id]) { await ACT[id](p); await p.waitForTimeout(2500); }
      await p.screenshot({ path: join(OUT, `${n}-${id}.png`) });
      if (id === 'my-avatar') portrait = await p.evaluate(() => (window as unknown as { portrait: () => string }).portrait());
      await ctx.close(); s.close();
    }

    // The family: Spanish when asked, one child, a pairing code.
    const call = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
      (await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
    await call('POST', '/auth/email-link', { email: 'shots@example.com' });
    const { sessionToken } = await call('POST', '/auth/verify', { token: mails.at(-1)!.match(/token=([\w-]+)/)![1] });
    const auth = { authorization: `Bearer ${sessionToken}` };
    if (ES) await call('PUT', '/family/language', { language: 'es' }, auth);
    const child = await call('POST', '/children', { firstName: CHILD, age: 7 }, auth);
    const { code } = await call('POST', '/devices/pairing-codes', { childId: child.id }, auth);

    const ctx = await browser.newContext(VIEW);
    await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
      const req = route.request();
      const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
      await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
    });
    await ctx.addInitScript(FAKE_IPAD);
    const p = await ctx.newPage();
    await p.goto(web);
    try {
    await p.getByRole('button', { name: /I have a code from the website|código del sitio web/ }).click();
    await p.getByPlaceholder('000000').fill(code);
    await p.getByRole('button', { name: /^(Pair|Vincular)$/ }).click();
    await p.waitForTimeout(1500);
    for (const d of '24682468') await p.getByRole('button', { name: d, exact: true }).click();
    // A new tablet opens the parent area after the PIN.
    await p.getByRole('button', { name: /^(Listo|Done)$/ }).waitFor();

    // Her apps, her stars and her portrait, then the home screen.
    const deviceToken = await p.evaluate(() => (window as unknown as { DucklingShell: { getDeviceToken: () => string } }).DucklingShell.getDeviceToken());
    const dev = { authorization: `Device ${deviceToken}` };
    const { devices } = await call('GET', '/devices', undefined, auth);
    // The starter set is installed at pairing; the home screen shows exactly HOME_APPS.
    for (const id of readdirSync(join(ROOT, 'apps'))) if (!HOME_APPS.includes(id)) await fetch(`${api}/devices/${devices[0].id}/apps/${id}`, { method: 'DELETE', headers: auth });
    for (const id of HOME_APPS) await call('PUT', `/devices/${devices[0].id}/apps/${id}`, {}, auth);
    for (const [id, earned] of Object.entries(STARS)) await call('POST', '/device/child/stars', { appId: id, earned }, dev);
    if (portrait) await fetch(`${api}/device/child/portrait`, { method: 'PUT', headers: { 'content-type': 'text/plain', ...dev }, body: portrait });
    await p.getByRole('button', { name: /Sincronizar con el sitio web|Sync with the website/ }).click();
    await p.waitForTimeout(4000);
    await p.screenshot({ path: join(OUT, '6-parent.png') });
    await p.getByRole('button', { name: /^(Listo|Done)$/ }).click();
    await p.getByRole('heading', { name: ES ? `Tableta de ${CHILD}` : `${CHILD}'s tablet` }).waitFor();
    await p.waitForTimeout(2500);
    await p.screenshot({ path: join(OUT, '1-home.png') });

    await p.getByRole('button', { name: ES ? 'Biblioteca' : 'Library' }).click();
    await p.waitForTimeout(2500);
    await p.screenshot({ path: join(OUT, '5-library.png') });
    } catch (e) { await p.screenshot({ path: join(OUT, 'fail.png') }); throw e; }
    await browser.close();
  }, 600_000);
});
