import { useEffect, useErrorBoundary } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { tr } from './i18n';
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
  // parent-blocked: the shell's Video blocked button, opening the parent area at the hosts a website was refused.
  const screen = r === 'store' ? <Store /> : r === 'pin' ? <Pin /> : r === 'parent' || r === 'parent-blocked' ? (parentUnlocked.value ? <Parent focus={r === 'parent-blocked' ? 'refused' : undefined} /> : <Pin />) : <Home />;
  return (
    <>
      <Guard>{screen}</Guard>
      {lastError.value && r === 'home' && <div class="banner">{lastError.value}</div>}
    </>
  );
}

/** A screen that fails to draw shows what failed and a way to try again, never a blank page (an iPad showed only the
 *  white home background, with no way to tell why). */
function Guard({ children }: { children: ComponentChildren }) {
  const [err, reset] = useErrorBoundary();
  if (!err) return <>{children}</>;
  const e = err as Error;
  return (
    <div class="crash">
      <h2>{tr('This screen could not be shown.')}</h2>
      <p>{tr('Send a photo of this message to support. The details help us fix it.')}</p>
      <pre>{`${e?.name || 'Error'}: ${e?.message || String(err)}\n${(e?.stack || '').split('\n').slice(0, 6).join('\n')}`}</pre>
      <button class="btn" onClick={() => { reset(); location.reload(); }}>{tr('Try again')}</button>
    </div>
  );
}
