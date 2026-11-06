import { useEffect } from 'preact/hooks';
import { route, paired, themeColors, startCheckins, lastError, go, parentUnlocked } from './state';
import { Pair } from './screens/Pair';
import { Home } from './screens/Home';
import { Store } from './screens/Store';
import { Pin } from './screens/Pin';
import { Parent } from './screens/Parent';

export function App() {
  useEffect(() => { startCheckins(); }, []);
  useEffect(() => {
    const [c1, c2] = themeColors.value;
    document.documentElement.style.setProperty('--c1', c1 ?? '#ffd36b');
    document.documentElement.style.setProperty('--c2', c2 ?? c1 ?? '#8fd6ff');
  }, [themeColors.value]);

  if (!paired.value) return <Pair />;
  const r = route.value;
  if (r === 'pair') { go('home'); return null; }
  // The parent area is reachable only through the PIN screen, whatever the URL says.
  const screen = r === 'store' ? <Store /> : r === 'pin' ? <Pin /> : r === 'parent' ? (parentUnlocked.value ? <Parent /> : <Pin />) : <Home />;
  return (
    <>
      {screen}
      {lastError.value && r === 'home' && <div class="banner">{lastError.value}</div>}
    </>
  );
}
