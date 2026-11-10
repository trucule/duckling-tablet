// The Windows release feed: an admin publishes a signed MSI per architecture, the newest is what tablets update to.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { Db } from '../src/db.js';
import { startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string;
const admin = { authorization: 'Bearer admin-test-token-123456', 'content-type': 'application/x-msi' };
const msi = (fill: number) => { const b = Buffer.alloc(8192, fill); b.writeUInt32BE(0xd0cf11e0, 0); b.writeUInt32BE(0xa1b11ae1, 4); return b; };

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-win-'));
  ({ db } = await cluster.newDb());
  const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456' });
  ({ app } = await buildServer(cfg, { db, logger: false, stripe: null }));
});
afterEach(async () => { await app.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Windows releases', () => {
  it('publishes signed installers per architecture and serves the newest', async () => {
    expect((await app.inject({ method: 'GET', url: '/windows/release?arch=arm64' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/admin/windows/releases?version=1.0.0&arch=arm64', headers: { ...admin, authorization: 'Bearer nope' }, payload: msi(1) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/windows/releases?version=1.0.0&arch=arm64', headers: admin, payload: Buffer.alloc(8192, 7) })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/admin/windows/releases?version=1.0.0&arch=arm64', headers: admin, payload: msi(1) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ version: '1.0.0', arch: 'arm64', size: 8192, sha256: createHash('sha256').update(msi(1)).digest('hex') });
    expect(existsSync(join(dir, 'files', 'windows', 'DucklingTablet-1.0.0-arm64.msi'))).toBe(true);
    await app.inject({ method: 'POST', url: '/admin/windows/releases?version=1.0.0&arch=x64', headers: admin, payload: msi(2) });
    await app.inject({ method: 'POST', url: '/admin/windows/releases?version=1.0.10&arch=arm64', headers: admin, payload: msi(3) });
    // Same or lower version for that architecture is refused.
    expect((await app.inject({ method: 'POST', url: '/admin/windows/releases?version=1.0.9&arch=arm64', headers: admin, payload: msi(4) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/windows/release?arch=arm64' })).json()).toMatchObject({ version: '1.0.10', url: expect.stringMatching(/\/files\/windows\/DucklingTablet-1\.0\.10-arm64\.msi$/) });
    const both = (await app.inject({ method: 'GET', url: '/windows/release' })).json();
    expect(both.x64.version).toBe('1.0.0');
    expect(both.arm64.version).toBe('1.0.10');
  });
});
