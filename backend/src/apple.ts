// Apple subscriptions (build plan, sections 6 and 7): the iPad app buys `duckling_monthly` with StoreKit 2, passing
// the family's appAccountToken, and sends the signed transaction to POST /billing/apple/link. After that, App Store
// Server Notifications v2 arrive at POST /hooks/apple. Every signed payload is verified with Apple's library against
// Apple's root certificates before anything is believed; the purchase row then feeds entitlementOf like any other.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SignedDataVerifier, Environment } from '@apple/app-store-server-library';
import type { JWSTransactionDecodedPayload, JWSRenewalInfoDecodedPayload } from '@apple/app-store-server-library';
import type { Config } from './config.js';
import type { Q } from './db.js';
import { newId } from './util.js';

export type AppleTransaction = JWSTransactionDecodedPayload;
export type AppleRenewal = JWSRenewalInfoDecodedPayload;
export interface AppleNotification { notificationType?: string; subtype?: string; notificationUUID?: string; environment?: string; transaction?: AppleTransaction; renewal?: AppleRenewal }

export interface AppleVerifier {
  transaction(signed: string): Promise<AppleTransaction>;
  notification(signedPayload: string): Promise<AppleNotification>;
}

const ENVIRONMENTS: Record<string, Environment> = { production: Environment.PRODUCTION, sandbox: Environment.SANDBOX, localtesting: Environment.LOCAL_TESTING, xcode: Environment.XCODE };

// One verifier per environment the server accepts. Production needs the app's Apple ID (App Store Connect > App
// Information > Apple ID); until it is set only the sandbox verifier exists, which is what TestFlight uses.
export function makeAppleVerifier(cfg: Config): AppleVerifier | null {
  const roots = existsSync(cfg.APPLE_ROOT_CERTS) ? readdirSync(cfg.APPLE_ROOT_CERTS).filter((f) => /\.(cer|der|crt)$/i.test(f)).map((f) => readFileSync(join(cfg.APPLE_ROOT_CERTS, f))) : [];
  const verifiers: SignedDataVerifier[] = [];
  for (const name of cfg.APPLE_ENVIRONMENTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const env = ENVIRONMENTS[name];
    if (!env) continue;
    const testing = env === Environment.LOCAL_TESTING || env === Environment.XCODE;
    if (!testing && !roots.length) continue;
    if (env === Environment.PRODUCTION && !cfg.APPLE_APP_APPLE_ID) continue;
    verifiers.push(new SignedDataVerifier(roots, !testing, env, cfg.APPLE_BUNDLE_ID, env === Environment.PRODUCTION ? cfg.APPLE_APP_APPLE_ID : undefined));
  }
  if (!verifiers.length) return null;
  // The first environment that verifies the payload wins; a payload no verifier accepts is rejected.
  const first = async <T>(fn: (v: SignedDataVerifier) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const v of verifiers) { try { return await fn(v); } catch (e) { last = e; } }
    throw last instanceof Error ? last : new Error('not verified');
  };
  return {
    transaction: (signed) => first((v) => v.verifyAndDecodeTransaction(signed)),
    notification: (signedPayload) => first(async (v) => {
      const n = await v.verifyAndDecodeNotification(signedPayload);
      const data = n.data;
      return {
        notificationType: n.notificationType, subtype: n.subtype, notificationUUID: n.notificationUUID, environment: data?.environment,
        transaction: data?.signedTransactionInfo ? await v.verifyAndDecodeTransaction(data.signedTransactionInfo) : undefined,
        renewal: data?.signedRenewalInfo ? await v.verifyAndDecodeRenewalInfo(data.signedRenewalInfo) : undefined,
      };
    }),
  };
}

// What a transaction (and, from a notification, its renewal info) means for the family: active until it expires,
// grace while Apple retries a failed payment, ended once revoked, refunded or lapsed.
export function appleStatus(t: AppleTransaction, r?: AppleRenewal, at = Date.now()): { status: 'active' | 'grace' | 'ended'; periodEnd: string | null } {
  const expires = t.expiresDate ? Number(t.expiresDate) : null;
  const end = expires ? new Date(expires).toISOString() : null;
  if (t.revocationDate) return { status: 'ended', periodEnd: end };
  if (expires && expires > at) return { status: 'active', periodEnd: end };
  const graceEnd = r?.gracePeriodExpiresDate ? Number(r.gracePeriodExpiresDate) : null;
  if (graceEnd && graceEnd > at) return { status: 'grace', periodEnd: new Date(graceEnd).toISOString() };
  if (r?.isInBillingRetryPeriod) return { status: 'grace', periodEnd: end };
  return { status: 'ended', periodEnd: end };
}

// Records the purchase for the family (run as duckling_system). One row per subscription, keyed by Apple's
// originalTransactionId, updated in place as renewals, failures and refunds arrive.
export async function recordApple(q: Q, familyId: string, t: AppleTransaction, r?: AppleRenewal): Promise<void> {
  const { status, periodEnd } = appleStatus(t, r);
  const raw = { productId: t.productId, originalTransactionId: t.originalTransactionId, transactionId: t.transactionId, expiresDate: t.expiresDate, revocationDate: t.revocationDate ?? null, offerType: t.offerType ?? null, environment: t.environment, renewal: r ? { autoRenewStatus: r.autoRenewStatus, isInBillingRetryPeriod: r.isInBillingRetryPeriod ?? null, gracePeriodExpiresDate: r.gracePeriodExpiresDate ?? null } : null };
  await q.run(
    `INSERT INTO purchase (id, family_id, source, external_id, product_id, status, period_end, raw, updated_at)
     VALUES ($1, $2, 'apple', $3, $4, $5, $6, $7, now())
     ON CONFLICT (external_id) DO UPDATE SET status = EXCLUDED.status, period_end = EXCLUDED.period_end, product_id = EXCLUDED.product_id, raw = EXCLUDED.raw, updated_at = now()
     WHERE purchase.family_id = EXCLUDED.family_id`,
    [newId('pur'), familyId, `apple:${t.originalTransactionId}`, t.productId ?? '', status, periodEnd, JSON.stringify(raw)],
  );
}
