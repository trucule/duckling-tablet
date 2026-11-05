// The CA file must reach pg even when the URL says sslmode=require (pg lets the parsed URL override an explicit ssl
// option, which is how the first deploy failed with "self-signed certificate in certificate chain").
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import pg from 'pg';
import { pgConfig } from '../src/pgconfig.js';

describe('pgConfig', () => {
  it('splits the URL into fields and decides TLS itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgcfg-'));
    const caPath = join(dir, 'ca.crt');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    try {
      const c = pgConfig('postgresql://duckling_app:p%40ss@private-host.db.ondigitalocean.com:25060/duckling?sslmode=require', caPath);
      expect(c).toMatchObject({ host: 'private-host.db.ondigitalocean.com', port: 25060, user: 'duckling_app', password: 'p@ss', database: 'duckling' });
      expect((c.ssl as { ca: string; rejectUnauthorized: boolean }).ca).toContain('BEGIN CERTIFICATE');
      expect((c.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
      expect((c as { connectionString?: string }).connectionString).toBeUndefined();

      expect(pgConfig('postgresql://u:p@127.0.0.1:5432/t').ssl).toBeUndefined();
      expect(pgConfig('postgresql://u:p@db:25060/t?sslmode=require').ssl).toEqual({ rejectUnauthorized: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('pg verifies the server against the given CA, with sslmode=require in the URL', async () => {
    // A throwaway CA signs a server certificate for localhost. The fake server speaks just enough PostgreSQL to reach
    // TLS: it answers the 8-byte SSLRequest with 'S' and then upgrades the socket. Which trust store pg used shows in
    // the outcome: with our CA the handshake completes (and the connection then fails on the protocol, not on the
    // certificate); without it, the handshake itself fails.
    const dir = mkdtempSync(join(tmpdir(), 'pgtls-'));
    const sh = (cmd: string) => execFileSync('sh', ['-c', cmd], { cwd: dir, stdio: 'pipe' });
    try {
      sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj "/CN=Test Project CA" -days 2 2>/dev/null');
      sh('openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj "/CN=localhost" 2>/dev/null');
      sh('printf "subjectAltName=DNS:localhost,IP:127.0.0.1" > ext.cnf && openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out srv.crt -days 2 -extfile ext.cnf 2>/dev/null');
      const { readFileSync } = await import('node:fs');
      const tlsOpts = { key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.crt')) };
      const server = createServer((sock) => {
        sock.once('data', (d) => {
          if (d.length === 8 && d.readUInt32BE(4) === 80877103) { // SSLRequest
            sock.write('S');
            const tls = new TLSSocket(sock, { isServer: true, ...tlsOpts });
            tls.on('error', () => {});
            tls.once('data', () => tls.end()); // the startup message: we are not a real server, so hang up
          } else { sock.end(); }
        });
        sock.on('error', () => {});
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      const url = `postgresql://u:p@localhost:${port}/t?sslmode=require`;


      const attempt = async (cfg: pg.ClientConfig) => {
        const c = new pg.Client({ ...cfg, connectionTimeoutMillis: 3000 });
        try { await c.connect(); return 'connected'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } finally { await c.end().catch(() => {}); }
      };
      // Without the CA: certificate failure. With it (through pgConfig, sslmode still in the URL): past the
      // certificate, failing only because the fake server is not PostgreSQL.
      expect(await attempt(pgConfig(url))).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
      const withCa = await attempt(pgConfig(url, join(dir, 'ca.crt')));
      expect(withCa).not.toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
      // And the broken way (connectionString plus ssl) is what we moved away from: the URL wins and the CA is lost.
      expect(await attempt({ connectionString: url, ssl: { ca: readFileSync(join(dir, 'ca.crt'), 'utf8'), rejectUnauthorized: true } })).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
      server.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
