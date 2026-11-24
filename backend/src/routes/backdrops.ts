// Photo backdrops for the apps' 3D places, served from backdrops/ in the repo (built by tools/build-backdrops.py from
// Poly Haven's CC0 photos): GET /backdrops/backdrops.json lists each one with its sun and colours,
// /backdrops/<id>.jpg is the 360° photo and /backdrops/<id>-light.png its lighting. Apps ship with their drawn
// backdrops; a tablet downloads a photo the first time a child goes to that place and keeps it. Public files, no
// sign-in and no rate limit; any origin may read them, since apps run on each shell's own origin.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKDROPS_DIR = fileURLToPath(new URL('../../../backdrops/', import.meta.url));

function send(reply: FastifyReply, file: string, type: string, maxAge: number) {
  if (!existsSync(file) || !statSync(file).isFile()) return reply.code(404).send({ error: 'Not found' });
  const st = statSync(file);
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cache-Control', `public, max-age=${maxAge}`);
  reply.header('ETag', `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`);
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.type(type).send(createReadStream(file));
}

export default async function backdropRoutes(app: FastifyInstance, opts: { dir?: string }) {
  const dir = opts.dir ?? BACKDROPS_DIR;
  const config = { rateLimit: false } as const;
  app.get('/backdrops/backdrops.json', { config }, (_req, reply) => send(reply, join(dir, 'backdrops.json'), 'application/json', 3600));
  app.get<{ Params: { name: string } }>('/backdrops/:name', { config }, (req, reply) => {
    const m = /^([a-z0-9]+(?:_[a-z0-9]+)*)(-light\.png|\.jpg)$/.exec(req.params.name);
    if (!m) return reply.code(404).send({ error: 'Not found' });
    return send(reply, join(dir, m[1] + m[2]), m[2] === '.jpg' ? 'image/jpeg' : 'image/png', 30 * 86400);
  });
}
