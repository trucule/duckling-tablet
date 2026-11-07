// What a family is entitled to right now: the best of its purchases, or the trial, or nothing. Computed on read, so
// a trial that ran out reads as ended without a job. Full use for trial, active and grace; ended and none are told
// to the parent (and, once subscriptions can be bought, make a tablet lift its lockdown).
import type { Q } from './db.js';

export interface Entitlement { status: 'trial' | 'active' | 'grace' | 'ended' | 'none'; source: string | null; periodEnd: string | null; daysLeft: number | null }

const RANK: Record<Entitlement['status'], number> = { active: 4, trial: 3, grace: 2, ended: 1, none: 0 };

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
