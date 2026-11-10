// Store billing: Apple (S3) and Google Play (A3); Stripe (S2) joins here.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceAuth } from '../auth.js';
import { HttpError, badRequest } from '../util.js';
import { firstDelivery } from '../webhooks.js';
import { entitlementOf } from '../entitlement.js';
import { notifyDevices } from '../notify.js';
import { recordApple, type AppleVerifier, type AppleTransaction, type AppleRenewal } from '../apple.js';
import { recordGoogle, GoogleUnavailable, type GooglePlay, type GoogleSubscription, type PushAuth } from '../google.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function billingRoutes(app: FastifyInstance, { ctx, apple, google, googlePushAuth }: { ctx: Ctx; apple: AppleVerifier | null; google: GooglePlay | null; googlePushAuth: PushAuth }) {
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

  // ---- Google Play ------------------------------------------------------------------------------------------------

  const googleProducts = new Set(ctx.cfg.GOOGLE_PLAY_PRODUCT_IDS.split(',').map((x) => x.trim()).filter(Boolean));
  const needGoogle = () => { if (!google) throw new HttpError(503, 'Google Play billing is not configured'); return google; };
  const productOf = (sub: GoogleSubscription) => sub.lineItems?.find((l) => l.productId)?.productId ?? '';

  // The family a subscription belongs to: the obfuscated account id the app set at purchase (the family's
  // appAccountToken), or the family that already holds this token or the one it replaced.
  const googleFamily = async (purchaseToken: string, sub: GoogleSubscription): Promise<string | null> => ctx.db.system(async (q) => {
    const acct = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (acct && UUID.test(acct)) {
      const f = await q.one<{ id: string }>('SELECT id FROM family WHERE app_account_token = $1::uuid', [acct.toLowerCase()]);
      if (f) return f.id;
    }
    for (const t of [purchaseToken, sub.linkedPurchaseToken]) {
      if (!t) continue;
      const p = await q.one<{ family_id: string }>('SELECT family_id FROM purchase WHERE external_id = $1', [`google:${t}`]);
      if (p) return p.family_id;
    }
    return null;
  });

  const lookup = async (purchaseToken: string) => {
    try { return await needGoogle().subscription(purchaseToken); }
    catch (e) { if (e instanceof GoogleUnavailable) throw new HttpError(503, 'Google Play could not be reached'); throw e; }
  };

  // The tablet, right after a Play Billing purchase or a restore: the purchase token.
  app.post('/billing/google/link', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const dv = await deviceAuth(ctx, req);
    const b = z.object({ purchaseToken: z.string().min(10).max(4000), productId: z.string().min(1).max(100) }).parse(req.body);
    if (!googleProducts.has(b.productId)) throw badRequest('Unknown product');
    const sub = await lookup(b.purchaseToken);
    if (!sub) throw badRequest('The purchase could not be verified');
    if (!googleProducts.has(productOf(sub))) throw badRequest('Unknown product');
    const owner = await googleFamily(b.purchaseToken, sub);
    // A purchase made for another family (another Google account's restore, a shared tablet) is not moved here.
    if (owner && owner !== dv.familyId) throw new HttpError(409, 'This subscription belongs to another Duckling family');
    const recorded = await ctx.db.system((q) => recordGoogle(q, dv.familyId, b.purchaseToken, sub));
    // Google refunds a purchase that is not acknowledged within three days.
    if (recorded && sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') await needGoogle().acknowledge(productOf(sub), b.purchaseToken);
    void notifyDevices(ctx, dv.familyId);
    return { pending: !recorded, entitlement: await ctx.db.family(dv.familyId, (q) => entitlementOf(q, dv.familyId)) };
  });

  // Real-time Developer Notifications through a Pub/Sub push subscription. Google's state for the token is read
  // fresh for every notification, so order and duplicates do not matter beyond the message id check.
  app.post('/hooks/google', async (req, reply) => {
    if (!(await googlePushAuth(req.headers.authorization))) { reply.code(401); return { error: 'not verified' }; }
    const b = z.object({ message: z.object({ data: z.string().max(20000).optional(), messageId: z.string().max(200).optional(), message_id: z.string().max(200).optional() }) }).safeParse(req.body);
    if (!b.success) throw badRequest('message missing');
    let n: { packageName?: string; subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string }; testNotification?: unknown };
    try { n = JSON.parse(Buffer.from(b.data.message.data ?? '', 'base64').toString('utf8')); } catch { return { ignored: true }; }
    const sn = n.subscriptionNotification;
    if (n.packageName !== ctx.cfg.GOOGLE_PLAY_PACKAGE || !sn?.purchaseToken) return { ignored: true };
    if (sn.subscriptionId && !googleProducts.has(sn.subscriptionId)) return { ignored: true };
    let sub: GoogleSubscription | null;
    // A failure to reach Google returns 503, so Pub/Sub delivers the message again later.
    try { sub = await needGoogle().subscription(sn.purchaseToken); }
    catch (e) { if (e instanceof GoogleUnavailable) { reply.code(503); return { retry: true }; } throw e; }
    if (!sub) return { ignored: true };
    const familyId = await googleFamily(sn.purchaseToken, sub);
    if (!familyId) { ctx.log(`google notification ${sn.notificationType ?? '?'} for an unknown family`); return { ignored: true }; }
    const id = b.data.message.messageId ?? b.data.message.message_id;
    const outcome = await ctx.db.system(async (q) => {
      if (id && !(await firstDelivery(q, 'google', id))) return 'duplicate';
      return (await recordGoogle(q, familyId, sn.purchaseToken!, sub!)) ? 'ok' : 'pending';
    });
    if (outcome !== 'ok') return { [outcome]: true };
    if (sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') await needGoogle().acknowledge(productOf(sub), sn.purchaseToken);
    void notifyDevices(ctx, familyId);
    return { ok: true };
  });
}
