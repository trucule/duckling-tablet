// The Windows installers. You publish a signed MSI per architecture (tools/windows-release.mjs on the droplet, or
// windows/Publish-Release.ps1 from your PC); every Windows tablet's service asks for the newest once a day and on
// start, checks the file's SHA-256 and its Authenticode signer itself, and installs it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { adminAuth } from '../auth.js';
import { badRequest, notFound, sha256 } from '../util.js';
import { compareVersions } from '../catalog.js';

const arch = z.enum(['x64', 'arm64']);
const version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/);
type Row = { version: string; arch: string; file_key: string; sha256: string; size: string; published_at: string };

export default async function windowsRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const shape = (r: Row) => ({ version: r.version, arch: r.arch, url: ctx.storage.publicUrl(r.file_key), sha256: r.sha256, size: Number(r.size), publishedAt: r.published_at });
  const newest = (a: string) => ctx.db.system(async (q) => {
    const rows = await q.all<Row>('SELECT * FROM windows_release WHERE arch = $1', [a]);
    return rows.sort((x, y) => compareVersions(y.version, x.version))[0] ?? null;
  });

  // Public: the newest installer for an architecture, or both.
  app.get('/windows/release', async (req) => {
    const qs = z.object({ arch: arch.optional() }).parse(req.query);
    if (qs.arch) { const r = await newest(qs.arch); if (!r) throw notFound('No Windows release yet'); return shape(r); }
    const out: Record<string, unknown> = {};
    for (const a of arch.options) { const r = await newest(a); if (r) out[a] = shape(r); }
    return out;
  });

  // Admin: the signed MSI as the body. Query: version, arch.
  app.register(async (up) => {
    up.addContentTypeParser(['application/x-msi', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 300 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    up.post('/admin/windows/releases', async (req) => {
      adminAuth(ctx, req);
      const qs = z.object({ version, arch }).parse(req.query);
      const body = req.body as Buffer;
      // An MSI is an OLE compound file: D0 CF 11 E0 A1 B1 1A E1.
      if (!Buffer.isBuffer(body) || body.length < 4096 || body.readUInt32BE(0) !== 0xd0cf11e0) throw badRequest('Send the signed MSI as the request body');
      const latest = await newest(qs.arch);
      if (latest && compareVersions(qs.version, latest.version) <= 0) throw badRequest(`Version must be above ${latest.version}`);
      const key = `windows/DucklingTablet-${qs.version}-${qs.arch}.msi`;
      await ctx.storage.put(key, body, 'application/x-msi', true);
      const row = await ctx.db.system(async (q) => {
        await q.run('INSERT INTO windows_release (version, arch, file_key, sha256, size) VALUES ($1, $2, $3, $4, $5)', [qs.version, qs.arch, key, sha256(body), body.length]);
        return q.one<Row>('SELECT * FROM windows_release WHERE arch = $1 AND version = $2', [qs.arch, qs.version]);
      });
      return shape(row!);
    });
  });
}
