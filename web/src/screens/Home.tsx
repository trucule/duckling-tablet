import { config, catalog, installed, installing, childName, themeColors, go, setupNeeded, retryInstall, installFromStore, openOtherApp, otherAppState } from '../state';
import { shell } from '../shell';
import type { InstalledApp } from '../api';

// The child's home: installed apps alphabetically, website tiles from the allowlist, the Library, a small parent button.
const AVATAR = 'my-avatar';

export function Home() {
  const c = config.value;
  const apps = [...(c?.apps ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const open = (a: InstalledApp) => { if (installed.value[a.id]) shell.openApp(a.id); else if (!installing.value[a.id]) void retryInstall(a.id); };
  // The child's own character in a circle: tapping it opens My Avatar, where she changes it. Until she saves one,
  // the circle shows her first letter. If My Avatar is not on this tablet, the tap installs it first.
  const avatarApp = c?.apps.find((a) => a.id === AVATAR);
  const avatarBusy = installing.value[AVATAR];
  const openAvatar = () => {
    if (avatarApp) return open(avatarApp);
    const fromLibrary = catalog.value.find((a) => a.id === AVATAR);
    if (fromLibrary) void installFromStore(fromLibrary); else go('store');
  };
  return (
    <div class="screen">
      <div class="topbar">
        <span class="who">
          <button class="avatar" onClick={openAvatar} aria-label="Your avatar" style={{ background: themeColors.value[0] ?? undefined }}>
            {c?.child?.portraitUrl ? <img src={c.child.portraitUrl} alt="" /> : <span class="letter">{(childName.value || '?').slice(0, 1).toUpperCase()}</span>}
            {avatarBusy ? <span class="busy">{avatarBusy}</span> : null}
          </button>
          <h1>{childName.value ? `${childName.value}'s tablet` : 'Duckling'}</h1>
        </span>
        {c?.child?.stars ? <span class="stars" title="Stars earned in the apps">&#11088; {c.child.stars.balance}</span> : null}
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
      {(c?.otherApps ?? []).length > 0 && (
        <>
          <h2 class="section">Other apps</h2>
          <div class="grid">
            {c!.otherApps!.map((a) => {
              const st = otherAppState(a);
              return (
                <button class={`tile ${st.ok ? '' : 'off'}`} key={a.package} onClick={() => openOtherApp(a)} aria-label={a.label}>
                  <span class="art plain">{a.icon ? <img src={a.icon} alt="" /> : <span>&#128241;</span>}</span>
                  <span class="name">{a.label}</span>
                  <span class="sub">{st.reason || (a.dailyMinutes === null ? 'Any time' : '')}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <button class="parent-button" onClick={() => go('pin')}>Parent</button>
    </div>
  );
}
