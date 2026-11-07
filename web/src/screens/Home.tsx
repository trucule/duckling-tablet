import { config, installed, installing, childName, go, setupNeeded, retryInstall } from '../state';
import { shell } from '../shell';
import type { InstalledApp } from '../api';

// The child's home: installed apps alphabetically, website tiles from the allowlist, the Library, a small parent button.
export function Home() {
  const c = config.value;
  const apps = [...(c?.apps ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const open = (a: InstalledApp) => { if (installed.value[a.id]) shell.openApp(a.id); else if (!installing.value[a.id]) void retryInstall(a.id); };
  return (
    <div class="screen">
      <div class="topbar">
        <h1>{childName.value ? `${childName.value}'s tablet` : 'Duckling'}</h1>
      </div>
      {setupNeeded.value && (
        <button class="setup" onClick={() => go('pin')}>
          <strong>This tablet is not locked down yet.</strong> A child can still leave Duckling. Finish setup in the parent area.
        </button>
      )}
      <div class="grid">
        {apps.map((a) => {
          const ready = !!installed.value[a.id];
          const busy = installing.value[a.id];
          return (
            <button class="tile" key={a.id} onClick={() => open(a)} aria-label={a.name}>
              <span class="art">
                {a.tileUrl ? <img src={a.tileUrl} alt="" /> : <span>{a.name.slice(0, 1)}</span>}
                {!ready && <span class="busy">{busy ?? 'Waiting'}</span>}
              </span>
              <span class="name">{a.name}</span>
            </button>
          );
        })}
        {(c?.allowlist ?? []).filter((w) => w.tile).map((w) => (
          <button class="tile" key={w.host} onClick={() => (location.href = w.tile!.url)} aria-label={w.tile!.name}>
            <span class="art" style={{ background: w.tile!.color ?? '#fff' }}>&#127760;</span>
            <span class="name">{w.tile!.name}</span>
          </button>
        ))}
        <button class="tile" onClick={() => go('store')} aria-label="Library">
          <span class="art">&#128218;</span>
          <span class="name">Library</span>
        </button>
      </div>
      <button class="parent-button" onClick={() => go('pin')}>Parent</button>
    </div>
  );
}
