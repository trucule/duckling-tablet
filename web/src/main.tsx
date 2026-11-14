import { render } from 'preact';
import { App } from './app';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';

// Installable, and starts from cache when offline. A tablet keeps this page open for days, so it looks for a new
// version itself: every 30 minutes, and whenever the child comes back from an app or the screen comes back on. A new
// version installs in the background and the page reloads into it (registerType autoUpdate).
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    const check = () => { if (navigator.onLine !== false) reg.update().catch(() => { /* offline or the server is restarting: the next check retries */ }); };
    setInterval(check, 30 * 60 * 1000);
    window.addEventListener('duckling:resume', check);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  },
});

render(<App />, document.getElementById('app')!);
