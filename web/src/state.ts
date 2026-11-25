// App state: the device config from the server, the catalog, and what the shell has installed. Installs the server
// expects (starter apps at pairing, apps a parent added remotely) are downloaded as soon as the config arrives.
import { signal, computed, effect } from '@preact/signals';
import { lang, setLang, tr } from './i18n';
import { adoptTabletBackground, forgetPictures, forgetTabletBackground } from './pictures';
import { api, ReleasedError, type DeviceConfig, type CatalogApp, type OtherApp, type Entitlement } from './api';
import { shell, type RefusedHost, type SignInProvider } from './shell';
import { logEvent } from './diag';

// The last config the server sent is kept on the tablet, so the home screen has its tiles at once on the next start,
// offline, and after the tablet was removed from its family on the website.
const CONFIG_KEY = 'duckling:last-config';
const storedConfig = (): DeviceConfig | null => { try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); } catch { return null; } };
export const config = signal<DeviceConfig | null>(storedConfig());
// The tablet speaks the language the server sends (the child's, else the family's); before pairing, its own.
effect(() => { if (config.value?.language) setLang(config.value.language); });
// The shell's own screens follow the tablet's language too.
effect(() => { shell.setLanguage(lang.value); });
// Removed from the family on the website, or the family account was deleted: the server answers 410. The tablet
// keeps its apps, PIN and lockdown and the parent area asks for a new pairing code. Nothing is wiped; only the
// tablet's own "Remove Duckling from this device" does that.
const UNLINKED_KEY = 'duckling:unlinked';
export const unlinked = signal<boolean>((() => { try { return localStorage.getItem(UNLINKED_KEY) === '1'; } catch { return false; } })());
function setUnlinked(on: boolean) { unlinked.value = on; try { if (on) localStorage.setItem(UNLINKED_KEY, '1'); else localStorage.removeItem(UNLINKED_KEY); } catch { /* storage unavailable */ } }
export const catalog = signal<CatalogApp[]>([]);
export const installed = signal<Record<string, string>>(shell.installedApps());
export const installing = signal<Record<string, string>>({}); // id -> status text
export const paired = signal<boolean>(!!shell.getDeviceToken());
export const route = signal<string>(location.hash.replace(/^#\/?/, '') || 'home');
export const lastError = signal<string>('');
// The parent area stays unlocked across a restart for a few minutes. Making Duckling the home app, and some of the
// settings screens the lockdown steps open, make Android recreate the activity, which reloads this page; without
// this the parent landed on the child's home screen (or the PIN screen) mid-setup and had to find the way back.
const UNLOCK_KEY = 'duckling:parent-unlocked-until';
const UNLOCK_MINUTES = 5;
const unlockedUntil = () => { try { return Number(localStorage.getItem(UNLOCK_KEY) || 0); } catch { return 0; } };
export const parentUnlocked = signal<boolean>(unlockedUntil() > Date.now());
export function unlockParent(on: boolean) {
  parentUnlocked.value = on;
  if (!on) shell.windows?.endParent();
  try { if (on) localStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_MINUTES * 60 * 1000)); else localStorage.removeItem(UNLOCK_KEY); } catch { /* storage unavailable: no carry-over */ }
}
if (parentUnlocked.value && !location.hash.includes('parent')) location.hash = '#/parent';

