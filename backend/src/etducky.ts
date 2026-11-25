// App requests and diagnostics reports become tickets in ET Ducky. Status changes come back through POST /hooks/etducky.
// The ticket API contract is small on purpose: ET Ducky needs one create endpoint that accepts this JSON and returns
// { id }, an attachments endpoint, and an outgoing webhook sending { ticketId, status, eventId? } with the shared
// secret as a bearer token (or an HMAC-SHA256 signature in x-etducky-signature). The full contract is in
// D:\Ducking_Docs\ET-Ducky-App-Request-Tickets-Spec.md.
import type { Config } from './config.js';
import { redactText } from './logging.js';

// An app request from a parent, or a diagnostics report sent from a tablet's parent area.
export type TicketInput =
  | { kind?: 'request'; requestId: string; familyId: string; title: string; description: string; childGrade: string | null }
  | { kind: 'diagnostics'; reportId: string; familyId: string; title: string; body: string };
export type CreateTicket = (t: TicketInput) => Promise<string | null>;
// A picture the parent attached after the ticket was made: POST /tickets/:id/attachments { url, contentType }.
// The url is a signed Duckling link that works for 30 days. Nothing is retried; the picture stays visible in the portal.
export type AttachToTicket = (ticketId: string, url: string, contentType: string) => Promise<boolean>;

export function makeEtDuckyAttach(cfg: Config, log: (msg: string) => void): AttachToTicket {
  return async (ticketId, url, contentType) => {
    if (!cfg.ETDUCKY_API_URL) return false;
    try {
      const r = await fetch(`${cfg.ETDUCKY_API_URL.replace(/\/$/, '')}/tickets/${encodeURIComponent(ticketId)}/attachments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ETDUCKY_API_KEY}` },
        body: JSON.stringify({ url, contentType }), signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) log(`ET Ducky attach failed: ${r.status}`);
      return r.ok;
    } catch (e) { log(`ET Ducky attach error: ${redactText((e as Error).message)}`); return false; }
  };
}

export function makeEtDucky(cfg: Config, log: (msg: string) => void): CreateTicket {
  return async (t) => {
    if (!cfg.ETDUCKY_API_URL) return null;
    try {
      const r = await fetch(`${cfg.ETDUCKY_API_URL.replace(/\/$/, '')}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ETDUCKY_API_KEY}` },
        body: JSON.stringify(t.kind === 'diagnostics'
          ? { type: 'Diagnostics', source: 'duckling-tablet', externalId: t.reportId, title: t.title.slice(0, 200), body: t.body.slice(0, 10_000) }
          : {
            type: 'App request', source: 'duckling-tablet', externalId: t.requestId,
            title: `App request: ${t.title}`,
            body: `${t.description}\n\nGrade: ${t.childGrade ?? 'not given'}\nFamily: ${t.familyId}\nRequest: ${t.requestId}`,
          }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) { log(`ET Ducky ticket create failed: ${r.status}`); return null; }
      const j = (await r.json()) as { id?: string | number };
      return j.id != null ? String(j.id) : null;
    } catch (e) { log(`ET Ducky ticket create error: ${redactText((e as Error).message)}`); return null; }
  };
}
