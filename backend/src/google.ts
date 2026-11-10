// Google Play subscriptions (build plan, sections 6 and 7). The Android app buys `duckling_monthly` with Play Billing,
// passing the family's appAccountToken as the obfuscated account id, and sends the purchase token to
// POST /billing/google/link. Google then posts Real-time Developer Notifications through Pub/Sub to
// POST /hooks/google. Nothing in a token or a notification is believed as sent: the server asks the Play Developer
// API for the subscription's state each time, and the push itself must carry a Google-signed OIDC token.
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import type { Config } from './config.js';
import type { Q } from './db.js';
import { newId } from './util.js';
import { readServiceAccount, accessTokens } from './serviceaccount.js';

export interface GoogleSubscription {
  subscriptionState?: string;
  lineItems?: { productId?: string; expiryTime?: string }[];
  acknowledgementState?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  linkedPurchaseToken?: string;
  latestOrderId?: string;
  startTime?: string;
  testPurchase?: Record<string, unknown>;
}

export interface GooglePlay {
  /** The subscription behind a purchase token; null when Google does not know the token. */
  subscription(purchaseToken: string): Promise<GoogleSubscription | null>;
  acknowledge(productId: string, purchaseToken: string): Promise<void>;
}

export class GoogleUnavailable extends Error {}

export function makeGooglePlay(cfg: Config, log: (msg: string) => void): GooglePlay | null {
  const sa = readServiceAccount(cfg.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE || cfg.FCM_SERVICE_ACCOUNT_FILE, 'Google Play', log);
  if (!sa) return null;
  const token = accessTokens(sa, 'https://www.googleapis.com/auth/androidpublisher', log);
  const base = `${cfg.ANDROID_PUBLISHER_ENDPOINT}/androidpublisher/v3/applications/${encodeURIComponent(cfg.GOOGLE_PLAY_PACKAGE)}/purchases`;
  const call = async (method: string, url: string) => {
    const bearer = await token();
    if (!bearer) throw new GoogleUnavailable('no access token');
    const r = await fetch(url, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!r) throw new GoogleUnavailable('network');
    return r;
  };
  return {
    async subscription(purchaseToken) {
      const r = await call('GET', `${base}/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
      if (r.status === 404 || r.status === 410 || r.status === 400) return null;
      if (!r.ok) { log(`Play subscriptionsv2.get failed: ${r.status}`); throw new GoogleUnavailable(String(r.status)); }
      return (await r.json()) as GoogleSubscription;
    },
    async acknowledge(productId, purchaseToken) {
      const r = await call('POST', `${base}/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`);
      if (!r.ok) log(`Play acknowledge failed: ${r.status}`);
    },
  };
}

// What a subscription means for the family. A cancelled subscription keeps working until its paid time ends; on
// hold and paused have no access; a pending purchase (cash payment not made yet) is not a subscription yet.
export function googleStatus(s: GoogleSubscription, at = Date.now()): { status: 'active' | 'grace' | 'ended'; periodEnd: string | null } | null {
  const expiries = (s.lineItems ?? []).map((l) => (l.expiryTime ? Date.parse(l.expiryTime) : NaN)).filter((n) => !Number.isNaN(n));
  const end = expiries.length ? new Date(Math.max(...expiries)) : null;
  const periodEnd = end ? end.toISOString() : null;
  switch (s.subscriptionState) {
    case 'SUBSCRIPTION_STATE_PENDING': return null;
    case 'SUBSCRIPTION_STATE_ACTIVE': return { status: 'active', periodEnd };
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD': return { status: 'grace', periodEnd };
    case 'SUBSCRIPTION_STATE_CANCELED': return { status: end && end.getTime() > at ? 'active' : 'ended', periodEnd };
    default: return { status: 'ended', periodEnd };
  }
}

// One purchase row per purchase token. When a subscription is bought again after it lapsed (or changed), Google
// issues a new token and names the old one in linkedPurchaseToken; that old row ends, so it no longer counts.
export async function recordGoogle(q: Q, familyId: string, purchaseToken: string, s: GoogleSubscription): Promise<boolean> {
  const st = googleStatus(s);
  if (!st) return false;
  const productId = s.lineItems?.find((l) => l.productId)?.productId ?? '';
  const raw = { subscriptionState: s.subscriptionState, latestOrderId: s.latestOrderId ?? null, linkedPurchaseToken: s.linkedPurchaseToken ?? null, acknowledgementState: s.acknowledgementState ?? null, test: !!s.testPurchase, lineItems: s.lineItems ?? [] };
  await q.run(
    `INSERT INTO purchase (id, family_id, source, external_id, product_id, status, period_end, raw, updated_at)
     VALUES ($1, $2, 'google', $3, $4, $5, $6, $7, now())
     ON CONFLICT (external_id) DO UPDATE SET status = EXCLUDED.status, period_end = EXCLUDED.period_end, product_id = EXCLUDED.product_id, raw = EXCLUDED.raw, updated_at = now()
     WHERE purchase.family_id = EXCLUDED.family_id`,
    [newId('pur'), familyId, `google:${purchaseToken}`, productId, st.status, st.periodEnd, JSON.stringify(raw)],
  );
  if (s.linkedPurchaseToken) {
    await q.run(`UPDATE purchase SET status = 'ended', updated_at = now() WHERE external_id = $1 AND family_id = $2`, [`google:${s.linkedPurchaseToken}`, familyId]);
  }
  return true;
}

// ---- The Pub/Sub push: a Google-signed OIDC token in the Authorization header ----------------------------------------

export type PushAuth = (authorization: string | undefined) => Promise<boolean>;
type Jwks = { keys: (JsonWebKey & { kid?: string })[] };

export function makePushAuth(cfg: Config, fetchKeys: () => Promise<Jwks> = defaultKeys()): PushAuth {
  const audience = cfg.GOOGLE_PUSH_AUDIENCE || `${cfg.PUBLIC_URL}/hooks/google`;
  return async (authorization) => {
    const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization ?? '');
    if (!m) return false;
    let header: { alg?: string; kid?: string }, claims: { iss?: string; aud?: string; exp?: number; iat?: number; email?: string; email_verified?: boolean };
    try { header = JSON.parse(Buffer.from(m[1], 'base64url').toString()); claims = JSON.parse(Buffer.from(m[2], 'base64url').toString()); } catch { return false; }
    if (header.alg !== 'RS256' || !header.kid) return false;
    let keys: Jwks;
    try { keys = await fetchKeys(); } catch { return false; }
    const jwk = keys.keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const ok = createVerify('RSA-SHA256').update(`${m[1]}.${m[2]}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(m[3], 'base64url'));
    if (!ok) return false;
    const now = Date.now() / 1000;
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return false;
    if (claims.aud !== audience) return false;
    if (!claims.exp || claims.exp < now - 60) return false;
    if (cfg.GOOGLE_PUSH_SERVICE_ACCOUNT && (claims.email !== cfg.GOOGLE_PUSH_SERVICE_ACCOUNT || claims.email_verified !== true)) return false;
    return true;
  };
}

// Google's signing keys, cached for an hour (they rotate over days).
function defaultKeys(): () => Promise<Jwks> {
  let cached: { keys: Jwks; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.keys;
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`certs ${r.status}`);
    cached = { keys: (await r.json()) as Jwks, until: Date.now() + 3_600_000 };
    return cached.keys;
  };
}