window.addEventListener('hashchange', () => { route.value = location.hash.replace(/^#\/?/, '') || 'home'; });
export const go = (r: string) => { location.hash = `#/${r}`; };

export const childName = computed(() => config.value?.child?.firstName ?? '');
// The server decides the lock from the entitlement at each check-in. A trial ends at a time the tablet already knows,
// with nobody there to push a change, so the tablet also ends it on its own the minute that time passes (the config
// is re-read every minute below) rather than at the next check-in. A paid subscription is left to the server: the
// store renews it, and a lapse arrives by push or check-in.
export const entitlement = computed<Entitlement | undefined>(() => {
  const e = config.value?.entitlement;
  if (e?.status === 'trial' && e.periodEnd && new Date(e.periodEnd).getTime() <= Date.now()) return { ...e, status: 'ended', daysLeft: 0 };
  return e;
});
export const locked = computed(() => !!config.value?.locked || entitlement.value?.status === 'ended');
export const themeColors = computed(() => config.value?.child?.theme?.colors ?? []);

export function refreshInstalled() { installed.value = shell.installedApps(); }

export async function loadCatalog() {
  try { catalog.value = (await api.catalog()).apps; } catch (e) { lastError.value = (e as Error).message; }
}

export async function checkin(): Promise<void> {
  if (!shell.getDeviceToken()) { paired.value = false; return; }
  try {
    const c = await api.checkin();
    setConfig(c);
    paired.value = true;
    lastError.value = '';
    if (c.state === 'release') { await releaseDevice(true); return; }
    void installMissing(c);
    void reportInstalled();
    void reportRefused();
  } catch (e) {
    if (e instanceof ReleasedError) {
      // Removed from the family with nothing on it to keep (a reinstalled app that still had the old credential, or a
      // tablet removed before anything was installed): start setup again. Otherwise keep the apps and show the
      // unlinked banner.
      if (!Object.keys(shell.installedApps()).length && !storedConfig()) { await releaseDevice(false); return; }
      setUnlinked(true); return;
    }
    lastError.value = (e as Error).message;
  }
}

function setConfig(c: DeviceConfig) {
  config.value = c;
  setUnlinked(false);
  applyConfig(c);
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); } catch { /* storage unavailable: the next check-in fills it */ }
}

// What the shell needs from the config: the websites it may open, the child's name and voice for the apps, and the
// family PIN (set on the website or on another tablet).
function applyConfig(c: DeviceConfig) {
  applyHosts(c);
  shell.setChildInfo(c.child?.firstName ?? '', c.narratorVoice ?? '');
  shell.setChildLevels(c.child?.levels ?? {});
  shell.setChildId(c.child?.id ?? '');
  if (c.appAccountToken) shell.setAppAccountToken(c.appAccountToken);
  if (c.pinHash) shell.setPinHash(c.pinHash);
  // Windows: the kiosk must list every other app a parent allowed before the child can open it.
  shell.windows?.setOtherApps((c.otherApps ?? []).map((a) => a.package));
}

// ---- Websites the shell may open right now: the allowlist, every site during travel mode, and the sites of other
// apps while they have time. Re-evaluated every minute, since windows open and close and travel mode ends.
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hhmm = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Seconds an app may still be open today, and why not when it may not.
export function otherAppState(a: OtherApp): { ok: boolean; secondsLeft: number; reason: string } {
  if (a.window) {
    const now = hhmm(), inWindow = a.window.start <= a.window.end ? (now >= a.window.start && now < a.window.end) : (now >= a.window.start || now < a.window.end);
    if (!inWindow) return { ok: false, secondsLeft: 0, reason: tr('Open {start} to {end}', { start: a.window.start, end: a.window.end }) };
  }
  if (a.dailyMinutes === null) return { ok: true, secondsLeft: 6 * 3600, reason: '' };
  const left = a.dailyMinutes * 60 - a.usedSecondsToday;
  if (left <= 0) return { ok: false, secondsLeft: 0, reason: tr('Done for today') };
  return { ok: true, secondsLeft: left, reason: tr('{n} min left today', { n: Math.ceil(left / 60) }) };
}

export const travelActive = (c: DeviceConfig | null) => !!c?.travel.active && !!c.travel.until && new Date(c.travel.until).getTime() > Date.now();

// Every website this tablet may open from its config: the allowlist, what those sites need for videos and sign-in,
// and the sites of other apps.
export function websiteHosts(c: DeviceConfig): string[] {
  const hosts = new Set(c.allowlist.map((w) => w.host.replace(/^\*\./, '')));
  for (const h of [...(c.mediaHosts ?? []), ...(c.signInHosts ?? [])]) hosts.add(h);
  for (const a of c.otherApps ?? []) for (const h of a.hosts) hosts.add(h.replace(/^\*\./, ''));
  return [...hosts].filter((h) => h && h !== '*');
}

// Fixes loading problems: the websites' saved data on the device (through the shell), then Duckling's own offline
// copy of its screens (the service worker and its caches), and a reload from the server. The apps, the child's
// progress and pictures, the PIN and the pairing stay.
export async function clearSavedData(c: DeviceConfig | null) {
  if (c) shell.clearWebsiteData(websiteHosts(c));
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* no Cache API */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* no service worker */ }
  setTimeout(() => location.reload(), 600);
}

