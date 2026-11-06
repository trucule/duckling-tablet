import { useEffect, useState } from 'preact/hooks';
import { InstallButton } from './install';
import { session } from './api';
import { SignIn } from './screens/SignIn';
import { Family } from './screens/Family';
import { Device } from './screens/Device';

export function App() {
  const [signedIn, setSignedIn] = useState(!!session.get());
  const [device, setDevice] = useState<string | null>(location.hash.startsWith('#/device/') ? location.hash.slice(9) : null);
  useEffect(() => {
    const onHash = () => setDevice(location.hash.startsWith('#/device/') ? location.hash.slice(9) : null);
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // The API clears the stored session on a 401; watch for that.
  useEffect(() => { const t = setInterval(() => { if (!session.get() && signedIn) setSignedIn(false); }, 1000); return () => clearInterval(t); }, [signedIn]);
  return (
    <div class="wrap">
      <header class="top">
        <img src="/logo.png" alt="" /><span class="name">Duckling Tablet</span>
        <span class="right"><InstallButton /><a href="https://ducklingtablet.com/support">Support</a></span>
      </header>
      {!signedIn ? <SignIn onSignedIn={() => setSignedIn(true)} />
        : device ? <Device id={device} onBack={() => { location.hash = ''; }} />
        : <Family onOpenDevice={(id) => { location.hash = `#/device/${id}`; }} />}
    </div>
  );
}
