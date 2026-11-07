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
