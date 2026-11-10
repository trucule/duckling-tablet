// One-time Stripe setup for Duckling, run on the droplet after STRIPE_SECRET_KEY is in /opt/duckling/.env:
//
//     cd /opt/duckling/src/backend && set -a && . /opt/duckling/.env && set +a && node dist/stripe-setup.js --write /opt/duckling/.env
//
// It checks that the duckling_monthly price exists, creates Duckling's own Customer Portal configuration (cancel at
// the end of the period, update the card, see invoices, Duckling's terms and privacy links), and creates the webhook
// endpoint for https://api.ducklingtablet.com/hooks/stripe with the events the API handles. With --write it puts
// STRIPE_PORTAL_CONFIGURATION and STRIPE_WEBHOOK_SECRET into the .env file, so the signing secret is never printed or
// copied. Running it again replaces Duckling's webhook endpoint (Stripe shows a secret only when an endpoint is made)
// and reuses the portal configuration. Other products in the same Stripe account are not touched.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';

export const WEBHOOK_EVENTS = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed',
  'invoice.paid', 'invoice.payment_failed',
];

type Json = Record<string, unknown> & { id?: string; data?: Json[]; error?: { message?: string } };

export async function stripeSetup(key: string, api: string, publicUrl: string, siteUrl: string, portalUrl: string, lookupKey: string, existingPortal: string) {
  const call = async (method: string, path: string, form?: [string, string][]): Promise<Json> => {
    const r = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form ? new URLSearchParams(form).toString() : undefined });
    const j = (await r.json()) as Json;
    if (!r.ok) throw new Error(`Stripe ${method} ${path.split('?')[0]}: ${r.status} ${j.error?.message ?? ''}`);
    return j;
  };
  const prices = await call('GET', `/v1/prices?active=true&lookup_keys[]=${encodeURIComponent(lookupKey)}`);
  const price = prices.data?.[0] as (Json & { unit_amount?: number; currency?: string; recurring?: { interval?: string }; product?: string }) | undefined;
  if (!price) throw new Error(`No active price with lookup key ${lookupKey}. Create it in the Stripe dashboard first.`);

  let portal = existingPortal;
  if (portal) {
    const p = await call('GET', `/v1/billing_portal/configurations/${portal}`).catch(() => null);
    if (!p?.id) portal = '';
  }
  if (!portal) {
    const p = await call('POST', '/v1/billing_portal/configurations', [
      ['business_profile[headline]', 'Duckling Tablet: manage your subscription'],
      ['business_profile[privacy_policy_url]', `${siteUrl}/privacy`],
      ['business_profile[terms_of_service_url]', `${siteUrl}/terms`],
      ['default_return_url', `${portalUrl}/#subscription`],
      ['features[subscription_cancel][enabled]', 'true'],
      ['features[subscription_cancel][mode]', 'at_period_end'],
      ['features[subscription_cancel][cancellation_reason][enabled]', 'true'],
      ['features[subscription_cancel][cancellation_reason][options][]', 'too_expensive'],
      ['features[subscription_cancel][cancellation_reason][options][]', 'unused'],
      ['features[subscription_cancel][cancellation_reason][options][]', 'missing_features'],
      ['features[subscription_cancel][cancellation_reason][options][]', 'other'],
      ['features[payment_method_update][enabled]', 'true'],
      ['features[invoice_history][enabled]', 'true'],
      ['features[customer_update][enabled]', 'true'],
      ['features[customer_update][allowed_updates][]', 'email'],
      ['features[customer_update][allowed_updates][]', 'address'],
      ['metadata[product]', 'duckling-tablet'],
    ]);
    portal = p.id!;
  }

  const url = `${publicUrl}/hooks/stripe`;
  const endpoints = await call('GET', '/v1/webhook_endpoints?limit=100');
  for (const e of (endpoints.data ?? []) as (Json & { url?: string })[]) if (e.url === url) await call('DELETE', `/v1/webhook_endpoints/${e.id}`);
  const created = await call('POST', '/v1/webhook_endpoints', [
    ['url', url], ['description', 'Duckling Tablet subscriptions'], ['metadata[product]', 'duckling-tablet'],
    ...WEBHOOK_EVENTS.map((ev): [string, string] => ['enabled_events[]', ev]),
  ]) as Json & { secret?: string };
  if (!created.secret) throw new Error('Stripe did not return the webhook signing secret.');
  return { price: { id: price.id!, amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval }, portal, webhook: { id: created.id!, url, secret: created.secret } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  if (!cfg.STRIPE_SECRET_KEY) { console.error('Add STRIPE_SECRET_KEY to /opt/duckling/.env first.'); process.exit(2); }
  const r = await stripeSetup(cfg.STRIPE_SECRET_KEY, cfg.STRIPE_API, cfg.PUBLIC_URL, cfg.SITE_URL, cfg.PORTAL_URL, cfg.STRIPE_PRICE_LOOKUP_KEY, cfg.STRIPE_PORTAL_CONFIGURATION);
  console.log(`Price ${r.price.id}: ${((r.price.amount ?? 0) / 100).toFixed(2)} ${String(r.price.currency).toUpperCase()} per ${r.price.interval}.`);
  console.log(`Customer Portal configuration ${r.portal}.`);
  console.log(`Webhook endpoint ${r.webhook.id} for ${r.webhook.url} (${WEBHOOK_EVENTS.length} events).`);
  const writeIdx = process.argv.indexOf('--write');
  const lines = { STRIPE_PORTAL_CONFIGURATION: r.portal, STRIPE_WEBHOOK_SECRET: r.webhook.secret };
  if (writeIdx > 0 && process.argv[writeIdx + 1]) {
    const file = process.argv[writeIdx + 1];
    let env = readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(lines)) {
      const re = new RegExp(`^${k}=.*$`, 'm');
      env = re.test(env) ? env.replace(re, () => `${k}=${v}`) : `${env.replace(/\n?$/, '\n')}${k}=${v}\n`;
    }
    writeFileSync(file, env);
    console.log(`STRIPE_PORTAL_CONFIGURATION and STRIPE_WEBHOOK_SECRET written to ${file}. Restart duckling-api.`);
  } else {
    console.log('Run again with --write /opt/duckling/.env to store the portal configuration and the webhook signing secret.');
    console.log('(The endpoint just made will be replaced by that run.)');
  }
}
