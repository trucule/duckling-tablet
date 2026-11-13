#!/usr/bin/env node
// Packages apps/<id>/ into signed zips and publishes them to the catalog (build plan, section 12).
//
//   node tools/publish.mjs keygen [--write /opt/duckling/.env]   make an Ed25519 signing key pair; prints the public key
//                                                                 and writes PACKAGE_SIGNING_KEY into the env file
//   node tools/publish.mjs pubkey                                  prints the public key of PACKAGE_SIGNING_KEY
//   node tools/publish.mjs all [--starter]                         publish every app (or only the starter set)
//   node tools/publish.mjs <id> [<id>...] [--request <reqId>]      publish named apps
//   node tools/publish.mjs voice all|<id>...                       ask the voice cache to make every line in the apps'
//                                                                 phrases.json now (publishing a version does this too)
//
// "starter": true in a manifest means the app is installed on a tablet when it is paired. Publishing never installs
// anything on tablets already paired: a new app appears in their Library until the child or a parent installs it.
// New apps get "starter": false, so the default set stays the apps a tablet started with.
//
// Needs ADMIN_TOKEN, PACKAGE_SIGNING_KEY (base64 PKCS8) and optionally API_URL in the environment or the env file
// named by DOTENV_CONFIG_PATH. A version already in the catalog is skipped, so a rerun is harmless.
//
// A new version is published only when apps/<id>/phrases.json matches the app's files: tools/phrases.mjs writes it
// after the app passes tools/ladder-check.mjs at every grade, so an app changed since its last check is refused (named
// apps stop the run; "all" skips that app and says so). After a new version is stored, its phrases go to the voice
// cache (POST /admin/voice/pregenerate) so the narrator lines are ready before the first tablet installs it.
//
// Package contents: manifest.json, index.html and the app's files, tile.png, and duckling-compat.js (per-app
// localStorage, the Duckling narrator, window.KidTablet). The Surface apps' own KID-VOICE block and their
// voice-config.js reference are replaced by the compatibility script at packaging time; config.js (Draw With Me's
// optional AI key) stays an empty stub until the AI proxy lands.
import 'dotenv/config';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { listFiles, sourceHash } from './app-source.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = join(ROOT, 'apps');
const API = (process.env.API_URL ?? 'https://api.ducklingtablet.com').replace(/\/$/, '');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const die = (m) => { console.error(m); process.exit(1); };

