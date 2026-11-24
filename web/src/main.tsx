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

// An error outside drawing (a failed module, a rejected promise) that leaves the page empty is written on the page,
// so a blank tablet still says what went wrong.
const reportBlank = (what: string) => setTimeout(() => {
  const root = document.getElementById('app');
  if (root && !root.textContent?.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'crash';
    pre.textContent = what;
    root.appendChild(pre);
  }
}, 3000);
window.addEventListener('error', (e) => reportBlank(`${e.message}\n${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) => { const r = e.reason as Error; reportBlank(`${r?.name || 'Error'}: ${r?.message || String(e.reason)}\n${r?.stack || ''}`); });

render(<App />, document.getElementById('app')!);
