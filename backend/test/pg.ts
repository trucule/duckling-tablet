// A real PostgreSQL for tests: one embedded cluster per test file, a template database with the bootstrap and all
// migrations applied, and a fresh copy of it for every test (CREATE DATABASE ... TEMPLATE takes a few milliseconds).
// The cluster's superuser plays doadmin for the bootstrap; the API connects as duckling_app and duckling_system,
// exactly as in production, so row-level security is exercised by every test.
import EmbeddedPostgres from 'embedded-postgres';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { bootstrap } from '../src/bootstrap.js';
import { Db, migrate } from '../src/db.js';

const SYSTEM_PW = 'system-test-pw', APP_PW = 'app-test-pw';

export interface TestDb { db: Db; name: string; appUrl: string; systemUrl: string; adminUrl: string }
export interface Cluster { port: number; newDb(): Promise<TestDb>; stop(): Promise<void> }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

export async function startCluster(): Promise<Cluster> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'duckling-pg-'));
  chmodSync(dir, 0o755); // mkdtemp makes it 0700; the postgres user needs to reach the data directory inside it
  const errors: string[] = [];
  const server = new EmbeddedPostgres({
    databaseDir: join(dir, 'data'), user: 'postgres', password: 'postgres', port, persistent: false,
    // PostgreSQL refuses to run as root (Claude's cloud workspace); embedded-postgres then runs it as a postgres user.
    createPostgresUser: process.getuid?.() === 0,
    onLog: () => {}, onError: (m) => errors.push(String(m)),
  });
  try {
    await server.initialise();
    await server.start();
  } catch (err) {
    throw new Error(`Embedded PostgreSQL did not start: ${(err as Error).message}\n${errors.join('\n')}`, { cause: err });
  }
  const url = (user: string, pw: string, database: string) => `postgresql://${user}:${pw}@127.0.0.1:${port}/${database}`;
  const asAdmin = async (database: string, fn: (c: pg.Client) => Promise<void>) => {
    const c = new pg.Client({ connectionString: url('postgres', 'postgres', database) });
    await c.connect();
    try { await fn(c); } finally { await c.end(); }
  };

  await asAdmin('postgres', (c) => c.query('CREATE DATABASE tmpl').then(() => {}));
  await asAdmin('tmpl', (c) => bootstrap(c, { systemPassword: SYSTEM_PW, appPassword: APP_PW }));
  const sys = new pg.Pool({ connectionString: url('duckling_system', SYSTEM_PW, 'tmpl'), max: 1 });
  try { await migrate(sys); } finally { await sys.end(); }

  let n = 0;
  return {
    port,
    async newDb() {
      const name = `t${++n}`;
      await asAdmin('postgres', (c) => c.query(`CREATE DATABASE ${name} TEMPLATE tmpl`).then(() => {}));
      const appUrl = url('duckling_app', APP_PW, name), systemUrl = url('duckling_system', SYSTEM_PW, name);
      return { db: new Db({ appUrl, systemUrl, appPoolSize: 4, systemPoolSize: 2 }), name, appUrl, systemUrl, adminUrl: url('postgres', 'postgres', name) };
    },
    async stop() {
      await server.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
