// Google Play subscriptions end to end on the API: the tablet links a purchase token, then Real-time Developer
// Notifications (Pub/Sub push) move the family through grace, hold, cancellation, expiry and a new purchase. The Play
// Developer API and Google's OAuth token endpoint are a local fake HTTP server, reached through the production code
// (service account JWT, subscriptionsv2.get, acknowledge); the Pub/Sub OIDC tokens are RS256 JWTs signed with a test
// key and checked by the production verifier against that key's JWKS.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { makePushAuth, googleStatus, type GoogleSubscription } from '../src/google.js';
import type { Db } from '../src/db.js';
import { freePort, startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string, fake: Server, fakeUrl: string;
const mails: { to: string; text: string }[] = [];
const pushes: string[][] = [];
// The fake Play Developer API: subscriptions by token, the acknowledgements it received, and whether it is up.
const subs = new Map<string, GoogleSubscription>();
const acks: string[] = [];
let playDown = false;
const DAY = 86_400_000;
const AUD = 'https://api.ducklingtablet.com/hooks/google';
const PUSHER = 'rtdn-push@duckling-tablet.iam.gserviceaccount.com';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(keys.publicKey as KeyObject).export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function oidc(claims: Record<string, unknown>, kid = 'k1', key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: AUD, email: PUSHER, email_verified: true, iat: now, exp: now + 3600, ...claims })}`;
  return `Bearer ${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`;
}

beforeAll(async () => {
  cluster = await startCluster();
  const port = await freePort();
  fakeUrl = `http://127.0.0.1:${port}`;
  fake = createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/token') return send(200, { access_token: 'play-access', expires_in: 3600 });
    if (playDown) return send(500, { error: 'down' });
    if (req.headers.authorization !== 'Bearer play-access') return send(401, {});
    let m = /^\/androidpublisher\/v3\/applications\/com\.ducklingtablet\.app\/purchases\/subscriptionsv2\/tokens\/([^/]+)$/.exec(url);
    if (m && req.method === 'GET') { const s = subs.get(decodeURIComponent(m[1])); return s ? send(200, s) : send(404, {}); }
    m = /^\/androidpublisher\/v3\/applications\/com\.ducklingtablet\.app\/purchases\/subscriptions\/([^/]+)\/tokens\/([^/]+):acknowledge$/.exec(url);
    if (m && req.method === 'POST') {
      const t = decodeURIComponent(m[2]); acks.push(t);
      const s = subs.get(t); if (s) s.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      return send(200, {});
    }
    send(404, {});
  }).listen(port, '127.0.0.1');
});
afterAll(async () => { fake?.close(); await cluster?.stop(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-google-'));
  ({ db } = await cluster.newDb());
  mails.length = 0; pushes.length = 0; subs.clear(); acks.length = 0; playDown = false;
  const saFile = join(dir, 'sa.json');
  writeFileSync(saFile, JSON.stringify({ project_id: 'duckling-tablet', client_email: 'play@duckling-tablet.iam.gserviceaccount.com', private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), token_uri: `${fakeUrl}/token` }));
  const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456', GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: saFile, ANDROID_PUBLISHER_ENDPOINT: fakeUrl, GOOGLE_PUSH_SERVICE_ACCOUNT: PUSHER });
  ({ app } = await buildServer(cfg, {
    db, logger: false,
    mailer: { async send(to, _s, text) { mails.push({ to, text }); } },
    push: async (tokens) => { pushes.push(tokens); return { sent: tokens.length, dead: [] }; },
    googlePushAuth: makePushAuth(cfg, async () => ({ keys: [jwk] })),
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
  const p = (await app.inject({ method: 'POST', url: '/devices/pair', payload: { code, platform: 'android', name: 'Tab' } })).json();
  const dev = { authorization: `Device ${p.deviceToken}` };
  await app.inject({ method: 'POST', url: '/device/checkin', headers: dev, payload: { pushToken: `push-${email}` } });
  const cfg = (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json();
  return { auth, dev, token: cfg.appAccountToken as string, familyId: s.familyId as string };
}
const statusOf = async (dev: Record<string, string>) => (await app.inject({ method: 'GET', url: '/device/config', headers: dev })).json().entitlement;
const sub = (o: Partial<GoogleSubscription> & { account?: string; expires?: number }): GoogleSubscription => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', latestOrderId: 'GPA.1',
  lineItems: [{ productId: 'duckling_monthly', expiryTime: new Date(o.expires ?? Date.now() + 30 * DAY).toISOString() }],
  externalAccountIdentifiers: o.account ? { obfuscatedExternalAccountId: o.account } : undefined, ...o,
});
let msg = 0;
const rtdn = (purchaseToken: string, type = 4, extra: Record<string, unknown> = {}, id = `m-${++msg}`) => ({
  message: { messageId: id, data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.ducklingtablet.app', eventTimeMillis: String(Date.now()), subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken, subscriptionId: 'duckling_monthly' }, ...extra })).toString('base64') },
  subscription: 'projects/duckling-tablet/subscriptions/rtdn-push',
});
const hook = (payload: unknown, authorization = oidc({})) => app.inject({ method: 'POST', url: '/hooks/google', headers: { authorization }, payload });

describe('Google Play subscriptions', () => {
  it('links a purchase, acknowledges it, and follows grace, hold, cancel, expiry and a new purchase', async () => {
    const a = await familyWithTablet('play@example.com');
    expect((await statusOf(a.dev)).status).toBe('trial');
    subs.set('purchase-token-1', sub({ account: a.token }));

    const link = await app.inject({ method: 'POST', url: '/billing/google/link', headers: a.dev, payload: { purchaseToken: 'purchase-token-1', productId: 'duckling_monthly' } });
    expect(link.statusCode).toBe(200);
    expect(link.json().entitlement.status).toBe('active');
    expect(acks).toEqual(['purchase-token-1']);
    // Linking again (a restore) does not acknowledge twice.
    await app.inject({ method: 'POST', url: '/billing/google/link', headers: a.dev, payload: { purchaseToken: 'purchase-token-1', productId: 'duckling_monthly' } });
    expect(acks).toEqual(['purchase-token-1']);

    // Unknown tokens and products are refused.
    expect((await app.inject({ method: 'POST', url: '/billing/google/link', headers: a.dev, payload: { purchaseToken: 'purchase-token-unknown', productId: 'duckling_monthly' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/billing/google/link', headers: a.dev, payload: { purchaseToken: 'purchase-token-1', productId: 'gems_1000' } })).statusCode).toBe(400);

    // The free trial ends, so the Play subscription alone decides from here.
    await db.system((q) => q.run("UPDATE entitlement SET current_period_end = now() - interval '1 day' WHERE family_id = $1", [a.familyId]));
    expect((await statusOf(a.dev)).status).toBe('active');

    // Payment fails: grace, then account hold (no access).
    subs.set('purchase-token-1', sub({ account: a.token, subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }));
    const g = rtdn('purchase-token-1', 6);
    expect((await hook(g)).json()).toEqual({ ok: true });
    expect((await statusOf(a.dev)).status).toBe('grace');
    expect((await hook(g)).json()).toEqual({ duplicate: true });
    subs.set('purchase-token-1', sub({ account: a.token, subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD', expires: Date.now() - DAY }));
    await hook(rtdn('purchase-token-1', 5));
    expect((await statusOf(a.dev)).status).toBe('ended');

    // Recovered, then cancelled: still active until the paid month ends, then ended.
    subs.set('purchase-token-1', sub({ account: a.token, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }));
    await hook(rtdn('purchase-token-1', 1));
    expect((await statusOf(a.dev)).status).toBe('active');
    subs.set('purchase-token-1', sub({ account: a.token, subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }));
    await hook(rtdn('purchase-token-1', 3));
    expect((await statusOf(a.dev)).status).toBe('active');
    subs.set('purchase-token-1', sub({ account: a.token, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', expires: Date.now() - DAY }));
    await hook(rtdn('purchase-token-1', 13));
    expect((await statusOf(a.dev)).status).toBe('ended');

    // Bought again later: a new token naming the old one, found through it even without the account id; acknowledged.
    subs.set('purchase-token-2', sub({ linkedPurchaseToken: 'purchase-token-1' }));
    expect((await hook(rtdn('purchase-token-2', 4))).json()).toEqual({ ok: true });
    expect((await statusOf(a.dev)).status).toBe('active');
    expect(acks).toContain('purchase-token-2');

    // Another family cannot take the subscription over from their tablet.
    const b = await familyWithTablet('other@example.com');
    expect((await app.inject({ method: 'POST', url: '/billing/google/link', headers: b.dev, payload: { purchaseToken: 'purchase-token-2', productId: 'duckling_monthly' } })).statusCode).toBe(409);
    expect((await statusOf(b.dev)).status).toBe('trial');

    // Every change reached the family's tablets as a push.
    expect(pushes.filter((t) => t.includes('push-play@example.com')).length).toBeGreaterThanOrEqual(6);
  });

  it('refuses pushes without a valid Google token, ignores what is not ours, and asks Pub/Sub to retry when Play is down', async () => {
    const a = await familyWithTablet('push@example.com');
    subs.set('purchase-token-9', sub({ account: a.token }));
    // No token, a token for another audience, another sender, an expired one, an unknown key, a bad signature.
    expect((await hook(rtdn('purchase-token-9'), '')).statusCode).toBe(401);
    expect((await hook(rtdn('purchase-token-9'), oidc({ aud: 'https://example.com/hooks/google' }))).statusCode).toBe(401);
    expect((await hook(rtdn('purchase-token-9'), oidc({ email: 'someone@example.com' }))).statusCode).toBe(401);
    expect((await hook(rtdn('purchase-token-9'), oidc({ exp: Math.floor(Date.now() / 1000) - 600 }))).statusCode).toBe(401);
    expect((await hook(rtdn('purchase-token-9'), oidc({}, 'k2'))).statusCode).toBe(401);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect((await hook(rtdn('purchase-token-9'), oidc({}, 'k1', other.privateKey))).statusCode).toBe(401);
    expect((await statusOf(a.dev)).status).toBe('trial');

    // Another app's notification, Google's test notification, a token nobody holds: acknowledged and ignored.
    const foreign = rtdn('purchase-token-9'); foreign.message.data = Buffer.from(JSON.stringify({ packageName: 'com.example.other', subscriptionNotification: { purchaseToken: 'purchase-token-9', subscriptionId: 'duckling_monthly' } })).toString('base64');
    expect((await hook(foreign)).json()).toEqual({ ignored: true });
    const test = rtdn('x'); test.message.data = Buffer.from(JSON.stringify({ packageName: 'com.ducklingtablet.app', testNotification: { version: '1.0' } })).toString('base64');
    expect((await hook(test)).json()).toEqual({ ignored: true });
    expect((await hook(rtdn('purchase-token-nobody'))).json()).toEqual({ ignored: true });

    // Play unreachable: 503, so Pub/Sub sends it again; the message id is not used up.
    playDown = true;
    const m = rtdn('purchase-token-9', 4);
    expect((await hook(m)).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/billing/google/link', headers: a.dev, payload: { purchaseToken: 'purchase-token-9', productId: 'duckling_monthly' } })).statusCode).toBe(503);
    playDown = false;
    expect((await hook(m)).json()).toEqual({ ok: true });
    expect((await statusOf(a.dev)).status).toBe('active');

    // A purchase still waiting for payment is not a subscription yet.
    subs.set('purchase-token-p', sub({ account: a.token, subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }));
    const pend = await app.inject({ method: 'POST', url: '/billing/google/link', headers: a.dev, payload: { purchaseToken: 'purchase-token-p', productId: 'duckling_monthly' } });
    expect(pend.json().pending).toBe(true);
    expect(acks).not.toContain('purchase-token-p');
  });

  it('maps every subscription state', () => {
    const at = Date.now();
    const s = (state: string, expires: number) => googleStatus(sub({ subscriptionState: state, expires }), at)?.status ?? null;
    expect(s('SUBSCRIPTION_STATE_ACTIVE', at + DAY)).toBe('active');
    expect(s('SUBSCRIPTION_STATE_IN_GRACE_PERIOD', at - DAY)).toBe('grace');
    expect(s('SUBSCRIPTION_STATE_ON_HOLD', at - DAY)).toBe('ended');
    expect(s('SUBSCRIPTION_STATE_PAUSED', at - DAY)).toBe('ended');
    expect(s('SUBSCRIPTION_STATE_CANCELED', at + DAY)).toBe('active');
    expect(s('SUBSCRIPTION_STATE_CANCELED', at - DAY)).toBe('ended');
    expect(s('SUBSCRIPTION_STATE_EXPIRED', at - DAY)).toBe('ended');
    expect(s('SUBSCRIPTION_STATE_PENDING', at + DAY)).toBe(null);
  });

  it('answers 503 when Google Play billing is not configured', async () => {
    await app.close();
    const cfg = loadConfig({ NODE_ENV: 'test', LOCAL_STORAGE_DIR: join(dir, 'files'), STORAGE: 'local', ADMIN_TOKEN: 'admin-test-token-123456' });
    ({ app } = await buildServer(cfg, { db, logger: false, mailer: { async send() {} }, push: async () => ({ sent: 0, dead: [] }), googlePushAuth: async () => true }));
    expect((await app.inject({ method: 'POST', url: '/hooks/google', payload: rtdn('purchase-token-1') })).statusCode).toBe(503);
  });
});
