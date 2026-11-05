// The family account: parents, children (profile for the apps) and account deletion.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { parentAuth } from '../auth.js';
import { newId, notFound, now } from '../util.js';

// Starting level per subject, 1 (youngest) to 10; the apps map it to their own level ladders.
const levels = z.record(z.enum(['reading', 'math', 'science', 'art', 'music', 'logic']), z.number().int().min(1).max(10));
const theme = z.object({ colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(4).optional(), interests: z.array(z.string().max(30)).max(8).optional() });
const childBody = z.object({
  firstName: z.string().trim().min(1).max(30),
  grade: z.enum(['pre-k', 'k', '1', '2', '3', '4', '5', '6']).nullable().optional(),
  levels: levels.optional(),
  theme: theme.optional(),
});

export const childRow = (r: any) => r && ({ id: r.id, firstName: r.first_name, grade: r.grade, levels: JSON.parse(r.levels), theme: JSON.parse(r.theme) });

export default async function familyRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/family', async (req) => {
    const a = parentAuth(ctx, req);
    const parents = ctx.db.prepare('SELECT id, email, role FROM parent WHERE family_id = ?').all(a.familyId);
    const children = (ctx.db.prepare('SELECT * FROM child WHERE family_id = ? ORDER BY created_at').all(a.familyId) as any[]).map(childRow);
    const devices = ctx.db.prepare(`SELECT id, child_id AS childId, platform, name, state, shell_version AS shellVersion, battery,
      last_seen_at AS lastSeenAt FROM device WHERE family_id = ? ORDER BY created_at`).all(a.familyId);
    return { familyId: a.familyId, you: a.email, parents, children, devices };
  });

  app.post('/children', async (req) => {
    const a = parentAuth(ctx, req);
    const b = childBody.parse(req.body);
    const id = newId('chd');
    ctx.db.prepare('INSERT INTO child (id, family_id, first_name, grade, levels, theme, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.familyId, b.firstName, b.grade ?? null, JSON.stringify(b.levels ?? {}), JSON.stringify(b.theme ?? {}), now());
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'child.created', { id });
    return childRow(ctx.db.prepare('SELECT * FROM child WHERE id = ?').get(id));
  });

  app.put<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = parentAuth(ctx, req);
    const b = childBody.partial().parse(req.body);
    const cur = ctx.db.prepare('SELECT * FROM child WHERE id = ? AND family_id = ?').get(req.params.id, a.familyId) as any;
    if (!cur) throw notFound('No such child');
    ctx.db.prepare('UPDATE child SET first_name = ?, grade = ?, levels = ?, theme = ? WHERE id = ?').run(
      b.firstName ?? cur.first_name, b.grade === undefined ? cur.grade : b.grade,
      b.levels ? JSON.stringify(b.levels) : cur.levels, b.theme ? JSON.stringify(b.theme) : cur.theme, cur.id);
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'child.updated', { id: cur.id });
    return childRow(ctx.db.prepare('SELECT * FROM child WHERE id = ?').get(cur.id));
  });

  app.delete<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = parentAuth(ctx, req);
    const r = ctx.db.prepare('DELETE FROM child WHERE id = ? AND family_id = ?').run(req.params.id, a.familyId);
    if (!r.changes) throw notFound('No such child');
    ctx.audit(a.familyId, `parent:${a.parentId}`, 'child.deleted', { id: req.params.id });
    return { ok: true };
  });

  // Delete account and all data: every device is told to release itself on its next check-in, then the family's
  // records go. (Store subscriptions are cancelled in Apple's or Google's own screens; Stripe is cancelled by the billing module.)
  app.delete('/family', async (req) => {
    const a = parentAuth(ctx, req);
    const { confirm } = z.object({ confirm: z.literal('DELETE') }).parse(req.body);
    void confirm;
    ctx.db.transaction(() => {
      const devices = ctx.db.prepare('SELECT token_hash FROM device WHERE family_id = ?').all(a.familyId) as { token_hash: string }[];
      const tomb = ctx.db.prepare('INSERT OR IGNORE INTO device_tombstone (token_hash, created_at) VALUES (?, ?)');
      for (const d of devices) tomb.run(d.token_hash, now());
      ctx.db.prepare('DELETE FROM family WHERE id = ?').run(a.familyId);
      ctx.db.prepare('DELETE FROM audit WHERE family_id = ?').run(a.familyId);
    })();
    ctx.audit(null, 'system', 'family.deleted', {});
    return { deleted: true };
  });
}
