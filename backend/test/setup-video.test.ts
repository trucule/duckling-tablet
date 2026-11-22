// A setup video for parents: create the family, pair a tablet, invite a second parent, pair another tablet. It drives
// the built portal and tablet app against a real API, takes a frame at each step with the next control outlined,
// composes the frames at 1920 x 1080 with a caption, and encodes an MP4 with ffmpeg. Runs only when asked:
//
//   cd backend && SETUP_VIDEO=/some/folder npx vitest run test/setup-video.test.ts
//
// Writes setup.mp4 and the composed frames (frames/) to that folder. Needs web/dist, portal/dist and ffmpeg.
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
    release: () => {}, installedPackages: () => '[]', chooseOtherApps: () => {}, launchPackage: () => {},
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

type Box = { x: number; y: number; width: number; height: number };
type Pane =
  | { kind: 'portal' | 'tablet'; img: string; vw: number; vh: number; ring?: Box; label?: string }
  | { kind: 'mail'; to: string; subject: string; lines: string[]; ring?: number };
type Shot = { part: string; caption: string; panes: Pane[]; seconds: number };

describe.skipIf(!ready)('setup video', () => {
  it('records the setup from a new family to a second tablet', async () => {
    const { chromium } = await import('playwright');
    type Page = import('playwright').Page;
    type Locator = import('playwright').Locator;
    const browser = await chromium.launch();
    const shots: Shot[] = [];
    let n = 0;

    async function context(viewport: { width: number; height: number }, shell?: string) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, locale: 'en-US' });
      await ctx.route('https://api.ducklingtablet.com/**', async (route) => {
        const req = route.request();
        const r = await fetch(req.url().replace('https://api.ducklingtablet.com', api), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined });
        await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
      });
      if (shell) await ctx.addInitScript(fakeShell(shell));
      return ctx.newPage();
    }
    // The page as it is now, with the control about to be pressed outlined. The control is scrolled to the middle.
    async function snap(p: Page, kind: 'portal' | 'tablet', target?: Locator, label?: string): Promise<Pane> {
      if (target) await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await p.waitForTimeout(400);
      const img = join(dir, `raw-${++n}.jpg`);
      await p.screenshot({ path: img, type: 'jpeg', quality: 92 });
      const vp = p.viewportSize()!;
      return { kind, img, vw: vp.width, vh: vp.height, ring: target ? (await target.boundingBox()) ?? undefined : undefined, label };
    }
    function mail(m: { to: string; subject: string; text: string }): Pane {
      const lines = m.text.replace(/http:\/\/127\.0\.0\.1:\d+/g, PORTAL_HOST).replace(/(token=)[\w-]+/g, '$1...').split('\n').filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())).slice(0, 9);
      return { kind: 'mail', to: m.to, subject: m.subject, lines, ring: lines.findIndex((l) => l.includes(PORTAL_HOST)) };
    }
    const add = (part: string, caption: string, panes: Pane[], seconds = 4) => shots.push({ part, caption, panes, seconds });

    // Part 1: the family.
    const P1 = 'Create your family';
    const mom = await context({ width: 960, height: 720 });
    await mom.goto(portal);
    await mom.getByLabel('Email').fill('sam@example.com');
    add(P1, 'On a phone or computer, go to parents.ducklingtablet.com and type your email.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Send me a link' }))]);
    await mom.getByRole('button', { name: 'Send me a link' }).click();
    await mom.getByText('Check your email').waitFor();
    add(P1, 'Open the sign-in link in the email. The first sign-in creates your family.', [await snap(mom, 'portal'), mail(mails.at(-1)!)], 4.5);
    await mom.goto(mails.at(-1)!.text.match(/(http\S+signin\?token=[\w-]+)/)![1]);
    await mom.getByRole('heading', { name: 'Children' }).waitFor();
    await mom.getByRole('button', { name: 'Not now' }).click().catch(() => {});
    await mom.getByPlaceholder('First name').fill('Ada');
    await mom.getByPlaceholder('Age').fill('7');
    add(P1, 'Add your child with a first name and age.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Add child' }))]);
    await mom.getByRole('button', { name: 'Add child' }).click();
    await mom.locator('#children .list li', { hasText: 'Ada' }).waitFor();
    add(P1, 'Each subject starts at a level for that age. Levels changes it per subject.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Levels' }))]);

    // Part 2: the first tablet.
    const P2 = 'Pair the tablet';
    const ipad = await context({ width: 1180, height: 820 }, 'ios');
    await ipad.goto(web);
    const haveCode = ipad.getByRole('button', { name: 'I have a code from the website' });
    add(P2, 'Install Duckling Tablet on the tablet and open it. Choose I have a code from the website.', [await snap(ipad, 'tablet', haveCode, 'iPad')]);
    await haveCode.click();
    await mom.locator('#devices select').first().selectOption({ label: 'Ada' });
    const makeCode = mom.getByRole('button', { name: 'Make a pairing code' });
    add(P2, 'On the website, under Devices, choose the child and press Make a pairing code.', [await snap(mom, 'portal', makeCode), await snap(ipad, 'tablet', undefined, 'iPad')]);
    await makeCode.click();
    const code = (await mom.locator('.code').textContent())!.trim();
    await ipad.getByPlaceholder('000000').fill(code);
    await ipad.getByLabel('Name for this tablet').fill('Ada\'s iPad');
    const pair = ipad.getByRole('button', { name: 'Pair', exact: true });
    add(P2, 'Type the code on the tablet, give the tablet a name, and press Pair. The code works once, for 15 minutes.', [await snap(mom, 'portal', mom.locator('.code')), await snap(ipad, 'tablet', pair, 'iPad')], 5);
    await pair.click();
    await ipad.getByRole('button', { name: '1', exact: true }).waitFor();
    for (const d of '2468') await ipad.getByRole('button', { name: d, exact: true }).click();
    await ipad.waitForTimeout(300);
    add(P2, 'Choose a four-digit parent PIN and type it twice. It opens the parent area on every tablet in the family.', [await snap(ipad, 'tablet', ipad.locator('.pin, .dots, .keypad').first(), 'iPad')], 4.5);
    for (const d of '2468') await ipad.getByRole('button', { name: d, exact: true }).click();
    const done = ipad.getByRole('button', { name: 'Done', exact: true });
    await done.waitFor();
    add(P2, 'The parent area on the tablet lists the steps that lock it down for your child. When they are done, press Done.', [await snap(ipad, 'tablet', done, 'iPad')], 5);
    await done.click();
    await ipad.getByRole('heading', { name: 'Ada\'s tablet' }).waitFor();
    await ipad.waitForTimeout(2500);
    add(P2, 'The tablet is ready, with the starter apps installed. More apps are in the Library.', [await snap(ipad, 'tablet', undefined, 'iPad')], 4.5);
    await mom.getByRole('button', { name: 'Refresh' }).click();
    await mom.getByText('Ada\'s iPad').waitFor();
    add(P2, 'The tablet now shows under Devices on the website, where you manage its apps and websites.', [await snap(mom, 'portal', mom.locator('#devices li', { hasText: 'Ada\'s iPad' }))]);

    // Part 3: a second parent.
    const P3 = 'Add a parent';
    const invite = mom.getByPlaceholder('Another parent\'s email');
    await invite.fill('alex@example.com');
    add(P3, 'Under Parents, type the other parent\'s email and press Invite.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Invite', exact: true }))]);
    await mom.getByRole('button', { name: 'Invite', exact: true }).click();
    await mom.getByText('Invitation sent', { exact: false }).waitFor();
    const inviteMail = mails.at(-1)!;
    add(P3, 'They get an email with a link. The link works for 7 days.', [await snap(mom, 'portal', mom.getByText('Invitation sent', { exact: false })), mail(inviteMail)], 4.5);
    const dad = await context({ width: 960, height: 720 });
    await dad.goto(inviteMail.text.match(/(http\S+token=[\w-]+)/)![1]);
    await dad.getByRole('heading', { name: 'Children' }).waitFor();
    await dad.getByRole('button', { name: 'Not now' }).click().catch(() => {});
    await dad.waitForTimeout(500);
    add(P3, 'The link signs them in to your family. Every parent can change the same settings.', [await snap(dad, 'portal', dad.locator('#parents'))], 4.5);

    // Part 4: another tablet, for a second child.
    const P4 = 'Add another tablet';
    await mom.reload();
    await mom.getByRole('heading', { name: 'Children' }).waitFor();
    await mom.getByPlaceholder('First name').fill('Leo');
    await mom.getByPlaceholder('Age').fill('5');
    add(P4, 'A second child gets a profile of their own.', [await snap(mom, 'portal', mom.getByRole('button', { name: 'Add child' }))], 3.5);
    await mom.getByRole('button', { name: 'Add child' }).click();
    await mom.locator('#children .list li', { hasText: 'Leo' }).waitFor();
    await mom.locator('#devices select').first().selectOption({ label: 'Leo' });
    await mom.getByRole('button', { name: 'Make a pairing code' }).click();
    const code2 = (await mom.locator('.code').textContent())!.trim();
    const tab = await context({ width: 1280, height: 800 }, 'android');
    await tab.goto(web);
    await tab.getByRole('button', { name: 'I have a code from the website' }).click();
    await tab.getByPlaceholder('000000').fill(code2);
    await tab.getByLabel('Name for this tablet').fill('Leo\'s tablet');
    const pair2 = tab.getByRole('button', { name: 'Pair', exact: true });
    add(P4, 'Each tablet pairs with its own code. Choose the child, make a code, and type it on the new tablet.', [await snap(mom, 'portal', mom.locator('.code')), await snap(tab, 'tablet', pair2, 'Android tablet')], 5);
    await pair2.click();
    // The family's PIN is already set, so the new tablet only asks for it before its parent area.
    const home2 = tab.getByRole('heading', { name: 'Leo\'s tablet' });
    for (let k = 0; k < 6 && !(await home2.count()); k++) {
      await tab.waitForTimeout(1200);
      if (await tab.getByRole('button', { name: '1', exact: true }).count()) for (const d of '2468') await tab.getByRole('button', { name: d, exact: true }).click();
      else if (await tab.getByRole('button', { name: 'Done', exact: true }).count()) await tab.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await tab.getByRole('heading', { name: 'Leo\'s tablet' }).waitFor();
    await tab.waitForTimeout(2500);
    add(P4, 'The new tablet shows Leo\'s apps at Leo\'s levels.', [await snap(tab, 'tablet', undefined, 'Android tablet')], 4);
    await mom.getByRole('button', { name: 'Refresh' }).click();
    await mom.getByText('Leo\'s tablet').waitFor();
    add(P4, 'Both tablets are listed under Devices. Any parent in the family can manage them.', [await snap(mom, 'portal', mom.locator('#devices'))], 5);
    await browser.close();

    // Compose and encode.
    const compose = await (await chromium.launch()).newPage({ viewport: { width: W, height: H } });
    const frames: string[] = [];
    const save = async (html: string, name: string) => {
      const page = join(dir, `${name}.html`);
      writeFileSync(page, html);
      await compose.goto(`file://${page}`, { waitUntil: 'load' });
      const f = join(OUT, 'frames', name);
      await compose.screenshot({ path: f, type: 'jpeg', quality: 92 });
      return f;
    };
    frames.push(await save(titleCard('Setting up Duckling Tablet', 'Create a family, pair a tablet, add a parent, and add another tablet.'), '00-title.jpg'));
    const scenes: { a: string; b?: string; seconds: number }[] = [{ a: frames[0], seconds: 3.5 }];
    let i = 0;
    for (const s of shots) {
      i++;
      const a = await save(frame(s, false), `${String(i).padStart(2, '0')}a.jpg`);
      const ringed = s.panes.some((p) => p.ring !== undefined && p.ring !== -1);
      const b = ringed ? await save(frame(s, true), `${String(i).padStart(2, '0')}b.jpg`) : undefined;
      scenes.push({ a, b, seconds: s.seconds });
    }
    scenes.push({ a: await save(titleCard('Duckling Tablet', 'parents.ducklingtablet.com'), '99-end.jpg'), seconds: 3 });
    await compose.close();

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
    await execFile('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', tmp]);
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
