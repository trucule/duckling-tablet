// Devices: pairing, parent controls per device, and the device's own check-in, config and installs.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceAuth, parentAuth } from '../auth.js';
import { childRow } from './family.js';
import { listCatalog } from '../catalog.js';
import { HttpError, badRequest, forbidden, hashToken, inMinutes, newId, newToken, notFound, now, pairingCode } from '../util.js';

// A host pattern: example.org (subdomains included) or *.example.org.
const host = z.string().trim().toLowerCase().regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, 'Use a site name like pbskids.org');
const allowEntry = z.object({ host, tile: z.object({ name: z.string().max(40), url: z.string().url(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional() });
const limits = z.object({ dailyMinutes: z.number().int().min(0).max(1440).nullable(), bedtime: z.object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) }).nullable() }).partial();

function getSetting<T>(ctx: Ctx, deviceId: string, key: string, fallback: T): T {
  const r = ctx.db.prepare('SELECT value FROM setting WHERE device_id = ? AND key = ?').get(deviceId, key) as { value: string } | undefined;
  return r ? JSON.parse(r.value) : fallback;
}
function setSetting(ctx: Ctx, deviceId: string, key: string, value: unknown) {
  ctx.db.prepare('INSERT INTO setting (device_id, key, value) VALUES (?, ?, ?) ON CONFLICT (device_id, key) DO UPDATE SET value = excluded.value')
    .run(deviceId, key, JSON.stringify(value));
}

export function deviceConfig(ctx: Ctx, deviceId: string) {
  const d = ctx.db.prepare('SELECT * FROM device WHERE id = ?').get(deviceId) as any;
  const child = d.child_id ? childRow(ctx.db.prepare('SELECT * FROM child WHERE id = ?').get(d.child_id)) : null;
  const installed = new Set((ctx.db.prepare('SELECT app_id FROM device_app WHERE device_id = ?').all(deviceId) as any[]).map((r) => r.app_id));
  const hidden = new Set((ctx.db.prepare('SELECT app_id FROM device_hidden_app WHERE device_id = ?').all(deviceId) as any[]).map((r) => r.app_id));
  const catalog = listCatalog(ctx).filter((a) => !hidden.has(a.id));
  const travelUntil = getSetting<string | null>(ctx, deviceId, 'travel_until', null);
  return {
    deviceId, state: d.state, child,
    apps: catalog.filter((a) => installed.has(a.id)).map((a) => ({ id: a.id, name: a.name, ...a.latest })),
    hidden: [...hidden],
    allowlist: getSetting(ctx, deviceId, 'allowlist', [] as unknown[]),
    travel: { active: !!travelUntil && travelUntil > now(), until: travelUntil },
    limits: getSetting(ctx, deviceId, 'limits', {}),
    narratorVoice: ctx.cfg.NARRATOR_VOICE,
    serverTime: now(),
  };
}