// Hosts the websites were refused, taken from the shell and sent to the server, which files them under the allowed
// site they came from for the parent area and the portal. A report that fails is kept for the next check-in.
let unsentRefused: RefusedHost[] = [];
export async function reportRefused(): Promise<void> {
  const fresh = shell.takeBlockedHosts();
  if (!fresh.length && !unsentRefused.length) return;
  const items = [...unsentRefused, ...fresh].slice(-200);
  unsentRefused = [];
  try { await api.reportSiteHosts(items); } catch { unsentRefused = items; }
}

function applyHosts(c: DeviceConfig) {
  // Sign-in services a website may send a parent to (Log in with Google); the shell shows them a standard browser
  // user agent, since they refuse an embedded web view (backend/src/sitehosts.ts).
  shell.setSignInHosts(c.signInHosts ?? []);
  // Refused without the Video blocked button: advertising, analytics, and hosts a parent kept blocked.
  shell.setQuietHosts(c.quietHosts ?? []);
  if (travelActive(c)) { shell.setAllowedHosts(['*']); return; }
  const hosts = new Set(c.allowlist.map((w) => w.host.replace(/^\*\./, '')));
  // What the allowed websites need for their own videos, from the server's checked list (backend/src/sitehosts.ts).
  for (const h of c.mediaHosts ?? []) hosts.add(h);
  for (const h of c.signInHosts ?? []) hosts.add(h);
  for (const a of c.otherApps ?? []) if (otherAppState(a).ok) for (const h of a.hosts) hosts.add(h.replace(/^\*\./, ''));
  shell.setAllowedHosts([...hosts]);
}
let wasLocked = false;
setInterval(() => {
  if (!config.value) return;
  applyHosts(config.value); config.value = { ...config.value };
  // The trial just ran out on the tablet's clock: fetch the server's view too, in case a subscription landed.
  if (locked.value && !wasLocked && !config.value.locked) void checkin();
  wasLocked = locked.value;
}, 60_000);

// The tablet's own apps go up once per session so the parent can allow them; the shell lists them. On the iPad the
// list is what a parent picked there, so it goes up again whenever that changes, an empty list included (the last
// pick removed).
let reportedInstalled = false;
async function reportInstalled() {
  if (reportedInstalled || shell.platform === 'web') return;
  const apps = shell.installedPackages();
  if (!apps.length && shell.platform !== 'ios') return;
  reportedInstalled = true;
  try { const r = await api.reportInstalled(apps); if (config.value) config.value = { ...config.value, otherApps: r.otherApps }; } catch { reportedInstalled = false; }
}
window.addEventListener('duckling:otherapps', () => { reportedInstalled = false; void reportInstalled(); });

// Opening another app: for as long as it has today, at most. The shell comes back when that ends.
// The label of an app that needs Duckling to restart before it opens (Windows), shown on the home screen.
export const restartNeeded = signal<string | null>(null);

export function openOtherApp(a: OtherApp) {
  const st = otherAppState(a);
  if (!st.ok) { lastError.value = `${a.label}: ${st.reason}`; return; }
  shell.launchPackage(a.package, Math.min(st.secondsLeft, 6 * 3600));
}
window.addEventListener('duckling:otherapp', async (e) => {
  const { pkg, seconds, reason } = (e as CustomEvent<{ pkg: string; seconds: number; reason: string }>).detail;
  if (reason === 'missing') { lastError.value = tr('That app is not on this tablet any more.'); reportedInstalled = false; void reportInstalled(); return; }
  // Windows reads the kiosk's list of apps at sign-in, so an app allowed since then needs Duckling to restart.
  if (reason === 'restart') { restartNeeded.value = config.value?.otherApps?.find((a) => a.package === pkg)?.label ?? tr('this app'); return; }
  if (reason === 'failed') { lastError.value = tr('That app did not open.'); return; }
  if (seconds <= 0) return;
  // Count it locally at once, then on the server.
  if (config.value) {
    config.value = { ...config.value, otherApps: (config.value.otherApps ?? []).map((a) => a.package === pkg ? { ...a, usedSecondsToday: a.usedSecondsToday + seconds } : a) };
    applyHosts(config.value);
  }
  try { const r = await api.otherAppUsage(pkg, seconds, localDay()); if (config.value) { config.value = { ...config.value, otherApps: r.otherApps }; applyHosts(config.value); } } catch { /* counted locally; the next check-in reconciles */ }
});

