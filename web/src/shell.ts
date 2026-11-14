// The bridge to the native shell (window.DucklingShell, injected by the Android, iPad and Windows apps).
// In a desktop browser there is no shell: the browser fallback keeps state in localStorage, "installs" are
// recorded with the server only, and opening an app explains that apps run on the tablet.

export interface LockdownStatus { homeRole: boolean; deviceSecure: boolean; pinned: boolean; lockdownOn: boolean; windows?: WindowsStatus }

// Windows: homeRole is "the child's account signs in automatically", lockdownOn "the kiosk is applied for it", pinned
// "this is the child's session", deviceSecure "this edition has the kiosk". The details below drive the setup card.
export interface WindowsStatus {
  edition?: string; productName?: string; build?: number; kioskSupported: boolean;
  accounts: { name: string; fullName: string }[]; childAccount: string; autoSignInUser: string;
  kioskApplied: boolean; otherKiosk: boolean; oldKidTablet: boolean; currentUser: string; parentPresent: boolean;
}
export interface WifiNetwork { ssid: string; signal: number; secured: boolean; connected: boolean }

// What only the Windows shell does: the child's Windows account, the kiosk, restarts, Wi-Fi from the parent area,
// a browser window for Stripe and network sign-in pages, and the other apps the kiosk must allow.
export interface WindowsShell {
  setChildAccount(name: string, fullName: string): Promise<string>;
  setLockdown(on: boolean): Promise<string>;
  restartDevice(): Promise<string>;
  restartSession(): Promise<string>;
  wifiNetworks(): Promise<WifiNetwork[]>;
  connectWifi(ssid: string, password: string): Promise<string>;
  // Resolves with how it ended: "purchased", "cancelled", "returned" (from Stripe) or "closed".
  openParentPage(url: string): Promise<string>;
  setOtherApps(ids: string[]): void;
  endParent(): void;
  exitShell(): void;
  isChildSession(): boolean;
}

export interface Shell {
  readonly platform: 'android' | 'ios' | 'windows' | 'web';
  shellVersion(): string;
  getDeviceToken(): string;
  setDeviceToken(token: string): void;
  pushToken(): string; // '' when the shell has no push
  installedApps(): Record<string, string>; // id -> version
  installApp(id: string, version: string, url: string, sha256: string, signature: string, permissions: string[]): Promise<void>;
  uninstallApp(id: string): void;
  openApp(id: string): void;
  hasPin(): boolean;
  setPin(pin: string): Promise<void>;
  verifyPin(pin: string): Promise<boolean>;
  // The family PIN from the server, as SHA-256 hex of "duckling:<pin>"; replaces whatever the shell holds.
  setPinHash(hash: string): void;
  lockdownStatus(): LockdownStatus;
  requestHomeRole(): void;
  openSecuritySettings(): void;
  openWifiSettings(): void;
  networkStatus(): 'wifi' | 'cellular' | 'other' | 'none';
  // The device's own permission for Duckling to use the microphone and camera; null where the shell cannot tell.
  mediaAccess(): MediaAccess | null;
  requestMediaAccess(): void; // ask the system, or open Duckling's page in its settings when it no longer asks
  openAppSettings(): void;
  setLockdown(on: boolean): void;
  setAllowedHosts(hosts: string[]): void;
  setChildInfo(name: string, voice: string): void;
  setChildLevels(levels: Record<string, number>): void;
  setChildId(id: string): void;
  release(): void;
  // Other apps: what is on the tablet, opening one for a number of seconds, and the permission that lets Duckling
  // come back when that time ends.
  installedPackages(): { package: string; label: string; icon?: string }[];
  launchPackage(pkg: string, seconds: number): void;
  canDrawOverlays(): boolean;
  openOverlaySettings(): void;
  // The subscription through the device's own store (the App Store on the iPad, Google Play on Android). False where
  // the store is not built in.
  readonly storeBilling: boolean;
  subscriptionPrice(): string; // the store's price text, '' until the store answers
  subscribe(): Promise<BillingResult>;
  restorePurchases(): Promise<BillingResult>;
  manageSubscription(): void;
  setAppAccountToken(token: string): void;
  readonly windows: WindowsShell | null;
}

