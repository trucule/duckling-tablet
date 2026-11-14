import { useState } from 'preact/hooks';
import { pair, pairWithCode } from '../state';
import { shell } from '../shell';
import { api } from '../api';

const DEFAULT_NAME = shell.platform === 'web' ? 'Browser' : 'Tablet';

// First run. Three short screens on this tablet and nothing else: the parent's email, the six-digit code from that
// email, the child's first name. A parent who already has a family uses the same screens (the tablet joins it) or
// a pairing code from the website.
export function Pair() {
  const [step, setStep] = useState<'email' | 'code' | 'child' | 'website'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [child, setChild] = useState('');
  const [age, setAge] = useState('');
  const [name, setName] = useState(DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const sendCode = (e: Event) => { e.preventDefault(); run(async () => { await api.requestCode(email.trim()); setStep('code'); }); };
  const finish = (e: Event) => { e.preventDefault(); run(() => pairWithCode(email.trim(), code, child.trim() || undefined, Number(age) || undefined, name.trim() || DEFAULT_NAME)); };
  const pairCode = (e: Event) => { e.preventDefault(); run(() => pair(code.trim(), name.trim() || DEFAULT_NAME)); };
  const input = { style: { fontSize: 22, padding: '12px 14px', borderRadius: 12, border: '2px solid var(--line)', width: '100%', boxSizing: 'border-box' as const } };

  return (
    <div class="screen">
      {step === 'email' && (
        <form class="card" onSubmit={sendCode}>
          <h2>Set up Duckling</h2>
          <p>Takes about three minutes, all on this tablet. Type a parent's email; we send a six-digit code to it.</p>
          <input type="email" required autoFocus placeholder="parent@example.com" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} {...input} />
          {error && <div class="error">{error}</div>}
          <div class="row" style={{ marginTop: 14 }}>
            <button class="pill primary" disabled={busy || !email.includes('@')}>{busy ? 'Sending' : 'Send the code'}</button>
            <button type="button" class="pill" onClick={() => { setError(''); setStep('website'); }}>I have a code from the website</button>
          </div>
          <p class="muted" style={{ marginTop: 14 }}>What a family gets: every learning app in the library, with a narrator who reads everything aloud, a 3D avatar the child builds with stars earned in the apps, a parent portal on your phone, and the right to ask for new apps at no extra cost. Free for 7 days, then $5 a month for every tablet in the family. No card now.</p>
        </form>
      )}

      {step === 'code' && (
        <form class="card" onSubmit={(e) => { e.preventDefault(); setError(''); setStep('child'); }}>
          <h2>Type the code</h2>
          <p>We sent six digits to {email}. Check the inbox on your phone (and the spam folder); the code works for 10 minutes.</p>
          <input inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} placeholder="000000" {...input} style={{ ...input.style, letterSpacing: 8, fontSize: 30, textAlign: 'center' }} />
          {error && <div class="error">{error}</div>}
          <div class="row" style={{ marginTop: 14 }}>
            <button class="pill primary" disabled={code.length !== 6}>Next</button>
            <button type="button" class="pill" disabled={busy} onClick={() => run(async () => { await api.requestCode(email.trim()); })}>Send a new code</button>
            <button type="button" class="pill" onClick={() => { setError(''); setStep('email'); }}>Change the email</button>
          </div>
        </form>
      )}

      {step === 'child' && (
        <form class="card" onSubmit={finish}>
          <h2>Who is this tablet for?</h2>
          <p>The child's first name and age. The narrator uses the name; the age sets where every app starts (two years below the child's age, so a 7-year-old starts at kindergarten level and moves up with each right answer). You can change levels and add more children on the website.</p>
          <label class="field"><span>Child's first name</span>
            <input autoFocus maxLength={40} value={child} onInput={(e) => setChild((e.target as HTMLInputElement).value)} placeholder="Ada" />
          </label>
          <label class="field"><span>Age</span>
            <input type="number" inputMode="numeric" min={1} max={16} value={age} onInput={(e) => setAge((e.target as HTMLInputElement).value)} placeholder="7" style={{ maxWidth: 120 }} />
          </label>
          <label class="field"><span>Name for this tablet</span>
            <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          {error && <div class="error">{error}</div>}
          <div class="row" style={{ marginTop: 14 }}>
            <button class="pill primary" disabled={busy || !child.trim()}>{busy ? 'Setting up' : 'Finish setup'}</button>
            <button type="button" class="pill" onClick={() => { setError(''); setStep('code'); }}>Back</button>
          </div>
        </form>
      )}

      {step === 'website' && (
        <form class="card" onSubmit={pairCode}>
          <h2>Pair with a code from the website</h2>
          <p>In the parent portal at parents.ducklingtablet.com, open your family and press Make a pairing code. Codes work once and expire after 15 minutes.</p>
          <label class="field code"><span>Pairing code</span>
            <input inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} placeholder="000000" />
          </label>
          <label class="field"><span>Name for this tablet</span>
            <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          {error && <div class="error">{error}</div>}
          <div class="row">
            <button class="pill primary" disabled={busy || code.length !== 6}>{busy ? 'Pairing' : 'Pair'}</button>
            <button type="button" class="pill" onClick={() => { setError(''); setCode(''); setStep('email'); }}>Back</button>
          </div>
        </form>
      )}
    </div>
  );
}