function publicKeyOf(pkcs8b64) {
  const priv = createPrivateKey({ key: Buffer.from(pkcs8b64, 'base64'), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return { spki: spki.toString('base64'), raw: spki.subarray(spki.length - 32).toString('base64') };
}

if (args[0] === 'keygen') {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const pub = publicKeyOf(pkcs8);
  const file = flag('--write');
  if (file) {
    let env = readFileSync(file, 'utf8');
    env = /^PACKAGE_SIGNING_KEY=.*$/m.test(env) ? env.replace(/^PACKAGE_SIGNING_KEY=.*$/m, () => `PACKAGE_SIGNING_KEY=${pkcs8}`) : `${env.replace(/\n?$/, '\n')}PACKAGE_SIGNING_KEY=${pkcs8}\n`;
    writeFileSync(file, env);
    console.log(`PACKAGE_SIGNING_KEY written to ${file} (not shown).`);
  } else {
    console.log(`PACKAGE_SIGNING_KEY=${pkcs8}`);
  }
  console.log(`Public key (raw Ed25519, base64, for the shells): ${pub.raw}`);
  process.exit(0);
}

const KEY = process.env.PACKAGE_SIGNING_KEY;
const voiceOnly = args[0] === 'voice';
if (!KEY && !voiceOnly) die('PACKAGE_SIGNING_KEY is not set. Run: node tools/publish.mjs keygen --write /opt/duckling/.env');
if (args[0] === 'pubkey') { console.log(publicKeyOf(KEY).raw); process.exit(0); }
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) die('ADMIN_TOKEN is not set.');
const privateKey = voiceOnly ? null : createPrivateKey({ key: Buffer.from(KEY, 'base64'), format: 'der', type: 'pkcs8' });

// phrases.json as written by tools/phrases.mjs, or why it cannot be used for this version.
function phrasesOf(id) {
  const file = join(APPS, id, 'phrases.json');
  if (!existsSync(file)) return { problem: 'has no phrases.json' };
  const p = JSON.parse(readFileSync(file, 'utf8'));
  if (p.source !== sourceHash(join(APPS, id))) return { problem: 'changed since it was last checked' };
  return { lines: p.lines ?? [] };
}

async function pregenerate(id, lines) {
  let created = 0, cached = 0, failed = 0;
  for (let i = 0; i < lines.length; i += 200) {
    const r = await api('POST', '/admin/voice/pregenerate', JSON.stringify({ lines: lines.slice(i, i + 200) }), { 'content-type': 'application/json' });
    if (r.status !== 200) { console.error(`${id}: voice pre-generation stopped: ${r.status} ${JSON.stringify(r.json)}`); return; }
    created += r.json.created; cached += r.json.cached; failed += r.json.failed;
  }
  console.log(`${id}: voice ${created} made, ${cached} already cached${failed ? `, ${failed} failed` : ''}`);
}

function validate(m, id) {
  const problems = [];
  if (m.id !== id) problems.push(`id "${m.id}" does not match folder "${id}"`);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id ?? '')) problems.push('id must be lowercase letters, digits and dashes');
  if (!m.name || m.name.length > 60) problems.push('name missing or over 60 characters');
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) problems.push('version must be x.y.z');
  if ((m.description ?? '').length > 500) problems.push('description over 500 characters');
  for (const s of m.subjects ?? []) if (!['reading', 'math', 'science', 'art', 'music', 'logic'].includes(s)) problems.push(`unknown subject ${s}`);
  if (m.about && !(typeof m.about.concept === 'string' && typeof m.about.progression === 'string' && Array.isArray(m.about.lifeSkills) && m.about.lifeSkills.length)) problems.push('about needs concept, progression and lifeSkills');
  for (const p of m.permissions ?? []) if (!['microphone', 'camera'].includes(p)) problems.push(`unknown permission ${p}`);
  if (problems.length) die(`apps/${id}/manifest.json: ${problems.join('; ')}`);
}

// The Surface apps carry an inline KID-VOICE block (Azure with a local key) behind <script src="voice-config.js">.
// Both go; duckling-compat.js takes their place at the same spot, or right after <head> when an app has neither.
export function withCompat(html, id) {
  const tag = '<script src="duckling-compat.js"></script>';
  let out = html.replace(/<script>\/\* KID-VOICE START \*\/[\s\S]*?\/\* KID-VOICE END \*\/<\/script>\s*/g, '');
  if (/<script src="voice-config\.js"><\/script>/.test(out)) out = out.replace(/<script src="voice-config\.js"><\/script>/, tag);
  else if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  else out = tag + '\n' + out;
  if (/KID-VOICE START|voice-config\.js/.test(out)) die(`apps/${id}/index.html: could not replace the voice block`);
  return out;
}

function pack(id) {
  const dir = join(APPS, id);
  if (!existsSync(join(dir, 'manifest.json'))) die(`apps/${id}/manifest.json is missing`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  validate(manifest, id);
  if (!existsSync(join(dir, 'index.html'))) die(`apps/${id}/index.html is missing`);
  if (!existsSync(join(dir, 'tile.png'))) die(`apps/${id}/tile.png is missing`);
  const files = {};
  for (const rel of listFiles(dir)) files[rel] = [readFileSync(join(dir, rel)), { level: rel.endsWith('.png') ? 0 : 6 }];
  files['index.html'] = [Buffer.from(withCompat(files['index.html'][0].toString('utf8'), id)), { level: 6 }];
  files['duckling-compat.js'] = [readFileSync(join(ROOT, 'tools', 'duckling-compat.js')), { level: 6 }];
  if (!files['config.js']) files['config.js'] = [Buffer.from('// Written by the Duckling publish tool: no local AI config; the backend proxies AI calls.\n'), { level: 6 }];
  const zip = Buffer.from(zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') }));
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const signature = sign(null, zip, privateKey).toString('base64');
  return { manifest, zip, sha256, signature };
}

async function api(method, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, ...headers }, body });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

