// Calls to api.ducklingtablet.com as the device. A 410 means the family was deleted or the device removed: the shell
// releases the lockdown and the web app returns to pairing.
import { shell } from './shell';

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://api.ducklingtablet.com';

export interface Child { id: string; firstName: string; grade: string | null; age?: number | null; levels: Record<string, number>; theme: { colors?: string[]; interests?: string[] }; portraitUrl?: string | null; stars?: { earned: number; spent: number; balance: number } }
export interface InstalledApp { id: string; name: string; version: string; url: string; sha256: string; signature: string; size: number; minShell: string | null; permissions: string[]; tileUrl: string | null }
export interface AllowEntry { host: string; tile?: { name: string; url: string; color?: string } }
export interface Entitlement { status: 'trial' | 'active' | 'grace' | 'ended' | 'none'; source: string | null; periodEnd: string | null; daysLeft: number | null }

export interface OtherApp { package: string; label: string; icon: string | null; allowed: boolean; dailyMinutes: number | null; window: { start: string; end: string } | null; hosts: string[]; usedSecondsToday: number }

export interface DeviceConfig {
  entitlement?: Entitlement;
  otherApps?: OtherApp[];
  deviceId: string; state: 'active' | 'release' | 'released'; child: Child | null; apps: InstalledApp[]; hidden: string[];
  allowlist: AllowEntry[]; travel: { active: boolean; until: string | null }; limits: Record<string, unknown>; narratorVoice: string; pinHash: string | null; serverTime: string; appAccountToken?: string | null;
}
export interface CatalogApp {
  id: string; name: string; description: string; subjects: string[]; ageMin: number | null; ageMax: number | null; starter: boolean; tileUrl: string | null;
  latest: { version: string; url: string; sha256: string; signature: string; size: number; minShell: string | null; permissions: string[] };
}

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export class ReleasedError extends Error {}

async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const token = shell.getDeviceToken();
    if (!token) throw new ApiError(401, 'Not paired');
    headers.authorization = `Device ${token}`;
  }
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 410) throw new ReleasedError('released');
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) throw new ApiError(r.status, json.error ?? r.statusText);
  return json as T;
}

export const api = {
  // A parent setting up from the tablet: the email tells them to finish on their phone.
  emailLink: (email: string, source: 'tablet' | 'portal' = 'portal') => call<{ sent: boolean }>('POST', '/auth/email-link', { email, source }, false),
  pair: (code: string, name: string) => call<{ deviceId: string; deviceToken: string; config: DeviceConfig }>(
    'POST', '/devices/pair', { code, platform: shell.platform === 'web' ? 'web' : shell.platform, name, shellVersion: shell.shellVersion() }, false),
  // One-device signup: a code by email, then the family, the child and this tablet in one call.
  requestCode: (email: string) => call<{ sent: boolean }>('POST', '/auth/code', { email }, false),
  pairWithCode: (email: string, code: string, childFirstName: string | undefined, childAge: number | undefined, name: string) => call<{ deviceId: string; deviceToken: string; newFamily: boolean; config: DeviceConfig }>(
    'POST', '/auth/code/pair', { email, code, childFirstName, childAge, platform: shell.platform === 'web' ? 'web' : shell.platform, name, shellVersion: shell.shellVersion() }, false),
  checkin: (battery?: number) => call<DeviceConfig>('POST', '/device/checkin', { shellVersion: shell.shellVersion(), ...(shell.pushToken() ? { pushToken: shell.pushToken() } : {}), ...(battery === undefined ? {} : { battery }) }),
  config: () => call<DeviceConfig>('GET', '/device/config'),
  reportInstalled: (apps: { package: string; label: string; icon?: string }[]) => call<{ otherApps: OtherApp[] }>('POST', '/device/apps-installed', { apps }),
  otherAppUsage: (pkg: string, seconds: number, day: string) => call<{ otherApps: OtherApp[] }>('POST', '/device/other-app-usage', { package: pkg, seconds, day }),
  catalog: () => call<{ apps: CatalogApp[] }>('GET', '/catalog', undefined, false),
  install: (id: string) => call<{ installed: boolean }>('PUT', `/device/apps/${id}`),
  uninstall: (id: string) => call<{ installed: boolean }>('DELETE', `/device/apps/${id}`),
  released: () => call<{ state: string }>('POST', '/device/released'),
  setPin: (pin: string) => call<{ set: boolean }>('PUT', '/device/pin', { pin }),
};
