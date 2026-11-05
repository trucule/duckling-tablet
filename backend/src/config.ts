// Settings come from the environment (a .env file next to the service on the droplet). Secrets never live in the repo.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8787),
  PUBLIC_URL: z.string().url().default('https://api.ducklingtablet.com'),
  PORTAL_URL: z.string().url().default('https://parents.ducklingtablet.com'),
  APP_URL: z.string().url().default('https://app.ducklingtablet.com'),
  DATABASE_PATH: z.string().default('./data/duckling.db'),

  // Files: 'local' writes under LOCAL_STORAGE_DIR (development and tests); 's3' uses DigitalOcean Spaces.
  STORAGE: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data/files'),
  SPACES_ENDPOINT: z.string().default('https://nyc3.digitaloceanspaces.com'),
  SPACES_REGION: z.string().default('nyc3'),
  SPACES_BUCKET: z.string().default('duckling'),
  SPACES_KEY: z.string().default(''),
  SPACES_SECRET: z.string().default(''),
  CDN_URL: z.string().default('https://cdn.ducklingtablet.com'),

  // Email links for parent sign-in. With no SMTP_HOST, links are written to the log (development).
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('Duckling Tablet <hello@ducklingtablet.com>'),

  // Azure Speech for the narrator and Story Maker voices.
  AZURE_SPEECH_KEY: z.string().default(''),
  AZURE_SPEECH_REGION: z.string().default('westus2'),
  NARRATOR_VOICE: z.string().default('en-US-AnaNeural'),
  TTS_DAILY_CHARS_PER_DEVICE: z.coerce.number().int().default(20000),

  // ET Ducky ticket bridge for app requests. With no ETDUCKY_API_URL, requests are kept here only.
  ETDUCKY_API_URL: z.string().default(''),
  ETDUCKY_API_KEY: z.string().default(''),
  ETDUCKY_WEBHOOK_SECRET: z.string().default(''),

  // Admin calls (publishing apps) use this bearer token.
  ADMIN_TOKEN: z.string().default(''),
  // Session cookie signing and token hashing.
  SESSION_SECRET: z.string().min(16).default('dev-only-change-me-please'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const cfg = schema.parse({ ...process.env, ...overrides });
  if (cfg.NODE_ENV === 'production') {
    const missing = (['SESSION_SECRET', 'ADMIN_TOKEN'] as const).filter((k) => !cfg[k] || cfg[k].startsWith('dev-only'));
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(', ')}`);
  }
  return cfg;
}