export default async function deviceRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const myDevice = (familyId: string, id: string) => {
    const d = ctx.db.prepare('SELECT * FROM device WHERE id = ? AND family_id = ?').get(id, familyId) as any;
    if (!d) throw notFound('No such device');
    return d;
  };
  const appExists = (id: string) => { if (!ctx.db.prepare('SELECT 1 FROM app WHERE id = ?').get(id)) throw notFound('No such app'); };

  // ---- Pairing: the parent makes a code, the device redeems it for a long-lived device token.
  app.post('/devices/pairing-codes', async (req) => {
    const a = parentAuth(ctx, req);
    const { childId } = z.object({ childId: z.string().nullable().optional() }).parse(req.body ?? {});
    if (childId && !ctx.db.prepare('SELECT 1 FROM child WHERE id = ? AND family_id = ?').get(childId, a.familyId)) throw notFound('No such child');
    let code = pairingCode();
    while (ctx.db.prepare('SELECT 1 FROM pairing_code WHERE code = ? AND used_at IS NULL AND expires_at > ?').get(code, now())) code = pairingCode();
    ctx.db.prepare('INSERT OR REPLACE INTO pairing_code (code, family_id, child_id, expires_at) VALUES (?, ?, ?, ?)').run(code, a.familyId, childId ?? null, inMinutes(15));
    return { code, expiresInMinutes: 15 };
  });

  app.post('/devices/pair', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const b = z.object({
      code: z.string().regex(/^\d{6}$/), platform: z.enum(['android', 'ios', 'windows', 'web']),
      name: z.string().trim().min(1).max(60), shellVersion: z.string().max(30).optional(),
    }).parse(req.body);
    const pc = ctx.db.prepare('SELECT * FROM pairing_code WHERE code = ?').get(b.code) as any;
    if (!pc || pc.used_at || pc.expires_at < now()) throw new HttpError(400, 'That code is not valid. Make a new one in the parent portal.');
    const id = newId('dev'), token = newToken();
    ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE pairing_code SET used_at = ? WHERE code = ?').run(now(), b.code);
      ctx.db.prepare(`INSERT INTO device (id, family_id, child_id, platform, name, token_hash, shell_version, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, pc.family_id, pc.child_id, b.platform, b.name, hashToken(token, ctx.cfg.SESSION_SECRET), b.shellVersion ?? null, now(), now());
      // New devices start with the starter set, so the home screen is not empty on first launch.
      const ins = ctx.db.prepare('INSERT OR IGNORE INTO device_app (device_id, app_id, installed_at) VALUES (?, ?, ?)');
      for (const s of ctx.db.prepare('SELECT id FROM app WHERE starter = 1').all() as any[]) ins.run(id, s.id, now());
    })();
    ctx.audit(pc.family_id, `device:${id}`, 'device.paired', { platform: b.platform, name: b.name });
    return { deviceId: id, deviceToken: token, config: deviceConfig(ctx, id) };
  });

  // ---- Parent controls for a device.
  app.get('/devices', async (req) => {
    const a = parentAuth(ctx, req);
    return { devices: ctx.db.prepare(`SELECT id, child_id AS childId, platform, name, state, shell_version AS shellVersion, battery,
      last_seen_at AS lastSeenAt FROM device WHERE family_id = ? ORDER BY created_at`).all(a.familyId) };
  });

  app.get<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const a = parentAuth(ctx, req); myDevice(a.familyId, req.params.id);
    return deviceConfig(ctx, req.params.id);
  });

  app.put<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id);
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), childId: z.string().nullable().optional() }).parse(req.body);
    if (b.childId && !ctx.db.prepare('SELECT 1 FROM child WHERE id = ? AND family_id = ?').get(b.childId, a.familyId)) throw notFound('No such child');
    ctx.db.prepare('UPDATE device SET name = ?, child_id = ? WHERE id = ?').run(b.name ?? d.name, b.childId === undefined ? d.child_id : b.childId, d.id);
    return deviceConfig(ctx, d.id);
  });

  // Remove from this device (remote): the device releases the lockdown on its next check-in, then uninstalls.
  app.post<{ Params: { id: string } }>('/devices/:id/release', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id);
    ctx.db.prepare("UPDATE device SET state = 'release' WHERE id = ?").run(d.id);
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'device.release', { id: d.id });
    return { state: 'release' };
  });

  app.put<{ Params: { id: string; app: string } }>('/devices/:id/apps/:app', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id); appExists(req.params.app);
    ctx.db.prepare('DELETE FROM device_hidden_app WHERE device_id = ? AND app_id = ?').run(d.id, req.params.app);
    ctx.db.prepare('INSERT OR IGNORE INTO device_app (device_id, app_id, installed_at) VALUES (?, ?, ?)').run(d.id, req.params.app, now());
    return { installed: true };
  });

  app.delete<{ Params: { id: string; app: string } }>('/devices/:id/apps/:app', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id);
    ctx.db.prepare('DELETE FROM device_app WHERE device_id = ? AND app_id = ?').run(d.id, req.params.app);
    return { installed: false };
  });

  // Hide an app from this device's home screen and Store (and uninstall it); unhide brings it back to the Store.
  app.put<{ Params: { id: string; app: string } }>('/devices/:id/hidden/:app', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id); appExists(req.params.app);
    ctx.db.prepare('INSERT OR IGNORE INTO device_hidden_app (device_id, app_id) VALUES (?, ?)').run(d.id, req.params.app);
    ctx.db.prepare('DELETE FROM device_app WHERE device_id = ? AND app_id = ?').run(d.id, req.params.app);
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'app.hidden', { device: d.id, app: req.params.app });
    return { hidden: true };
  });
  app.delete<{ Params: { id: string; app: string } }>('/devices/:id/hidden/:app', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id);
    ctx.db.prepare('DELETE FROM device_hidden_app WHERE device_id = ? AND app_id = ?').run(d.id, req.params.app);
    return { hidden: false };
  });

  app.put<{ Params: { id: string } }>('/devices/:id/settings', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id);
    const b = z.object({ allowlist: z.array(allowEntry).max(200).optional(), limits: limits.optional() }).parse(req.body);
    if (b.allowlist) setSetting(ctx, d.id, 'allowlist', b.allowlist);
    if (b.limits) setSetting(ctx, d.id, 'limits', { ...getSetting(ctx, d.id, 'limits', {}), ...b.limits });
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'settings.updated', { device: d.id, keys: Object.keys(b) });
    return deviceConfig(ctx, d.id);
  });

  // Travel mode: lifts the website allowlist for N hours (default 6); 0 ends it now.
  app.post<{ Params: { id: string } }>('/devices/:id/travel', async (req) => {
    const a = parentAuth(ctx, req); const d = myDevice(a.familyId, req.params.id);
    const { hours } = z.object({ hours: z.number().int().min(0).max(48).default(6) }).parse(req.body ?? {});
    setSetting(ctx, d.id, 'travel_until', hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null);
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'travel.set', { device: d.id, hours });
    return deviceConfig(ctx, d.id).travel;
  });

  // ---- The device itself.
  app.post('/device/checkin', async (req) => {
    const dv = deviceAuth(ctx, req);
    const b = z.object({ shellVersion: z.string().max(30).optional(), battery: z.number().int().min(0).max(100).optional(), pushToken: z.string().max(4096).optional() }).parse(req.body ?? {});
    ctx.db.prepare(`UPDATE device SET shell_version = COALESCE(?, shell_version), battery = COALESCE(?, battery),
      push_token = COALESCE(?, push_token), last_seen_at = ? WHERE id = ?`).run(b.shellVersion ?? null, b.battery ?? null, b.pushToken ?? null, now(), dv.deviceId);
    return deviceConfig(ctx, dv.deviceId);
  });

  app.get('/device/config', async (req) => deviceConfig(ctx, deviceAuth(ctx, req).deviceId));

  // The child installs and uninstalls freely (no PIN); apps a parent hid stay unavailable.
  app.put<{ Params: { app: string } }>('/device/apps/:app', async (req) => {
    const dv = deviceAuth(ctx, req); appExists(req.params.app);
    if (dv.state !== 'active') throw badRequest('This device is being removed');
    if (ctx.db.prepare('SELECT 1 FROM device_hidden_app WHERE device_id = ? AND app_id = ?').get(dv.deviceId, req.params.app)) throw forbidden('A parent turned this app off');
    ctx.db.prepare('INSERT OR IGNORE INTO device_app (device_id, app_id, installed_at) VALUES (?, ?, ?)').run(dv.deviceId, req.params.app, now());
    return { installed: true };
  });
  app.delete<{ Params: { app: string } }>('/device/apps/:app', async (req) => {
    const dv = deviceAuth(ctx, req);
    ctx.db.prepare('DELETE FROM device_app WHERE device_id = ? AND app_id = ?').run(dv.deviceId, req.params.app);
    return { installed: false };
  });

  // Remove from this device (on the tablet, behind the parent PIN): the shell has already released the lockdown.
  app.post('/device/released', async (req) => {
    const dv = deviceAuth(ctx, req);
    ctx.db.prepare("UPDATE device SET state = 'released' WHERE id = ?").run(dv.deviceId);
    ctx.audit(dv.familyId, `device:${dv.deviceId}`, 'device.released');
    return { state: 'released' };
  });
}
