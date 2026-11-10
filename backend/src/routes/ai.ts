// The AI proxy. Apps on a paired tablet call POST /ai/messages exactly as they called the Anthropic Messages API
// (the compatibility script redirects their fetch), and the server adds the key. What the server enforces:
// the device token, the calling app, a model allowlist, size limits, and a daily number of calls per device per
// app. Prompts and replies pass through and are not stored or logged; ai_usage keeps counts and token totals.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceAuth } from '../auth.js';
import { HttpError } from '../util.js';
import { requireSubscribed } from '../entitlement.js';

const APP_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

// "draw-with-me:25,story-maker:12,*:10" -> calls per device per day for each app; * is every other app.
export function parseDailyCalls(s: string): (appId: string) => number {
  const map = new Map<string, number>();
  for (const part of s.split(',')) {
    const [id, n] = part.split(':').map((x) => x.trim());
    if (id && Number.isFinite(Number(n))) map.set(id, Number(n));
  }
  return (appId) => map.get(appId) ?? map.get('*') ?? 10;
}

export default async function aiRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  const body = z.object({
    model: z.string().min(1).max(80),
    max_tokens: z.number().int().min(1).max(ctx.cfg.AI_MAX_TOKENS),
    system: z.string().max(ctx.cfg.AI_MAX_PROMPT_CHARS).optional(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(ctx.cfg.AI_MAX_PROMPT_CHARS) })).min(1).max(24),
  }).strict();
  const allowed = new Set(ctx.cfg.AI_MODELS.split(',').map((m) => m.trim()).filter(Boolean));
  const dailyCalls = parseDailyCalls(ctx.cfg.AI_DAILY_CALLS);

  app.post('/ai/messages', async (req, reply) => {
    const dv = await deviceAuth(ctx, req);
    const appId = String(req.headers['x-duckling-app'] ?? '');
    if (!APP_ID.test(appId)) throw new HttpError(400, 'x-duckling-app header required');
    const p = body.parse(req.body);
    const chars = (p.system?.length ?? 0) + p.messages.reduce((n, m) => n + m.content.length, 0);
    if (chars > ctx.cfg.AI_MAX_PROMPT_CHARS) throw new HttpError(413, 'Prompt too long');
    const model = allowed.has(p.model) ? p.model : ctx.cfg.AI_DEFAULT_MODEL;
    const limit = dailyCalls(appId);

    // One call against the allowance, inside the device's family transaction.
    await ctx.db.family(dv.familyId, async (t) => {
      await requireSubscribed(t, dv.familyId);
      const used = (await t.one<{ calls: number }>('SELECT calls FROM ai_usage WHERE device_id = $1 AND app_id = $2 AND day = CURRENT_DATE FOR UPDATE', [dv.deviceId, appId]))?.calls ?? 0;
      if (used >= limit) throw new HttpError(429, 'Daily AI limit reached for this app');
      await t.run(`INSERT INTO ai_usage (family_id, device_id, app_id, day, calls) VALUES ($1, $2, $3, CURRENT_DATE, 1)
        ON CONFLICT (device_id, app_id, day) DO UPDATE SET calls = ai_usage.calls + 1`, [dv.familyId, dv.deviceId, appId]);
    });

    const res = await ctx.complete({ model, max_tokens: p.max_tokens, system: p.system, messages: p.messages });
    const upstreamDown = !res || res.status >= 500 || res.status === 429;
    if (upstreamDown || res.status !== 200) {
      // The call did not happen for the child: give it back.
      await ctx.db.family(dv.familyId, (t) => t.run('UPDATE ai_usage SET calls = GREATEST(calls - 1, 0) WHERE device_id = $1 AND app_id = $2 AND day = CURRENT_DATE', [dv.deviceId, appId]));
      req.log.warn({ appId, status: res?.status ?? 0 }, 'ai upstream failed');
      if (upstreamDown) throw new HttpError(503, 'AI unavailable');
      throw new HttpError(502, 'AI request refused');
    }

    const usage = (res.body as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
    await ctx.db.family(dv.familyId, (t) => t.run('UPDATE ai_usage SET input_tokens = input_tokens + $3, output_tokens = output_tokens + $4 WHERE device_id = $1 AND app_id = $2 AND day = CURRENT_DATE',
      [dv.deviceId, appId, usage.input_tokens ?? 0, usage.output_tokens ?? 0]));
    reply.header('Cache-Control', 'private, no-store');
    return res.body;
  });
}
