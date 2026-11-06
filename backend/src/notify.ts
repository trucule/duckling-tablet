// After a parent changes something, the tablets concerned get a push so they check in now instead of at the next
// three-hourly check-in. One device, or every device in the family (a child's profile, the PIN). Never awaited by a
// request: a push that fails only delays the change until the next check-in.
import type { Ctx } from './context.js';

export async function notifyDevices(ctx: Ctx, familyId: string, deviceId?: string): Promise<void> {
  try {
    const rows = await ctx.db.family(familyId, (q) => q.all<{ id: string; push_token: string }>(
      `SELECT id, push_token FROM device WHERE push_token IS NOT NULL AND state <> 'released'${deviceId ? ' AND id = $1' : ''}`, deviceId ? [deviceId] : []));
    if (!rows.length) return;
    const { dead } = await ctx.push(rows.map((r) => r.push_token), { type: 'config-changed' });
    if (dead.length) await ctx.db.family(familyId, (q) => q.run('UPDATE device SET push_token = NULL WHERE push_token = ANY($1)', [dead]));
  } catch (e) { ctx.log(`push failed: ${(e as Error).message}`); }
}

// Wraps a handler's result: when it resolves, the push goes out and the result is returned unchanged.
export function after<T>(ctx: Ctx, familyId: string, deviceId: string | undefined, work: Promise<T>): Promise<T> {
  return work.then((r) => { void notifyDevices(ctx, familyId, deviceId); return r; });
}
