// The Home pill check: every shell draws Duckling's Home button over the top right corner of a running app (Windows
// 8 px from the right and 6 from the top, Android and the iPad about 16 and 14). Apps keep that corner clear: nothing
// tappable may sit within 210 px of the right edge and 72 px of the top. This loads each app at three screen sizes and
// at the lowest and highest grade, probes a grid of points in the corner, and reports any button, link, input or
// pointer-cursor element found there. Exit code 1 when one is found.
//
//   node tools/pill-check.mjs --all [--shots dir]
//   node tools/pill-check.mjs paint-studio word-wizard
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'backend', 'package.json'));
const { chromium } = require('playwright');
const APPS = path.join(ROOT, 'apps');
const COMPAT = fs.readFileSync(path.join(ROOT, 'tools', 'duckling-compat.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
export const ZONE = { width: 210, height: 72 };
const SIZES = [[1024, 640], [1280, 800], [1440, 960]];
const SUBJECTS = ['reading', 'math', 'science', 'logic', 'art', 'music'];

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; args.splice(i, v === true ? 1 : 2); return v; };
const all = flag('--all'); const shots = flag('--shots');
const ids = all ? fs.readdirSync(APPS).filter((d) => fs.existsSync(path.join(APPS, d, 'manifest.json'))) : args;
if (!ids.length) { console.error('usage: node tools/pill-check.mjs <app-id>|--all [--shots dir]'); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
for (const id of ids) {
  const root = path.join(APPS, id);
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const levels = decodeURIComponent((req.url.match(/[?&]levels=([^&]*)/) || [, '{}'])[1]);
    if (u === '/' || u === '/index.html') {
      let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      html = html.replace(/<script src="voice-config\.js"><\/script>/, '').replace(/<!-- KID-VOICE START -->[\s\S]*?<!-- KID-VOICE END -->/, '');
      const bridge = `window.DucklingApp={appId:()=>${JSON.stringify(id)},deviceToken:()=>'t',apiUrl:()=>location.origin+'/api',childName:()=>'Ada',voice:()=>'en-US-AnaNeural',levels:()=>${JSON.stringify(levels)}};`;
      html = html.replace(/<head>/i, `<head><script>${bridge}</script><script>${COMPAT.replace(/<\/script/g, '<\\/script')}</script>`);
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
    }
    const f = path.join(root, u); if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const found = new Map();
  for (const [w, h] of SIZES) for (const g of [-1, 8]) {
    const levels = Object.fromEntries(SUBJECTS.map((s) => [s, g]));
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"design":null,"owned":[],"spent":0,"savedAt":0,"earned":0,"earnedByApp":{}}' }));
    try {
      await page.goto(`${base}?levels=${encodeURIComponent(JSON.stringify(levels))}`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1500);
      const hits = await page.evaluate((zone) => {
        const out = new Set(), W = innerWidth;
        // The control a tap there would reach: a button, link or form control (the whole control, not an icon inside
        // it), or else the nearest element with a click handler or a pointer cursor. A drawing canvas is not a control.
        const tappable = (el) => {
          if (!el) return null;
          const control = el.closest('button,a[href],input,select,textarea,label,summary,[role=button]');
          if (control) return control;
          for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
            if (e.tagName.toLowerCase() === 'canvas') return null;
            if (e.onclick || getComputedStyle(e).cursor === 'pointer') return e;
          }
          return null;
        };
        for (let y = 2; y < zone.height; y += 6) for (let x = W - zone.width + 2; x < W; x += 6) {
          const el = tappable(document.elementFromPoint(x, y));
          if (!el) continue;
          const r = el.getBoundingClientRect(), label = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '')) + ' "' + (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 24) + '"';
          out.add(`${label} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return [...out];
      }, ZONE);
      for (const hit of hits) (found.get(hit.replace(/ at .*/, '')) ?? found.set(hit.replace(/ at .*/, ''), new Set()).get(hit.replace(/ at .*/, ''))).add(`${w}x${h}${g < 0 ? ' pre-K' : ' 8th'}`);
      if (shots && hits.length) await page.screenshot({ path: path.join(shots, `${id}-${w}x${h}-${g}.png`) });
    } catch (e) { found.set('load failed: ' + e.message.slice(0, 80), new Set([`${w}x${h}`])); }
    await ctx.close();
  }
  srv.close();
  if (found.size) { failed++; console.log(`✗ ${id}`); for (const [el, where] of found) console.log(`    ${el}  (${[...where].join(', ')})`); }
  else console.log(`✓ ${id}`);
}
await browser.close();
console.log(failed ? `\n${failed} app(s) have something tappable under the Home button` : '\nEvery app keeps the Home button corner clear');
process.exit(failed ? 1 : 0);
