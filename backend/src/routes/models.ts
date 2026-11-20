// Speech models an app downloads once and keeps on the tablet, served from models/ in the repo the way /fonts serves
// fonts/: GET /models/<model>/<path> sends the file at models/<model>/<path>. Read It Say It Make It fetches the
// Spanish Vosk model this way (models/README.md lists the files). The folder holds files Chris places on the server;
// git carries only the README and the folder. Public files, no sign-in and no rate limit; any origin may read them,
// since apps run on each shell's own origin. A model name or a path of any other shape than a model's finds nothing.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS_DIR = fileURLToPath(new URL('../../../models/', import.meta.url));

// A model folder name (vosk-small-es) and a file path inside it (graph/phones/word_boundary.int): lowercase names,
// digits, _ and -, at most three folders deep, one extension. Dots appear only before the extension, so ".." and
// dotfiles (.gitkeep, .gitignore) never match.
const MODEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE = /^(?:[a-z0-9_-]+\/){0,3}[a-z0-9_-]+\.[a-z]+$/;
const TEXT = new Set(['txt', 'conf', 'int', 'stats']);

function send(reply: FastifyReply, file: string, type: string, maxAge: number) {
  if (!existsSync(file) || !statSync(file).isFile()) return reply.code(404).send({ error: 'Not found' });
  const st = statSync(file);
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cache-Control', `public, max-age=${maxAge}`);
  reply.header('ETag', `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`);
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.type(type).send(createReadStream(file));
}

export default async function modelRoutes(app: FastifyInstance, opts: { dir?: string }) {
  const dir = opts.dir ?? MODELS_DIR;
  const config = { rateLimit: false } as const;
  app.get<{ Params: { model: string; '*': string } }>('/models/:model/*', { config }, (req, reply) => {
    const model = req.params.model, file = req.params['*'];
    if (!MODEL.test(model) || !FILE.test(file)) return reply.code(404).send({ error: 'Not found' });
    const ext = file.slice(file.lastIndexOf('.') + 1);
    return send(reply, join(dir, model, ...file.split('/')), TEXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream', 30 * 86400);
  });
}
