// Google service accounts: read the key file once and mint OAuth 2 access tokens with a signed JWT (RS256), the way
// service accounts authenticate. A token is good for an hour and is renewed at 55 minutes. Used for FCM (push) and
// the Google Play Developer API (subscriptions).
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

export interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

export function readServiceAccount(file: string, what: string, log: (msg: string) => void): ServiceAccount | null {
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as ServiceAccount; }
  catch (e) { log(`${what} service account not readable: ${(e as Error).message}`); return null; }
}

export function accessTokens(sa: ServiceAccount, scope: string, log: (msg: string) => void): () => Promise<string | null> {
  let access: { token: string; until: number } | null = null;
  return async () => {
    if (access && access.until > Date.now()) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const uri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: uri, iat: now, exp: now + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const r = await fetch(uri, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r || !r.ok) { log(`Google token request failed for ${scope}: ${r?.status ?? 'network'}`); return null; }
    const j = (await r.json()) as { access_token: string; expires_in: number };
    access = { token: j.access_token, until: Date.now() + Math.min(j.expires_in - 300, 3300) * 1000 };
    return access.token;
  };
}
