// Your admin calls: publish app versions, pre-generate their voice lines, see requests. Bearer ADMIN_TOKEN.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { adminAuth } from '../auth.js';
import { compareVersions } from '../catalog.js';
import { requestRow } from './requests.js';
import type { makeVoiceCache } from './tts.js';
import { badRequest, notFound, now, sha256 } from '../util.js';
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
    ctx.db.prepare(`INSERT INTO app (id, name, description, subjects, age_min, age_max, starter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, subjects = excluded.subjects,
      age_min = excluded.age_min, age_max = excluded.age_max, starter = excluded.starter`)
      .run(id, b.name, b.description, JSON.stringify(b.subjects), b.ageMin, b.ageMax, b.starter ? 1 : 0, now());
    return { id };
  });

  // Body: the signed package zip (application/zip). Query: version, signature (base64 Ed25519 over the zip, made on
  // your machine), minShell, permissions (comma list), request (an app request this version fulfils).
  app.register(async (up) => {
    up.addContentTypeParser(['application/zip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 },
      (_req, body, done) => done(null, body));
    up.post<{ Params: { id: string } }>('/admin/apps/:id/versions', async (req) => {
      const id = appId.parse(req.params.id);
      if (!ctx.db.prepare('SELECT 1 FROM app WHERE id = ?').get(id)) throw notFound('Create the app first (PUT /admin/apps/:id)');
      const qs = z.object({
        version, signature: z.string().min(40).max(200), minShell: z.string().max(20).optional(),
        permissions: z.string().optional(), request: z.string().optional(),
      }).parse(req.query);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length < 22) throw badRequest('Send the package zip as the request body');
      if (ctx.db.prepare('SELECT 1 FROM app_version WHERE app_id = ? AND version = ?').get(id, qs.version)) throw badRequest('That version is already published');
      const latest = (ctx.db.prepare('SELECT version FROM app_version WHERE app_id = ?').all(id) as any[]).map((r) => r.version).sort(compareVersions).pop();
      if (latest && compareVersions(qs.version, latest) <= 0) throw badRequest(`Version must be above ${latest}`);
      const key = `packages/${id}/${qs.version}.zip`;
      await ctx.storage.put(key, body, 'application/zip', true);
      const perms = (qs.permissions ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      ctx.db.prepare(`INSERT INTO app_version (app_id, version, package_key, sha256, signature, size, min_shell, permissions, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, qs.version, key, sha256(body), qs.signature, body.length, qs.minShell ?? null, JSON.stringify(perms), now());

      // A version that fulfils a request: mark it shipped and install it where the family asked for that.
      let installedFor = 0;
      if (qs.request) {
        const r = ctx.db.prepare('SELECT * FROM app_request WHERE id = ?').get(qs.request) as any;
        if (!r) throw notFound('No such request');
        ctx.db.prepare("UPDATE app_request SET status = 'shipped', app_id = ?, updated_at = ? WHERE id = ?").run(id, now(), r.id);
        if (r.install_when_ready) {
          const devices = ctx.db.prepare("SELECT id FROM device WHERE family_id = ? AND state = 'active'").all(r.family_id) as any[];
          const ins = ctx.db.prepare('INSERT OR IGNORE INTO device_app (device_id, app_id, installed_at) VALUES (?, ?, ?)');
          for (const d of devices) installedFor += ins.run(d.id, id, now()).changes;
        }
        ctx.audit(r.family_id, 'admin', 'request.shipped', { request: r.id, app: id });
      }
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

  app.get('/admin/requests', async () => ({
    requests: (ctx.db.prepare('SELECT * FROM app_request ORDER BY created_at DESC LIMIT 200').all() as any[]).map((r) => ({ ...requestRow(r), familyId: r.family_id, ticket: r.etducky_ticket_id })),
  }));

  app.get('/admin/stats', async () => ({
    families: (ctx.db.prepare('SELECT COUNT(*) n FROM family').get() as any).n,
    devices: ctx.db.prepare("SELECT platform, COUNT(*) n FROM device WHERE state = 'active' GROUP BY platform").all(),
    apps: (ctx.db.prepare('SELECT COUNT(*) n FROM app').get() as any).n,
    voiceClips: (ctx.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(hits), 0) hits FROM voice_clip').get() as any),
    openRequests: (ctx.db.prepare("SELECT COUNT(*) n FROM app_request WHERE status IN ('requested','planned','building')").get() as any).n,
  }));
}
