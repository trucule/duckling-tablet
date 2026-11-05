// App requests become tickets in ET Ducky. Status changes come back through POST /hooks/etducky.
// The ticket API contract is small on purpose: ET Ducky needs one create endpoint that accepts this JSON
// and returns { id }, and one outgoing webhook that sends { ticketId, status, message? } signed with
// ETDUCKY_WEBHOOK_SECRET (header x-etducky-signature: hex HMAC-SHA256 of the raw body).
import type { Config } from './config.js';

export interface TicketInput {
  requestId: string; familyId: string; title: string; description: string; childGrade: string | null;
}
export type CreateTicket = (t: TicketInput) => Promise<string | null>;

export function makeEtDucky(cfg: Config, log: (msg: string) => void): CreateTicket {
  return async (t) => {
    if (!cfg.ETDUCKY_API_URL) return null;
    try {
      const r = await fetch(`${cfg.ETDUCKY_API_URL.replace(/\/$/, '')}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ETDUCKY_API_KEY}` },
        body: JSON.stringify({
          type: 'App request', source: 'duckling-tablet', externalId: t.requestId,
          title: `App request: ${t.title}`,
          body: `${t.description}\n\nGrade: ${t.childGrade ?? 'not given'}\nFamily: ${t.familyId}\nRequest: ${t.requestId}`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) { log(`ET Ducky ticket create failed: ${r.status}`); return null; }
      const j = (await r.json()) as { id?: string | number };
      return j.id != null ? String(j.id) : null;
    } catch (e) { log(`ET Ducky ticket create error: ${(e as Error).message}`); return null; }
  };
}
