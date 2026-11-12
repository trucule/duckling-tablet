// Records a short GIF of each app in action for the parent portal's About page: apps/<id>/demo.gif.
//
//   node tools/demos.mjs            # every app
//   node tools/demos.mjs robot-path # one app
//
// Each app is served from its folder, opened in headless Chromium at tablet size with a drawn cursor, driven for a
// few seconds (a start button if there is one, then taps on what is on screen, a drag on a canvas), recorded as
// video, and turned into a 6-second GIF with ffmpeg. Driving starts once the app has finished loading (no network
// requests and a screen that has stopped changing), and the GIF starts half a second before the first tap, so it
// shows the app in use rather than its loading screen. The narrator is stubbed so lines "finish" at once. A per-app
// script in SCRIPTS replaces the generic drive where the generic one does not show the app well.
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS = path.join(HERE, '..', 'apps');
// Playwright comes from the backend's dependencies (this is a development tool, not run on the droplet).
const { chromium } = createRequire(path.join(HERE, '..', 'backend', 'package.json'))('playwright');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(APPS).filter((d) => fs.existsSync(path.join(APPS, d, 'manifest.json')));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2' };
const W = 1024, H = 640, SECONDS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A visible cursor: Playwright's video does not draw one. Moves with the mouse, pulses on a click.
const CURSOR = `(() => {
  const c = document.createElement('div'); c.id = '__cur';
  c.style.cssText = 'position:fixed;z-index:2147483647;width:26px;height:26px;margin:-4px 0 0 -4px;pointer-events:none;border-radius:50%;background:rgba(255,120,0,.55);border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);transition:transform .12s;left:-100px;top:-100px';
  document.documentElement.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { c.style.transform = 'scale(.7)'; }, true);
  addEventListener('mouseup', () => { c.style.transform = ''; }, true);
})();`;
// Narration ends at once, so apps that wait for a line to finish keep moving.
const VOICE_STUB = `(() => { const ss = window.speechSynthesis; if (!ss) return;
  ss.speak = (u) => { setTimeout(() => { try { u.dispatchEvent(new Event('start')); } catch (e) {} setTimeout(() => { try { u.dispatchEvent(new Event('end')); } catch (e) {} }, 250); }, 10); };
  ss.cancel = () => {}; ss.getVoices = () => []; })();`;

// When the first tap or drag of the current recording happened; the GIF starts just before it.
let firstAt = 0;
const touched = () => { if (!firstAt) firstAt = Date.now(); };
async function tapAt(page, x, y) { await page.mouse.move(x, y, { steps: 8 }); await sleep(120); touched(); await page.mouse.down(); await sleep(80); await page.mouse.up(); }
async function tap(page, loc) {
  const b = await loc.boundingBox().catch(() => null);
  if (!b || b.width < 8 || b.height < 8) return false;
  await tapAt(page, b.x + b.width / 2, b.y + b.height / 2); return true;
}
async function drag(page, box, points) {
  const [x0, y0] = points[0];
  await page.mouse.move(box.x + x0 * box.width, box.y + y0 * box.height, { steps: 6 }); touched(); await page.mouse.down();
  for (const [x, y] of points.slice(1)) { await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 10 }); await sleep(30); }
  await page.mouse.up();
}

const CLICKABLE = 'button, [role=button], a, .btn, .tile, .card, .cell, .key, .pad, .option, .choice, .item, .level, .piece, .orb, .slot, .note, .letter, .chip, label, select, input[type=range]';
const START = /start|play|go\b|begin|let.s|lesson|level|next|new game|try|open|enter|explore|first|easy/i;

// Visible, reasonably sized things to tap, nearest the middle first, skipping anything that looks like navigation
// away from the app (home, back, quit, parent, settings, fullscreen).
async function candidates(page) {
  const els = await page.locator(CLICKABLE).elementHandles();
  const out = [];
  for (const el of els) {
    const b = await el.boundingBox().catch(() => null);
    if (!b || b.width < 28 || b.height < 24 || b.x < 0 || b.y < 0 || b.x + b.width > W || b.y + b.height > H) continue;
    const text = ((await el.textContent().catch(() => '')) || '').trim().slice(0, 40);
    if (/home|back|quit|exit|parent|settings|fullscreen|close|menu|←|⌂/i.test(text)) continue;
    out.push({ el, b, text, d: Math.hypot(b.x + b.width / 2 - W / 2, b.y + b.height / 2 - H / 2) });
  }
  return out.sort((a, b) => a.d - b.d);
}

