// Parent sign-in by email link: no passwords. The link opens the parent portal, which posts the token back.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { SESSION_COOKIE, parentAuth, sessionToken } from '../auth.js';
import { HttpError, hashToken, inDays, inMinutes, newId, newToken } from '../util.js';
import { redactText } from '../logging.js';
import { languageOf } from '../language.js';
import { portalCodeEmail, signInLinkEmail, tabletCodeEmail } from '../emails.js';
import { randomInt } from 'node:crypto';
import { deviceConfig } from './devices.js';
import { SUBJECTS, gradeForAge } from './family.js';
import { PROVIDERS, TokenError, type IdClaims, type Provider } from '../idtoken.js';

export default async function authRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const h = (t: string) => hashToken(t, ctx.cfg.SESSION_SECRET);

  app.post('/auth/email-link', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email, source, delivery, language } = z.object({
      email: z.string().email().max(254), source: z.enum(['portal', 'tablet']).default('portal'),
      // The asking browser's or tablet's language (navigator.language); the email is written in it.
      language: z.string().max(35).optional(),
      // 'code' comes from the portal running as an iPhone or iPad home-screen app (navigator.standalone). iOS opens a
      // mail link in Safari, which keeps its own sign-in, so that app gets a six-digit code to type in instead.
      delivery: z.enum(['link', 'code']).default('link'),
    }).parse(req.body);
    // The store review family has no real inbox: on the website, in any browser, it gets the code box and signs in
    // with the fixed review code (POST /auth/code/verify), and no email goes out.
    if (isReviewer(email)) return { sent: true, delivery: 'code' };
    try {
      if (source === 'portal' && delivery === 'code') {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await ctx.db.query('SELECT create_login_code($1, $2, $3, $4)', [newId('lc'), email.trim(), h(code), inMinutes(15)]);
        const m = portalCodeEmail(languageOf(language), code);
        await ctx.mailer.send(email, m.subject, m.body);
        return { sent: true, delivery: 'code' };
      }
      const token = newToken();
      await ctx.db.query('SELECT create_login_token($1, $2, $3)', [h(token), email.trim(), inMinutes(15)]);
      const link = `${ctx.cfg.PORTAL_URL}/signin?token=${token}`;
      const m = signInLinkEmail(languageOf(language), source, link);
      await ctx.mailer.send(email, m.subject, m.body);
    } catch (err) {
      // The address and the link stay out of the log; the mail server's own message is enough to diagnose.
      req.log.error({ err: { type: (err as Error).name, code: (err as { code?: string }).code, message: redactText((err as Error).message) } }, 'sign-in email failed');
      throw new HttpError(503, 'We could not send the email right now. Please try again in a minute.');
    }
    return { sent: true, delivery: 'link' };
  });

  // The store review family (REVIEW_EMAIL and REVIEW_CODE in the environment): that one address gets no code by
  // mail and is signed in by the fixed code. Off unless both values are set.
  const isReviewer = (email: string) => !!ctx.cfg.REVIEW_EMAIL && !!ctx.cfg.REVIEW_CODE
    && email.trim().toLowerCase() === ctx.cfg.REVIEW_EMAIL.toLowerCase();

  // ---- One-device signup from a tablet: a six-digit code by email, then the tablet is paired in the same step.
  app.post('/auth/code', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email, language } = z.object({ email: z.string().email().max(254), language: z.string().max(35).optional() }).parse(req.body);
    if (isReviewer(email)) return { sent: true };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await ctx.db.query('SELECT create_login_code($1, $2, $3, $4)', [newId('lc'), email.trim(), h(code), inMinutes(10)]);
    try {
      const m = tabletCodeEmail(languageOf(language), code);
      await ctx.mailer.send(email, m.subject, m.body);
    } catch (err) {
      req.log.error({ err: { type: (err as Error).name, code: (err as { code?: string }).code, message: redactText((err as Error).message) } }, 'code email failed');
      throw new HttpError(503, 'We could not send the email right now. Please try again in a minute.');
    }
    return { sent: true };
  });

  // A tablet paired to a parent's family as it signs up: the family's language for a new family, the child (found by
  // first name, or made with levels from her age), the device with its token, and the starter apps.
  const tabletBody = z.object({
    childFirstName: z.string().trim().min(1).max(40).optional(), childAge: z.number().min(1).max(16).optional(),
    platform: z.enum(['android', 'ios', 'windows', 'web']), name: z.string().trim().min(1).max(60), shellVersion: z.string().max(30).optional(),
    // The tablet's language; a new family starts with it.
    language: z.string().max(35).optional(),
  });
  async function pairTablet(q: Parameters<Parameters<typeof ctx.db.app>[0]>[0], parent: { parent_id: string; family_id: string; created: boolean }, b: z.infer<typeof tabletBody>, via: string) {
    const devId = newId('dev'), devToken = newToken();
    await q.setFamily(parent.family_id);
    if (parent.created) await q.run('UPDATE family SET language = $1 WHERE id = $2', [languageOf(b.language), parent.family_id]);
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
    await audit(q, parent.family_id, `device:${devId}`, parent.created ? 'family.created' : 'device.paired', { platform: b.platform, name: b.name, via });
    return { deviceId: devId, deviceToken: devToken, newFamily: parent.created, config: await deviceConfig(ctx, q, devId) };
  }

  // The code, the child's first name and the tablet's details in one call: the family exists (new, with its free
  // trial, or the parent's existing one), the child is there, and the tablet is paired with the starter apps.
  app.post('/auth/code/pair', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const b = tabletBody.extend({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    // The code check commits on its own, so a miss is counted and a match is used up whatever happens next.
    const [{ ok }] = isReviewer(b.email) ? [{ ok: b.code === ctx.cfg.REVIEW_CODE }]
      : await ctx.db.query('SELECT redeem_login_code($1, $2) AS ok', [b.email.trim(), h(b.code)]) as { ok: boolean }[];
    if (!ok) throw new HttpError(401, 'That code is not right or has expired. Check the email, or ask for a new code.');
    return ctx.db.app(async (q) => {
      const parent = (await q.one<{ parent_id: string; family_id: string; created: boolean }>(
        'SELECT parent_id, family_id, created FROM find_or_create_parent($1, $2, $3)', [b.email.trim(), newId('fam'), newId('par')]))!;
      // The review family keeps full access for as long as reviews happen (ten years); every other family gets the trial.
      if (parent.created) await q.run('SELECT start_trial($1, $2)', [parent.family_id, isReviewer(b.email) ? 3650 : ctx.cfg.TRIAL_DAYS]);
      return pairTablet(q, parent, b, 'code');
    });
  });

  app.post('/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { token, language } = z.object({ token: z.string().min(20).max(200), language: z.string().max(35).optional() }).parse(req.body);
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
      return openSession(q, parent, link.invite_family_id ? 'parent.joined' : undefined, languageOf(language));
    });
    return sessionReply(reply, result);
  });

  // The code from the sign-in email sent to the portal on an iPhone or iPad home screen, typed there.
  app.post('/auth/code/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const b = z.object({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/), language: z.string().max(35).optional() }).parse(req.body);
    // The code check commits on its own, so a miss is counted and a match is used up whatever happens next.
    const [{ ok }] = isReviewer(b.email) ? [{ ok: b.code === ctx.cfg.REVIEW_CODE }]
      : await ctx.db.query('SELECT redeem_login_code($1, $2) AS ok', [b.email.trim(), h(b.code)]) as { ok: boolean }[];
    if (!ok) throw new HttpError(401, 'That code is not right or has expired. Check the email, or ask for a new one.');
    const result = await ctx.db.app(async (q) => {
      const parent = (await q.one<{ parent_id: string; family_id: string; created: boolean }>(
        'SELECT parent_id, family_id, created FROM find_or_create_parent($1, $2, $3)', [b.email.trim(), newId('fam'), newId('par')]))!;
      if (parent.created) await q.run('SELECT start_trial($1, $2)', [parent.family_id, isReviewer(b.email) ? 3650 : ctx.cfg.TRIAL_DAYS]);
      return openSession(q, parent, undefined, languageOf(b.language));
    });
    return sessionReply(reply, result);
  });

  type Parent = { parent_id: string; family_id: string; created: boolean };
  // A family made here starts in the language of the browser that signed in.
  async function openSession(q: Parameters<Parameters<typeof ctx.db.app>[0]>[0], parent: Parent, event?: string, language?: string) {
    await q.setFamily(parent.family_id);
    if (parent.created && language) await q.run('UPDATE family SET language = $1 WHERE id = $2', [language, parent.family_id]);
    const session = newToken();
    await q.run('INSERT INTO session (token_hash, parent_id, family_id, expires_at) VALUES ($1, $2, $3, $4)', [h(session), parent.parent_id, parent.family_id, inDays(30)]);
    await audit(q, parent.family_id, `parent:${parent.parent_id}`, event ?? (parent.created ? 'family.created' : 'parent.signed_in'));
    return { session, parentId: parent.parent_id, familyId: parent.family_id, created: parent.created };
  }

  function sessionReply(reply: import('fastify').FastifyReply, r: Awaited<ReturnType<typeof openSession>>) {
    reply.setCookie(SESSION_COOKIE, r.session, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.NODE_ENV === 'production', maxAge: 30 * 86400,
    });
    return { sessionToken: r.session, parentId: r.parentId, familyId: r.familyId, newFamily: r.created };
  }

  // ---- Sign in with Apple, Google or Microsoft (idtoken.ts). The provider account is a parent's: found by its
  // subject when it was used before, else by its verified email (the parent who signed in with that address), else a
  // new family with its trial. A tablet that signs in this way joins that family, whatever tablets it already has.
  const audiences = (p: Provider) => (p === 'apple' ? ctx.cfg.APPLE_SIGNIN_CLIENT_IDS : p === 'google' ? ctx.cfg.GOOGLE_SIGNIN_CLIENT_IDS : ctx.cfg.MICROSOFT_SIGNIN_CLIENT_IDS);
  const providerBody = z.object({ provider: z.enum(['apple', 'google', 'microsoft']), idToken: z.string().min(20).max(8000), nonce: z.string().max(200).optional() });

  // Which providers are set up here, with the client ids the portal and the shells ask the provider for.
  app.get('/auth/providers', async () => ({ providers: PROVIDERS.filter((p) => audiences(p).length).map((p) => ({ provider: p, clientIds: audiences(p) })) }));

  // A nonce for the next sign-in, to be put in the provider's request (Apple takes its SHA-256).
  app.get('/auth/nonce', { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { nonce: ctx.nonces.issue() };
  });

  // A token that fails is 400, not 401: the portal signs a parent out on a 401, and a failed link must not.
  async function checked(b: z.infer<typeof providerBody>): Promise<IdClaims> {
    if (!audiences(b.provider).length) throw new HttpError(503, 'That sign-in is not available yet.');
    let c: IdClaims;
    try { c = await ctx.verifyIdToken(b.provider, b.idToken, audiences(b.provider)); }
    catch (e) { if (e instanceof TokenError) throw new HttpError(400, 'That sign-in could not be checked. Try again.'); throw e; }
    // Apple and Google tokens carry a nonce this server issued, once; Microsoft's sign-in library sets its own.
    if (b.provider !== 'microsoft' && !(b.nonce && ctx.nonces.redeem(b.nonce, c.nonce))) throw new HttpError(400, 'That sign-in has expired. Try again.');
    return c;
  }

  type Q = Parameters<Parameters<typeof ctx.db.app>[0]>[0];
  async function parentFor(q: Q, c: IdClaims): Promise<Parent> {
    const found = await q.one<{ parent_id: string; family_id: string }>('SELECT parent_id, family_id FROM find_identity($1, $2)', [c.provider, c.subject]);
    if (found) return { ...found, created: false };
    if (!c.email || !c.emailVerified) throw new HttpError(400, 'That account did not share a verified email address. Sign in with your email instead.');
    const parent = (await q.one<Parent>('SELECT parent_id, family_id, created FROM find_or_create_parent($1, $2, $3)', [c.email, newId('fam'), newId('par')]))!;
    if (parent.created) await q.run('SELECT start_trial($1, $2)', [parent.family_id, ctx.cfg.TRIAL_DAYS]);
    await q.setFamily(parent.family_id);
    await q.run('INSERT INTO parent_identity (provider, subject, parent_id, family_id, email) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
      [c.provider, c.subject, parent.parent_id, parent.family_id, c.email]);
    await audit(q, parent.family_id, `parent:${parent.parent_id}`, 'sign_in.linked', { provider: c.provider, automatic: true });
    return parent;
  }

  // The portal (or a parent screen) signs in.
  app.post('/auth/provider', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const b = providerBody.extend({ language: z.string().max(35).optional() }).parse(req.body);
    const c = await checked(b);
    const result = await ctx.db.app(async (q) => openSession(q, await parentFor(q, c), undefined, languageOf(b.language)));
    return sessionReply(reply, result);
  });

  // A tablet signs up or joins its family: the same answer as /auth/code/pair.
  app.post('/auth/provider/pair', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const b = tabletBody.merge(providerBody).parse(req.body);
    const c = await checked(b);
    return ctx.db.app(async (q) => pairTablet(q, await parentFor(q, c), b, b.provider));
  });

  // ---- A parent's sign-in methods in the portal: their email always, and the provider accounts linked to them.
  const signIns = async (q: Q, parentId: string) => {
    const p = await q.one<{ email: string }>('SELECT email FROM parent WHERE id = $1', [parentId]);
    const rows = await q.all<{ provider: Provider; email: string | null; created_at: string }>('SELECT provider, email, created_at FROM parent_identity WHERE parent_id = $1 ORDER BY created_at', [parentId]);
    return { email: p?.email ?? null, linked: rows.map((r) => ({ provider: r.provider, email: r.email, linkedAt: r.created_at })), available: PROVIDERS.filter((x) => audiences(x).length) };
  };

  app.get('/family/sign-ins', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, (q) => signIns(q, a.parentId));
  });

  // Links another provider account to the signed-in parent, so signing in with it on any tablet reaches this family
  // and its subscription (an Apple private relay address cannot be matched by email any other way).
  app.post('/family/sign-ins', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const a = await parentAuth(ctx, req);
    const b = providerBody.parse(req.body);
    const c = await checked(b);
    return ctx.db.family(a.familyId, async (q) => {
      const found = await q.one<{ parent_id: string; family_id: string }>('SELECT parent_id, family_id FROM find_identity($1, $2)', [c.provider, c.subject]);
      if (found && found.parent_id !== a.parentId) {
        throw new HttpError(409, found.family_id === a.familyId
          ? 'That account is linked to the other parent in your family.'
          : 'That account is linked to another Duckling family. Sign in with it there and remove it first.');
      }
      if (!found) {
        const has = await q.one('SELECT 1 FROM parent_identity WHERE parent_id = $1 AND provider = $2', [a.parentId, c.provider]);
        if (has) throw new HttpError(409, 'Another account from the same company is linked already. Remove it first.');
        await q.run('INSERT INTO parent_identity (provider, subject, parent_id, family_id, email) VALUES ($1, $2, $3, $4, $5)', [c.provider, c.subject, a.parentId, a.familyId, c.email]);
        await audit(q, a.familyId, `parent:${a.parentId}`, 'sign_in.linked', { provider: c.provider });
      }
      return signIns(q, a.parentId);
    });
  });

  app.delete<{ Params: { provider: string } }>('/family/sign-ins/:provider', async (req) => {
    const a = await parentAuth(ctx, req);
    const provider = z.enum(['apple', 'google', 'microsoft']).parse(req.params.provider);
    return ctx.db.family(a.familyId, async (q) => {
      const n = await q.run('DELETE FROM parent_identity WHERE parent_id = $1 AND provider = $2', [a.parentId, provider]);
      if (n) await audit(q, a.familyId, `parent:${a.parentId}`, 'sign_in.removed', { provider });
      return signIns(q, a.parentId);
    });
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
