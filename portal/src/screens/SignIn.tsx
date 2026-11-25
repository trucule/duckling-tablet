import { tr, trn } from '../i18n';
import { useEffect, useState } from 'preact/hooks';
import { api, session } from '../api';
import { continueWith, portalClientId, providerToken, SignInCancelled, type Provider } from '../providers';

// The providers set up on the server that the portal can use, with the client id to ask each for.
export function useProviders() {
  const [list, setList] = useState<{ provider: Provider; clientId: string }[]>([]);
  useEffect(() => {
    api.signInProviders().then((r) => setList(r.providers.flatMap((p) => { const c = portalClientId(p.provider, p.clientIds); return c ? [{ provider: p.provider, clientId: c }] : []; }))).catch(() => {});
  }, []);
  return list;
}

// Opens the provider's sign-in and hands its token and this server's nonce to `use`. A closed window is not an error.
export async function withProvider(p: { provider: Provider; clientId: string }, use: (idToken: string, nonce: string) => Promise<void>) {
  const { nonce } = await api.signInNonce();
  let token: string;
  try { token = await providerToken(p.provider, p.clientId, nonce); } catch (e) { if (e instanceof SignInCancelled) return; throw e; }
  await use(token, nonce);
}

// Email sign-in. In a browser the email has a link; /signin?token=... is redeemed here and the token leaves the URL.
// As an iPhone or iPad home-screen app (navigator.standalone) the email has a six-digit code typed here instead: iOS
// opens mail links in Safari, which keeps its own sign-in, so a link would never sign in the home-screen app.
const iosHomeScreen = (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<false | 'link' | 'code'>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const providers = useProviders();
  const viaProvider = (p: { provider: Provider; clientId: string }) => async () => {
    setBusy(true); setError('');
    try { await withProvider(p, async (idToken, nonce) => { const r = await api.providerSignIn(p.provider, idToken, nonce); session.set(r.sessionToken); onSignedIn(); }); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token');
    if (!token) return;
    history.replaceState(null, '', '/');
    setBusy(true);
    api.verify(token).then((r) => { session.set(r.sessionToken); onSignedIn(); })
      .catch((e) => setError((e as Error).message)).finally(() => setBusy(false));
  }, []);
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError('');
    try { const r = await api.emailLink(email.trim(), iosHomeScreen ? 'code' : 'link'); setSent(r.delivery ?? 'link'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const check = async (e: Event) => {
    e.preventDefault(); setBusy(true); setError('');
    try { const r = await api.verifyCode(email.trim(), code.replace(/\D/g, '')); session.set(r.sessionToken); onSignedIn(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <div class="card" style={{ maxWidth: 520, margin: '40px auto' }}>
      <h1>{tr('Sign in')}</h1>
      {sent === 'link' && <p class="ok">{tr('Check your email for a sign-in link from hello@ducklingtablet.com. It works once and expires in 15 minutes.')}</p>}
      {sent === 'code' ? (
        <form onSubmit={check}>
          <p>{tr('We sent a code to {email}. Type it here.', { email: email.trim() })}</p>
          <label class="field"><span>{tr('Code')}</span>
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required value={code}
              onInput={(e) => setCode((e.target as HTMLInputElement).value)} autoFocus style={{ fontSize: 24, letterSpacing: '0.15em' }} />
          </label>
          {error && <div class="error">{error}</div>}
          <button class="btn primary" disabled={busy || code.replace(/\D/g, '').length !== 6}>{busy ? tr('Working') : tr('Sign in')}</button>
          <p class="muted">{tr('No email? Check spam, or')} <a href="#" onClick={(e) => { e.preventDefault(); setSent(false); setCode(''); setError(''); }}>{tr('send a new code')}</a>{tr('. The code works once and expires in 15 minutes.')}</p>
        </form>
      ) : !sent && (
        <form onSubmit={submit}>
          <p>{iosHomeScreen ? tr('Type your email address and we send a code. No password to remember. The first sign-in creates your family account.') : tr('Type your email address and we send a link. No password to remember. The first sign-in creates your family account.')}</p>
          <label class="field"><span>{tr('Email')}</span><input type="email" autoComplete="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autoFocus /></label>
          {error && <div class="error">{error}</div>}
          <button class="btn primary" disabled={busy || !email}>{busy ? tr('Working') : iosHomeScreen ? tr('Send me a code') : tr('Send me a link')}</button>
          {providers.length > 0 && <div class="signin-providers">
            <p class="muted">{tr('Or sign in with an account you already have. A tablet set up with the same account is in the same family.')}</p>
            {providers.map((p) => <button type="button" key={p.provider} class={`btn signin ${p.provider}`} disabled={busy} onClick={viaProvider(p)}>{continueWith(p.provider)}</button>)}
          </div>}
        </form>
      )}
      {!sent && error && <p class="muted">{tr('A link that failed can be replaced by asking for a new one above.')}</p>}
    </div>
  );
}
