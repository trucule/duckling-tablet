// The family account: parents, children (profile for the apps) and account deletion.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, type Ctx } from '../context.js';
import { parentAuth } from '../auth.js';
import { newId, notFound } from '../util.js';

// Starting level per subject, 1 (youngest) to 10; the apps map it to their own level ladders.
const levels = z.record(z.enum(['reading', 'math', 'science', 'art', 'music', 'logic']), z.number().int().min(1).max(10));
const theme = z.object({ colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(4).optional(), interests: z.array(z.string().max(30)).max(8).optional() });
const childBody = z.object({
  firstName: z.string().trim().min(1).max(30),
  grade: z.enum(['pre-k', 'k', '1', '2', '3', '4', '5', '6']).nullable().optional(),
  levels: levels.optional(),
  theme: theme.optional(),
});

export const childRow = (r: any) => r && ({ id: r.id, firstName: r.first_name, grade: r.grade, levels: r.levels, theme: r.theme });

const DEVICE_COLUMNS = `id, child_id AS "childId", platform, name, state, shell_version AS "shellVersion", battery, last_seen_at AS "lastSeenAt"`;

export default async function familyRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/family', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => ({
      familyId: a.familyId, you: a.email,
      parents: await q.all('SELECT id, email, role FROM parent ORDER BY created_at'),
      children: (await q.all('SELECT * FROM child ORDER BY created_at')).map(childRow),
      devices: await q.all(`SELECT ${DEVICE_COLUMNS} FROM device ORDER BY created_at`),
    }));
  });

  app.post('/children', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = childBody.parse(req.body);
    const id = newId('chd');
    return ctx.db.family(a.familyId, async (q) => {
      await q.run('INSERT INTO child (id, family_id, first_name, grade, levels, theme) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)',
        [id, a.familyId, b.firstName, b.grade ?? null, JSON.stringify(b.levels ?? {}), JSON.stringify(b.theme ?? {})]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.created', { id });
      return childRow(await q.one('SELECT * FROM child WHERE id = $1', [id]));
    });
  });

  app.put<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    const b = childBody.partial().parse(req.body);
    return ctx.db.family(a.familyId, async (q) => {
      const cur = await q.one('SELECT * FROM child WHERE id = $1', [req.params.id]);
      if (!cur) throw notFound('No such child');
      await q.run('UPDATE child SET first_name = $1, grade = $2, levels = $3::jsonb, theme = $4::jsonb WHERE id = $5', [
        b.firstName ?? cur.first_name, b.grade === undefined ? cur.grade : b.grade,
        JSON.stringify(b.levels ?? cur.levels), JSON.stringify(b.theme ?? cur.theme), cur.id]);
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.updated', { id: cur.id });
      return childRow(await q.one('SELECT * FROM child WHERE id = $1', [cur.id]));
    });
  });

  app.delete<{ Params: { id: string } }>('/children/:id', async (req) => {
    const a = await parentAuth(ctx, req);
    return ctx.db.family(a.familyId, async (q) => {
      const n = await q.run('DELETE FROM child WHERE id = $1', [req.params.id]);
      if (!n) throw notFound('No such child');
      await audit(q, a.familyId, `parent:${a.parentId}`, 'child.deleted', { id: req.params.id });
      return { ok: true };
    });
  });

  // Delete account and all data: every device is told to release itself on its next check-in, then the family's
  // records go. Tombstones are a global table, so this is system work. (Store subscriptions are cancelled in
  // Apple's or Google's own screens; Stripe is cancelled by the billing module.)
  app.delete('/family', async (req) => {
    const a = await parentAuth(ctx, req);
    z.object({ confirm: z.literal('DELETE') }).parse(req.body);
    await ctx.db.system(async (q) => {
      await q.run('INSERT INTO device_tombstone (token_hash) SELECT token_hash FROM device WHERE family_id = $1 ON CONFLICT DO NOTHING', [a.familyId]);
      await q.run('DELETE FROM family WHERE id = $1', [a.familyId]);
      await q.run('DELETE FROM audit WHERE family_id = $1', [a.familyId]);
      await audit(q, null, 'system', 'family.deleted');
    });
    return { deleted: true };
  });
}
