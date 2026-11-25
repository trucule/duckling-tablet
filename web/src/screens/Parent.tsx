import { useEffect, useState } from 'preact/hooks';
import { config, checkin, clearSavedData, releaseDevice, go, lastError, unlockParent, setupNeeded, refreshSetup, instantUpdates, unlinked, relink, entitlement, reportRefused } from '../state';
import { collectReport } from '../report';
import { forgetTabletBackground, tabletBackground, useHomeBackground, usePicture } from '../pictures';
import { shell, type LockdownStatus, type BillingResult, type WifiNetwork, type MediaAccess, type MediaState } from '../shell';
import { api, type AppRequest, type SiteHost } from '../api';
import { lang, setLang, tr, trn, type Lang } from '../i18n';

// Behind the PIN: lockdown steps for this platform, a check-in button, and Remove from this device.
export function Parent({ focus }: { focus?: 'refused' } = {}) {
  const [status, setStatus] = useState<LockdownStatus>(shell.lockdownStatus());
  const [busy, setBusy] = useState(false);
  const refresh = () => { setStatus(shell.lockdownStatus()); refreshSetup(); };
  // The steps are re-read when the app comes back to the front, when the shell pushes a new state (the iPad does that
  // the moment Guided Access or Screen Time changes, with no resume), and every two seconds while this screen is open,
  // so a step turns to a check mark on its own.
  useEffect(() => {
    window.addEventListener('duckling:resume', refresh); window.addEventListener('duckling:state', refresh);
    const t = setInterval(() => setStatus(shell.lockdownStatus()), 2000);
    return () => { window.removeEventListener('duckling:resume', refresh); window.removeEventListener('duckling:state', refresh); clearInterval(t); };
  }, []);
  const c = config.value;
  const android = shell.platform === 'android';
  const ios = shell.platform === 'ios';
  const win = shell.windows;
  const locks = android || ios || !!win;
  const device = ios ? 'iPad' : win ? 'device' : 'tablet';
  const thisDevice = tr(ios ? 'this iPad' : win ? 'this device' : 'this tablet');
  const [billingNote, setBillingNote] = useState('');
  const [linkCode, setLinkCode] = useState(''); const [linkName, setLinkName] = useState(ios ? 'iPad' : tr('Tablet')); const [linkError, setLinkError] = useState('');
  const link = async (e: Event) => {
    e.preventDefault(); setBusy(true); setLinkError('');
    try { await relink(linkCode, linkName.trim() || tr('Tablet')); setLinkCode(''); } catch (err) { setLinkError((err as Error).message); } finally { setBusy(false); refresh(); }
  };
  const release = async () => {
    if (!confirm(ios
      ? tr('Remove Duckling from this iPad? The lockdown is lifted and the apps and data are removed. Then delete Duckling Tablet from the home screen. The family account keeps its settings.')
      : win
      ? tr('Remove Duckling from this device? The lockdown and automatic sign-in are turned off, the apps and data are removed, the child is signed out, and Duckling uninstalls itself. The child\'s Windows account stays. The family account keeps its settings.')
      : tr('Remove Duckling from this device? The lockdown is lifted, the apps and data are removed, and Android then asks whether to uninstall Duckling. The family account keeps its settings.'))) return;
    setBusy(true);
    await releaseDevice(true);
  };
  // The store purchase (App Store on the iPad, Google Play on Android), behind the parent PIN. The result reaches the
  // server from the app, then this check-in shows it.
  const store = async (call: () => Promise<BillingResult>) => {
    setBusy(true); setBillingNote('');
    const r = await call();
    const notes: Record<string, string> = {
      purchased: tr('Thank you. The subscription is active.'), pending: r.message || tr('The purchase is waiting for approval.'), cancelled: '',
      none: ios ? tr('No subscription was found for this Apple ID.') : tr('No subscription was found for the Google account on this tablet.'), unavailable: r.message || (ios ? tr('The App Store is not available right now.') : tr('Google Play is not available right now.')), failed: r.message || tr('The purchase did not go through.'),
    };
    setBillingNote(notes[r.status] ?? r.message);
    await checkin(); setBusy(false); refresh();
  };
  // Windows: Stripe's own pages open in a parent browser window over Duckling; when it closes, check in.
  const card = async (make: () => Promise<{ url: string }>) => {
    setBusy(true); setBillingNote('');
    try {
      const how = await win!.openParentPage((await make()).url);
      setBillingNote(how === 'purchased' ? tr('Thank you. The subscription is starting.') : '');
    } catch (e) { setBillingNote((e as Error).message); }
    await checkin(); setBusy(false); refresh();
  };
  const ent = entitlement.value;
  const subscribed = ent?.status === 'active' || ent?.status === 'grace';
  const price = shell.subscriptionPrice();
  return (
    <div class="screen">
      <div class="topbar">
        <h1>{locks && setupNeeded.value ? tr('Set up {device}', { device: thisDevice }) : tr('Parent area')}</h1>
        <button class="pill" onClick={() => { unlockParent(false); go('home'); }}>{tr('Done')}</button>
      </div>

      {focus === 'refused' && !unlinked.value && <RefusedHosts focus />}

      {android && setupNeeded.value && (
        <div class="card">
          <p>{tr('The PIN is set. One more thing before handing the tablet over: the three lockdown steps below. Until they are done, a child can leave Duckling with the Home button.')}</p>
        </div>
      )}
      {ios && setupNeeded.value && (
        <div class="card">
          <p>{tr('The PIN is set. One more thing before handing the iPad over: the lockdown steps below. Until they are done, a child can leave Duckling and open other apps.')}</p>
        </div>
      )}

      {win && setupNeeded.value && (
        <div class="card">
          <p>{tr('The PIN is set. One more thing before handing the device over: the lockdown steps below. Until they are done, Duckling is a window like any other and a child can leave it.')}</p>
        </div>
      )}

      {unlinked.value && (
        <div class="card manage">
          <img class="qr" src="/parents-qr.svg" alt={tr('QR code for parents.ducklingtablet.com')} width="132" height="132" />
          <form onSubmit={link}>
            <h2>{tr('Link this tablet to your family')}</h2>
            <p>{tr('This tablet is not linked to a family account: it was removed on the website, or the account was deleted. Its apps, PIN and lockdown are still here, but changes from the website do not reach it and the narrator voice is off.')}</p>
            <p>{tr('To manage it again, open')} <strong>parents.ducklingtablet.com</strong> {tr('on your phone (scan the code), press Make a pairing code under Devices, and type the code here. The apps already on the tablet stay.')}</p>
            <div class="row">
              <input inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="000000" aria-label={tr('Pairing code')} value={linkCode} onInput={(e) => setLinkCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center', width: 170 }} />
              <input maxLength={60} placeholder={tr('Name for this tablet')} aria-label={tr('Name for this tablet')} value={linkName} onInput={(e) => setLinkName((e.target as HTMLInputElement).value)} style={{ width: 200 }} />
              <button class="pill primary" disabled={busy || linkCode.length !== 6}>{busy ? tr('Linking') : tr('Link')}</button>
            </div>
            {linkError && <div class="error">{linkError}</div>}
          </form>
        </div>
      )}

      {!unlinked.value && (
      <div class="card manage">
        <img class="qr" src="/parents-qr.svg" alt={tr('QR code for parents.ducklingtablet.com')} width="132" height="132" />
        <div>
          <h2>{tr('Manage {device} from your phone', { device: thisDevice })}</h2>
          <p>{shell.storeBilling ? tr("Apps, websites, other apps and their daily minutes, the child's level and a second parent are chosen in the parent portal.") : tr("Apps, websites, other apps and their daily minutes, the child's level, a second parent and the subscription are chosen in the parent portal.")} {tr("Scan the code with your phone's camera, or open parents.ducklingtablet.com and sign in with your email. The portal offers to add itself to your phone's home screen.")}</p>
          <p>{instantUpdates() ? tr('Changes made there reach {device} within seconds while it is on and online; the button fetches them now.', { device: thisDevice }) : win ? tr('Changes made there reach {device} within five minutes while it is on and online; the button fetches them now.', { device: thisDevice }) : tr('Changes made there reach {device} when it is opened, and every three hours; the button fetches them now.', { device: thisDevice })}</p>
          <div class="row">
            <button class="pill" disabled={busy} onClick={async () => { setBusy(true); await checkin(); setBusy(false); refresh(); }}>{tr('Sync with the website')}</button>
          </div>
          {lastError.value && <div class="error">{lastError.value}</div>}
        </div>
      </div>
      )}

      {!unlinked.value && (
      <div class="card">
        <h2>{tr('Included with Duckling')}</h2>
        <p>{ent?.status === 'trial' && ent.daysLeft !== null ? trn(ent.daysLeft, 'Free trial: {n} day left, then {price} a month for every tablet in the family.', 'Free trial: {n} days left, then {price} a month for every tablet in the family.', { price: price || '$5' }) : ent?.status === 'active' ? (ent.source === 'complimentary' ? tr('Complimentary license: every tablet in the family is covered, with nothing to pay.') : tr('Subscribed: {price} a month covers every tablet in the family.', { price: price || '$5' })) : ent?.status === 'grace' ? tr('The last payment did not go through. Everything keeps running while the store tries again.') : ent?.status === 'ended' ? (shell.storeBilling ? tr('The free trial has ended. Subscribe below to keep everything running.') : tr('The free trial has ended. Subscribe in the parent portal to keep everything running.')) : tr('Free for 7 days, then $5 a month for every tablet in the family.')}</p>
        {shell.storeBilling && (
          <div class="row">
            {!subscribed && <button class="pill" disabled={busy} onClick={() => store(() => shell.subscribe())}>{price ? tr('Subscribe, {price} a month', { price }) : tr('Subscribe')}</button>}
            {subscribed && ent?.source === (ios ? 'apple' : 'google') && <button class="pill quiet" onClick={() => shell.manageSubscription()}>{tr('Manage subscription')}</button>}
            <button class="pill quiet" disabled={busy} onClick={() => store(() => shell.restorePurchases())}>{tr('Restore purchases')}</button>
          </div>
        )}
        {win && c?.cardPayments && (!subscribed || ent?.source === 'stripe') && (
          <div class="row">
            {!subscribed && <button class="pill" disabled={busy} onClick={() => card(api.stripeCheckout)}>{tr('Subscribe with a card, $5 a month')}</button>}
            {subscribed && <button class="pill quiet" disabled={busy} onClick={() => card(api.stripePortal)}>{tr('Manage subscription')}</button>}
          </div>
        )}
        {win && c?.cardPayments && !subscribed && <p class="why">{ent?.status === 'trial' ? tr('Billed by card through Stripe, starting when the free trial ends. It renews each month until cancelled under Manage subscription, here or in the parent portal.') : tr('Billed by card through Stripe. It renews each month until cancelled under Manage subscription, here or in the parent portal.')} <a href="https://ducklingtablet.com/terms">{tr('Terms')}</a> · <a href="https://ducklingtablet.com/privacy">{tr('Privacy')}</a></p>}
        {shell.storeBilling && !subscribed && <p class="why">{ios ? tr('Billed through your Apple ID. It renews each month until cancelled in the App Store settings at least a day before the renewal date.') : tr('Billed through your Google Play account. It renews each month until cancelled in Google Play under Payments and subscriptions.')} <a href="https://ducklingtablet.com/terms">{tr('Terms')}</a> · <a href="https://ducklingtablet.com/privacy">{tr('Privacy')}</a></p>}
        {billingNote && <p>{billingNote}</p>}
        <ul class="included">
          <li><strong>{tr('Ask for an app, at no extra cost.')}</strong> {tr('Describe an app you wish existed; the ET Ducky team builds it for every family. Ask below or from the parent portal.')}</li>
          <li>{tr('Every learning app, and every new one, with the narrator voice.')}</li>
          <li>{tr('The child\'s avatar, stars and progress on every tablet they use.')}</li>
          <li>{tr('The parent portal: apps, websites, a second parent, and this tablet from your phone.')}</li>
        </ul>
      </div>
      )}

      {!unlinked.value && <LanguageCard />}

      {!unlinked.value && <HomeBackground />}

      {!unlinked.value && <AskForApp />}

      {/* Before the lockdown: once the lockdown is on, the system's permission prompt and settings can no longer be reached. */}
      <MediaAccessCard device={device} />

      {ios && (
        <div class="card">
          <h2>{tr('Lockdown')}</h2>
          <p>{tr('Do the steps in order. Each one gets a check mark when it is done.')}</p>
          <ul class="steps">
            <li><span class={`dot ${status.deviceSecure ? 'done' : ''}`}>{status.deviceSecure ? '✓' : '1'}</span>
              <span><span class="what">{tr('Set an iPad passcode')}</span><br /><span class="why">{tr('In Settings, tap Face ID & Passcode (or Touch ID & Passcode) and turn the passcode on. Use one the child does not know.')}</span></span></li>
            <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '2'}</span>
              <span><span class="what">{tr('Screen Time')}</span><br /><span class="why">{tr("Duckling uses Screen Time to limit this iPad to Duckling and the websites you choose. Tap Continue to see the iPad's request; it asks for the passcode or Face ID.")}</span></span>
              <button class="pill quiet" onClick={() => { shell.requestHomeRole(); setTimeout(refresh, 2500); }}>{tr('Continue')}</button></li>
            <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '3'}</span>
              <span><span class="what">{tr('Close other apps and websites')}</span><br /><span class="why">{tr('Tap Turn on. Only Duckling and the websites you allow will open.')}</span></span>
              <button class="pill quiet" disabled={!status.homeRole} onClick={() => { shell.setLockdown(!status.lockdownOn); setTimeout(refresh, 800); }}>{status.lockdownOn ? tr('Turn off') : tr('Turn on')}</button></li>
            {/* No Open Settings button on the iPad steps: iOS lets an app open only its own page in Settings, not
                Passcode or Accessibility, so the steps give the Settings path in words. */}
            <li><span class={`dot ${status.pinned ? 'done' : ''}`}>{status.pinned ? '✓' : '4'}</span>
              <span><span class="what">{tr('Keep the child in Duckling')}</span><br /><span class="why">{tr('In Settings, tap Accessibility, then Guided Access. Turn it on and set a passcode under Passcode Settings. Come back here, triple-click the top button (or the Home button) and tap Start. To leave, triple-click and enter that passcode.')}</span></span></li>
          </ul>
        </div>
      )}

      {ios && (
        <div class="card">
          <h2>{tr('Other apps')}</h2>
          <p>{tr('Apps already on this iPad can stay open to the child while the lockdown is on, each with a daily allowance. Pick them here; the iPad shows its own app list and the choice stays on the iPad. Screen Time closes an app when its minutes for the day are used up and opens it again the next day.')} {status.otherApps ? tr('{n} allowed now.', { n: status.otherApps }) : tr('None allowed yet.')}</p>
          <p>{tr('The child opens them from the iPad home screen, so leave Guided Access off, or end it first, when other apps are allowed. The parent portal lists the choice for each tablet.')}</p>
          <div class="row"><button class="pill" onClick={() => { shell.chooseOtherApps(lang.value); setTimeout(refresh, 1500); }}>{tr('Choose apps')}</button></div>
        </div>
      )}

      {win && <WindowsLockdown status={status} childName={c?.child?.firstName ?? ''} refresh={refresh} />}

      {win && (
        <div class="card">
          <h2>{tr('Other apps')}</h2>
          <p>{tr('Programs and Store apps already on this device can appear on the home screen with a daily allowance, chosen in the parent portal.')} {c?.otherApps?.length ? tr('{n} allowed now.', { n: c.otherApps.length }) : tr('None allowed yet.')} {tr("When the time is up, Duckling closes the app and comes back. Windows adds a newly allowed app at the child's next sign-in; the home screen offers that restart when it is needed.")}</p>
        </div>
      )}

      {android && (
        <div class="card">
          <h2>{tr('Lockdown')}</h2>
          <p>{tr('Each step is checked when you come back to this screen. With all three done, the child cannot leave Duckling. The last step restarts Duckling; you come back here on your own.')}</p>
          <ul class="steps">
            <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '1'}</span>
              <span><span class="what">{tr('Keep Duckling pinned')}</span><br /><span class="why">{tr('Android asks once to confirm pinning; after that it re-pins on every start.')}</span></span>
              <button class="pill quiet" onClick={() => { shell.setLockdown(!status.lockdownOn); setTimeout(refresh, 800); }}>{status.lockdownOn ? tr('Turn off') : tr('Turn on')}</button></li>
            <li><span class={`dot ${status.deviceSecure ? 'done' : ''}`}>{status.deviceSecure ? '✓' : '2'}</span>
              <span><span class="what">{tr('A screen lock the child does not know')}</span><br /><span class="why">{tr('Needed so unpinning asks for it. Also turn on App pinning in the same settings.')}</span></span>
              <button class="pill quiet" onClick={() => { shell.openSecuritySettings(); setTimeout(refresh, 1500); }}>{tr('Open settings')}</button></li>
            <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '3'}</span>
              <span><span class="what">{tr('Make Duckling the home screen')}</span><br /><span class="why">{tr('Home and recents then lead back here. Tap Continue to see Android\'s list of home apps.')}</span></span>
              <button class="pill quiet" onClick={() => { shell.requestHomeRole(); setTimeout(refresh, 1500); }}>{tr('Continue')}</button></li>
          </ul>
        </div>
      )}

      {android && (
        <div class="card">
          <h2>{tr('Other apps')}</h2>
          <p>{tr('Apps already on this tablet can appear on the home screen with a daily allowance, chosen in the parent portal under this tablet.')} {c?.otherApps?.length ? tr('{n} allowed now.', { n: c.otherApps.length }) : tr('None allowed yet.')}</p>
          <p>{shell.canDrawOverlays() ? tr('While another app is open the lockdown is lifted; Duckling comes back on its own when the time ends. For that it needs permission to appear over other apps: granted.') : tr('While another app is open the lockdown is lifted; Duckling comes back on its own when the time ends. For that it needs permission to appear over other apps.')}</p>
          {!shell.canDrawOverlays() && <div class="row"><button class="pill" onClick={() => shell.openOverlaySettings()}>{tr('Open settings')}</button></div>}
        </div>
      )}

      <div class="card">
        <h2>{tr('Wi-Fi')}</h2>
        <p>{{ wifi: tr('Connected to Wi-Fi.'), cellular: tr('Connected through mobile data.'), other: tr('Connected.'), none: tr('Not connected to the internet. Installed apps still work; new apps, the narrator voice and changes from the website wait until the tablet is back online.') }[shell.networkStatus()]}</p>
        {win && <WindowsWifi />}
        {android && (
          <>
            <p>{tr('On a plane, in a hotel or at a cafe: open Android\'s Wi-Fi settings, pick the network, and if it asks you to sign in, tap "Sign in to network" in the notification that appears (or the network\'s own entry) and finish its page. Then press Back until Duckling is showing. The lockdown comes back on its own.')}</p>
            <div class="row">
              <button class="pill" onClick={() => shell.openWifiSettings()}>{tr('Choose a Wi-Fi network')}</button>
            </div>
          </>
        )}
      </div>

      <div class="card">
        <h2>{tr('This device')}</h2>
        <p>{c?.child ? tr(shell.platform === 'web' ? "{name}'s browser" : ios ? "{name}'s iPad" : win ? "{name}'s device" : "{name}'s tablet", { name: c.child.firstName }) : tr('Unassigned')} · id {c?.deviceId ?? '?'} · shell {shell.shellVersion()}{status.windows?.productName ? ` · ${status.windows.productName}` : ''}</p>
        {win && !win.isChildSession() && <div class="row"><button class="pill quiet" onClick={() => win.exitShell()}>{tr('Close Duckling')}</button></div>}
      </div>

      <div class="card">
        <h2>{tr('Loading problems')}</h2>
        <p>{tr('A website that stops loading or keeps showing an old version, or a Duckling screen that stays blank, can be fixed by clearing what is saved for them on this device. Websites may ask the child to sign in again. Apps, progress, pictures and settings stay.')}</p>
        <div class="row"><button class="pill quiet" disabled={busy} onClick={() => { if (confirm(tr('Clear saved website data and reload Duckling?'))) { setBusy(true); void clearSavedData(c); } }}>{tr('Clear saved website data')}</button></div>
      </div>

      {focus !== 'refused' && !unlinked.value && <RefusedHosts />}

      {!unlinked.value && <SendDiagnostics />}

      <div class="card">
        <h2>{tr('Remove from this device')}</h2>
        <p>{ios ? tr('Lifts the lockdown, tells the website and clears the apps and data. Then delete Duckling Tablet from the home screen. You can pair the iPad again later.') : win ? tr('Turns the lockdown and automatic sign-in off, tells the website, clears the apps and data, signs the child out and uninstalls Duckling. The child\'s Windows account stays. You can install Duckling and pair the device again later.') : tr('Lifts the lockdown, tells the website, clears the apps and data, and then Android asks whether to uninstall Duckling. You can pair the tablet again later.')}</p>
        <div class="row"><button class="pill danger" disabled={busy} onClick={release}>{tr('Remove Duckling from this device')}</button></div>
      </div>
    </div>
  );
}