// on: allowed; off: not allowed (declined, switched off, or not asked yet on Android); blocked: a restriction set
// elsewhere (iPad Screen Time); ask: the iPad has not asked yet.
export type MediaState = 'on' | 'off' | 'blocked' | 'ask';
export interface MediaAccess { microphone: MediaState; camera: MediaState }

export interface BillingResult { status: 'purchased' | 'pending' | 'cancelled' | 'unavailable' | 'failed' | 'none' | string; message: string }

// The Android side exposes synchronous string-returning methods; async work calls back into window.DucklingWeb.
interface NativeShell {
  platform(): string;
  shellVersion(): string;
  getDeviceToken(): string;
  setDeviceToken(t: string): void;
  pushToken?(): string;
  installedApps(): string;
  installApp(id: string, version: string, url: string, sha256: string, signature: string, permissions: string): void;
  uninstallApp(id: string): void;
  openApp(id: string): void;
  hasPin(): boolean;
  setPin(pin: string): void;
  verifyPin(pin: string): boolean;
  setPinHash(hash: string): void;
  lockdownStatus(): string;
  requestHomeRole(): void;
  openSecuritySettings(): void;
  openWifiSettings?(): void;
  networkStatus?(): string;
  mediaAccess?(): string;
  requestMediaAccess?(): void;
  openAppSettings?(): void;
  setLockdown(on: boolean): void;
  setAllowedHosts(csv: string): void;
  setChildInfo(name: string, voice: string): void;
  setChildLevels?(json: string): void;
  setChildId?(id: string): void;
  release(): void;
  installedPackages?(): string;
  launchPackage?(pkg: string, seconds: number): void;
  canDrawOverlays?(): boolean;
  openOverlaySettings?(): void;
  subscribe?(): void;
  restorePurchases?(): void;
  manageSubscription?(): void;
  subscriptionPrice?(): string;
  setAppAccountToken?(token: string): void;
  // Windows only (results arrive at DucklingWeb.onWindows(kind, ok, message))
  setChildAccount?(name: string, fullName: string): void;
  restartDevice?(): void;
  restartSession?(): void;
  wifiNetworks?(): void;
  connectWifi?(ssid: string, password: string): void;
  openParentPage?(url: string): void;
  setOtherApps?(csv: string): void;
  endParent?(): void;
  exitShell?(): void;
  isChildSession?(): boolean;
}

declare global {
  interface Window { DucklingShell?: NativeShell; DucklingWeb?: { onInstall(id: string, ok: boolean, message: string): void; onResume(): void; onPush(): void; onOtherApp(pkg: string, seconds: number, reason: string): void; onBilling(status: string, message: string): void; onWindows(kind: string, ok: boolean, message: string): void } }
}

const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
window.DucklingWeb = {
  onInstall(id, ok, message) {
    const p = pending.get(id); pending.delete(id);
    if (!p) return;
    ok ? p.resolve() : p.reject(new Error(message || 'Install failed'));
  },
  // The shell calls this when the activity comes back to the front (after a settings screen, for example).
  onResume() { window.dispatchEvent(new Event('duckling:resume')); },
  // A push from the server (a parent changed something), or a new push token to report.
  onPush() { window.dispatchEvent(new Event('duckling:push')); },
  // Another app's turn ended (the child came back, or the time ran out): how long it was open.
  onOtherApp(pkg, seconds, reason) { window.dispatchEvent(new CustomEvent('duckling:otherapp', { detail: { pkg, seconds, reason } })); },
  // A store purchase, restore or its failure: one at a time, so the waiting promise is the only one.
  onBilling(status, message) { const w = billingWait; billingWait = null; w?.({ status, message }); },
  // Windows: the end of a lockdown step, a Wi-Fi scan or join, the parent browser closing.
  onWindows(kind, ok, message) {
    const w = windowsWaits.get(kind); windowsWaits.delete(kind);
    w?.(ok, message);
    window.dispatchEvent(new CustomEvent('duckling:windows', { detail: { kind, ok, message } }));
  },
};
const windowsWaits = new Map<string, (ok: boolean, message: string) => void>();
const windowsCall = (kind: string, start: () => void) => new Promise<string>((resolve, reject) => {
  windowsWaits.set(kind, (ok, message) => (ok ? resolve(message) : reject(new Error(message || 'That did not work.'))));
  try { start(); } catch (e) { windowsWaits.delete(kind); reject(e as Error); }
});

