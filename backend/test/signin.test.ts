// Sign in with Apple, Google and Microsoft against the real API, with the providers' key sets replaced by test keys:
// a tablet signs up and a second tablet joins the same family, a verified email reaches the parent who used it before,
// an Apple private relay account is linked from the portal, and tokens that are not ours are refused.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { JWKS_URLS, makeVerifier, TokenError } from '../src/idtoken.js';
import type { Db } from '../src/db.js';
import { startCluster, type Cluster } from './pg.js';

let cluster: Cluster, app: FastifyInstance, db: Db, dir: string;
const mails: { to: string; text: string }[] = [];

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k: KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const KEYS = { keys: [jwk(publicKey, 'k1')] };
const fetchJwks = async (url: string) => { if (!Object.values(JWKS_URLS).includes(url)) throw new Error(url); return KEYS; };

const ISS = { apple: 'https://appleid.apple.com', google: 'https://accounts.google.com', microsoft: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' };
const AUD = { apple: 'com.ducklingtablet.app', google: 'web-client.apps.googleusercontent.com', microsoft: '11111111-2222-3333-4444-555555555555' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(provider: keyof typeof ISS, claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid: opts.kid ?? 'k1' })}.${b64({ iss: ISS[provider], aud: AUD[provider], iat: now, exp: now + 600, ...claims })}`;
  return `${body}.${sign('sha256', Buffer.from(body), opts.key ?? privateKey).toString('base64url')}`;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'duck-signin-'));
  ({ db } = await cluster.newDb());
  mails.length = 0;
  const cfg = loadConfig({ NODE_ENV: 'test', STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), RATE_LIMIT_PER_MINUTE: 5000,
    APPLE_SIGNIN_CLIENT_IDS: `${AUD.apple},com.ducklingtablet.web`, GOOGLE_SIGNIN_CLIENT_IDS: AUD.google, MICROSOFT_SIGNIN_CLIENT_IDS: AUD.microsoft });
  ({ app } = await buildServer(cfg, { db, logger: false, fetchJwks, mailer: { async send(to, subject, text) { mails.push({ to, text: `${subject}\n${text}` }); } }, synth: async () => null, createTicket: async () => null }));
});
afterEach(async () => { await app.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

const nonce = async () => (await app.inject({ method: 'GET', url: '/auth/nonce' })).json().nonce as string;
const tablet = { platform: 'android', name: 'Tablet', childFirstName: 'Ada', childAge: 7 };
const pair = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/auth/provider/pair', payload: { ...tablet, ...body } });

describe('sign in with Apple, Google and Microsoft', () => {
  it('signs a tablet up with Google, and a second tablet with the same account joins the same family', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/providers' })).json().providers.map((p: any) => p.provider)).toEqual(['apple', 'google', 'microsoft']);
    let n = await nonce();
    const first = await pair({ provider: 'google', idToken: token('google', { sub: 'g-1', email: 'Mom@Example.com', email_verified: true, nonce: n }), nonce: n });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ newFamily: true, config: { entitlement: { status: 'trial' }, child: { firstName: 'Ada' } } });
    n = await nonce();
    const second = await pair({ provider: 'google', idToken: token('google', { sub: 'g-1', email: 'mom@example.com', email_verified: true, nonce: n }), nonce: n, platform: 'windows', name: 'Surface' });
    expect(second.json()).toMatchObject({ newFamily: false, config: { child: { firstName: 'Ada' } } });
    const fams = await db.system((q) => q.all('SELECT family_id FROM device'));
    expect(new Set(fams.map((f) => f.family_id)).size).toBe(1);
    expect(await db.system((q) => q.all('SELECT provider, subject, email FROM parent_identity'))).toEqual([{ provider: 'google', subject: 'g-1', email: 'mom@example.com' }]);
  });

  it('reaches the parent who used the same verified email, and an Apple relay account by linking it in the portal', async () => {
    // A parent who signed up with an email code on another tablet.
    await app.inject({ method: 'POST', url: '/auth/code', payload: { email: 'dad@example.com' } });
    const code = mails.at(-1)!.text.replace(/\s/g, '').match(/(\d{6})/)![1];
    const byEmail = (await app.inject({ method: 'POST', url: '/auth/code/pair', payload: { ...tablet, email: 'dad@example.com', code } })).json();
    // Sign in with Apple, sharing that address: the iPad joins the same family.
    let n = await nonce();
    const ipad = await pair({ provider: 'apple', idToken: token('apple', { sub: 'a-1', email: 'dad@example.com', email_verified: 'true', nonce: sha(n) }), nonce: n, platform: 'ios', name: 'iPad' });
    expect(ipad.json().newFamily).toBe(false);
    expect(ipad.json().config.child.firstName).toBe('Ada');
    const famOf = async (dev: string) => (await db.system((q) => q.one('SELECT family_id FROM device WHERE id = $1', [dev])))!.family_id;
    expect(await famOf(ipad.json().deviceId)).toBe(await famOf(byEmail.deviceId));

    // Dad signs in to the portal with Microsoft (same address), and links his wife's hidden-address Apple ID.
    const ms = await app.inject({ method: 'POST', url: '/auth/provider', payload: { provider: 'microsoft', idToken: token('microsoft', { sub: 'm-1', email: 'dad@example.com' }) } });
    expect(ms.statusCode, ms.body).toBe(200);
    const auth = { authorization: `Bearer ${ms.json().sessionToken}` };
    expect(ms.json().familyId).toBe(await famOf(byEmail.deviceId));
    n = await nonce();
    const relay = token('apple', { sub: 'a-2', email: 'x7y8@privaterelay.appleid.com', email_verified: true, is_private_email: true, nonce: sha(n) });
    // Dad already has an Apple ID linked: a second one is refused until the first is removed.
    expect((await app.inject({ method: 'POST', url: '/family/sign-ins', headers: auth, payload: { provider: 'apple', idToken: relay, nonce: n } })).statusCode).toBe(409);
    const removed = (await app.inject({ method: 'DELETE', url: '/family/sign-ins/apple', headers: auth })).json();
    expect(removed.linked.map((l: any) => l.provider)).toEqual(['microsoft']);
    n = await nonce();
    const linked = await app.inject({ method: 'POST', url: '/family/sign-ins', headers: auth, payload: { provider: 'apple', idToken: token('apple', { sub: 'a-2', email: 'x7y8@privaterelay.appleid.com', email_verified: true, nonce: sha(n) }), nonce: n } });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toMatchObject({ email: 'dad@example.com', available: ['apple', 'google', 'microsoft'] });
    expect(linked.json().linked.map((l: any) => [l.provider, l.email])).toEqual([['microsoft', 'dad@example.com'], ['apple', 'x7y8@privaterelay.appleid.com']]);
    // Now an iPad signed in with that relay account joins the same family and its subscription.
    n = await nonce();
    const ipad2 = await pair({ provider: 'apple', idToken: token('apple', { sub: 'a-2', email: 'x7y8@privaterelay.appleid.com', email_verified: true, nonce: sha(n) }), nonce: n, platform: 'ios', name: 'iPad 2' });
    expect(await famOf(ipad2.json().deviceId)).toBe(await famOf(byEmail.deviceId));

    // Another family cannot take an account linked here.
    n = await nonce();
    const g = await app.inject({ method: 'POST', url: '/auth/provider', payload: { provider: 'google', idToken: token('google', { sub: 'g-9', email: 'other@example.com', email_verified: true, nonce: n }), nonce: n } });
    n = await nonce();
    const steal = await app.inject({ method: 'POST', url: '/family/sign-ins', headers: { authorization: `Bearer ${g.json().sessionToken}` },
      payload: { provider: 'apple', idToken: token('apple', { sub: 'a-2', email: 'x7y8@privaterelay.appleid.com', email_verified: true, nonce: sha(n) }), nonce: n } });
    expect(steal.statusCode).toBe(409);
    expect(steal.json().error).toMatch(/another Duckling family/);
  });

  it('refuses tokens that are not ours, not signed by the provider, expired, unverified or replayed', async () => {
    const ok = async (claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; provider?: 'apple' | 'google' } = {}, useNonce = true) => {
      const n = await nonce();
      const p = opts.provider ?? 'google';
      return (await pair({ provider: p, idToken: token(p, { sub: 's', email: 'k@example.com', email_verified: true, ...(useNonce ? { nonce: p === 'apple' ? sha(n) : n } : {}), ...claims }, opts), nonce: n })).statusCode;
    };
    expect(await ok({ aud: 'someone-else' })).toBe(401);
    expect(await ok({ iss: 'https://evil.example' })).toBe(401);
    expect(await ok({}, { key: other.privateKey })).toBe(401);
    expect(await ok({}, { kid: 'unknown' })).toBe(401);
    expect(await ok({ exp: Math.floor(Date.now() / 1000) - 3600 })).toBe(401);
    expect(await ok({ email_verified: false })).toBe(401);
    expect(await ok({}, {}, false)).toBe(401);
    expect(await ok({ nonce: 'made-up' })).toBe(401);
    // A Google nonce given as Apple's hash form, and a nonce used twice.
    const n = await nonce();
    const t = token('google', { sub: 's2', email: 'k2@example.com', email_verified: true, nonce: n });
    expect((await pair({ provider: 'google', idToken: t, nonce: n })).statusCode).toBe(200);
    expect((await pair({ provider: 'google', idToken: t, nonce: n })).statusCode).toBe(401);
    expect((await pair({ provider: 'google', idToken: 'not.a.token.at.all.really.no', nonce: await nonce() })).statusCode).toBe(401);
  });

  it('says a provider that is not set up is not available', async () => {
    await app.close();
    const cfg = loadConfig({ NODE_ENV: 'test', STORAGE: 'local', LOCAL_STORAGE_DIR: join(dir, 'files'), RATE_LIMIT_PER_MINUTE: 5000, GOOGLE_SIGNIN_CLIENT_IDS: AUD.google });
    ({ app } = await buildServer(cfg, { db, logger: false, fetchJwks, mailer: { async send() {} }, synth: async () => null, createTicket: async () => null }));
    expect((await app.inject({ method: 'GET', url: '/auth/providers' })).json().providers).toEqual([{ provider: 'google', clientIds: [AUD.google] }]);
    expect((await pair({ provider: 'apple', idToken: token('apple', { sub: 'x' }), nonce: await nonce() })).statusCode).toBe(503);
  });
});

describe('the token checker', () => {
  it('fetches the provider keys once and again for a new key, and never for a bad token', async () => {
    let fetches = 0;
    const v = makeVerifier(async () => { fetches++; return KEYS; });
    await v('google', token('google', { sub: 'x' }), [AUD.google]);
    await v('google', token('google', { sub: 'y' }), [AUD.google]);
    expect(fetches).toBe(1);
    await expect(v('google', 'a.b', [AUD.google])).rejects.toBeInstanceOf(TokenError);
    expect(fetches).toBe(1);
  });
});
