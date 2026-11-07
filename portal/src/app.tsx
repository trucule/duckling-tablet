import { useEffect, useState } from 'preact/hooks';
import { InstallButton } from './install';
import { session } from './api';
import { SignIn } from './screens/SignIn';
import { Family } from './screens/Family';
import { Device } from './screens/Device';
import { AppAbout } from './screens/AppAbout';

export function App() {
  const [signedIn, setSignedIn] = useState(!!session.get());
  const parse = () => location.hash.startsWith('#/device/') ? { device: location.hash.slice(9) } : location.hash.startsWith('#/app/') ? { app: location.hash.slice(6) } : {};
  const [route, setRoute] = useState<{ device?: string; app?: string }>(parse());
  useEffect(() => {
    const onHash = () => { setRoute(parse()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const device = route.device ?? null;
  // The API clears the stored session on a 401; watch for that.
  useEffect(() => { const t = setInterval(() => { if (!session.get() && signedIn) setSignedIn(false); }, 1000); return () => clearInterval(t); }, [signedIn]);
  return (
    <div class="wrap">
      <header class="top">
        <img src="/logo.png" alt="" /><span class="name">Duckling Tablet</span>
        <span class="right"><InstallButton /><a href="https://ducklingtablet.com/support">Support</a></span>
      </header>
      {!signedIn ? <SignIn onSignedIn={() => setSignedIn(true)} />
        : route.app ? <AppAbout id={route.app} onBack={() => { history.length > 1 ? history.back() : (location.hash = ''); }} />
        : device ? <Device id={device} onBack={() => { location.hash = ''; }} />
        : <Family onOpenDevice={(id) => { location.hash = `#/device/${id}`; }} />}
    </div>
  );
}
