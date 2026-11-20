#!/usr/bin/env node
// Checks apps and writes apps/<id>/phrases.json, the lines the narrator is asked to say, so the publish tool can have
// the shared voice cache make them before any tablet asks (build plan, section 12, publish steps 1 and 2).
//
//   node tools/phrases.mjs <id> [<id>...]     check named apps
//   node tools/phrases.mjs --all              check every app
//
// For each app this runs tools/ladder-check.mjs --drive (every grade from pre-K to 8th, every rung exercised) in English
// and again in Spanish (--lang es), and stops on any failure. Then it gathers the lines:
//   - every line the app asked the narrator for while it was loaded at each grade, with its rate and voice; a line
//     heard from the Spanish run in the Spanish narrator carries lang "es", so the cache makes it in that voice;
//   - every fixed string the app passes straight to its speech helper (say, speak, talk, tell, narrate and the like),
//     at the rate that helper sets.
// Lines built at run time ("You found 7 shells") are not known here; the cache makes them the first time a tablet
// asks. phrases.json also records a hash of the app's files. The publish tool refuses a new version when the files
// no longer match that hash, so every published version was checked first.
//
// Needs Playwright with Chromium (backend dev dependency). Runs on a PC, in a Claude session or in CI, not on the
// droplet: commit the phrases.json it writes.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, sourceHash } from './app-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = join(ROOT, 'apps');
const HARNESS_VOICE = 'en-US-AnaNeural'; // what ladder-check's fake bridge reports; lines in it use the narrator
const HARNESS_VOICE_ES = 'es-MX-MarinaNeural'; // the same for --lang es; lines in it use the Spanish narrator
const args = process.argv.slice(2);
const ids = args.includes('--all') ? readdirSync(APPS).filter((d) => existsSync(join(APPS, d, 'manifest.json'))) : args.filter((a) => !a.startsWith('--'));
if (!ids.length) { console.error('usage: node tools/phrases.mjs <id>...|--all'); process.exit(2); }

// The same cleaning the compatibility script does before it asks for a clip, so the cache key matches.
export const clean = (t) => String(t || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();

const HELPER = /\b(say|speak|talk|tell|narrate|announce|sayLine|speakLine|sayText)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\\n])*)\2\s*[,)]/g;
function unescape(s, q) { try { return q === '`' ? s.replace(/\\`/g, '`').replace(/\\\\/g, '\\') : JSON.parse('"' + s.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'); } catch { return null; } }

function staticLines(dir) {
  const out = [];
  for (const rel of listFiles(dir)) {
    if (!/\.(html|js)$/.test(rel) || rel === 'phrases.json') continue;
    // Embedded libraries and assets sit on very long lines; app code does not.
    const code = readFileSync(join(dir, rel), 'utf8').split('\n').filter((l) => l.length < 5000).join('\n');
    const rates = [...code.matchAll(/\.rate\s*=\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    const rate = rates.length ? Math.round((Math.max(0.5, Math.min(2, rates[0])) - 1) * 100) : 0;
    for (const m of code.matchAll(HELPER)) {
      if (m[2] === '`' && m[3].includes('${')) continue;
      const text = clean(unescape(m[3], m[2]));
      if (text.length >= 2 && text.length <= 1000 && /[a-z]/i.test(text)) out.push({ text, rate });
    }
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'phrases-'));
let failed = 0;
for (const id of ids) {
  const dir = join(APPS, id);
  if (!existsSync(join(dir, 'manifest.json'))) { console.error(`${id}: no apps/${id}/manifest.json`); failed++; continue; }
  const heard = [];
  let bad = false;
  for (const lang of ['en', 'es']) {
    const heardFile = join(tmp, `${id}-${lang}.json`);
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'ladder-check.mjs'), id, '--drive', '--lang', lang, '--phrases', heardFile], { encoding: 'utf8' });
    const lines = (r.stdout || '').trim().split('\n');
    if (r.status !== 0) { console.error(`${id}: ${lang === 'es' ? 'Spanish ' : ''}check failed, phrases.json not written\n${lines.filter((l) => !l.startsWith('ok')).join('\n')}${r.stderr ? '\n' + r.stderr.slice(-800) : ''}`); failed++; bad = true; break; }
    const got = existsSync(heardFile) ? (JSON.parse(readFileSync(heardFile, 'utf8'))[id] ?? []) : [];
    heard.push(...got.map((l) => (lang === 'es' && l.voice === HARNESS_VOICE_ES ? { ...l, lang: 'es' } : l)));
  }
  if (bad) continue;
  const seen = new Map();
  const add = (l) => {
    const text = clean(l.text); if (!text) return;
    const voice = l.voice && l.voice !== HARNESS_VOICE && l.voice !== HARNESS_VOICE_ES ? l.voice : undefined;
    const k = `${l.lang ?? ''}|${voice ?? ''}|${l.rate}|${text}`;
    if (!seen.has(k)) seen.set(k, { text, rate: l.rate, ...(voice ? { voice } : {}), ...(l.lang === 'es' ? { lang: 'es' } : {}) });
  };
  heard.forEach(add);
  staticLines(dir).forEach(add);
  const list = [...seen.values()].sort((a, b) => a.text.localeCompare(b.text) || a.rate - b.rate);
  writeFileSync(join(dir, 'phrases.json'), JSON.stringify({ source: sourceHash(dir), lines: list }, null, 1) + '\n');
  console.log(`${id}: checked at 10 grades in English and Spanish, ${list.length} lines (${list.filter((l) => l.lang === 'es').length} Spanish, ${heard.length} heard on load)`);
}
process.exit(failed ? 1 : 0);
