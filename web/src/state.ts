// App state: the device config from the server, the catalog, and what the shell has installed. Installs the server
// expects (starter apps at pairing, apps a parent added remotely) are downloaded as soon as the config arrives.
import { signal, computed } from '@preact/signals';
import { api, ReleasedError, type DeviceConfig, type CatalogApp, type OtherApp } from './api';
import { shell } from './shell';

export const config = signal<DeviceConfig | null>(null);
export const catalog = signal<CatalogApp[]>([]);
export const installed = signal<Record<string, string>>(shell.installedApps());
export const installing = signal<Record<string, string>>({}); // id -> status text
export const paired = signal<boolean>(!!shell.getDeviceToken());
export const route = signal<string>(location.hash.replace(/^#\/?/, '') || 'home');
export const lastError = signal<string>('');
export const parentUnlocked = signal<boolean>(false);

window.addEventListener('hashchange', () => { route.value = location.hash.replace(/^#\/?/, '') || 'home'; });
export const go = (r: string) => { location.hash = `#/${r}`; };

export const childName = computed(() => config.value?.child?.firstName ?? '');
export const themeColors = computed(() => config.value?.child?.theme?.colors ?? []);

export function refreshInstalled() { installed.value = shell.installedApps(); }

export async function loadCatalog() {
  try { catalog.value = (await api.catalog()).apps; } catch (e) { lastError.value = (e as Error).message; }
}

export async function checkin(): Promise<void> {
  if (!shell.getDeviceToken()) { paired.value = false; return; }
  try {
    const c = await api.checkin();
    config.value = c;
    paired.value = true;
    lastError.value = '';
    applyConfig(c);
    if (c.state === 'release') { await releaseDevice(true); return; }
    void installMissing(c);
    void reportInstalled();
  } catch (e) {
    if (e instanceof ReleasedError) { await releaseDevice(false); return; }
    lastError.value = (e as Error).message;
  }
}

// What the shell needs from the config: the websites it may open, the child's name and voice for the apps, and the
// family PIN (set on the website or on another tablet).
function applyConfig(c: DeviceConfig) {
  applyHosts(c);
  shell.setChildInfo(c.child?.firstName ?? '', c.narratorVoice ?? '');
  shell.setChildLevels(c.child?.levels ?? {});
  if (c.pinHash) shell.setPinHash(c.pinHash);
}

// ---- Websites the shell may open right now: the allowlist, every site during travel mode, and the sites of other
// apps while they have time. Re-evaluated every minute, since windows open and close and travel mode ends.
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hhmm = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Seconds an app may still be open today, and why not when it may not.
export function otherAppState(a: OtherApp): { ok: boolean; secondsLeft: number; reason: string } {
  if (a.window) {
    const now = hhmm(), inWindow = a.window.start <= a.window.end ? (now >= a.window.start && now < a.window.end) : (now >= a.window.start || now < a.window.end);
    if (!inWindow) return { ok: false, secondsLeft: 0, reason: `Open ${a.window.start} to ${a.window.end}` };
  }
  if (a.dailyMinutes === null) return { ok: true, secondsLeft: 6 * 3600, reason: '' };
  const left = a.dailyMinutes * 60 - a.usedSecondsToday;
  if (left <= 0) return { ok: false, secondsLeft: 0, reason: 'Done for today' };
  return { ok: true, secondsLeft: left, reason: `${Math.ceil(left / 60)} min left today` };
}

export const travelActive = (c: DeviceConfig | null) => !!c?.travel.active && !!c.travel.until && new Date(c.travel.until).getTime() > Date.now();

function applyHosts(c: DeviceConfig) {
  if (travelActive(c)) { shell.setAllowedHosts(['*']); return; }
  const hosts = new Set(c.allowlist.map((w) => w.host.replace(/^\*\./, '')));
  for (const a of c.otherApps ?? []) if (otherAppState(a).ok) for (const h of a.hosts) hosts.add(h.replace(/^\*\./, ''));
  shell.setAllowedHosts([...hosts]);
}
setInterval(() => { if (config.value) { applyHosts(config.value); config.value = { ...config.value }; } }, 60_000);

// The tablet's own apps go up once per session so the parent can allow them; the shell lists them.
let reportedInstalled = false;
async function reportInstalled() {
  if (reportedInstalled || shell.platform === 'web') return;
  const apps = shell.installedPackages();
  if (!apps.length) return;
  reportedInstalled = true;
  try { const r = await api.reportInstalled(apps); if (config.value) config.value = { ...config.value, otherApps: r.otherApps }; } catch { reportedInstalled = false; }
}

// Opening another app: for as long as it has today, at most. The shell comes back when that ends.
export function openOtherApp(a: OtherApp) {
  const st = otherAppState(a);
  if (!st.ok) { lastError.value = `${a.label}: ${st.reason}`; return; }
  shell.launchPackage(a.package, Math.min(st.secondsLeft, 6 * 3600));
}
window.addEventListener('duckling:otherapp', async (e) => {
  const { pkg, seconds, reason } = (e as CustomEvent<{ pkg: string; seconds: number; reason: string }>).detail;
  if (reason === 'missing') { lastError.value = 'That app is not on this tablet any more.'; reportedInstalled = false; void reportInstalled(); return; }
  if (seconds <= 0) return;
  // Count it locally at once, then on the server.
  if (config.value) {
    config.value = { ...config.value, otherApps: (config.value.otherApps ?? []).map((a) => a.package === pkg ? { ...a, usedSecondsToday: a.usedSecondsToday + seconds } : a) };
    applyHosts(config.value);
  }
  try { const r = await api.otherAppUsage(pkg, seconds, localDay()); if (config.value) { config.value = { ...config.value, otherApps: r.otherApps }; applyHosts(config.value); } } catch { /* counted locally; the next check-in reconciles */ }
});

// Apps the server lists for this device but the shell does not have yet (or has at an older version).
async function installMissing(c: DeviceConfig) {
  for (const a of c.apps) {
    if (installed.value[a.id] === a.version) continue;
    await installPackage(a.id, a.version, a.url, a.sha256, a.signature, a.permissions ?? []);
  }
}

export async function installPackage(id: string, version: string, url: string, sha256: string, signature: string, permissions: string[]): Promise<boolean> {
  if (installing.value[id]) return false;
  installing.value = { ...installing.value, [id]: 'Downloading' };
  try {
    await shell.installApp(id, version, url, sha256, signature, permissions);
    refreshInstalled();
    return true;
  } catch (e) {
    lastError.value = `${id}: ${(e as Error).message}`;
    return false;
  } finally {
    const { [id]: _, ...rest } = installing.value; installing.value = rest;
  }
}

export async function installFromStore(app: CatalogApp) {
  const ok = await installPackage(app.id, app.latest.version, app.latest.url, app.latest.sha256, app.latest.signature, app.latest.permissions);
  if (ok) { try { await api.install(app.id); } catch (e) { lastError.value = (e as Error).message; } await checkin(); }
}

export async function removeApp(id: string) {
  shell.uninstallApp(id); refreshInstalled();
  try { await api.uninstall(id); } catch (e) { lastError.value = (e as Error).message; }
  await checkin();
}

// Parent asked for release (portal or PIN area), or the server says the device is gone.
export async function releaseDevice(tellServer: boolean) {
  if (tellServer) { try { await api.released(); } catch { /* the device is leaving either way */ } }
  shell.release();
  shell.setDeviceToken('');
  config.value = null; paired.value = false; installed.value = {};
  go('pair');
}

// The first PIN, typed on this tablet: it becomes the family PIN unless the website set one in the meantime.
export async function setFirstPin(pin: string) {
  await shell.setPin(pin);
  try { await api.setPin(pin); } catch { /* already set elsewhere: the next check-in brings that one */ }
}

export async function pair(code: string, name: string) {
  adopt(await api.pair(code, name));
}

// The tablet is paired: keep the token, apply the config, start the starter downloads, and carry on with the PIN
// and the lockdown steps (on a tablet the parent who typed the code is holding it).
function adopt(r: { deviceToken: string; config: DeviceConfig }) {
  shell.setDeviceToken(r.deviceToken);
  config.value = r.config; paired.value = true;
  applyConfig(r.config);
  void installMissing(r.config);
  go(shell.platform === 'web' ? 'home' : 'pin');
}

export async function pairWithCode(email: string, code: string, childFirstName: string | undefined, childAge: number | undefined, name: string) {
  adopt(await api.pairWithCode(email, code, childFirstName, childAge, name));
}

// True while a tablet still needs the lockdown steps (the Home banner and the parent area's setup wording).
export const setupNeeded = signal<boolean>(false);
export function refreshSetup() {
  if (shell.platform === 'web') { setupNeeded.value = false; return; }
  const s = shell.lockdownStatus();
  setupNeeded.value = !(s.homeRole && s.lockdownOn);
}
window.addEventListener('duckling:resume', refreshSetup);
refreshSetup();

// A tile the child taps before its download finished, or after a failed one: try again.
export async function retryInstall(id: string) {
  const a = config.value?.apps.find((x) => x.id === id);
  if (!a || installed.value[a.id] === a.version) return;
  lastError.value = '';
  await installPackage(a.id, a.version, a.url, a.sha256, a.signature, a.permissions ?? []);
}

// Whether the shell can receive pushes (parent changes arrive within seconds instead of at the next sync).
export const instantUpdates = () => !!shell.pushToken();

// Check in on load and every 3 hours, and whenever the page comes back to the foreground after a while.
let last = 0;
export function startCheckins() {
  const tick = () => { last = Date.now(); void checkin(); void loadCatalog(); };
  tick();
  setInterval(tick, 3 * 3600 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 10 * 60 * 1000) tick(); });
  // A push from the server: a parent changed something, or the shell has a new push token to report.
  window.addEventListener('duckling:push', tick);
  // Back from an app: My Avatar may have saved a new portrait, and an app may have earned stars. A short gap keeps a
  // child flicking in and out of apps from checking in every few seconds.
  window.addEventListener('duckling:resume', () => { if (Date.now() - last > 20 * 1000) tick(); });
}