async function generic(page) {
  await sleep(1500);
  // A start-like control first.
  const start = page.locator(CLICKABLE).filter({ hasText: START }).first();
  if (await start.count()) { await tap(page, start); await sleep(1100); }
  // Then whatever is on screen: a canvas gets a drawing, other things a tap, up to the time limit.
  const until = Date.now() + (SECONDS - 2.2) * 1000;
  const seen = new Set();
  while (Date.now() < until) {
    const canvas = page.locator('canvas').first();
    const cb = (await canvas.count()) ? await canvas.boundingBox().catch(() => null) : null;
    if (cb && cb.width > 200 && !seen.has('canvas')) {
      seen.add('canvas');
      await drag(page, cb, [[0.3, 0.4], [0.4, 0.3], [0.55, 0.45], [0.65, 0.35], [0.7, 0.55], [0.5, 0.65], [0.35, 0.55]]);
      await sleep(400); continue;
    }
    const cands = (await candidates(page)).filter((c) => !seen.has(c.text + '@' + Math.round(c.b.x) + ',' + Math.round(c.b.y)));
    if (!cands.length) { await page.mouse.move(W / 2 + 60, H / 2 + 40, { steps: 10 }); await sleep(500); continue; }
    const c = cands[Math.min(cands.length - 1, Math.floor(Math.random() * Math.min(3, cands.length)))];
    seen.add(c.text + '@' + Math.round(c.b.x) + ',' + Math.round(c.b.y));
    await tapAt(page, c.b.x + c.b.width / 2, c.b.y + c.b.height / 2);
    await sleep(650);
  }
}

// Waits for the app to finish loading: no network requests for half a second, then a screen that stays the same
// for 600 ms (up to 8 seconds; apps that animate all the time go on after that).
async function loaded(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const until = Date.now() + 8000;
  let last = null, same = 0;
  while (Date.now() < until) {
    const shot = (await page.screenshot({ type: 'jpeg', quality: 30 })).toString('base64');
    same = shot === last ? same + 1 : 0; last = shot;
    if (same >= 2) return;
    await sleep(300);
  }
}

// Per-app drives. Positions are fractions of the canvas or absolute viewport points at 1024 x 640; each script
// shows the central action of the app in about six seconds.
const T = (page, sel) => page.locator(sel).first();
const tapText = async (page, re, wait = 700) => { const l = page.locator(CLICKABLE).filter({ hasText: re }).first(); if (await l.count()) { await tap(page, l); await sleep(wait); return true; } return false; };
const tapSel = async (page, sel, wait = 700) => { const l = T(page, sel); if (await l.count()) { await tap(page, l); await sleep(wait); return true; } return false; };
const canvasBox = async (page, sel = 'canvas') => (await T(page, sel).boundingBox().catch(() => null)) || { x: 0, y: 0, width: W, height: H };
const tapFrac = async (page, box, fx, fy, wait = 600) => { await tapAt(page, box.x + fx * box.width, box.y + fy * box.height); await sleep(wait); };


