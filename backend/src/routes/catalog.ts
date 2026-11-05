// The Store's catalog. Public: it lists app names, descriptions and package URLs, nothing about families.
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { listCatalog } from '../catalog.js';

export default async function catalogRoutes(app: FastifyInstance, { ctx }: { ctx: Ctx }) {
  app.get('/catalog', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return { apps: await listCatalog(ctx) };
  });
}
