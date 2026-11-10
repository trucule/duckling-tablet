// Store billing. Apple now (S3); Google (A3) and Stripe (S2) join here.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceAuth } from '../auth.js';
import { HttpError, badRequest } from '../util.js';
import { firstDelivery } from '../webhooks.js';
import { entitlementOf } from '../entitlement.js';
import { notifyDevices } from '../notify.js';
import { recordApple, type AppleVerifier, type AppleTransaction, type AppleRenewal } from '../apple.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function billingRoutes(app: FastifyInstance, { ctx, apple }: { ctx: Ctx; apple: AppleVerifier | null }) {
  const products = new Set(ctx.cfg.APPLE_PRODUCT_IDS.split(',').map((s) => s.trim()).filter(Boolean));
  const needApple = () => { if (!apple) throw new HttpError(503, 'Apple billing is not configured'); return apple; };

  // The family a transaction belongs to: its appAccountToken (set by the iPad app at purchase), or the family that
  // already holds this subscription.
  const familyOf = async (t: AppleTransaction): Promise<string | null> => ctx.db.system(async (q) => {
    if (t.appAccountToken && UUID.test(t.appAccountToken)) {
      const f = await q.one<{ id: string }>('SELECT id FROM family WHERE app_account_token = $1::uuid', [t.appAccountToken.toLowerCase()]);
      if (f) return f.id;
    }
    const p = t.originalTransactionId ? await q.one<{ family_id: string }>('SELECT family_id FROM purchase WHERE external_id = $1', [`apple:${t.originalTransactionId}`]) : null;
    return p?.family_id ?? null;
  });

  // The tablet, right after a StoreKit purchase or a restore: the signed transaction from StoreKit 2.
  app.post('/billing/apple/link', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ signedTransaction: z.string().min(20).max(20000) }).parse(req.body);
    let t: AppleTransaction;
    try { t = await needApple().transaction(b.signedTransaction); } catch (e) { if (e instanceof HttpError) throw e; throw badRequest('The purchase could not be verified'); }
    if (!t.productId || !products.has(t.productId)) throw badRequest('Unknown product');
    const mine = await ctx.db.family(dv.familyId, (q) => q.one<{ app_account_token: string }>('SELECT app_account_token::text AS app_account_token FROM family WHERE id = $1', [dv.familyId]));
    // A purchase made for another family (another Apple ID's restore, a shared iPad) is not moved here.
    if (!t.appAccountToken || t.appAccountToken.toLowerCase() !== mine?.app_account_token) {
      const owner = await familyOf(t);
      if (owner && owner !== dv.familyId) throw new HttpError(409, 'This subscription belongs to another Duckling family');
    }
    await ctx.db.system((q) => recordApple(q, dv.familyId, t));
    void notifyDevices(ctx, dv.familyId);
    return { entitlement: await ctx.db.family(dv.familyId, (q) => entitlementOf(q, dv.familyId)) };
  });

  // App Store Server Notifications v2: renewals, failed payments, grace, expiry, refunds, revocations.
  app.post('/hooks/apple', async (req, reply) => {
    const b = z.object({ signedPayload: z.string().min(20).max(100000) }).safeParse(req.body);
    if (!b.success) throw badRequest('signedPayload missing');
    let n: Awaited<ReturnType<AppleVerifier['notification']>>;
    try { n = await needApple().notification(b.data.signedPayload); } catch (e) { if (e instanceof HttpError) throw e; reply.code(401); return { error: 'not verified' }; }
    if (n.notificationType === 'TEST' || !n.transaction) return { ignored: true };
    const t = n.transaction, r: AppleRenewal | undefined = n.renewal;
    if (!t.productId || !products.has(t.productId)) return { ignored: true };
    const familyId = await familyOf(t);
    if (!familyId) { ctx.log(`apple notification ${n.notificationType ?? '?'} for an unknown family`); return { ignored: true }; }
    const applied = await ctx.db.system(async (q) => {
      if (n.notificationUUID && !(await firstDelivery(q, 'apple', n.notificationUUID))) return false;
      await recordApple(q, familyId, t, r);
      return true;
    });
    if (applied) void notifyDevices(ctx, familyId);
    return applied ? { ok: true } : { duplicate: true };
  });
}
