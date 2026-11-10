// Stripe subscriptions (build plan, sections 6 and 7): how Windows families pay, and an option on the parent portal.
// Checkout and the Customer Portal are Stripe's own pages; the API makes their sessions. Webhooks are verified with
// the endpoint's signing secret, and the subscription's state is then read from the Stripe API every time, so the
// order and content of events do not matter beyond their ids.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Q } from './db.js';
import { newId } from './util.js';

export interface StripeSubscription {
  id: string;
  status: string; // trialing, active, past_due, unpaid, canceled, incomplete, incomplete_expired, paused
  customer: string;
  metadata?: Record<string, string>;
  current_period_end?: number;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  items?: { data?: { current_period_end?: number; price?: { id?: string; lookup_key?: string | null } }[] };
}

export interface Stripe {
  /** A Checkout Session URL for the monthly subscription. */
  checkout(o: { familyId: string; customer: string | null; email: string | null; trialEnd: number | null; successUrl: string; cancelUrl: string }): Promise<string>;
  /** A Customer Portal session URL. */
  portal(customer: string, returnUrl: string): Promise<string>;
  subscription(id: string): Promise<StripeSubscription | null>;
  subscriptionsOf(customer: string): Promise<StripeSubscription[]>;
  cancel(id: string): Promise<void>;
}

export class StripeUnavailable extends Error {}

type Form = Record<string, string | number | boolean | null | undefined>;
const encode = (f: Form) => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export function makeStripe(cfg: Config, log: (msg: string) => void): Stripe | null {
  if (!cfg.STRIPE_SECRET_KEY) return null;
  const base = cfg.STRIPE_API.replace(/\/$/, '');
  const call = async <T>(method: string, path: string, form?: Form): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form ? encode(form) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!r) throw new StripeUnavailable('network');
    const body = (await r.json().catch(() => ({}))) as T & { error?: { type?: string; code?: string; message?: string } };
    if (r.status >= 500) throw new StripeUnavailable(String(r.status));
    if (r.status >= 400 && r.status !== 404) log(`Stripe ${method} ${path.split('?')[0].replace(/\/(sub|cus|cs|bps)_[\w]+/g, '/$1_…')} failed: ${r.status} ${[body.error?.type, body.error?.code].filter(Boolean).join(' ')}`);
    return { status: r.status, body };
  };
  let price: { id: string; until: number } | null = null;
  const priceId = async () => {
    if (cfg.STRIPE_PRICE_ID) return cfg.STRIPE_PRICE_ID;
    if (price && price.until > Date.now()) return price.id;
    const r = await call<{ data?: { id: string }[] }>('GET', `/v1/prices?active=true&lookup_keys[]=${encodeURIComponent(cfg.STRIPE_PRICE_LOOKUP_KEY)}`);
    const id = r.body.data?.[0]?.id;
    if (!id) throw new StripeUnavailable(`no active price with lookup key ${cfg.STRIPE_PRICE_LOOKUP_KEY}`);
    price = { id, until: Date.now() + 3_600_000 };
    return id;
  };
  return {
    async checkout(o) {
      const f: Form = {
        mode: 'subscription',
        'line_items[0][price]': await priceId(),
        'line_items[0][quantity]': 1,
        client_reference_id: o.familyId,
        'metadata[family_id]': o.familyId,
        'subscription_data[metadata][family_id]': o.familyId,
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
        'automatic_tax[enabled]': cfg.STRIPE_AUTOMATIC_TAX,
        billing_address_collection: 'auto',
      };
      if (o.trialEnd) f['subscription_data[trial_end]'] = o.trialEnd;
      if (o.customer) { f.customer = o.customer; if (cfg.STRIPE_AUTOMATIC_TAX) f['customer_update[address]'] = 'auto'; }
      else if (o.email) f.customer_email = o.email;
      const r = await call<{ url?: string }>('POST', '/v1/checkout/sessions', f);
      if (!r.body.url) throw new StripeUnavailable(`checkout ${r.status}`);
      return r.body.url;
    },
    async portal(customer, returnUrl) {
      const r = await call<{ url?: string }>('POST', '/v1/billing_portal/sessions', { customer, return_url: returnUrl, configuration: cfg.STRIPE_PORTAL_CONFIGURATION || undefined });
      if (!r.body.url) throw new StripeUnavailable(`portal ${r.status}`);
      return r.body.url;
    },
    async subscription(id) {
      if (!/^sub_\w+$/.test(id)) return null;
      const r = await call<StripeSubscription>('GET', `/v1/subscriptions/${id}`);
      return r.status === 200 ? r.body : null;
    },
    async subscriptionsOf(customer) {
      if (!/^cus_\w+$/.test(customer)) return [];
      const r = await call<{ data?: StripeSubscription[] }>('GET', `/v1/subscriptions?customer=${customer}&status=all&limit=20`);
      return r.status === 200 ? r.body.data ?? [] : [];
    },
    async cancel(id) {
      if (!/^sub_\w+$/.test(id)) return;
      await call('DELETE', `/v1/subscriptions/${id}`);
    },
  };
}

// What a subscription means for the family. Trialing counts as active: Stripe has the card and bills when the trial
// ends. Past due and unpaid are a payment Stripe is retrying. Incomplete (the first payment needs the parent's bank)
// is not a subscription yet.
export function stripeStatus(s: StripeSubscription): { status: 'active' | 'grace' | 'ended'; periodEnd: string | null } | null {
  const ends = [s.current_period_end, ...(s.items?.data ?? []).map((i) => i.current_period_end), s.status === 'trialing' ? s.trial_end ?? undefined : undefined]
    .filter((n): n is number => typeof n === 'number' && n > 0);
  const periodEnd = ends.length ? new Date(Math.max(...ends) * 1000).toISOString() : null;
  switch (s.status) {
    case 'incomplete': return null;
    case 'trialing': case 'active': return { status: 'active', periodEnd };
    case 'past_due': case 'unpaid': return { status: 'grace', periodEnd };
    default: return { status: 'ended', periodEnd };
  }
}

export const priceOf = (s: StripeSubscription) => s.items?.data?.[0]?.price?.lookup_key || s.items?.data?.[0]?.price?.id || '';

export async function recordStripe(q: Q, familyId: string, s: StripeSubscription): Promise<boolean> {
  const st = stripeStatus(s);
  if (!st) return false;
  const raw = { status: s.status, customer: s.customer, cancelAtPeriodEnd: !!s.cancel_at_period_end, trialEnd: s.trial_end ?? null, price: priceOf(s) };
  await q.run(
    `INSERT INTO purchase (id, family_id, source, external_id, product_id, status, period_end, raw, updated_at)
     VALUES ($1, $2, 'stripe', $3, $4, $5, $6, $7, now())
     ON CONFLICT (external_id) DO UPDATE SET status = EXCLUDED.status, period_end = EXCLUDED.period_end, product_id = EXCLUDED.product_id, raw = EXCLUDED.raw, updated_at = now()
     WHERE purchase.family_id = EXCLUDED.family_id`,
    [newId('pur'), familyId, `stripe:${s.id}`, priceOf(s), st.status, st.periodEnd, JSON.stringify(raw)],
  );
  await q.run('UPDATE family SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS DISTINCT FROM $1', [s.customer, familyId]);
  return true;
}

// The Stripe-Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> (several v1 while the
// secret is being rolled). Five minutes of clock difference are accepted, as Stripe's own libraries do.
export function verifyStripeSignature(header: string | undefined, raw: string, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest();
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const got = Buffer.from(v ?? '', 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
