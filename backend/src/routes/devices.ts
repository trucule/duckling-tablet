// Devices: pairing, parent controls per device, and the device's own check-in, config and installs.
// Every handler runs inside one family-scoped transaction, so a query that forgets a WHERE still sees one family.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import type { Q } from '../db.js';
import { deviceAuth, parentAuth } from '../auth.js';
import { childRow } from './family.js';
import { listCatalog } from '../catalog.js';
import { after } from '../notify.js';
import { HttpError, badRequest, forbidden, hashToken, inMinutes, newId, newToken, notFound, now, pairingCode, safeEqual, sha256 } from '../util.js';

// A host pattern: example.org (subdomains included) or *.example.org.
const host = z.string().trim().toLowerCase().regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, 'Use a site name like pbskids.org');
const allowEntry = z.object({ host, tile: z.object({ name: z.string().max(40), url: z.string().url(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional() });
const limits = z.object({ dailyMinutes: z.number().int().min(0).max(1440).nullable(), bedtime: z.object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) }).nullable() }).partial();

const DEVICE_COLUMNS = `id, child_id AS "childId", platform, name, state, shell_version AS "shellVersion", battery, last_seen_at AS "lastSeenAt"`;

async function getSetting<T>(q: Q, deviceId: string, key: string, fallback: T): Promise<T> {
  const r = await q.one<{ value: T }>('SELECT value FROM setting WHERE device_id = $1 AND key = $2', [deviceId, key]);
  return r ? r.value : fallback;
}
async function setSetting(q: Q, familyId: string, deviceId: string, key: string, value: unknown): Promise<void> {
  await q.run(`INSERT INTO setting (family_id, device_id, key, value) VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (device_id, key) DO UPDATE SET value = excluded.value`, [familyId, deviceId, key, JSON.stringify(value ?? null)]);
}

export async function deviceConfig(ctx: Ctx, q: Q, deviceId: string) {
  const d = await q.one('SELECT * FROM device WHERE id = $1', [deviceId]);
  if (!d) throw notFound('No such device');
  const child = d.child_id ? childRow(await q.one('SELECT * FROM child WHERE id = $1', [d.child_id])) : null;
  const installed = new Set((await q.all('SELECT app_id FROM device_app WHERE device_id = $1', [deviceId])).map((r) => r.app_id as string));
  const hidden = new Set((await q.all('SELECT app_id FROM device_hidden_app WHERE device_id = $1', [deviceId])).map((r) => r.app_id as string));
  const catalog = (await listCatalog(ctx, q)).filter((a) => !hidden.has(a.id));
  const travelUntil = await getSetting<string | null>(q, deviceId, 'travel_until', null);
  const fam = await q.one<{ pin_sync: string | null }>('SELECT pin_sync FROM family WHERE id = $1', [d.family_id]);
  return {
    deviceId, state: d.state, child,
    // SHA-256 of "duckling:<pin>", the form the shells keep; null until a parent sets a PIN.
    pinHash: fam?.pin_sync ?? null,
    apps: catalog.filter((a) => installed.has(a.id)).map((a) => ({ id: a.id, name: a.name, tileUrl: a.tileUrl, permissions: a.latest!.permissions, ...a.latest })),
    hidden: [...hidden],
    allowlist: await getSetting(q, deviceId, 'allowlist', [] as unknown[]),
    travel: { active: !!travelUntil && travelUntil > now(), until: travelUntil },
    limits: await getSetting(q, deviceId, 'limits', {}),
    narratorVoice: ctx.cfg.NARRATOR_VOICE,
    serverTime: now(),
  };
}

