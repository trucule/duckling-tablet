// Paint Studio's font library, served from fonts/ in the repo (built by tools/font-library.py and
// tools/font-sheets.mjs): GET /fonts/library.json lists every font with its group and preview cell,
// /fonts/sheets/<group>-<n>.webp are the preview sheets, /fonts/files/<id>.woff2 the fonts. A tablet downloads a
// font when a child first picks it and keeps it. Public files, no sign-in and no rate limit; any origin may read
// them, since apps run on each shell's own origin.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONTS_DIR = fileURLToPath(new URL('../../../fonts/', import.meta.url));

function send(reply: FastifyReply, file: string, type: string, maxAge: number) {
  if (!existsSync(file) || !statSync(file).isFile()) return reply.code(404).send({ error: 'Not found' });
  const st = statSync(file);
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cache-Control', `public, max-age=${maxAge}`);
  reply.header('ETag', `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`);
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.type(type).send(createReadStream(file));
}

export default async function fontRoutes(app: FastifyInstance, opts: { dir?: string }) {
  const dir = opts.dir ?? FONTS_DIR;
  const config = { rateLimit: false } as const;
  app.get('/fonts/library.json', { config }, (_req, reply) => send(reply, join(dir, 'library.json'), 'application/json', 3600));
  app.get<{ Params: { name: string } }>('/fonts/sheets/:name', { config }, (req, reply) => {
    const m = /^([a-z]+-\d+)\.webp$/.exec(req.params.name);
    return m ? send(reply, join(dir, 'sheets', `${m[1]}.webp`), 'image/webp', 86400) : reply.code(404).send({ error: 'Not found' });
  });
  app.get<{ Params: { name: string } }>('/fonts/files/:name', { config }, (req, reply) => {
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.woff2$/.exec(req.params.name);
    return m ? send(reply, join(dir, 'files', `${m[1]}.woff2`), 'font/woff2', 30 * 86400) : reply.code(404).send({ error: 'Not found' });
  });
}
