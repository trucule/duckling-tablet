// The family account: parents, children (profile for the apps) and account deletion.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import type { Q } from '../db.js';
import { entitlementOf } from '../entitlement.js';
import { parentAuth } from '../auth.js';
import { HttpError, hashToken, inDays, linkExpiry, newId, newToken, notFound, safeEqual, sha256 } from '../util.js';
import { redactText } from '../logging.js';
import { notifyDevices } from '../notify.js';
import { LANGUAGES, languageOf } from '../language.js';
import { inviteEmail } from '../emails.js';

// Difficulty is a grade on one scale for every subject: -1 pre-K, 0 kindergarten, 1 to 8. A child starts two
// years below her age (a 7-year-old, in 2nd grade, starts at kindergarten level) unless the parent picks otherwise.
export const SUBJECTS = ['reading', 'math', 'science', 'logic', 'art', 'music'] as const;
export const gradeForAge = (age: number) => Math.max(-1, Math.min(8, Math.round(age) - 7));
const gradeNum = z.number().int().min(-1).max(8);
const levels = z.object({ reading: gradeNum, math: gradeNum, science: gradeNum, logic: gradeNum, art: gradeNum, music: gradeNum }).partial();
const birthMonthFor = (age: number) => { const d = new Date(); d.setMonth(d.getMonth() - Math.round(age * 12)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const ageFrom = (birthMonth: string | null) => { if (!birthMonth) return null; const [y, m] = birthMonth.split('-').map(Number); const d = new Date(); return Math.max(0, Math.floor(((d.getFullYear() - y) * 12 + (d.getMonth() + 1 - m)) / 12)); };
const theme = z.object({ colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(4).optional(), interests: z.array(z.string().max(30)).max(8).optional() });
const childBody = z.object({
  firstName: z.string().trim().min(1).max(30),
  grade: z.enum(['pre-k', 'k', '1', '2', '3', '4', '5', '6', '7', '8']).nullable().optional(),
  age: z.number().min(1).max(16).optional(),
  startGrade: gradeNum.optional(),
  levels: levels.optional(),
  theme: theme.optional(),
  // Her own language; null uses the family's.
  language: z.enum(LANGUAGES).nullable().optional(),
});

export const childRow = (r: any) => r && ({ id: r.id, firstName: r.first_name, grade: r.grade, age: ageFrom(r.birth_month), levels: r.levels, theme: r.theme, language: r.language ?? null });

// Stars earned across apps minus what the avatar shop spent; null when the child has no avatar or stars yet.
export const starsOf = async (q: Q, childId: string, avatar: { spent?: number } | null) => {
  const earned = (await q.one<{ n: number }>('SELECT COALESCE(SUM(earned), 0)::int AS n FROM child_stars WHERE child_id = $1', [childId]))!.n;
  return { earned, spent: Math.max(0, Number(avatar?.spent ?? 0) | 0), balance: Math.max(0, earned - (Number(avatar?.spent ?? 0) | 0)) };
};

// The child's pictures (her portrait from My Avatar, her home background) are private in storage. Signed links
// (30 days) go into device configs and portal rows. The key is part of the signature, so a new picture gets a new link.
export type ChildImage = 'portrait' | 'background';
const IMAGE_COLUMN: Record<ChildImage, 'portrait_key' | 'background_key'> = { portrait: 'portrait_key', background: 'background_key' };
export const portraitPath = (childId: string) => `/children/${childId}/portrait`;
export const portraitSign = (secret: string, childId: string, key: string, exp: number) => hashToken(`${childId}/${key}/${exp}`, secret).slice(0, 32);
export const childImageUrl = (cfg: { PUBLIC_URL: string; SESSION_SECRET: string }, childId: string, kind: ChildImage, key: string | null) => {
  if (!key) return null;
  const exp = linkExpiry();
  // v names the stored picture: the tablet keeps its own copy of each picture and downloads again only when v changes
  // (the expiry and signature change every 15 days for the same picture).
  return `${cfg.PUBLIC_URL}/children/${childId}/${kind}?exp=${exp}&sig=${portraitSign(cfg.SESSION_SECRET, childId, key, exp)}&v=${sha256(key).slice(0, 12)}`;
};
export const portraitUrl = (cfg: { PUBLIC_URL: string; SESSION_SECRET: string }, childId: string, key: string | null) => childImageUrl(cfg, childId, 'portrait', key);
export const backgroundUrl = (cfg: { PUBLIC_URL: string; SESSION_SECRET: string }, childId: string, key: string | null) => childImageUrl(cfg, childId, 'background', key);

/** Every stored file that belongs to the family or one child: pictures, request attachments and diagnostics reports, for deletion. */
export async function storedFilesOf(q: Q, where: { familyId?: string; childId?: string }): Promise<string[]> {
  const rows = where.childId
    ? await q.all<{ k: string | null }>('SELECT unnest(ARRAY[portrait_key, background_key]) AS k FROM child WHERE id = $1', [where.childId])
    : await q.all<{ k: string | null }>(`SELECT unnest(ARRAY[portrait_key, background_key]) AS k FROM child WHERE family_id = $1
        UNION ALL SELECT storage_key FROM request_attachment WHERE family_id = $1
        UNION ALL SELECT storage_key FROM diagnostic_report WHERE family_id = $1`, [where.familyId]);
  return rows.map((r) => r.k).filter((k): k is string => !!k);
}
async function removeStored(ctx: Ctx, keys: string[]) {
  for (const k of keys) { try { await ctx.storage.delete(k); } catch { /* the rows are gone; a stray file is retried by nothing and costs little */ } }
}

// A child row for parents: profile, stars, portrait link.
export const childWithExtras = async (ctx: Ctx, q: Q, r: any) => ({ ...childRow(r), stars: await starsOf(q, r.id, r.avatar), portraitUrl: portraitUrl(ctx.cfg, r.id, r.portrait_key), backgroundUrl: backgroundUrl(ctx.cfg, r.id, r.background_key), avatarSavedAt: r.avatar_saved_at ?? null });

const DEVICE_COLUMNS = `id, child_id AS "childId", platform, name, state, shell_version AS "shellVersion", battery, last_seen_at AS "lastSeenAt"`;

export default async function familyRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/family', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => ({
      familyId: a.familyId, you: a.email,
      // The owner's stats page is offered to the emails in STATS_EMAILS.
      stats: ctx.cfg.STATS_EMAILS.includes(a.email.toLowerCase()),
      language: (await q.one<{ language: string }>('SELECT language FROM family WHERE id = $1', [a.familyId]))!.language,
      pinSet: !!(await q.one<{ pin_hash: string | null }>('SELECT pin_hash FROM family WHERE id = $1', [a.familyId]))?.pin_hash,
      subscription: await entitlementOf(q, a.familyId),
      // Whether card payments (Stripe) are offered, and whether this family has a Stripe customer to manage.
      cardPayments: !!ctx.stripe,
      cardCustomer: !!(await q.one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM family WHERE id = $1', [a.familyId]))?.stripe_customer_id,
      parents: await q.all('SELECT id, email, role FROM parent ORDER BY created_at'),
      children: await Promise.all((await q.all('SELECT * FROM child ORDER BY created_at')).map((r) => childWithExtras(ctx, q, r))),
      devices: await q.all(`SELECT ${DEVICE_COLUMNS} FROM device ORDER BY created_at`),
    }));
  });

  // The parent PIN guards the parent area on every tablet. Set here or on the first tablet; the device config carries
  // the shells' form of the hash so a change here reaches every tablet at its next check-in.
  app.put('/family/pin', async (req) => {
    const a = await parentAuth(ctx, req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{4,6}$/, 'Four to six digits') }).parse(req.body);
    await ctx.db.family(a.familyId, async (q) => {
      await q.run('UPDATE family SET pin_hash = $1, pin_sync = $2, pin_set_at = now() WHERE id = $3', [hashToken(pin, ctx.cfg.SESSION_SECRET), sha256(`duckling:${pin}`), a.familyId]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'pin.set');
    });
    void notifyDevices(ctx, a.familyId);
    return { set: true };
  });

  // The family's language: its tablets, the portal and the emails. A child with her own keeps hers.
  app.put('/family/language', async (req) => {
    const a = await parentAuth(ctx, req);
    const { language } = z.object({ language: z.enum(LANGUAGES) }).parse(req.body);
    await ctx.db.family(a.familyId, async (q) => {
      await q.run('UPDATE family SET language = $1 WHERE id = $2', [language, a.familyId]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'family.language', { language });
    });
    void notifyDevices(ctx, a.familyId);
    return { language };
  });

  // A second parent: the address gets a sign-in link that joins this family. Up to four parents.
  app.post('/family/parents/invite', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const a = await parentAuth(ctx, req);
    const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
    const token = newToken();
    await ctx.db.family(a.familyId, async (q) => {
      const n = (await q.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM parent'))!.n;
      if (n >= 4) throw new HttpError(409, 'A family can have four parents.');
      if (await q.one('SELECT 1 FROM parent WHERE lower(email) = lower($1)', [email])) throw new HttpError(409, 'That address is already in your family.');
      await q.run('SELECT create_invite_token($1, $2, $3, $4)', [hashToken(token, ctx.cfg.SESSION_SECRET), email.trim(), inDays(7), a.familyId]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'parent.invited');
    });
    const link = `${ctx.cfg.PORTAL_URL}/signin?token=${token}`;
    const lang = languageOf((await ctx.db.family(a.familyId, (q) => q.one<{ language: string }>('SELECT language FROM family WHERE id = $1', [a.familyId])))?.language);
    try {
      const m = inviteEmail(lang, a.email, link);
      await ctx.mailer.send(email, m.subject, m.body);
    } catch (err) {
      req.log.error({ err: { type: (err as Error).name, code: (err as { code?: string }).code, message: redactText((err as Error).message) } }, 'invite email failed');
      throw new HttpError(503, 'We could not send the email right now. Please try again in a minute.');
    }
    return { sent: true };
  });

  app.delete<{ Params: { id: string } }>('/family/parents/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    if (req.params.id === a.parentId) throw new HttpError(400, 'You cannot remove yourself. Another parent can, or delete the account.');
    return ctx.db.family(a.familyId, async (q) => {
      const n = await q.run('DELETE FROM parent WHERE id = $1', [req.params.id]);
      if (!n) throw notFound('No such parent');
      await audit(q, a.familyId, `parent:${a.parentId}`, 'parent.removed', { id: req.params.id });
      return { ok: true };
    });
  });

  // The child's pictures (portrait, home background): parents with a session, and signed links from configs and portal rows.
  for (const kind of ['portrait', 'background'] as const) {
    const col = IMAGE_COLUMN[kind];
    app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(`/children/:id/${kind}`, async (req, reply) => {
      const { id } = req.params;
      const exp = Number(req.query.exp), sig = String(req.query.sig ?? '');
      let key: string | null | undefined, signed = false;
      if (Number.isFinite(exp) && exp > Date.now() && sig.length === 32) {
        signed = true;
        key = (await ctx.db.system((q) => q.one<Record<string, string | null>>(`SELECT ${col} AS k FROM child WHERE id = $1`, [id])))?.k;
        if (!key || !safeEqual(sig, portraitSign(ctx.cfg.SESSION_SECRET, id, key, exp))) throw notFound(`No ${kind}`);
      } else {
        const a = await parentAuth(ctx, req);
        key = (await ctx.db.family(a.familyId, (q) => q.one<Record<string, string | null>>(`SELECT ${col} AS k FROM child WHERE id = $1`, [id])))?.k;
      }
      if (!key) throw notFound(`No ${kind}`);
      const bytes = await ctx.storage.get(key);
      if (!bytes) throw notFound(`No ${kind}`);
      // A signed link names one stored picture (the signature covers its key), so it can be kept for as long as it works.
      reply.header('Cache-Control', signed ? 'private, max-age=2592000, immutable' : 'private, no-cache').type(key.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
      return reply.send(bytes);
    });
  }

  app.post('/children', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = childBody.parse(req.body);
    const id = newId('chd');
    // Every subject starts at startGrade, else two years below the age, else kindergarten; explicit levels win.
    const start = b.startGrade ?? (b.age !== undefined ? gradeForAge(b.age) : 0);
    const levels = { ...Object.fromEntries(SUBJECTS.map((s) => [s, start])), ...(b.levels ?? {}) };
    return ctx.db.family(a.familyId, async (q) => {
      await q.run('INSERT INTO child (id, family_id, first_name, grade, birth_month, levels, theme, language) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)',
        [id, a.familyId, b.firstName, b.grade ?? null, b.age !== undefined ? birthMonthFor(b.age) : null, JSON.stringify(levels), JSON.stringify(b.theme ?? {}), b.language ?? null]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.created', { id });
      return childRow(await q.one('SELECT * FROM child WHERE id = $1', [id]));
    });
  });

  app.put<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = childBody.partial().parse(req.body);
    return ctx.db.family(a.familyId, async (q) => {
      const cur = await q.one('SELECT * FROM child WHERE id = $1', [req.params.id]);
      if (!cur) throw notFound('No such child');
      const levels = b.startGrade !== undefined ? Object.fromEntries(SUBJECTS.map((s) => [s, b.startGrade])) : { ...cur.levels, ...(b.levels ?? {}) };
      await q.run('UPDATE child SET first_name = $1, grade = $2, levels = $3::jsonb, theme = $4::jsonb, birth_month = $6, language = $7 WHERE id = $5', [
        b.firstName ?? cur.first_name, b.grade === undefined ? cur.grade : b.grade,
        JSON.stringify(levels), JSON.stringify(b.theme ?? cur.theme), cur.id, b.age !== undefined ? birthMonthFor(b.age) : cur.birth_month,
        b.language === undefined ? cur.language : b.language]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.updated', { id: cur.id });
      return childRow(await q.one('SELECT * FROM child WHERE id = $1', [cur.id]));
    }).then((r) => { void notifyDevices(ctx, a.familyId); return r; });
  });

  app.delete<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    const files = await ctx.db.family(a.familyId, async (q) => {
      const keys = await storedFilesOf(q, { childId: req.params.id });
      const n = await q.run('DELETE FROM child WHERE id = $1', [req.params.id]);
      if (!n) throw notFound('No such child');
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.deleted', { id: req.params.id });
      return keys;
    });
    await removeStored(ctx, files);
    return { ok: true };
  });

  // Delete account and all data: every device is told to release itself on its next check-in, then the family's
  // records go. Tombstones are a global table, so this is system work. A card subscription (Stripe) is cancelled
  // here first; App Store and Google Play subscriptions are cancelled in Apple's or Google's own screens, which the
  // portal points to.
  app.delete('/family', async (req) => {
    const a = await parentAuth(ctx, req);
    z.object({ confirm: z.literal('DELETE') }).parse(req.body);
    const customer = (await ctx.db.family(a.familyId, (q) => q.one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM family WHERE id = $1', [a.familyId])))?.stripe_customer_id;
    if (customer) {
      if (!ctx.stripe) throw new HttpError(503, 'The card subscription could not be cancelled right now. Try again later.');
      try {
        for (const s of await ctx.stripe.subscriptionsOf(customer)) if (!['canceled', 'incomplete_expired'].includes(s.status)) await ctx.stripe.cancel(s.id);
      } catch { throw new HttpError(503, 'The card subscription could not be cancelled right now. Try again later.'); }
    }
    const files = await ctx.db.system(async (q) => {
      const keys = await storedFilesOf(q, { familyId: a.familyId });
      await q.run('INSERT INTO device_tombstone (token_hash) SELECT token_hash FROM device WHERE family_id = $1 ON CONFLICT DO NOTHING', [a.familyId]);
      await q.run('DELETE FROM family WHERE id = $1', [a.familyId]);
      await q.run('DELETE FROM audit WHERE family_id = $1', [a.familyId]);
      await audit(q, null, 'system', 'family.deleted');
      return keys;
    });
    // The pictures and request attachments go after the records, so a failed delete never leaves a record without its file.
    await removeStored(ctx, files);
    return { deleted: true };
  });
}
