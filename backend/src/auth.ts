// Three kinds of caller: a parent (session cookie or bearer), a device (Device token), and the admin (you).
// Parent and device lookups happen before the family is known, so they go through SECURITY DEFINER functions.
import type { FastifyRequest } from 'fastify';
import type { Ctx } from './context.js';
import { HttpError, hashToken, safeEqual } from './util.js';

export const SESSION_COOKIE = 'dt_session';

export interface ParentAuth { parentId: string; familyId: string; email: string; }
export interface DeviceAuth { deviceId: string; familyId: string; childId: string | null; state: string; }

function bearer(req: FastifyRequest, scheme: string): string | null {
  const h = req.headers.authorization ?? '';
  const [s, v] = h.split(' ');
  return s?.toLowerCase() === scheme.toLowerCase() && v ? v : null;
}

export function sessionToken(req: FastifyRequest): string | null {
  return bearer(req, 'Bearer') ?? req.cookies?.[SESSION_COOKIE] ?? null;
}

export async function parentAuth(ctx: Ctx, req: FastifyRequest): Promise<ParentAuth> {
  const token = sessionToken(req);
  if (!token) throw new HttpError(401, 'Sign in required');
  const [row] = await ctx.db.query<{ parent_id: string; family_id: string; email: string }>(
    'SELECT parent_id, family_id, email FROM auth_session($1)', [hashToken(token, ctx.cfg.SESSION_SECRET)]);
  if (!row) throw new HttpError(401, 'Session expired');
  return { parentId: row.parent_id, familyId: row.family_id, email: row.email };
}

export async function deviceAuth(ctx: Ctx, req: FastifyRequest): Promise<DeviceAuth> {
  const token = bearer(req, 'Device');
  if (!token) throw new HttpError(401, 'Device token required');
  const [row] = await ctx.db.query<{ device_id: string | null; family_id: string; child_id: string | null; state: string; released: boolean }>(
    'SELECT device_id, family_id, child_id, state, released FROM auth_device($1)', [hashToken(token, ctx.cfg.SESSION_SECRET)]);
  if (!row) throw new HttpError(401, 'Unknown device');
  // A device whose family was deleted is told to release itself, once.
  if (row.released || !row.device_id) throw new HttpError(410, 'release');
  return { deviceId: row.device_id, familyId: row.family_id, childId: row.child_id, state: row.state };
}

export function adminAuth(ctx: Ctx, req: FastifyRequest): void {
  const token = bearer(req, 'Bearer');
  if (!ctx.cfg.ADMIN_TOKEN || !token || !safeEqual(token, ctx.cfg.ADMIN_TOKEN)) throw new HttpError(401, 'Admin token required');
}
