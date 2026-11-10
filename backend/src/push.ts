// Push to tablets through Firebase Cloud Messaging (HTTP v1). One data-only message, {type: 'config-changed'},
// after any parent change; the shell then checks in and applies the new config. Without a service account file
// (FCM_SERVICE_ACCOUNT_FILE) nothing is sent and tablets pick changes up at their three-hourly check-in.
// Returns the tokens FCM no longer knows, so the caller can forget them.
import type { Config } from './config.js';
import { readServiceAccount, accessTokens } from './serviceaccount.js';

export type Push = (tokens: string[], data: Record<string, string>) => Promise<{ sent: number; dead: string[] }>;

export function makeFcm(cfg: Config, log: (msg: string) => void): Push {
  const sa = readServiceAccount(cfg.FCM_SERVICE_ACCOUNT_FILE, 'FCM', log);
  if (!sa) return async () => ({ sent: 0, dead: [] });
  const accessToken = accessTokens(sa, 'https://www.googleapis.com/auth/firebase.messaging', log);

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
