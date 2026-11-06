// Parent calls to the API with the session token from the email link (kept in localStorage; the API also sets a
// cookie, but the portal and the API are on different hosts so the bearer header is what counts).
export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://api.ducklingtablet.com';

export interface Child { id: string; firstName: string; grade: string | null; levels: Record<string, number>; theme: { colors?: string[]; interests?: string[] } }
export interface Device { id: string; childId: string | null; platform: string; name: string; state: string; shellVersion: string | null; battery: number | null; lastSeenAt: string | null }
export interface Family { familyId: string; you: string; parents: { id: string; email: string; role: string }[]; children: Child[]; devices: Device[] }
export interface DeviceDetail { deviceId: string; state: string; child: Child | null; apps: { id: string; name: string; version: string; tileUrl: string | null }[]; hidden: string[]; allowlist: { host: string; tile?: { name: string; url: string } }[]; travel: { active: boolean; until: string | null } }
export interface CatalogApp { id: string; name: string; tileUrl: string | null; description: string }

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export const session = {
  get: () => { try { return localStorage.getItem('duckling.session') ?? ''; } catch { return ''; } },
  set: (t: string) => { try { t ? localStorage.setItem('duckling.session', t) : localStorage.removeItem('duckling.session'); } catch {} },
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session.get()) headers.authorization = `Bearer ${session.get()}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (r.status === 401) session.set('');
  if (!r.ok) throw new ApiError(r.status, json.error ?? r.statusText);
  return json as T;
}

export const api = {
  emailLink: (email: string) => call<{ sent: boolean }>('POST', '/auth/email-link', { email }),
  verify: (token: string) => call<{ sessionToken: string; newFamily: boolean }>('POST', '/auth/verify', { token }),
  logout: () => call('POST', '/auth/logout', {}),
  family: () => call<Family>('GET', '/family'),
  addChild: (b: { firstName: string; grade?: string | null; theme?: Child['theme'] }) => call<Child>('POST', '/children', b),
  updateChild: (id: string, b: Partial<{ firstName: string; grade: string | null; theme: Child['theme'] }>) => call<Child>('PUT', `/children/${id}`, b),
  deleteChild: (id: string) => call('DELETE', `/children/${id}`),
  pairingCode: (childId: string | null) => call<{ code: string; expiresInMinutes: number }>('POST', '/devices/pairing-codes', { childId }),
  device: (id: string) => call<DeviceDetail>('GET', `/devices/${id}`),
  renameDevice: (id: string, b: { name?: string; childId?: string | null }) => call<DeviceDetail>('PUT', `/devices/${id}`, b),
  releaseDevice: (id: string) => call('POST', `/devices/${id}/release`, {}),
  hideApp: (id: string, app: string, hidden: boolean) => call(hidden ? 'PUT' : 'DELETE', `/devices/${id}/hidden/${app}`, hidden ? {} : undefined),
  installApp: (id: string, app: string) => call('PUT', `/devices/${id}/apps/${app}`, {}),
  settings: (id: string, b: { allowlist?: { host: string; tile?: { name: string; url: string } }[] }) => call<DeviceDetail>('PUT', `/devices/${id}/settings`, b),
  travel: (id: string, hours: number) => call('POST', `/devices/${id}/travel`, { hours }),
  catalog: () => call<{ apps: CatalogApp[] }>('GET', '/catalog'),
  deleteFamily: () => call('DELETE', '/family', { confirm: 'DELETE' }),
};
