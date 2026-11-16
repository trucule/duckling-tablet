// Camera Fun on a Duckling tablet: a saved photo opened from the gallery offers Home screen, which makes it the
// background of this tablet only. The real compatibility script runs over a fake shell bridge: the photo goes to the
// shell (DucklingApp.setLocalBackground) and nothing goes to the network. A shell without setLocalBackground (older
// builds) and a plain browser get no button. The camera is Chromium's fake device. Screenshots go to WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { freePort } from './pg.js';

const APP = join(import.meta.dirname, '..', '..', 'apps', 'camera-fun');
const COMPAT = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'duckling-compat.js'), 'utf8');
let server: Server, url: string;
beforeAll(async () => {
  const port = await freePort();
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm' };
  server = createServer((req, res) => {
    const p = join(APP, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!p.startsWith(APP) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
  url = `http://127.0.0.1:${port}/index.html`;
});
afterAll(() => { server?.close(); });

type Shell = 'new' | 'old' | 'browser';
async function withPhoto(shell: Shell) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
  const hold = shell === 'new' ? `, setLocalBackground: (d) => { window.__local = d; return true; }` : '';
  if (shell !== 'browser') await ctx.addInitScript(`window.DucklingApp = { appId: () => 'camera-fun', deviceToken: () => 'dev-1', apiUrl: () => 'https://api.example.test', childId: () => 'chd_1', childName: () => 'Ada', voice: () => 'en-US-AnaNeural', levels: () => '{}'${hold} };`);
  await ctx.addInitScript(COMPAT);
  // Every request that leaves the page's own server, and any upload of a background.
  const away: string[] = [];
  await ctx.route('https://api.example.test/**', (r) => { away.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`); return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }); });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForFunction(() => !!(window as any).CF);
  // A saved photo: a 1280 by 720 picture with a red square, as the camera would store it.
  await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d')!;
    g.fillStyle = '#3aa0ff'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#e63946'; g.fillRect(500, 200, 280, 280);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    await new Promise<void>((ok, no) => { const r = indexedDB.open('camerafun', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => { const t = r.result.transaction('photos', 'readwrite'); t.objectStore('photos').add({ time: Date.now(), blob, w: 1280, h: 720 }); t.oncomplete = () => ok(); t.onerror = () => no(t.error); }; });
    await (window as any).CF.openGallery();
  });
  await p.locator('#grid canvas').first().click();
  await p.locator('#view.on').waitFor();
  return { browser, p, away };
}

describe('Camera Fun home screen background', () => {
  it('hands a saved photo to the shell for this tablet only and uploads nothing', async () => {
    const { browser, p, away } = await withPhoto('new');
    const btn = p.getByRole('button', { name: '🏠 Home screen' });
    await btn.waitFor();
    await btn.click();
    await p.getByRole('button', { name: '🏠 Your home screen' }).waitFor();
    const d = await p.evaluate(() => (window as any).__local as string);
    expect(d.startsWith('data:image/jpeg;base64,')).toBe(true);
    // The photo itself went, at its own size: the middle is the red square.
    const px = await p.evaluate(async (src) => { const im = new Image(); im.src = src; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d')!; g.drawImage(im, 0, 0); return [im.width, im.height, ...g.getImageData(640, 340, 1, 1).data]; }, d);
    expect(px.slice(0, 2)).toEqual([1280, 720]);
    expect(px[2]).toBeGreaterThan(180); expect(px[4]).toBeLessThan(110);
    expect(away.filter((r) => /background/.test(r))).toEqual([]);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'camera-home-bg.png') });
    await browser.close();
  }, 60_000);

  it('a painting chosen on the tablet goes to her profile and replaces the tablet photo', async () => {
    const { browser, p, away } = await withPhoto('new');
    await p.evaluate(async () => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; await (window as any).KidTablet.setHomeBackground(c); });
    expect(away).toContain('PUT /device/child/background');
    expect(await p.evaluate(() => (window as any).__local)).toBe('none');
    await browser.close();
  }, 60_000);

  it('offers nothing on an older shell or in a plain browser', async () => {
    for (const shell of ['old', 'browser'] as const) {
      const { browser, p } = await withPhoto(shell);
      expect(await p.locator('#homeBg').isVisible()).toBe(false);
      await browser.close();
    }
  }, 90_000);
});
