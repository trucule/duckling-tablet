// Parent sign-in by email link: no passwords. The link opens the parent portal, which posts the token back.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { SESSION_COOKIE, parentAuth } from '../auth.js';
import { HttpError, hashToken, inDays, inMinutes, newId, newToken, now } from '../util.js';

export default async function authRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const h = (t: string) => hashToken(t, ctx.cfg.SESSION_SECRET);

  app.post('/auth/email-link', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
    const token = newToken();
    ctx.db.prepare('INSERT INTO login_token (token_hash, email, expires_at) VALUES (?, ?, ?)').run(h(token), email.trim(), inMinutes(15));
    const link = `${ctx.cfg.PORTAL_URL}/signin?token=${token}`;
    await ctx.mailer.send(email, 'Your Duckling Tablet sign-in link',
      `Tap this link to sign in to Duckling Tablet. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`);
    return { sent: true };
  });

  app.post('/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    const row = ctx.db.prepare('SELECT email, expires_at, used_at FROM login_token WHERE token_hash = ?').get(h(token)) as
      { email: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || row.expires_at < now()) throw new HttpError(401, 'This link has expired. Ask for a new one.');

    const result = ctx.db.transaction(() => {
      ctx.db.prepare('UPDATE login_token SET used_at = ? WHERE token_hash = ?').run(now(), h(token));
      let parent = ctx.db.prepare('SELECT id, family_id FROM parent WHERE email = ?').get(row.email) as { id: string; family_id: string } | undefined;
      let created = false;
      if (!parent) {
        const familyId = newId('fam'), parentId = newId('par');
        ctx.db.prepare('INSERT INTO family (id, created_at) VALUES (?, ?)').run(familyId, now());
        ctx.db.prepare('INSERT INTO parent (id, family_id, email, created_at) VALUES (?, ?, ?, ?)').run(parentId, familyId, row.email, now());
        parent = { id: parentId, family_id: familyId };
        created = true;
      }
      const session = newToken();
      ctx.db.prepare('INSERT INTO session (token_hash, parent_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(h(session), parent.id, now(), inDays(30));
      return { session, parent, created };
    })();

    ctx.audit(result.parent.family_id, `parent:${result.parent.id}`, result.created ? 'family.created' : 'parent.signed_in');
    reply.setCookie(SESSION_COOKIE, result.session, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.NODE_ENV === 'production', maxAge: 30 * 86400,
    });
    return { sessionToken: result.session, parentId: result.parent.id, familyId: result.parent.family_id, newFamily: result.created };
  });

  app.post('/auth/logout', async (req, reply) => {
    const auth = parentAuth(ctx, req);
    const token = req.headers.authorization?.split(' ')[1] ?? req.cookies?.[SESSION_COOKIE];
    if (token) ctx.db.prepare('DELETE FROM session WHERE token_hash = ?').run(h(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    ctx.audit(auth.familyId, `parent:${auth.parentId}`, 'parent.signed_out');
    return { ok: true };
  });
}