function windowsShell(n: NativeShell): WindowsShell {
  return {
    setChildAccount: (name, fullName) => windowsCall('account', () => n.setChildAccount!(name, fullName)),
    setLockdown: (on) => windowsCall('lockdown', () => n.setLockdown(on)),
    restartDevice: () => windowsCall('restart', () => n.restartDevice!()),
    restartSession: () => windowsCall('restartSession', () => n.restartSession!()),
    wifiNetworks: async () => JSON.parse(await windowsCall('wifi', () => n.wifiNetworks!())) as WifiNetwork[],
    connectWifi: (ssid, password) => windowsCall('wifiConnect', () => n.connectWifi!(ssid, password)),
    openParentPage: (url) => new Promise<string>((resolve) => { windowsWaits.set('parentPage', (_ok, message) => resolve(message.split(' ')[0] || 'closed')); n.openParentPage!(url); }),
    setOtherApps: (ids) => { try { n.setOtherApps?.(ids.join(',')); } catch { /* older shell */ } },
    endParent: () => { try { n.endParent?.(); } catch { /* older shell */ } },
    exitShell: () => n.exitShell?.(),
    isChildSession: () => { try { return !!n.isChildSession?.(); } catch { return false; } },
  };
}
let billingWait: ((r: BillingResult) => void) | null = null;
const billingCall = (start: () => void) => new Promise<BillingResult>((resolve) => { billingWait = resolve; start(); });

function native(n: NativeShell): Shell {
  return {
    platform: (n.platform() as Shell['platform']) || 'android',
    shellVersion: () => n.shellVersion(),
    getDeviceToken: () => n.getDeviceToken() || '',
    setDeviceToken: (t) => n.setDeviceToken(t),
    pushToken: () => { try { return n.pushToken?.() || ''; } catch { return ''; } },
    installedApps: () => { try { return JSON.parse(n.installedApps() || '{}'); } catch { return {}; } },
    installApp: (id, version, url, sha256, signature, permissions) => new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      n.installApp(id, version, url, sha256, signature, permissions.join(','));
    }),
    uninstallApp: (id) => n.uninstallApp(id),
    openApp: (id) => n.openApp(id),
    hasPin: () => n.hasPin(),
    setPin: async (pin) => n.setPin(pin),
    verifyPin: async (pin) => n.verifyPin(pin),
    setPinHash: (h) => { try { n.setPinHash(h); } catch { /* older shell */ } },
    lockdownStatus: () => { try { return JSON.parse(n.lockdownStatus()); } catch { return { homeRole: false, deviceSecure: false, pinned: false, lockdownOn: false }; } },
    requestHomeRole: () => n.requestHomeRole(),
    openSecuritySettings: () => n.openSecuritySettings(),
    openWifiSettings: () => { try { n.openWifiSettings?.(); } catch { /* older shell */ } },
    mediaAccess: () => { try { const j = n.mediaAccess?.(); return j ? JSON.parse(j) as MediaAccess | null : null; } catch { return null; } },
    requestMediaAccess: () => { try { n.requestMediaAccess?.(); } catch { /* older shell */ } },
    openAppSettings: () => { try { n.openAppSettings?.(); } catch { /* older shell */ } },
    networkStatus: () => { try { return (n.networkStatus?.() as ReturnType<Shell['networkStatus']>) || (navigator.onLine ? 'other' : 'none'); } catch { return navigator.onLine ? 'other' : 'none'; } },
    setLockdown: (on) => n.setLockdown(on),
    setAllowedHosts: (hosts) => n.setAllowedHosts(hosts.join(',')),
    setChildInfo: (name, voice) => n.setChildInfo(name, voice),
    setChildLevels: (l) => { try { n.setChildLevels?.(JSON.stringify(l)); } catch { /* older shell */ } },
    setChildId: (id) => { try { n.setChildId?.(id); } catch { /* older shell */ } },
    release: () => n.release(),
    installedPackages: () => { try { return JSON.parse(n.installedPackages?.() || '[]'); } catch { return []; } },
    launchPackage: (pkg, seconds) => n.launchPackage?.(pkg, seconds),
    canDrawOverlays: () => { try { return !!n.canDrawOverlays?.(); } catch { return false; } },
    openOverlaySettings: () => n.openOverlaySettings?.(),
    storeBilling: typeof n.subscribe === 'function',
    subscriptionPrice: () => { try { return n.subscriptionPrice?.() || ''; } catch { return ''; } },
    subscribe: () => billingCall(() => n.subscribe?.()),
    restorePurchases: () => billingCall(() => n.restorePurchases?.()),
    manageSubscription: () => n.manageSubscription?.(),
    setAppAccountToken: (t) => { try { n.setAppAccountToken?.(t); } catch { /* older shell */ } },
    windows: n.platform() === 'windows' ? windowsShell(n) : null,
  };
}

