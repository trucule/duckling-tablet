// Website tile icons. GET /site-icon/:host returns the icon a site publishes for itself (its apple-touch-icon, or the
// largest icon its home page links, or /favicon.ico), so a website tile on the home screen shows the site's own
// picture. The icon is fetched once and kept in storage at site-icons/<host>; every tablet after that gets the copy.
//
// Only hosts that some family has on a tablet's allowlist are fetched, so the endpoint cannot be used to make the
// server visit an arbitrary site. Fetches go over HTTPS only, to public addresses only (checked when the connection
// is made, so a DNS answer cannot point it inside the network), with a time limit and a size limit.
import type { FastifyInstance } from 'fastify';
import { request } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { Ctx } from '../context.js';

export type Fetched = { status: number; type: string; body: Buffer; location?: string };
export type FetchUrl = (url: string, maxBytes: number) => Promise<Fetched>;

const HOST = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
const MAX_ICON = 512 * 1024, MAX_PAGE = 512 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};

/** True for addresses on the public internet; false for loopback, private, link-local, CGNAT, multicast and the like. */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s.startsWith('::ffff:')) return isPublicAddress(s.slice(7));
    return !(s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9')
      || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff') || s.startsWith('64:ff9b') || s.startsWith('2001:db8'));
  }
  return false;
}

// Resolves like dns.lookup but refuses any answer that is not a public address.
function publicLookup(hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const list = (addrs as LookupAddress[]).filter((a) => isPublicAddress(a.address));
    if (!list.length) return cb(Object.assign(new Error(`${hostname} is not a public address`), { code: 'ENOTPUBLIC' }), '');
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** One HTTPS GET with no redirects followed, a 6-second limit and a size limit. */
export const httpsGet: FetchUrl = (url, maxBytes) => new Promise((resolve, reject) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOST.test(u.hostname)) return reject(new Error('https and a host name only'));
  const req = request(u, { method: 'GET', lookup: publicLookup as never, timeout: 6000,
    headers: { 'user-agent': 'DucklingTablet/1.0 (+https://ducklingtablet.com) site icon', accept: '*/*' } }, (res) => {
    const chunks: Buffer[] = []; let size = 0;
    res.on('data', (c: Buffer) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('too large')); return; } chunks.push(c); });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
      body: Buffer.concat(chunks), location: typeof res.headers.location === 'string' ? res.headers.location : undefined }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', reject);
  req.end();
});

/** GET that follows up to three HTTPS redirects, each one checked again. */
async function follow(fetchUrl: FetchUrl, url: string, maxBytes: number): Promise<Fetched & { url: string }> {
  for (let i = 0; i < 4; i++) {
    const r = await fetchUrl(url, maxBytes);
    if (r.status >= 300 && r.status < 400 && r.location) { url = new URL(r.location, url).toString(); continue; }
    return { ...r, url };
  }
  throw new Error('too many redirects');
}

/** The icon links on a page, best first: apple-touch-icon, then icons by their largest declared size. */
export function iconLinks(html: string, base: string): string[] {
  const found: { href: string; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => (new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag) ?? []).slice(2).find((x) => x !== undefined);
    const rel = (attr('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr('href');
    if (!href || !(rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'))) continue;
    let abs: string;
    try { abs = new URL(href.replace(/&amp;/g, '&'), base).toString(); } catch { continue; }
    if (!abs.startsWith('https://')) continue;
    const sizes = (attr('sizes') ?? '').toLowerCase();
    const px = sizes === 'any' ? 256 : Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
    const touch = rel.some((r) => r.startsWith('apple-touch-icon'));
    found.push({ href: abs, score: (touch ? 1000 : 0) + (px || (touch ? 180 : 16)) });
  }
  return [...new Set(found.sort((a, b) => b.score - a.score).map((f) => f.href))];
}

/** Finds and downloads the site's icon; null when it has none that is an image. */
export async function findIcon(fetchUrl: FetchUrl, host: string): Promise<{ type: string; body: Buffer } | null> {
  const home = `https://${host}/`;
  const candidates: string[] = [];
  try {
    const page = await follow(fetchUrl, home, MAX_PAGE);
    if (page.status === 200 && page.type.includes('html')) candidates.push(...iconLinks(page.body.toString('utf8'), page.url));
  } catch { /* no home page: the well-known paths below may still answer */ }
  candidates.push(`${home}apple-touch-icon.png`, `${home}favicon.ico`);
  for (const url of candidates.slice(0, 6)) {
    try {
      const r = await follow(fetchUrl, url, MAX_ICON);
      const type = r.type === 'image/vnd.microsoft.icon' ? 'image/x-icon' : r.type;
      if (r.status === 200 && IMAGE_TYPES[type] && r.body.length >= 32) return { type, body: r.body };
    } catch { /* try the next one */ }
  }
  return null;
}

export default async function siteIconRoutes(app: FastifyInstance, opts: { ctx: Ctx; fetchUrl?: FetchUrl }) {
  const { ctx } = opts;
  const fetchUrl = opts.fetchUrl ?? httpsGet;
  const inflight = new Map<string, Promise<{ type: string; body: Buffer } | null>>();
  const misses = new Map<string, number>(); // host -> time of the last failed look, retried after 6 hours

  async function allowedSomewhere(host: string): Promise<boolean> {
    const rows = await ctx.db.system((q) => q.all(
      `SELECT 1 FROM setting WHERE key = 'allowlist' AND (value @> $1::jsonb OR value @> $2::jsonb) LIMIT 1`,
      [JSON.stringify([{ host }]), JSON.stringify([{ host: `*.${host}` }])]));
    return rows.length > 0;
  }

  async function load(host: string): Promise<{ type: string; body: Buffer } | null> {
    for (const [ext, type] of [['png', 'image/png'], ['ico', 'image/x-icon'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['svg', 'image/svg+xml'], ['gif', 'image/gif']]) {
      const body = await ctx.storage.get(`site-icons/${host}.${ext}`);
      if (body) return { type, body };
    }
    const missed = misses.get(host);
    if (missed && Date.now() - missed < 6 * 3600_000) return null;
    if (!(await allowedSomewhere(host))) return null;
    let p = inflight.get(host);
    if (!p) {
      p = findIcon(fetchUrl, host).then(async (icon) => {
        if (icon) await ctx.storage.put(`site-icons/${host}.${IMAGE_TYPES[icon.type]}`, icon.body, icon.type, false);
        else misses.set(host, Date.now());
        return icon;
      }).finally(() => inflight.delete(host));
      inflight.set(host, p);
    }
    return p;
  }

  app.get<{ Params: { host: string } }>('/site-icon/:host', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const host = req.params.host.toLowerCase().replace(/^\*\./, '');
    if (!HOST.test(host) || host.length > 253) return reply.code(404).send();
    const icon = await load(host);
    if (!icon) return reply.code(404).header('cache-control', 'public, max-age=3600').send();
    // An SVG icon is shown in an <img>, where its scripts never run; the policy header covers a direct visit too.
    return reply.header('content-type', icon.type).header('cache-control', 'public, max-age=604800')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").header('x-content-type-options', 'nosniff').send(icon.body);
  });
}
