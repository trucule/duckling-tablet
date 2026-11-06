// Parent sign-in by email link: no passwords. The link opens the parent portal, which posts the token back.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { SESSION_COOKIE, parentAuth, sessionToken } from '../auth.js';
import { HttpError, hashToken, inDays, inMinutes, newId, newToken } from '../util.js';
import { redactText } from '../logging.js';

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

  app.post('/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    // One transaction: redeem the link, find or create the parent, then scope to the family and open the session.
    const result = await ctx.db.app(async (q) => {
      const link = await q.one<{ email: string }>('SELECT email FROM redeem_login_token($1)', [h(token)]);
      if (!link) throw new HttpError(401, 'This link has expired. Ask for a new one.');
      const parent = (await q.one<{ parent_id: string; family_id: string; created: boolean }>(
        'SELECT parent_id, family_id, created FROM find_or_create_parent($1, $2, $3)', [link.email, newId('fam'), newId('par')]))!;
      await q.setFamily(parent.family_id);
      const session = newToken();
      await q.run('INSERT INTO session (token_hash, parent_id, family_id, expires_at) VALUES ($1, $2, $3, $4)', [h(session), parent.parent_id, parent.family_id, inDays(30)]);
      await audit(q, parent.family_id, `parent:${parent.parent_id}`, parent.created ? 'family.created' : 'parent.signed_in');
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