function browser(): Shell {
  const get = (k: string) => { try { return localStorage.getItem(`duckling.${k}`); } catch { return null; } };
  const set = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(`duckling.${k}`) : localStorage.setItem(`duckling.${k}`, v); } catch {} };
  const installed = (): Record<string, string> => { try { return JSON.parse(get('installed') || '{}'); } catch { return {}; } };
  const hash = async (pin: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`duckling:${pin}`)))).map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    platform: 'web',
    shellVersion: () => 'web-0.1.0',
    getDeviceToken: () => get('token') || '',
    setDeviceToken: (t) => set('token', t || null),
    pushToken: () => '',
    installedApps: installed,
    async installApp(id, version) { const all = installed(); all[id] = version; set('installed', JSON.stringify(all)); },
    uninstallApp(id) { const all = installed(); delete all[id]; set('installed', JSON.stringify(all)); },
    openApp() { alert('Apps run on the tablet. In a browser, the Store and the parent area can be tried.'); },
    hasPin: () => !!get('pin'),
    async setPin(pin) { set('pin', await hash(pin)); },
    async verifyPin(pin) { return !!get('pin') && get('pin') === await hash(pin); },
    setPinHash(h) { set('pin', h); },
    lockdownStatus: () => ({ homeRole: false, deviceSecure: false, pinned: false, lockdownOn: false }),
    requestHomeRole() { alert('On the tablet this opens the home app chooser.'); },
    openSecuritySettings() { alert('On the tablet this opens the security settings.'); },
    openWifiSettings() { alert('On the tablet this opens the Wi-Fi settings.'); },
    mediaAccess: () => null,
    requestMediaAccess() {},
    openAppSettings() {},
    networkStatus: () => (navigator.onLine ? 'other' : 'none'),
    setLockdown() {},
    setAllowedHosts() {},
    setChildInfo() {},
    setChildLevels() {},
    setChildId() {},
    release() { set('token', null); set('installed', null); set('pin', null); },
    installedPackages: () => [],
    launchPackage() { alert('On the tablet this opens the app.'); },
    canDrawOverlays: () => false,
    openOverlaySettings() { alert('On the tablet this opens the overlay permission.'); },
    storeBilling: false,
    subscriptionPrice: () => '',
    subscribe: async () => ({ status: 'unavailable', message: '' }),
    restorePurchases: async () => ({ status: 'unavailable', message: '' }),
    manageSubscription() {},
    setAppAccountToken() {},
    windows: null,
  };
}

export const shell: Shell = window.DucklingShell ? native(window.DucklingShell) : browser();