async function publish(id, requestId) {
  const { manifest: m, zip, sha256, signature } = pack(id);
  const catalog = (await (await fetch(`${API}/catalog`)).json()).apps;
  const existing = catalog.find((a) => a.id === id);
  // A new version must have been checked; nothing is sent for one that was not.
  const phrases = existing?.latest?.version === m.version ? { lines: [] } : phrasesOf(id);
  if (phrases.problem) {
    const msg = `${id} ${m.version}: not published, apps/${id} ${phrases.problem}. Run: node tools/phrases.mjs ${id}, then commit apps/${id}/phrases.json`;
    if (all) { console.error(msg); skipped++; return; }
    die(msg);
  }
  const meta = { name: m.name, description: m.description ?? '', subjects: m.subjects ?? [], ageMin: m.ageMin ?? null, ageMax: m.ageMax ?? null, starter: !!m.starter, about: m.about ?? null };
  const put = await api('PUT', `/admin/apps/${id}`, JSON.stringify(meta), { 'content-type': 'application/json' });
  if (put.status !== 200) die(`PUT /admin/apps/${id}: ${put.status} ${JSON.stringify(put.json)}`);
  const tile = await api('PUT', `/admin/apps/${id}/tile`, readFileSync(join(APPS, id, 'tile.png')), { 'content-type': 'image/png' });
  if (tile.status !== 200) die(`PUT tile ${id}: ${tile.status} ${JSON.stringify(tile.json)}`);
  // The About page's recording (tools/demos.mjs makes it); uploaded when its bytes changed, like the tile.
  if (existsSync(join(APPS, id, 'demo.gif'))) {
    const gif = readFileSync(join(APPS, id, 'demo.gif'));
    const gifKey = `demos/${id}-${createHash('sha256').update(gif).digest('hex').slice(0, 12)}.gif`;
    if (!existing?.demoUrl || !existing.demoUrl.endsWith(gifKey)) {
      const demo = await api('PUT', `/admin/apps/${id}/demo`, gif, { 'content-type': 'image/gif' });
      if (demo.status !== 200) die(`PUT demo ${id}: ${demo.status} ${JSON.stringify(demo.json)}`);
    }
  }
  if (existing?.latest?.version === m.version) {
    // Tablets update an app only when its version changes, so new bytes under an old version (an edited app, or a
    // change to duckling-compat.js) would never reach them. Say so plainly.
    if (existing.latest.sha256 === sha256) console.log(`${id} ${m.version}: already published (same bytes); metadata updated`);
    else console.error(`${id} ${m.version}: already published (DIFFERENT bytes); metadata updated. Tablets keep the old package until the version in apps/${id}/manifest.json goes up.`);
    return;
  }

  const qs = new URLSearchParams({ version: m.version, signature });
  if (m.minShell) qs.set('minShell', m.minShell);
  if (m.permissions?.length) qs.set('permissions', m.permissions.join(','));
  if (requestId) qs.set('request', requestId);
  const post = await api('POST', `/admin/apps/${id}/versions?${qs}`, zip, { 'content-type': 'application/zip' });
  if (post.status !== 200) die(`POST versions ${id}: ${post.status} ${JSON.stringify(post.json)}`);
  console.log(`${id} ${m.version}: published, ${(zip.length / 1024).toFixed(0)} KB, sha256 ${sha256.slice(0, 12)}..., ${post.json.url}`);
  await pregenerate(id, phrases.lines);
}

let ids = args.filter((a) => !a.startsWith('--') && a !== flag('--request'));
if (voiceOnly) ids.shift();
const all = ids[0] === 'all';
let skipped = 0;
if (all) {
  ids = readdirSync(APPS).filter((d) => existsSync(join(APPS, d, 'manifest.json')));
  if (has('--starter')) ids = ids.filter((d) => JSON.parse(readFileSync(join(APPS, d, 'manifest.json'), 'utf8')).starter);
}
if (!ids.length) die('Name apps to publish, or "all".');
if (voiceOnly) {
  for (const id of ids) {
    const p = phrasesOf(id);
    if (p.problem) { console.error(`${id}: apps/${id} ${p.problem}; run node tools/phrases.mjs ${id}`); skipped++; continue; }
    await pregenerate(id, p.lines);
  }
} else {
  for (const id of ids) await publish(id, flag('--request'));
}
if (skipped) { console.error(`${skipped} app(s) skipped; see above.`); process.exitCode = 1; }
