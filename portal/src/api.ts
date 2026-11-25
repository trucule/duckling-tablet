// Parent calls to the API with the session token from the email link (kept in localStorage; the API also sets a
// cookie, but the portal and the API are on different hosts so the bearer header is what counts).
import { tr, lang, type Lang } from './i18n';
import type { Provider } from './providers';
export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://api.ducklingtablet.com';

export interface Child { id: string; firstName: string; grade: string | null; age?: number | null; levels: Record<string, number>; theme: { colors?: string[]; interests?: string[] }; stars?: { earned: number; spent: number; balance: number }; portraitUrl?: string | null; language?: Lang | null }
export interface Device { id: string; childId: string | null; platform: string; name: string; state: string; shellVersion: string | null; battery: number | null; lastSeenAt: string | null }
export interface Attachment { id: string; requestId: string; contentType: string; size: number; url: string; createdAt: string }
export interface AppRequest { id: string; title: string; description: string; childGrade: string | null; installWhenReady: boolean; status: string; appId: string | null; createdAt: string; updatedAt: string; attachments: Attachment[] }
export interface Entitlement { status: 'trial' | 'active' | 'grace' | 'ended' | 'none'; source: string | null; periodEnd: string | null; daysLeft: number | null }
export interface Family { familyId: string; you: string; language?: Lang; pinSet: boolean; subscription: Entitlement; cardPayments?: boolean; cardCustomer?: boolean; stats?: boolean; parents: { id: string; email: string; role: string }[]; children: Child[]; devices: Device[] }
export interface OtherApp { package: string; label: string; icon: string | null; allowed: boolean; dailyMinutes: number | null; window: { start: string; end: string } | null; hosts: string[]; usedSecondsToday: number }
export interface DeviceDetail { deviceId: string; state: string; child: Child | null; apps: { id: string; name: string; version: string; tileUrl: string | null }[]; hidden: string[]; allowlist: { host: string; tile?: { name: string; url: string } }[]; travel: { active: boolean; until: string | null }; otherApps: OtherApp[] }
// A host an allowed website asked for and the tablet refused, filed under that website, with a parent's decision.
export interface SiteHost { site: string; host: string; media: boolean; hits: number; tracker: boolean; refusal: string | null; decision: 'allowed' | 'blocked' | null; firstSeenAt: string; lastSeenAt: string }
export interface AppAbout { concept: string; progression: string; lifeSkills: string[] }
// The name, description and About text in another language, by language code, from the app's manifest (apps.ts reads them).
export type AppI18n = Partial<Record<'en' | 'es', { name: string; description?: string; about?: AppAbout | null }>>;
export interface CatalogApp { id: string; name: string; tileUrl: string | null; description: string; demoUrl: string | null; subjects: string[]; ageMin: number | null; ageMax: number | null; starter: boolean; about: AppAbout | null; i18n?: AppI18n | null }

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export const session = {
  get: () => { try { return localStorage.getItem('duckling.session') ?? ''; } catch { return ''; } },
  set: (t: string) => { try { t ? localStorage.setItem('duckling.session', t) : localStorage.removeItem('duckling.session'); } catch {} },
};

