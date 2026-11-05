// PostgreSQL through two pools. duckling_app is subject to row-level security and is used for every request made
// for a parent or a device; duckling_system owns the tables and is used, on purpose and only through
// db.system(), for migrations, webhooks, admin publishing, the voice cache index and family deletion.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg';
import { pgConfig } from './pgconfig.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// timestamptz comes back as a Date; everything else stays text or a number.
pg.types.setTypeParser(20, (v) => Number(v)); // bigint: sizes and counts fit in a JS number

export interface DbOptions {
  appUrl: string;
  systemUrl: string;
  caCert?: string; // path to the DigitalOcean CA certificate; without it, plain TCP (local development and tests)
  appPoolSize?: number;
  systemPoolSize?: number;
}

// One transaction's worth of queries.
export class Q {
  constructor(readonly client: PoolClient) {}
  async all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> { return (await this.client.query(sql, params)).rows as T[]; }
  async one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> { return (await this.all<T>(sql, params))[0]; }
  async run(sql: string, params: unknown[] = []): Promise<number> { return (await this.client.query(sql, params)).rowCount ?? 0; }
  // Scopes the rest of this transaction to one family (transaction-local, so safe behind PgBouncer).
  async setFamily(familyId: string): Promise<void> { await this.client.query("SELECT set_config('app.family_id', $1, true)", [familyId]); }
}

export class Db {
  readonly appPool: Pool;
  readonly systemPool: Pool;

  constructor(opts: DbOptions) {
    const base: PoolConfig = { idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };
    this.appPool = new pg.Pool({ ...base, ...pgConfig(opts.appUrl, opts.caCert), max: opts.appPoolSize ?? 8 });
    this.systemPool = new pg.Pool({ ...base, ...pgConfig(opts.systemUrl, opts.caCert), max: opts.systemPoolSize ?? 3 });
  }

  // A single statement as duckling_app with no family set: health checks, catalog reads, SECURITY DEFINER lookups.
  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> { return (await this.appPool.query(sql, params)).rows as T[]; }

  // A transaction as duckling_app with no family yet; call q.setFamily once the family is known.
  app<T>(fn: (q: Q) => Promise<T>): Promise<T> { return tx(this.appPool, fn); }

  // A transaction as duckling_app scoped to one family. Every parent and device route runs inside one of these.
  family<T>(familyId: string, fn: (q: Q) => Promise<T>): Promise<T> {
    return tx(this.appPool, async (q) => { await q.setFamily(familyId); return fn(q); });
  }

  // A transaction as duckling_system, past the policies. Webhooks, admin work, system writes.
  system<T>(fn: (q: Q) => Promise<T>): Promise<T> { return tx(this.systemPool, fn); }

  async close(): Promise<void> { await Promise.all([this.appPool.end(), this.systemPool.end()]); }
}

async function tx<T>(pool: Pool, fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(new Q(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Applies migrations/NNN_*.sql in order, once each, as duckling_system.
export async function migrate(systemPool: Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await systemPool.connect();
  const applied: string[] = [];
  try {
    await client.query('SET search_path = duckling');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migration')).rows.map((r) => r.name as string));
    for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL search_path = duckling');
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    client.release();
  }
  return applied;
}
