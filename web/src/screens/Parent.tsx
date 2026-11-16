import { useEffect, useState } from 'preact/hooks';
import { config, checkin, releaseDevice, go, lastError, unlockParent, setupNeeded, refreshSetup, instantUpdates, unlinked, relink, entitlement } from '../state';
import { usePicture } from '../pictures';
import { shell, type LockdownStatus, type BillingResult, type WifiNetwork, type MediaAccess, type MediaState } from '../shell';
import { api, type AppRequest } from '../api';

// Behind the PIN: lockdown steps for this platform, a check-in button, and Remove from this device.
export function Parent() {
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
  const [billingNote, setBillingNote] = useState('');
  const [linkCode, setLinkCode] = useState(''); const [linkName, setLinkName] = useState(ios ? 'iPad' : 'Tablet'); const [linkError, setLinkError] = useState('');
  const link = async (e: Event) => {
    e.preventDefault(); setBusy(true); setLinkError('');
    try { await relink(linkCode, linkName.trim() || 'Tablet'); setLinkCode(''); } catch (err) { setLinkError((err as Error).message); } finally { setBusy(false); refresh(); }
  };
  const release = async () => {
    if (!confirm(ios
      ? 'Remove Duckling from this iPad? The lockdown is lifted and the apps and data are removed. Then delete Duckling Tablet from the home screen. The family account keeps its settings.'
      : win
      ? 'Remove Duckling from this device? The lockdown and automatic sign-in are turned off, the apps and data are removed, the child is signed out, and Duckling uninstalls itself. The child\'s Windows account stays. The family account keeps its settings.'
      : 'Remove Duckling from this device? The lockdown is lifted, the apps and data are removed, and Android then asks whether to uninstall Duckling. The family account keeps its settings.')) return;
    setBusy(true);
    await releaseDevice(true);
  };
  // The store purchase (App Store on the iPad, Google Play on Android), behind the parent PIN. The result reaches the
  // server from the app, then this check-in shows it.
  const storeName = ios ? 'the App Store' : 'Google Play';
  const accountName = ios ? 'this Apple ID' : 'the Google account on this tablet';
  const store = async (call: () => Promise<BillingResult>) => {
    setBusy(true); setBillingNote('');
    const r = await call();
    const notes: Record<string, string> = {
      purchased: 'Thank you. The subscription is active.', pending: r.message || 'The purchase is waiting for approval.', cancelled: '',
      none: `No subscription was found for ${accountName}.`, unavailable: r.message || `${storeName.charAt(0).toUpperCase() + storeName.slice(1)} is not available right now.`, failed: r.message || 'The purchase did not go through.',
    };
    setBillingNote(notes[r.status] ?? r.message);
    await checkin(); setBusy(false); refresh();
  };
  // Windows: Stripe's own pages open in a parent browser window over Duckling; when it closes, check in.
  const card = async (make: () => Promise<{ url: string }>) => {
    setBusy(true); setBillingNote('');
    try {
      const how = await win!.openParentPage((await make()).url);
      setBillingNote(how === 'purchased' ? 'Thank you. The subscription is starting.' : '');
    } catch (e) { setBillingNote((e as Error).message); }
    await checkin(); setBusy(false); refresh();
  };
  const ent = entitlement.value;
  const subscribed = ent?.status === 'active' || ent?.status === 'grace';
  const price = shell.subscriptionPrice();
  return (
    <div class="screen">
      <div class="topbar">
        <h1>{locks && setupNeeded.value ? `Set up this ${device}` : 'Parent area'}</h1>
        <button class="pill" onClick={() => { unlockParent(false); go('home'); }}>Done</button>
      </div>

      {android && setupNeeded.value && (
        <div class="card">
          <p>The PIN is set. One more thing before handing the tablet over: the three lockdown steps below. Until they are done, a child can leave Duckling with the Home button.</p>
        </div>
      )}
      {ios && setupNeeded.value && (
        <div class="card">
          <p>The PIN is set. One more thing before handing the iPad over: the lockdown steps below. Until they are done, a child can leave Duckling and open other apps.</p>
        </div>
      )}

      {win && setupNeeded.value && (
        <div class="card">
          <p>The PIN is set. One more thing before handing the device over: the lockdown steps below. Until they are done, Duckling is a window like any other and a child can leave it.</p>
        </div>
      )}

      {unlinked.value && (
        <div class="card manage">
          <img class="qr" src="/parents-qr.svg" alt="QR code for parents.ducklingtablet.com" width="132" height="132" />
          <form onSubmit={link}>
            <h2>Link this tablet to your family</h2>
            <p>This tablet is not linked to a family account: it was removed on the website, or the account was deleted. Its apps, PIN and lockdown are still here, but changes from the website do not reach it and the narrator voice is off.</p>
            <p>To manage it again, open <strong>parents.ducklingtablet.com</strong> on your phone (scan the code), press Make a pairing code under Devices, and type the code here. The apps already on the tablet stay.</p>
            <div class="row">
              <input inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="000000" aria-label="Pairing code" value={linkCode} onInput={(e) => setLinkCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} style={{ fontSize: 24, letterSpacing: 6, textAlign: 'center', width: 170 }} />
              <input maxLength={60} placeholder="Name for this tablet" aria-label="Name for this tablet" value={linkName} onInput={(e) => setLinkName((e.target as HTMLInputElement).value)} style={{ width: 200 }} />
              <button class="pill primary" disabled={busy || linkCode.length !== 6}>{busy ? 'Linking' : 'Link'}</button>
            </div>
            {linkError && <div class="error">{linkError}</div>}
          </form>
        </div>
      )}

      {!unlinked.value && (
      <div class="card manage">
        <img class="qr" src="/parents-qr.svg" alt="QR code for parents.ducklingtablet.com" width="132" height="132" />
        <div>
          <h2>Manage this {device} from your phone</h2>
          <p>Apps, websites, other apps and their daily minutes, the child's level{shell.storeBilling ? ' and a second parent' : ', a second parent and the subscription'} are chosen in the parent portal. Scan the code with your phone's camera, or open <strong>parents.ducklingtablet.com</strong> and sign in with your email. The portal offers to add itself to your phone's home screen.</p>
          <p>Changes made there reach this {device} {instantUpdates() ? 'within seconds while it is on and online' : win ? 'within five minutes while it is on and online' : 'when it is opened, and every three hours'}; the button fetches them now.</p>
          <div class="row">
            <button class="pill" disabled={busy} onClick={async () => { setBusy(true); await checkin(); setBusy(false); refresh(); }}>Sync with the website</button>
          </div>
          {lastError.value && <div class="error">{lastError.value}</div>}
        </div>
      </div>
      )}

      {!unlinked.value && (
      <div class="card">
        <h2>Included with Duckling</h2>
        <p>{ent?.status === 'trial' && ent.daysLeft !== null ? `Free trial: ${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left, then ${price || '$5'} a month for every tablet in the family.` : ent?.status === 'active' ? (ent.source === 'complimentary' ? 'Complimentary license: every tablet in the family is covered, with nothing to pay.' : `Subscribed: ${price || '$5'} a month covers every tablet in the family.`) : ent?.status === 'grace' ? 'The last payment did not go through. Everything keeps running while the store tries again.' : ent?.status === 'ended' ? (shell.storeBilling ? 'The free trial has ended. Subscribe below to keep everything running.' : 'The free trial has ended. Subscribe in the parent portal to keep everything running.') : 'Free for 7 days, then $5 a month for every tablet in the family.'}</p>
        {shell.storeBilling && (
          <div class="row">
            {!subscribed && <button class="pill" disabled={busy} onClick={() => store(() => shell.subscribe())}>{price ? `Subscribe, ${price} a month` : 'Subscribe'}</button>}
            {subscribed && ent?.source === (ios ? 'apple' : 'google') && <button class="pill quiet" onClick={() => shell.manageSubscription()}>Manage subscription</button>}
            <button class="pill quiet" disabled={busy} onClick={() => store(() => shell.restorePurchases())}>Restore purchases</button>
          </div>
        )}
        {win && c?.cardPayments && (!subscribed || ent?.source === 'stripe') && (
          <div class="row">
            {!subscribed && <button class="pill" disabled={busy} onClick={() => card(api.stripeCheckout)}>Subscribe with a card, $5 a month</button>}
            {subscribed && <button class="pill quiet" disabled={busy} onClick={() => card(api.stripePortal)}>Manage subscription</button>}
          </div>
        )}
        {win && c?.cardPayments && !subscribed && <p class="why">Billed by card through Stripe{ent?.status === 'trial' ? ', starting when the free trial ends' : ''}. It renews each month until cancelled under Manage subscription, here or in the parent portal. <a href="https://ducklingtablet.com/terms">Terms</a> · <a href="https://ducklingtablet.com/privacy">Privacy</a></p>}
        {shell.storeBilling && !subscribed && <p class="why">{ios ? 'Billed through your Apple ID. It renews each month until cancelled in the App Store settings at least a day before the renewal date.' : 'Billed through your Google Play account. It renews each month until cancelled in Google Play under Payments and subscriptions.'} <a href="https://ducklingtablet.com/terms">Terms</a> · <a href="https://ducklingtablet.com/privacy">Privacy</a></p>}
        {billingNote && <p>{billingNote}</p>}
        <ul class="included">
          <li><strong>Ask for an app, at no extra cost.</strong> Describe an app you wish existed; the ET Ducky team builds it for every family. Ask below or from the parent portal.</li>
          <li>Every learning app, and every new one, with the narrator voice.</li>
          <li>The child's avatar, stars and progress on every tablet they use.</li>
          <li>The parent portal: apps, websites, a second parent, and this tablet from your phone.</li>
        </ul>
      </div>
      )}

      {!unlinked.value && <HomeBackground />}

      {!unlinked.value && <AskForApp />}

      {ios && (
        <div class="card">
          <h2>Lockdown</h2>
          <p>Do the steps in order. Each one gets a check mark when it is done.</p>
          <ul class="steps">
            <li><span class={`dot ${status.deviceSecure ? 'done' : ''}`}>{status.deviceSecure ? '✓' : '1'}</span>
              <span><span class="what">Set an iPad passcode</span><br /><span class="why">In Settings, tap Face ID &amp; Passcode (or Touch ID &amp; Passcode) and turn the passcode on. Use one the child does not know.</span></span>
              <button class="pill quiet" onClick={() => shell.openSecuritySettings()}>Open Settings</button></li>
            <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '2'}</span>
              <span><span class="what">Screen Time</span><br /><span class="why">Duckling uses Screen Time to limit this iPad to Duckling and the websites you choose. Tap Continue to see the iPad's request; it asks for the passcode or Face ID.</span></span>
              <button class="pill quiet" onClick={() => { shell.requestHomeRole(); setTimeout(refresh, 2500); }}>Continue</button></li>
            <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '3'}</span>
              <span><span class="what">Close other apps and websites</span><br /><span class="why">Tap Turn on. Only Duckling and the websites you allow will open.</span></span>
              <button class="pill quiet" disabled={!status.homeRole} onClick={() => { shell.setLockdown(!status.lockdownOn); setTimeout(refresh, 800); }}>{status.lockdownOn ? 'Turn off' : 'Turn on'}</button></li>
            <li><span class={`dot ${status.pinned ? 'done' : ''}`}>{status.pinned ? '✓' : '4'}</span>
              <span><span class="what">Keep the child in Duckling</span><br /><span class="why">In Settings, tap Accessibility, then Guided Access. Turn it on and set a passcode under Passcode Settings. Come back here, triple-click the top button (or the Home button) and tap Start. To leave, triple-click and enter that passcode.</span></span>
              <button class="pill quiet" onClick={() => shell.openSecuritySettings()}>Open Settings</button></li>
          </ul>
        </div>
      )}

      {win && <WindowsLockdown status={status} childName={c?.child?.firstName ?? ''} refresh={refresh} />}

      {win && (
        <div class="card">
          <h2>Other apps</h2>
          <p>Programs and Store apps already on this device can appear on the home screen with a daily allowance, chosen in the parent portal. {c?.otherApps?.length ? `${c.otherApps.length} allowed now.` : 'None allowed yet.'} When the time is up, Duckling closes the app and comes back. Windows adds a newly allowed app at the child's next sign-in; the home screen offers that restart when it is needed.</p>
        </div>
      )}

      {android && (
        <div class="card">
          <h2>Lockdown</h2>
          <p>Each step is checked when you come back to this screen. With all three done, the child cannot leave Duckling. The last step restarts Duckling; you come back here on your own.</p>
          <ul class="steps">
            <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '1'}</span>
              <span><span class="what">Keep Duckling pinned</span><br /><span class="why">Android asks once to confirm pinning; after that it re-pins on every start.</span></span>
              <button class="pill quiet" onClick={() => { shell.setLockdown(!status.lockdownOn); setTimeout(refresh, 800); }}>{status.lockdownOn ? 'Turn off' : 'Turn on'}</button></li>
            <li><span class={`dot ${status.deviceSecure ? 'done' : ''}`}>{status.deviceSecure ? '✓' : '2'}</span>
              <span><span class="what">A screen lock the child does not know</span><br /><span class="why">Needed so unpinning asks for it. Also turn on App pinning in the same settings.</span></span>
              <button class="pill quiet" onClick={() => { shell.openSecuritySettings(); setTimeout(refresh, 1500); }}>Open settings</button></li>
            <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '3'}</span>
              <span><span class="what">Make Duckling the home screen</span><br /><span class="why">Home and recents then lead back here. Tap Continue to see Android's list of home apps.</span></span>
              <button class="pill quiet" onClick={() => { shell.requestHomeRole(); setTimeout(refresh, 1500); }}>Continue</button></li>
          </ul>
        </div>
      )}

      {android && (
        <div class="card">
          <h2>Other apps</h2>
          <p>Apps already on this tablet can appear on the home screen with a daily allowance, chosen in the parent portal under this tablet. {c?.otherApps?.length ? `${c.otherApps.length} allowed now.` : 'None allowed yet.'}</p>
          <p>While another app is open the lockdown is lifted; Duckling comes back on its own when the time ends. For that it needs permission to appear over other apps{shell.canDrawOverlays() ? ': granted.' : '.'}</p>
          {!shell.canDrawOverlays() && <div class="row"><button class="pill" onClick={() => shell.openOverlaySettings()}>Open settings</button></div>}
        </div>
      )}

      <MediaAccessCard device={device} />

      <div class="card">
        <h2>Wi-Fi</h2>
        <p>{{ wifi: 'Connected to Wi-Fi.', cellular: 'Connected through mobile data.', other: 'Connected.', none: 'Not connected to the internet. Installed apps still work; new apps, the narrator voice and changes from the website wait until the tablet is back online.' }[shell.networkStatus()]}</p>
        {win && <WindowsWifi />}
        {android && (
          <>
            <p>On a plane, in a hotel or at a cafe: open Android's Wi-Fi settings, pick the network, and if it asks you to sign in, tap "Sign in to network" in the notification that appears (or the network's own entry) and finish its page. Then press Back until Duckling is showing. The lockdown comes back on its own.</p>
            <div class="row">
              <button class="pill" onClick={() => shell.openWifiSettings()}>Choose a Wi-Fi network</button>
            </div>
          </>
        )}
      </div>

      <div class="card">
        <h2>This device</h2>
        <p>{c?.child ? `${c.child.firstName}'s` : 'Unassigned'} {shell.platform === 'web' ? 'browser' : device} · id {c?.deviceId ?? '?'} · shell {shell.shellVersion()}{status.windows?.productName ? ` · ${status.windows.productName}` : ''}</p>
        {win && !win.isChildSession() && <div class="row"><button class="pill quiet" onClick={() => win.exitShell()}>Close Duckling</button></div>}
      </div>

      <div class="card">
        <h2>Remove from this device</h2>
        <p>{ios ? 'Lifts the lockdown, tells the website and clears the apps and data. Then delete Duckling Tablet from the home screen. You can pair the iPad again later.' : win ? 'Turns the lockdown and automatic sign-in off, tells the website, clears the apps and data, signs the child out and uninstalls Duckling. The child\'s Windows account stays. You can install Duckling and pair the device again later.' : 'Lifts the lockdown, tells the website, clears the apps and data, and then Android asks whether to uninstall Duckling. You can pair the tablet again later.'}</p>
        <div class="row"><button class="pill danger" disabled={busy} onClick={release}>Remove Duckling from this device</button></div>
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
  const suggested = (childName || 'Child').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 20) || 'Child';
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
      <h2>Lockdown</h2>
      {!w && <p>Checking this device…</p>}
      {w && !w.kioskSupported && <p class="error">{w.productName ?? 'This edition of Windows'} has no kiosk mode, which the lockdown needs. Duckling still starts in the child's account, but the Windows key leads out of it. Windows 11 Pro has the full lockdown.</p>}
      <p>Each step is checked when it finishes. With all three done, the device signs in to the child's account by itself and shows only Duckling and the other apps you allow.</p>
      <ul class="steps">
        <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '1'}</span>
          <span><span class="what">The child's Windows account</span><br />
            <span class="why">{status.homeRole && !changing ? `${w?.childAccount} signs in by itself when the device starts.` : 'A standard account just for the child, signed in automatically with a password nobody needs to know. Use an account the child already has, or make one.'}</span>
            {(!status.homeRole || changing) && w && (
              <span class="row">
                <input list="duck-accounts" maxLength={20} value={chosen} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Account name" style={{ width: 200 }} />
                <datalist id="duck-accounts">{accounts.map((a) => <option value={a.name}>{a.fullName}</option>)}</datalist>
              </span>
            )}
          </span>
          {(!status.homeRole || changing) && <button class="pill quiet" disabled={!!busy || !w || !chosen.trim()} onClick={() => run('account', async () => {
            await win.setChildAccount(chosen.trim(), childName || chosen.trim());
            // With the lockdown on, the kiosk is applied again for the account now chosen.
            if (status.lockdownOn) await win.setLockdown(true);
            setChanging(false);
          })}>{busy === 'account' ? 'Working' : exists ? 'Use this account' : 'Make this account'}</button>}
          {status.homeRole && !changing && <button class="pill quiet" disabled={!!busy} onClick={() => { setName(''); setChanging(true); }}>Change</button>}
        </li>
        <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '2'}</span>
          <span><span class="what">Lock the account to Duckling</span><br />
            <span class="why">Windows' kiosk mode for that account: Duckling fills the screen, there is no taskbar, and only Duckling and the apps you allow can open.{w?.oldKidTablet ? ' The older Kid Tablet setup on this device is moved aside (kept in C:\\ProgramData\\Duckling\\old-kidtablet) when this is turned on.' : ''}{w?.otherKiosk && !status.lockdownOn ? ' This replaces the kiosk set up on this device before.' : ''}</span></span>
          <button class="pill quiet" disabled={!!busy || !status.homeRole || !w?.kioskSupported} onClick={() => run('lockdown', () => win.setLockdown(!status.lockdownOn))}>{busy === 'lockdown' ? 'Working' : status.lockdownOn ? 'Turn off' : 'Turn on'}</button>
        </li>
        <li><span class={`dot ${status.pinned ? 'done' : ''}`}>{status.pinned ? '✓' : '3'}</span>
          <span><span class="what">Restart into {w?.childAccount || "the child's account"}</span><br />
            <span class="why">{status.pinned ? 'This is the child\'s account, locked to Duckling.' : 'The device restarts and signs in to the child\'s account, where Duckling opens by itself.'} To use Windows yourself later: press Ctrl+Alt+Delete, choose Sign out, and hold the Shift key while the sign-in screen appears; then sign in to your own account.</span></span>
          {!status.pinned && <button class="pill quiet" disabled={!!busy || !status.homeRole || !status.lockdownOn} onClick={() => { if (confirm('Restart now? Save anything open in other windows first.')) void run('restart', () => win.restartDevice()); }}>{busy === 'restart' ? 'Restarting' : 'Restart'}</button>}
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
      setNote(`Joining ${pick.ssid}. If the network shows a sign-in page (hotels, planes, cafes), press "Open the network's sign-in page".`);
      setPick(null); setPassword('');
      setTimeout(() => void scan(), 6000);
    } catch (err) { setNote((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <div class="row">
        <button class="pill" disabled={busy} onClick={scan}>{busy && !pick ? 'Looking' : nets ? 'Look again' : 'Choose a Wi-Fi network'}</button>
        <button class="pill quiet" disabled={busy} onClick={() => void win.openParentPage('http://www.msftconnecttest.com/redirect')}>Open the network's sign-in page</button>
      </div>
      {nets && (
        <ul class="wifi">
          {nets.length === 0 && <li>No networks found.</li>}
          {nets.map((n) => (
            <li key={n.ssid}>
              <button class="link" disabled={busy || n.connected} onClick={() => { setPick(n); setPassword(''); }}>{n.ssid}</button>
              <span class="why"> {n.connected ? 'connected' : `${n.signal}%`}{n.secured ? ' · password' : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {pick && (
        <form class="row" onSubmit={join}>
          <strong>{pick.ssid}</strong>
          {pick.secured && <input type="password" placeholder="Password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} autoComplete="off" style={{ width: 220 }} />}
          <button class="pill primary" disabled={busy || (pick.secured && password.length < 8)}>{busy ? 'Joining' : 'Join'}</button>
          <button type="button" class="pill quiet" onClick={() => setPick(null)}>Cancel</button>
        </form>
      )}
      {note && <p>{note}</p>}
    </>
  );
}

const REQUEST_STATUS: Record<AppRequest['status'], string> = { requested: 'Received', planned: 'Planned', building: 'Being built', declined: 'Not taken on', shipped: 'In the Library', withdrawn: 'Withdrawn', done: 'Finished' };
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
    e.preventDefault(); setBusy('Sending'); setError('');
    try { await api.createRequest(title.trim(), desc.trim()); setTitle(''); setDesc(''); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const withdraw = async (id: string) => {
    setBusy('Withdrawing'); setError('');
    try { await api.withdrawRequest(id); setConfirming(false); await load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  return (
    <div class="card ask">
      <h2>Ask for an app</h2>
      {list === null && !error && <p>Loading.</p>}
      {open && (
        <>
          <p><strong>{open.title}</strong>: {REQUEST_STATUS[open.status]}. The ET Ducky team works on one request per family at a time; the next one can be sent when this one is finished. Pictures can be added in the parent portal.</p>
          <p class="why">{open.description}</p>
          <div class="row">
            {!confirming && <button class="pill quiet" disabled={!!busy} onClick={() => setConfirming(true)}>Withdraw this request</button>}
            {confirming && <>
              <button class="pill" disabled={!!busy} onClick={() => withdraw(open.id)}>{busy || 'Withdraw it'}</button>
              <button class="pill quiet" disabled={!!busy} onClick={() => setConfirming(false)}>Keep it</button>
            </>}
          </div>
        </>
      )}
      {list && !open && (
        <form onSubmit={send}>
          <p>Describe an app you wish existed: what the child would do in it and what it should teach. The ET Ducky team builds it, and it arrives in the Library for every family.</p>
          {last && <p class="why">Last request: {last.title}, {REQUEST_STATUS[last.status].toLowerCase()}.</p>}
          <label class="field"><span>Name for the app</span>
            <input maxLength={80} placeholder="A dinosaur counting game" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field"><span>What it should do</span>
            <textarea maxLength={2000} rows={4} placeholder="Loves dinosaurs and is learning to count to 20. Dinosaurs hatch from eggs and the child counts them..." value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} />
          </label>
          <div class="row">
            <button class="pill primary" disabled={!!busy || title.trim().length < 3 || desc.trim().length < 10}>{busy || 'Send the request'}</button>
          </div>
        </form>
      )}
      {error && <div class="error">{error}</div>}
    </div>
  );
}

// The home background she chose from a saved picture. It follows her to every tablet; a parent can remove it here.
function HomeBackground() {
  const url = usePicture('background', config.value?.child?.backgroundUrl);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true); setError('');
    try { await api.clearBackground(); await checkin(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div class="card">
      <h2>Home background</h2>
      {url ? (
        <>
          <img class="bg-preview" src={url} alt="The home background" />
          <p>Your child chose this picture. It shows on all of their tablets.</p>
          <div class="row"><button class="pill quiet" disabled={busy} onClick={remove}>{busy ? 'Removing' : 'Remove it'}</button></div>
        </>
      ) : <p>None. Your child can pick a saved painting in Paint Studio or Draw With Me, or a photo in Camera Fun: open the saved pictures and tap Use as home background (Home screen in Camera Fun). A photo is kept with the child's profile until it is removed here.</p>}
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
  const rows: [string, MediaState][] = [['Microphone', m.microphone], ['Camera', m.camera]];
  const off = rows.filter(([, s]) => s !== 'on');
  const blocked = off.some(([, s]) => s === 'blocked');
  const asks = off.some(([, s]) => s === 'ask');
  const how = win
    ? 'Windows has it turned off. Turn the lockdown off, open Windows Settings, then Privacy & security, then Microphone or Camera, and turn on access and Let desktop apps access it.'
    : blocked
      ? 'Screen Time blocks it. In Settings, tap Screen Time, then Content & Privacy Restrictions, then Microphone or Camera, and choose Allow Changes. Then come back to this card.'
      : ios && asks ? "Tap Continue to see the iPad's request for each one."
      : ios ? 'Tap Open Settings and turn on Microphone and Camera for Duckling Tablet.'
      : "Tap Continue to see Android's request for each one. If Android no longer asks, its settings for Duckling open, with Microphone and Camera under Permissions.";
  return (
    <div class="card">
      <h2>Microphone and camera</h2>
      <p>Apps that listen or take pictures need these. Sound and pictures stay on this {device}.</p>
      <ul class="steps">
        {rows.map(([name, s]) => <li key={name}><span class={`dot ${s === 'on' ? 'done' : ''}`}>{s === 'on' ? '✓' : '!'}</span><span><span class="what">{name}</span><br /><span class="why">{s === 'on' ? 'On.' : s === 'blocked' ? 'Blocked by Screen Time.' : s === 'ask' ? 'Not allowed yet.' : 'Off.'}</span></span></li>)}
      </ul>
      {off.length > 0 && <p>{how}</p>}
      {off.length > 0 && !win && <div class="row"><button class="pill" onClick={() => (blocked ? shell.openAppSettings() : shell.requestMediaAccess())}>{blocked || (ios && !asks) ? 'Open Settings' : 'Continue'}</button></div>}
    </div>
  );
}
