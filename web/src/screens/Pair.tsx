import { tr } from '../i18n';
import { useEffect, useRef, useState } from 'preact/hooks';
import { pair, pairWithCode, pairWithProvider } from '../state';
import { shell, type SignInProvider } from '../shell';
import { api } from '../api';

const DEFAULT_NAME = () => shell.platform === 'web' ? tr('Browser') : tr('Tablet');
const CONTINUE_WITH: Record<SignInProvider, () => string> = { apple: () => tr('Continue with Apple'), google: () => tr('Continue with Google'), microsoft: () => tr('Continue with Microsoft') };

// The account this device is signed in to (Apple on the iPad, Google on Android, Microsoft on Windows), when the
// server takes it: one press replaces the email and the code.
function useDeviceSignIn() {
  const [offer, setOffer] = useState<{ provider: SignInProvider; clientId: string } | null>(null);
  useEffect(() => {
    if (!shell.signInProviders.length) return;
    api.signInProviders().then((r) => {
      const p = r.providers.find((x) => shell.signInProviders.includes(x.provider) && x.clientIds.length);
      if (p) setOffer({ provider: p.provider, clientId: p.clientIds[0] });
    }).catch(() => {});
  }, []);
  return offer;
}

// The space for a sign-in button the shell draws itself (Apple's own Continue with Apple on the iPad). The shell is
// told where the space is on the page whenever the layout changes, and takes the button away when this goes.
function NativeSignInButton({ enabled, onPress }: { enabled: boolean; onPress: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const press = useRef(onPress);
  press.current = onPress;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      shell.placeSignInButton(r.width && r.height ? { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height } : null, enabledRef.current);
    };
    const tapped = () => press.current();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener('resize', place);
    window.addEventListener('duckling:signinbutton', tapped);
    placeRef.current = place;
    place();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('duckling:signinbutton', tapped);
      placeRef.current = null;
      shell.placeSignInButton(null, false);
    };
  }, []);
  const enabledRef = useRef(enabled);
  const placeRef = useRef<(() => void) | null>(null);
  useEffect(() => { enabledRef.current = enabled; placeRef.current?.(); }, [enabled]);
  return <div ref={ref} class="signin-native" aria-label={tr('Continue with Apple')} />;
}

