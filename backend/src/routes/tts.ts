// Shared narrator voice cache. A line is synthesized by Azure once, stored as voice/<hash>.mp3, and every device
// after that gets a redirect to the CDN copy. Lines marked private (they contain the child's name) are spoken
// but never stored, so no child's name is saved on the server.
// voice_clip is a global table: devices read it; the index is written as duckling_system.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceAuth } from '../auth.js';
import { HttpError, sha256 } from '../util.js';

const VOICE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

export const clipKey = (voice: string, rate: number, text: string, style = '') => sha256(style ? `${voice}|${rate}|${style}|${text}` : `${voice}|${rate}|${text}`);
export const normalizeLine = (t: string) => t.replace(/\s+/g, ' ').trim();

export function makeVoiceCache(ctx: Ctx) {
  const inflight = new Map<string, Promise<Buffer | null>>();

  // Returns the stored clip's public URL, synthesizing and storing it on a miss. null = Azure unavailable.
  async function ensure(text: string, voice: string, rate: number, style = ''): Promise<{ hash: string; url: string; created: boolean } | null> {
    const hash = clipKey(voice, rate, text, style), key = `voice/${hash}.mp3`;
    const [row] = await ctx.db.query('SELECT hash FROM voice_clip WHERE hash = $1', [hash]);
    if (row && await ctx.storage.exists(key)) {
      await ctx.db.system((q) => q.run('UPDATE voice_clip SET hits = hits + 1 WHERE hash = $1', [hash]));
      return { hash, url: ctx.storage.publicUrl(key), created: false };
    }
    // One Azure call per line, however many devices ask at once.
    let p = inflight.get(hash);
    if (!p) {
      p = ctx.synth(text, voice, rate, style || undefined).then(async (mp3) => {
        if (mp3) {
          await ctx.storage.put(key, mp3, 'audio/mpeg', true);
          await ctx.db.system((q) => q.run('INSERT INTO voice_clip (hash, voice, rate, chars) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [hash, voice, rate, text.length]));
        }
        return mp3;
      }).finally(() => inflight.delete(hash));
      inflight.set(hash, p);
    }
    const mp3 = await p;
    return mp3 ? { hash, url: ctx.storage.publicUrl(key), created: true } : null;
  }
  return { ensure };
}

export default async function ttsRoutes(app: FastifyInstance, { ctx, voice }: { ctx: Ctx; voice: ReturnType<typeof makeVoiceCache> }) {
  const q = z.object({
    text: z.string().min(1).max(1000),
    voice: z.string().regex(VOICE).optional(),
    rate: z.coerce.number().int().min(-50).max(100).default(0),
    style: z.string().regex(/^[a-z-]{1,30}$/).optional(),
    private: z.enum(['0', '1']).default('0'),
  });

  // Counts uncached characters against the device's daily cap, inside the device's family transaction.
  const charge = (familyId: string, deviceId: string, chars: number) => ctx.db.family(familyId, async (t) => {
    const used = (await t.one<{ chars: number }>('SELECT chars FROM tts_usage WHERE device_id = $1 AND day = CURRENT_DATE FOR UPDATE', [deviceId]))?.chars ?? 0;
    if (used + chars > ctx.cfg.TTS_DAILY_CHARS_PER_DEVICE) throw new HttpError(429, 'Daily voice limit reached; the device voice will be used');
    await t.run(`INSERT INTO tts_usage (family_id, device_id, day, chars) VALUES ($1, $2, CURRENT_DATE, $3)
      ON CONFLICT (device_id, day) DO UPDATE SET chars = tts_usage.chars + excluded.chars`, [familyId, deviceId, chars]);
  });

  app.get('/tts', async (req, reply) => {
    const dv = await deviceAuth(ctx, req);
    const p = q.parse(req.query);
    const text = normalizeLine(p.text), v = p.voice ?? ctx.cfg.NARRATOR_VOICE;

    if (p.private === '1') {
      await charge(dv.familyId, dv.deviceId, text.length);
      const mp3 = await ctx.synth(text, v, p.rate, p.style);
      if (!mp3) throw new HttpError(503, 'Voice unavailable');
      reply.header('Cache-Control', 'private, no-store').type('audio/mpeg');
      return reply.send(mp3);
    }

    const hash = clipKey(v, p.rate, text, p.style ?? '');
    const [cached] = await ctx.db.query('SELECT 1 FROM voice_clip WHERE hash = $1', [hash]);
    if (!cached) await charge(dv.familyId, dv.deviceId, text.length);
    const clip = await voice.ensure(text, v, p.rate, p.style ?? '');
    if (!clip) throw new HttpError(503, 'Voice unavailable');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.redirect(clip.url, 302);
  });
}
