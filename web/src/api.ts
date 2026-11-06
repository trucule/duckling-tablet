// Calls to api.ducklingtablet.com as the device. A 410 means the family was deleted or the device removed: the shell
// releases the lockdown and the web app returns to pairing.
import { shell } from './shell';

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://api.ducklingtablet.com';

export interface Child { id: string; firstName: string; grade: string | null; levels: Record<string, number>; theme: { colors?: string[]; interests?: string[] } }
export interface InstalledApp { id: string; name: string; version: string; url: string; sha256: string; signature: string; size: number; minShell: string | null; permissions: string[]; tileUrl: string | null }
export interface AllowEntry { host: string; tile?: { name: string; url: string; color?: string } }
export interface DeviceConfig {
  deviceId: string; state: 'active' | 'release' | 'released'; child: Child | null; apps: InstalledApp[]; hidden: string[];
  allowlist: AllowEntry[]; travel: { active: boolean; until: string | null }; limits: Record<string, unknown>; narratorVoice: string; serverTime: string;
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
  checkin: (battery?: number) => call<DeviceConfig>('POST', '/device/checkin', { shellVersion: shell.shellVersion(), ...(battery === undefined ? {} : { battery }) }),
  config: () => call<DeviceConfig>('GET', '/device/config'),
  catalog: () => call<{ apps: CatalogApp[] }>('GET', '/catalog', undefined, false),
  install: (id: string) => call<{ installed: boolean }>('PUT', `/device/apps/${id}`),
  uninstall: (id: string) => call<{ installed: boolean }>('DELETE', `/device/apps/${id}`),
  released: () => call<{ state: string }>('POST', '/device/released'),
};
