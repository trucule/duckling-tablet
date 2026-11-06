import { useState } from 'preact/hooks';
import { pair } from '../state';
import { shell } from '../shell';

// The parent makes a six-digit code in the portal; the tablet redeems it once for its device token.
export function Pair() {
  const [code, setCode] = useState('');
  const [name, setName] = useState(shell.platform === 'web' ? 'Browser' : 'Tablet');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await pair(code.trim(), name.trim() || 'Tablet'); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div class="screen">
      <form class="card" onSubmit={submit}>
        <h2>Pair this tablet</h2>
        <p>In the parent portal, open Devices and choose Add a device. Type the six-digit code here. Codes work once and expire after 15 minutes.</p>
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
