// The bridge to the native shell (window.DucklingShell, injected by the Android app; iPad and Windows later).
// In a desktop browser there is no shell: the browser fallback keeps state in localStorage, "installs" are
// recorded with the server only, and opening an app explains that apps run on the tablet.

export interface LockdownStatus { homeRole: boolean; deviceSecure: boolean; pinned: boolean; lockdownOn: boolean }

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
  setLockdown(on: boolean): void;
  setAllowedHosts(hosts: string[]): void;
  setChildInfo(name: string, voice: string): void;
  release(): void;
}

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
  setLockdown(on: boolean): void;
  setAllowedHosts(csv: string): void;
  setChildInfo(name: string, voice: string): void;
  release(): void;
}

declare global {
  interface Window { DucklingShell?: NativeShell; DucklingWeb?: { onInstall(id: string, ok: boolean, message: string): void; onResume(): void; onPush(): void } }
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
};

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
    networkStatus: () => { try { return (n.networkStatus?.() as ReturnType<Shell['networkStatus']>) || (navigator.onLine ? 'other' : 'none'); } catch { return navigator.onLine ? 'other' : 'none'; } },
    setLockdown: (on) => n.setLockdown(on),
    setAllowedHosts: (hosts) => n.setAllowedHosts(hosts.join(',')),
    setChildInfo: (name, voice) => n.setChildInfo(name, voice),
    release: () => n.release(),
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
    networkStatus: () => (navigator.onLine ? 'other' : 'none'),
    setLockdown() {},
    setAllowedHosts() {},
    setChildInfo() {},
    release() { set('token', null); set('installed', null); set('pin', null); },
  };
}

export const shell: Shell = window.DucklingShell ? native(window.DucklingShell) : browser();
