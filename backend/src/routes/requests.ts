// Parents request new apps; each request becomes an ET Ducky ticket, and ticket status flows back here.
import type { FastifyInstance } from 'fastify';
import { requireSubscribed } from '../entitlement.js';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { parentAuth } from '../auth.js';
import { HttpError, hashToken, newId, notFound, safeEqual, sha256 } from '../util.js';
import { firstDelivery } from '../webhooks.js';

const OPEN = ['requested', 'planned', 'building'];
export const requestRow = (r: any) => r && ({
  id: r.id, title: r.title, description: r.description, childGrade: r.child_grade, installWhenReady: r.install_when_ready,
  status: r.status, appId: r.app_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
const MAX_ATTACHMENT = 10 * 1024 * 1024, MAX_PER_REQUEST = 5;

export default async function requestRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  // Pictures are private in storage. Parents read them with their session; ET Ducky gets a signed link (30 days).
  const attachmentPath = (requestId: string, attId: string) => `/requests/${requestId}/attachments/${attId}`;
  const sign = (requestId: string, attId: string, exp: number) => hashToken(`${requestId}/${attId}/${exp}`, ctx.cfg.SESSION_SECRET).slice(0, 32);
  const signedUrl = (requestId: string, attId: string) => { const exp = Date.now() + 30 * 86_400_000; return `${ctx.cfg.PUBLIC_URL}${attachmentPath(requestId, attId)}?exp=${exp}&sig=${sign(requestId, attId, exp)}`; };
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

  app.post('/requests', async (req) => {
    const a = await parentAuth(ctx, req);
    await ctx.db.family(a.familyId, (q) => requireSubscribed(q, a.familyId));
    const b = z.object({
      title: z.string().trim().min(3).max(80),
      description: z.string().trim().min(10).max(2000),
      childGrade: z.string().max(10).nullable().optional(),
      installWhenReady: z.boolean().default(true),
    }).parse(req.body);
    const id = newId('req');
    await ctx.db.family(a.familyId, async (q) => {
      // One open request per family keeps the queue fair.
      if (await q.one('SELECT 1 FROM app_request WHERE status = ANY($1)', [OPEN])) {
        throw new HttpError(409, 'You already have a request in progress. You can make another once it is finished.');
      }
      await q.run(`INSERT INTO app_request (id, family_id, title, description, child_grade, install_when_ready) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, a.familyId, b.title, b.description, b.childGrade ?? null, b.installWhenReady]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'request.created', { id });
    });
    const ticket = await ctx.createTicket({ requestId: id, familyId: a.familyId, title: b.title, description: b.description, childGrade: b.childGrade ?? null });
    return ctx.db.family(a.familyId, async (q) => {
      if (ticket) await q.run('UPDATE app_request SET etducky_ticket_id = $1 WHERE id = $2', [ticket, id]);
      return requestRow(await q.one('SELECT * FROM app_request WHERE id = $1', [id]));
    });
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
        const updated = await q.run("UPDATE app_request SET status = $1, updated_at = now() WHERE etducky_ticket_id = $2 AND status != 'shipped'", [status, b.ticketId]);
        return { updated };
      });
    });
  });
}