const SCRIPTS = {
  'paint-studio': async (page) => {
    await sleep(600);
    const cb = await T(page, '#view').boundingBox();
    await tapSel(page, '#palette i:nth-child(14)', 300);
    await tapSel(page, '#mirror', 150); await tapSel(page, '#mirror', 150); await tapSel(page, '#mirror', 150); await tapSel(page, '#mirror', 300);
    await drag(page, cb, [[0.5, 0.2], [0.58, 0.32], [0.55, 0.42], [0.62, 0.5]]); await sleep(300);
    await tapSel(page, '#palette i:nth-child(10)', 250);
    await page.locator('#tools .tool', { hasText: 'Watercolor' }).click(); await sleep(250);
    await drag(page, cb, [[0.4, 0.3], [0.45, 0.4], [0.4, 0.5]]); await sleep(300);
    await tapSel(page, '#palette i:nth-child(8)', 250);
    await page.locator('#tools .tool', { hasText: 'Crayon' }).click(); await sleep(250);
    await drag(page, cb, [[0.52, 0.6], [0.6, 0.66], [0.55, 0.75]]); await sleep(900);
  },
  'chemistry-lab': async (page) => { await sleep(1200); await tapSel(page, '#bookbtn', 1500); const b = await canvasBox(page, '#c'); await tapFrac(page, b, 0.5, 0.5, 900); await tapSel(page, 'button.slot', 700); await tapFrac(page, b, 0.25, 0.55, 800); },
  'kitchen-lab': async (page) => { await sleep(1200); await tapSel(page, '#bookbtn', 1500); const b = await canvasBox(page, '#c'); await tapFrac(page, b, 0.5, 0.5, 900); await tapSel(page, 'button.slot', 700); await tapFrac(page, b, 0.25, 0.55, 800); },
  'circuit-lab': async (page) => { await sleep(1800); const b = await canvasBox(page, '#gl'); await drag(page, b, [[0.3, 0.7], [0.45, 0.45]]); await sleep(400); await drag(page, b, [[0.55, 0.45], [0.7, 0.7]]); await sleep(400); await drag(page, b, [[0.3, 0.7], [0.7, 0.7]]); await sleep(600); await tapFrac(page, b, 0.5, 0.35, 900); await tapSel(page, '#done', 900); },
  'count-with-me': async (page) => { await sleep(1500); await tapSel(page, '#hint', 900); await tapText(page, /^1$/, 400); await tapText(page, /^2$/, 400); await tapSel(page, 'button.ok', 1200); await tapText(page, /Build it/, 900); const cells = page.locator('div.cell'); const n = await cells.count(); for (let i = 0; i < Math.min(4, n); i++) { await tap(page, cells.nth(i)); await sleep(250); } },
  // The cat lesson: a circle for the head, then the ears, step by step.
  'draw-with-me': async (page) => {
    await sleep(800); await tapText(page, /^Cat$/, 1300);
    const cb = await T(page, 'canvas:visible').last().boundingBox().catch(() => null) || { x: 322, y: 166, width: 340, height: 340 };
    const circle = []; for (let a = 0; a <= 2 * Math.PI + 0.4; a += 0.4) circle.push([0.5 + 0.3 * Math.cos(a), 0.56 + 0.3 * Math.sin(a)]);
    await drag(page, cb, circle); await sleep(500);
    await tapSel(page, '#next', 1100);
    await drag(page, cb, [[0.3, 0.36], [0.33, 0.12], [0.44, 0.28]]); await sleep(250);
    await drag(page, cb, [[0.56, 0.28], [0.67, 0.12], [0.7, 0.36]]); await sleep(500);
    await tapSel(page, '#next', 1000);
  },
  'ecosystem-aquarium': async (page) => { await sleep(1800); await tapText(page, /^\+$/, 350); await tapText(page, /^\+$/, 350); await tapSel(page, '#run', 2500); const b = await canvasBox(page, '#gl'); await tapFrac(page, b, 0.5, 0.5, 600); },
  'fraction-pizza': async (page) => { await sleep(1500); const b = await canvasBox(page, '#c'); await tapFrac(page, b, 0.32, 0.5, 500); await tapFrac(page, b, 0.32, 0.5, 500); await drag(page, b, [[0.32, 0.5], [0.62, 0.5]]); await sleep(600); await tapSel(page, '#serveBtn', 1200); await tapFrac(page, b, 0.5, 0.5, 500); },
  'level-up': async (page) => { await sleep(1500); await tapText(page, /Math/, 1400); for (let i = 0; i < 4; i++) { const c = (await candidates(page)).filter((x) => x.b.y > 150 && x.b.height > 40); if (!c.length) break; await tapAt(page, c[0].b.x + c[0].b.width / 2, c[0].b.y + c[0].b.height / 2); await sleep(900); } },
  'light-bridge': async (page) => { await sleep(1500); const b = await canvasBox(page); await drag(page, b, [[0.3, 0.3], [0.3, 0.7]]); await sleep(300); await drag(page, b, [[0.45, 0.3], [0.6, 0.3], [0.6, 0.7]]); await sleep(300); await drag(page, b, [[0.4, 0.5], [0.55, 0.5]]); await sleep(500); await tapSel(page, '#hint', 1200); },
  'music-box': async (page) => { await sleep(1500); const cells = page.locator('div.cell'); const n = await cells.count(); const picks = [0, 5, 10, 17, 22, 27, 34, 41, 48, 51]; for (const i of picks) { if (i < n) { await tap(page, cells.nth(i)); await sleep(120); } } await tapSel(page, '#play', 2500); await tapText(page, /Flute/, 800); },
  'my-avatar': async (page) => { await sleep(4200); await tapText(page, /Hair/, 900); for (let i = 0; i < 2; i++) { const c = (await candidates(page)).filter((x) => x.b.x > 660); if (c[i]) { await tapAt(page, c[i].b.x + c[i].b.width / 2, c[i].b.y + c[i].b.height / 2); await sleep(700); } } await tapText(page, /Clothes/, 900); const c2 = (await candidates(page)).filter((x) => x.b.x > 660); if (c2[1]) { await tapAt(page, c2[1].b.x + c2[1].b.width / 2, c2[1].b.y + c2[1].b.height / 2); await sleep(700); } await tapText(page, /\u27f3/, 400); await tapText(page, /\u27f3/, 400); },
  'number-line-rocket': async (page) => { await sleep(1500); const b = await canvasBox(page, '#c'); await tapFrac(page, b, 0.80, 0.72, 700); await tapSel(page, '#launchBtn', 3200); },
  'pattern-machine': async (page) => { await sleep(1500); const b = await canvasBox(page); await tapFrac(page, b, 0.5, 0.3, 900); await tapFrac(page, b, 0.3, 0.94, 1000); await tapFrac(page, b, 0.5, 0.94, 1000); await tapFrac(page, b, 0.7, 0.94, 900); },
  'planet-explorer': async (page) => { await sleep(1800); await tapText(page, /Look closer/, 1500); const b = await canvasBox(page, '#gl'); await tapFrac(page, b, 0.5, 0.5, 700); await tapSel(page, 'button.ans', 1500); },
  'playground-lab': async (page) => { await sleep(1500); await tapText(page, /🎳/u, 600); const b = await canvasBox(page, '#c'); await tapFrac(page, b, 0.55, 0.6, 400); await tapSel(page, '#fire', 2200); await tapSel(page, '#slow', 400); await tapSel(page, '#fire', 1500); },
  'read-it-say-it': async (page) => { await sleep(1800); await tapSel(page, '#listen', 1500); await tapSel(page, '#mic', 1200); const b = await canvasBox(page); await tapFrac(page, b, 0.3, 0.4, 500); await tapFrac(page, b, 0.5, 0.4, 500); await tapFrac(page, b, 0.7, 0.4, 700); },
  'story-maker': async (page) => { await sleep(1500); await tapText(page, /Spark/, 500); await tapText(page, /Luna/, 500); await tapText(page, /moon/, 700); for (let i = 0; i < 3; i++) { const c = (await candidates(page)).filter((x) => x.b.y > 60); if (!c.length) break; const pick = c.find((x) => /start|go|tell|make|begin|read/i.test(x.text)) || c[0]; await tapAt(page, pick.b.x + pick.b.width / 2, pick.b.y + pick.b.height / 2); await sleep(900); } },
  'camera-fun': async (page) => { await sleep(2200); await tapText(page, /Comic/, 900); await tapText(page, /Stamps/, 700); const c = (await candidates(page)).filter((x) => x.b.y > 540 && x.b.x < 700); if (c[1]) { await tapAt(page, c[1].b.x + c[1].b.width / 2, c[1].b.y + c[1].b.height / 2); await sleep(500); } await tapAt(page, 420, 300); await sleep(500); await tapSel(page, '#snap', 1500); },
  'robot-path': async (page) => { await sleep(1300); for (const re of [/\u27a1/, /\u27a1/, /\u2b06/, /\u27a1/]) { await tapText(page, re, 220); } await tapSel(page, '#go', 3800); },
  'simon-orchestra': async (page) => { await sleep(2600); const pads = page.locator('button.pad'); for (const i of [0, 1, 2, 1]) { await tap(page, pads.nth(i)); await sleep(500); } await sleep(800); },
  'tangram-city': async (page) => { await sleep(1500); const b = await canvasBox(page, '#c'); await drag(page, b, [[0.15, 0.75], [0.45, 0.45]]); await sleep(300); await tapSel(page, '#flipBtn', 400); await drag(page, b, [[0.85, 0.75], [0.55, 0.5]]); await sleep(300); await drag(page, b, [[0.15, 0.4], [0.5, 0.6]]); await sleep(500); await tapSel(page, '#hintBtn', 800); },
  'trace-with-me': async (page) => { await sleep(1500); await tapText(page, /Little/, 900); const cb = await canvasBox(page, '#w'); await drag(page, cb, [[0.5, 0.2], [0.38, 0.8]]); await sleep(250); await drag(page, cb, [[0.5, 0.2], [0.62, 0.8]]); await sleep(250); await drag(page, cb, [[0.43, 0.58], [0.57, 0.58]]); await sleep(900); await tapSel(page, '#next', 800); },
  'voice-band': async (page) => { await sleep(1500); await tapText(page, /Voice Effects/, 1500); for (let i = 0; i < 4; i++) { const c = (await candidates(page)).filter((x) => x.b.y > 100); if (!c[i]) break; await tapAt(page, c[i].b.x + c[i].b.width / 2, c[i].b.y + c[i].b.height / 2); await sleep(700); } },
  // Spells the word the prompt asks for ("Make a robot!"), letter by letter, so the thing appears.
  'word-wizard': async (page) => {
    await sleep(800);
    const word = ((await page.locator('body').innerText()).match(/Make an? ([a-z]+)!/i)?.[1] ?? '').toLowerCase();
    // The tiles stay in place as letters are used, so their positions are read once.
    const tiles = await page.locator('button.tile').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { ch: e.innerText.trim().toLowerCase(), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    for (const ch of word) {
      const i = tiles.findIndex((t) => t.ch === ch);
      if (i < 0) break;
      const t = tiles.splice(i, 1)[0];
      await tapAt(page, t.x, t.y); await sleep(250);
    }
    await sleep(2500);
  },
};

// A synthetic camera and microphone, so Camera Fun shows a picture instead of a permission screen.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
for (const id of ids) {
  const root = path.join(APPS, id);
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(root, p === '/' ? 'index.html' : p);
    if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const vdir = fs.mkdtempSync(path.join(root, '.demo-'));
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: vdir, size: { width: W, height: H } }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  const videoAt = Date.now();
  firstAt = 0;
  await page.addInitScript(VOICE_STUB);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(CURSOR);
    await loaded(page);
    await (SCRIPTS[id] ?? generic)(page);
    // Keep recording until SECONDS after the first tap.
    const left = (firstAt || Date.now()) + SECONDS * 1000 + 300 - Date.now();
    if (left > 0) await sleep(left);
  } catch (e) { errors.push(e.message); }
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  const gif = path.join(root, 'demo.gif');
  // Two passes: a palette from the clip, then the GIF at 10 frames a second and 560 pixels wide, trimmed to the
  // seconds that show the app in use: from half a second before the first tap.
  const from = Math.max(0, ((firstAt || videoAt + 1000) - videoAt) / 1000 - 0.5).toFixed(2);
  const palette = path.join(vdir, 'palette.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', from, '-t', String(SECONDS), '-i', webm, '-vf', 'fps=10,scale=560:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff', palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', from, '-t', String(SECONDS), '-i', webm, '-i', palette, '-lavfi', 'fps=10,scale=560:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', gif]);
  fs.rmSync(vdir, { recursive: true, force: true });
  srv.close();
  console.log(`${id}: ${(fs.statSync(gif).size / 1024).toFixed(0)} KB${errors.length ? `  (page errors: ${errors.slice(0, 2).join(' | ').slice(0, 160)})` : ''}`);
}
await browser.close();
