// The owner's stats: counts across every family, for the parents named in STATS_EMAILS (the portal's Stats page) or
// the admin token. Nothing here names a family, a parent, a child or a tablet; every figure is a count or a sum.
// It reads across families, so it runs as duckling_system.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { adminAuth, parentAuth } from '../auth.js';
import { HttpError } from '../util.js';

async function statsAuth(ctx: Ctx, req: FastifyRequest): Promise<void> {
  if (/^Bearer /i.test(req.headers.authorization ?? '') && ctx.cfg.ADMIN_TOKEN) {
    try { adminAuth(ctx, req); return; } catch { /* not the admin token: try a parent session */ }
  }
  const a = await parentAuth(ctx, req);
  if (!ctx.cfg.STATS_EMAILS.includes(a.email.toLowerCase())) throw new HttpError(403, 'Not available');
}

const n = (v: unknown) => Number(v ?? 0);

export default async function statsRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/stats', async (req, reply) => {
    await statsAuth(ctx, req);
    reply.header('Cache-Control', 'no-store');
    return ctx.db.system(async (q) => {
      const one = async (sql: string, p: unknown[] = []) => (await q.one<Record<string, unknown>>(sql, p)) ?? {};
      const fam = await one(`SELECT count(*) total,
          count(*) FILTER (WHERE created_at > now() - interval '7 days') new7,
          count(*) FILTER (WHERE created_at > now() - interval '30 days') new30,
          count(*) FILTER (WHERE language = 'es') spanish FROM family`);
      const withTablet = await one(`SELECT count(DISTINCT family_id) n FROM device WHERE state = 'active'`);
      const childCount = await one(`SELECT count(*) total, count(*) FILTER (WHERE language = 'es') spanish, count(*) FILTER (WHERE portrait_key IS NOT NULL) portraits FROM child`);
      const dev = await one(`SELECT count(*) total,
          count(*) FILTER (WHERE last_seen_at > now() - interval '1 day') seen1,
          count(*) FILTER (WHERE last_seen_at > now() - interval '7 days') seen7,
          count(*) FILTER (WHERE last_seen_at > now() - interval '30 days') seen30,
          count(*) FILTER (WHERE created_at > now() - interval '7 days') new7,
          count(*) FILTER (WHERE created_at > now() - interval '30 days') new30
        FROM device WHERE state = 'active'`);
      const platforms = await q.all<{ platform: string; total: string; seen7: string }>(`SELECT platform, count(*) total,
          count(*) FILTER (WHERE last_seen_at > now() - interval '7 days') seen7 FROM device WHERE state = 'active' GROUP BY platform ORDER BY count(*) DESC`);
      const shells = await q.all<{ platform: string; shell_version: string | null; n: string }>(`SELECT platform, shell_version, count(*) n FROM device
          WHERE state = 'active' AND last_seen_at > now() - interval '30 days' GROUP BY platform, shell_version ORDER BY platform, count(*) DESC`);

      // Subscriptions. A family's trial has run its course once it is older than the trial; of those, how many pay.
      const subs = await q.all<{ status: string; source: string | null; n: string }>(`SELECT status, source, count(*) n FROM entitlement GROUP BY status, source ORDER BY status, source`);
      const conv = await one(`SELECT count(*) eligible, count(*) FILTER (WHERE e.status IN ('active', 'grace')) paying
          FROM family f JOIN entitlement e ON e.family_id = f.id WHERE f.created_at < now() - make_interval(days => $1)`, [ctx.cfg.TRIAL_DAYS]);
      const trialsEnding = await one(`SELECT count(*) n FROM entitlement WHERE status = 'trial' AND current_period_end BETWEEN now() AND now() + interval '7 days'`);

      // Apps: installs on active tablets, use in the last 7 and 30 days, stars earned, AI calls.
      const apps = await q.all<Record<string, unknown>>(`SELECT a.id, a.name,
          (SELECT count(*) FROM device_app da JOIN device d ON d.id = da.device_id WHERE da.app_id = a.id AND d.state = 'active') installs,
          (SELECT coalesce(sum(opens), 0) FROM app_usage u WHERE u.app_id = a.id AND u.day > current_date - 7) opens7,
          (SELECT coalesce(sum(seconds), 0) FROM app_usage u WHERE u.app_id = a.id AND u.day > current_date - 7) seconds7,
          (SELECT count(DISTINCT device_id) FROM app_usage u WHERE u.app_id = a.id AND u.day > current_date - 7) tablets7,
          (SELECT coalesce(sum(opens), 0) FROM app_usage u WHERE u.app_id = a.id AND u.day > current_date - 30) opens30,
          (SELECT coalesce(sum(seconds), 0) FROM app_usage u WHERE u.app_id = a.id AND u.day > current_date - 30) seconds30,
          (SELECT coalesce(sum(earned), 0) FROM child_stars s WHERE s.app_id = a.id) stars,
          (SELECT coalesce(sum(calls), 0) FROM ai_usage x WHERE x.app_id = a.id AND x.day > current_date - 30) ai30
        FROM app a ORDER BY a.name`);

      // Each day of the last 30: new families, new tablets, tablets that opened an app, and minutes in apps.
      const days = await q.all<Record<string, unknown>>(`SELECT d::date AS day,
          (SELECT count(*) FROM family WHERE created_at::date = d::date) families,
          (SELECT count(*) FROM device WHERE created_at::date = d::date) tablets,
          (SELECT count(DISTINCT device_id) FROM app_usage WHERE day = d::date) active,
          (SELECT coalesce(sum(seconds), 0) FROM app_usage WHERE day = d::date) seconds
        FROM generate_series(current_date - 29, current_date, interval '1 day') d ORDER BY d`);

      // Where the children's levels sit, per subject: the starting grade each child's apps use.
      const levels = await q.all<{ subject: string; grade: string; n: string }>(`SELECT l.key subject, l.value::text grade, count(*) n
          FROM child c, jsonb_each(c.levels) l WHERE jsonb_typeof(l.value) = 'number' GROUP BY l.key, l.value::text ORDER BY l.key, l.value::text::numeric`);

      const requests = await q.all<{ status: string; n: string }>(`SELECT status, count(*) n FROM app_request GROUP BY status ORDER BY status`);
      const requests30 = await one(`SELECT count(*) n FROM app_request WHERE created_at > now() - interval '30 days'`);

      // The narrator: lines kept once and played again, and characters made new in the last 30 days.
      const voice = await one(`SELECT count(*) clips, coalesce(sum(chars), 0) chars, coalesce(sum(hits), 0) hits,
          count(*) FILTER (WHERE created_at > now() - interval '30 days') clips30,
          coalesce(sum(chars) FILTER (WHERE created_at > now() - interval '30 days'), 0) chars30 FROM voice_clip`);
      const voiceByLang = await q.all<{ lang: string; clips: string; hits: string }>(`SELECT left(voice, 2) lang, count(*) clips, coalesce(sum(hits), 0) hits FROM voice_clip GROUP BY 1 ORDER BY 1`);
      const ttsChars30 = await one(`SELECT coalesce(sum(chars), 0) n FROM tts_usage WHERE day > current_date - 30`);
      const ai = await one(`SELECT coalesce(sum(calls), 0) calls, coalesce(sum(input_tokens), 0) input, coalesce(sum(output_tokens), 0) output FROM ai_usage WHERE day > current_date - 30`);

      // Other apps parents allowed (by name, across families), with minutes in the last 30 days.
      const otherApps = await q.all<{ label: string; families: string; minutes30: string }>(`SELECT o.label, count(DISTINCT o.family_id) families,
          coalesce((SELECT sum(u.seconds) FROM other_app_usage u WHERE u.package = o.package AND u.day > current_date - 30), 0) / 60 minutes30
        FROM device_other_app o WHERE o.allowed GROUP BY o.label, o.package ORDER BY count(DISTINCT o.family_id) DESC, o.label LIMIT 15`);

      return {
        at: new Date().toISOString(),
        trialDays: ctx.cfg.TRIAL_DAYS,
        families: { total: n(fam.total), new7: n(fam.new7), new30: n(fam.new30), withTablet: n(withTablet.n), spanish: n(fam.spanish) },
        children: { total: n(childCount.total), spanish: n(childCount.spanish), portraits: n(childCount.portraits) },
        tablets: { total: n(dev.total), seen1: n(dev.seen1), seen7: n(dev.seen7), seen30: n(dev.seen30), new7: n(dev.new7), new30: n(dev.new30),
          platforms: platforms.map((p) => ({ platform: p.platform, total: n(p.total), seen7: n(p.seen7) })),
          shells: shells.map((s) => ({ platform: s.platform, version: s.shell_version ?? '', n: n(s.n) })) },
        subscriptions: { byStatus: subs.map((s) => ({ status: s.status, source: s.source ?? '', n: n(s.n) })), trialEnded: n(conv.eligible), paying: n(conv.paying), trialsEnding7: n(trialsEnding.n) },
        apps: apps.map((a) => ({ id: String(a.id), name: String(a.name), installs: n(a.installs), opens7: n(a.opens7), minutes7: Math.round(n(a.seconds7) / 60), tablets7: n(a.tablets7),
          opens30: n(a.opens30), minutes30: Math.round(n(a.seconds30) / 60), stars: n(a.stars), ai30: n(a.ai30) })),
        days: days.map((d) => ({ day: String(d.day instanceof Date ? d.day.toISOString().slice(0, 10) : d.day).slice(0, 10), families: n(d.families), tablets: n(d.tablets), active: n(d.active), minutes: Math.round(n(d.seconds) / 60) })),
        levels: levels.map((l) => ({ subject: l.subject, grade: Number(l.grade), n: n(l.n) })),
        requests: { byStatus: requests.map((r) => ({ status: r.status, n: n(r.n) })), new30: n(requests30.n) },
        voice: { clips: n(voice.clips), chars: n(voice.chars), hits: n(voice.hits), clips30: n(voice.clips30), chars30: n(voice.chars30), charsAsked30: n(ttsChars30.n),
          byLanguage: voiceByLang.map((v) => ({ lang: v.lang, clips: n(v.clips), hits: n(v.hits) })) },
        ai: { calls30: n(ai.calls), inputTokens30: n(ai.input), outputTokens30: n(ai.output) },
        otherApps: otherApps.map((o) => ({ label: o.label, families: n(o.families), minutes30: n(o.minutes30) })),
      };
    });
  });
}
