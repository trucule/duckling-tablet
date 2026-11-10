// The publish tool against a real server: packages the starter apps, signs them, publishes them, and the catalog
// then lists them with a signature that verifies against the tool's public key. Needs `npm ci` in tools/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { freePort, startCluster, type Cluster } from './pg.js';
import type { Db } from '../src/db.js';

// The starter set, read from the manifests so the tests follow it when an app joins or leaves the set.
const STARTERS = readdirSync(join(import.meta.dirname, '..', '..', 'apps')).filter((d) => existsSync(join(import.meta.dirname, '..', '..', 'apps', d, 'manifest.json')) && JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'apps', d, 'manifest.json'), 'utf8')).starter).sort();

const TOOLS = join(import.meta.dirname, '..', '..', 'tools');
const ADMIN = 'admin-token-for-tests-0123456789';
let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, base: string;

beforeAll(async () => {
  cluster = await startCluster();
  dir = mkdtempSync(join(tmpdir(), 'duck-pub-'));
  ({ db } = await cluster.newDb());
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const cfg = loadConfig({ NODE_ENV: 'test', STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), ADMIN_TOKEN: ADMIN, PUBLIC_URL: base });
  ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send() {} }, synth: async () => null, createTicket: async () => null }));
  await app.listen({ port, host: '127.0.0.1' });
});
afterAll(async () => { await app?.close(); await db?.close(); await cluster?.stop(); rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!existsSync(join(TOOLS, 'node_modules', 'fflate')))('publish tool', () => {
  it('publishes the starter apps with verifiable signatures and is idempotent', async () => {
    const keygen = execFileSync('node', [join(TOOLS, 'publish.mjs'), 'keygen'], { encoding: 'utf8' });
    const key = keygen.match(/^PACKAGE_SIGNING_KEY=(\S+)/m)![1];
    const pub = keygen.match(/base64, for the shells\): (\S+)/)![1];
    const env = { ...process.env, API_URL: base, ADMIN_TOKEN: ADMIN, PACKAGE_SIGNING_KEY: key, DOTENV_CONFIG_PATH: join(dir, 'none.env') };
    // The server runs in this process, so the tool must run without blocking the event loop.
    const { stdout: out } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'all', '--starter'], { encoding: 'utf8', env, maxBuffer: 1 << 24 });
    expect(out).toMatch(/count-with-me \d+\.\d+\.\d+: published/);
    expect(out).toMatch(/draw-with-me \d+\.\d+\.\d+: published/);
    // Each new version's narrator lines go to the voice cache right after it is stored.
    expect(out).toMatch(/count-with-me: voice \d+ made, \d+ already cached/);

    const catalog = (await (await fetch(`${base}/catalog`)).json()).apps as any[];
    const ids = catalog.map((a) => a.id).sort();
    expect(ids).toEqual(STARTERS);
    for (const a of catalog) {
      expect(a.starter).toBe(true);
      expect(a.tileUrl).toMatch(new RegExp(`/tiles/${a.id}-[0-9a-f]{12}\\.png$`));
      expect((await fetch(a.tileUrl)).status).toBe(200);
      const zip = Buffer.from(await (await fetch(a.latest.url)).arrayBuffer());
      expect(zip.length).toBe(a.latest.size);
      // raw 32-byte Ed25519 public key -> SPKI
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]);
      const ok = verify(null, zip, createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(a.latest.signature, 'base64'));
      expect(ok, `${a.id} signature`).toBe(true);
      expect(zip.subarray(0, 2).toString()).toBe('PK');
      // The package's index.html loads the compatibility script and no longer carries the Surface Azure block.
      const { unzipSync, strFromU8 } = await import('fflate');
      const entries = unzipSync(new Uint8Array(zip));
      const html = strFromU8(entries['index.html']);
      expect(html).toContain('<script src="duckling-compat.js"></script>');
      expect(html).not.toMatch(/KID-VOICE|voice-config\.js/);
      expect(entries['duckling-compat.js']).toBeDefined();
      expect(entries['manifest.json']).toBeDefined();
      // phrases.json, written by tools/phrases.mjs after the app passed its check, travels with the package.
      expect(JSON.parse(strFromU8(entries['phrases.json'])).lines).toBeInstanceOf(Array);
    }
    expect(catalog.find((a) => a.id === 'music-box').latest.permissions).toEqual(['microphone']);

    const { stdout: again } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'music-box'], { encoding: 'utf8', env });
    expect(again).toMatch(/already published \(same bytes\)/);
  });
});
