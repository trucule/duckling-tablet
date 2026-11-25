// What a diagnostics report from the parent area carries: this build and browser, the shell and its lockdown state,
// the tablet's settings as it last received them, its event log and the shell's own log. No child name, PIN,
// pictures, tokens or anything typed in an app. The server adds what it knows and sends it to the team as a ticket.
import { shell } from './shell';
import { config, installed, lastError, route } from './state';
import { lang } from './i18n';
import { recentEvents } from './diag';

declare const __DUCKLING_BUILD__: string;
const build = typeof __DUCKLING_BUILD__ === 'string' ? __DUCKLING_BUILD__ : 'dev';

export async function collectReport(): Promise<Record<string, unknown>> {
  const c = config.value;
  const lock = { ...shell.lockdownStatus() } as Record<string, unknown>;
  // Windows lists its accounts by name; only the counts and states stay.
  if (lock.windows && typeof lock.windows === 'object') {
    const { accounts, childAccount, autoSignInUser, currentUser, ...rest } = lock.windows as Record<string, unknown>;
    lock.windows = { ...rest, accounts: Array.isArray(accounts) ? accounts.length : 0, childAccountSet: !!childAccount, autoSignIn: !!autoSignInUser, signedIn: currentUser ? (currentUser === childAccount ? 'child' : 'other') : '' };
  }
  let storage: unknown = null;
  try { storage = await navigator.storage?.estimate?.(); } catch { /* not offered */ }
  let cacheNames: string[] = [];
  try { cacheNames = await caches.keys(); } catch { /* no Cache API */ }
  const serverTime = c?.serverTime ? Date.parse(c.serverTime) : NaN;
  return {
    app: {
      build, userAgent: navigator.userAgent, language: lang.value, online: navigator.onLine, route: route.value,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, viewport: `${innerWidth}x${innerHeight}`,
      time: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // From the check-in just before the report: how far the tablet's clock is from the server's.
      clockOffsetSeconds: Number.isFinite(serverTime) ? Math.round((Date.now() - serverTime) / 1000) : null,
      serviceWorker: navigator.serviceWorker?.controller ? 'active' : 'none', caches: cacheNames, storage,
      lastError: lastError.value,
    },
    shell: {
      platform: shell.platform, version: shell.shellVersion(), network: shell.networkStatus(), lockdown: lock,
      mediaAccess: shell.mediaAccess(), installedApps: installed.value, storeBilling: shell.storeBilling,
      canDrawOverlays: shell.canDrawOverlays(),
      otherApps: shell.installedPackages().map((p) => ({ package: p.package, label: p.label, allowed: p.allowed ?? null, dailyMinutes: p.dailyMinutes ?? null })),
    },
    config: c && {
      deviceId: c.deviceId, state: c.state, language: c.language, familyLanguage: c.familyLanguage, entitlement: c.entitlement, locked: c.locked,
      apps: c.apps.map((a) => ({ id: a.id, version: a.version, minShell: a.minShell, permissions: a.permissions })), hidden: c.hidden,
      allowlist: c.allowlist, mediaHosts: c.mediaHosts, signInHosts: c.signInHosts?.length ?? 0, travel: c.travel, limits: c.limits,
      otherApps: c.otherApps?.map((a) => ({ package: a.package, allowed: a.allowed, dailyMinutes: a.dailyMinutes, window: a.window, hosts: a.hosts, usedSecondsToday: a.usedSecondsToday })),
      child: c.child ? { grade: c.child.grade, age: c.child.age ?? null, levels: c.child.levels, language: c.child.language ?? null } : null,
      pinSet: !!c.pinHash, serverTime: c.serverTime,
    },
    log: recentEvents(),
    shellLog: shell.shellLog(),
  };
}
