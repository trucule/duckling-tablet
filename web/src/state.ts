// App state: the device config from the server, the catalog, and what the shell has installed. Installs the server
// expects (starter apps at pairing, apps a parent added remotely) are downloaded as soon as the config arrives.
import { signal, computed } from '@preact/signals';
import { api, ReleasedError, type DeviceConfig, type CatalogApp } from './api';
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
  } catch (e) {
    if (e instanceof ReleasedError) { await releaseDevice(false); return; }
    lastError.value = (e as Error).message;
  }
}

// What the shell needs from the config: the websites it may open, the child's name and voice for the apps, and the
// family PIN (set on the website or on another tablet).
function applyConfig(c: DeviceConfig) {
  shell.setAllowedHosts(c.allowlist.map((w) => w.host.replace(/^\*\./, '')));
  shell.setChildInfo(c.child?.firstName ?? '', c.narratorVoice ?? '');
  if (c.pinHash) shell.setPinHash(c.pinHash);
}

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
  const r = await api.pair(code, name);
  shell.setDeviceToken(r.deviceToken);
  config.value = r.config; paired.value = true;
  applyConfig(r.config);
  void installMissing(r.config);
  go('home');
}

// Check in on load and every 3 hours, and whenever the page comes back to the foreground after a while.
let last = 0;
export function startCheckins() {
  const tick = () => { last = Date.now(); void checkin(); void loadCatalog(); };
  tick();
  setInterval(tick, 3 * 3600 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 10 * 60 * 1000) tick(); });
  // A push from the server: a parent changed something, or the shell has a new push token to report.
  window.addEventListener('duckling:push', tick);
}
