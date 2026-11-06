import { useEffect, useState } from 'preact/hooks';
import { api, session } from '../api';

// Email link sign-in. /signin?token=... (from the email) is redeemed here and the token leaves the URL.
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    try { await api.emailLink(email.trim()); setSent(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div class="card" style={{ maxWidth: 520, margin: '40px auto' }}>
      <h1>Sign in</h1>
      {sent ? <p class="ok">Check your email for a sign-in link from hello@ducklingtablet.com. It works once and expires in 15 minutes.</p> : (
        <form onSubmit={submit}>
          <p>Type your email address and we send a link. No password to remember. The first sign-in creates your family account.</p>
          <label class="field"><span>Email</span><input type="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autoFocus /></label>
          {error && <div class="error">{error}</div>}
          <button class="btn primary" disabled={busy || !email}>{busy ? 'Working' : 'Send me a link'}</button>
        </form>
      )}
      {!sent && error && <p class="muted">A link that failed can be replaced by asking for a new one above.</p>}
    </div>
  );
}
