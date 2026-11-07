// The family account: parents, children (profile for the apps) and account deletion.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import type { Q } from '../db.js';
import { parentAuth } from '../auth.js';
import { HttpError, hashToken, inDays, newId, newToken, notFound, safeEqual, sha256 } from '../util.js';
import { redactText } from '../logging.js';
import { notifyDevices } from '../notify.js';

// Starting level per subject, 1 (youngest) to 10; the apps map it to their own level ladders.
const levels = z.record(z.enum(['reading', 'math', 'science', 'art', 'music', 'logic']), z.number().int().min(1).max(10));
const theme = z.object({ colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(4).optional(), interests: z.array(z.string().max(30)).max(8).optional() });
const childBody = z.object({
  firstName: z.string().trim().min(1).max(30),
  grade: z.enum(['pre-k', 'k', '1', '2', '3', '4', '5', '6']).nullable().optional(),
  levels: levels.optional(),
  theme: theme.optional(),
});

export const childRow = (r: any) => r && ({ id: r.id, firstName: r.first_name, grade: r.grade, levels: r.levels, theme: r.theme });

// Stars earned across apps minus what the avatar shop spent; null when the child has no avatar or stars yet.
export const starsOf = async (q: Q, childId: string, avatar: { spent?: number } | null) => {
  const earned = (await q.one<{ n: number }>('SELECT COALESCE(SUM(earned), 0)::int AS n FROM child_stars WHERE child_id = $1', [childId]))!.n;
  return { earned, spent: Math.max(0, Number(avatar?.spent ?? 0) | 0), balance: Math.max(0, earned - (Number(avatar?.spent ?? 0) | 0)) };
};

// The portrait is private in storage. Signed links (30 days) go into device configs and portal rows.
export const portraitPath = (childId: string) => `/children/${childId}/portrait`;
export const portraitSign = (secret: string, childId: string, key: string, exp: number) => hashToken(`${childId}/${key}/${exp}`, secret).slice(0, 32);
export const portraitUrl = (cfg: { PUBLIC_URL: string; SESSION_SECRET: string }, childId: string, key: string | null) => {
  if (!key) return null;
  const exp = Date.now() + 30 * 86_400_000;
  return `${cfg.PUBLIC_URL}${portraitPath(childId)}?exp=${exp}&sig=${portraitSign(cfg.SESSION_SECRET, childId, key, exp)}`;
};

// A child row for parents: profile, stars, portrait link.
export const childWithExtras = async (ctx: Ctx, q: Q, r: any) => ({ ...childRow(r), stars: await starsOf(q, r.id, r.avatar), portraitUrl: portraitUrl(ctx.cfg, r.id, r.portrait_key), avatarSavedAt: r.avatar_saved_at ?? null });

const DEVICE_COLUMNS = `id, child_id AS "childId", platform, name, state, shell_version AS "shellVersion", battery, last_seen_at AS "lastSeenAt"`;

export default async function familyRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/family', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => ({
      familyId: a.familyId, you: a.email,
      pinSet: !!(await q.one<{ pin_hash: string | null }>('SELECT pin_hash FROM family WHERE id = $1', [a.familyId]))?.pin_hash,
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
    try {
      await ctx.mailer.send(email, 'You are invited to a Duckling Tablet family',
        `${a.email} invited you to manage their family's Duckling tablets. Open this link to join; it works once and expires in 7 days.\n\n${link}\n\nIf you were not expecting this, you can ignore this email.`);
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

  // The child's portrait, drawn in My Avatar: parents with a session, and signed links from configs and portal rows.
  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>('/children/:id/portrait', async (req, reply) => {
    const { id } = req.params;
    const exp = Number(req.query.exp), sig = String(req.query.sig ?? '');
    let row: { portrait_key: string | null } | null | undefined;
    if (Number.isFinite(exp) && exp > Date.now() && sig.length === 32) {
      row = await ctx.db.system((q) => q.one('SELECT portrait_key FROM child WHERE id = $1', [id]));
      if (!row?.portrait_key || !safeEqual(sig, portraitSign(ctx.cfg.SESSION_SECRET, id, row.portrait_key, exp))) throw notFound('No portrait');
    } else {
      const a = await parentAuth(ctx, req);
      row = await ctx.db.family(a.familyId, (q) => q.one('SELECT portrait_key FROM child WHERE id = $1', [id]));
    }
    if (!row?.portrait_key) throw notFound('No portrait');
    const bytes = await ctx.storage.get(row.portrait_key);
    if (!bytes) throw notFound('No portrait');
    reply.header('Cache-Control', 'private, max-age=3600').type('image/png');
    return reply.send(bytes);
  });

  app.post('/children', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = childBody.parse(req.body);
    const id = newId('chd');
    return ctx.db.family(a.familyId, async (q) => {
      await q.run('INSERT INTO child (id, family_id, first_name, grade, levels, theme) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)',
        [id, a.familyId, b.firstName, b.grade ?? null, JSON.stringify(b.levels ?? {}), JSON.stringify(b.theme ?? {})]);
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
      await q.run('UPDATE child SET first_name = $1, grade = $2, levels = $3::jsonb, theme = $4::jsonb WHERE id = $5', [
        b.firstName ?? cur.first_name, b.grade === undefined ? cur.grade : b.grade,
        JSON.stringify(b.levels ?? cur.levels), JSON.stringify(b.theme ?? cur.theme), cur.id]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.updated', { id: cur.id });
      return childRow(await q.one('SELECT * FROM child WHERE id = $1', [cur.id]));
    }).then((r) => { void notifyDevices(ctx, a.familyId); return r; });
  });

  app.delete<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => {
      const n = await q.run('DELETE FROM child WHERE id = $1', [req.params.id]);
      if (!n) throw notFound('No such child');
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.deleted', { id: req.params.id });
      return { ok: true };
    });
  });

  // Delete account and all data: every device is told to release itself on its next check-in, then the family's
  // records go. Tombstones are a global table, so this is system work. (Store subscriptions are cancelled in
  // Apple's or Google's own screens; Stripe is cancelled by the billing module.)
  app.delete('/family', async (req) => {
    const a = await parentAuth(ctx, req);
    z.object({ confirm: z.literal('DELETE') }).parse(req.body);
    await ctx.db.system(async (q) => {
      await q.run('INSERT INTO device_tombstone (token_hash) SELECT token_hash FROM device WHERE family_id = $1 ON CONFLICT DO NOTHING', [a.familyId]);
      await q.run('DELETE FROM family WHERE id = $1', [a.familyId]);
      await q.run('DELETE FROM audit WHERE family_id = $1', [a.familyId]);
      await audit(q, null, 'system', 'family.deleted');
    });
    return { deleted: true };
  });
}