// First run. Three short screens on this tablet and nothing else: the parent's email, the six-digit code from that
// email, the child's first name. Where the device has an account the server takes, one press on Continue with
// Apple, Google or Microsoft replaces the first two. A parent who already has a family uses the same screens (the
// tablet joins it) or a pairing code from the website.
export function Pair() {
  const [step, setStep] = useState<'email' | 'code' | 'child' | 'website'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [child, setChild] = useState('');
  const [age, setAge] = useState('');
  const [name, setName] = useState(DEFAULT_NAME());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const offer = useDeviceSignIn();
  const [signedIn, setSignedIn] = useState<{ provider: SignInProvider; idToken: string; nonce: string } | null>(null);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const sendCode = (e: Event) => { e.preventDefault(); run(async () => { await api.requestCode(email.trim()); setStep('code'); }); };
  const finish = (e: Event) => {
    e.preventDefault();
    const kid = child.trim() || undefined, years = Number(age) || undefined, label = name.trim() || DEFAULT_NAME();
    run(() => signedIn ? pairWithProvider(signedIn.provider, signedIn.idToken, signedIn.nonce, kid, years, label) : pairWithCode(email.trim(), code, kid, years, label));
  };
  const deviceSignIn = () => run(async () => {
    if (!offer) return;
    const { nonce } = await api.signInNonce();
    const r = await shell.signIn(offer.provider, nonce, offer.clientId);
    if (r.status === 'cancelled') return;
    if (r.status !== 'ok' || !r.idToken) throw new Error(r.message || tr('That sign-in did not finish. Try again, or use your email.'));
    setSignedIn({ provider: offer.provider, idToken: r.idToken, nonce });
    setStep('child');
  });
  const pairCode = (e: Event) => { e.preventDefault(); run(() => pair(code.trim(), name.trim() || DEFAULT_NAME())); };
  const input = { style: { fontSize: 22, padding: '12px 14px', borderRadius: 12, border: '2px solid var(--line)', width: '100%', boxSizing: 'border-box' as const } };

  return (
    <div class="screen">
      {step === 'email' && (
        <form class="card" onSubmit={sendCode}>
          <h2>{tr('Set up Duckling')}</h2>
          <p>{tr("Takes about three minutes, all on this tablet. Type a parent's email; we send a six-digit code to it.")}</p>
          {offer && <>
            {offer.provider === 'apple' && shell.nativeSignInButton
              ? <NativeSignInButton enabled={!busy} onPress={deviceSignIn} />
              : <button type="button" class={`pill primary signin ${offer.provider}`} disabled={busy} onClick={deviceSignIn}>{CONTINUE_WITH[offer.provider]()}</button>}
            <p class="muted">{tr('Or type an email:')}</p>
          </>}
          <input type="email" required autoFocus placeholder={tr('parent@example.com')} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} {...input} />
          {error && <div class="error">{error}</div>}
          <div class="row" style={{ marginTop: 14 }}>
            <button class="pill primary" disabled={busy || !email.includes('@')}>{busy ? tr('Sending') : tr('Send the code')}</button>
            <button type="button" class="pill" onClick={() => { setError(''); setStep('website'); }}>{tr('I have a code from the website')}</button>
          </div>
          <p class="muted" style={{ marginTop: 14 }}>{tr('What a family gets: every learning app in the library, with a narrator who reads everything aloud, a 3D avatar the child builds with stars earned in the apps, a parent portal on your phone, and the right to ask for new apps at no extra cost. Free for 7 days, then $5 a month for every tablet in the family. No card now.')}</p>
        </form>
      )}

      {step === 'code' && (
        <form class="card" onSubmit={(e) => { e.preventDefault(); setError(''); setStep('child'); }}>
          <h2>{tr('Type the code')}</h2>
          <p>{tr('We sent six digits to {email}. Check the inbox on your phone (and the spam folder); the code works for 10 minutes.', { email })}</p>
          <input inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} placeholder="000000" {...input} style={{ ...input.style, letterSpacing: 8, fontSize: 30, textAlign: 'center' }} />
          {error && <div class="error">{error}</div>}
          <div class="row" style={{ marginTop: 14 }}>
            <button class="pill primary" disabled={code.length !== 6}>{tr('Next')}</button>
            <button type="button" class="pill" disabled={busy} onClick={() => run(async () => { await api.requestCode(email.trim()); })}>{tr('Send a new code')}</button>
            <button type="button" class="pill" onClick={() => { setError(''); setStep('email'); }}>{tr('Change the email')}</button>
          </div>
        </form>
      )}

      {step === 'child' && (
        <form class="card" onSubmit={finish}>
          <h2>{tr('Who is this tablet for?')}</h2>
          <p>{tr("The child's first name and age. The narrator uses the name; the age sets where every app starts (two years below the child's age, so a 7-year-old starts at kindergarten level and moves up with each right answer). You can change levels and add more children on the website.")}</p>
          <label class="field"><span>{tr("Child's first name")}</span>
            <input autoFocus maxLength={40} value={child} onInput={(e) => setChild((e.target as HTMLInputElement).value)} placeholder="Ada" />
          </label>
          <label class="field"><span>{tr('Age')}</span>
            <input type="number" inputMode="numeric" min={1} max={16} value={age} onInput={(e) => setAge((e.target as HTMLInputElement).value)} placeholder="7" style={{ maxWidth: 120 }} />
          </label>
          <label class="field"><span>{tr('Name for this tablet')}</span>
            <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          {error && <div class="error">{error}</div>}
          <div class="row" style={{ marginTop: 14 }}>
            <button class="pill primary" disabled={busy || !child.trim()}>{busy ? tr('Setting up') : tr('Finish setup')}</button>
            <button type="button" class="pill" onClick={() => { setError(''); if (signedIn) { setSignedIn(null); setStep('email'); } else setStep('code'); }}>{tr('Back')}</button>
          </div>
        </form>
      )}

      {step === 'website' && (
        <form class="card" onSubmit={pairCode}>
          <h2>{tr('Pair with a code from the website')}</h2>
          <p>{tr('In the parent portal at parents.ducklingtablet.com, open your family and press Make a pairing code. Codes work once and expire after 15 minutes.')}</p>
          <label class="field code"><span>{tr('Pairing code')}</span>
            <input inputMode="numeric" pattern="[0-9]*" maxLength={6} autoFocus value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} placeholder="000000" />
          </label>
          <label class="field"><span>{tr('Name for this tablet')}</span>
            <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          {error && <div class="error">{error}</div>}
          <div class="row">
            <button class="pill primary" disabled={busy || code.length !== 6}>{busy ? tr('Pairing') : tr('Pair')}</button>
            <button type="button" class="pill" onClick={() => { setError(''); setCode(''); setStep('email'); }}>{tr('Back')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
