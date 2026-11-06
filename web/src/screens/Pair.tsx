import { useState } from 'preact/hooks';
import { pair } from '../state';
import { shell } from '../shell';
import { api } from '../api';

// The parent makes a six-digit code in the portal; the tablet redeems it once for its device token.
export function Pair() {
  const [code, setCode] = useState('');
  const [name, setName] = useState(shell.platform === 'web' ? 'Browser' : 'Tablet');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [emailState, setEmailState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [emailError, setEmailError] = useState('');
  const sendLink = async (e: Event) => {
    e.preventDefault(); setEmailState('busy'); setEmailError('');
    try { await api.emailLink(email.trim(), 'tablet'); setEmailState('sent'); }
    catch (err) { setEmailError((err as Error).message); setEmailState('idle'); }
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await pair(code.trim(), name.trim() || 'Tablet'); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div class="screen">
      <form class="card" onSubmit={sendLink}>
        <h2>New to Duckling? Start here.</h2>
        <p>This app belongs on the child's tablet; parents manage it from a web page on their own phone or computer. Type your email and we send you a link to set up your family. Open it on your phone, add your child, press Add a device, and type the code it shows into the box below.</p>
        {emailState === 'sent' ? <p class="ok">Sent. Check your email on your phone for a message from hello@ducklingtablet.com, then come back here with the code.</p> : (
          <div class="row">
            <input type="email" required placeholder="parent@example.com" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 220, fontSize: 20, padding: '10px 12px', borderRadius: 12, border: '2px solid var(--line)' }} />
            <button class="pill" disabled={emailState === 'busy' || !email}>{emailState === 'busy' ? 'Sending' : 'Send me the link'}</button>
          </div>
        )}
        {emailError && <div class="error">{emailError}</div>}
      </form>

      <form class="card" onSubmit={submit}>
        <h2>Pair this tablet</h2>
        <p>Already have an account? In the parent portal at parents.ducklingtablet.com, press Add a device and type the six-digit code here. Codes work once and expire after 15 minutes.</p>
        <label class="field code"><span>Pairing code</span>
          <input inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} placeholder="000000" />
        </label>
        <label class="field"><span>Name for this device</span>
          <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {error && <div class="error">{error}</div>}
        <div class="row"><button class="pill primary" disabled={busy || code.length !== 6}>{busy ? 'Pairing' : 'Pair'}</button></div>
      </form>
    </div>
  );
}
