// Parent sign-in by email link: no passwords. The link opens the parent portal, which posts the token back.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { SESSION_COOKIE, parentAuth, sessionToken } from '../auth.js';
import { HttpError, hashToken, inDays, inMinutes, newId, newToken } from '../util.js';
import { redactText } from '../logging.js';
import { randomInt } from 'node:crypto';
import { deviceConfig } from './devices.js';
import { SUBJECTS, gradeForAge } from './family.js';

export default async function authRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const h = (t: string) => hashToken(t, ctx.cfg.SESSION_SECRET);

  app.post('/auth/email-link', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email, source } = z.object({ email: z.string().email().max(254), source: z.enum(['portal', 'tablet']).default('portal') }).parse(req.body);
    const token = newToken();
    await ctx.db.query('SELECT create_login_token($1, $2, $3)', [h(token), email.trim(), inMinutes(15)]);
    const link = `${ctx.cfg.PORTAL_URL}/signin?token=${token}`;
    try {
      const body = source === 'tablet'
        ? `You started setting up Duckling Tablet on a tablet. Open this link on your phone or computer to set up your family; it works once and expires in 15 minutes.\n\n${link}\n\nThen add your child, press Add a device, and type the six-digit code it shows into the tablet.\n\nIf you did not ask for this, you can ignore this email.`
        : `Tap this link to sign in to Duckling Tablet. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`;
      await ctx.mailer.send(email, source === 'tablet' ? 'Set up your Duckling Tablet family' : 'Your Duckling Tablet sign-in link', body);
    } catch (err) {
      // The address and the link stay out of the log; the mail server's own message is enough to diagnose.
      req.log.error({ err: { type: (err as Error).name, code: (err as { code?: string }).code, message: redactText((err as Error).message) } }, 'sign-in email failed');
      throw new HttpError(503, 'We could not send the email right now. Please try again in a minute.');
    }
    return { sent: true };
  });

  // ---- One-device signup from a tablet: a six-digit code by email, then the tablet is paired in the same step.
  app.post('/auth/code', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await ctx.db.query('SELECT create_login_code($1, $2, $3, $4)', [newId('lc'), email.trim(), h(code), inMinutes(10)]);
    try {
      await ctx.mailer.send(email, `${code.slice(0, 3)} ${code.slice(3)} is your Duckling Tablet code`,
        `Type this code on the tablet to finish setting up Duckling Tablet:\n\n    ${code.slice(0, 3)} ${code.slice(3)}\n\nIt works once and expires in 10 minutes. If you did not ask for this, you can ignore this email.`);
    } catch (err) {
      req.log.error({ err: { type: (err as Error).name, code: (err as { code?: string }).code, message: redactText((err as Error).message) } }, 'code email failed');
      throw new HttpError(503, 'We could not send the email right now. Please try again in a minute.');
    }
    return { sent: true };
  });

  // The code, the child's first name and the tablet's details in one call: the family exists (new, with its free
  // trial, or the parent's existing one), the child is there, and the tablet is paired with the starter apps.
  app.post('/auth/code/pair', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const b = z.object({
      email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/),
      childFirstName: z.string().trim().min(1).max(40).optional(), childAge: z.number().min(1).max(16).optional(),
      platform: z.enum(['android', 'ios', 'windows', 'web']), name: z.string().trim().min(1).max(60), shellVersion: z.string().max(30).optional(),
    }).parse(req.body);
    const devId = newId('dev'), devToken = newToken();
    // The code check commits on its own, so a miss is counted and a match is used up whatever happens next.
    const [{ ok }] = await ctx.db.query('SELECT redeem_login_code($1, $2) AS ok', [b.email.trim(), h(b.code)]) as { ok: boolean }[];
    if (!ok) throw new HttpError(401, 'That code is not right or has expired. Check the email, or ask for a new code.');
    return ctx.db.app(async (q) => {
      const parent = (await q.one<{ parent_id: string; family_id: string; created: boolean }>(
        'SELECT parent_id, family_id, created FROM find_or_create_parent($1, $2, $3)', [b.email.trim(), newId('fam'), newId('par')]))!;
      if (parent.created) await q.run('SELECT start_trial($1, $2)', [parent.family_id, ctx.cfg.TRIAL_DAYS]);
      await q.setFamily(parent.family_id);
      let childId: string | null = null;
      if (b.childFirstName) {
        const existing = await q.one<{ id: string }>('SELECT id FROM child WHERE lower(first_name) = lower($1) ORDER BY created_at LIMIT 1', [b.childFirstName]);
        if (existing) childId = existing.id;
        else {
          childId = newId('chd');
          // Every subject starts two years below the child's age (kindergarten level when the age is unknown).
          const start = b.childAge !== undefined ? gradeForAge(b.childAge) : 0;
          const bm = b.childAge !== undefined ? (() => { const d = new Date(); d.setMonth(d.getMonth() - Math.round(b.childAge! * 12)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })() : null;
          await q.run("INSERT INTO child (id, family_id, first_name, birth_month, levels, theme) VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb)",
            [childId, parent.family_id, b.childFirstName, bm, JSON.stringify(Object.fromEntries(SUBJECTS.map((s) => [s, start])))]);
          await audit(q, parent.family_id, `parent:${parent.parent_id}`, 'child.created', { id: childId });
        }
      }
      await q.run(`INSERT INTO device (id, family_id, child_id, platform, name, token_hash, shell_version, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())`, [devId, parent.family_id, childId, b.platform, b.name, hashToken(devToken, ctx.cfg.SESSION_SECRET), b.shellVersion ?? null]);
      await q.run('INSERT INTO device_app (family_id, device_id, app_id) SELECT $1, $2, id FROM app WHERE starter ON CONFLICT DO NOTHING', [parent.family_id, devId]);
      await audit(q, parent.family_id, `device:${devId}`, parent.created ? 'family.created' : 'device.paired', { platform: b.platform, name: b.name, via: 'code' });
      return { deviceId: devId, deviceToken: devToken, newFamily: parent.created, config: await deviceConfig(ctx, q, devId) };
    });
  });

  app.post('/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    // One transaction: redeem the link, find or create the parent, then scope to the family and open the session.
    const result = await ctx.db.app(async (q) => {
      const link = await q.one<{ email: string; invite_family_id: string | null }>('SELECT email, invite_family_id FROM redeem_login_token($1)', [h(token)]);
      if (!link) throw new HttpError(401, 'This link has expired. Ask for a new one.');
      let parent: { parent_id: string; family_id: string; created: boolean; joined?: boolean };
      if (link.invite_family_id) {
        // An invite: the address joins the inviting family. An address that already has a family of its own cannot.
        const j = (await q.one<{ parent_id: string; family_id: string; joined: boolean }>(
          'SELECT parent_id, family_id, joined FROM join_family($1, $2, $3)', [link.email, link.invite_family_id, newId('par')]))!;
        if (!j.joined) throw new HttpError(409, 'This email address already has a Duckling family of its own. Sign in with it, or ask for the invite at another address.');
        parent = { ...j, created: false };
      } else {
        parent = (await q.one<{ parent_id: string; family_id: string; created: boolean }>(
          'SELECT parent_id, family_id, created FROM find_or_create_parent($1, $2, $3)', [link.email, newId('fam'), newId('par')]))!;
        if (parent.created) await q.run('SELECT start_trial($1, $2)', [parent.family_id, ctx.cfg.TRIAL_DAYS]);
      }
      await q.setFamily(parent.family_id);
      const session = newToken();
      await q.run('INSERT INTO session (token_hash, parent_id, family_id, expires_at) VALUES ($1, $2, $3, $4)', [h(session), parent.parent_id, parent.family_id, inDays(30)]);
      await audit(q, parent.family_id, `parent:${parent.parent_id}`, parent.created ? 'family.created' : link.invite_family_id ? 'parent.joined' : 'parent.signed_in');
      return { session, parentId: parent.parent_id, familyId: parent.family_id, created: parent.created };
    });

    reply.setCookie(SESSION_COOKIE, result.session, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.NODE_ENV === 'production', maxAge: 30 * 86400,
    });
    return { sessionToken: result.session, parentId: result.parentId, familyId: result.familyId, newFamily: result.created };
  });

  app.post('/auth/logout', async (req, reply) => {
    const a = await parentAuth(ctx, req);
    const token = sessionToken(req);
    await ctx.db.family(a.familyId, async (q) => {
      if (token) await q.run('DELETE FROM session WHERE token_hash = $1', [h(token)]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'parent.signed_out');
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
