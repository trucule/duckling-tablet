// Devices: pairing, parent controls per device, and the device's own check-in, config and installs.
// Every handler runs inside one family-scoped transaction, so a query that forgets a WHERE still sees one family.
import { mediaHostsFor, siteHost } from '../sitehosts.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { notifyDevices } from '../notify.js';
import type { Q } from '../db.js';
import { deviceAuth, parentAuth } from '../auth.js';
import { backgroundUrl, childRow, portraitUrl, starsOf } from './family.js';
import { entitlementOf, isLocked, requireSubscribed } from '../entitlement.js';
import { listCatalog } from '../catalog.js';
import { LANGUAGES, languageOf, narratorFor } from '../language.js';
import { after } from '../notify.js';
import { HttpError, badRequest, forbidden, hashToken, inMinutes, newId, newToken, notFound, now, pairingCode, safeEqual, sha256 } from '../util.js';

// A host pattern: example.org (subdomains included) or *.example.org.
// A pasted address (https://www.kleki.com/) is taken as its site name (kleki.com) before the check.
const host = z.preprocess(siteHost, z.string().regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, 'Use a site name like pbskids.org'));
const allowEntry = z.object({ host, tile: z.object({ name: z.string().max(40), url: z.string().url().refine((u) => /^https?:\/\//i.test(u), 'A website link starts with https://'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional() });
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

const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// The tablet's other apps: every present one for parents, only the allowed ones for the tablet.
export async function otherAppsFor(q: Q, deviceId: string, familyId: string, allowedOnly: boolean, day?: string) {
  const rows = await q.all(`SELECT * FROM device_other_app WHERE device_id = $1 AND present ${allowedOnly ? 'AND allowed' : ''} ORDER BY lower(label)`, [deviceId]);
  const usage = await q.all<{ package: string; seconds: number }>('SELECT package, seconds FROM other_app_usage WHERE device_id = $1 AND day = $2', [deviceId, day ?? new Date().toISOString().slice(0, 10)]);
  const used = Object.fromEntries(usage.map((u) => [u.package, u.seconds]));
  void familyId;
  return rows.map((r: any) => ({
    package: r.package, label: r.label, icon: r.icon ?? null, allowed: r.allowed,
    dailyMinutes: r.daily_minutes ?? null, window: r.window_start && r.window_end ? { start: r.window_start, end: r.window_end } : null,
    hosts: r.hosts ?? [], usedSecondsToday: used[r.package] ?? 0,
  }));
}

// forParent: the full list of the tablet's other apps (the tablet itself gets only the allowed ones).
export async function deviceConfig(ctx: Ctx, q: Q, deviceId: string, forParent = false) {
  const d = await q.one('SELECT * FROM device WHERE id = $1', [deviceId]);
  if (!d) throw notFound('No such device');
  const childRaw = d.child_id ? await q.one('SELECT * FROM child WHERE id = $1', [d.child_id]) : null;
  const child = childRaw ? { ...childRow(childRaw), portraitUrl: portraitUrl(ctx.cfg, childRaw.id, childRaw.portrait_key), backgroundUrl: backgroundUrl(ctx.cfg, childRaw.id, childRaw.background_key), stars: await starsOf(q, childRaw.id, childRaw.avatar) } : null;
  const installed = new Set((await q.all('SELECT app_id FROM device_app WHERE device_id = $1', [deviceId])).map((r) => r.app_id as string));
  const hidden = new Set((await q.all('SELECT app_id FROM device_hidden_app WHERE device_id = $1', [deviceId])).map((r) => r.app_id as string));
  const catalog = (await listCatalog(ctx, q)).filter((a) => !hidden.has(a.id));
  const travelUntil = await getSetting<string | null>(q, deviceId, 'travel_until', null);
  const fam = await q.one<{ pin_sync: string | null; app_account_token: string; language: string }>('SELECT pin_sync, app_account_token::text AS app_account_token, language FROM family WHERE id = $1', [d.family_id]);
  // The child's own language when she has one, else the family's.
  const language = languageOf(childRaw?.language ?? fam?.language);
  const ent = await entitlementOf(q, d.family_id);
  const allowlist = await getSetting(q, deviceId, 'allowlist', [] as { host: string }[]);
  return {
    deviceId, state: d.state, child,
    // SHA-256 of "duckling:<pin>", the form the shells keep; null until a parent sets a PIN.
    pinHash: fam?.pin_sync ?? null,
    entitlement: ent,
    // The tablet greys its apps and hides websites and other apps while this is true (see entitlement.ts).
    locked: isLocked(ent),
    // The iPad app passes this with every StoreKit purchase so Apple's notifications name the family.
    appAccountToken: fam?.app_account_token ?? null,
    // Card payments through Stripe (the Windows parent area subscribes this way).
    cardPayments: !!ctx.stripe,
    apps: catalog.filter((a) => installed.has(a.id)).map((a) => ({ id: a.id, name: a.name, i18n: a.i18n, tileUrl: a.tileUrl, permissions: a.latest!.permissions, ...a.latest })),
    hidden: [...hidden],
    allowlist,
    // Hosts the allowed websites need for their videos (sitehosts.ts); the tablet allows them with no tile.
    mediaHosts: mediaHostsFor(allowlist.map((w) => w.host)),
    travel: { active: !!travelUntil && travelUntil > now(), until: travelUntil },
    limits: await getSetting(q, deviceId, 'limits', {}),
    // Apps installed outside Duckling that a parent allowed, with today's use (the tablet's local day).
    otherApps: await otherAppsFor(q, deviceId, d.family_id, !forParent),
    language, familyLanguage: languageOf(fam?.language),
    narratorVoice: narratorFor(ctx.cfg, language),
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
    return ctx.db.family(a.familyId, async (q) => { await myDevice(q, req.params.id); return deviceConfig(ctx, q, req.params.id, true); });
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

  // Remove a tablet from the family: the record goes, so the tablet's next contact answers 410. The tablet keeps its
  // apps, PIN and lockdown and its parent area asks for a new pairing code. Its push token is used one last time so
  // it finds out now rather than at the next check-in.
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

  // Other apps: a parent allows an app the tablet already has, with a daily allowance, a time window and the websites
  // that open only while the app has time.
  app.put<{ Params: { id: string; pkg: string } }>('/devices/:id/other-apps/:pkg', async (req) => {
    const a = await parentAuth(ctx, req);
    if (!PACKAGE.test(req.params.pkg)) throw badRequest('Bad package name');
    const b = z.object({
      allowed: z.boolean().optional(),
      dailyMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      window: z.object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) }).nullable().optional(),
      hosts: z.array(host).max(50).optional(),
    }).parse(req.body);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      const cur = await q.one('SELECT * FROM device_other_app WHERE device_id = $1 AND package = $2', [d.id, req.params.pkg]);
      if (!cur) throw notFound('The tablet has not reported that app');
      await q.run(`UPDATE device_other_app SET allowed = $3, daily_minutes = $4, window_start = $5, window_end = $6, hosts = $7::jsonb, updated_at = now() WHERE device_id = $1 AND package = $2`,
        [d.id, req.params.pkg, b.allowed ?? cur.allowed, b.dailyMinutes === undefined ? cur.daily_minutes : b.dailyMinutes,
          b.window === undefined ? cur.window_start : (b.window?.start ?? null), b.window === undefined ? cur.window_end : (b.window?.end ?? null),
          JSON.stringify(b.hosts ?? cur.hosts ?? [])]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'device.other_app', { id: d.id, package: req.params.pkg, allowed: b.allowed ?? cur.allowed });
      return { otherApps: await otherAppsFor(q, d.id, a.familyId, false) };
    }));
  });

  // Travel mode: lifts the website allowlist for N hours (default 6); 0 ends it now.
  app.post<{ Params: { id: string } }>('/devices/:id/travel', async (req) => {
    const a = await parentAuth(ctx, req);
    // Minutes (1 to 2880) or, for older callers, hours; 0 ends it now.
    const b = z.object({ minutes: z.number().int().min(0).max(2880).optional(), hours: z.number().int().min(0).max(48).optional() }).parse(req.body ?? {});
    const minutes = b.minutes ?? (b.hours === undefined ? 360 : b.hours * 60);
    return after(ctx, a.familyId, req.params.id, ctx.db.family(a.familyId, async (q) => {
      const d = await myDevice(q, req.params.id);
      await setSetting(q, a.familyId, d.id, 'travel_until', minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'travel.set', { device: d.id, minutes });
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

  // The tablet's launchable apps, reported at check-in (apps no longer there are kept, marked absent, so a parent's
  // settings survive a reinstall). Labels and small icons only. The iPad cannot list its apps or open one, so there a
  // parent picks the allowed apps and their minutes on the iPad itself (Screen Time), and the report carries that
  // choice: `allowed` and `dailyMinutes` are applied when present and left to the portal when absent.
  app.post('/device/apps-installed', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ apps: z.array(z.object({
      package: z.string().regex(PACKAGE).max(200), label: z.string().trim().min(1).max(80),
      icon: z.string().regex(/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/).max(12_000).optional(),
      allowed: z.boolean().optional(), dailyMinutes: z.number().int().min(1).max(1440).nullable().optional(),
    })).max(300) }).parse(req.body);
    return ctx.db.family(dv.familyId, async (q) => {
      await q.run('UPDATE device_other_app SET present = false WHERE device_id = $1', [dv.deviceId]);
      for (const a of b.apps) {
        await q.run(`INSERT INTO device_other_app (family_id, device_id, package, label, icon, present, allowed, daily_minutes)
          VALUES ($1, $2, $3, $4, $5, true, COALESCE($6::boolean, false), CASE WHEN $7::boolean THEN $8::integer ELSE NULL END)
          ON CONFLICT (device_id, package) DO UPDATE SET label = excluded.label, icon = COALESCE(excluded.icon, device_other_app.icon), present = true, updated_at = now(),
            allowed = COALESCE($6::boolean, device_other_app.allowed), daily_minutes = CASE WHEN $7::boolean THEN $8::integer ELSE device_other_app.daily_minutes END`,
          [dv.familyId, dv.deviceId, a.package, a.label, a.icon ?? null, a.allowed ?? null, a.dailyMinutes !== undefined, a.dailyMinutes ?? null]);
      }
      return { otherApps: await otherAppsFor(q, dv.deviceId, dv.familyId, true) };
    });
  });

  // A Duckling app opened, and the seconds until Duckling was back in front, added to the tablet's local day.
  app.post('/device/app-usage', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ app: z.string().regex(/^[a-z0-9-]{1,64}$/), seconds: z.number().int().min(0).max(6 * 3600), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
    await ctx.db.family(dv.familyId, (q) => q.run(`INSERT INTO app_usage (family_id, device_id, app_id, day, opens, seconds) VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT (device_id, app_id, day) DO UPDATE SET opens = app_usage.opens + 1, seconds = app_usage.seconds + excluded.seconds, updated_at = now()`,
      [dv.familyId, dv.deviceId, b.app, b.day, b.seconds]));
    return { ok: true };
  });

  // Time spent in another app, counted by the tablet from launch to its return; added to the tablet's local day.
  app.post('/device/other-app-usage', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ package: z.string().regex(PACKAGE), seconds: z.number().int().min(0).max(86_400), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
    return ctx.db.family(dv.familyId, async (q) => {
      await q.run(`INSERT INTO other_app_usage (family_id, device_id, package, day, seconds) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (device_id, package, day) DO UPDATE SET seconds = other_app_usage.seconds + excluded.seconds, updated_at = now()`, [dv.familyId, dv.deviceId, b.package, b.day, b.seconds]);
      return { otherApps: await otherAppsFor(q, dv.deviceId, dv.familyId, true, b.day) };
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
      await requireSubscribed(q, dv.familyId);
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
  // ---- The child's avatar, portrait and stars (My Avatar and the stars counter in every app, through the
  // compatibility script). All of it lives on the child profile, so it is the same on every tablet she uses.
  const withChild = async (dv: { familyId: string; childId: string | null }) => {
    if (!dv.childId) throw new HttpError(409, 'This tablet has no child assigned yet');
    return dv.childId;
  };

  app.get('/device/child/avatar', async (req) => {
    const dv = await deviceAuth(ctx, req);
    if (!dv.childId) return { design: null, owned: [], spent: 0, savedAt: 0, earned: 0, earnedByApp: {} };
    return ctx.db.family(dv.familyId, async (q) => {
      const c = await q.one<{ avatar: any; avatar_saved_at: string | null }>('SELECT avatar, avatar_saved_at FROM child WHERE id = $1', [dv.childId]);
      const rows = await q.all<{ app_id: string; earned: number }>('SELECT app_id, earned FROM child_stars WHERE child_id = $1', [dv.childId]);
      const earnedByApp = Object.fromEntries(rows.map((r) => [r.app_id, r.earned]));
      const a = c?.avatar ?? {};
      return { design: a.design ?? null, owned: a.owned ?? [], spent: a.spent ?? 0, savedAt: a.savedAt ?? 0, earned: rows.reduce((n, r) => n + r.earned, 0), earnedByApp };
    });
  });

  app.put('/device/child/avatar', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const childId = await withChild(dv);
    const b = z.object({ design: z.record(z.unknown()), owned: z.array(z.string().max(64)).max(500).default([]), spent: z.number().int().min(0).max(1_000_000).default(0), savedAt: z.number().min(0).default(0) }).parse(req.body);
    if (JSON.stringify(b).length > 32 * 1024) throw new HttpError(413, 'Avatar too large');
    await ctx.db.family(dv.familyId, async (q) => {
      // A newer save on another tablet is kept; the app restores from the server when it sees a later savedAt.
      const n = await q.run('UPDATE child SET avatar = $2, avatar_saved_at = now() WHERE id = $1 AND (avatar IS NULL OR COALESCE((avatar->>\'savedAt\')::numeric, 0) <= $3)', [childId, JSON.stringify(b), b.savedAt]);
      if (n) await audit(q, dv.familyId, `device:${dv.deviceId}`, 'child.avatar', { child: childId });
    });
    return { saved: true };
  });

  app.post('/device/child/stars', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const childId = await withChild(dv);
    const b = z.object({ appId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/), earned: z.number().int().min(0).max(1_000_000) }).parse(req.body);
    return ctx.db.family(dv.familyId, async (q) => {
      await q.run(`INSERT INTO child_stars (family_id, child_id, app_id, earned) VALUES ($1, $2, $3, $4)
        ON CONFLICT (child_id, app_id) DO UPDATE SET earned = GREATEST(child_stars.earned, excluded.earned), updated_at = now()`, [dv.familyId, childId, b.appId, b.earned]);
      const total = (await q.one<{ n: number }>('SELECT COALESCE(SUM(earned), 0)::int AS n FROM child_stars WHERE child_id = $1', [childId]))!.n;
      return { earned: total };
    });
  });

  // The child's portrait for an app to draw (Number Line Rocket's pilot), as PNG bytes. 404 when she has none.
  app.get('/device/child/portrait', async (req, reply) => {
    const dv = await deviceAuth(ctx, req);
    if (!dv.childId) throw new HttpError(404, 'No portrait');
    const row = await ctx.db.family(dv.familyId, (q) => q.one<{ portrait_key: string | null }>('SELECT portrait_key FROM child WHERE id = $1', [dv.childId]));
    const png = row?.portrait_key ? await ctx.storage.get(row.portrait_key) : null;
    if (!png) throw new HttpError(404, 'No portrait');
    reply.header('Cache-Control', 'private, max-age=300').type('image/png');
    return reply.send(png);
  });

  // The portrait: a 384-pixel PNG as a data URL (what My Avatar's portrait() returns), up to 600 KB.
  app.register(async (pics) => {
    pics.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 900 * 1024 }, (_req, body, done) => done(null, body));
    pics.put('/device/child/portrait', async (req) => {
      const dv = await deviceAuth(ctx, req);
      const childId = await withChild(dv);
      const raw = typeof req.body === 'string' ? req.body : '';
      const m = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/);
      if (!m) throw new HttpError(415, 'Send a PNG data URL');
      const png = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
      if (png.length < 100 || png.length > 600 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new HttpError(400, 'Not a PNG, or too large');
      const key = `portraits/${childId}-${sha256(png).slice(0, 12)}.png`;
      await ctx.storage.put(key, png, 'image/png', false);
      const old = await ctx.db.family(dv.familyId, async (q) => {
        const prev = await q.one<{ portrait_key: string | null }>('SELECT portrait_key FROM child WHERE id = $1', [childId]);
        await q.run('UPDATE child SET portrait_key = $2, portrait_updated_at = now() WHERE id = $1', [childId, key]);
        return prev?.portrait_key ?? null;
      });
      if (old && old !== key) { try { await ctx.storage.delete(old); } catch { /* a stale file costs little */ } }
      return { portraitUrl: portraitUrl(ctx.cfg, childId, key) };
    });
  });

  app.register(async (pics) => {
    pics.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 2_200_000 }, (_req, body, done) => done(null, body));
    // The home background: a picture she saved in an app, as a PNG or JPEG data URL up to 1.5 MB. Every tablet of hers
    // shows it at its next check-in (a push tells them now). DELETE goes back to the plain home screen.
    pics.put('/device/child/background', async (req) => {
      const dv = await deviceAuth(ctx, req);
      const childId = await withChild(dv);
      const raw = typeof req.body === 'string' ? req.body : '';
      const m = raw.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/);
      if (!m) throw new HttpError(415, 'Send a PNG or JPEG data URL');
      const img = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
      const png = img.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', jpg = img.subarray(0, 3).toString('hex') === 'ffd8ff';
      if (img.length < 100 || img.length > 1_500_000 || !(m[1] === 'png' ? png : jpg)) throw new HttpError(400, 'Not a PNG or JPEG, or too large');
      const key = `backgrounds/${childId}-${sha256(img).slice(0, 12)}.${png ? 'png' : 'jpg'}`;
      await ctx.storage.put(key, img, png ? 'image/png' : 'image/jpeg', false);
      const old = await setBackground(dv.familyId, childId, key, `device:${dv.deviceId}`);
      if (old && old !== key) { try { await ctx.storage.delete(old); } catch { /* a stale file costs little */ } }
      void notifyDevices(ctx, dv.familyId);
      return { backgroundUrl: backgroundUrl(ctx.cfg, childId, key) };
    });
  });

  app.delete('/device/child/background', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const childId = await withChild(dv);
    const old = await setBackground(dv.familyId, childId, null, `device:${dv.deviceId}`);
    if (old) { try { await ctx.storage.delete(old); } catch { /* a stale file costs little */ } }
    void notifyDevices(ctx, dv.familyId);
    return { backgroundUrl: null };
  });

  async function setBackground(familyId: string, childId: string, key: string | null, actor: string) {
    return ctx.db.family(familyId, async (q) => {
      const prev = await q.one<{ background_key: string | null }>('SELECT background_key FROM child WHERE id = $1', [childId]);
      await q.run('UPDATE child SET background_key = $2 WHERE id = $1', [childId, key]);
      await audit(q, familyId, actor, key ? 'child.background.set' : 'child.background.cleared', { childId });
      return prev?.background_key ?? null;
    });
  }

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

  // The language from the tablet's parent area (behind the PIN): the family's, so every tablet and the portal follow.
  app.put('/device/language', async (req) => {
    const dv = await deviceAuth(ctx, req);
    const { language } = z.object({ language: z.enum(LANGUAGES) }).parse(req.body);
    await ctx.db.family(dv.familyId, async (q) => {
      await q.run('UPDATE family SET language = $1 WHERE id = $2', [language, dv.familyId]);
      await audit(q, dv.familyId, `device:${dv.deviceId}`, 'family.language', { language });
    });
    void notifyDevices(ctx, dv.familyId);
    return { language };
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
