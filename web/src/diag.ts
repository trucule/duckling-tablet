// The tablet's own event log for diagnostics reports: script errors, failed server calls, failed installs, and the
// shell's messages. Kept on the tablet (the last 150), and sent only when a parent presses Send diagnostics. Messages
// are cut short and carry no tokens: server calls are logged by method, path and status.
export interface LogEntry { at: string; kind: 'error' | 'rejection' | 'api' | 'install' | 'note'; message: string }

const KEY = 'duckling:log';
const MAX = 150;
let entries: LogEntry[] = (() => { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })();
let saving = 0;

const clean = (s: string) => s.replace(/(Device|Bearer)\s+[\w.-]+/g, '$1 [token]').replace(/([?&](token|sig|code)=)[^&\s]+/gi, '$1[hidden]').slice(0, 500);

export function logEvent(kind: LogEntry['kind'], message: string) {
  entries.push({ at: new Date().toISOString(), kind, message: clean(String(message)) });
  if (entries.length > MAX) entries = entries.slice(-MAX);
  // Saved a moment later, so a burst of errors is one write.
  if (!saving) saving = window.setTimeout(() => { saving = 0; try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage full or off */ } }, 500);
}

export const recentEvents = (): LogEntry[] => entries.slice();

window.addEventListener('error', (e) => {
  // A resource that failed to load (an image) has no message; only script errors are logged.
  if (!e.message) return;
  logEvent('error', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as Error | undefined;
  logEvent('rejection', r?.stack?.split('\n').slice(0, 3).join(' | ') || String(r));
});
