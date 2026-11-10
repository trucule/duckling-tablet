// Stripe subscriptions end to end on the API: Checkout from a tablet's parent area and from the portal, the signed
// webhook moving the family through active, past due and cancelled, the Customer Portal, subscriptions of other
// products in the same Stripe account being left alone, and account deletion cancelling the card subscription. The
// Stripe API is a local fake HTTP server reached through the production client; webhook signatures are made with
// the same scheme Stripe uses.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { stripeStatus, verifyStripeSignature, type StripeSubscription } from '../src/stripe.js';
import { stripeSetup, WEBHOOK_EVENTS } from '../src/stripe-setup.js';
import type { Db } from '../src/db.js';
import { freePort, startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, urls: { appUrl: string; systemUrl: string }, dir: string, fake: Server, fakeUrl: string;
const mails: { to: string; text: string }[] = [];
const pushes: string[][] = [];
const subs = new Map<string, StripeSubscription>();
const checkouts: Record<string, string>[] = [];
const portals: Record<string, string>[] = [];
const cancelled: string[] = [];
let stripeDown = false;
let rejectIcon = false;
const setup = { portalForms: [] as URLSearchParams[], endpoints: [] as { id: string; url: string; events?: string[] }[], deleted: [] as string[] };
const SECRET = 'whsec_test_secret';
const DAY = 86_400_000;
const sec = (ms: number) => Math.floor(ms / 1000);

function sign(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
async function hook(event: unknown, signature?: string) {
  const body = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/hooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signature ?? sign(body) }, payload: body });
}
const sub = (id: string, o: Partial<StripeSubscription> & { family?: string; price?: string; end?: number }): StripeSubscription => ({
  id, status: o.status ?? 'active', customer: o.customer ?? 'cus_A', metadata: o.family ? { family_id: o.family } : {},
  trial_end: o.trial_end ?? null,
  items: { data: [{ current_period_end: o.end ?? sec(Date.now() + 30 * DAY), price: { id: 'price_duck', lookup_key: o.price ?? 'duckling_monthly' } }] },
});

