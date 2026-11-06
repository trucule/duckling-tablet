// Push to tablets through Firebase Cloud Messaging (HTTP v1). One data-only message, {type: 'config-changed'},
// after any parent change; the shell then checks in and applies the new config. Without a service account file
// (FCM_SERVICE_ACCOUNT_FILE) nothing is sent and tablets pick changes up at their three-hourly check-in.
// Returns the tokens FCM no longer knows, so the caller can forget them.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import type { Config } from './config.js';

export type Push = (tokens: string[], data: Record<string, string>) => Promise<{ sent: number; dead: string[] }>;

interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

export function makeFcm(cfg: Config, log: (msg: string) => void): Push {
  let account: ServiceAccount | null = null;
  try { if (cfg.FCM_SERVICE_ACCOUNT_FILE) account = JSON.parse(readFileSync(cfg.FCM_SERVICE_ACCOUNT_FILE, 'utf8')); }
  catch (e) { log(`FCM service account not readable: ${(e as Error).message}`); }
  if (!account) return async () => ({ sent: 0, dead: [] });
  const sa = account;
  let access: { token: string; until: number } | null = null;

  // OAuth 2 with a signed JWT (RS256), the way service accounts authenticate; good for an hour, renewed at 55 minutes.
  async function accessToken(): Promise<string | null> {
    if (access && access.until > Date.now()) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const r = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r || !r.ok) { log(`FCM token request failed: ${r?.status ?? 'network'}`); return null; }
    const j = (await r.json()) as { access_token: string; expires_in: number };
    access = { token: j.access_token, until: Date.now() + Math.min(j.expires_in - 300, 3300) * 1000 };
    return access.token;
  }

  return async (tokens, data) => {
    const dead: string[] = [];
    let sent = 0;
    const bearer = tokens.length ? await accessToken() : null;
    if (!bearer) return { sent, dead };
    for (const token of tokens) {
      const r = await fetch(`${cfg.FCM_ENDPOINT}/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ message: { token, data, android: { priority: 'high', ttl: '3600s' }, apns: { headers: { 'apns-priority': '5', 'apns-push-type': 'background' }, payload: { aps: { 'content-available': 1 } } } } }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (r?.ok) { sent++; continue; }
      const body = r ? await r.text().catch(() => '') : '';
      if (r && (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(body))) dead.push(token);
      else log(`FCM send failed: ${r?.status ?? 'network'}`);
    }
    return { sent, dead };
  };
}
