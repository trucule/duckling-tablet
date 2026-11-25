// Diagnostics: a parent sends a report from the tablet's parent area, with an optional note. The report (versions,
// settings, lockdown state, recent errors, hosts the websites were refused) is kept as a private file, with what the
// server knows about the tablet added, and becomes an ET Ducky ticket with a summary and a signed link to the file.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import type { Q } from '../db.js';
import { deviceAuth } from '../auth.js';
import { HttpError, hashToken, linkExpiry, newId, notFound, safeEqual } from '../util.js';
import { deviceConfig, siteHostsOf } from './devices.js';

const MAX_REPORT = 1_000_000;          // bytes of the tablet's part, as JSON
const MAX_PER_DAY = 20;                // reports per family in 24 hours, on top of the per-address rate limit
const RETRY_DAYS = 30;
const KEEP_DAYS = 90;                  // a report and its file are deleted after this (the privacy policy says so)

const reportPath = (id: string) => `/diagnostics/${id}`;
const signFor = (ctx: Ctx, id: string, exp: number) => hashToken(`diagnostics/${id}/${exp}`, ctx.cfg.SESSION_SECRET).slice(0, 32);
export const reportUrl = (ctx: Ctx, id: string) => { const exp = linkExpiry(); return `${ctx.cfg.PUBLIC_URL}${reportPath(id)}?exp=${exp}&sig=${signFor(ctx, id, exp)}`; };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 200) => (v === undefined || v === null ? '' : String(v)).replace(/[\r\n]+/g, ' ').slice(0, n);

/** The names the report must not carry: the family's children (a tablet named "Ada's tablet" loses the name too). */
async function namesOf(q: Q, familyId: string): Promise<string[]> {
  const rows = await q.all<{ n: string }>('SELECT first_name AS n FROM child WHERE family_id = $1', [familyId]);
  return rows.map((r) => r.n.trim()).filter((n) => n.length >= 2);
}

/** Replaces each name with [name], wherever it appears in the text (as a whole word, any case). */
export function redactNames(text: string, names: string[]): string {
  let out = text;
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
  }
  return out;
}

/** The ticket text: the note, then what to look at first. The full report is behind the link. */
export function summarize(r: { id: string; familyId: string; deviceId: string | null; note: string; client: Json; server: Json; url: string }): string {
  const c = r.client, shell = obj(c.shell), app = obj(c.app), cfg = obj(c.config), lock = obj(shell.lockdown), ent = obj(cfg.entitlement);
  const lines: string[] = [];
  lines.push(r.note.trim() || '(No note from the parent.)', '');
  lines.push(`Family: ${r.familyId}   Device: ${r.deviceId ?? 'removed'}   Report: ${r.id}`);
  lines.push(`Platform: ${str(shell.platform, 20)}, shell ${str(shell.version, 30)}, web app ${str(app.build, 40)}`);
  lines.push(`Agent: ${str(app.userAgent, 300)}`);
  lines.push(`Screen: ${str(app.screen, 40)}   Language: ${str(app.language, 5)}   Network: ${str(shell.network, 12)}   Online: ${str(app.online, 5)}`);
  lines.push(`Clock: tablet ${str(app.time, 40)} (${str(app.timeZone, 40)}), ${str(app.clockOffsetSeconds, 12)} s from the server`);
  lines.push(`Subscription: ${str(ent.status, 20)}${ent.daysLeft != null ? `, ${str(ent.daysLeft, 5)} days left` : ''}${cfg.locked ? ', LOCKED' : ''}`);
  lines.push(`Lockdown: on ${str(lock.lockdownOn, 5)}, pinned ${str(lock.pinned, 5)}, home ${str(lock.homeRole, 5)}, secure ${str(lock.deviceSecure, 5)}`);
  const apps = Object.entries(obj(shell.installedApps)).map(([k, v]) => `${k} ${str(v, 20)}`);
  lines.push(`Apps on the tablet (${apps.length}): ${apps.join(', ').slice(0, 1500)}`);
  const sites = arr(cfg.allowlist).map((w) => str(obj(w).host, 100));
  lines.push(`Websites: ${sites.join(', ') || 'none'}   Travel mode: ${str(obj(cfg.travel).active, 5)}`);
  const refused = arr(r.server.siteHosts).map((h) => { const o = obj(h); return `${str(o.site, 80)} > ${str(o.host, 120)}${o.media ? ' (video)' : ''}${o.tracker ? ' (ads/analytics)' : ''} x${str(o.hits, 8)}${o.decision ? ` [${str(o.decision, 8)}]` : ''}`; });
  if (refused.length) lines.push('', 'Hosts the websites were refused:', ...refused.slice(0, 25).map((x) => `  ${x}`));
  const errors = arr(c.log).slice(-20).map((e) => { const o = obj(e); return `  ${str(o.at, 30)} ${str(o.kind, 12)} ${str(o.message, 300)}`; });
  if (errors.length) lines.push('', 'Recent events on the tablet:', ...errors);
  const shellLog = str(c.shellLog, 100_000).length ? 'yes, in the full report' : 'none';
  lines.push('', `Shell log: ${shellLog}`);
  lines.push(`Full report (JSON, this link works for 30 days): ${r.url}`);
  return lines.join('\n').slice(0, 9500);
}