beforeAll(async () => {
  cluster = await startCluster();
  const port = await freePort();
  fakeUrl = `http://127.0.0.1:${port}`;
  fake = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (stripeDown) return send(500, { error: { type: 'api_error' } });
      if (req.headers.authorization !== 'Bearer sk_test_duck') return send(401, { error: { type: 'invalid_request_error' } });
      const form = Object.fromEntries(new URLSearchParams(data));
      if (url.startsWith('/v1/prices?') && decodeURIComponent(url).includes('lookup_keys[]=duckling_monthly')) return send(200, { data: [{ id: 'price_duck' }] });
      if (url === '/v1/checkout/sessions' && req.method === 'POST') {
        checkouts.push(form);
        if (rejectIcon && form['branding_settings[icon][type]']) return send(400, { error: { type: 'invalid_request_error', param: 'branding_settings[icon]' } });
        return send(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
      }
      if (url === '/v1/billing_portal/sessions' && req.method === 'POST') { portals.push(form); return send(200, { id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' }); }
      if (url.startsWith('/v1/prices?') && decodeURIComponent(url).includes('lookup_keys[]=')) return send(200, { data: [] });
      if (url === '/v1/billing_portal/configurations' && req.method === 'POST') { setup.portalForms.push(new URLSearchParams(data)); return send(200, { id: 'bpc_new' }); }
      if (url.startsWith('/v1/billing_portal/configurations/')) return url.endsWith('/bpc_keep') ? send(200, { id: 'bpc_keep' }) : send(404, { error: { message: 'No such configuration' } });
      if (url.startsWith('/v1/webhook_endpoints?')) return send(200, { data: setup.endpoints });
      let w = /^\/v1\/webhook_endpoints\/(we_\w+)$/.exec(url);
      if (w && req.method === 'DELETE') { setup.endpoints = setup.endpoints.filter((e) => e.id !== w![1]); setup.deleted.push(w[1]); return send(200, { id: w[1], deleted: true }); }
      if (url === '/v1/webhook_endpoints' && req.method === 'POST') { const f = new URLSearchParams(data); const e = { id: `we_${setup.endpoints.length + 9}`, url: f.get('url')!, events: f.getAll('enabled_events[]') }; setup.endpoints.push(e); return send(200, { ...e, secret: 'whsec_made_here' }); }
      let m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url);
      if (m && req.method === 'GET') { const s = subs.get(m[1]); return s ? send(200, s) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }); }
      if (m && req.method === 'DELETE') { cancelled.push(m[1]); const s = subs.get(m[1]); if (s) s.status = 'canceled'; return send(200, s ?? {}); }
      m = /^\/v1\/subscriptions\?customer=(cus_\w+)/.exec(url);
      if (m && req.method === 'GET') return send(200, { data: [...subs.values()].filter((s) => s.customer === m![1]) });
      send(404, { error: { type: 'invalid_request_error' } });
    });
  }).listen(port, '127.0.0.1');
});
afterAll(async () => { fake?.close(); await cluster?.stop(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-stripe-'));
  const t = await cluster.newDb(); db = t.db; urls = t;
  mails.length = 0; pushes.length = 0; subs.clear(); checkouts.length = 0; portals.length = 0; cancelled.length = 0; stripeDown = false; rejectIcon = false;
  const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456', STRIPE_SECRET_KEY: 'sk_test_duck', STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API: fakeUrl, STRIPE_PORTAL_CONFIGURATION: 'bpc_duck' });
  ({ app } = await buildServer(cfg, {
    db, logger: false,
    mailer: { async send(to, _s, text) { mails.push({ to, text }); } },
    push: async (tokens) => { pushes.push(tokens); return { sent: tokens.length, dead: [] }; },
  }));
});
afterEach(async () => { await app.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

async function familyWithTablet(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email } });
  const token = mails.filter((m) => m.to === email).at(-1)!.text.match(/token=([\w-]+)/)![1];
  const s = (await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } })).json();
  const auth = { authorization: `Bearer ${s.sessionToken}` };
  const child = (await app.inject({ method: 'POST', url: '/children', headers: auth, payload: { firstName: 'Ada', age: 7 } })).json();
  const code = (await app.inject({ method: 'POST', url: '/devices/pairing-codes', headers: auth, payload: { childId: child.id } })).json().code;
  const p = (await app.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'windows', name: 'Surface' } })).json();
  const dev = { authorization: `Device ${p.deviceToken}` };
  await app.inject({ method: 'POST', url: '/device/checkin', headers: dev, payload: { pushToken: `push-${email}` } });
  return { auth, dev, familyId: s.familyId as string };
}
const statusOf = async (dev: Record<string, string>) => (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json().entitlement;

describe('Stripe subscriptions', () => {
  it('maps Stripe states and checks signatures the way Stripe signs them', () => {
    const end = sec(Date.now() + 10 * DAY);
    expect(stripeStatus(sub('sub_1', { status: 'trialing', end }))).toEqual({ status: 'active', periodEnd: new Date(end * 1000).toISOString() });
    expect(stripeStatus(sub('sub_1', { status: 'past_due' }))?.status).toBe('grace');
    expect(stripeStatus(sub('sub_1', { status: 'unpaid' }))?.status).toBe('grace');
    expect(stripeStatus(sub('sub_1', { status: 'canceled' }))?.status).toBe('ended');
    expect(stripeStatus(sub('sub_1', { status: 'incomplete' }))).toBeNull();
    // The older API version kept the period end on the subscription itself.
    expect(stripeStatus({ id: 'sub_2', status: 'active', customer: 'cus_A', current_period_end: end })?.periodEnd).toBe(new Date(end * 1000).toISOString());
    const body = '{"id":"evt_1"}';
    expect(verifyStripeSignature(sign(body), body, SECRET)).toBe(true);
    expect(verifyStripeSignature(sign(body), body + ' ', SECRET)).toBe(false);
    expect(verifyStripeSignature(sign(body, Math.floor(Date.now() / 1000) - 600), body, SECRET)).toBe(false);
    expect(verifyStripeSignature(sign(body, undefined, 'whsec_other'), body, SECRET)).toBe(false);
    expect(verifyStripeSignature(`t=${Math.floor(Date.now() / 1000)},v1=zz,${sign(body).split(',')[1]}`, body, SECRET)).toBe(true);
  });

  it('a tablet subscribes during the trial: billing starts when the trial ends, and webhooks keep the family current', async () => {
    const f = await familyWithTablet('win@example.com');
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: f.dev })).json().cardPayments).toBe(true);
    const r = await app.inject({ method: 'POST', url: '/billing/stripe/checkout', headers: { ...f.dev, 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const c = checkouts[0];
    expect(c.mode).toBe('subscription');
    expect(c['line_items[0][price]']).toBe('price_duck');
    expect(c.client_reference_id).toBe(f.familyId);
    expect(c['subscription_data[metadata][family_id]']).toBe(f.familyId);
    expect(c.customer_email).toBe('win@example.com');
    expect(c.success_url).toBe('https://ducklingtablet.com/checkout/success?from=tablet');
    expect(c['automatic_tax[enabled]']).toBe('true');
    // Duckling's own name, colors and icon on the page.
    expect(c['branding_settings[display_name]']).toBe('Duckling Tablet');
    expect(c['branding_settings[icon][url]']).toBe('https://ducklingtablet.com/logo.png');
    // Seven days of trial left: Stripe is told to start billing at the trial's end.
    const trialEnd = Number(c['subscription_data[trial_end]']);
    expect(Math.abs(trialEnd * 1000 - (Date.now() + 7 * DAY))).toBeLessThan(60_000);

    // Checkout completes; the subscription is trialing at Stripe until the server trial would have ended.
    subs.set('sub_W', sub('sub_W', { status: 'trialing', family: f.familyId, customer: 'cus_W', trial_end: trialEnd, end: trialEnd }));
    expect((await hook({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: { subscription: 'sub_W' } } }, 't=1,v1=00')).statusCode).toBe(400);
    const done = await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', subscription: 'sub_W', customer: 'cus_W', client_reference_id: f.familyId } } });
    expect(done.json()).toEqual({ ok: true });
    expect(await statusOf(f.dev)).toMatchObject({ status: 'active', source: 'stripe' });
    expect(pushes.at(-1)).toEqual(['push-win@example.com']);
    // The same event again does nothing.
    expect((await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { subscription: 'sub_W' } } })).json()).toEqual({ duplicate: true });
    const fam = (await app.inject({ method: 'GET', url: '/family', headers: f.auth })).json();
    // The support report names the family, its purchase and its device.
    const { execFileSync } = await import('node:child_process');
    const report = execFileSync('npx', ['tsx', 'src/family-report.ts', 'WIN@example.com'], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL_APP: urls.appUrl, DATABASE_URL_SYSTEM: urls.systemUrl, DOTENV_CONFIG_PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(report).toContain(`Family ${f.familyId}`);
    expect(report).toMatch(/entitlement: active via stripe/);
    expect(report).toMatch(/purchase stripe stripe:sub_W duckling_monthly: active/);
    expect(report).toMatch(/device dev_\w+ windows "Surface" active/);
    expect(report).toMatch(/Purchases updated in the last day: ?\n.*stripe:sub_W active -> family /);
    expect(fam).toMatchObject({ cardPayments: true, cardCustomer: true, subscription: { status: 'active', source: 'stripe' } });

    // A second Checkout is refused while subscribed; the Customer Portal opens instead, with Duckling's configuration.
    expect((await app.inject({ method: 'POST', url: '/billing/stripe/checkout', headers: f.auth })).statusCode).toBe(409);
    const portal = await app.inject({ method: 'POST', url: '/billing/stripe/portal', headers: f.dev });
    expect(portal.json().url).toBe('https://billing.stripe.com/p/session/bps_1');
    expect(portals[0]).toMatchObject({ customer: 'cus_W', configuration: 'bpc_duck', return_url: 'https://ducklingtablet.com/checkout/return?from=tablet' });

    // The trial is over at both ends (Stripe's trial ends with the server's), and the first renewal fails (the newer
    // invoice shape names the subscription under parent): grace, the tablet keeps going.
    await db.system((q) => q.run(`UPDATE entitlement SET current_period_end = now() - interval '1 hour' WHERE family_id = $1`, [f.familyId]));
    subs.get('sub_W')!.status = 'past_due';
    expect((await hook({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: { id: 'in_1', parent: { subscription_details: { subscription: 'sub_W' } } } } })).json()).toEqual({ ok: true });
    expect((await statusOf(f.dev)).status).toBe('grace');
    // Paid again (the older invoice shape).
    subs.get('sub_W')!.status = 'active';
    expect((await hook({ id: 'evt_3', type: 'invoice.paid', data: { object: { id: 'in_2', subscription: 'sub_W' } } })).json()).toEqual({ ok: true });
    expect((await statusOf(f.dev)).status).toBe('active');
    // Cancelled and over: the family is locked like an ended trial.
    Object.assign(subs.get('sub_W')!, sub('sub_W', { status: 'canceled', family: f.familyId, customer: 'cus_W', end: sec(Date.now() - DAY) }));
    expect((await hook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_W', object: 'subscription' } } })).json()).toEqual({ ok: true });
    const cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: f.dev })).json();
    expect(cfg.entitlement.status).toBe('ended');
    expect(cfg.locked).toBe(true);
  });

  it('a parent subscribes from the portal; other products in the account and unknown families are ignored', async () => {
    const f = await familyWithTablet('portal@example.com');
    const r = await app.inject({ method: 'POST', url: '/billing/stripe/checkout', headers: f.auth });
    expect(r.statusCode).toBe(200);
    expect(checkouts[0]).toMatchObject({ customer_email: 'portal@example.com', success_url: 'http://localhost/?subscribed=1#subscription'.replace('http://localhost', 'https://parents.ducklingtablet.com') });
    // Stripe refusing the icon: the page still opens, with the name and colors.
    rejectIcon = true;
    expect((await app.inject({ method: 'POST', url: '/billing/stripe/checkout', headers: f.auth })).statusCode).toBe(200);
    expect(checkouts.slice(-2).map((x) => [x['branding_settings[icon][type]'] ?? null, x['branding_settings[display_name]']])).toEqual([['url', 'Duckling Tablet'], [null, 'Duckling Tablet']]);
    rejectIcon = false;
    // No customer yet: nothing to manage.
    expect((await app.inject({ method: 'POST', url: '/billing/stripe/portal', headers: f.auth })).statusCode).toBe(404);

    // ET Ducky's own subscriptions live in the same Stripe account and are not Duckling's.
    subs.set('sub_ET', sub('sub_ET', { family: f.familyId, customer: 'cus_ET', price: 'etducky_pro' }));
    expect((await hook({ id: 'evt_et', type: 'customer.subscription.created', data: { object: { id: 'sub_ET' } } })).json()).toEqual({ ignored: true });
    // A Duckling subscription for a family that does not exist here.
    subs.set('sub_X', sub('sub_X', { family: 'fam_nope', customer: 'cus_X' }));
    expect((await hook({ id: 'evt_x', type: 'customer.subscription.created', data: { object: { id: 'sub_X' } } })).json()).toEqual({ ignored: true });
    // Events that carry no subscription.
    expect((await hook({ id: 'evt_c', type: 'customer.created', data: { object: { id: 'cus_Q' } } })).json()).toEqual({ ignored: true });
    expect((await statusOf(f.dev)).status).toBe('trial');

    // Stripe down: 503 so Stripe sends the event again; nothing is recorded.
    subs.set('sub_P', sub('sub_P', { family: f.familyId, customer: 'cus_P' }));
    stripeDown = true;
    expect((await hook({ id: 'evt_p', type: 'customer.subscription.created', data: { object: { id: 'sub_P' } } })).statusCode).toBe(503);
    stripeDown = false;
    expect((await hook({ id: 'evt_p', type: 'customer.subscription.created', data: { object: { id: 'sub_P' } } })).json()).toEqual({ ok: true });
    expect(await statusOf(f.dev)).toMatchObject({ status: 'active', source: 'stripe' });

    // The next Checkout for this family reuses its customer (tax address from the customer record).
    subs.get('sub_P')!.status = 'canceled';
    Object.assign(subs.get('sub_P')!, { items: { data: [{ current_period_end: sec(Date.now() - DAY), price: { lookup_key: 'duckling_monthly' } }] } });
    await hook({ id: 'evt_p2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_P' } } });
    await app.inject({ method: 'POST', url: '/billing/stripe/checkout', headers: f.auth });
    expect(checkouts.at(-1)).toMatchObject({ customer: 'cus_P', 'customer_update[address]': 'auto' });
    expect(checkouts.at(-1)!.customer_email).toBeUndefined();
  });

  it('deleting the account cancels the card subscription first', async () => {
    const f = await familyWithTablet('bye@example.com');
    subs.set('sub_D', sub('sub_D', { family: f.familyId, customer: 'cus_D' }));
    subs.set('sub_D0', sub('sub_D0', { status: 'canceled', family: f.familyId, customer: 'cus_D' }));
    await hook({ id: 'evt_d', type: 'customer.subscription.created', data: { object: { id: 'sub_D' } } });
    stripeDown = true;
    expect((await app.inject({ method: 'DELETE', url: '/family', headers: f.auth, payload: { confirm: 'DELETE' } })).statusCode).toBe(503);
    stripeDown = false;
    const r = await app.inject({ method: 'DELETE', url: '/family', headers: f.auth, payload: { confirm: 'DELETE' } });
    expect(r.json()).toEqual({ deleted: true });
    expect(cancelled).toEqual(['sub_D']);
  });

  it('answers 503 when Stripe is not configured', async () => {
    const f = await familyWithTablet('none@example.com');
    await app.close();
    const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456' });
    ({ app } = await buildServer(cfg, { db, logger: false, stripe: null, mailer: { async send(to, _s, text) { mails.push({ to, text }); } } }));
    expect((await app.inject({ method: 'POST', url: '/billing/stripe/checkout', headers: f.dev })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/device/config', headers: f.dev })).json().cardPayments).toBe(false);
    expect((await hook({ id: 'evt_n', type: 'invoice.paid', data: { object: { subscription: 'sub_N' } } })).statusCode).toBe(400);
  });

  it('stripe-setup makes the portal configuration and replaces only Duckling\'s webhook endpoint', async () => {
    setup.endpoints = [{ id: 'we_1', url: 'https://api.ducklingtablet.com/hooks/stripe' }, { id: 'we_2', url: 'https://api.etducky.com/stripe' }];
    const r = await stripeSetup('sk_test_duck', fakeUrl, 'https://api.ducklingtablet.com', 'https://ducklingtablet.com', 'https://parents.ducklingtablet.com', 'duckling_monthly', 'bpc_gone');
    expect(r.portal).toBe('bpc_new');
    const form = setup.portalForms[0];
    expect(form.get('features[subscription_cancel][mode]')).toBe('at_period_end');
    expect(form.get('business_profile[terms_of_service_url]')).toBe('https://ducklingtablet.com/terms');
    expect(setup.deleted).toEqual(['we_1']);
    expect(setup.endpoints.map((e) => e.url)).toEqual(['https://api.etducky.com/stripe', 'https://api.ducklingtablet.com/hooks/stripe']);
    expect(setup.endpoints[1].events).toEqual(WEBHOOK_EVENTS);
    expect(r.webhook.secret).toBe('whsec_made_here');
    // An existing configuration is kept.
    expect((await stripeSetup('sk_test_duck', fakeUrl, 'https://api.ducklingtablet.com', 'https://ducklingtablet.com', 'https://parents.ducklingtablet.com', 'duckling_monthly', 'bpc_keep')).portal).toBe('bpc_keep');
    await expect(stripeSetup('sk_test_duck', fakeUrl, 'https://api.ducklingtablet.com', 'https://ducklingtablet.com', 'https://parents.ducklingtablet.com', 'no_such_price', '')).rejects.toThrow(/No active price/);
  });
});
