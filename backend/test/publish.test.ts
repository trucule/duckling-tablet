// The publish tool against a real server: packages the starter apps, signs them, publishes them, and the catalog
// then lists them with a signature that verifies against the tool's public key. Needs `npm ci` in tools/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { freePort, startCluster, type Cluster } from './pg.js';
import type { Db } from '../src/db.js';

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
    expect(out).toMatch(/count-with-me 1\.0\.0: published/);
    expect(out).toMatch(/draw-with-me 1\.0\.0: published/);

    const catalog = (await (await fetch(`${base}/catalog`)).json()).apps as any[];
    const ids = catalog.map((a) => a.id).sort();
    expect(ids).toEqual(['count-with-me', 'draw-with-me', 'music-box', 'robot-path', 'trace-with-me', 'word-wizard']);
    for (const a of catalog) {
      expect(a.starter).toBe(true);
      const zip = Buffer.from(await (await fetch(a.latest.url)).arrayBuffer());
      expect(zip.length).toBe(a.latest.size);
      // raw 32-byte Ed25519 public key -> SPKI
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub, 'base64')]);
      const ok = verify(null, zip, createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(a.latest.signature, 'base64'));
      expect(ok, `${a.id} signature`).toBe(true);
      expect(zip.subarray(0, 2).toString()).toBe('PK');
    }
    expect(catalog.find((a) => a.id === 'music-box').latest.permissions).toEqual(['microphone']);

    const { stdout: again } = await execFile('node', [join(TOOLS, 'publish.mjs'), 'music-box'], { encoding: 'utf8', env });
    expect(again).toMatch(/already published \(same bytes\)/);
  });
});
