// Parents request new apps; each request becomes an ET Ducky ticket, and ticket status flows back here.
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { parentAuth } from '../auth.js';
import { HttpError, newId, safeEqual, sha256 } from '../util.js';
import { firstDelivery } from '../webhooks.js';

const OPEN = ['requested', 'planned', 'building'];
export const requestRow = (r: any) => r && ({
  id: r.id, title: r.title, description: r.description, childGrade: r.child_grade, installWhenReady: r.install_when_ready,
  status: r.status, appId: r.app_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export default async function requestRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/requests', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => ({ requests: (await q.all('SELECT * FROM app_request ORDER BY created_at DESC')).map(requestRow) }));
  });

  app.post('/requests', async (req) => {
    const a = await parentAuth(ctx, req);
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
    hooks.post('/hooks/etducky', async (req) => {
      const raw = String(req.body ?? '');
      const sig = String(req.headers['x-etducky-signature'] ?? '');
      const want = createHmac('sha256', ctx.cfg.ETDUCKY_WEBHOOK_SECRET || '\u0000').update(raw).digest('hex');
      if (!ctx.cfg.ETDUCKY_WEBHOOK_SECRET || !safeEqual(sig, want)) throw new HttpError(401, 'Bad signature');
      const b = z.object({
        eventId: z.union([z.string(), z.number()]).transform(String).optional(),
        ticketId: z.union([z.string(), z.number()]).transform(String), status: z.string(),
      }).parse(JSON.parse(raw));
      const eventId = b.eventId ?? (req.headers['x-etducky-delivery'] ? String(req.headers['x-etducky-delivery']) : `body:${sha256(raw)}`);
      const map: Record<string, string> = { new: 'requested', open: 'requested', planned: 'planned', 'in progress': 'building', building: 'building', declined: 'declined', closed: 'declined', rejected: 'declined' };
      const status = map[b.status.toLowerCase()];
      if (!status) return { ignored: true };
      return ctx.db.system(async (q) => {
        if (!(await firstDelivery(q, 'etducky', eventId))) return { duplicate: true, updated: 0 };
        const updated = await q.run("UPDATE app_request SET status = $1, updated_at = now() WHERE etducky_ticket_id = $2 AND status != 'shipped'", [status, b.ticketId]);
        return { updated };
      });
    });
  });
}
