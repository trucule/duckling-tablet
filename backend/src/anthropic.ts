// The Anthropic Messages API, called with the server's key on behalf of an app on a paired tablet. The apps keep
// their own prompts; this is the one place the key is used. Returns the upstream status and parsed body, or null
// when the key is not configured or the call fails to complete.
import type { Config } from './config.js';

export interface AiRequest { model: string; max_tokens: number; system?: string; messages: { role: 'user' | 'assistant'; content: string }[] }
export interface AiResult { status: number; body: unknown }
export type Complete = (req: AiRequest) => Promise<AiResult | null>;

export function makeAnthropic(cfg: Config): Complete {
  return async (req) => {
    if (!cfg.ANTHROPIC_API_KEY) return null;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'user-agent': 'duckling-backend' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(cfg.AI_TIMEOUT_MS),
    }).catch(() => null);
    if (!r) return null;
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  };
}