/** Opens the ticket for a stored report. True when ET Ducky took it. */
async function openTicket(ctx: Ctx, row: { id: string; family_id: string; summary: string; title: string }): Promise<boolean> {
  // The summary holds a signed link; a retry days later gets a fresh one.
  const body = row.summary.replace(/https?:\/\/\S+\/diagnostics\/\S+/, reportUrl(ctx, row.id));
  const ticket = await ctx.createTicket({ kind: 'diagnostics', reportId: row.id, familyId: row.family_id, title: row.title, body });
  if (!ticket) return false;
  await ctx.db.system((q) => q.run('UPDATE diagnostic_report SET etducky_ticket_id = $1 WHERE id = $2 AND etducky_ticket_id IS NULL', [ticket, row.id]));
  return true;
}

const titleOf = (platform: string, version: string, note: string) => `Diagnostics: ${platform || 'tablet'} ${version}${note.trim() ? `: ${note.trim().replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;

/** Reports from the last 30 days that have no ticket yet (ET Ducky was down or not configured). ET Ducky returns the
 * existing ticket for a repeated report id, so a retry never makes a second one. */
/** Deletes reports older than KEEP_DAYS with their files. Runs with the ticket retry. */
export async function pruneDiagnostics(ctx: Ctx): Promise<number> {
  const old = await ctx.db.system((q) => q.all<{ id: string; storage_key: string }>(
    `DELETE FROM diagnostic_report WHERE created_at < now() - interval '${KEEP_DAYS} days' RETURNING id, storage_key`));
  for (const r of old) { try { await ctx.storage.delete(r.storage_key); } catch { /* the row is gone; a stray file costs little */ } }
  return old.length;
}

export async function sendMissingDiagnostics(ctx: Ctx): Promise<{ waiting: number; created: number }> {
  await pruneDiagnostics(ctx);
  const rows = await ctx.db.system((q) => q.all<{ id: string; family_id: string; summary: string; title: string }>(
    `SELECT id, family_id, summary, title FROM diagnostic_report
     WHERE etducky_ticket_id IS NULL AND created_at > now() - interval '${RETRY_DAYS} days' ORDER BY created_at LIMIT 20`));
  let created = 0;
  for (const r of rows) if (await openTicket(ctx, r)) created++;
  return { waiting: rows.length - created, created };
}

export default async function diagnosticsRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.post('/device/diagnostics', { bodyLimit: MAX_REPORT + 16_384, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ note: z.string().max(2000).default(''), report: z.record(z.string(), z.unknown()) }).parse(req.body);
    if (JSON.stringify(b.report).length > MAX_REPORT) throw new HttpError(413, 'The report is too large');
    const id = newId('diag');
    const today = await ctx.db.family(dv.familyId, (q) => q.one<{ n: number }>("SELECT count(*)::int AS n FROM diagnostic_report WHERE created_at > now() - interval '1 day'"));
    if ((today?.n ?? 0) >= MAX_PER_DAY) throw new HttpError(429, 'Too many reports today. Try again tomorrow.');
    const { full, summary, title, note } = await ctx.db.family(dv.familyId, async (q) => {
      // What the server knows about this tablet, beside what it reported about itself.
      const d = await q.one('SELECT platform, state, shell_version, battery, last_seen_at, created_at FROM device WHERE id = $1', [dv.deviceId]);
      const fam = await q.one('SELECT language, created_at FROM family WHERE id = $1', [dv.familyId]);
      const counts = await q.one<{ devices: number; children: number }>('SELECT (SELECT count(*) FROM device)::int AS devices, (SELECT count(*) FROM child)::int AS children');
      const config = await deviceConfig(ctx, q, dv.deviceId);
      const events = await q.all("SELECT action, actor, at FROM audit WHERE at > now() - interval '7 days' ORDER BY at DESC LIMIT 60");
      const server = {
        device: d, family: { language: fam?.language, createdAt: fam?.created_at, ...counts },
        // The tablet's settings as the server would send them now (no child name: grade and levels only).
        config: { ...config, child: config.child ? { grade: config.child.grade, age: config.child.age ?? null, levels: config.child.levels, language: config.child.language ?? null } : null, pinHash: config.pinHash ? 'set' : null, appAccountToken: undefined },
        siteHosts: await siteHostsOf(q, dv.deviceId),
        recentActions: events,
      };
      const names = await namesOf(q, dv.familyId);
      const note = redactNames(b.note, names);
      const client = JSON.parse(redactNames(JSON.stringify(b.report), names)) as Json;
      const full = { id, createdAt: new Date().toISOString(), familyId: dv.familyId, deviceId: dv.deviceId, note, client, server };
      const summary = summarize({ id, familyId: dv.familyId, deviceId: dv.deviceId, note, client, server: server as unknown as Json, url: reportUrl(ctx, id) });
      const shellInfo = obj(client.shell);
      return { full, summary, note, title: titleOf(str(shellInfo.platform, 20) || d?.platform, str(shellInfo.version, 30) || d?.shell_version || '', note) };
    });
    const bytes = Buffer.from(JSON.stringify(full, null, 1));
    const key = `diagnostics/${id}.json`;
    await ctx.storage.put(key, bytes, 'application/json', false);
    await ctx.db.family(dv.familyId, async (q) => {
      await q.run('INSERT INTO diagnostic_report (id, family_id, device_id, title, note, summary, storage_key, size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, dv.familyId, dv.deviceId, title, note, summary, key, bytes.length]);
      await audit(q, dv.familyId, `device:${dv.deviceId}`, 'diagnostics.sent', { id, size: bytes.length });
    });
    const sent = await openTicket(ctx, { id, family_id: dv.familyId, summary, title });
    return { id, sent };
  });

  // The full report, for the ET Ducky team through the signed link in the ticket. No other way in.
  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>('/diagnostics/:id', async (req, reply) => {
    const id = req.params.id, exp = Number(req.query.exp), sig = String(req.query.sig ?? '');
    if (!(Number.isFinite(exp) && exp > Date.now() && sig.length === 32 && safeEqual(sig, signFor(ctx, id, exp)))) throw new HttpError(403, 'This link has expired or is not valid');
    const row = await ctx.db.system((q) => q.one<{ storage_key: string }>('SELECT storage_key FROM diagnostic_report WHERE id = $1', [id]));
    const bytes = row ? await ctx.storage.get(row.storage_key) : null;
    if (!bytes) throw notFound('No such report');
    reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', `inline; filename="${id}.json"`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox").type('application/json');
    return reply.send(bytes);
  });
}
