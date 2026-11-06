import { useState } from 'preact/hooks';
import { shell } from '../shell';
import { go, parentUnlocked, setFirstPin } from '../state';

// The parent PIN: set on first use (typed twice), then asked for before the parent area.
export function Pin() {
  const [pin, setPin] = useState('');
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState('');
  const setting = !shell.hasPin();
  const title = setting ? (first === null ? 'Choose a parent PIN' : 'Type it again') : 'Parent PIN';
  const press = async (d: string) => {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next); setError('');
    if (next.length < 4) return;
    if (setting) {
      if (first === null) { setFirst(next); setPin(''); return; }
      if (first !== next) { setError('The two PINs were different. Start again.'); setFirst(null); setPin(''); return; }
      await setFirstPin(next); parentUnlocked.value = true; go('parent'); return;
    }
    if (await shell.verifyPin(next)) { parentUnlocked.value = true; go('parent'); }
    else { setError('That is not the PIN.'); setPin(''); }
  };
  return (
    <div class="screen">
      <div class="card center">
        <h2>{title}</h2>
        {setting && first === null && <p>Four digits. It guards the parent area on every tablet in your family; you can change it on the website.</p>}
        <div class="dots">{[0, 1, 2, 3].map((i) => <i class={i < pin.length ? 'on' : ''} key={i} />)}</div>
        {error && <div class="error">{error}</div>}
        <div class="pinpad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)}>{d}</button>)}
          <button onClick={() => go('home')}>Back</button>
          <button onClick={() => press('0')}>0</button>
          <button onClick={() => setPin(pin.slice(0, -1))}>&#9003;</button>
        </div>
      </div>
    </div>
  );
}
