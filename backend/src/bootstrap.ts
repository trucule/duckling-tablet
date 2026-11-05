// One-time database bootstrap, run as DigitalOcean's doadmin (DATABASE_URL_ADMIN): creates the two roles with fresh
// passwords, the schema they work in, and their search_path. With --write <env file> it puts the two connection
// strings into that file (replacing earlier DATABASE_URL_APP and DATABASE_URL_SYSTEM lines) and prints nothing
// secret; without it, it prints them. Running it again rotates both passwords (then restart the service).
//
//   DATABASE_URL_ADMIN='postgresql://doadmin:...@host:25060/duckling?sslmode=require' \
//     DOTENV_CONFIG_PATH=/opt/duckling/.env node dist/bootstrap.js --write /opt/duckling/.env
//
// DATABASE_CA_CERT comes from the env file (dotenv) or the environment.
// The tests call bootstrap() against an embedded PostgreSQL with the superuser standing in for doadmin.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
  const lines = {
    DATABASE_URL_SYSTEM: connectionUrl(adminUrl, 'duckling_system', systemPassword),
    DATABASE_URL_APP: connectionUrl(adminUrl, 'duckling_app', appPassword),
  };
  const writeIdx = process.argv.indexOf('--write');
  if (writeIdx > 0 && process.argv[writeIdx + 1]) {
    const file = process.argv[writeIdx + 1];
    let env = readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(lines)) {
      const re = new RegExp(`^${k}=.*$`, 'm');
      env = re.test(env) ? env.replace(re, () => `${k}=${v}`) : `${env.replace(/\n?$/, '\n')}${k}=${v}\n`;
    }
    writeFileSync(file, env);
    console.log(`Roles duckling_system and duckling_app are set up; DATABASE_URL_SYSTEM and DATABASE_URL_APP written to ${file}.`);
  } else {
    console.log('# Add these to /opt/duckling/.env, then run the migrations and restart duckling-api:');
    for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  }
}
