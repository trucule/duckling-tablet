// Builds the Fastify app from its parts. index.ts starts it; tests build it with fakes for Azure, mail and ET Ducky.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Config } from './config.js';
import { Db } from './db.js';
import { makeStorage, type Storage } from './storage.js';
import { makeMailer, type Mailer } from './mailer.js';
import { makeAzureSynth, type Synth } from './azure.js';
import { makeEtDucky, makeEtDuckyAttach, type CreateTicket, type AttachToTicket } from './etducky.js';
import type { Ctx } from './context.js';
import { HttpError } from './util.js';
import { loggerOptions, pathOnly, redactText } from './logging.js';
import authRoutes from './routes/auth.js';
import familyRoutes from './routes/family.js';
import deviceRoutes from './routes/devices.js';
import catalogRoutes from './routes/catalog.js';
import ttsRoutes, { makeVoiceCache } from './routes/tts.js';
import requestRoutes from './routes/requests.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai.js';
import { makeAnthropic, type Complete } from './anthropic.js';

export interface BuildOptions { db?: Db; storage?: Storage; mailer?: Mailer; synth?: Synth; createTicket?: CreateTicket; attachToTicket?: AttachToTicket; complete?: Complete; logger?: boolean | Record<string, unknown> }

export async function buildServer(cfg: Config, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const wantLog = opts.logger ?? cfg.NODE_ENV !== 'test';
  const logger = wantLog === false ? false : loggerOptions(typeof wantLog === 'object' ? wantLog : {});
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1024 * 1024 });
  const log = (m: string) => app.log.info(m);
  const db = opts.db ?? new Db({ appUrl: cfg.DATABASE_URL_APP, systemUrl: cfg.DATABASE_URL_SYSTEM, caCert: cfg.DATABASE_CA_CERT || undefined });
  const ctx: Ctx = {
    cfg, db,
    storage: opts.storage ?? makeStorage(cfg),
    mailer: opts.mailer ?? makeMailer(cfg, log),
    synth: opts.synth ?? makeAzureSynth(cfg),
    createTicket: opts.createTicket ?? makeEtDucky(cfg, log),
    attachToTicket: opts.attachToTicket ?? makeEtDuckyAttach(cfg, log),
    complete: opts.complete ?? makeAnthropic(cfg),
  };
  const voice = makeVoiceCache(ctx);

  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  // The portal, the child web app, and the origins the shells give installed packages (Android's asset loader).
  await app.register(cors, { origin: [cfg.PORTAL_URL, cfg.APP_URL, 'https://appassets.androidplatform.net'], credentials: true });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;
    // Only the error's type, code and a masked message: driver errors can carry row values in their details.
    if (status >= 500) app.log.error({ err: { type: e.name, code: e.code, message: redactText(e.message) }, url: pathOnly(req.url) }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Something went wrong' : e.message });
  });

  // Fastify's own 404 handler logs the full URL, query string included; this one logs the path.
  app.setNotFoundHandler((req, reply) => {
    req.log.info({ url: pathOnly(req.url) }, 'route not found');
    return reply.code(404).send({ error: 'Not found' });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  for (const r of [authRoutes, familyRoutes, deviceRoutes, catalogRoutes, requestRoutes]) await app.register(r, { ctx });
  await app.register(ttsRoutes, { ctx, voice });
  await app.register(aiRoutes, { ctx });
  await app.register(adminRoutes, { ctx, voice });

  // Development only: serve files from local storage at /files/... (production uses the Spaces CDN).
  if (cfg.STORAGE === 'local') {
    app.get('/files/*', async (req, reply) => {
      const rel = normalize((req.params as { '*': string })['*']).replace(/\\/g, '/');
      if (rel.startsWith('..')) throw new HttpError(400, 'Bad path');
      const p = join(cfg.LOCAL_STORAGE_DIR, rel);
      if (!existsSync(p)) throw new HttpError(404, 'Not found');
      reply.type(p.endsWith('.mp3') ? 'audio/mpeg' : p.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
      return reply.send(readFileSync(p));
    });
  }

  app.addHook('onClose', async () => { if (!opts.db) await db.close(); });
  return { app, ctx };
}
