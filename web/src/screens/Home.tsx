import { tr, trn } from '../i18n';
import { appName } from '../apps';
import { useState } from 'preact/hooks';
import { useHomeBackground, usePicture } from '../pictures';
import { config, catalog, installed, installing, childName, themeColors, go, setupNeeded, retryInstall, installFromStore, openOtherApp, otherAppState, locked, unlinked, entitlement, restartNeeded, openApp } from '../state';
import { shell } from '../shell';
import { API, type Entitlement, type InstalledApp } from '../api';

// A website's tile shows the site's own icon (fetched once by the API), or a globe when the site has none.
function SiteArt({ host, color }: { host: string; color?: string }) {
  const [failed, setFailed] = useState(false);
  const h = host.replace(/^\*\./, '');
  return (
    <span class="art site" style={{ background: color ?? '#fff' }}>
      {failed ? <span>&#127760;</span> : <img src={`${API}/site-icon/${encodeURIComponent(h)}`} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}

// The child's home: installed apps alphabetically, website tiles from the allowlist, the Library, a small parent button.
const AVATAR = 'my-avatar';

// A line for the parent on the child's home screen while the family is not subscribed: what the trial is, when it
// ends, and what a subscription keeps (the apps already here, and new apps on request at no charge). Tapping it opens
// the parent area, where the subscription lives on a tablet that bills through its store.
function subscriptionNote(e: Entitlement | undefined) {
  if (!e || e.status === 'active') return null;
  const keep = tr('Subscribing keeps every app on this tablet and lets you request new apps at no charge.');
  if (e.status === 'trial') {
    const d = e.daysLeft ?? 0;
    return <><strong>{d === 0 ? tr('Free trial: ends today.') : trn(d, 'Free trial: {n} day left.', 'Free trial: {n} days left.')}</strong> {keep}</>;
  }
  if (e.status === 'grace') return <><strong>{tr('The last payment did not go through.')}</strong> {tr('Everything keeps running while the store tries again. Check the subscription in the parent area.')}</>;
  return <><strong>{tr('The free trial has ended, so the apps are locked.')}</strong> {tr('Subscribing in the parent area unlocks every app on this tablet and lets you request new apps at no charge.')}</>;
}

export function Home() {
  const c = config.value;
  const apps = [...(c?.apps ?? [])].sort((a, b) => appName(a).localeCompare(appName(b)));
  // While the family is locked out the tiles stay (the apps are still here) but a tap only explains why.
  const [lockNote, setLockNote] = useState(false);
  const open = (a: InstalledApp) => {
    if (locked.value) { setLockNote(true); setTimeout(() => setLockNote(false), 3000); return; }
    if (installed.value[a.id]) openApp(a.id); else if (!installing.value[a.id]) void retryInstall(a.id);
  };
  // The child's own character in a circle: tapping it opens My Avatar, where she changes it. Until she saves one,
  // the circle shows her first letter. If My Avatar is not on this tablet, the tap installs it first.
  const avatarApp = c?.apps.find((a) => a.id === AVATAR);
  const avatarBusy = installing.value[AVATAR];
  const openAvatar = () => {
    if (avatarApp) return open(avatarApp);
    const fromLibrary = catalog.value.find((a) => a.id === AVATAR);
    if (fromLibrary) void installFromStore(fromLibrary); else go('store');
  };
  // Her home background: a picture she chose in an app (a painting on her profile, or a Camera Fun photo kept on this
  // tablet only, pictures.ts). It sits in a layer fixed to the
  // screen, so it is sized to the display and not to the scrolling page of tiles. The whole picture shows, centered;
  // where its shape differs from the screen's, a blurred copy fills the edges. Tile names get a light label so they
  // read over any picture.
  const bg = useHomeBackground(c?.child?.backgroundUrl);
  const portrait = usePicture('portrait', c?.child?.portraitUrl);
  const bgUrl = bg ? `url("${bg.replace(/"/g, '%22')}")` : '';
  return (
    <div class={`screen${bg ? ' with-bg' : ''}`}>
      {bg && <div class="home-bg" aria-hidden="true"><div class="fill" style={{ backgroundImage: bgUrl }} /><div class="pic" style={{ backgroundImage: bgUrl }} /></div>}
      <div class="topbar">
        <span class="who">
          <button class="avatar" onClick={openAvatar} aria-label={tr('Your avatar')} style={{ background: themeColors.value[0] ?? undefined }}>
            {portrait ? <img src={portrait} alt="" /> : <span class="letter">{(childName.value || '?').slice(0, 1).toUpperCase()}</span>}
            {avatarBusy ? <span class="busy">{tr(avatarBusy)}</span> : null}
          </button>
          <h1>{childName.value ? tr("{name}'s tablet", { name: childName.value }) : 'Duckling'}</h1>
        </span>
        {c?.child?.stars ? <span class="stars" title={tr('Stars earned in the apps')}>&#11088; {c.child.stars.balance}</span> : null}
      </div>
      {setupNeeded.value && (
        <button class="setup" onClick={() => go('pin')}>
          <strong>{tr('This tablet is not locked down yet.')}</strong> {tr('A child can still leave Duckling. Finish setup in the parent area.')}
        </button>
      )}
      {unlinked.value && (
        <button class="setup" onClick={() => go('pin')}>
          <strong>{tr('This tablet is not linked to a family.')}</strong> {tr('The apps still work. A parent can link it again in the parent area.')}
        </button>
      )}
      {restartNeeded.value && (
        <button class="setup" onClick={() => { restartNeeded.value = null; void shell.windows?.restartSession().catch(() => undefined); }}>
          <strong>{tr('{app} is ready.', { app: restartNeeded.value })}</strong> {tr('Duckling restarts once to add it: tap here, wait for Duckling to open again, then tap {app}.', { app: restartNeeded.value })}
        </button>
      )}
      {!unlinked.value && subscriptionNote(entitlement.value) && (
        <button class="setup" onClick={() => go('pin')}>{subscriptionNote(entitlement.value)}</button>
      )}
      <div class="grid">
        {apps.map((a) => {
          const ready = !!installed.value[a.id];
          const busy = installing.value[a.id];
          return (
            <button class={`tile ${locked.value ? 'off' : ''}`} key={a.id} onClick={() => open(a)} aria-label={appName(a)}>
              <span class="art">
                {a.tileUrl ? <img src={a.tileUrl} alt="" /> : <span>{appName(a).slice(0, 1)}</span>}
                {!ready && <span class="busy">{tr(busy ?? 'Waiting')}</span>}
              </span>
              <span class="name">{appName(a)}</span>
            </button>
          );
        })}
        {!locked.value && (c?.allowlist ?? []).filter((w) => w.tile).map((w) => (
          <button class="tile" key={w.host} onClick={() => (location.href = w.tile!.url)} aria-label={w.tile!.name}>
            <SiteArt host={w.host} color={w.tile!.color} />
            <span class="name">{w.tile!.name}</span>
          </button>
        ))}
        <button class={`tile ${locked.value ? 'off' : ''}`} onClick={() => (locked.value ? open({ id: 'library' } as InstalledApp) : go('store'))} aria-label={tr('Library')}>
          <span class="art">&#128218;</span>
          <span class="name">{tr('Library')}</span>
        </button>
      </div>
      {lockNote && <div class="banner">{tr('The apps are locked. Ask a parent to subscribe.')}</div>}
      {!locked.value && (c?.otherApps ?? []).length > 0 && (
        <>
          <h2 class="section">{tr('Other apps')}</h2>
          <div class="grid">
            {c!.otherApps!.map((a) => {
              const st = otherAppState(a);
              return (
                <button class={`tile ${st.ok ? '' : 'off'}`} key={a.package} onClick={() => openOtherApp(a)} aria-label={a.label}>
                  <span class="art plain">{a.icon ? <img src={a.icon} alt="" /> : <span>&#128241;</span>}</span>
                  <span class="name">{a.label}</span>
                  <span class="sub">{st.reason || (a.dailyMinutes === null ? tr('Any time') : '')}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <button class="parent-button" onClick={() => go('pin')}>{tr('Parent')}</button>
    </div>
  );
}
