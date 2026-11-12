// Parents request new apps; each request becomes an ET Ducky ticket, and ticket status flows back here.
import type { FastifyInstance } from 'fastify';
import { requireSubscribed } from '../entitlement.js';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { deviceAuth, parentAuth } from '../auth.js';
import { HttpError, hashToken, newId, notFound, safeEqual, sha256 } from '../util.js';
import { firstDelivery } from '../webhooks.js';

const OPEN = ['requested', 'planned', 'building'];
export const requestRow = (r: any) => r && ({
  id: r.id, title: r.title, description: r.description, childGrade: r.child_grade, installWhenReady: r.install_when_ready,
  status: r.status, appId: r.app_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
const MAX_ATTACHMENT = 10 * 1024 * 1024, MAX_PER_REQUEST = 5;

// Pictures are private in storage. Parents read them with their session; ET Ducky gets a signed link (30 days).
const attachmentPath = (requestId: string, attId: string) => `/requests/${requestId}/attachments/${attId}`;
const signFor = (ctx: Ctx, requestId: string, attId: string, exp: number) => hashToken(`${requestId}/${attId}/${exp}`, ctx.cfg.SESSION_SECRET).slice(0, 32);
const signedUrlFor = (ctx: Ctx, requestId: string, attId: string) => { const exp = Date.now() + 30 * 86_400_000; return `${ctx.cfg.PUBLIC_URL}${attachmentPath(requestId, attId)}?exp=${exp}&sig=${signFor(ctx, requestId, attId, exp)}`; };

/** Opens the ET Ducky ticket for every open request that has none: a request made while ET Ducky was not configured,
 * unreachable or refusing gets its ticket here, with its pictures. ET Ducky returns the existing ticket for a repeated
 * request id, so a retry never makes a second one. Runs every 10 minutes and from POST /admin/requests/tickets. */
export async function sendMissingTickets(ctx: Ctx): Promise<{ configured: boolean; waiting: number; created: number }> {
  const configured = !!ctx.cfg.ETDUCKY_API_URL;
  const rows = await ctx.db.system((q) => q.all<{ id: string; family_id: string; title: string; description: string; child_grade: string | null }>(
    'SELECT id, family_id, title, description, child_grade FROM app_request WHERE etducky_ticket_id IS NULL AND status = ANY($1) ORDER BY created_at LIMIT 50', [OPEN]));
  let created = 0;
  for (const r of rows) {
    const ticket = await ctx.createTicket({ requestId: r.id, familyId: r.family_id, title: r.title, description: r.description, childGrade: r.child_grade });
    if (!ticket) continue;
    const atts = await ctx.db.system(async (q) => {
      await q.run('UPDATE app_request SET etducky_ticket_id = $1 WHERE id = $2 AND etducky_ticket_id IS NULL', [ticket, r.id]);
      return q.all<{ id: string; content_type: string }>('SELECT id, content_type FROM request_attachment WHERE request_id = $1 ORDER BY created_at', [r.id]);
    });
    for (const att of atts) await ctx.attachToTicket(ticket, signedUrlFor(ctx, r.id, att.id), att.content_type);
    created++;
  }
  if (rows.length) ctx.log(`ET Ducky tickets: ${created} of ${rows.length} waiting requests sent${configured ? '' : ' (ETDUCKY_API_URL is not set)'}`);
  return { configured, waiting: rows.length - created, created };
}

export default async function requestRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const sign = (requestId: string, attId: string, exp: number) => signFor(ctx, requestId, attId, exp);
  const signedUrl = (requestId: string, attId: string) => signedUrlFor(ctx, requestId, attId);
  const attachmentRow = (r: any) => ({ id: r.id, requestId: r.request_id, contentType: r.content_type, size: Number(r.size), url: `${ctx.cfg.PUBLIC_URL}${attachmentPath(r.request_id, r.id)}`, createdAt: r.created_at });

  app.get('/requests', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => {
      const atts = (await q.all('SELECT * FROM request_attachment ORDER BY created_at')).map(attachmentRow);
      return { requests: (await q.all('SELECT * FROM app_request ORDER BY created_at DESC')).map((r) => ({ ...requestRow(r), attachments: atts.filter((x) => x.requestId === r.id) })) };
    });
  });

  // A picture for a request (a drawing, a photo of a book page), sent as the raw body with its image content type.
  app.register(async (images) => {
    for (const t of Object.keys(IMAGE_TYPES)) images.addContentTypeParser(t, { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT }, (_req, body, done) => done(null, body));
    images.post<{ Params: { id: string } }>('/requests/:id/attachments', async (req) => {
      const a = await parentAuth(ctx, req);
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      const ext = IMAGE_TYPES[type];
      if (!ext || !Buffer.isBuffer(req.body)) throw new HttpError(415, 'Send a JPEG, PNG, WebP, GIF or HEIC picture');
      const body = req.body as Buffer;
      if (body.length < 16) throw new HttpError(400, 'Empty picture');
      const attId = newId('att'), key = `requests/${req.params.id}/${attId}.${ext}`;
      const ticket = await ctx.db.family(a.familyId, async (q) => {
        const r = await q.one<{ status: string; etducky_ticket_id: string | null }>('SELECT status, etducky_ticket_id FROM app_request WHERE id = $1', [req.params.id]);
        if (!r) throw notFound('No such request');
        if (!OPEN.includes(r.status)) throw new HttpError(409, 'This request is finished; pictures can be added to a request in progress.');
        const n = (await q.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM request_attachment WHERE request_id = $1', [req.params.id]))!.n;
        if (n >= MAX_PER_REQUEST) throw new HttpError(409, `Up to ${MAX_PER_REQUEST} pictures per request`);
        await ctx.storage.put(key, body, type, false);
        await q.run('INSERT INTO request_attachment (id, family_id, request_id, storage_key, content_type, size) VALUES ($1, $2, $3, $4, $5, $6)', [attId, a.familyId, req.params.id, key, type, body.length]);
        await audit(q, a.familyId, `parent:${a.parentId}`, 'request.attached', { id: req.params.id, attachment: attId, size: body.length });
        return r.etducky_ticket_id;
      });
      if (ticket) void ctx.attachToTicket(ticket, signedUrl(req.params.id, attId), type);
      return attachmentRow({ id: attId, request_id: req.params.id, content_type: type, size: body.length, created_at: new Date().toISOString() });
    });
  });

  app.get<{ Params: { id: string; att: string }; Querystring: { exp?: string; sig?: string } }>('/requests/:id/attachments/:att', async (req, reply) => {
    const { id, att } = req.params;
    const exp = Number(req.query.exp), sig = String(req.query.sig ?? '');
    const signed = Number.isFinite(exp) && exp > Date.now() && sig.length === 32 && safeEqual(sig, sign(id, att, exp));
    const row = signed
      ? await ctx.db.system((q) => q.one('SELECT * FROM request_attachment WHERE id = $1 AND request_id = $2', [att, id]))
      : await ctx.db.family((await parentAuth(ctx, req)).familyId, (q) => q.one('SELECT * FROM request_attachment WHERE id = $1 AND request_id = $2', [att, id]));
    if (!row) throw notFound('No such picture');
    const bytes = await ctx.storage.get(row.storage_key);
    if (!bytes) throw notFound('No such picture');
    reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'inline').type(row.content_type);
    return reply.send(bytes);
  });

  // The parent withdraws a request still in progress. Its ET Ducky ticket stays (the API has no close call); a
  // status change on it later no longer moves the request, and a request with no ticket yet never gets one.
  app.post<{ Params: { id: string } }>('/requests/:id/withdraw', async (req) => {
    const a = await parentAuth(ctx, req);
    return withdrawRequest(a.familyId, `parent:${a.parentId}`, req.params.id);
  });

  const requestBody = z.object({
    title: z.string().trim().min(3).max(80),
    description: z.string().trim().min(10).max(2000),
    childGrade: z.string().max(10).nullable().optional(),
    installWhenReady: z.boolean().default(true),
  });

  // One request, from the portal or a tablet's parent area: one open request per family, then the ET Ducky ticket.
  async function createRequest(familyId: string, actor: string, b: z.infer<typeof requestBody>) {
    await ctx.db.family(familyId, (q) => requireSubscribed(q, familyId));
    const id = newId('req');
    await ctx.db.family(familyId, async (q) => {
      // One open request per family keeps the queue fair.
      if (await q.one('SELECT 1 FROM app_request WHERE status = ANY($1)', [OPEN])) {
        throw new HttpError(409, 'You already have a request in progress. You can make another once it is finished.');
      }
      await q.run(`INSERT INTO app_request (id, family_id, title, description, child_grade, install_when_ready) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, familyId, b.title, b.description, b.childGrade ?? null, b.installWhenReady]);
      await audit(q, familyId, actor, 'request.created', { id });
    });
    const ticket = await ctx.createTicket({ requestId: id, familyId, title: b.title, description: b.description, childGrade: b.childGrade ?? null });
    return ctx.db.family(familyId, async (q) => {
      if (ticket) await q.run('UPDATE app_request SET etducky_ticket_id = $1 WHERE id = $2', [ticket, id]);
      return requestRow(await q.one('SELECT * FROM app_request WHERE id = $1', [id]));
    });
  }

  async function withdrawRequest(familyId: string, actor: string, id: string) {
    return ctx.db.family(familyId, async (q) => {
      const r = await q.one<{ status: string }>('SELECT status FROM app_request WHERE id = $1', [id]);
      if (!r) throw notFound('No such request');
      if (!OPEN.includes(r.status)) throw new HttpError(409, 'This request is already finished.');
      await q.run("UPDATE app_request SET status = 'withdrawn', updated_at = now() WHERE id = $1", [id]);
      await audit(q, familyId, actor, 'request.withdrawn', { id });
      return requestRow(await q.one('SELECT * FROM app_request WHERE id = $1', [id]));
    });
  }

  app.post('/requests', async (req) => {
    const a = await parentAuth(ctx, req);
    return createRequest(a.familyId, `parent:${a.parentId}`, requestBody.parse(req.body));
  });

  // The same from a tablet's parent area (behind the parent PIN on the tablet). The grade is the tablet's child's;
  // pictures are added on the website.
  app.get('/device/requests', async (req) => {
    const d = await deviceAuth(ctx, req);
    return ctx.db.family(d.familyId, async (q) => ({ requests: (await q.all('SELECT * FROM app_request ORDER BY created_at DESC LIMIT 10')).map(requestRow) }));
  });
  app.post('/device/requests', async (req) => {
    const d = await deviceAuth(ctx, req);
    const b = requestBody.omit({ childGrade: true }).parse(req.body);
    const grade = d.childId ? (await ctx.db.family(d.familyId, (q) => q.one<{ grade: string | null }>('SELECT grade FROM child WHERE id = $1', [d.childId])))?.grade ?? null : null;
    return createRequest(d.familyId, `device:${d.deviceId}`, { ...b, childGrade: grade });
  });
  app.post<{ Params: { id: string } }>('/device/requests/:id/withdraw', async (req) => {
    const d = await deviceAuth(ctx, req);
    return withdrawRequest(d.familyId, `device:${d.deviceId}`, req.params.id);
  });

  // ET Ducky webhook: { eventId, ticketId, status } signed with HMAC-SHA256 of the raw body (x-etducky-signature,
  // hex). eventId (or the x-etducky-delivery header) makes redeliveries no-ops; without either, the body hash stands
  // in. System work: the ticket id is the only key, so it runs past the policies.
  app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    // ET Ducky's automation webhook action sends a body template with custom headers and cannot sign the body, so the
    // secret travels as a bearer token. A sender that can sign may instead send x-etducky-signature (hex HMAC-SHA256
    // of the raw body under the same secret). A delivery that names an eventId is applied once; one without is applied
    // as it comes, which is harmless because the update is idempotent.
    hooks.post('/hooks/etducky', async (req) => {
      const raw = String(req.body ?? '');
      const secret = ctx.cfg.ETDUCKY_WEBHOOK_SECRET;
      const sig = String(req.headers['x-etducky-signature'] ?? '');
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const signed = !!sig && safeEqual(sig, createHmac('sha256', secret || '\u0000').update(raw).digest('hex'));
      const authorized = !!secret && (signed || (!!bearer && safeEqual(bearer, secret)));
      if (!authorized) throw new HttpError(401, 'Bad signature');
      const b = z.object({
        eventId: z.union([z.string(), z.number()]).transform(String).optional(),
        ticketId: z.union([z.string(), z.number()]).transform(String), status: z.string(),
      }).parse(JSON.parse(raw));
      const eventId = b.eventId ?? (req.headers['x-etducky-delivery'] ? String(req.headers['x-etducky-delivery']) : null);
      const map: Record<string, string> = { new: 'requested', open: 'requested', planned: 'planned', 'in progress': 'building', building: 'building', declined: 'declined', closed: 'declined', rejected: 'declined' };
      const status = map[b.status.trim().toLowerCase()];
      if (!status) return { ignored: true };
      return ctx.db.system(async (q) => {
        if (eventId && !(await firstDelivery(q, 'etducky', eventId))) return { duplicate: true, updated: 0 };
        const updated = await q.run("UPDATE app_request SET status = $1, updated_at = now() WHERE etducky_ticket_id = $2 AND status NOT IN ('shipped', 'withdrawn')", [status, b.ticketId]);
        return { updated };
      });
    });
  });
}
