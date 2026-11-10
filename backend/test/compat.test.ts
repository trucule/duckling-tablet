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

// webview: what Android's WebView offers, no speechSynthesis and no SpeechSynthesisUtterance, with the shell's own
// voice on the bridge (speak/stopSpeaking) answering through window.__ducklingVoice like DeviceVoice.kt does.
function page(appId: string, bridge: boolean, webview = false, childId = '') {
  const wv = webview ? `delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; delete Window.prototype.speechSynthesis; window.deviceSaid = [];` : '';
  const speak = webview ? `, speak: (id, text, rate) => { window.deviceSaid.push(text + '@' + rate); setTimeout(() => window.__ducklingVoice.start(id), 5); setTimeout(() => window.__ducklingVoice.end(id), 30); }, stopSpeaking: () => {}` : '';
  const b = bridge ? `${wv}window.DucklingApp = { ${childId ? `childId: () => ${JSON.stringify(childId)}, ` : ''}appId: () => ${JSON.stringify(appId)}, deviceToken: () => 'dev-token-1', apiUrl: () => location.origin + '/api', childName: () => 'Ada', voice: () => 'en-US-AnaNeural', levels: () => JSON.stringify({ math: 5, reading: -1 })${speak} };` : '';
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
      if (url.pathname === '/api/ai/messages' && req.method === 'POST') {
        let data = ''; req.on('data', (c) => { data += c; });
        req.on('end', () => {
          requests.push(`AI ${req.headers.authorization} ${req.headers['x-duckling-app']} ${req.headers['x-api-key'] ?? 'nokey'} ${data}`);
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
        });
        return;
      }
      if (url.pathname.startsWith('/api/device/child/')) {
        let data = ''; req.on('data', (c) => { data += c; });
        req.on('end', () => {
          requests.push(`HOME ${req.method} ${url.pathname} ${req.headers.authorization} ${req.headers['content-type'] ?? '-'} ${data.slice(0, 120)}`);
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          if (url.pathname.endsWith('/avatar') && req.method === 'GET') return res.end(JSON.stringify({ design: { hair: 'bob' }, owned: [], spent: 2, savedAt: 5, earned: 9, earnedByApp: { 'word-wizard': 6, 'count-with-me': 3 } }));
          if (url.pathname.endsWith('/stars')) return res.end(JSON.stringify({ earned: 11 }));
          res.end('{}');
        });
        return;
      }
      if (url.pathname === '/api/tts' && url.searchParams.get('voice') === 'en-US-GuyNeural') {
        requests.push(`CAST ${url.search}`);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' }); return res.end(TONE);
      }
      if (url.pathname === '/api/tts') {
        requests.push(`${req.headers.authorization} ${url.search}`);
        if (refuse) { res.writeHead(429); return res.end(); }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' }); return res.end(TONE);
      }
      const m = url.pathname.match(/^\/apps\/([a-z-]+)\/(index\.html|nobridge\.html|webview\.html)$/);
      if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(m[1], m[2] !== 'nobridge.html', m[2] === 'webview.html', url.searchParams.get('child') ?? '')); }
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
      // Levels: the parent's grade per subject, mapped onto an app's ladder (pre-K at the bottom, 8th at the top,
      // 2nd grade where the app used to start everyone); an unknown subject reads as 2nd grade.
      expect(await a.evaluate(() => [(window as any).KidTablet.grade('math'), (window as any).KidTablet.grade('reading'), (window as any).KidTablet.grade('music')])).toEqual([5, -1, 2]);
      expect(await a.evaluate(() => { const lf = (window as any).KidTablet.levelFor; return [lf('reading', 11, 2), lf('music', 11, 2), lf('math', 11, 2), lf('math', 1, 0)]; })).toEqual([0, 2, 6, 0]);
      // rungFor: the app names the grade of each rung; the child opens on the first rung at her grade, or the first
      // above it, or the top when none is above.
      expect(await a.evaluate(() => { const rf = (window as any).KidTablet.rungFor; const G = [-1, 0, 0, 1, 2, 2, 3, 4, 6, 8]; return [rf('reading', G), rf('music', G), rf('math', G), rf('math', [-1, 0, 1]), rf('math', [])]; })).toEqual([0, 4, 8, 2, 0]);

      // A spoken line: one request with the token, then start, word boundaries and end from the real clip.
      const tts = () => requests.filter((r) => r.startsWith('Device '));
      const events = await a.evaluate(() => window.sayAndWait('Tap the red one.'));
      expect(tts()).toHaveLength(1);
      expect(tts()[0]).toMatch(/^Device dev-token-1 \?text=Tap%20the%20red%20one\.&rate=0&voice=en-US-AnaNeural$/);
      expect(events[0]).toBe('start');
      expect(events.filter((e: string) => e.startsWith('boundary'))).toEqual(['boundary:0', 'boundary:4', 'boundary:8', 'boundary:12']);
      expect(events.at(-1)).toBe('end');
      // The same line again comes from the cache: no new request.
      await a.evaluate(() => window.sayAndWait('Tap the red one.'));
      expect(tts()).toHaveLength(1);
      // A line with the child's name is marked private.
      await a.evaluate(() => window.sayAndWait('Well done, Ada!'));
      expect(tts().at(-1)).toMatch(/text=Well%20done%2C%20Ada!&rate=0&voice=en-US-AnaNeural&private=1$/);
      // The daily allowance is used up: the device voice takes over and the utterance still finishes.
      refuse = true;
      const fallback = await a.evaluate(() => window.sayAndWait('Try the blue one.'));
      expect(fallback.at(-1)).toMatch(/end|error/);
      expect(tts()).toHaveLength(3);

      // An app's Anthropic call goes to the Duckling API with the device token and the app id, and no key.
      expect(await a.evaluate(() => (window as any).DWM_CONFIG.apiKey)).toBe('duckling');
      const ai = await a.evaluate(async () => {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'app-key', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) });
        return (await r.json()).content[0].text;
      });
      expect(ai).toBe('ok');
      expect(requests.at(-1)).toBe('AI Device dev-token-1 count-with-me nokey {"model":"m","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}');

      // The Surface home-screen service (KidHome) is answered by the child's profile: the avatar comes from the API,
      // a saved design and portrait go to it, and the star count adds the other apps' stars from the server.
      await a.waitForFunction(() => (window as any).KID_STARS && (window as any).KID_STARS.earned() === 9);
      await a.evaluate(() => { localStorage.setItem('math-progress', JSON.stringify({ level: 4, stars: 5 })); });
      await a.waitForFunction(() => (window as any).KID_STARS.earned() === 11); // 6 (word-wizard) + max(5 local, 3 served)
      // The report goes a moment after the save (one report for a burst of saves).
      await expect.poll(() => requests.filter((r) => r.includes('/device/child/stars')), { timeout: 5000 }).toContain('HOME POST /api/device/child/stars Device dev-token-1 application/json {"appId":"count-with-me","earned":5}');
      const home = await a.evaluate(async () => {
        const got = await (await fetch('http://127.0.0.1:47821/avatar')).json();
        await fetch('http://127.0.0.1:47821/avatar', { method: 'POST', body: JSON.stringify({ design: { hair: 'bun' }, owned: ['bun'], spent: 3, savedAt: 7 }) });
        await fetch('http://127.0.0.1:47821/portrait', { method: 'POST', body: 'data:image/png;base64,iVBORw0KGgo=' });
        return got;
      });
      expect(home.design).toEqual({ hair: 'bob' });
      expect(requests.filter((r) => r.startsWith('HOME')).slice(-3)).toEqual([
        'HOME GET /api/device/child/avatar Device dev-token-1 - ',
        'HOME PUT /api/device/child/avatar Device dev-token-1 application/json {"design":{"hair":"bun"},"owned":["bun"],"spent":3,"savedAt":7}',
        'HOME PUT /api/device/child/portrait Device dev-token-1 text/plain data:image/png;base64,iVBORw0KGgo=',
      ]);

      // Story Maker's cast: its Azure calls (voice list, then SSML with a voice, a rate and a style) are answered by
      // the narrator endpoint, and a line with the child's name is private.
      const cast = await a.evaluate(async () => {
        const list = await (await fetch('https://duckling.tts.speech.microsoft.com/cognitiveservices/voices/list', { headers: { 'Ocp-Apim-Subscription-Key': 'duckling' } })).json();
        const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="en-US-GuyNeural"><prosody rate="-6%"><mstts:express-as style="cheerful">Hello, Ada &amp; friends!</mstts:express-as></prosody></voice></speak>';
        const r = await fetch('https://duckling.tts.speech.microsoft.com/cognitiveservices/v1', { method: 'POST', headers: { 'Content-Type': 'application/ssml+xml' }, body: ssml });
        return { voices: list.map((v: any) => v.ShortName), ok: r.ok, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength, tts: (window as any).DWM_CONFIG.tts };
      });
      expect(cast.voices).toContain('en-US-AnaNeural');
      expect(cast).toMatchObject({ ok: true, type: 'audio/mpeg', tts: { provider: 'azure', region: 'duckling' } });
      expect(cast.bytes).toBeGreaterThan(100);
      expect(requests.filter((r) => r.startsWith('CAST')).at(-1)).toBe('CAST ?text=Hello%2C%20Ada%20%26%20friends!&rate=-6&voice=en-US-GuyNeural&style=cheerful&private=1');
      const before = requests.length;
      const c = await ctx.newPage(); await c.goto(`${base}/apps/count-with-me/nobridge.html`);
      expect(await c.evaluate(() => window.KidTablet.platform)).toBe('browser');
      expect(await c.evaluate(() => localStorage.getItem('progress'))).toBe('level 3'); // same app id, same namespace
      await c.evaluate(() => window.sayAndWait('Hello.'));
      expect(await c.evaluate(() => (window as any).DWM_CONFIG)).toBeUndefined();
      expect(await c.evaluate(() => (window as any).KID_STARS)).toBeUndefined();
      expect(requests).toHaveLength(before);

      // Android's WebView has no speech API at all. The narrator still speaks every line, the utterance's on*
      // handlers fire, and when the API refuses, the shell's own voice says the line and the end still arrives.
      refuse = false;
      const w = await ctx.newPage(); await w.goto(`${base}/apps/word-wizard/webview.html`);
      expect(await w.evaluate(() => typeof (window as any).speechSynthesis.speak)).toBe('function');
      const narrated = await w.evaluate(() => new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const u = new SpeechSynthesisUtterance('Spell the word cat.');
        u.onstart = () => seen.push('start'); u.onend = () => { seen.push('end'); resolve(seen); };
        speechSynthesis.speak(u);
      }));
      expect(narrated).toEqual(['start', 'end']);
      expect(tts().at(-1)).toMatch(/text=Spell%20the%20word%20cat\.&rate=0&voice=en-US-AnaNeural$/);
      expect(await w.evaluate(() => (window as any).deviceSaid)).toEqual([]);
      refuse = true;
      const device = await w.evaluate(() => new Promise<string[]>((resolve) => {
        const u = new SpeechSynthesisUtterance('Try again.'); u.rate = 0.9;
        u.onend = () => resolve((window as any).deviceSaid);
        speechSynthesis.speak(u);
      }));
      expect(device).toEqual(['Try again.@0.9']);

      // A tablet paired to one child and later to another: each child has her own saved progress and her own
      // IndexedDB (photos, recordings), so the second child opens at her own grade and sees nothing of the first.
      const saveAndRead = async (child: string, write: boolean) => {
        const q = await ctx.newPage(); await q.goto(`${base}/apps/read-it-say-it/index.html?child=${child}`);
        const r = await q.evaluate(async (w) => {
          const idb = (name: string) => new Promise<IDBDatabase>((ok, no) => { const o = indexedDB.open(name, 1); o.onupgradeneeded = () => o.result.createObjectStore('photos'); o.onsuccess = () => ok(o.result); o.onerror = () => no(o.error); });
          const db = await idb('camerafun');
          if (w) { localStorage.setItem('read-it-say-it-v1', JSON.stringify({ lv: 7 })); await new Promise((ok) => { const t = db.transaction('photos', 'readwrite'); t.objectStore('photos').put('selfie', 'p1'); t.oncomplete = ok; }); }
          const photo = await new Promise((ok) => { const g = db.transaction('photos').objectStore('photos').get('p1'); g.onsuccess = () => ok(g.result ?? null); });
          const names = (await indexedDB.databases()).map((d) => d.name);
          return { progress: localStorage.getItem('read-it-say-it-v1'), photo, names, keys: localStorage.length };
        }, write);
        await q.close(); return r;
      };
      const first = await saveAndRead('chd_first', true);
      expect(first).toMatchObject({ progress: '{"lv":7}', photo: 'selfie', names: ['camerafun'] });
      const second = await saveAndRead('chd_second', false);
      expect(second).toMatchObject({ progress: null, photo: null, keys: 0, names: ['camerafun'] });
      expect(await saveAndRead('chd_first', false)).toMatchObject({ progress: '{"lv":7}', photo: 'selfie' });
    } finally { await browser.close(); server.close(); }
  }, 60_000);
});

declare global { interface Window { KidTablet: { say: unknown; childName: string; platform: string }; sayAndWait(text: string): Promise<string[]>; events: string[] } }
