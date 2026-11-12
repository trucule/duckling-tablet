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
import requestRoutes, { sendMissingTickets } from './routes/requests.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai.js';
import billingRoutes from './routes/billing.js';
import { makeAppleVerifier, type AppleVerifier } from './apple.js';
import { makeGooglePlay, makePushAuth, type GooglePlay, type PushAuth } from './google.js';
import { makeAnthropic, type Complete } from './anthropic.js';
import { makeFcm, type Push } from './push.js';
import { makeStripe, type Stripe } from './stripe.js';
import stripeRoutes from './routes/stripe.js';
import windowsRoutes from './routes/windows.js';
import siteIconRoutes, { type FetchUrl } from './routes/siteicon.js';

export interface BuildOptions { stripe?: Stripe | null; apple?: AppleVerifier | null; google?: GooglePlay | null; googlePushAuth?: PushAuth; db?: Db; storage?: Storage; mailer?: Mailer; synth?: Synth; createTicket?: CreateTicket; attachToTicket?: AttachToTicket; complete?: Complete; push?: Push; fetchUrl?: FetchUrl; logger?: boolean | Record<string, unknown> }

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
    push: opts.push ?? makeFcm(cfg, log),
    stripe: opts.stripe === undefined ? makeStripe(cfg, log) : opts.stripe,
    log,
  };
  const voice = makeVoiceCache(ctx);

  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  // The portal, the child web app, and the origins the shells give installed packages: Android's asset loader, the
  // iPad's local server, and the Windows shell's WebView2 virtual host. The public site reads the Windows release.
  // The portal and the web app call every verb the API has; @fastify/cors allows only GET, HEAD and POST unless told.
  await app.register(cors, { origin: [cfg.PORTAL_URL, cfg.APP_URL, cfg.SITE_URL, 'https://appassets.androidplatform.net', 'duckling-app://local', 'https://apps.duckling.example'], credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] });
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
  await app.register(billingRoutes, {
    ctx,
    apple: opts.apple === undefined ? makeAppleVerifier(cfg) : opts.apple,
    google: opts.google === undefined ? makeGooglePlay(cfg, ctx.log) : opts.google,
    googlePushAuth: opts.googlePushAuth ?? makePushAuth(cfg),
  });
  await app.register(stripeRoutes, { ctx });
  await app.register(windowsRoutes, { ctx });
  await app.register(siteIconRoutes, { ctx, fetchUrl: opts.fetchUrl });
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

  // App requests whose ET Ducky ticket could not be opened when they were made get it here, every 10 minutes.
  if (cfg.NODE_ENV !== 'test') {
    if (!cfg.ETDUCKY_API_URL) app.log.warn('ETDUCKY_API_URL is not set: app requests are kept here and get their ET Ducky tickets once it is');
    let timer: NodeJS.Timeout | undefined;
    const run = () => { sendMissingTickets(ctx).catch((e) => app.log.error({ err: { type: (e as Error).name, message: redactText((e as Error).message) } }, 'ET Ducky ticket retry failed')); };
    app.addHook('onReady', async () => { setTimeout(run, 30_000).unref(); timer = setInterval(run, 10 * 60_000); timer.unref(); });
    app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  }
  app.addHook('onClose', async () => { if (!opts.db) await db.close(); });
  return { app, ctx };
}
