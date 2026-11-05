// Three kinds of caller: a parent (session cookie or bearer), a device (Device token), and the admin (you).
import type { FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { HttpError, hashToken, now, safeEqual } from './util.js';

export const SESSION_COOKIE = 'dt_session';

export interface ParentAuth { parentId: string; familyId: string; email: string; }
export interface DeviceAuth { deviceId: string; familyId: string; childId: string | null; state: string; }

function bearer(req: FastifyRequest, scheme: string): string | null {
  const h = req.headers.authorization ?? '';
  const [s, v] = h.split(' ');
  return s?.toLowerCase() === scheme.toLowerCase() && v ? v : null;
}

export function parentAuth(ctx: Ctx, req: FastifyRequest): ParentAuth {
  const token = bearer(req, 'Bearer') ?? req.cookies?.[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'Sign in required');
  const row = ctx.db.prepare(`SELECT p.id, p.family_id, p.email, s.expires_at FROM session s JOIN parent p ON p.id = s.parent_id
    WHERE s.token_hash = ?`).get(hashToken(token, ctx.cfg.SESSION_SECRET)) as { id: string; family_id: string; email: string; expires_at: string } | undefined;
  if (!row || row.expires_at < now()) throw new HttpError(401, 'Session expired');
  return { parentId: row.id, familyId: row.family_id, email: row.email };
}

export function deviceAuth(ctx: Ctx, req: FastifyRequest): DeviceAuth {
  const token = bearer(req, 'Device');
  if (!token) throw new HttpError(401, 'Device token required');
  const hash = hashToken(token, ctx.cfg.SESSION_SECRET);
  const row = ctx.db.prepare('SELECT id, family_id, child_id, state FROM device WHERE token_hash = ?').get(hash) as
    { id: string; family_id: string; child_id: string | null; state: string } | undefined;
  if (!row) {
    // A device whose family was deleted is told to release itself, once.
    if (ctx.db.prepare('SELECT 1 FROM device_tombstone WHERE token_hash = ?').get(hash)) throw new HttpError(410, 'release');
    throw new HttpError(401, 'Unknown device');
  }
  return { deviceId: row.id, familyId: row.family_id, childId: row.child_id, state: row.state };
}

export function adminAuth(ctx: Ctx, req: FastifyRequest): void {
  const token = bearer(req, 'Bearer');
  if (!ctx.cfg.ADMIN_TOKEN || !token || !safeEqual(token, ctx.cfg.ADMIN_TOKEN)) throw new HttpError(401, 'Admin token required');
}
