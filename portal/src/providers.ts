import { tr } from './i18n';

// Sign in with Apple, Google or Microsoft in the portal. Each returns the provider's ID token for the API to check.
// Apple uses its own script in a popup. Google and Microsoft open their sign-in page in a popup that comes back to
// /signin-done.html on this site with the token in the address fragment, which this page reads and the popup never
// sends anywhere. No provider script runs on the portal except Apple's.

export type Provider = 'apple' | 'google' | 'microsoft';
export const PROVIDER_NAMES: Record<Provider, string> = { apple: 'Apple', google: 'Google', microsoft: 'Microsoft' };
export const continueWith = (p: Provider) => p === 'apple' ? tr('Continue with Apple') : p === 'google' ? tr('Continue with Google') : tr('Continue with Microsoft');

export class SignInCancelled extends Error {}

const randomState = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

declare global {
  interface Window { AppleID?: { auth: { init(o: Record<string, unknown>): void; signIn(): Promise<{ authorization: { id_token: string; state?: string } }> } } }
}

let appleScript: Promise<void> | null = null;
function loadApple(): Promise<void> {
  if (window.AppleID) return Promise.resolve();
  appleScript ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    s.onload = () => resolve();
    s.onerror = () => { appleScript = null; reject(new Error(tr('That sign-in did not open. Check the connection and try again.'))); };
    document.head.appendChild(s);
  });
  return appleScript;
}

async function apple(clientId: string, nonce: string): Promise<string> {
  await loadApple();
  const state = randomState();
  window.AppleID!.auth.init({ clientId, scope: 'email', redirectURI: `${location.origin}/`, state, nonce, usePopup: true });
  try {
    const r = await window.AppleID!.auth.signIn();
    if (r.authorization.state && r.authorization.state !== state) throw new Error(tr('That sign-in could not be checked. Try again.'));
    return r.authorization.id_token;
  } catch (e) {
    const err = (e as { error?: string }).error;
    if (err === 'popup_closed_by_user' || err === 'user_cancelled_authorize') throw new SignInCancelled();
    throw e instanceof Error ? e : new Error(tr('That sign-in did not finish. Try again.'));
  }
}

const SCOPE = ['openid', 'email', 'profile'].join(' ');
const RETURN_PATH = '/signin-done.html';

const AUTHORIZE: Record<'google' | 'microsoft', string> = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  microsoft: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
};

function popupFlow(provider: 'google' | 'microsoft', clientId: string, nonce: string): Promise<string> {
  const state = randomState();
  const u = new URL(AUTHORIZE[provider]);
  u.search = new URLSearchParams({
    client_id: clientId, response_type: 'id_token', response_mode: 'fragment', scope: SCOPE,
    redirect_uri: location.origin + RETURN_PATH, nonce, state, prompt: 'select_account',
  }).toString();
  const w = window.open(u.toString(), 'duckling-signin', 'width=500,height=650');
  if (!w) return Promise.reject(new Error(tr('The sign-in window was blocked. Allow pop-ups for this site and try again.')));
  return new Promise<string>((resolve, reject) => {
    const timer = window.setInterval(() => {
      if (w.closed) { window.clearInterval(timer); reject(new SignInCancelled()); return; }
      let hash = '';
      try { if (w.location.origin !== location.origin) return; hash = w.location.hash; } catch { return; } // still on the provider's page
      if (!hash) return;
      window.clearInterval(timer);
      w.close();
      const p = new URLSearchParams(hash.slice(1));
      if (p.get('state') !== state) { reject(new Error(tr('That sign-in could not be checked. Try again.'))); return; }
      if (p.get('error')) { reject(p.get('error') === 'access_denied' ? new SignInCancelled() : new Error(tr('That sign-in did not finish. Try again.'))); return; }
      const token = p.get('id_token');
      token ? resolve(token) : reject(new Error(tr('That sign-in did not finish. Try again.')));
    }, 300);
  });
}

export function providerToken(provider: Provider, clientId: string, nonce: string): Promise<string> {
  return provider === 'apple' ? apple(clientId, nonce) : popupFlow(provider, clientId, nonce);
}

// The client id the portal asks a provider for. Apple's is the Services ID (com.ducklingtablet.web), not the app's
// bundle id; Google's and Microsoft's are the single web client the server lists.
export function portalClientId(provider: Provider, clientIds: string[]): string | undefined {
  return provider === 'apple' ? clientIds.find((c) => c.endsWith('.web')) : clientIds[0];
}
