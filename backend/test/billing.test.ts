// Apple subscriptions end to end on the API: the tablet links a StoreKit 2 transaction, then App Store Server
// Notifications v2 move the family through renewal, grace, expiry and refund. Payloads are built the way Apple's
// library reads them; the verifier runs in its LocalTesting environment (no Apple signature), so everything but the
// signature check is the production code path, including bundle id and environment checks.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { Db } from '../src/db.js';
import { startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string;
const mails: { to: string; text: string }[] = [];
const pushes: string[][] = [];

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-bill-'));
  ({ db } = await cluster.newDb());
  mails.length = 0; pushes.length = 0;
  const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456', APPLE_ENVIRONMENTS: 'LocalTesting' });
  ({ app } = await buildServer(cfg, {
    db, logger: false,
    mailer: { async send(to, _s, text) { mails.push({ to, text }); } },
    push: async (tokens) => { pushes.push(tokens); return { sent: tokens.length, dead: [] }; },
  }));
});
afterEach(async () => { await app.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jws = (payload: unknown) => `${b64({ alg: 'ES256', x5c: [] })}.${b64(payload)}.c2lnbmF0dXJl`;
const DAY = 86_400_000;
const tx = (o: Record<string, unknown>) => jws({
  bundleId: 'com.ducklingtablet.app', environment: 'LocalTesting', productId: 'duckling_monthly', type: 'Auto-Renewable Subscription',
  originalTransactionId: '2000000000000001', transactionId: String(Date.now()), purchaseDate: Date.now(), signedDate: Date.now(),
  expiresDate: Date.now() + 30 * DAY, inAppOwnershipType: 'PURCHASED', ...o,
});
const renewal = (o: Record<string, unknown>) => jws({ environment: 'LocalTesting', originalTransactionId: '2000000000000001', productId: 'duckling_monthly', autoRenewStatus: 1, signedDate: Date.now(), ...o });
const note = (type: string, uuid: string, t: string, r?: string, subtype?: string) => jws({
  notificationType: type, subtype, notificationUUID: uuid, version: '2.0', signedDate: Date.now(),
  data: { bundleId: 'com.ducklingtablet.app', environment: 'LocalTesting', signedTransactionInfo: t, signedRenewalInfo: r },
});

async function familyWithTablet(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email-link', payload: { email } });
  const token = mails.filter((m) => m.to === email).at(-1)!.text.match(/token=([\w-]+)/)![1];
  const s = (await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } })).json();
  const auth = { authorization: `Bearer ${s.sessionToken}` };
  const child = (await app.inject({ method: 'POST', url: '/children', headers: auth, payload: { firstName: 'Ada', age: 7 } })).json();
  const code = (await app.inject({ method: 'POST', url: '/devices/pairing-codes', headers: auth, payload: { childId: child.id } })).json().code;
  const p = (await app.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'ios', name: 'iPad' } })).json();
  const dev = { authorization: `Device ${p.deviceToken}` };
  await app.inject({ method: 'POST', url: '/device/checkin', headers: dev, payload: { pushToken: `push-${email}` } });
  const cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json();
  return { auth, dev, token: cfg.appAccountToken as string, familyId: s.familyId as string };
}
const statusOf = async (dev: Record<string, string>) => (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json().entitlement;

describe('Apple subscriptions', () => {
  it('links a purchase, follows renewal, grace, expiry and refund, and ignores repeats and strangers', async () => {
    const a = await familyWithTablet('apple@example.com');
    expect(a.token).toMatch(/^[0-9a-f-]{36}$/);
    expect((await statusOf(a.dev)).status).toBe('trial');

    // The tablet links its StoreKit transaction.
    const link = await app.inject({ method: 'POST', url: '/billing/apple/link', headers: a.dev, payload: { signedTransaction: tx({ appAccountToken: a.token }) } });
    expect(link.statusCode).toBe(200);
    expect(link.json().entitlement.status).toBe('active');

    // A transaction for the production app or another bundle does not verify here.
    const wrongEnv = await app.inject({ method: 'POST', url: '/billing/apple/link', headers: a.dev, payload: { signedTransaction: tx({ appAccountToken: a.token, environment: 'Sandbox' }) } });
    expect(wrongEnv.statusCode).toBe(400);
    const wrongApp = await app.inject({ method: 'POST', url: '/billing/apple/link', headers: a.dev, payload: { signedTransaction: tx({ appAccountToken: a.token, bundleId: 'com.example.other' }) } });
    expect(wrongApp.statusCode).toBe(400);
    const wrongProduct = await app.inject({ method: 'POST', url: '/billing/apple/link', headers: a.dev, payload: { signedTransaction: tx({ appAccountToken: a.token, productId: 'gems_1000' }) } });
    expect(wrongProduct.statusCode).toBe(400);

    // The family's own free trial ends, so from here the Apple subscription alone decides.
    await db.system((q) => q.run("UPDATE entitlement SET current_period_end = now() - interval '1 day' WHERE family_id = $1", [a.familyId]));
    expect((await statusOf(a.dev)).status).toBe('active');

    // Payment fails and Apple's grace period starts: full use continues.
    const past = Date.now() - DAY;
    const fail = await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: note('DID_FAIL_TO_RENEW', 'n-1', tx({ appAccountToken: a.token, expiresDate: past }), renewal({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: Date.now() + 6 * DAY }), 'GRACE_PERIOD') } });
    expect(fail.json()).toEqual({ ok: true });
    expect((await statusOf(a.dev)).status).toBe('grace');
    // The same notification again changes nothing.
    expect((await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: note('DID_FAIL_TO_RENEW', 'n-1', tx({ appAccountToken: a.token, expiresDate: past }), renewal({ isInBillingRetryPeriod: true }), 'GRACE_PERIOD') } })).json()).toEqual({ duplicate: true });

    // Renewed: active again, and the tablets were told.
    await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: note('DID_RENEW', 'n-2', tx({ appAccountToken: a.token, expiresDate: Date.now() + 30 * DAY })) } });
    expect((await statusOf(a.dev)).status).toBe('active');

    // Refunded: ended at once, even though the period had time left.
    await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: note('REFUND', 'n-3', tx({ appAccountToken: a.token, revocationDate: Date.now(), revocationReason: 0 })) } });
    expect((await statusOf(a.dev)).status).toBe('ended');

    // A later notification without the token still finds the family through the subscription it already holds.
    await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: note('SUBSCRIBED', 'n-4', tx({ expiresDate: Date.now() + 30 * DAY }), undefined, 'RESUBSCRIBE') } });
    expect((await statusOf(a.dev)).status).toBe('active');

    // Another family cannot take this subscription over by linking it from their tablet.
    const b = await familyWithTablet('other@example.com');
    const steal = await app.inject({ method: 'POST', url: '/billing/apple/link', headers: b.dev, payload: { signedTransaction: tx({ appAccountToken: a.token }) } });
    expect(steal.statusCode).toBe(409);
    expect((await statusOf(b.dev)).status).toBe('trial');

    // A notification for a subscription nobody here holds is acknowledged and ignored; Apple's test ping too.
    expect((await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: note('DID_RENEW', 'n-5', tx({ originalTransactionId: '9999', appAccountToken: '00000000-0000-4000-8000-000000000000' })) } })).json()).toEqual({ ignored: true });
    expect((await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: jws({ notificationType: 'TEST', notificationUUID: 't-1', version: '2.0', signedDate: Date.now(), data: { bundleId: 'com.ducklingtablet.app', environment: 'LocalTesting' } }) } })).json()).toEqual({ ignored: true });
    // A payload that is not Apple's shape is refused.
    expect((await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: 'not.a.jws-at-all-really' } })).statusCode).toBe(401);
    // Every change reached the family's tablets as a push.
    expect(pushes.filter((t) => t.includes('push-apple@example.com')).length).toBeGreaterThanOrEqual(4);
  });

  it('answers 503 when Apple billing is not configured', async () => {
    await app.close();
    const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456', APPLE_ENVIRONMENTS: 'Production', APPLE_ROOT_CERTS: join(dir, 'none') });
    ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send(to, _s, text) { mails.push({ to, text }); } }, push: async () => ({ sent: 0, dead: [] }) }));
    expect((await app.inject({ method: 'POST', url: '/hooks/apple', payload: { signedPayload: jws({ x: 1 }) } })).statusCode).toBe(503);
  });
});
