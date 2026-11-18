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
  // PostgreSQL: duckling_app for requests (row-level security applies), duckling_system for system work.
  // Both default to a local cluster for development; production sets the DigitalOcean strings and the CA file.
  DATABASE_URL_APP: z.string().default('postgresql://duckling_app:duckling@127.0.0.1:5432/duckling'),
  DATABASE_URL_SYSTEM: z.string().default('postgresql://duckling_system:duckling@127.0.0.1:5432/duckling'),
  DATABASE_CA_CERT: z.string().default(''),

  // Files: 'local' writes under LOCAL_STORAGE_DIR (development and tests); 's3' uses DigitalOcean Spaces.
  STORAGE: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data/files'),
  SPACES_ENDPOINT: z.string().default('https://nyc3.digitaloceanspaces.com'),
  SPACES_REGION: z.string().default('nyc3'),
  SPACES_BUCKET: z.string().default('duckling'),
  SPACES_KEY: z.string().default(''),
  SPACES_SECRET: z.string().default(''),
  SPACES_CDN_URL: z.string().default('https://duckling.nyc3.cdn.digitaloceanspaces.com'),

  // Email links for parent sign-in. With no SMTP_HOST, links are written to the log (development).
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(2525),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('Duckling Tablet <hello@ducklingtablet.com>'),

  // Azure Speech for the narrator and Story Maker voices.
  AZURE_SPEECH_KEY: z.string().default(''),
  AZURE_SPEECH_REGION: z.string().default('eastus'),
  NARRATOR_VOICE: z.string().default('en-US-AnaNeural'),
  // The Spanish narrator (families and children whose language is es).
  NARRATOR_VOICE_ES: z.string().default('es-MX-MarinaNeural'),
  TTS_DAILY_CHARS_PER_DEVICE: z.coerce.number().int().default(20000),

  // The free trial a new family gets, in days, with no card. Subscriptions (A3) take over at its end.
  TRIAL_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  // Requests per minute from one address, for every route without its own limit. The browser tests drive a whole
  // family from one address, so they raise it.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100000).default(300),

  // The store review family. App Store and Play reviewers cannot read our email, so when both values are set the
  // tablet signup accepts this fixed six-digit code for this one address and sends it no mail. The parent website
  // is unaffected. Unset in every environment but production, where the operator sets both at deploy; the code is
  // the reviewer's password in the store consoles. Change both when a review is over.
  REVIEW_EMAIL: z.string().email().optional(),
  REVIEW_CODE: z.string().regex(/^\d{6}$/).optional(),

  // Apple subscriptions (S3). APPLE_ROOT_CERTS holds Apple's root certificates (AppleRootCA-G3.cer and friends,
  // fetched by deploy-remote.sh). Production verification also needs APPLE_APP_APPLE_ID, the numeric Apple ID on
  // App Store Connect > App Information; until it is set only sandbox (TestFlight) purchases verify.
  APPLE_BUNDLE_ID: z.string().default('com.ducklingtablet.app'),
  APPLE_APP_APPLE_ID: z.coerce.number().int().positive().optional(),
  APPLE_ROOT_CERTS: z.string().default('/opt/duckling/apple-root-certs'),
  APPLE_ENVIRONMENTS: z.string().default('Production,Sandbox'),
  APPLE_PRODUCT_IDS: z.string().default('duckling_monthly'),

  // Google Play subscriptions (A3). The Play Developer API is called with a service account that has access to the
  // app in Play Console (Users and permissions); empty GOOGLE_PLAY_SERVICE_ACCOUNT_FILE uses the FCM one. Real-time
  // Developer Notifications arrive by Pub/Sub push with an OIDC token whose audience is GOOGLE_PUSH_AUDIENCE
  // (default PUBLIC_URL/hooks/google) and, when set, whose email is GOOGLE_PUSH_SERVICE_ACCOUNT.
  GOOGLE_PLAY_PACKAGE: z.string().default('com.ducklingtablet.app'),
  GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: z.string().default(''),
  GOOGLE_PLAY_PRODUCT_IDS: z.string().default('duckling_monthly'),
  ANDROID_PUBLISHER_ENDPOINT: z.string().url().default('https://androidpublisher.googleapis.com'),
  GOOGLE_PUSH_AUDIENCE: z.string().default(''),
  GOOGLE_PUSH_SERVICE_ACCOUNT: z.string().default(''),

  // Stripe subscriptions (S2): how Windows tablets subscribe, and an option on the parent portal. With no
  // STRIPE_SECRET_KEY the routes answer 503. The price is found by its lookup key unless STRIPE_PRICE_ID is set. The
  // Customer Portal uses STRIPE_PORTAL_CONFIGURATION (Duckling's own branding and options) when set, else the
  // account default. STRIPE_WEBHOOK_SECRET is the signing secret of the /hooks/stripe endpoint. All three are
  // written into .env on the droplet by `node dist/stripe-setup.js`, except the secret key, which the operator adds.
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRICE_LOOKUP_KEY: z.string().default('duckling_monthly'),
  STRIPE_PRICE_ID: z.string().default(''),
  STRIPE_PORTAL_CONFIGURATION: z.string().default(''),
  // Duckling's name, colors and icon on the Checkout page instead of the account's (ET Ducky).
  STRIPE_BRANDING: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  STRIPE_AUTOMATIC_TAX: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  STRIPE_API: z.string().url().default('https://api.stripe.com'),
  // The public site, where Checkout returns to (checkout/success.html and checkout/cancel.html).
  SITE_URL: z.string().url().default('https://ducklingtablet.com'),

  // The AI proxy (POST /ai/messages) for Draw With Me lessons and Story Maker scenes. With no key, apps get a 503
  // and fall back to their built-in content. Models outside AI_MODELS are served with AI_DEFAULT_MODEL.
  ANTHROPIC_API_KEY: z.string().default(''),
  AI_MODELS: z.string().default('claude-haiku-5-5,claude-sonnet-5-5,claude-haiku-4-5-20251001'),
  AI_DEFAULT_MODEL: z.string().default('claude-haiku-5-5'),
  AI_DAILY_CALLS: z.string().default('draw-with-me:25,story-maker:12,*:10'),
  AI_MAX_TOKENS: z.coerce.number().int().default(6000),
  AI_MAX_PROMPT_CHARS: z.coerce.number().int().default(24000),
  AI_TIMEOUT_MS: z.coerce.number().int().default(45000),

  // Push to tablets after parent changes: a Firebase service account JSON file (FCM HTTP v1). Empty: no push.
  FCM_SERVICE_ACCOUNT_FILE: z.string().default(''),
  FCM_ENDPOINT: z.string().url().default('https://fcm.googleapis.com'),

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
    // SMTP_HOST is required too: without it sign-in links are written to the log, which is fine in development only.
    const missing = (['SESSION_SECRET', 'ADMIN_TOKEN', 'DATABASE_URL_APP', 'DATABASE_URL_SYSTEM', 'SMTP_HOST'] as const)
      .filter((k) => !cfg[k] || cfg[k].startsWith('dev-only') || cfg[k].includes('@127.0.0.1:5432/duckling'));
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(', ')}`);
  }
  return cfg;
}
