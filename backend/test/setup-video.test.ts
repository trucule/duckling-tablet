// A setup video for parents: why the tablet exists, then create the family, pair a tablet, invite a second parent, pair another tablet, keep the
// website on a phone, ask for an app, allow a website, and give another app its screen time. It drives the built
// portal and tablet app against a real API, takes a frame at each step with the next control outlined, composes the
// frames at 1920 x 1080 with a caption, and encodes an MP4 with ffmpeg. Runs only when asked:
//
//   cd backend && SETUP_VIDEO=/some/folder [SETUP_VOICE=/folder/of/beats] npx vitest run test/setup-video.test.ts
//
// Writes setup.mp4, the composed frames (frames/) and the narration script (beats_duckling_setup.txt, one line per
// scene in the voice clone's beats format) to that folder. With SETUP_VOICE, a folder of beat1.wav to beatN.wav read
// from that script, each scene lasts at least as long as its line and the narration is mixed in.
// Needs web/dist, portal/dist and ffmpeg.
import { describe, it, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import { freePort, startCluster, type Cluster } from './pg.js';

const execFile = promisify(execFileCb);
const ROOT = join(import.meta.dirname, '..', '..');
const TOOLS = join(ROOT, 'tools');
const ADMIN = 'admin-token-for-tests-0123456789';
const OUT = process.env.SETUP_VIDEO ?? '';
const VOICE = process.env.SETUP_VOICE ?? '';
const ready = !!OUT && existsSync(join(ROOT, 'web', 'dist', 'index.html')) && existsSync(join(ROOT, 'portal', 'dist', 'index.html')) && existsSync(join(TOOLS, 'node_modules', 'fflate'));
const PORTAL_HOST = 'https://parents.ducklingtablet.com';
const W = 1920, H = 1080, FPS = 30;

// A tablet shell as the web app sees it: installs succeed and the lockdown steps are done.
const fakeShell = (platform: string) => `(() => {
  const st = { token: localStorage.getItem('i.token') || '', pin: localStorage.getItem('i.pin') || '', installed: JSON.parse(localStorage.getItem('i.inst') || '{}') };
  const save = () => { localStorage.setItem('i.token', st.token); localStorage.setItem('i.pin', st.pin); localStorage.setItem('i.inst', JSON.stringify(st.installed)); };
  window.DucklingShell = {
    platform: () => ${JSON.stringify(platform)}, shellVersion: () => '1.1.0',
    getDeviceToken: () => st.token, setDeviceToken: (t) => { st.token = t; save(); }, pushToken: () => '',
    installedApps: () => JSON.stringify(st.installed),
    installApp: (id, v) => setTimeout(() => { st.installed[id] = v; save(); window.DucklingWeb.onInstall(id, true, ''); }, 30),
    uninstallApp: (id) => { delete st.installed[id]; save(); }, openApp: () => {},
    hasPin: () => !!st.pin, setPin: (p) => { st.pin = p; save(); }, verifyPin: (p) => p === st.pin,
    // The family's PIN arrives as a hash; the video's PIN is 2468.
    setPinHash: (h) => { if (h && !st.pin) { st.pin = '2468'; save(); } },
    lockdownStatus: () => JSON.stringify({ homeRole: true, deviceSecure: true, pinned: true, lockdownOn: true, screenTime: true, otherApps: 0 }),
    requestHomeRole: () => {}, openSecuritySettings: () => {}, openWifiSettings: () => {}, networkStatus: () => 'wifi',
    mediaAccess: () => JSON.stringify({ microphone: 'on', camera: 'on' }),
    setLockdown: () => {}, setAllowedHosts: () => {}, setSignInHosts: () => {}, setChildInfo: () => {}, setChildLevels: () => {}, setChildId: () => {}, setLanguage: () => {},
    release: () => {}, installedPackages: () => ${JSON.stringify(platform === 'android' ? JSON.stringify([{ package: 'com.google.android.apps.youtube.kids', label: 'YouTube Kids' }, { package: 'com.example.puzzles', label: 'Puzzle Pals' }]) : '[]')}, chooseOtherApps: () => {}, launchPackage: () => {},
    canDrawOverlays: () => false, openOverlaySettings: () => {}, setAppAccountToken: () => {}, subscriptionPrice: () => '$4.99',
  };
})();`;

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, api: string, portal: string, web: string;
const servers: Server[] = [];
const mails: { to: string; subject: string; text: string }[] = [];

function serve(root: string, port: number): Server {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  return createServer((req, res) => {
    let p = join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
}

beforeAll(async () => {
  if (!ready) return;
  mkdirSync(join(OUT, 'frames'), { recursive: true });
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-video-'));
  ({ db } = await cluster.newDb());
  const [apiPort, portalPort, webPort] = [await freePort(), await freePort(), await freePort()];
  api = `http://127.0.0.1:${apiPort}`; portal = `http://127.0.0.1:${portalPort}`; web = `http://127.0.0.1:${webPort}`;
  const cfg = loadConfig({ NODE_ENV: 'test', RATE_LIMIT_PER_MINUTE: 5000, STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: api, PORTAL_URL: portal, APP_URL: web });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(to, subject, text) { mails.push({ to, subject, text }); } }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  servers.push(serve(join(ROOT, 'portal', 'dist'), portalPort), serve(join(ROOT, 'web', 'dist'), webPort));
  const { stdout: keygen } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'keygen']);
  const key = keygen.match(/^PACKAGE_SIGNING_KEY=(\S+)/m)![1];
  await execFile('node', [join(TOOLS, 'publish.mjs'), 'all', '--starter'], { env: { ...process.env, API_URL: api, ADMIN_TOKEN: ADMIN, PACKAGE_SIGNING_KEY: key, DOTENV_CONFIG_PATH: join(dir, 'none') }, maxBuffer: 1 << 26 });
}, 600_000);
afterAll(async () => {
  for (const s of servers) s.close();
  await app?.close(); await db?.close(); await cluster?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// One app from its folder, with the compat script and a bridge giving the child's name, voice and grades (as in
// store-shots.test.ts).
const VOICE_STUB = `(() => { const ss = window.speechSynthesis; if (!ss) return; ss.speak = (u) => { setTimeout(() => { try { u.dispatchEvent(new Event('start')); } catch (e) {} setTimeout(() => { try { u.dispatchEvent(new Event('end')); } catch (e) {} }, 250); }, 10); }; ss.cancel = () => {}; ss.getVoices = () => []; })();`;
const SEED = `(() => { let a = 20261121; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();`;
function serveApp(id: string, CHILD: string): Promise<{ url: string; close: () => void }> {
  const root = join(ROOT, 'apps', id), compat = readFileSync(join(TOOLS, 'duckling-compat.js'), 'utf8');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' };
  const levels = JSON.stringify({ reading: 2, math: 2, science: 2, logic: 2, art: 2, music: 2 });
  const srv = createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (u === '/' || u === '/index.html') {
      const bridge = `window.DucklingApp={appId:()=>${JSON.stringify(id)},deviceToken:()=>'t',apiUrl:()=>location.origin+'/api',childName:()=>${JSON.stringify(CHILD)},childId:()=>'c1',voice:()=>'en-US-AnaNeural',language:()=>'en',levels:()=>${JSON.stringify(levels)}};`;
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

type Box = { x: number; y: number; width: number; height: number };
type Pane =
  | { kind: 'portal' | 'tablet' | 'phone'; img: string; vw: number; vh: number; ring?: Box; label?: string }
  | { kind: 'mail'; to: string; subject: string; lines: string[]; ring?: number };
type Shot = { part: string; caption: string; say: string; panes: Pane[]; seconds: number; card?: { title: string; sub: string } };

describe.skipIf(!ready)('setup video', () => {
  it('records the setup from a new family to a second tablet', async () => {
    const { chromium } = await import('playwright');
    type Page = import('playwright').Page;
    type Locator = import('playwright').Locator;
    const browser = await chromium.launch();
    const shots: Shot[] = [];
    let n = 0;

    async function context(viewport: { width: number; height: number }, shell?: string, extra: Record<string, unknown> = {}) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, locale: 'en-US', timezoneId: 'America/Los_Angeles', ...extra });
      await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
        const req = route.request();
        const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
        await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
      });
      if (shell) await ctx.addInitScript(fakeShell(shell));
      return ctx.newPage();
    }
    // The page as it is now, with the control about to be pressed outlined. The control is scrolled to the middle.
    async function snap(p: Page, kind: 'portal' | 'tablet' | 'phone', target?: Locator, label?: string): Promise<Pane> {
      if (target) await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await p.waitForTimeout(400);
      const img = join(dir, `raw-${++n}.jpg`);
      await p.screenshot({ path: img, type: 'jpeg', quality: 92 });
      const vp = p.viewportSize()!;
      return { kind, img, vw: vp.width, vh: vp.height, ring: target ? (await target.boundingBox()) ?? undefined : undefined, label };
    }
    function mail(m: { to: string; subject: string; text: string }): Pane {
      const lines = m.text.replace(/http:\/\/127\.0\.0\.1:\d+/g, PORTAL_HOST).replace(/(token=)[\w-]+/g, '$1...').split('\n').filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())).slice(0, 9);
      return { kind: 'mail', to: m.to, subject: m.subject, lines, ring: lines.findIndex((l) => l.includes(PORTAL_HOST) || /\b\d{3} \d{3}\b/.test(l)) };
    }
    // caption is what the frame says, say what the narrator says (no hyphens, the web address spelled out: the voice
    // clone's script rules).
    const add = (part: string, caption: string, say: string, panes: Pane[], seconds = 4) => shots.push({ part, caption, say, panes, seconds });

    // Part 1: the family.
    const P1 = 'Create your family';
    const mom = await context({ width: 960, height: 720 });
    await mom.goto(portal);
    await mom.getByLabel('Email').fill('sam@example.com');
    add(P1, 'On a phone or computer, go to parents.ducklingtablet.com and type your email.', 'Go to parents dot duckling tablet dot com, and type your email.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Send me a link' }))]);
    await mom.getByRole('button', { name: 'Send me a link' }).click();
    await mom.getByText('Check your email').waitFor();
    add(P1, 'Open the sign-in link in the email. The first sign-in creates your family.', 'Open the link in the email. Your first sign in creates the family.', [await snap(mom, 'portal'), mail(mails.at(-1)!)], 4.5);
    await mom.goto(mails.at(-1)!.text.match(/(http\S+signin\?token=[\w-]+)/)![1]);
    await mom.getByRole('heading', { name: 'Children' }).waitFor();
    await mom.getByRole('button', { name: 'Not now' }).click().catch(() => {});
    await mom.getByPlaceholder('First name').fill('Scarlett');
    await mom.getByPlaceholder('Age').fill('7');
    add(P1, 'Add your child with a first name and age.', 'Add your child with a first name and an age.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Add child' }))]);
    await mom.getByRole('button', { name: 'Add child' }).click();
    await mom.locator('#children .list li', { hasText: 'Scarlett' }).waitFor();
    add(P1, 'Each subject starts at a level for that age. Levels changes it per subject.', 'Each subject starts at a level that fits their age.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Levels' }))]);

    // Part 2: the first tablet.
    const P2 = 'Pair the tablet';
    const ipad = await context({ width: 1180, height: 820 }, 'ios');
    await ipad.goto(web);
    const haveCode = ipad.getByRole('button', { name: 'I have a code from the website' });
    add(P2, 'On the tablet, install Duckling Tablet: Kids Learning from the App Store or Google Play and open it. Choose I have a code from the website.', 'On the tablet, find Duckling Tablet Kids Learning in the Apple App Store or the Google Play Store, install it, and open it.', [await snap(ipad, 'tablet', haveCode, 'iPad')]);
    await haveCode.click();
    await mom.locator('#devices select').first().selectOption({ label: 'Scarlett' });
    const makeCode = mom.getByRole('button', { name: 'Make a pairing code' });
    add(P2, 'On the website, under Devices, choose the child and press Make a pairing code.', 'On the website, choose your child and make a pairing code.', [await snap(mom, 'portal', makeCode), await snap(ipad, 'tablet', undefined, 'iPad')]);
    await makeCode.click();
    const code = (await mom.locator('.code').textContent())!.trim();
    await ipad.getByPlaceholder('000000').fill(code);
    await ipad.getByLabel('Name for this tablet').fill('Scarlett\'s iPad');
    const pair = ipad.getByRole('button', { name: 'Pair', exact: true });
    add(P2, 'Type the code on the tablet, give the tablet a name, and press Pair. The code works once, for 15 minutes.', 'Type the code on the tablet, give it a name, and press Pair.', [await snap(mom, 'portal', mom.locator('.code')), await snap(ipad, 'tablet', pair, 'iPad')], 5);
    await pair.click();
    await ipad.getByRole('button', { name: '1', exact: true }).waitFor();
    for (const d of '2468') await ipad.getByRole('button', { name: d, exact: true }).click();
    await ipad.waitForTimeout(300);
    add(P2, 'Choose a four-digit parent PIN and type it twice. It opens the parent area on every tablet in the family.', 'Choose a four digit parent PIN, and type it twice.', [await snap(ipad, 'tablet', ipad.locator('.pin, .dots, .keypad').first(), 'iPad')], 4.5);
    for (const d of '2468') await ipad.getByRole('button', { name: d, exact: true }).click();
    const done = ipad.getByRole('button', { name: 'Done', exact: true });
    await done.waitFor();
    add(P2, 'The parent area on the tablet lists the steps that lock it down for your child. When every step is finished, press Done.', 'The parent area lists the steps that lock the tablet down. When every step is finished, press Done.', [await snap(ipad, 'tablet', done, 'iPad')], 5);
    await done.click();
    await ipad.getByRole('heading', { name: 'Scarlett\'s tablet' }).waitFor();
    await ipad.waitForTimeout(2500);
    const herHome = await snap(ipad, 'tablet', undefined, 'iPad');
    add(P2, 'The tablet is ready, with the starter apps installed. More apps are in the Library.', 'The tablet is ready, with the starter apps installed.', [await snap(ipad, 'tablet', undefined, 'iPad')], 4.5);
    await mom.getByRole('button', { name: 'Refresh' }).click();
    await mom.locator('#devices li', { hasText: 'Scarlett\'s iPad' }).waitFor();
    add(P2, 'The tablet now shows under Devices on the website, where you manage its apps and websites.', 'On the website, the tablet now shows under Devices.', [await snap(mom, 'portal', mom.locator('#devices li', { hasText: 'Scarlett\'s iPad' }))]);

    // Part 3: a second parent.
    const P3 = 'Add a parent';
    const invite = mom.getByPlaceholder('Another parent\'s email');
    await invite.fill('alex@example.com');
    add(P3, 'Under Parents, type the other parent\'s email and press Invite.', 'Under Parents, invite the other parent by email.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Invite', exact: true }))]);
    await mom.getByRole('button', { name: 'Invite', exact: true }).click();
    await mom.getByText('Invitation sent', { exact: false }).waitFor();
    const inviteMail = mails.at(-1)!;
    add(P3, 'They get an email with a link. The link works for 7 days.', 'They get an email with a link that works for seven days.', [await snap(mom, 'portal', mom.getByText('Invitation sent', { exact: false })), mail(inviteMail)], 4.5);
    const dad = await context({ width: 960, height: 720 });
    await dad.goto(inviteMail.text.match(/(http\S+token=[\w-]+)/)![1]);
    await dad.getByRole('heading', { name: 'Children' }).waitFor();
    await dad.getByRole('button', { name: 'Not now' }).click().catch(() => {});
    await dad.waitForTimeout(500);
    add(P3, 'The link signs them in to your family. Every parent can change the same settings.', 'The link signs them in to the same family.', [await snap(dad, 'portal', dad.locator('#parents'))], 4.5);

    // Part 4: another tablet for the same child.
    const P4 = 'Add another tablet';
    await mom.reload();
    await mom.getByRole('heading', { name: 'Children' }).waitFor();
    await mom.locator('#devices select').first().selectOption({ label: 'Scarlett' });
    await mom.getByRole('button', { name: 'Make a pairing code' }).click();
    const code2 = (await mom.locator('.code').textContent())!.trim();
    const tab = await context({ width: 1280, height: 800 }, 'android');
    await tab.goto(web);
    await tab.getByRole('button', { name: 'I have a code from the website' }).click();
    await tab.getByPlaceholder('000000').fill(code2);
    await tab.getByLabel('Name for this tablet').fill('Scarlett\'s Android');
    const pair2 = tab.getByRole('button', { name: 'Pair', exact: true });
    add(P4, 'Each tablet pairs with its own code. Choose the child, make a code, and type it on the new tablet.', 'Each new tablet gets its own pairing code.', [await snap(mom, 'portal', mom.locator('.code')), await snap(tab, 'tablet', pair2, 'Android tablet')], 5);
    await pair2.click();
    // The family's PIN is already set, so the new tablet only asks for it before its parent area.
    const home2 = tab.getByRole('heading', { name: 'Scarlett\'s tablet' });
    for (let k = 0; k < 6 && !(await home2.count()); k++) {
      await tab.waitForTimeout(1200);
      if (await tab.getByRole('button', { name: '1', exact: true }).count()) for (const d of '2468') await tab.getByRole('button', { name: d, exact: true }).click();
      else if (await tab.getByRole('button', { name: 'Done', exact: true }).count()) await tab.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await tab.getByRole('heading', { name: 'Scarlett\'s tablet' }).waitFor();
    await tab.waitForTimeout(2500);
    add(P4, 'The new tablet has the same child\'s apps, levels and stars.', 'The new tablet has the same apps, levels, and stars for Scarlett.', [await snap(tab, 'tablet', undefined, 'Android tablet')], 4);
    await mom.getByRole('button', { name: 'Refresh' }).click();
    await mom.locator('#devices li', { hasText: 'Scarlett\'s Android' }).waitFor();
    add(P4, 'Both tablets are listed under Devices. Any parent in the family can manage them.', 'Both tablets are listed under Devices, and any parent can manage them.', [await snap(mom, 'portal', mom.locator('#devices'))], 5);

    // Part 5: the website on a phone, as a home screen app.
    const P5 = 'Keep the website on your phone';
    const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', isMobile: true, hasTouch: true };
    const safari = await context({ width: 390, height: 844 }, undefined, IPHONE);
    await safari.goto(portal);
    await safari.getByLabel('Email').fill('sam@example.com');
    await safari.getByRole('button', { name: 'Send me a link' }).click();
    await safari.getByText('Check your email').waitFor();
    await safari.goto(mails.at(-1)!.text.match(/(http\S+signin\?token=[\w-]+)/)![1]);
    const keep = safari.locator('.card', { has: safari.getByRole('heading', { name: 'Keep this page on your phone' }) });
    await keep.waitFor();
    add(P5, 'On a phone, the website shows how to put it on the home screen, where it opens like an app.', 'On your phone, the website can sit on your home screen, and it opens like an app.', [await snap(safari, 'phone', keep, 'iPhone')], 4.5);
    const home = await context({ width: 390, height: 844 }, undefined, IPHONE);
    await home.context().addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await home.goto(portal);
    await home.getByLabel('Email').fill('sam@example.com');
    await home.getByRole('button', { name: 'Send me a code' }).click();
    await home.getByLabel('Code').waitFor();
    const codeMail = mails.at(-1)!;
    await home.getByLabel('Code').fill(codeMail.text.match(/\b\d{3} \d{3}\b/)![0]);
    add(P5, 'On an iPhone, the home screen app keeps its own sign-in, so the email has a six-digit code to type. On Android, the link in the email signs it in.', 'On an iPhone, the home screen app keeps its own sign in, so the email has a six digit code to type in. On Android, the link in the email works.', [await snap(home, 'phone', home.getByRole('button', { name: 'Sign in' }), 'iPhone'), mail(codeMail)], 5);
    await home.getByRole('button', { name: 'Sign in' }).click();
    await home.getByRole('heading', { name: 'Children' }).waitFor();
    add(P5, 'After that, it opens to your family, signed in.', 'After that, it opens straight to your family.', [await snap(home, 'phone', undefined, 'iPhone')], 3.5);

    // Part 6: asking for an app.
    const P6 = 'Ask for a new app';
    await mom.reload();
    await mom.getByRole('heading', { name: 'Children' }).waitFor();
    await mom.getByPlaceholder('Search apps', { exact: false }).first().fill('volcano eruptions');
    const ask = mom.getByRole('button', { name: 'Ask for this app' });
    add(P6, 'Under Apps, search for what your child wants. When nothing fits, press Ask for this app.', 'Search the apps for what your child wants. When nothing fits, press Ask for this app.', [await snap(mom, 'portal', ask)], 4.5);
    await ask.click();
    await mom.getByPlaceholder('What should it do', { exact: false }).fill('Make a volcano erupt and show why it happens. Scarlett likes lava and the layers inside the earth.');
    const send = mom.getByRole('button', { name: 'Send the request' });
    add(P6, 'Describe the app and what your child likes about the idea, then press Send the request.', 'Describe the app and what your child likes about it, then send the request.', [await snap(mom, 'portal', send)], 4.5);
    await send.click();
    const asked = mom.locator('li', { hasText: 'Volcano eruptions' }).last();
    await asked.waitFor();
    add(P6, 'The request is listed with its status. Requests are included with the subscription.', 'The request is listed with its status, and requests are included with the subscription.', [await snap(mom, 'portal', asked)], 4.5);

    // Part 7: a website as a tile.
    const P7 = 'Allow a website';
    await mom.getByPlaceholder('pbskids.org').fill('pbskids.org');
    await mom.getByPlaceholder('Name on the tile').fill('PBS Kids');
    const allowSite = mom.getByRole('button', { name: 'Allow site' });
    add(P7, 'Under Websites, type the site\'s address and a name for its tile, then press Allow site.', 'Under Websites, type the address of a site, give its tile a name, and press Allow site.', [await snap(mom, 'portal', allowSite)], 4.5);
    await allowSite.click();
    await mom.locator('#websites li', { hasText: 'pbskids.org' }).waitFor();
    await ipad.goto(web);
    await ipad.getByRole('heading', { name: 'Scarlett\'s tablet' }).waitFor();
    const pbs = ipad.getByRole('button', { name: 'PBS Kids' });
    await pbs.waitFor();
    await ipad.waitForTimeout(1500);
    add(P7, 'Every tablet in the family gets the tile. Sites that are not allowed stay blocked.', 'Every tablet in the family gets the tile, and sites that are not allowed stay blocked.', [await snap(ipad, 'tablet', pbs, 'iPad')], 4.5);

    // Part 8: screen time for the tablet's other apps. The Android tablet reported its apps when it synced.
    const P8 = 'Screen time in other apps';
    await tab.goto(web);
    await tab.getByRole('heading', { name: 'Scarlett\'s tablet' }).waitFor();
    await tab.waitForTimeout(1500);
    await mom.reload();
    await mom.getByRole('heading', { name: 'Other apps' }).waitFor();
    const which = mom.getByRole('tablist', { name: 'Which tablet' });
    await which.getByRole('tab', { name: 'Scarlett\'s Android' }).click();
    const row = mom.locator('#other-apps li', { hasText: 'YouTube Kids' });
    await row.waitFor();
    add(P8, 'Under Other apps, the website lists the apps on an Android tablet. Press Allow to put one on its home screen.', 'Under Other apps, the website lists the apps on an Android tablet. Press Allow to put one on its home screen.', [await snap(mom, 'portal', row.getByRole('button', { name: 'Allow' }))], 5);
    await row.getByRole('button', { name: 'Allow' }).click();
    await row.getByText('0 of 30 min used today').waitFor();
    await row.locator('select').selectOption('60');
    await row.getByText('0 of 60 min used today').waitFor();
    await row.locator('input[type=time]').first().fill('15:00');
    await row.locator('input[type=time]').last().fill('18:00');
    await row.getByRole('button', { name: 'Set hours' }).click();
    await mom.waitForTimeout(800);
    add(P8, 'Set the minutes a day and the hours it can open. When the time ends, the tablet comes back to Duckling.', 'You decide how many minutes a day it gets and the hours it can open, and when the time ends, the tablet comes back to Duckling.', [await snap(mom, 'portal', row)], 4.5);
    // The tablet at ten past four in the afternoon, inside those hours.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    await tab.clock.setFixedTime(new Date(`${today}T16:10:00-08:00`));
    await tab.goto(web);
    await tab.getByRole('heading', { name: 'Scarlett\'s tablet' }).waitFor();
    const yt = tab.getByRole('button', { name: 'YouTube Kids' });
    await yt.waitFor();
    await tab.waitForTimeout(1500);
    add(P8, 'The tablet shows the app with the time it has left today.', 'The tablet shows the app with the time it has left today.', [await snap(tab, 'tablet', yt, 'Android tablet')], 4);
    await which.getByRole('tab', { name: 'Scarlett\'s iPad' }).click();
    const ipadNote = mom.getByText('On an iPad the apps are chosen on the iPad itself', { exact: false });
    await ipadNote.waitFor();
    add(P8, 'On an iPad, the apps are chosen on the iPad itself, in the parent area under Other apps.', 'On an iPad, the apps are chosen on the iPad itself, in the parent area under Other apps.', [await snap(mom, 'portal', ipadNote)], 5);

    // The opening: why the tablet exists, then what a child sees on it.
    const W0 = 'Why Duckling Tablet';
    const appShot = async (id: string, act?: (p: Page) => Promise<void>) => {
      const srv = await serveApp(id, 'Scarlett');
      const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1.5, locale: 'en-US' });
      await ctx.addInitScript(VOICE_STUB); await ctx.addInitScript(SEED);
      const p = await ctx.newPage();
      await p.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ design: null, owned: [], spent: 0, savedAt: 0, earned: 48, earnedByApp: { 'word-wizard': 20, 'count-with-me': 16, 'planet-explorer': 12 }, content: [{ type: 'text', text: '{}' }] }) }));
      await p.goto(srv.url); await p.waitForTimeout(4000);
      if (act) { await act(p); await p.waitForTimeout(1500); }
      const pane = await snap(p, 'tablet', undefined, 'iPad');
      await ctx.close(); srv.close();
      return pane;
    };
    const intro: Shot[] = [
      { part: '', caption: '', say: 'I made Duckling Tablet for my daughter, Scarlett.', panes: [], seconds: 3.5, card: { title: 'Duckling Tablet', sub: 'A learning tablet for kids, locked down by a parent.' } },
      { part: '', caption: '', say: 'On a tablet that is not locked down, there are ads everywhere, and one video leads to the next until a child ends up somewhere inappropriate.', panes: [], seconds: 5, card: { title: 'Tablets that are not locked down', sub: 'Ads in the apps, and one video after another.' } },
      { part: W0, caption: 'The tablet opens only the apps and websites a parent allows.', say: 'On a Duckling tablet, kids can open only the learning apps and the websites their parents allow.', panes: [herHome], seconds: 4.5 },
      { part: W0, caption: 'Every app starts at the child\'s level and moves up a little at a time.', say: 'Every app is designed to move a child forward a little at a time, starting at their own level.', panes: [await appShot('word-wizard')], seconds: 4.5 },
      { part: W0, caption: 'Stars from learning and playing decorate their avatar.', say: 'As they learn and play, they earn stars to decorate their own avatar.', panes: [await appShot('my-avatar', (p) => p.getByRole('button', { name: /Hats/ }).first().click())], seconds: 4.5 },
      { part: '', caption: '', say: 'When I saw her progress in reading and math, I decided to share it with other families. Here is how to set it up.', panes: [], seconds: 5, card: { title: 'Made for Scarlett', sub: 'Shared with other families after her reading and math improved.' } },
    ];
    shots.unshift(...intro);
    await browser.close();

    // Compose and encode.
    const compose = await (await chromium.launch()).newPage({ viewport: { width: W, height: H } });
    const save = async (html: string, name: string) => {
      const page = join(dir, `${name}.html`);
      writeFileSync(page, html);
      await compose.goto(`file://${page}`, { waitUntil: 'load' });
      const f = join(OUT, 'frames', name);
      await compose.screenshot({ path: f, type: 'jpeg', quality: 92 });
      return f;
    };
    const scenes: { a: string; b?: string; seconds: number; say: string }[] = [];
    let i = 0;
    for (const s of shots) {
      i++;
      const a = await save(s.card ? titleCard(s.card.title, s.card.sub) : frame(s, false), `${String(i).padStart(2, '0')}a.jpg`);
      const ringed = s.panes.some((p) => p.ring !== undefined && p.ring !== -1);
      const b = ringed ? await save(frame(s, true), `${String(i).padStart(2, '0')}b.jpg`) : undefined;
      scenes.push({ a, b, seconds: s.seconds, say: s.say });
    }
    scenes.push({ a: await save(titleCard('Duckling Tablet', 'parents.ducklingtablet.com'), '99-end.jpg'), seconds: 3, say: 'Set up your family at parents dot duckling tablet dot com.' });
    await compose.close();

    // The narration script, one line per scene, for the voice clone (narrate_chatterbox.py --script).
    writeFileSync(join(OUT, 'beats_duckling_setup.txt'), [
      `# Duckling Tablet setup video. ${scenes.length} beats, one line each, in the order of the video's scenes.`,
      '# Written by backend/test/setup-video.test.ts; change the lines there. The line count MUST match the scenes.',
      '# All [warm], single reference: narrate with --ref ref_warm_clean.wav (NOT --voices). Pick takes with pick_takes.py.',
      ...scenes.map((x) => `[warm] ${x.say}`), ''].join('\n'));
    // With the recorded lines, each scene lasts until its line has finished, plus a pause.
    const LEAD = 0.35;
    const beats: number[] = [];
    if (VOICE) {
      for (const [k, x] of scenes.entries()) {
        const wav = join(VOICE, `beat${k + 1}.wav`);
        if (!existsSync(wav)) throw new Error(`${wav} is missing: the script has ${scenes.length} lines`);
        const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]);
        beats.push(Number(stdout.trim()));
        x.seconds = Math.max(x.seconds, LEAD + beats[k] + 0.6);
      }
      // Lines the voice rushed: conversational speech runs near 5 syllables a second. Above 6.5 a line sounds sped
      // up; fast-lines.txt names them for narrate_chatterbox.py --only.
      const syllables = (t: string) => (t.toLowerCase().match(/[a-z']+/g) ?? []).reduce((n, w) => n + Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length - (/[^l]e$/.test(w) ? 1 : 0)), 0);
      const fast = scenes.map((x, k) => ({ k: k + 1, rate: syllables(x.say) / Math.max(0.5, beats[k] - 0.14), say: x.say })).filter((x) => x.rate > 6.5);
      writeFileSync(join(OUT, 'fast-lines.txt'), fast.map((x) => `beat${x.k}\t${x.rate.toFixed(1)} syllables/s\t${x.say}`).join('\n') + '\n');
      if (fast.length) console.warn(`Fast lines (--only ${fast.map((x) => x.k).join(',')}):\n${fast.map((x) => `  beat${x.k} ${x.rate.toFixed(1)}/s ${x.say}`).join('\n')}`);
    }

    // One file per scene: a fade in from the scene before, then the outline fades in after a moment.
    const parts: string[] = [];
    let prev = '';
    for (const [k, s] of scenes.entries()) {
      const out = join(dir, `scene-${k}.mp4`), tmp = join(dir, `scene-${k}.tmp.mp4`);
      const inputs = [prev, s.a, s.b].filter(Boolean) as string[];
      const still = (j: number, sec: number, tag: string) => `[${j}:v]format=yuv420p,loop=-1:1,fps=${FPS},trim=duration=${sec},setpts=PTS-STARTPTS,settb=1/${FPS}[${tag}]`;
      const f: string[] = [], hold = s.seconds;
      let cur: string;
      let j = 0;
      if (prev) { f.push(still(j++, 0.5, 'p')); f.push(still(j++, hold, 'a')); f.push('[p][a]xfade=transition=fade:duration=0.5:offset=0[x]'); cur = 'x'; }
      else { f.push(still(j++, hold, 'a')); cur = 'a'; }
      if (s.b) { f.push(still(j++, hold, 'b')); f.push(`[${cur}][b]xfade=transition=fade:duration=0.3:offset=0.9,trim=duration=${hold}[y]`); cur = 'y'; }
      await execFile('ffmpeg', ['-y', '-v', 'error', ...inputs.flatMap((x) => ['-framerate', String(FPS), '-i', x]), '-filter_complex', f.join(';'), '-map', `[${cur}]`, '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FPS), tmp], { maxBuffer: 1 << 24 });
      renameSync(tmp, out);
      parts.push(out);
      prev = s.b ?? s.a;
    }
    writeFileSync(join(dir, 'list.txt'), parts.map((x) => `file '${x}'`).join('\n'));
    const tmp = join(OUT, 'setup.tmp.mp4');
    const silent = join(dir, 'silent.mp4');
    await execFile('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', VOICE ? silent : tmp]);
    if (VOICE) {
      // Each line starts just after its scene fades in; the mix is leveled for online video.
      let at = 0;
      const f = scenes.map((x, k) => { const d = Math.round((at + LEAD) * 1000); at += x.seconds; return `[${k + 1}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${d}:all=1[a${k}]`; });
      f.push(`${scenes.map((_, k) => `[a${k}]`).join('')}amix=inputs=${scenes.length}:normalize=0:duration=longest,apad=whole_dur=${at},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`);
      await execFile('ffmpeg', ['-y', '-v', 'error', '-i', silent, ...scenes.flatMap((_, k) => ['-i', join(VOICE, `beat${k + 1}.wav`)]), '-filter_complex', f.join(';'),
        '-map', '0:v', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-shortest', '-movflags', '+faststart', tmp], { maxBuffer: 1 << 24 });
    }
    renameSync(tmp, join(OUT, 'setup.mp4'));
  }, 900_000);
});

// The drawing: a caption band at the top, then one or two panes. A portal pane is a browser window, a tablet pane a
// device with a bezel, a mail pane an email.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STYLE = `<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; background: #eef0eb; font-family: 'Inter', 'Noto Sans', 'DejaVu Sans', sans-serif; color: #1f2a2a; overflow: hidden; }
  .top { height: 190px; padding: 38px 80px 0; }
  .part { font-size: 26px; font-weight: 700; color: #1f6f5c; letter-spacing: .02em; }
  .cap { font-size: 40px; font-weight: 600; margin-top: 10px; line-height: 1.25; max-width: 1760px; }
  .stage { position: absolute; top: 200px; left: 0; right: 0; bottom: 40px; display: flex; justify-content: center; align-items: center; gap: 56px; }
  .pane { position: relative; }
  .browser { background: #fff; border-radius: 14px; box-shadow: 0 18px 50px rgba(20,40,40,.18); overflow: hidden; }
  .bar { height: 44px; background: #e4e7e2; display: flex; align-items: center; padding: 0 16px; gap: 8px; }
  .dot { width: 13px; height: 13px; border-radius: 50%; background: #c9cec7; }
  .url { margin-left: 14px; flex: 1; height: 28px; border-radius: 8px; background: #fff; font-size: 16px; line-height: 28px; padding: 0 14px; color: #55615f; }
  .device { background: #1d2323; border-radius: 34px; padding: 22px; box-shadow: 0 18px 50px rgba(20,40,40,.22); }
  .device img { border-radius: 12px; display: block; }
  .shot { position: relative; }
  .shot img { display: block; }
  .ring { position: absolute; border: 6px solid #f0a23b; border-radius: 16px; box-shadow: 0 0 0 6px rgba(240,162,59,.28); }
  .label { position: absolute; left: 0; right: 0; bottom: -34px; text-align: center; font-size: 20px; color: #55615f; }
  .mail { width: 760px; background: #fff; border-radius: 14px; box-shadow: 0 18px 50px rgba(20,40,40,.18); padding: 34px 38px; font-size: 21px; line-height: 1.45; }
  .mail .h { color: #55615f; font-size: 18px; } .mail .s { font-size: 26px; font-weight: 700; margin: 8px 0 18px; }
  .mail p { min-height: 1em; overflow-wrap: anywhere; } .mail p.link { color: #1f6f5c; text-decoration: underline; }
  .mail p.hl { outline: 6px solid #f0a23b; outline-offset: 6px; border-radius: 6px; }
  .title { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 22px; }
  .title h1 { font-size: 76px; } .title p { font-size: 34px; color: #55615f; }
</style>`;

function titleCard(title: string, sub: string) {
  return `<!doctype html><html><head>${STYLE}</head><body><div class="title"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div></body></html>`;
}

function frame(s: Shot, ring: boolean) {
  const two = s.panes.length > 1;
  const maxW = two ? 860 : 1500, maxH = 790;
  const panes = s.panes.map((p) => {
    if (p.kind === 'mail') {
      return `<div class="mail"><div class="h">From: Duckling Tablet<br>To: ${esc(p.to)}</div><div class="s">${esc(p.subject)}</div>${p.lines.map((l, i) => `<p class="${l.includes(PORTAL_HOST) ? 'link' : ''} ${ring && i === p.ring ? 'hl' : ''}">${esc(l)}</p>`).join('')}</div>`;
    }
    const chrome = p.kind === 'portal' ? 44 : 44;
    const scale = Math.min(maxW / p.vw, (maxH - chrome) / p.vh);
    const w = Math.round(p.vw * scale), h = Math.round(p.vh * scale);
    const r = ring && p.ring ? `<div class="ring" style="left:${p.ring.x * scale - 12}px;top:${p.ring.y * scale - 12}px;width:${p.ring.width * scale + 24}px;height:${p.ring.height * scale + 24}px"></div>` : '';
    const img = `<div class="shot"><img src="file://${p.img}" width="${w}" height="${h}">${r}</div>`;
    return p.kind === 'portal'
      ? `<div class="pane browser"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">parents.ducklingtablet.com</span></div>${img}</div>`
      : `<div class="pane"><div class="device">${img}</div>${p.label ? `<div class="label">${esc(p.label)}</div>` : ''}</div>`;
  }).join('');
  return `<!doctype html><html><head>${STYLE}</head><body><div class="top"><div class="part">${esc(s.part)}</div><div class="cap">${esc(s.caption)}</div></div><div class="stage">${panes}</div></body></html>`;
}
