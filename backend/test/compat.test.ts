// The compatibility layer that the publish tool writes into every package, driven in Chromium with a fake shell
// bridge and a fake API: per-app localStorage, the narrator request with the device token, private lines for the
// child's name, start/boundary/end events from a real clip, and the device-voice fallback when the API refuses.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './pg.js';

const COMPAT = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'duckling-compat.js'), 'utf8');
const TONE = readFileSync(join(import.meta.dirname, 'fixtures', 'tone.mp3'));

function page(appId: string, bridge: boolean) {
  const b = bridge ? `window.DucklingApp = { appId: () => ${JSON.stringify(appId)}, deviceToken: () => 'dev-token-1', apiUrl: () => location.origin + '/api', childName: () => 'Ada', voice: () => 'en-US-AnaNeural' };` : '';
  return `<!doctype html><html><head><script>${b}</script><script>${COMPAT}</script></head><body><div id="log"></div>
  <script>
    window.events = [];
    window.sayAndWait = (text) => new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      for (const t of ['start', 'boundary', 'end', 'error']) u.addEventListener(t, (e) => { window.events.push(t + (t === 'boundary' ? ':' + e.charIndex : '')); if (t === 'end' || t === 'error') resolve(window.events); });
      speechSynthesis.speak(u);
    });
  </script></body></html>`;
}

describe('duckling-compat.js', () => {
  it('namespaces storage, asks the API for clips with the device token, plays them with events, and falls back', async () => {
    const { chromium } = await import('playwright');
    const requests: string[] = [];
    let refuse = false;
    const port = await freePort();
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/api/tts') {
        requests.push(`${req.headers.authorization} ${url.search}`);
        if (refuse) { res.writeHead(429); return res.end(); }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' }); return res.end(TONE);
      }
      const m = url.pathname.match(/^\/apps\/([a-z-]+)\/(index\.html|nobridge\.html)$/);
      if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(m[1], m[2] === 'index.html')); }
      res.writeHead(404); res.end();
    }).listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext();
    try {
      // Two apps on one origin keep their storage apart.
      const a = await ctx.newPage(); await a.goto(`${base}/apps/count-with-me/index.html`);
      await a.evaluate(() => { localStorage.setItem('progress', 'level 3'); });
      const b = await ctx.newPage(); await b.goto(`${base}/apps/robot-path/index.html`);
      expect(await b.evaluate(() => localStorage.getItem('progress'))).toBeNull();
      await b.evaluate(() => { localStorage.setItem('progress', 'board 7'); });
      expect(await a.evaluate(() => localStorage.getItem('progress'))).toBe('level 3');
      expect(await a.evaluate(() => localStorage.length)).toBe(1);
      expect(await a.evaluate(() => Object.keys(window.KidTablet))).toContain('say');
      expect(await a.evaluate(() => window.KidTablet.childName)).toBe('Ada');

      // A spoken line: one request with the token, then start, word boundaries and end from the real clip.
      const events = await a.evaluate(() => window.sayAndWait('Tap the red one.'));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/^Device dev-token-1 \?text=Tap%20the%20red%20one\.&rate=0&voice=en-US-AnaNeural$/);
      expect(events[0]).toBe('start');
      expect(events.filter((e: string) => e.startsWith('boundary'))).toEqual(['boundary:0', 'boundary:4', 'boundary:8', 'boundary:12']);
      expect(events.at(-1)).toBe('end');
      // The same line again comes from the cache: no new request.
      await a.evaluate(() => window.sayAndWait('Tap the red one.'));
      expect(requests).toHaveLength(1);
      // A line with the child's name is marked private.
      await a.evaluate(() => window.sayAndWait('Well done, Ada!'));
      expect(requests.at(-1)).toMatch(/text=Well%20done%2C%20Ada!&rate=0&voice=en-US-AnaNeural&private=1$/);
      // The daily allowance is used up: the device voice takes over and the utterance still finishes.
      refuse = true;
      const fallback = await a.evaluate(() => window.sayAndWait('Try the blue one.'));
      expect(fallback.at(-1)).toMatch(/end|error/);
      expect(requests).toHaveLength(3);

      // Without a shell bridge nothing is intercepted: no request leaves the page.
      const c = await ctx.newPage(); await c.goto(`${base}/apps/count-with-me/nobridge.html`);
      expect(await c.evaluate(() => window.KidTablet.platform)).toBe('browser');
      expect(await c.evaluate(() => localStorage.getItem('progress'))).toBe('level 3'); // same app id, same namespace
      await c.evaluate(() => window.sayAndWait('Hello.'));
      expect(requests).toHaveLength(3);
    } finally { await browser.close(); server.close(); }
  }, 60_000);
});

declare global { interface Window { KidTablet: { say: unknown; childName: string; platform: string }; sayAndWait(text: string): Promise<string[]>; events: string[] } }
