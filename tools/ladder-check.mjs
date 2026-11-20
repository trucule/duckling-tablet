#!/usr/bin/env node
// Loads one app (or every app) the way the tablet does, with the compatibility script and a fake bridge, once per
// grade from pre-K to 8th, and reports page errors, console errors and the level the app chose. With --shots it
// saves a screenshot per grade. With --drive it also runs an optional window.DucklingLadder hook that an app can
// expose for self-checks: { levels: () => n, exercise: (i, times) => string[] of problems } runs every level's
// generator many times and reports anything thrown.
//
//   node tools/ladder-check.mjs word-wizard            one app, grades -1..8
//   node tools/ladder-check.mjs --all                  every packaged app
//   node tools/ladder-check.mjs word-wizard --shots out/   screenshots per grade
//   node tools/ladder-check.mjs word-wizard --drive    also exercise every level's generator 40 times
//   node tools/ladder-check.mjs word-wizard --phrases out.json   also record every narrator line the app asked for
//                                                                 (text, rate, voice), keyed by app id
//   node tools/ladder-check.mjs word-wizard --lang es      load the app the way a Spanish tablet does (KidTablet.language
//                                                          es, a Spanish narrator). The visible text is scanned for
//                                                          English words, and an app's window.DucklingLang hook
//                                                          ({ missing: () => string[] of untranslated keys, allow:
//                                                          string[] of English words that are right as they are }) is
//                                                          read; either fails the grade. docs/languages-brief.md.
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
const SUBJECTS = ['reading', 'math', 'science', 'logic', 'art', 'music'];
const GRADES = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const NAME = { '-1': 'pre-K', 0: 'K', 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th', 7: '7th', 8: '8th' };

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; args.splice(i, v === true ? 1 : 2); return v; };
const all = flag('--all'); const shots = flag('--shots'); const drive = flag('--drive'); const times = Number(flag('--times') || 40);
const phrasesOut = flag('--phrases'); const heard = {};
const lang = flag('--lang') === 'es' ? 'es' : 'en';
const VOICE = lang === 'es' ? 'es-MX-MarinaNeural' : 'en-US-AnaNeural';
// English words that have no place on a Spanish screen. Short words that Spanish also has (a, no, me, sin, con, son)
// are left out. An app that must show one (a brand, a letter name) lists it in DucklingLang.allow.
const ENGLISH = new Set(('the you your and with tap click press next play start level score correct again great good job choose pick done back ready try new game points star stars word words number numbers count color colors draw listen read say sing build make help hint win time hard easy medium mode menu settings sound music play pause stop continue finish finished skip yes answer question wrong right left down up high low fast slow big small more less add remove save delete open close show hide turn drag drop match find search begin learn practice lesson round rounds player players welcome hello goodbye thanks thank please sorry oops nice awesome wow cool okay ok let go wait loading step steps page pages').split(' '));
const ids = all ? fs.readdirSync(APPS).filter((d) => fs.existsSync(path.join(APPS, d, 'manifest.json'))) : args;
if (!ids.length) { console.error('usage: node tools/ladder-check.mjs <app-id>|--all [--shots dir] [--drive] [--times n]'); process.exit(2); }
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
      const bridge = `window.DucklingApp={appId:()=>${JSON.stringify(id)},deviceToken:()=>'t',apiUrl:()=>location.origin+'/api',childName:()=>'Ada',voice:()=>${JSON.stringify(VOICE)},language:()=>${JSON.stringify(lang)},levels:()=>${JSON.stringify(levels)}};`;
      html = html.replace(/<head>/i, `<head><script>${bridge}</script><script>${COMPAT.replace(/<\/script/g, '<\\/script')}</script>`);
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
    }
    const f = path.join(root, u); if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  for (const g of GRADES) {
    const levels = Object.fromEntries(SUBJECTS.map((s) => [s, g]));
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 }, permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => { if (!/decode audio/i.test(e.message)) errors.push('pageerror: ' + e.message.slice(0, 160)); });
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|decode audio|net::ERR|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)); });
    await page.route('**/api/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/api/tts') && !u.searchParams.get('private')) {
        const line = { text: u.searchParams.get('text') || '', rate: Number(u.searchParams.get('rate')) || 0, voice: u.searchParams.get('voice') || '' };
        (heard[id] ??= new Map()).set(`${line.voice}|${line.rate}|${line.text}`, line);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"design":null,"owned":[],"spent":0,"savedAt":0,"earned":0,"earnedByApp":{},"content":[{"type":"text","text":"{}"}]}' });
    });
    try {
      await page.goto(`${base}?levels=${encodeURIComponent(JSON.stringify(levels))}`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(2000);
      const info = await page.evaluate(() => {
        const L = window.DucklingLadder;
        const start = typeof START_LEVEL !== 'undefined' ? START_LEVEL : typeof START !== 'undefined' ? START : typeof APP !== 'undefined' && APP.start !== undefined ? APP.start : typeof SUBJECTS !== 'undefined' && Array.isArray(SUBJECTS) ? SUBJECTS.map((s) => s.start) : undefined;
        return { start: start === undefined ? (L && L.start ? L.start() : null) : start, levels: L && L.levels ? L.levels() : null, label: L && L.label ? L.label() : null };
      });
      let driven = '';
      if (drive) {
        const r = await page.evaluate(async (n) => {
          const L = window.DucklingLadder; if (!L || !L.exercise) return null;
          const out = { ok: 0, bad: [] , samples: {} };
          const count = L.levels();
          for (let i = 0; i < count; i++) {
            try { const s = await L.exercise(i, n); out.ok++; out.samples[i] = Array.isArray(s) ? s.slice(0, 2) : s; } catch (e) { out.bad.push(`level ${i}: ${String(e && e.message || e).slice(0, 120)}`); }
          }
          return out;
        }, times);
        if (r === null) driven = '  (no DucklingLadder.exercise hook)';
        else { driven = `  exercised ${r.ok}/${r.ok + r.bad.length} levels x${times}`; if (r.bad.length) errors.push(...r.bad); }
      }
      if (lang === 'es') {
        const r = await page.evaluate((english) => {
          const L = window.DucklingLang || {};
          const allow = new Set((L.allow || []).map((w) => String(w).toLowerCase()));
          const missing = L.missing ? L.missing() : null;
          const text = (document.body && document.body.innerText) || '';
          const found = new Set();
          for (const w of text.toLowerCase().split(/[^a-záéíóúüñ']+/)) if (english.includes(w) && !allow.has(w)) found.add(w);
          return { missing, found: [...found], hook: !!L.missing, keys: L.keys ? L.keys().length : null };
        }, [...ENGLISH]);
        if (!r.hook) errors.push('no window.DucklingLang.missing hook (docs/languages-brief.md)');
        if (r.missing && r.missing.length) errors.push(`untranslated: ${r.missing.slice(0, 8).join(' | ')}${r.missing.length > 8 ? ` (+${r.missing.length - 8})` : ''}`);
        if (r.found.length) errors.push(`English on screen: ${r.found.slice(0, 12).join(' ')}`);
      }
      if (shots) await page.screenshot({ path: path.join(shots, `${id}-${lang}-${String(g).replace('-', 'm')}.png`) });
      const bad = errors.length > 0;
      if (bad) failed++;
      console.log(`${bad ? 'FAIL' : 'ok  '} ${id} ${NAME[g].padEnd(5)} start=${JSON.stringify(info.start)}${info.levels != null ? ` of ${info.levels}` : ''}${info.label ? ` "${info.label}"` : ''}${driven}${bad ? '\n       ' + [...new Set(errors)].slice(0, 6).join('\n       ') : ''}`);
    } catch (e) {
      failed++; console.log(`FAIL ${id} ${NAME[g]} ${String(e.message).slice(0, 160)}`);
    }
    await ctx.close();
  }
  srv.close();
}
await browser.close();
if (phrasesOut) fs.writeFileSync(phrasesOut, JSON.stringify(Object.fromEntries(Object.entries(heard).map(([k, m]) => [k, [...m.values()]])), null, 1));
process.exit(failed ? 1 : 0);