// ---- Time in Duckling apps. Opening one notes the app and the time; coming back to Duckling sends the open and the
// minutes to the server for the owner's stats. The note is kept in localStorage, so a page reload in between (the iPad
// shell can reload the home page) still counts it. One open spans the time until the tablet is back on Duckling.
const OPEN_KEY = 'duckling:app-open';
const MAX_SECONDS = 6 * 3600;
function finishAppOpen() {
  let open: { id: string; start: number; day: string } | null = null;
  try { open = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); localStorage.removeItem(OPEN_KEY); } catch { return; }
  if (!open || typeof open.id !== 'string' || typeof open.start !== 'number') return;
  const seconds = Math.max(0, Math.min(MAX_SECONDS, Math.round((Date.now() - open.start) / 1000)));
  void api.appUsage(open.id, seconds, open.day || localDay()).catch(() => { /* a lost open only lowers the stats */ });
}
export function openApp(id: string) {
  finishAppOpen();
  try { localStorage.setItem(OPEN_KEY, JSON.stringify({ id, start: Date.now(), day: localDay() })); } catch { /* no storage: not counted */ }
  shell.openApp(id);
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
  installing.value = { ...installing.value, [id]: tr('Downloading') };
  try {
    await shell.installApp(id, version, url, sha256, signature, permissions);
    refreshInstalled();
    return true;
  } catch (e) {
    lastError.value = `${id}: ${(e as Error).message}`;
    logEvent('install', `${id} ${version}: ${(e as Error).message}`);
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
  setUnlinked(false);
  try { localStorage.removeItem(CONFIG_KEY); } catch { /* storage unavailable */ }
  await forgetPictures();
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
  setConfig(r.config); paired.value = true;
  void installMissing(r.config);
  // A new tablet lands on its home screen, where the banner says it is not locked down yet. A family without a PIN
  // chooses one first (setup-pin), which then leads home too.
  go(shell.platform === 'web' || shell.hasPin() ? 'home' : 'setup-pin');
}

// An unlinked tablet joins a family again with a pairing code from the website. The apps already on it that the new
// family's list lacks are added to that list, so the child's tiles come back; the parent stays in the parent area.
export async function relink(code: string, name: string) {
  const r = await api.pair(code, name);
  shell.setDeviceToken(r.deviceToken);
  setConfig(r.config); paired.value = true;
  const listed = new Set(r.config.apps.map((a) => a.id));
  for (const id of Object.keys(installed.value)) if (!listed.has(id) && !r.config.hidden.includes(id)) { try { await api.install(id); } catch { /* the family is locked out, or the app is gone from the catalog */ } }
  await checkin();
}

export async function pairWithProvider(provider: SignInProvider, idToken: string, nonce: string, childFirstName: string | undefined, childAge: number | undefined, name: string) {
  adopt(await api.pairWithProvider(provider, idToken, nonce, childFirstName, childAge, name));
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
window.addEventListener('duckling:state', refreshSetup);
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

// Check in on load and every 3 hours, on a push, and every time the home screen comes back into view.
let lastCatalog = 0, running: Promise<void> | null = null, again = false;
// One check-in at a time. A request while one is running runs once more after it, so a change saved just before the
// home screen came back (a new background, portrait or stars) is never answered by a check-in that started earlier.
function checkinNow(): void {
  if (running) { again = true; return; }
  running = checkin().finally(() => { running = null; if (again) { again = false; checkinNow(); } });
}
function refresh(catalogGap: number) {
  checkinNow();
  if (Date.now() - lastCatalog > catalogGap) { lastCatalog = Date.now(); void loadCatalog(); }
}
// A Camera Fun photo set as this tablet's background waits in the shell until the home screen is back.
function takeTabletBackground() {
  const d = shell.takeLocalBackground();
  if (d === 'none') void forgetTabletBackground();
  else if (d) void adoptTabletBackground(d);
}
export function startCheckins() {
  finishAppOpen();
  takeTabletBackground();
  refresh(0);
  setInterval(() => refresh(0), 3 * 3600 * 1000);
  // A push from the server: a parent changed something, or the shell has a new push token to report.
  window.addEventListener('duckling:push', () => refresh(0));
  // Back from an app or another screen: My Avatar may have saved a portrait, Paint Studio a background, and any app
  // stars. Every return checks in; only the catalog waits between returns. The shells say so with onResume, and the
  // page itself sees it as visibilitychange (the iPad shell sends onResume only when Duckling comes to the front).
  window.addEventListener('duckling:resume', () => { finishAppOpen(); takeTabletBackground(); refresh(20 * 1000); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { finishAppOpen(); takeTabletBackground(); refresh(10 * 60 * 1000); } });
}
