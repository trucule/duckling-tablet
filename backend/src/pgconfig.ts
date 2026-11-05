// Turns a DATABASE_URL into a pg config with TLS settled here, not by the URL. pg merges a parsed connectionString
// over the explicit options, so "sslmode=require" in the URL would replace an explicit ssl: { ca } and the
// DigitalOcean CA would never be used ("self-signed certificate in certificate chain"). We parse the URL, take the
// host, port, user, password and database from it, and decide TLS ourselves:
// - a CA file given: verify the server against that CA (DigitalOcean managed databases);
// - no CA but sslmode in the URL: verify against the system store (fails for DigitalOcean, on purpose);
// - neither: plain TCP (local development and tests).
import { readFileSync } from 'node:fs';
import { parse } from 'pg-connection-string';
import type { ClientConfig } from 'pg';

export function pgConfig(url: string, caCert?: string): ClientConfig {
  const p = parse(url);
  const wantsTls = !!caCert || /[?&]sslmode=/.test(url);
  const ssl = wantsTls ? { rejectUnauthorized: true, ...(caCert ? { ca: readFileSync(caCert, 'utf8') } : {}) } : undefined;
  return {
    host: p.host ?? undefined,
    port: p.port ? Number(p.port) : undefined,
    user: p.user,
    password: p.password,
    database: p.database ?? undefined,
    ssl,
  };
}
