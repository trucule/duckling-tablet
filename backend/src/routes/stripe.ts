// Stripe (S2): Checkout and the Customer Portal for a family, and the webhook that keeps its subscription current.
// Windows tablets subscribe here from the parent area (behind the PIN), and parents can subscribe on the portal.
// The webhook needs the raw body for its signature, so this plugin has its own JSON parser.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceAuth, parentAuth } from '../auth.js';
import { HttpError, badRequest } from '../util.js';
import { firstDelivery } from '../webhooks.js';
import { entitlementOf } from '../entitlement.js';
import { notifyDevices } from '../notify.js';
import { recordStripe, priceOf, verifyStripeSignature, StripeUnavailable, type StripeSubscription } from '../stripe.js';

const TWO_DAYS = 2 * 86_400_000;

export default async function stripeRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { (e as Error & { statusCode?: number }).statusCode = 400; done(e as Error); }
  });

  const need = () => { if (!ctx.stripe) throw new HttpError(503, 'Card payments are not available yet'); return ctx.stripe; };
  const unavailable = (e: unknown) => { if (e instanceof StripeUnavailable) throw new HttpError(503, 'Stripe could not be reached. Try again in a minute.'); throw e; };
  const ours = (s: StripeSubscription) => {
    const p = priceOf(s);
    return p === ctx.cfg.STRIPE_PRICE_LOOKUP_KEY || (!!ctx.cfg.STRIPE_PRICE_ID && p === ctx.cfg.STRIPE_PRICE_ID);
  };

  // A parent on the portal (session) or a tablet's parent area (device token).
  const caller = async (req: FastifyRequest) => {
    if ((req.headers.authorization ?? '').toLowerCase().startsWith('device ')) {
      const d = await deviceAuth(ctx, req);
      return { familyId: d.familyId, actor: `device:${d.deviceId}`, email: null as string | null, from: 'tablet' as const };
    }
    const p = await parentAuth(ctx, req);
    return { familyId: p.familyId, actor: `parent:${p.parentId}`, email: p.email, from: 'portal' as const };
  };

  const familyBilling = (familyId: string) => ctx.db.family(familyId, async (q) => {
    const f = await q.one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM family WHERE id = $1', [familyId]);
    const owner = await q.one<{ email: string }>(`SELECT email FROM parent WHERE family_id = $1 ORDER BY (role = 'owner') DESC, created_at LIMIT 1`, [familyId]);
    const trial = await q.one<{ status: string; current_period_end: string | null }>('SELECT status, current_period_end FROM entitlement WHERE family_id = $1', [familyId]);
    return { customer: f?.stripe_customer_id ?? null, ownerEmail: owner?.email ?? null, trial, entitlement: await entitlementOf(q, familyId) };
  });

  app.post('/billing/stripe/checkout', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const c = await caller(req);
    const stripe = need();
    const f = await familyBilling(c.familyId);
    const e = f.entitlement;
    if ((e.status === 'active' || e.status === 'grace') && e.source) {
      const where = e.source === 'stripe' ? 'with a card. Manage it from the parent area or the parent portal' : e.source === 'apple' ? 'through the App Store' : 'through Google Play';
      throw new HttpError(409, `This family already has a subscription ${where}.`);
    }
    // A family still in its free trial is not charged until the trial ends (Stripe needs at least two days' notice).
    const end = f.trial?.status === 'trial' && f.trial.current_period_end ? new Date(f.trial.current_period_end).getTime() : 0;
    const trialEnd = end - Date.now() >= TWO_DAYS ? Math.floor(end / 1000) : null;
    const back = c.from === 'portal'
      ? { successUrl: `${ctx.cfg.PORTAL_URL}/?subscribed=1#subscription`, cancelUrl: `${ctx.cfg.PORTAL_URL}/#subscription` }
      : { successUrl: `${ctx.cfg.SITE_URL}/checkout/success?from=tablet`, cancelUrl: `${ctx.cfg.SITE_URL}/checkout/cancel?from=tablet` };
    const url = await stripe.checkout({ familyId: c.familyId, customer: f.customer, email: c.email ?? f.ownerEmail, trialEnd, ...back }).catch(unavailable);
    return { url, trialEnd: trialEnd ? new Date(trialEnd * 1000).toISOString() : null };
  });

  app.post('/billing/stripe/portal', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const c = await caller(req);
    const stripe = need();
    const f = await familyBilling(c.familyId);
    if (!f.customer) throw new HttpError(404, 'This family has no card subscription.');
    const returnUrl = c.from === 'portal' ? `${ctx.cfg.PORTAL_URL}/#subscription` : `${ctx.cfg.SITE_URL}/checkout/return?from=tablet`;
    return { url: await stripe.portal(f.customer, returnUrl).catch(unavailable) };
  });

  // The family a subscription belongs to: the family id Checkout put in its metadata, or the family that holds its
  // customer. A subscription in the same Stripe account that is not Duckling's (another product) is not ours.
  const familyOf = (s: StripeSubscription) => ctx.db.system(async (q) => {
    const meta = s.metadata?.family_id;
    if (meta) { const f = await q.one<{ id: string }>('SELECT id FROM family WHERE id = $1', [meta]); if (f) return f.id; }
    const f = await q.one<{ id: string }>('SELECT id FROM family WHERE stripe_customer_id = $1', [s.customer]);
    return f?.id ?? null;
  });

  app.post('/hooks/stripe', async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    if (!verifyStripeSignature(req.headers['stripe-signature'] as string | undefined, raw, ctx.cfg.STRIPE_WEBHOOK_SECRET)) { reply.code(400); return { error: 'not verified' }; }
    const ev = z.object({ id: z.string().max(200), type: z.string().max(100), data: z.object({ object: z.record(z.unknown()) }) }).safeParse(req.body);
    if (!ev.success) throw badRequest('Not an event');
    const o = ev.data.data.object as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);
    let subId: string | null = null;
    if (ev.data.type.startsWith('customer.subscription.')) subId = str(o.id);
    else if (ev.data.type === 'checkout.session.completed' || ev.data.type === 'checkout.session.async_payment_succeeded') subId = str(o.subscription);
    else if (ev.data.type.startsWith('invoice.')) {
      const parent = o.parent as { subscription_details?: { subscription?: unknown } } | undefined;
      subId = str(o.subscription) ?? str(parent?.subscription_details?.subscription);
    }
    if (!subId) return { ignored: true };
    if (!ctx.stripe) { reply.code(503); return { retry: true }; }
    let sub: StripeSubscription | null;
    try { sub = await ctx.stripe.subscription(subId); }
    catch (e) { if (e instanceof StripeUnavailable) { reply.code(503); return { retry: true }; } throw e; }
    if (!sub || !ours(sub)) return { ignored: true };
    const familyId = await familyOf(sub);
    if (!familyId) { ctx.log(`stripe ${ev.data.type} for an unknown family`); return { ignored: true }; }
    const outcome = await ctx.db.system(async (q) => {
      if (!(await firstDelivery(q, 'stripe', ev.data.id))) return 'duplicate';
      return (await recordStripe(q, familyId, sub!)) ? 'ok' : 'pending';
    });
    if (outcome === 'ok') void notifyDevices(ctx, familyId);
    return { [outcome]: true };
  });
}
