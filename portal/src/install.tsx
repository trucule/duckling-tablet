import { tr, trn } from './i18n';
import { useEffect, useState } from 'preact/hooks';

// "Add to home screen" where the browser offers an install prompt (Chrome, Edge, Samsung Internet). Safari on iPhone
// has no prompt API, so there the button explains the Share menu route. Hidden once the portal runs installed.
interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [hint, setHint] = useState(false);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  if (standalone) return null;
  if (prompt) return <button class="btn quiet" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>{tr('Add to home screen')}</button>;
  if (ios) return (
    <span>
      <button class="btn quiet" onClick={() => setHint(!hint)}>{tr('Add to home screen')}</button>
      {hint && <span class="muted" style={{ display: 'block', maxWidth: 260, marginTop: 6 }}>{tr('In Safari, tap Share, then "Add to Home Screen".')}</span>}
    </span>
  );
  return null;
}

// A card on the family page that explains how to keep the portal on the phone's home screen, whatever the browser:
// the install prompt where there is one, otherwise the browser's own menu route. Dismissable; gone once installed.
export function InstallCard() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('duckling.installcard') === 'hidden'; } catch { return false; } });
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
  const android = /android/i.test(ua);
  const samsung = /SamsungBrowser/i.test(ua);
  const firefox = /firefox/i.test(ua);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  if (standalone || hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem('duckling.installcard', 'hidden'); } catch {} };
  const route = ios ? tr('In Safari, tap the Share button (the square with an arrow), then "Add to Home Screen".')
    : samsung ? tr('Tap the menu (three lines), then "Add page to", then "Home screen".')
    : firefox ? tr('Tap the menu (three dots), then "Install" or "Add to Home screen".')
    : android ? tr('Tap the menu (three dots) at the top right of Chrome, then "Add to Home screen" or "Install app".')
    : tr('In Chrome or Edge, use the install icon at the right end of the address bar, or the menu, then "Install Duckling Parents".');
  return (
    <div class="card">
      <h2>{tr('Keep this page on your phone')}</h2>
      <p>{tr('The portal works as an app: an icon on the home screen, full screen, signed in.')} {prompt ? tr('Your browser can add it now.') : route}</p>
      <div class="row">
        {prompt && <button class="btn primary" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>{tr('Add to home screen')}</button>}
        <button class="btn quiet" onClick={dismiss}>{tr('Not now')}</button>
      </div>
    </div>
  );
}
