// Azure Speech REST synthesis. Returns MP3 bytes, or null when Azure is not configured or fails.
import type { Config } from './config.js';

export type Synth = (text: string, voice: string, rate: number) => Promise<Buffer | null>;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function makeAzureSynth(cfg: Config): Synth {
  return async (text, voice, rate) => {
    if (!cfg.AZURE_SPEECH_KEY) return null;
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${esc(voice)}">` +
      `<prosody rate="${rate >= 0 ? '+' : ''}${rate}%">${esc(text)}</prosody></voice></speak>`;
    const r = await fetch(`https://${cfg.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': cfg.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'duckling-backend',
      },
      body: ssml,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r || !r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  };
}
