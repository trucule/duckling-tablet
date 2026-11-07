import { useEffect, useState } from 'preact/hooks';
import { config, checkin, releaseDevice, go, lastError, parentUnlocked, setupNeeded, refreshSetup, instantUpdates } from '../state';
import { shell, type LockdownStatus } from '../shell';

// Behind the PIN: lockdown steps for this platform, a check-in button, and Remove from this device.
export function Parent() {
  const [status, setStatus] = useState<LockdownStatus>(shell.lockdownStatus());
  const [busy, setBusy] = useState(false);
  const refresh = () => { setStatus(shell.lockdownStatus()); refreshSetup(); };
  useEffect(() => { window.addEventListener('duckling:resume', refresh); return () => window.removeEventListener('duckling:resume', refresh); }, []);
  const c = config.value;
  const android = shell.platform === 'android';
  const release = async () => {
    if (!confirm('Remove Duckling from this device? The lockdown is lifted, the apps and data are removed, and Android then asks whether to uninstall Duckling. The family account keeps its settings.')) return;
    setBusy(true);
    await releaseDevice(true);
  };
  return (
    <div class="screen">
      <div class="topbar">
        <h1>{android && setupNeeded.value ? 'Set up this tablet' : 'Parent area'}</h1>
        <button class="pill" onClick={() => { parentUnlocked.value = false; go('home'); }}>Done</button>
      </div>

      {android && setupNeeded.value && (
        <div class="card">
          <p>The PIN is set. One more thing before handing the tablet over: the three lockdown steps below. Until they are done, a child can leave Duckling with the Home button.</p>
        </div>
      )}

      <div class="card">
        <h2>Included with Duckling</h2>
        <p>{c?.entitlement?.status === 'trial' && c.entitlement.daysLeft !== null ? `Free trial: ${c.entitlement.daysLeft} day${c.entitlement.daysLeft === 1 ? '' : 's'} left, then $5 a month for every tablet in the family.` : c?.entitlement?.status === 'active' ? 'Subscribed: $5 a month covers every tablet in the family.' : c?.entitlement?.status === 'ended' ? 'The free trial has ended. Subscribe in the parent portal to keep everything running.' : 'Free for 7 days, then $5 a month for every tablet in the family.'}</p>
        <ul class="included">
          <li><strong>Ask for an app, at no extra cost.</strong> Describe an app you wish existed; the ET Ducky team builds it for every family. Ask from the parent portal.</li>
          <li>24 learning apps and every new one, with the narrator voice.</li>
          <li>The child's avatar, stars and progress on every tablet she uses.</li>
          <li>The parent portal: apps, websites, a second parent, and this tablet from your phone.</li>
        </ul>
      </div>

      {android && (
        <div class="card">
          <h2>Lockdown</h2>
          <p>Each step is checked when you come back to this screen. With all three done, the child cannot leave Duckling.</p>
          <ul class="steps">
            <li><span class={`dot ${status.homeRole ? 'done' : ''}`}>{status.homeRole ? '✓' : '1'}</span>
              <span><span class="what">Make Duckling the home screen</span><br /><span class="why">Home and recents then lead back here.</span></span>
              <button class="pill quiet" onClick={() => { shell.requestHomeRole(); setTimeout(refresh, 1500); }}>Set</button></li>
            <li><span class={`dot ${status.deviceSecure ? 'done' : ''}`}>{status.deviceSecure ? '✓' : '2'}</span>
              <span><span class="what">A screen lock the child does not know</span><br /><span class="why">Needed so unpinning asks for it. Also turn on App pinning in the same settings.</span></span>
              <button class="pill quiet" onClick={() => { shell.openSecuritySettings(); setTimeout(refresh, 1500); }}>Open settings</button></li>
            <li><span class={`dot ${status.lockdownOn ? 'done' : ''}`}>{status.lockdownOn ? '✓' : '3'}</span>
              <span><span class="what">Keep Duckling pinned</span><br /><span class="why">Android asks once to confirm pinning; after that it re-pins on every start.</span></span>
              <button class="pill quiet" onClick={() => { shell.setLockdown(!status.lockdownOn); setTimeout(refresh, 800); }}>{status.lockdownOn ? 'Turn off' : 'Turn on'}</button></li>
          </ul>
        </div>
      )}

      {android && (
        <div class="card">
          <h2>Other apps</h2>
          <p>Apps already on this tablet can appear on the home screen with a daily allowance, chosen in the parent portal under this tablet. {c?.otherApps?.length ? `${c.otherApps.length} allowed now.` : 'None allowed yet.'}</p>
          <p>While another app is open the lockdown is lifted; Duckling comes back on its own when the time ends. For that it needs permission to appear over other apps{shell.canDrawOverlays() ? ': granted.' : '.'}</p>
          {!shell.canDrawOverlays() && <div class="row"><button class="pill" onClick={() => shell.openOverlaySettings()}>Allow Duckling to appear over other apps</button></div>}
        </div>
      )}

      <div class="card">
        <h2>Wi-Fi</h2>
        <p>{{ wifi: 'Connected to Wi-Fi.', cellular: 'Connected through mobile data.', other: 'Connected.', none: 'Not connected to the internet. Installed apps still work; new apps, the narrator voice and changes from the website wait until the tablet is back online.' }[shell.networkStatus()]}</p>
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
        <p>{c?.child ? `${c.child.firstName}'s` : 'Unassigned'} {shell.platform === 'web' ? 'browser' : 'tablet'} · id {c?.deviceId ?? '?'} · shell {shell.shellVersion()}</p>
        <p>Apps, the website list, the child's profile, time limits and the subscription are chosen in the parent portal at parents.ducklingtablet.com. Changes made there reach this tablet {instantUpdates() ? 'within seconds while it is on and online' : 'when it is opened, and every three hours'}; the button below fetches them now.</p>
        <div class="row">
          <button class="pill" disabled={busy} onClick={async () => { setBusy(true); await checkin(); setBusy(false); refresh(); }}>Sync with the website</button>
        </div>
        {lastError.value && <div class="error">{lastError.value}</div>}
      </div>

      <div class="card">
        <h2>Remove from this device</h2>
        <p>Lifts the lockdown, tells the website, clears the apps and data, and then Android asks whether to uninstall Duckling. You can pair the tablet again later.</p>
        <div class="row"><button class="pill danger" disabled={busy} onClick={release}>Remove Duckling from this device</button></div>
      </div>
    </div>
  );
}