export default async function deviceRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const myDevice = async (q: Q, id: string) => {
    const d = await q.one('SELECT * FROM device WHERE id = $1', [id]);
    if (!d) throw notFound('No such device');
    return d;
  };
  const appExists = async (q: Q, id: string) => { if (!(await q.one('SELECT 1 FROM app WHERE id = $1', [id]))) throw notFound('No such app'); };
  const myChild = async (q: Q, id: string) => { if (!(await q.one('SELECT 1 FROM child WHERE id = $1', [id]))) throw notFound('No such child'); };

  // ---- Pairing: the parent makes a code, the device redeems it for a long-lived device token.
  app.post('/devices/pairing-codes', async (req) => {
    const a = await parentAuth(ctx, req);
    const { childId } = z.object({ childId: z.string().nullable().optional() }).parse(req.body ?? {});
    return ctx.db.family(a.familyId, async (q) => {
      if (childId) await myChild(q, childId);
      // Codes are global (a device redeems one with no family yet), so a clash with another family's live code retries.
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = pairingCode();
        const r = await q.one<{ ok: boolean }>('SELECT create_pairing_code($1, $2, $3) AS ok', [code, childId ?? null, inMinutes(15)]);
        if (r?.ok) return { code, expiresInMinutes: 15 };
      }
      throw new HttpError(503, 'Could not make a code; try again');
    });
  });

  app.post('/devices/pair', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const b = z.object({
      code: z.string().regex(/^\d{6}$/), platform: z.enum(['android', 'ios', 'windows', 'web']),
      name: z.string().trim().min(1).max(60), shellVersion: z.string().max(30).optional(),
    }).parse(req.body);
    const id = newId('dev'), token = newToken();
    return ctx.db.app(async (q) => {
      const pc = await q.one<{ family_id: string; child_id: string | null }>('SELECT family_id, child_id FROM redeem_pairing_code($1)', [b.code]);
      if (!pc) throw new HttpError(400, 'That code is not valid. Make a new one in the parent portal.');
      await q.setFamily(pc.family_id);
      await q.run(`INSERT INTO device (id, family_id, child_id, platform, name, token_hash, shell_version, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())`, [id, pc.family_id, pc.child_id, b.platform, b.name, hashToken(token, ctx.cfg.SESSION_SECRET), b.shellVersion ?? null]);
      // New devices start with the starter set, so the home screen is not empty on first launch.
      await q.run('INSERT INTO device_app (family_id, device_id, app_id) SELECT $1, $2, id FROM app WHERE starter ON CONFLICT DO NOTHING', [pc.family_id, id]);
      await audit(q, pc.family_id, `device:${id}`, 'device.paired', { platform: b.platform, name: b.name });
      return { deviceId: id, deviceToken: token, config: await deviceConfig(ctx, q, id) };
    });
  });

  // ---- Parent controls for a device.
  app.get('/devices', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => ({ devices: await q.all(`SELECT ${DEVICE_COLUMNS} FROM device ORDER BY created_at`) }));
  });

  app.get<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => { await myDevice(q, req.params.id); return deviceConfig(ctx, q, req.params.id); });
  });

  app.put<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), childId: z.string().nullable().optional() }).parse(req.body);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      if (b.childId) await myChild(q, b.childId);
      await q.run('UPDATE device SET name = $1, child_id = $2 WHERE id = $3', [b.name ?? d.name, b.childId === undefined ? d.child_id : b.childId, d.id]);
      return deviceConfig(ctx, q, d.id);
    }));
  });

  // Remove from this device (remote): the device releases the lockdown on its next check-in, then uninstalls.
  app.post<{ Params: { id: string } }>('/devices/:id/release', async (req) => {
    const a = await parentAuth(ctx, req);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      await q.run("UPDATE device SET state = 'release' WHERE id = $1", [d.id]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'device.release', { id: d.id });
      return { state: 'release' };
    }));
  });

  // Remove a tablet from the family: the record goes, so the tablet's next contact answers 410 and it clears itself.
  // Its push token is used one last time so that happens now rather than at the next check-in.
  app.delete<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    const token = await ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      const row = await q.one<{ push_token: string | null }>('SELECT push_token FROM device WHERE id = $1', [d.id]);
      await q.run('DELETE FROM device WHERE id = $1', [d.id]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'device.removed', { id: d.id, name: d.name });
      return row?.push_token ?? null;
    });
    if (token) void ctx.push([token], { type: 'config-changed' }).catch(() => {});
    return { ok: true };
  });

  app.put<{ Params: { id: string; app: string } }>('/devices/:id/apps/:app', async (req) => {
    const a = await parentAuth(ctx, req);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id); await appExists(q, req.params.app);
      await q.run('DELETE FROM device_hidden_app WHERE device_id = $1 AND app_id = $2', [d.id, req.params.app]);
      await q.run('INSERT INTO device_app (family_id, device_id, app_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a.familyId, d.id, req.params.app]);
      return { installed: true };
    }));
  });

  app.delete<{ Params: { id: string; app: string } }>('/devices/:id/apps/:app', async (req) => {
    const a = await parentAuth(ctx, req);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      await q.run('DELETE FROM device_app WHERE device_id = $1 AND app_id = $2', [d.id, req.params.app]);
      return { installed: false };
    }));
  });

  // Hide an app from this device's home screen and Store (and uninstall it); unhide brings it back to the Store.
  app.put<{ Params: { id: string; app: string } }>('/devices/:id/hidden/:app', async (req) => {
    const a = await parentAuth(ctx, req);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id); await appExists(q, req.params.app);
      await q.run('INSERT INTO device_hidden_app (family_id, device_id, app_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [a.familyId, d.id, req.params.app]);
      await q.run('DELETE FROM device_app WHERE device_id = $1 AND app_id = $2', [d.id, req.params.app]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'app.hidden', { device: d.id, app: req.params.app });
      return { hidden: true };
    }));
  });
  app.delete<{ Params: { id: string; app: string } }>('/devices/:id/hidden/:app', async (req) => {
    const a = await parentAuth(ctx, req);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      await q.run('DELETE FROM device_hidden_app WHERE device_id = $1 AND app_id = $2', [d.id, req.params.app]);
      return { hidden: false };
    }));
  });

  app.put<{ Params: { id: string } }>('/devices/:id/settings', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = z.object({ allowlist: z.array(allowEntry).max(200).optional(), limits: limits.optional() }).parse(req.body);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      if (b.allowlist) await setSetting(q, a.familyId, d.id, 'allowlist', b.allowlist);
      if (b.limits) await setSetting(q, a.familyId, d.id, 'limits', { ...(await getSetting(q, d.id, 'limits', {})), ...b.limits });
      await audit(q, a.familyId, `parent:${a.parentId}`, 'settings.updated', { device: d.id, keys: Object.keys(b) });
      return deviceConfig(ctx, q, d.id);
    }));
  });

  // Travel mode: lifts the website allowlist for N hours (default 6); 0 ends it now.
  app.post<{ Params: { id: string } }>('/devices/:id/travel', async (req) => {
    const a = await parentAuth(ctx, req);
    const { hours } = z.object({ hours: z.number().int().min(0).max(48).default(6) }).parse(req.body ?? {});
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      await setSetting(q, a.familyId, d.id, 'travel_until', hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'travel.set', { device: d.id, hours });
      return (await deviceConfig(ctx, q, d.id)).travel;
    }));
  });

  // ---- The device itself.
  app.post('/device/checkin', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ shellVersion: z.string().max(30).optional(), battery: z.number().int().min(0).max(100).optional(), pushToken: z.string().max(4096).optional() }).parse(req.body ?? {});
    return ctx.db.family(dv.familyId, async (q) => {
      await q.run(`UPDATE device SET shell_version = COALESCE($1, shell_version), battery = COALESCE($2, battery),
        push_token = COALESCE($3, push_token), last_seen_at = now() WHERE id = $4`, [b.shellVersion ?? null, b.battery ?? null, b.pushToken ?? null, dv.deviceId]);
      return deviceConfig(ctx, q, dv.deviceId);
    });
  });

  app.get('/device/config', async (req) => {
    const dv = await deviceAuth(ctx, req);
    return ctx.db.family(dv.familyId, (q) => deviceConfig(ctx, q, dv.deviceId));
  });

  // The child installs and uninstalls freely (no PIN); apps a parent hid stay unavailable.
  app.put<{ Params: { app: string } }>('/device/apps/:app', async (req) => {
    const dv = await deviceAuth(ctx, req);
    if (dv.state !== 'active') throw badRequest('This device is being removed');
    return ctx.db.family(dv.familyId, async (q) => {
      await appExists(q, req.params.app);
      if (await q.one('SELECT 1 FROM device_hidden_app WHERE device_id = $1 AND app_id = $2', [dv.deviceId, req.params.app])) throw forbidden('A parent turned this app off');
      await q.run('INSERT INTO device_app (family_id, device_id, app_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [dv.familyId, dv.deviceId, req.params.app]);
      return { installed: true };
    });
  });
  app.delete<{ Params: { app: string } }>('/device/apps/:app', async (req) => {
    const dv = await deviceAuth(ctx, req);
    await ctx.db.family(dv.familyId, (q) => q.run('DELETE FROM device_app WHERE device_id = $1 AND app_id = $2', [dv.deviceId, req.params.app]));
    return { installed: false };
  });

  // Remove from this device (on the tablet, behind the parent PIN): the shell has already released the lockdown.
  // The first tablet sets the family PIN when none exists yet; after that the website owns it.
  app.put('/device/pin', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{4,6}$/) }).parse(req.body);
    return ctx.db.family(dv.familyId, async (q) => {
      const n = await q.run('UPDATE family SET pin_hash = $1, pin_sync = $2, pin_set_at = now() WHERE id = $3 AND pin_hash IS NULL', [hashToken(pin, ctx.cfg.SESSION_SECRET), sha256(`duckling:${pin}`), dv.familyId]);
      if (!n) throw new HttpError(409, 'The family PIN is already set; the tablet receives it at check-in.');
      await audit(q, dv.familyId, `device:${dv.deviceId}`, 'pin.set');
      return { set: true };
    });
  });

  app.post('/device/pin/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const dv = await deviceAuth(ctx, req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{4,6}$/) }).parse(req.body);
    const fam = await ctx.db.family(dv.familyId, (q) => q.one<{ pin_hash: string | null }>('SELECT pin_hash FROM family WHERE id = $1', [dv.familyId]));
    return { ok: !!fam?.pin_hash && safeEqual(fam.pin_hash, hashToken(pin, ctx.cfg.SESSION_SECRET)) };
  });

  app.post('/device/released', async (req) => {
    const dv = await deviceAuth(ctx, req);
    await ctx.db.family(dv.familyId, async (q) => {
      await q.run("UPDATE device SET state = 'released' WHERE id = $1", [dv.deviceId]);
      await audit(q, dv.familyId, `device:${dv.deviceId}`, 'device.released');
    });
    return { state: 'released' };
  });
}
