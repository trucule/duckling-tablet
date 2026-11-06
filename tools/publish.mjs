#!/usr/bin/env node
// Packages apps/<id>/ into signed zips and publishes them to the catalog (build plan, section 12).
//
//   node tools/publish.mjs keygen [--write /opt/duckling/.env]   make an Ed25519 signing key pair; prints the public key
//                                                                 and writes PACKAGE_SIGNING_KEY into the env file
//   node tools/publish.mjs pubkey                                  prints the public key of PACKAGE_SIGNING_KEY
//   node tools/publish.mjs all [--starter]                         publish every app (or only the starter set)
//   node tools/publish.mjs <id> [<id>...] [--request <reqId>]      publish named apps
//
// Needs ADMIN_TOKEN, PACKAGE_SIGNING_KEY (base64 PKCS8) and optionally API_URL in the environment or the env file
// named by DOTENV_CONFIG_PATH. A version already in the catalog is skipped, so a rerun is harmless.
//
// Package contents: manifest.json, index.html and the app's files, tile.png, plus two stubs the Surface apps load:
// voice-config.js (empty, so speech falls back to the device voice until the compatibility script lands) and
// config.js (empty, for Draw With Me's optional AI key, which the backend will provide later).
import 'dotenv/config';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

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
if (!KEY) die('PACKAGE_SIGNING_KEY is not set. Run: node tools/publish.mjs keygen --write /opt/duckling/.env');
if (args[0] === 'pubkey') { console.log(publicKeyOf(KEY).raw); process.exit(0); }
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) die('ADMIN_TOKEN is not set.');
const privateKey = createPrivateKey({ key: Buffer.from(KEY, 'base64'), format: 'der', type: 'pkcs8' });

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function validate(m, id) {
  const problems = [];
  if (m.id !== id) problems.push(`id "${m.id}" does not match folder "${id}"`);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(m.id ?? '')) problems.push('id must be lowercase letters, digits and dashes');
  if (!m.name || m.name.length > 60) problems.push('name missing or over 60 characters');
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) problems.push('version must be x.y.z');
  if ((m.description ?? '').length > 500) problems.push('description over 500 characters');
  for (const s of m.subjects ?? []) if (!['reading', 'math', 'science', 'art', 'music', 'logic'].includes(s)) problems.push(`unknown subject ${s}`);
  for (const p of m.permissions ?? []) if (!['microphone', 'camera'].includes(p)) problems.push(`unknown permission ${p}`);
  if (problems.length) die(`apps/${id}/manifest.json: ${problems.join('; ')}`);
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
  const stubComment = Buffer.from('// Written by the Duckling publish tool: this package has no local voice or AI config.\n');
  if (!files['voice-config.js']) files['voice-config.js'] = [stubComment, { level: 6 }];
  if (!files['config.js']) files['config.js'] = [stubComment, { level: 6 }];
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
  const meta = { name: m.name, description: m.description ?? '', subjects: m.subjects ?? [], ageMin: m.ageMin ?? null, ageMax: m.ageMax ?? null, starter: !!m.starter };
  const put = await api('PUT', `/admin/apps/${id}`, JSON.stringify(meta), { 'content-type': 'application/json' });
  if (put.status !== 200) die(`PUT /admin/apps/${id}: ${put.status} ${JSON.stringify(put.json)}`);
  const tile = await api('PUT', `/admin/apps/${id}/tile`, readFileSync(join(APPS, id, 'tile.png')), { 'content-type': 'image/png' });
  if (tile.status !== 200) die(`PUT tile ${id}: ${tile.status} ${JSON.stringify(tile.json)}`);
  if (existing?.latest?.version === m.version) {
    console.log(`${id} ${m.version}: already published (${existing.latest.sha256 === sha256 ? 'same' : 'DIFFERENT'} bytes); metadata updated`);
    return;
  }
  const qs = new URLSearchParams({ version: m.version, signature });
  if (m.minShell) qs.set('minShell', m.minShell);
  if (m.permissions?.length) qs.set('permissions', m.permissions.join(','));
  if (requestId) qs.set('request', requestId);
  const post = await api('POST', `/admin/apps/${id}/versions?${qs}`, zip, { 'content-type': 'application/zip' });
  if (post.status !== 200) die(`POST versions ${id}: ${post.status} ${JSON.stringify(post.json)}`);
  console.log(`${id} ${m.version}: published, ${(zip.length / 1024).toFixed(0)} KB, sha256 ${sha256.slice(0, 12)}..., ${post.json.url}`);
}

let ids = args.filter((a) => !a.startsWith('--') && a !== flag('--request'));
if (ids[0] === 'all') {
  ids = readdirSync(APPS).filter((d) => existsSync(join(APPS, d, 'manifest.json')));
  if (has('--starter')) ids = ids.filter((d) => JSON.parse(readFileSync(join(APPS, d, 'manifest.json'), 'utf8')).starter);
}
if (!ids.length) die('Name apps to publish, or "all".');
for (const id of ids) await publish(id, flag('--request'));