// Windows: the child's own account signing in automatically, the kiosk for that account, and the restart into it.
function WindowsLockdown({ status, childName, refresh }: { status: LockdownStatus; childName: string; refresh: () => void }) {
  const win = shell.windows!;
  const w = status.windows;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Letters in any alphabet stay, so a Sofía gets a tablet named for her and not for Sofa.
  const suggested = (childName || 'Child').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 20) || 'Child';
  // null until the parent types: then the box holds exactly what they typed, even when they clear it.
  const [name, setName] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  // A step finishes on the device before Windows' own status shows it (the shell reads that status in the
  // background), so the step stays "Working" until the status changes, for up to 30 seconds.
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what); setError('');
    const before = JSON.stringify(shell.lockdownStatus());
    try {
      await f();
      for (let i = 0; i < 15 && JSON.stringify(shell.lockdownStatus()) === before; i++) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); refresh(); }
  };
  const accounts = (w?.accounts ?? []).filter((a) => a.name.toLowerCase() !== (w?.currentUser ?? '').toLowerCase() || a.name === w?.childAccount);
  const chosen = name ?? (w?.childAccount || (accounts.length === 1 ? accounts[0].name : accounts.find((a) => a.name.toLowerCase() === suggested.toLowerCase())?.name) || suggested);
  const exists = accounts.some((a) => a.name.toLowerCase() === chosen.toLowerCase());
  return (
    <div class="card">
      <h2>{tr('Lockdown')}</h2>
      {!w && <p>{tr('Checking this device…')}</p>}
      {w && !w.kioskSupported && <p class="error">{tr("{edition} has no kiosk mode, which the lockdown needs. Duckling still starts in the child's account, but the Windows key leads out of it. Windows 11 Pro has the full lockdown.", { edition: w.productName ?? tr('This edition of Windows') })}</p>}
      <p>{tr('Each step is checked when it finishes. With all three done, the device signs in to the child\'s account by itself and shows only Duckling and the other apps you allow.')}</p>
      <ul class="steps">
        <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '1'}</span>
          <span><span class="what">{tr('The child\'s Windows account')}</span><br />
            <span class="why">{status.homeRole && !changing ? tr('{account} signs in by itself when the device starts.', { account: w?.childAccount ?? '' }) : tr('A standard account just for the child, signed in automatically with a password nobody needs to know. Use an account the child already has, or make one.')}</span>
            {(!status.homeRole || changing) && w && (
              <span class="row">
                <input list="duck-accounts" maxLength={20} value={chosen} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label={tr('Account name')} style={{ width: 200 }} />
                <datalist id="duck-accounts">{accounts.map((a) => <option value={a.name}>{a.fullName}</option>)}</datalist>
              </span>
            )}
          </span>
          {(!status.homeRole || changing) && <button class="pill quiet" disabled={!!busy || !w || !chosen.trim()} onClick={() => run('account', async () => {
            await win.setChildAccount(chosen.trim(), childName || chosen.trim());
            // With the lockdown on, the kiosk is applied again for the account now chosen.
            if (status.lockdownOn) await win.setLockdown(true);
            setChanging(false);
          })}>{busy === 'account' ? tr('Working') : exists ? tr('Use this account') : tr('Make this account')}</button>}
          {status.homeRole && !changing && <button class="pill quiet" disabled={!!busy} onClick={() => { setName(''); setChanging(true); }}>{tr('Change')}</button>}
        </li>
        <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '2'}</span>
          <span><span class="what">{tr('Lock the account to Duckling')}</span><br />
            <span class="why">{tr("Windows' kiosk mode for that account: Duckling fills the screen, there is no taskbar, and only Duckling and the apps you allow can open.")}{w?.oldKidTablet ? ` ${tr('The older Kid Tablet setup on this device is moved aside (kept in {path}) when this is turned on.', { path: 'C:\\ProgramData\\Duckling\\old-kidtablet' })}` : ''}{w?.otherKiosk && !status.lockdownOn ? ` ${tr('This replaces the kiosk set up on this device before.')}` : ''}</span></span>
          <button class="pill quiet" disabled={!!busy || !status.homeRole || !w?.kioskSupported} onClick={() => run('lockdown', () => win.setLockdown(!status.lockdownOn))}>{busy === 'lockdown' ? tr('Working') : status.lockdownOn ? tr('Turn off') : tr('Turn on')}</button>
        </li>
        <li><span class={`dot ${status.pinned ? 'done' : ''}`}>{status.pinned ? '✓' : '3'}</span>
          <span><span class="what">{w?.childAccount ? tr('Restart into {account}', { account: w.childAccount }) : tr("Restart into the child's account")}</span><br />
            <span class="why">{status.pinned ? tr('This is the child\'s account, locked to Duckling.') : tr('The device restarts and signs in to the child\'s account, where Duckling opens by itself.')} {tr('To use Windows yourself later: press Ctrl+Alt+Delete, choose Sign out, and hold the Shift key while the sign-in screen appears; then sign in to your own account.')}</span></span>
          {!status.pinned && <button class="pill quiet" disabled={!!busy || !status.homeRole || !status.lockdownOn} onClick={() => { if (confirm(tr('Restart now? Save anything open in other windows first.'))) void run('restart', () => win.restartDevice()); }}>{busy === 'restart' ? tr('Restarting') : tr('Restart')}</button>}
        </li>
      </ul>
      {error && <div class="error">{error}</div>}
    </div>
  );
}

