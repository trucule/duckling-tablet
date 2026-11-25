// Sign in with Apple, Google or Microsoft: the ID token a tablet or the portal got from the provider, checked here
// against the provider's published keys. A token is accepted only when its signature, issuer, audience (one of our
// own client ids) and times are right. Microsoft is personal accounts only (the consumers tenant), whose email is the
// account's verified sign-in name; a work or school account's email claim is not verified, so it is not accepted.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';

export type Provider = 'apple' | 'google' | 'microsoft';
export const PROVIDERS: Provider[] = ['apple', 'google', 'microsoft'];

export interface IdClaims { provider: Provider; subject: string; email: string | null; emailVerified: boolean; privateEmail: boolean; nonce: string | null }

const ISSUERS: Record<Provider, string[]> = {
  apple: ['https://appleid.apple.com'],
  google: ['https://accounts.google.com', 'accounts.google.com'],
  microsoft: ['https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0'],
};
export const JWKS_URLS: Record<Provider, string> = {
  apple: 'https://appleid.apple.com/auth/keys',
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  microsoft: 'https://login.microsoftonline.com/consumers/discovery/v2.0/keys',
};

export type FetchJson = (url: string) => Promise<unknown>;
const defaultFetch: FetchJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`keys ${r.status}`);
  return r.json();
};

export class TokenError extends Error {}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const SKEW = 120;   // seconds of clock difference allowed

/** Keys per provider, fetched once an hour, and again (at most once a minute) when a token names a key not held. */
export function makeVerifier(fetchJson: FetchJson = defaultFetch, now = () => Date.now()) {
  const cache = new Map<Provider, { keys: (JsonWebKey & { kid?: string })[]; at: number }>();
  const keysFor = async (p: Provider, kid: string) => {
    const c = cache.get(p);
    const fresh = c && now() - c.at < 3_600_000;
    const found = c?.keys.find((k) => k.kid === kid);
    if (found && fresh) return found;
    if (c && found && now() - c.at < 60_000) return found;
    if (!c || now() - c.at > 60_000) {
      const j = (await fetchJson(JWKS_URLS[p])) as { keys?: (JsonWebKey & { kid?: string })[] };
      cache.set(p, { keys: Array.isArray(j?.keys) ? j.keys : [], at: now() });
    }
    return cache.get(p)!.keys.find((k) => k.kid === kid) ?? null;
  };

  return async function verifyIdToken(provider: Provider, token: string, audiences: string[]): Promise<IdClaims> {
    if (!audiences.length) throw new TokenError(`Sign in with ${provider} is not set up`);
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('Not a token');
    let header: { alg?: string; kid?: string }, payload: Record<string, unknown>;
    try { header = JSON.parse(b64(parts[0]).toString('utf8')); payload = JSON.parse(b64(parts[1]).toString('utf8')); } catch { throw new TokenError('Not a token'); }
    if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new TokenError('Unsupported token');
    const jwk = await keysFor(provider, String(header.kid ?? ''));
    if (!jwk) throw new TokenError('Unknown signing key');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, b64(parts[2]));
    if (!ok) throw new TokenError('Bad signature');

    const t = Math.floor(now() / 1000);
    if (!ISSUERS[provider].includes(String(payload.iss))) throw new TokenError('Wrong issuer');
    const aud = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
    if (!aud.some((a) => audiences.includes(a))) throw new TokenError('Wrong audience');
    if (typeof payload.exp !== 'number' || payload.exp + SKEW < t) throw new TokenError('Expired');
    if (typeof payload.iat === 'number' && payload.iat - SKEW > t) throw new TokenError('Issued in the future');
    if (typeof payload.nbf === 'number' && payload.nbf - SKEW > t) throw new TokenError('Not yet valid');
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject || subject.length > 255) throw new TokenError('No subject');

    const email = typeof payload.email === 'string' && payload.email.includes('@') ? payload.email.trim().toLowerCase().slice(0, 254) : null;
    const flag = (v: unknown) => v === true || v === 'true';
    // Apple and Google say whether the address was verified; a personal Microsoft account's email is its sign-in name.
    const emailVerified = !!email && (provider === 'microsoft' ? true : flag(payload.email_verified));
    return { provider, subject, email, emailVerified, privateEmail: flag(payload.is_private_email), nonce: typeof payload.nonce === 'string' ? payload.nonce : null };
  };
}
export type VerifyIdToken = ReturnType<typeof makeVerifier>;

// Nonces the server hands out before a sign-in: an expiry and random bytes, signed with the session secret. The
// provider puts the nonce (Google) or its SHA-256 (Apple) into the token, so a token can only be used with a nonce
// this server made in the last ten minutes, and each nonce only once.
export function makeNonces(secret: string, now = () => Date.now()) {
  const used = new Map<string, number>();
  const sign = (body: string) => createHmac('sha256', secret).update(`nonce:${body}`).digest('base64url').slice(0, 32);
  return {
    issue(): string { const body = `${now() + 10 * 60_000}.${randomBytes(12).toString('base64url')}`; return `${body}.${sign(body)}`; },
    /** True once for a nonce this server made that has not expired, matching the token's nonce claim. */
    redeem(nonce: string, claim: string | null): boolean {
      const m = /^(\d+)\.([\w-]+)\.([\w-]+)$/.exec(nonce);
      if (!m || Number(m[1]) < now()) return false;
      const want = Buffer.from(sign(`${m[1]}.${m[2]}`)), got = Buffer.from(m[3]);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
      if (claim !== nonce && claim !== createHash('sha256').update(nonce).digest('hex')) return false;
      for (const [k, exp] of used) if (exp < now()) used.delete(k);
      if (used.has(nonce)) return false;
      used.set(nonce, Number(m[1]));
      return true;
    },
  };
}
