// Row-level security, checked at the SQL level as duckling_app (section 5 of the build plan). These must pass before
// any other PostgreSQL work counts as done.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import type { Db } from '../src/db.js';
import { startCluster, type Cluster, type TestDb } from './pg.js';

let cluster: Cluster, t: TestDb, db: Db;
const A = 'fam_A', B = 'fam_B';

const FAMILY_TABLES = ['family', 'parent', 'session', 'child', 'pairing_code', 'device', 'device_app', 'device_hidden_app',
  'setting', 'app_request', 'request_attachment', 'entitlement', 'purchase', 'tts_usage', 'audit'];
const CLOSED_TABLES = ['login_token', 'device_tombstone', 'webhook_event'];
const READ_ONLY_TABLES = ['app', 'app_version', 'voice_clip', 'entitlement', 'purchase'];

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

beforeEach(async () => {
  t = await cluster.newDb(); db = t.db;
  // Two families with a child, a device and a request each, written as the owner.
  await db.system(async (q) => {
    for (const [f, name] of [[A, 'Ada'], [B, 'Ben']] as const) {
      await q.run('INSERT INTO family (id) VALUES ($1)', [f]);
      await q.run('INSERT INTO parent (id, family_id, email) VALUES ($1, $2, $3)', [`par_${f}`, f, `${f}@example.com`]);
      await q.run('INSERT INTO child (id, family_id, first_name) VALUES ($1, $2, $3)', [`chd_${f}`, f, name]);
      await q.run("INSERT INTO device (id, family_id, platform, name, token_hash) VALUES ($1, $2, 'android', 'Tablet', $3)", [`dev_${f}`, f, `hash_${f}`]);
      await q.run("INSERT INTO app_request (id, family_id, title, description) VALUES ($1, $2, 'T', 'D')", [`req_${f}`, f]);
      await q.run("INSERT INTO audit (family_id, actor, action) VALUES ($1, 'test', 'seeded')", [f]);
    }
    await q.run("INSERT INTO login_token (token_hash, email, expires_at) VALUES ('lt', 'x@example.com', now() + interval '1 hour')");
    await q.run("INSERT INTO device_tombstone (token_hash) VALUES ('tomb')");
  });
});
afterEach(async () => { await db.close(); });

const sqlState = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };
const RLS_VIOLATION = '42501';       // new row violates row-level security policy (and insufficient_privilege)
const INSUFFICIENT_PRIVILEGE = '42501';