// Windows: Wi-Fi from the parent area, since the kiosk keeps Windows' own network settings out of reach.
function WindowsWifi() {
  const win = shell.windows!;
  const [nets, setNets] = useState<WifiNetwork[] | null>(null);
  const [pick, setPick] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const scan = async () => { setBusy(true); setNote(''); try { setNets(await win.wifiNetworks()); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); } };
  const join = async (e: Event) => {
    e.preventDefault(); if (!pick) return;
    setBusy(true); setNote('');
    try {
      await win.connectWifi(pick.ssid, password);
      setNote(tr("Joining {network}. If the network shows a sign-in page (hotels, planes, cafes), press \"Open the network's sign-in page\".", { network: pick.ssid }));
      setPick(null); setPassword('');
      setTimeout(() => void scan(), 6000);
    } catch (err) { setNote((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <div class="row">
        <button class="pill" disabled={busy} onClick={scan}>{busy && !pick ? tr('Looking') : nets ? tr('Look again') : tr('Choose a Wi-Fi network')}</button>
        <button class="pill quiet" disabled={busy} onClick={() => void win.openParentPage('http://www.msftconnecttest.com/redirect')}>{tr('Open the network\'s sign-in page')}</button>
      </div>
      {nets && (
        <ul class="wifi">
          {nets.length === 0 && <li>{tr('No networks found.')}</li>}
          {nets.map((n) => (
            <li key={n.ssid}>
              <button class="link" disabled={busy || n.connected} onClick={() => { setPick(n); setPassword(''); }}>{n.ssid}</button>
              <span class="why"> {n.connected ? tr('connected') : `${n.signal}%`}{n.secured ? ` · ${tr('password')}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {pick && (
        <form class="row" onSubmit={join}>
          <strong>{pick.ssid}</strong>
          {pick.secured && <input type="password" placeholder={tr('Password')} value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} autoComplete="off" style={{ width: 220 }} />}
          <button class="pill primary" disabled={busy || (pick.secured && password.length < 8)}>{busy ? tr('Joining') : tr('Join')}</button>
          <button type="button" class="pill quiet" onClick={() => setPick(null)}>{tr('Cancel')}</button>
        </form>
      )}
      {note && <p>{note}</p>}
    </>
  );
}

const REQUEST_STATUS = (s: AppRequest['status']) => tr(({ requested: 'Received', planned: 'Planned', building: 'Being built', declined: 'Not taken on', shipped: 'In the Library', withdrawn: 'Withdrawn', done: 'Finished' } as const)[s]);
const OPEN_REQUEST = ['requested', 'planned', 'building'];

// Ask for an app: the portal's request form on the tablet. One request is in progress at a time for the family;
// while one is, the card shows it and offers to withdraw it. Pictures are added in the portal.
function AskForApp() {
  const [list, setList] = useState<AppRequest[] | null>(null);
  const [title, setTitle] = useState(''); const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [confirming, setConfirming] = useState(false);
  const load = () => api.requests().then((r) => setList(r.requests)).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);
  const open = list?.find((r) => OPEN_REQUEST.includes(r.status));
  const last = list?.find((r) => !OPEN_REQUEST.includes(r.status));
  const send = async (e: Event) => {
    e.preventDefault(); setBusy(tr('Sending')); setError('');
    try { await api.createRequest(title.trim(), desc.trim()); setTitle(''); setDesc(''); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const withdraw = async (id: string) => {
    setBusy(tr('Withdrawing')); setError('');
    try { await api.withdrawRequest(id); setConfirming(false); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  return (
    <div class="card ask">
      <h2>{tr('Ask for an app')}</h2>
      {list === null && !error && <p>{tr('Loading.')}</p>}
      {open && (
        <>
          <p><strong>{open.title}</strong>: {REQUEST_STATUS(open.status)}. {tr('The ET Ducky team works on one request per family at a time; the next one can be sent when this one is finished. Pictures can be added in the parent portal.')}</p>
          <p class="why">{open.description}</p>
          <div class="row">
            {!confirming && <button class="pill quiet" disabled={!!busy} onClick={() => setConfirming(true)}>{tr('Withdraw this request')}</button>}
            {confirming && <>
              <button class="pill" disabled={!!busy} onClick={() => withdraw(open.id)}>{busy || tr('Withdraw it')}</button>
              <button class="pill quiet" disabled={!!busy} onClick={() => setConfirming(false)}>{tr('Keep it')}</button>
            </>}
          </div>
        </>
      )}
      {list && !open && (
        <form onSubmit={send}>
          <p>{tr('Describe an app you wish existed: what the child would do in it and what it should teach. The ET Ducky team builds it, and it arrives in the Library for every family.')}</p>
          {last && <p class="why">{tr('Last request: {title}, {status}.', { title: last.title, status: REQUEST_STATUS(last.status).toLowerCase() })}</p>}
          <label class="field"><span>{tr('Name for the app')}</span>
            <input maxLength={80} placeholder={tr('A dinosaur counting game')} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field"><span>{tr('What it should do')}</span>
            <textarea maxLength={2000} rows={4} placeholder={tr('Loves dinosaurs and is learning to count to 20. Dinosaurs hatch from eggs and the child counts them...')} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
          </label>
          <div class="row">
            <button class="pill primary" disabled={!!busy || title.trim().length < 3 || desc.trim().length < 10}>{busy || tr('Send the request')}</button>
          </div>
        </form>
      )}
      {error && <div class="error">{error}</div>}
    </div>
  );
}

// The home background she chose from a saved picture: a painting on her profile, which follows her to every tablet,
// or a Camera Fun photo kept on this tablet only. A parent can remove either here.
function HomeBackground() {
  const profileUrl = config.value?.child?.backgroundUrl;
  const profile = usePicture('background', profileUrl);
  const url = useHomeBackground(profileUrl);
  const local = !!tabletBackground.value && url === tabletBackground.value;
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true); setError('');
    try { if (local) await forgetTabletBackground(); else { await api.clearBackground(); await checkin(); } }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h2>{tr('Home background')}</h2>
      {url ? (
        <>
          <img class="bg-preview" src={url} alt={tr('The home background')} />
          <p>{local
            ? `${tr('Your child chose this photo in Camera Fun. It is the background of this tablet only and stays on this tablet.')}${profile ? ` ${tr("Removing it brings back the picture on the child's profile.")}` : ''}`
            : tr('Your child chose this picture. It shows on all of their tablets.')}</p>
          <div class="row"><button class="pill quiet" disabled={busy} onClick={remove}>{busy ? tr('Removing') : tr('Remove it')}</button></div>
        </>
      ) : <p>{tr('None. Your child can pick a saved painting in Paint Studio or Draw With Me (open the saved pictures and tap Use as home background), which shows on all of their tablets, or a photo in Camera Fun (Home screen), which stays on this tablet and is its background only.')}</p>}
      {error && <div class="error">{error}</div>}
    </div>
  );
}

// The device's own permission for Duckling to use the microphone and camera. Without it every app that listens or takes
// pictures fails, and the app cannot tell the child why; this card shows it and leads to the switch.
function MediaAccessCard({ device }: { device: string }) {
  const [m, setM] = useState<MediaAccess | null>(shell.mediaAccess());
  useEffect(() => {
    const read = () => setM(shell.mediaAccess());
    window.addEventListener('duckling:resume', read); window.addEventListener('duckling:state', read);
    const t = setInterval(read, 2000);
    return () => { window.removeEventListener('duckling:resume', read); window.removeEventListener('duckling:state', read); clearInterval(t); };
  }, []);
  if (!m) return null;
  const ios = shell.platform === 'ios', win = shell.platform === 'windows';
  const rows: [string, MediaState][] = [[tr('Microphone'), m.microphone], [tr('Camera'), m.camera]];
  const off = rows.filter(([, s]) => s !== 'on');
  const blocked = off.some(([, s]) => s === 'blocked');
  const asks = off.some(([, s]) => s === 'ask');
  const how = win
    ? tr('Windows has it turned off. Turn the lockdown off, open Windows Settings, then Privacy & security, then Microphone or Camera, and turn on access and Let desktop apps access it.')
    : blocked
      ? tr('Screen Time blocks it. In Settings, tap Screen Time, then Content & Privacy Restrictions, then Microphone or Camera, and choose Allow Changes. Then come back to this card.')
      : ios && asks ? tr("Tap Continue to see the iPad's request for each one.")
      : ios ? tr('Tap Open Settings and turn on Microphone and Camera for Duckling Tablet.')
      : tr("Tap Continue to see Android's request for each one. If Android no longer asks, its settings for Duckling open, with Microphone and Camera under Permissions.");
  return (
    <div class="card">
      <h2>{tr('Microphone and camera')}</h2>
      <p>{tr('Apps that listen or take pictures need these. Sound and pictures stay on {device}.', { device: tr(device === 'iPad' ? 'this iPad' : device === 'device' ? 'this device' : 'this tablet') })}</p>
      <ul class="steps">
        {rows.map(([name, s]) => <li key={name}><span class={`dot ${s === 'on' ? 'done' : ''}`}>{s === 'on' ? '✓' : '!'}</span><span><span class="what">{name}</span><br /><span class="why">{s === 'on' ? tr('On.') : s === 'blocked' ? tr('Blocked by Screen Time.') : s === 'ask' ? tr('Not allowed yet.') : tr('Off.')}</span></span></li>)}
      </ul>
      {off.length > 0 && <p>{how}</p>}
      {off.length > 0 && !win && <div class="row"><button class="pill" onClick={() => (blocked ? shell.openAppSettings() : shell.requestMediaAccess())}>{blocked || (ios && !asks) ? tr('Open Settings') : tr('Continue')}</button></div>}
    </div>
  );
}

// The family's language: every tablet, the portal and the emails follow it. Each choice is written in its own
// language so a parent can find theirs whatever the screen is in now.
const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', es: 'Español' };
function LanguageCard() {
  const c = config.value;
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const family = (c?.familyLanguage ?? lang.value) as Lang;
  const own = c?.child?.language;
  const choose = async (l: Lang) => {
    setBusy(true); setError('');
    try { await api.setLanguage(l); if (!own) setLang(l); await checkin(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h2>{tr('Language')}</h2>
      <p>{tr('The language of every tablet in the family, the narrator, the parent portal and the emails.')}</p>
      {own && <p class="why">{tr('{name} has their own language set in the parent portal: {language}.', { name: c?.child?.firstName ?? '', language: LANGUAGE_NAMES[own] })}</p>}
      <div class="row">
        {(Object.keys(LANGUAGE_NAMES) as Lang[]).map((l) => (
          <button key={l} lang={l} class={`pill ${family === l ? 'primary' : 'quiet'}`} disabled={busy || family === l} onClick={() => choose(l)}>{LANGUAGE_NAMES[l]}</button>
        ))}
      </div>
      {error && <div class="error">{error}</div>}
    </div>
  );
}

// Hosts the allowed websites asked for and this tablet refused: a video's playlist on another domain, a picture
// server. A parent allows one for its website (it then opens only while that website is allowed, with no tile) or
// keeps it blocked. Advertising and analytics hosts are folded away. The Video blocked button opens the parent area
// here (focus); otherwise the card shows only when there is something to decide.
function RefusedHosts({ focus = false }: { focus?: boolean }) {
  const [list, setList] = useState<SiteHost[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showTrackers, setShowTrackers] = useState(false);
  useEffect(() => {
    (async () => {
      await reportRefused();
      try { setList((await api.siteHosts()).siteHosts); } catch (e) { setError((e as Error).message); setList([]); }
    })();
  }, []);
  const decide = async (h: SiteHost, decision: SiteHost['decision']) => {
    setBusy(`${h.site} ${h.host}`); setError('');
    try { setList((await api.decideSiteHost(h.site, h.host, decision)).siteHosts); await checkin(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };
  if (list === null) return focus ? <div class="card" id="refused"><h2>{tr('Blocked on websites')}</h2><p>{tr('Loading')}</p></div> : null;
  const open = list.filter((h) => !h.tracker || showTrackers || h.decision === 'allowed');
  const trackers = list.filter((h) => h.tracker && h.decision !== 'allowed').length;
  if (!focus && !list.some((h) => !h.tracker && h.decision === null) && !list.some((h) => h.decision)) return null;
  const sites = [...new Set(open.map((h) => h.site))];
  return (
    <div class="card" id="refused">
      <h2>{tr('Blocked on websites')}</h2>
      <p>{tr('Websites often load their videos and pictures from another address. Duckling blocks every address you have not allowed, so a video may not play. These are the addresses each website asked for. Allow one only if it belongs to the website or a service you trust: it opens only while that website is allowed, and never gets a tile of its own.')}</p>
      {!list.length && <p>{tr('Nothing has been blocked on the allowed websites yet. If a video did not play, open it again and come back here.')}</p>}
      {sites.map((site) => (
        <div class="refused-site" key={site}>
          <h3>{site}</h3>
          <ul class="refused">
            {open.filter((h) => h.site === site).map((h) => (
              <li key={h.host}>
                <span><strong>{h.host}</strong><br /><span class="why">{[h.media ? tr('Video') : '', h.tracker ? tr('Advertising or analytics') : '', trn(h.hits, 'Asked once', 'Asked {n} times')].filter(Boolean).join(' · ')}</span>{h.refusal && <><br /><span class="why">{tr(h.refusal)}</span></>}</span>
                {h.decision === 'allowed' && <><span class="state ok">{tr('Allowed')}</span><button class="pill quiet" disabled={!!busy} onClick={() => decide(h, 'blocked')}>{tr('Block')}</button></>}
                {h.decision === 'blocked' && <><span class="state">{tr('Kept blocked')}</span>{h.refusal ? <span /> : <button class="pill quiet" disabled={!!busy} onClick={() => decide(h, 'allowed')}>{tr('Allow')}</button>}</>}
                {h.decision === null && <>{h.refusal ? <span /> : <button class="pill" disabled={!!busy} onClick={() => decide(h, 'allowed')}>{tr('Allow')}</button>}<button class="pill quiet" disabled={!!busy} onClick={() => decide(h, 'blocked')}>{tr('Keep blocked')}</button></>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {trackers > 0 && <div class="row"><button class="pill quiet" onClick={() => setShowTrackers(!showTrackers)}>{showTrackers ? tr('Hide advertising and analytics') : trn(trackers, 'Show {n} advertising or analytics address', 'Show {n} advertising and analytics addresses')}</button></div>}
      {error && <div class="error">{error}</div>}
    </div>
  );
}

// Send diagnostics: a report to the Duckling team (an ET Ducky ticket) with an optional note from the parent.
function SendDiagnostics() {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; sent: boolean } | null>(null);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError(''); setDone(null);
    try {
      // A check-in first, so the report carries the newest settings and the clock comparison is current.
      await checkin();
      await reportRefused();
      setDone(await api.sendDiagnostics(note.trim(), await collectReport()));
      setNote('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h2>{tr('Report a problem')}</h2>
      <p>{tr('Sends a report to the Duckling team: the versions on this tablet, its settings and lockdown steps, recent errors, and the addresses websites were blocked from, with your note. Your child\'s name, the PIN and pictures are not included.')}</p>
      <div class="field"><textarea rows={3} maxLength={2000} placeholder={tr('What happened? (optional)')} aria-label={tr('What happened? (optional)')} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} /></div>
      <div class="row"><button class="pill" disabled={busy} onClick={send}>{busy ? tr('Sending') : tr('Send diagnostics')}</button></div>
      {done && <p>{done.sent ? tr('Sent. The reference is {id}.', { id: done.id }) : tr('Saved. It reaches the team as soon as their system answers. The reference is {id}.', { id: done.id })}</p>}
      {error && <div class="error">{error}</div>}
    </div>
  );
}
