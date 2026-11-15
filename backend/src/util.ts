import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const now = () => new Date().toISOString();
export const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
// Expiry for a signed link: the same value for 15 days at a time, and always 30 to 45 days ahead. A link for the same
// file is then the same URL at every check-in, so a tablet or browser keeps the picture it has instead of downloading it
// again (and the home screen does not flash white while it does).
const LINK_STEP = 15 * 86_400_000;
export const linkExpiry = (now = Date.now()) => (Math.floor(now / LINK_STEP) + 3) * LINK_STEP;
export const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hashToken = (token: string, secret: string) => createHmac('sha256', secret).update(token).digest('hex');

// Six digits, easy to read off a phone and type on a tablet.
export const pairingCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (what = 'Forbidden') => new HttpError(403, what);
export const badRequest = (what: string) => new HttpError(400, what);