// The server's reason for a refusal; for a refused form it is the first field's own message ("Use a site name like
// pbskids.org") in place of "Invalid request".
function reason(json: { error?: string; issues?: string[] }): string | undefined {
  const issue = json.issues?.[0];
  if (issue) { const msg = issue.slice(issue.indexOf(': ') + 2); if (msg) return msg; }
  return json.error;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session.get()) headers.authorization = `Bearer ${session.get()}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (r.status === 401) session.set('');
  if (!r.ok) throw new ApiError(r.status, tr(reason(json) ?? r.statusText));
  return json as T;
}

// The owner's accounts list (GET /stats/accounts): each family's parents, subscription and tablets. Nothing about children.
export interface Account {
  familyId: string; createdAt: string | null; language: string;
  subscription: { status: string; source: string; periodEnd: string | null };
  parents: { email: string; role: string; lastSignIn: string | null }[];
  tablets: { platform: string; version: string; lastSeen: string | null }[];
  minutes30: number;
}

// The owner's stats (GET /stats): counts across every family, no names.
// Trial to paid: families whose trial is over, those that subscribed in a store, and those paying now.
export interface Funnel { trials: number; over: number; subscribed: number; paying: number }
export interface Stats {
  at: string; trialDays: number;
  families: { total: number; new7: number; new30: number; withTablet: number; spanish: number };
  children: { total: number; spanish: number; portraits: number };
  tablets: { total: number; seen1: number; seen7: number; seen30: number; new7: number; new30: number;
    platforms: { platform: string; total: number; seen7: number }[]; shells: { platform: string; version: string; n: number }[] };
  subscriptions: { byStatus: { status: string; source: string; n: number }[]; trialEnded: number; paying: number; trialsEnding7: number;
    conversion?: Funnel & { byMonth: (Funnel & { key: string })[]; byPlatform: (Funnel & { key: string })[]; byStore: (Funnel & { key: string })[] } };
  apps: { id: string; name: string; installs: number; opens7: number; minutes7: number; tablets7: number; opens30: number; minutes30: number; stars: number; ai30: number }[];
  days: { day: string; families: number; tablets: number; active: number; minutes: number }[];
  levels: { subject: string; grade: number; n: number }[];
  requests: { byStatus: { status: string; n: number }[]; new30: number };
  voice: { clips: number; chars: number; hits: number; clips30: number; chars30: number; charsAsked30: number; byLanguage: { lang: string; clips: number; hits: number }[] };
  ai: { calls30: number; inputTokens30: number; outputTokens30: number };
  otherApps: { label: string; families: number; minutes30: number }[];
}

// A parent's ways to sign in: their email, and the Apple, Google or Microsoft accounts linked to them.
export interface SignIns { email: string | null; linked: { provider: Provider; email: string | null; linkedAt: string }[]; available: Provider[] }

export const api = {
  stats: () => call<Stats>('GET', '/stats'),
  statsAccounts: () => call<{ at: string; accounts: Account[] }>('GET', '/stats/accounts'),
  emailLink: (email: string, delivery: 'link' | 'code' = 'link') => call<{ sent: boolean; delivery: 'link' | 'code' }>('POST', '/auth/email-link', { email, delivery, language: lang.value }),
  verifyCode: (email: string, code: string) => call<{ sessionToken: string; newFamily: boolean }>('POST', '/auth/code/verify', { email, code, language: lang.value }),
  verify: (token: string) => call<{ sessionToken: string; newFamily: boolean }>('POST', '/auth/verify', { token, language: lang.value }),
  signInProviders: () => call<{ providers: { provider: Provider; clientIds: string[] }[] }>('GET', '/auth/providers'),
  signInNonce: () => call<{ nonce: string }>('GET', '/auth/nonce'),
  providerSignIn: (provider: Provider, idToken: string, nonce: string) => call<{ sessionToken: string; newFamily: boolean }>('POST', '/auth/provider', { provider, idToken, nonce, language: lang.value }),
  signIns: () => call<SignIns>('GET', '/family/sign-ins'),
  linkSignIn: (provider: Provider, idToken: string, nonce: string) => call<SignIns>('POST', '/family/sign-ins', { provider, idToken, nonce }),
  unlinkSignIn: (provider: Provider) => call<SignIns>('DELETE', `/family/sign-ins/${provider}`),
  logout: () => call('POST', '/auth/logout', {}),
  family: () => call<Family>('GET', '/family'),
  // The family's language: emails, the portal, and every tablet whose child has no language of their own.
  setLanguage: (language: Lang) => call<{ language: Lang }>('PUT', '/family/language', { language }),
  // Card payments through Stripe: a Checkout page to subscribe, the Customer Portal to manage.
  stripeCheckout: () => call<{ url: string; trialEnd: string | null }>('POST', '/billing/stripe/checkout', {}),
  stripePortal: () => call<{ url: string }>('POST', '/billing/stripe/portal', {}),
  addChild: (b: { firstName: string; grade?: string | null; age?: number; startGrade?: number; levels?: Record<string, number>; theme?: Child['theme'] }) => call<Child>('POST', '/children', b),
  updateChild: (id: string, b: Partial<{ firstName: string; grade: string | null; age: number; startGrade: number; levels: Record<string, number>; theme: Child['theme']; language: Lang | null }>) => call<Child>('PUT', `/children/${id}`, b),
  deleteChild: (id: string) => call('DELETE', `/children/${id}`),
  pairingCode: (childId: string | null) => call<{ code: string; expiresInMinutes: number }>('POST', '/devices/pairing-codes', { childId }),
  device: (id: string) => call<DeviceDetail>('GET', `/devices/${id}`),
  renameDevice: (id: string, b: { name?: string; childId?: string | null }) => call<DeviceDetail>('PUT', `/devices/${id}`, b),
  releaseDevice: (id: string) => call('POST', `/devices/${id}/release`, {}),
  removeDevice: (id: string) => call('DELETE', `/devices/${id}`),
  hideApp: (id: string, app: string, hidden: boolean) => call(hidden ? 'PUT' : 'DELETE', `/devices/${id}/hidden/${app}`, hidden ? {} : undefined),
  installApp: (id: string, app: string) => call('PUT', `/devices/${id}/apps/${app}`, {}),
  siteHosts: (id: string) => call<{ siteHosts: SiteHost[] }>('GET', `/devices/${id}/site-hosts`),
  decideSiteHost: (id: string, site: string, host: string, decision: SiteHost['decision']) => call<{ siteHosts: SiteHost[] }>('PUT', `/devices/${id}/site-hosts`, { site, host, decision }),
  settings: (id: string, b: { allowlist?: { host: string; tile?: { name: string; url: string } }[] }) => call<DeviceDetail>('PUT', `/devices/${id}/settings`, b),
  travel: (id: string, minutes: number) => call('POST', `/devices/${id}/travel`, { minutes }),
  otherApp: (id: string, pkg: string, b: { allowed?: boolean; dailyMinutes?: number | null; window?: { start: string; end: string } | null; hosts?: string[] }) => call('PUT', `/devices/${id}/other-apps/${encodeURIComponent(pkg)}`, b),
  catalog: () => call<{ apps: CatalogApp[] }>('GET', '/catalog'),
  setPin: (pin: string) => call<{ set: boolean }>('PUT', '/family/pin', { pin }),
  inviteParent: (email: string) => call<{ sent: boolean }>('POST', '/family/parents/invite', { email }),
  removeParent: (id: string) => call('DELETE', `/family/parents/${id}`),
  requests: () => call<{ requests: AppRequest[] }>('GET', '/requests'),
  withdrawRequest: (id: string) => call<AppRequest>('POST', `/requests/${id}/withdraw`),
  createRequest: (b: { title: string; description: string; childGrade?: string | null; installWhenReady: boolean }) => call<AppRequest>('POST', '/requests', b),
  // A picture goes up as its own bytes with the image content type.
  attach: async (requestId: string, file: File): Promise<Attachment> => {
    const r = await fetch(`${API}/requests/${requestId}/attachments`, { method: 'POST', headers: { 'content-type': file.type || 'image/jpeg', authorization: `Bearer ${session.get()}` }, body: file });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, tr(reason(json) ?? r.statusText));
    return json as Attachment;
  },
  // Pictures are private: fetched with the session and shown from a blob URL.
  picture: async (url: string): Promise<string> => {
    const r = await fetch(url, { headers: { authorization: `Bearer ${session.get()}` } });
    if (!r.ok) throw new ApiError(r.status, tr('Picture unavailable'));
    return URL.createObjectURL(await r.blob());
  },
  deleteFamily: () => call('DELETE', '/family', { confirm: 'DELETE' }),
};