describe('row-level security', () => {
  it('every family table has a policy and duckling_app owns nothing', async () => {
    const c = new pg.Client({ connectionString: t.adminUrl }); await c.connect();
    try {
      const rows = (await c.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'duckling' AND c.relkind = 'r'`)).rows;
      const byName = Object.fromEntries(rows.map((r) => [r.relname, r]));
      for (const name of FAMILY_TABLES) {
        expect(byName[name], name).toBeDefined();
        expect(byName[name].relrowsecurity, `${name} has RLS on`).toBe(true);
        expect(byName[name].policies, `${name} has a policy`).toBe(1);
        expect(byName[name].relforcerowsecurity, `${name} has no FORCE (see section 5)`).toBe(false);
      }
      for (const r of rows) expect(r.owner, `${r.relname} owner`).toBe('duckling_system');
      const fns = (await c.query("SELECT proname, prosecdef, pg_get_userbyid(proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'duckling'")).rows;
      expect(fns.length).toBeGreaterThanOrEqual(7);
      for (const f of fns) { expect(f.prosecdef, `${f.proname} is SECURITY DEFINER`).toBe(true); expect(f.owner).toBe('duckling_system'); }
    } finally { await c.end(); }
  });

  it('with app.family_id set to A, queries with no WHERE return only A\'s rows', async () => {
    await db.family(A, async (q) => {
      expect((await q.all('SELECT id FROM family')).map((r) => r.id)).toEqual([A]);
      expect((await q.all('SELECT first_name FROM child')).map((r) => r.first_name)).toEqual(['Ada']);
      expect((await q.all('SELECT id FROM device')).map((r) => r.id)).toEqual([`dev_${A}`]);
      expect((await q.all('SELECT id FROM app_request')).map((r) => r.id)).toEqual([`req_${A}`]);
      expect((await q.all('SELECT id FROM parent')).map((r) => r.id)).toEqual([`par_${A}`]);
      expect((await q.all('SELECT family_id FROM audit')).map((r) => r.family_id)).toEqual([A]);
      // B's rows are invisible even when asked for by id, and updates and deletes aimed at them touch nothing.
      expect(await q.one('SELECT 1 FROM child WHERE id = $1', [`chd_${B}`])).toBeUndefined();
      expect(await q.run("UPDATE child SET first_name = 'X' WHERE id = $1", [`chd_${B}`])).toBe(0);
      expect(await q.run('DELETE FROM device WHERE id = $1', [`dev_${B}`])).toBe(0);
      expect(await q.run('UPDATE child SET first_name = first_name')).toBe(1);
    });
    expect((await db.system((q) => q.one('SELECT first_name FROM child WHERE id = $1', [`chd_${B}`])))!.first_name).toBe('Ben');
  });

  it('with app.family_id set to A, inserts for family B fail the WITH CHECK', async () => {
    for (const sql of [
      `INSERT INTO child (id, family_id, first_name) VALUES ('chd_new', '${B}', 'Nope')`,
      `INSERT INTO device (id, family_id, platform, name, token_hash) VALUES ('dev_new', '${B}', 'ios', 'iPad', 'h2')`,
      `INSERT INTO device_app (family_id, device_id, app_id) VALUES ('${B}', 'dev_${B}', 'x')`,
      `INSERT INTO setting (family_id, device_id, key, value) VALUES ('${B}', 'dev_${B}', 'k', '1'::jsonb)`,
      `INSERT INTO app_request (id, family_id, title, description) VALUES ('req_new', '${B}', 'T', 'D')`,
      `INSERT INTO session (token_hash, parent_id, family_id, expires_at) VALUES ('s', 'par_${B}', '${B}', now() + interval '1 day')`,
      `INSERT INTO audit (family_id, actor, action) VALUES ('${B}', 'a', 'b')`,
      `INSERT INTO audit (family_id, actor, action) VALUES (NULL, 'a', 'b')`,
      `UPDATE child SET family_id = '${B}' WHERE id = 'chd_${A}'`,
    ]) {
      expect(await sqlState(db.family(A, (q) => q.run(sql))), sql).toBe(RLS_VIOLATION);
    }
    // The same inserts for A itself go through.
    await db.family(A, async (q) => {
      expect(await q.run(`INSERT INTO child (id, family_id, first_name) VALUES ('chd_new', '${A}', 'Yes')`)).toBe(1);
      expect(await q.run(`INSERT INTO audit (family_id, actor, action) VALUES ('${A}', 'a', 'b')`)).toBe(1);
    });
  });

  it('with no app.family_id, family tables return nothing and accept nothing', async () => {
    for (const table of FAMILY_TABLES) {
      expect(await db.app((q) => q.all(`SELECT * FROM ${table}`)), table).toEqual([]);
      expect(await db.query(`SELECT * FROM ${table}`), table).toEqual([]);
    }
    expect(await sqlState(db.app((q) => q.run(`INSERT INTO child (id, family_id, first_name) VALUES ('c', '${A}', 'n')`)))).toBe(RLS_VIOLATION);
    // A family set in one transaction does not leak into the next one on the same pooled connection.
    await db.family(A, (q) => q.all('SELECT 1 FROM child'));
    expect(await db.app((q) => q.all('SELECT * FROM child'))).toEqual([]);
  });

  it('duckling_app cannot read login_token, device_tombstone or webhook_event directly, and cannot write global tables', async () => {
    for (const table of CLOSED_TABLES) {
      expect(await sqlState(db.query(`SELECT * FROM ${table}`)), table).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(db.family(A, (q) => q.all(`SELECT * FROM ${table}`))), table).toBe(INSUFFICIENT_PRIVILEGE);
    }
    for (const [table, insert] of [
      ['app', "INSERT INTO app (id, name) VALUES ('x', 'X')"],
      ['app_version', "INSERT INTO app_version (app_id, version, package_key, sha256, signature, size) VALUES ('x', '1.0.0', 'k', 's', 'g', 1)"],
      ['voice_clip', "INSERT INTO voice_clip (hash, voice, rate, chars) VALUES ('h', 'v', 0, 1)"],
      ['entitlement', `INSERT INTO entitlement (family_id, status) VALUES ('${A}', 'trial')`],
      ['purchase', `INSERT INTO purchase (id, family_id, source, external_id, product_id, status) VALUES ('p', '${A}', 'stripe', 'e', 'pr', 'active')`],
      ['login_token', "INSERT INTO login_token (token_hash, email, expires_at) VALUES ('t', 'e', now())"],
      ['device_tombstone', "INSERT INTO device_tombstone (token_hash) VALUES ('t')"],
      ['webhook_event', "INSERT INTO webhook_event (source, event_id) VALUES ('s', 'e')"],
    ]) {
      expect(await sqlState(db.family(A, (q) => q.run(insert))), table).toBe(INSUFFICIENT_PRIVILEGE);
    }
    for (const table of READ_ONLY_TABLES) expect(await sqlState(db.query(`SELECT * FROM ${table}`)), table).toBeNull();
    // The tombstone and login token are still reachable through their functions.
    expect((await db.query('SELECT released FROM auth_device($1)', ['tomb']))[0].released).toBe(true);
    expect((await db.query('SELECT email FROM redeem_login_token($1)', ['lt']))[0].email).toBe('x@example.com');
    expect(await db.query('SELECT email FROM redeem_login_token($1)', ['lt'])).toEqual([]);
  });

  it('the owner role sees everything, which is why only db.system() connects as it', async () => {
    expect((await db.system((q) => q.all('SELECT id FROM family ORDER BY id'))).map((r) => r.id)).toEqual([A, B]);
  });
});
