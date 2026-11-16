// Camera Fun on a Duckling tablet: a saved photo opened from the gallery offers Home screen, which hands the photo to
// KidTablet.setHomeBackground (the compatibility script sends it to the child's profile). In a plain browser the
// button stays hidden. The camera is Chromium's fake device. Screenshots go to WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { freePort } from './pg.js';

const APP = join(import.meta.dirname, '..', '..', 'apps', 'camera-fun');
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

async function withPhoto(duckling: boolean) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
  if (duckling) await ctx.addInitScript(`window.KidTablet = { platform: 'duckling', setHomeBackground: (c) => new Promise((ok) => setTimeout(() => { window.__bg = { w: c.width, h: c.height, data: c.toDataURL('image/jpeg', 0.8) }; ok({ ok: true }); }, 200)) };`);
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
  return { browser, p };
}

describe('Camera Fun home screen background', () => {
  it('sends a saved photo to be the home screen background on a Duckling tablet', async () => {
    const { browser, p } = await withPhoto(true);
    const btn = p.getByRole('button', { name: '🏠 Home screen' });
    await btn.waitFor();
    await btn.click();
    await p.getByRole('button', { name: '🏠 Your home screen' }).waitFor();
    const bg = await p.evaluate(() => (window as any).__bg);
    expect([bg.w, bg.h]).toEqual([1280, 720]);
    // The photo itself went: the middle is the red square.
    const px = await p.evaluate(async (d) => { const im = new Image(); im.src = d; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d')!; g.drawImage(im, 0, 0); return [...g.getImageData(640, 340, 1, 1).data]; }, bg.data);
    expect(px[0]).toBeGreaterThan(180); expect(px[2]).toBeLessThan(110);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'camera-home-bg.png') });
    await browser.close();
  }, 60_000);

  it('offers nothing in a plain browser', async () => {
    const { browser, p } = await withPhoto(false);
    expect(await p.locator('#homeBg').isVisible()).toBe(false);
    await browser.close();
  }, 60_000);
});
