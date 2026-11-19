import { tr, trn } from './i18n';
import { useEffect, useState } from 'preact/hooks';
import { InstallButton } from './install';
import { session } from './api';
import { SignIn } from './screens/SignIn';
import { Family } from './screens/Family';
import { AppAbout } from './screens/AppAbout';
import { Stats } from './screens/Stats';

export function App() {
  const [signedIn, setSignedIn] = useState(!!session.get());
  const parse = () => location.hash.startsWith('#/app/') ? { app: location.hash.slice(6) } : location.hash === '#/stats' ? { stats: true } : {};
  const [route, setRoute] = useState<{ app?: string; stats?: boolean }>(parse());
  useEffect(() => {
    const onHash = () => { setRoute(parse()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // The API clears the stored session on a 401; watch for that.
  useEffect(() => { const t = setInterval(() => { if (!session.get() && signedIn) setSignedIn(false); }, 1000); return () => clearInterval(t); }, [signedIn]);
  return (
    <div class="wrap">
      <header class="top">
        <img src="/logo.png" alt="" /><span class="name">Duckling Tablet</span>
        <span class="right"><InstallButton /><a href="https://ducklingtablet.com/support">{tr('Support')}</a></span>
      </header>
      {!signedIn ? <SignIn onSignedIn={() => setSignedIn(true)} />
        : route.app ? <AppAbout id={route.app} onBack={() => { history.length > 1 ? history.back() : (location.hash = ''); }} />
        : route.stats ? <Stats onBack={() => { location.hash = ''; }} />
        : <Family />}
    </div>
  );
}
