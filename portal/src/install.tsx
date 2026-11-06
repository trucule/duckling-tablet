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
  if (prompt) return <button class="btn quiet" onClick={async () => { await prompt.prompt(); await prompt.userChoice; setPrompt(null); }}>Add to home screen</button>;
  if (ios) return (
    <span>
      <button class="btn quiet" onClick={() => setHint(!hint)}>Add to home screen</button>
      {hint && <span class="muted" style={{ display: 'block', maxWidth: 260, marginTop: 6 }}>In Safari, tap Share, then "Add to Home Screen".</span>}
    </span>
  );
  return null;
}
