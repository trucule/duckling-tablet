// Your admin calls: publish app versions, pre-generate their voice lines, see requests. Bearer ADMIN_TOKEN.
// Everything here is system work (the catalog is global and publishing touches every family), so it runs as
// duckling_system through ctx.db.system().
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { adminAuth } from '../auth.js';
import { compareVersions } from '../catalog.js';
import { requestRow } from './requests.js';
import type { makeVoiceCache } from './tts.js';
import { badRequest, notFound, sha256 } from '../util.js';
import { normalizeLine } from './tts.js';

const appId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);

export default async function adminRoutes(app: FastifyInstance, { ctx, voice }: { ctx: Ctx; voice: ReturnType<typeof makeVoiceCache> }) {
  app.addHook('onRequest', async (req) => adminAuth(ctx, req));

  app.put<{ Params: { id: string } }>('/admin/apps/:id', async (req) => {
    const id = appId.parse(req.params.id);
    const b = z.object({
      name: z.string().min(1).max(60), description: z.string().max(500).default(''),
      subjects: z.array(z.string().max(20)).max(6).default([]), ageMin: z.number().int().min(2).max(14).nullable().default(null),
      ageMax: z.number().int().min(2).max(14).nullable().default(null), starter: z.boolean().default(false),
    }).parse(req.body);
    await ctx.db.system((q) => q.run(`INSERT INTO app (id, name, description, subjects, age_min, age_max, starter) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, subjects = excluded.subjects,
      age_min = excluded.age_min, age_max = excluded.age_max, starter = excluded.starter`,
      [id, b.name, b.description, JSON.stringify(b.subjects), b.ageMin, b.ageMax, b.starter]));
    return { id };
  });

  // Body: the app's tile, a PNG (image/png), 512 by 512. Stored under a content-hashed key (the CDN caches files as
  // immutable) and shown in the catalog.
  app.register(async (up) => {
    up.addContentTypeParser('image/png', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    up.put<{ Params: { id: string } }>('/admin/apps/:id/tile', async (req) => {
      const id = appId.parse(req.params.id);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw badRequest('Send a PNG as the request body');
      await ctx.db.system(async (q) => {
        if (!(await q.one('SELECT 1 FROM app WHERE id = $1', [id]))) throw notFound('Create the app first (PUT /admin/apps/:id)');
      });
      const key = `tiles/${id}-${sha256(body).slice(0, 12)}.png`;
      await ctx.storage.put(key, body, 'image/png', true);
      await ctx.db.system((q) => q.run('UPDATE app SET tile_key = $1 WHERE id = $2', [key, id]));
      return { id, tileUrl: ctx.storage.publicUrl(key) };
    });
  });

  // Body: the signed package zip (application/zip). Query: version, signature (base64 Ed25519 over the zip, made on
  // your machine), minShell, permissions (comma list), request (an app request this version fulfils).
  app.register(async (up) => {
    up.addContentTypeParser(['application/zip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 },
      (_req, body, done) => done(null, body));
    up.post<{ Params: { id: string } }>('/admin/apps/:id/versions', async (req) => {
      const id = appId.parse(req.params.id);
      const qs = z.object({
        version, signature: z.string().min(40).max(200), minShell: z.string().max(20).optional(),
        permissions: z.string().optional(), request: z.string().optional(),
      }).parse(req.query);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 22) throw badRequest('Send the package zip as the request body');

      await ctx.db.system(async (q) => {
        if (!(await q.one('SELECT 1 FROM app WHERE id = $1', [id]))) throw notFound('Create the app first (PUT /admin/apps/:id)');
        const versions = (await q.all('SELECT version FROM app_version WHERE app_id = $1', [id])).map((r) => r.version as string);
        if (versions.includes(qs.version)) throw badRequest('That version is already published');
        const latest = versions.sort(compareVersions).pop();
        if (latest && compareVersions(qs.version, latest) <= 0) throw badRequest(`Version must be above ${latest}`);
        if (qs.request && !(await q.one('SELECT 1 FROM app_request WHERE id = $1', [qs.request]))) throw notFound('No such request');
      });

      // The upload happens outside any transaction; the insert below is what publishes the version.
      const key = `packages/${id}/${qs.version}.zip`;
      await ctx.storage.put(key, body, 'application/zip', true);
      const perms = (qs.permissions ?? '').split(',').map((s) => s.trim()).filter(Boolean);

      const installedFor = await ctx.db.system(async (q) => {
        await q.run(`INSERT INTO app_version (app_id, version, package_key, sha256, signature, size, min_shell, permissions)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`, [id, qs.version, key, sha256(body), qs.signature, body.length, qs.minShell ?? null, JSON.stringify(perms)]);
        // A version that fulfils a request: mark it shipped and install it where the family asked for that.
        let installed = 0;
        if (qs.request) {
          const r = await q.one('SELECT * FROM app_request WHERE id = $1', [qs.request]);
          if (!r) throw notFound('No such request');
          await q.run("UPDATE app_request SET status = 'shipped', app_id = $1, updated_at = now() WHERE id = $2", [id, r.id]);
          if (r.install_when_ready) {
            installed = await q.run(`INSERT INTO device_app (family_id, device_id, app_id)
              SELECT family_id, id, $1 FROM device WHERE family_id = $2 AND state = 'active' ON CONFLICT DO NOTHING`, [id, r.family_id]);
          }
          await audit(q, r.family_id, 'admin', 'request.shipped', { request: r.id, app: id });
        }
        return installed;
      });
      return { app: id, version: qs.version, url: ctx.storage.publicUrl(key), size: body.length, installedFor };
    });
  });

  // Pre-generate every fixed line of an app (its phrases.json) into the shared voice cache.
  app.post('/admin/voice/pregenerate', async (req) => {
    const b = z.object({
      lines: z.array(z.object({ text: z.string().min(1).max(1000), voice: z.string().optional(), rate: z.number().int().min(-50).max(100).default(0) })).max(5000),
    }).parse(req.body);
    let created = 0, cached = 0, failed = 0;
    for (const l of b.lines) {
      const r = await voice.ensure(normalizeLine(l.text), l.voice ?? ctx.cfg.NARRATOR_VOICE, l.rate);
      if (!r) failed++; else if (r.created) created++; else cached++;
    }
    return { created, cached, failed };
  });

  app.get('/admin/requests', async () => ctx.db.system(async (q) => ({
    requests: (await q.all('SELECT * FROM app_request ORDER BY created_at DESC LIMIT 200')).map((r) => ({ ...requestRow(r), familyId: r.family_id, ticket: r.etducky_ticket_id })),
  })));

  app.get('/admin/stats', async () => ctx.db.system(async (q) => ({
    families: (await q.one('SELECT COUNT(*)::int AS n FROM family'))!.n,
    devices: await q.all("SELECT platform, COUNT(*)::int AS n FROM device WHERE state = 'active' GROUP BY platform ORDER BY platform"),
    apps: (await q.one('SELECT COUNT(*)::int AS n FROM app'))!.n,
    voiceClips: await q.one('SELECT COUNT(*)::int AS n, COALESCE(SUM(hits), 0)::int AS hits FROM voice_clip'),
    aiToday: await q.all("SELECT app_id AS \"appId\", SUM(calls)::int AS calls, SUM(input_tokens)::int AS \"inputTokens\", SUM(output_tokens)::int AS \"outputTokens\" FROM ai_usage WHERE day = CURRENT_DATE GROUP BY app_id ORDER BY app_id"),
    openRequests: (await q.one("SELECT COUNT(*)::int AS n FROM app_request WHERE status IN ('requested', 'planned', 'building')"))!.n,
  })));
}
