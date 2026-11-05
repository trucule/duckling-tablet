// Logging rules (build plan, section 6): never log tokens, PINs, child names or email bodies.
// - Request lines carry the path only; query strings are dropped because /tts?text=... can carry a spoken line and a
//   sign-in or pairing flow can carry a token.
// - Credential headers are redacted, and so is any object field that looks like a secret, wherever it appears in a
//   log call (a token, a PIN, a password).
// - Response bodies and request bodies are never logged; nothing here changes that.
import type { FastifyServerOptions } from 'fastify';

export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-etducky-signature"]',
  'req.headers["stripe-signature"]', 'res.headers["set-cookie"]',
  '*.token', '*.sessionToken', '*.deviceToken', '*.deviceTokenHash', '*.password', '*.pin', '*.pinHash', '*.secret',
  '*.apiKey', '*.authorization', '*.cookie', '*.email', '*.firstName', '*.first_name',
];

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

// Pino options for Fastify. `extra` lets tests attach a stream; production adds nothing.
export function loggerOptions(extra: Record<string, unknown> = {}): LoggerOptions {
  return {
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req(req: { method: string; url: string; ip?: string; id?: unknown }) {
        return { method: req.method, url: pathOnly(req.url), remoteAddress: req.ip };
      },
      res(res: { statusCode: number }) { return { statusCode: res.statusCode }; },
    },
    ...extra,
  } as LoggerOptions;
}

export const pathOnly = (url: string) => url.split('?')[0];

// For free text that may carry a secret (an upstream error message, a URL): masks token-like query values and
// bearer credentials before the text reaches a log line.
export function redactText(s: string): string {
  return s
    .replace(/([?&](?:token|code|key|secret|signature|session|pin)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Device)\s+[A-Za-z0-9_\-.=]{8,}/g, '$1 [redacted]');
}
