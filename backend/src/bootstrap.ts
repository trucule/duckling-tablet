// One-time database bootstrap, run as DigitalOcean's doadmin (DATABASE_URL_ADMIN): creates the two roles with fresh
// passwords, the schema they work in, and their search_path. Prints the two connection strings for /opt/duckling/.env;
// nothing is written anywhere else. Running it again rotates both passwords (print, then restart the service).
//
//   DATABASE_URL_ADMIN='postgresql://doadmin:...@host:25060/duckling?sslmode=require' DATABASE_CA_CERT=/opt/duckling/ca.crt \
//     node dist/bootstrap.js
//
// The tests call bootstrap() against an embedded PostgreSQL with the superuser standing in for doadmin.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg, { type Client } from 'pg';

export interface BootstrapOptions { systemPassword: string; appPassword: string }

export async function bootstrap(client: Client, opts: BootstrapOptions): Promise<void> {
  const lit = (s: string) => client.escapeLiteral(s);
  const admin = (await client.query('SELECT current_user AS u')).rows[0].u as string;
  const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('duckling_system', 'duckling_app')")).rows.map((r) => r.rolname as string);

  for (const [role, pw] of [['duckling_system', opts.systemPassword], ['duckling_app', opts.appPassword]] as const) {
    if (roles.includes(role)) await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${lit(pw)}`);
    else await client.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${lit(pw)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  }
  // The admin must be a member of the owner role to create a schema owned by it (doadmin is not a superuser).
  await client.query(`GRANT duckling_system TO ${pg.escapeIdentifier(admin)}`);
  await client.query('CREATE SCHEMA IF NOT EXISTS duckling AUTHORIZATION duckling_system');
  await client.query('GRANT USAGE ON SCHEMA duckling TO duckling_app');
  await client.query('ALTER ROLE duckling_system SET search_path = duckling, public');
  await client.query('ALTER ROLE duckling_app SET search_path = duckling, public');
}

const newPassword = () => randomBytes(24).toString('base64url');

export function connectionUrl(adminUrl: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return u.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminUrl) { console.error('Set DATABASE_URL_ADMIN to the doadmin connection string.'); process.exit(2); }
  const ca = process.env.DATABASE_CA_CERT;
  const client = new pg.Client({ connectionString: adminUrl, ssl: ca ? { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } : undefined });
  await client.connect();
  const systemPassword = newPassword(), appPassword = newPassword();
  await bootstrap(client, { systemPassword, appPassword });
  await client.end();
  console.log('# Add these to /opt/duckling/.env, then run the migrations and restart duckling-api:');
  console.log(`DATABASE_URL_SYSTEM=${connectionUrl(adminUrl, 'duckling_system', systemPassword)}`);
  console.log(`DATABASE_URL_APP=${connectionUrl(adminUrl, 'duckling_app', appPassword)}`);
}
