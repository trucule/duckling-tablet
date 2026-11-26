#!/usr/bin/env node
// Opens one app the way the tablet does (the compatibility script and a fake bridge), several times in one browser
// profile, on a slowed-down processor, and prints when things happened on each opening: API requests, pictures
// decoded (with their size and how long each took), photo backdrops asked for and shown, and every stretch of more
// than 150 ms in which the page could not respond. The first opening fills the tablet's copies (IndexedDB, the
// app's storage); the later ones show what a child sees on a normal day. Compare the numbers before and after a
// change; they are for comparing, not tablet seconds.
//
//   node tools/load-time.mjs my-avatar                 three openings, processor slowed four times
//   node tools/load-time.mjs my-avatar --runs 2 --cpu 6 --wait 15000
//   node tools/load-time.mjs my-avatar --net 400       the API answers backdrop files after 400 ms (default 150)
//   node tools/load-time.mjs my-avatar --api '{"design":{"place":"park"},"owned":["park"],"savedAt":9e13}'
//                                                      what every other API request answers (My Avatar reads its design from it)
//   node tools/load-time.mjs my-avatar --shot out/a    a screenshot at the end of each opening: out/a-1.png, ...
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend', 'package.json'));
const { chromium } = require('playwright');
const args = process.argv.slice(2);
const flag = (f, d) => { const i = args.indexOf(f); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const runs = Number(flag('--runs', 3)), cpu = Number(flag('--cpu', 4)), wait = Number(flag('--wait', 10000)), net = Number(flag('--net', 150));
const apiBody = flag('--api', '{"design":null,"owned":[],"spent":0,"savedAt":0,"earned":0,"earnedByApp":{},"content":[{"type":"text","text":"{}"}]}');
const shot = flag('--shot');
const id = args[0];
if (!id || !fs.existsSync(path.join(ROOT, 'apps', id, 'index.html'))) { console.error('usage: node tools/load-time.mjs <app-id> [--runs n] [--cpu n] [--wait ms] [--net ms] [--api json] [--shot path]'); process.exit(2); }

const root = path.join(ROOT, 'apps', id);
const COMPAT = fs.readFileSync(path.join(ROOT, 'tools', 'duckling-compat.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const cors = { 'access-control-allow-origin': '*' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u.startsWith('/api/backdrops/')) {
    const f = path.join(ROOT, 'backdrops', path.basename(u));
    if (!fs.existsSync(f)) { res.writeHead(404, cors); return res.end(); }
    return setTimeout(() => { res.writeHead(200, { 'content-type': TYPES[path.extname(f)], ...cors }); fs.createReadStream(f).pipe(res); }, net);
  }
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(apiBody); }
  if (u === '/' || u === '/index.html') {
    let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    html = html.replace(/<script src="voice-config\.js"><\/script>/, '').replace(/<!-- KID-VOICE START -->[\s\S]*?<!-- KID-VOICE END -->/, '');
    const bridge = `window.DucklingApp={appId:()=>${JSON.stringify(id)},deviceToken:()=>'t',apiUrl:()=>location.origin+'/api',childName:()=>'Ada',voice:()=>'en-US-AnaNeural',language:()=>'en',levels:()=>'{}',goHome:()=>{}};`;
    html = html.replace(/<head>/i, `<head><script>${bridge}</script><script>${COMPAT.replace(/<\/script/g, '<\\/script')}</script>`);
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
  }
  const f = path.join(root, u);
  if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

// Runs in the page before anything else: notes each event with the time since the page started.
const PROBE = `(() => {
  window.__T = []; const mark = (n) => window.__T.push([Math.round(performance.now()), n]);
  const cib = window.createImageBitmap;
  window.createImageBitmap = function () { const s = performance.now(); return cib.apply(this, arguments).then((bm) => { mark('picture ' + bm.width + 'x' + bm.height + ' decoded in ' + Math.round(performance.now() - s) + ' ms'); return bm; }); };
  const f = window.fetch;
  window.fetch = function (u) { const s = performance.now(), n = String((u && u.url) || u).replace(/^.*\\/api\\//, 'api/').split('?')[0].slice(0, 60); return f.apply(this, arguments).then((r) => { mark('answered ' + n + ' in ' + Math.round(performance.now() - s) + ' ms'); return r; }); };
  let B;
  Object.defineProperty(window, 'DucklingBackdrops', { configurable: true, get: () => B, set: (v) => {
    B = v; const l = v.load, g = v.ground;
    v.load = function (i) { const s = performance.now(); mark('photo ' + i + ' asked for' + (v.kept && v.kept(i) ? ' (kept on the tablet)' : '')); return l.apply(this, arguments).then((r) => { mark('photo ' + i + (r ? ' ready' : ' not to be had') + ' after ' + Math.round(performance.now() - s) + ' ms'); return r; }); };
    v.ground = function () { mark('PHOTO SHOWN'); return g.apply(this, arguments); };
  } });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 150) mark('busy for ' + Math.round(e.duration) + ' ms from ' + Math.round(e.startTime)); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
})();`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'duckling-load-'));
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'],
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
try {
  for (let run = 1; run <= runs; run++) {
    const page = await ctx.newPage();
    if (cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpu });
    page.on('pageerror', (e) => { if (!/decode audio/i.test(e.message)) console.log('  page error: ' + e.message.slice(0, 200)); });
    await page.addInitScript(PROBE);
    const t = Date.now();
    await page.goto(base, { waitUntil: 'load', timeout: 120000 });
    console.log(`${id}, opening ${run}: page loaded after ${Date.now() - t} ms`);
    await page.waitForTimeout(wait);
    for (const [ms, n] of await page.evaluate(() => window.__T)) console.log(`  ${String(ms).padStart(6)}  ${n}`);
    if (shot) { fs.mkdirSync(path.dirname(shot), { recursive: true }); await page.screenshot({ path: `${shot}-${run}.png` }); }
    await page.close();
  }
} finally { await ctx.close(); srv.close(); fs.rmSync(profile, { recursive: true, force: true }); }
