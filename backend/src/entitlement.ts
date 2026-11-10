// What a family is entitled to right now: the best of its purchases, or the trial, or nothing. Computed on read, so
// a trial that ran out reads as ended without a job. Full use for trial, active and grace. Ended and none lock the
// tablet: the apps stay installed but greyed and the lockdown stays, the parent area stays open so a parent can
// subscribe, and the server refuses installs, requests, the AI writer and cloud narration (requireSubscribed).
import type { Q } from './db.js';
import { HttpError } from './util.js';

export interface Entitlement { status: 'trial' | 'active' | 'grace' | 'ended' | 'none'; source: string | null; periodEnd: string | null; daysLeft: number | null }

const RANK: Record<Entitlement['status'], number> = { active: 4, trial: 3, grace: 2, ended: 1, none: 0 };

// Whether the family is locked out: the trial ended (or there never was one) and no purchase covers today. Trial,
// active and grace (a payment the store is retrying) are not locked. Decided on the server for every request that
// costs money or delivers content, so a tablet with a stale config cannot keep going past the end.
export const isLocked = (e: Entitlement) => e.status === 'ended' || e.status === 'none';

export class SubscriptionNeeded extends HttpError { constructor() { super(402, 'The free trial has ended. A parent can subscribe in the parent area or the parent portal.'); } }
export async function requireSubscribed(q: Q, familyId: string): Promise<Entitlement> {
  const e = await entitlementOf(q, familyId);
  if (isLocked(e)) throw new SubscriptionNeeded();
  return e;
}

export async function entitlementOf(q: Q, familyId: string): Promise<Entitlement> {
  const row = await q.one<{ status: Entitlement['status']; source: string | null; current_period_end: string | null }>('SELECT status, source, current_period_end FROM entitlement WHERE family_id = $1', [familyId]);
  const purchases = await q.all<{ status: string; period_end: string | null; source: string }>('SELECT status, period_end, source FROM purchase WHERE family_id = $1', [familyId]);
  let best: Entitlement = { status: 'none', source: null, periodEnd: null, daysLeft: null };
  const consider = (status: Entitlement['status'], source: string | null, end: string | null) => {
    const e = { status, source, periodEnd: end, daysLeft: end ? Math.max(0, Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000)) : null };
    if (RANK[e.status] > RANK[best.status]) best = e;
  };
  if (row) {
    const expired = row.current_period_end !== null && new Date(row.current_period_end).getTime() <= Date.now();
    consider(row.status === 'trial' && expired ? 'ended' : row.status, row.source, row.current_period_end);
  }
  for (const p of purchases) {
    const expired = p.period_end !== null && new Date(p.period_end).getTime() <= Date.now();
    const s = (p.status === 'active' && !expired) ? 'active' : p.status === 'grace' ? 'grace' : 'ended';
    consider(s, p.source, p.period_end);
  }
  return best;
}
