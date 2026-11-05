// Parents request new apps; each request becomes an ET Ducky ticket, and ticket status flows back here.
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { parentAuth } from '../auth.js';
import { HttpError, newId, now, safeEqual } from '../util.js';

const OPEN = ['requested', 'planned', 'building'];
export const requestRow = (r: any) => r && ({
  id: r.id, title: r.title, description: r.description, childGrade: r.child_grade, installWhenReady: !!r.install_when_ready,
  status: r.status, appId: r.app_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export default async function requestRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/requests', async (req) => {
    const a = parentAuth(ctx, req);
    return { requests: (ctx.db.prepare('SELECT * FROM app_request WHERE family_id = ? ORDER BY created_at DESC').all(a.familyId) as any[]).map(requestRow) };
  });

  app.post('/requests', async (req) => {
    const a = parentAuth(ctx, req);
    const b = z.object({
      title: z.string().trim().min(3).max(80),
      description: z.string().trim().min(10).max(2000),
      childGrade: z.string().max(10).nullable().optional(),
      installWhenReady: z.boolean().default(true),
    }).parse(req.body);
    // One open request per family keeps the queue fair.
    const open = ctx.db.prepare(`SELECT 1 FROM app_request WHERE family_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`).get(a.familyId, ...OPEN);
    if (open) throw new HttpError(409, 'You already have a request in progress. You can make another once it is finished.');
    const id = newId('req');
    ctx.db.prepare(`INSERT INTO app_request (id, family_id, title, description, child_grade, install_when_ready, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, a.familyId, b.title, b.description, b.childGrade ?? null, b.installWhenReady ? 1 : 0, now(), now());
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'request.created', { id });
    const ticket = await ctx.createTicket({ requestId: id, familyId: a.familyId, title: b.title, description: b.description, childGrade: b.childGrade ?? null });
    if (ticket) ctx.db.prepare('UPDATE app_request SET etducky_ticket_id = ? WHERE id = ?').run(ticket, id);
    return requestRow(ctx.db.prepare('SELECT * FROM app_request WHERE id = ?').get(id));
  });

  // ET Ducky webhook: { ticketId, status } signed with HMAC-SHA256 of the raw body (x-etducky-signature, hex).
  app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    hooks.post('/hooks/etducky', async (req) => {
      const raw = String(req.body ?? '');
      const sig = String(req.headers['x-etducky-signature'] ?? '');
      const want = createHmac('sha256', ctx.cfg.ETDUCKY_WEBHOOK_SECRET || '\u0000').update(raw).digest('hex');
      if (!ctx.cfg.ETDUCKY_WEBHOOK_SECRET || !safeEqual(sig, want)) throw new HttpError(401, 'Bad signature');
      const b = z.object({ ticketId: z.union([z.string(), z.number()]).transform(String), status: z.string() }).parse(JSON.parse(raw));
      const map: Record<string, string> = { new: 'requested', open: 'requested', planned: 'planned', 'in progress': 'building', building: 'building', declined: 'declined', closed: 'declined', rejected: 'declined' };
      const status = map[b.status.toLowerCase()];
      if (!status) return { ignored: true };
      const r = ctx.db.prepare("UPDATE app_request SET status = ?, updated_at = ? WHERE etducky_ticket_id = ? AND status != 'shipped'").run(status, now(), b.ticketId);
      return { updated: r.changes };
    });
  });
}
