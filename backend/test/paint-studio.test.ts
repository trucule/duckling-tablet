// Paint Studio's Text tool in Chromium, served as files the way a tablet's app runner serves a package: the nine
// bundled fonts load from their bytes, typed words show on the page while typing and can be dragged, Done paints them
// onto the current layer as one step Undo takes back, and picking another tool places typed words. Screenshots go to
// WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fontRoutes from '../src/routes/fonts.js';
import { freePort } from './pg.js';

const APP = join(import.meta.dirname, '..', '..', 'apps', 'paint-studio');
let server: Server, url: string, fontApi: FastifyInstance, api: string;
beforeAll(async () => {
  const port = await freePort();
  // Fonts go out as application/octet-stream, the type a shell may give a file it does not know.
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
  server = createServer((req, res) => {
    const p = join(APP, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!p.startsWith(APP) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
  url = `http://127.0.0.1:${port}/index.html`;
  // The API's font library on its own origin, as on a tablet.
  fontApi = Fastify(); await fontApi.register(fontRoutes, {});
  const apiPort = await freePort(); await fontApi.listen({ port: apiPort, host: '127.0.0.1' }); api = `http://127.0.0.1:${apiPort}`;
});
afterAll(async () => { server?.close(); await fontApi?.close(); });

describe('Paint Studio text', () => {
  it('types, moves, places and undoes words in the bundled fonts', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    // Every font loaded and is in the document's font set.
    await p.waitForFunction(() => document.fonts.size >= 9 && [...document.fonts].every((f) => f.status === 'loaded'));
    expect(await p.evaluate(() => [...document.fonts].filter((f) => f.family.startsWith('PS ')).length)).toBe(9);
    const ink = () => p.evaluate(() => {
      // Painted pixels, read from the visible canvas over white paper.
      const v = document.getElementById('view') as HTMLCanvasElement, d = v.getContext('2d')!.getImageData(0, 0, v.width, v.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++; return n;
    });
    const box = await p.locator('#view').boundingBox();
    const at = (x: number, y: number) => ({ x: box!.x + (x / 1280) * box!.width, y: box!.y + (y / 800) * box!.height });

    await p.getByRole('button', { name: 'Text', exact: true }).click();
    let c = at(300, 300); await p.mouse.click(c.x, c.y);
    await p.getByLabel('Words').waitFor();
    expect(await p.evaluate(() => document.activeElement?.id)).toBe('textInput');
    await p.getByLabel('Words').fill('Hello Duckling');
    const typed = await ink();
    expect(typed).toBeGreaterThan(500);
    // The same words in another font draw differently.
    await p.locator('#fonts button', { hasText: 'Fancy' }).click();
    const fancy = await p.evaluate(() => (document.getElementById('view') as HTMLCanvasElement).toDataURL());
    await p.locator('#fonts button', { hasText: 'Pixel' }).click();
    expect(await p.evaluate(() => (document.getElementById('view') as HTMLCanvasElement).toDataURL())).not.toBe(fancy);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'paint-text-typing.png') });
    // Dragging the words moves them.
    const before = await p.evaluate(() => ({ x: (window as any).draft.x, y: (window as any).draft.y }));
    c = at(320, 310); await p.mouse.move(c.x, c.y); await p.mouse.down();
    const to = at(620, 520); await p.mouse.move(to.x, to.y, { steps: 6 }); await p.mouse.up();
    const after = await p.evaluate(() => ({ x: (window as any).draft.x, y: (window as any).draft.y }));
    expect(after.x - before.x).toBeGreaterThan(250); expect(after.y - before.y).toBeGreaterThan(180);
    // Done paints them on the layer; Undo takes them off.
    await p.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await p.locator('#textpanel').isVisible()).toBe(false);
    expect(await p.evaluate(() => (window as any).draft)).toBeNull();
    // With the draft gone, what shows is the layer itself.
    expect(await ink()).toBeGreaterThan(300);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'paint-text-placed.png') });
    await p.getByRole('button', { name: 'Undo' }).click();
    expect(await ink()).toBe(0);
    // Typed words are placed when another tool is picked; empty words are dropped.
    c = at(200, 600); await p.mouse.click(c.x, c.y);
    await p.getByLabel('Words').fill('Hi');
    await p.getByRole('button', { name: 'Brush', exact: true }).click();
    expect(await ink()).toBeGreaterThan(50);
    await p.getByRole('button', { name: 'Text', exact: true }).click();
    c = at(900, 200); await p.mouse.click(c.x, c.y);
    await p.getByRole('button', { name: 'Cancel' }).click();
    expect(await p.locator('#textpanel').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);

  it('picks a font from the library on the server, keeps it, and works offline with the fonts it kept', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(`window.KidTablet = { apiUrl: ${JSON.stringify(api)} };`);
    const p = await ctx.newPage();
    const errors: string[] = [], files: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('request', (r) => { if (r.url().includes('/fonts/files/')) files.push(r.url()); });
    await p.goto(url);
    const box = await p.locator('#view').boundingBox();
    const at = (x: number, y: number) => ({ x: box!.x + (x / 1280) * box!.width, y: box!.y + (y / 800) * box!.height });
    const page = () => p.evaluate(() => (document.getElementById('view') as HTMLCanvasElement).toDataURL());
    await p.getByRole('button', { name: 'Text', exact: true }).click();
    const c = at(400, 500); await p.mouse.click(c.x, c.y);
    await p.getByLabel('Words').fill('Hello there');
    const before = await page();

    await p.getByRole('button', { name: 'More fonts' }).click();
    await p.locator('#fontGroups button', { hasText: 'Handwriting' }).waitFor();
    await expect.poll(() => p.locator('#fontTiles .ftile').count()).toBeGreaterThan(200);
    for (const g of ['Fun', 'Book', 'Plain', 'Typewriter', 'Mine']) await p.locator('#fontGroups button', { hasText: g }).waitFor();
    await p.locator('#fontGroups button', { hasText: 'Fun' }).click();
    await expect.poll(() => p.locator('#fontTiles .ftile').count()).toBeGreaterThan(300);
    // The tiles are cut from the preview sheets, with no font downloaded yet.
    await p.waitForTimeout(500);
    expect(await p.locator('#fontTiles .ftile.text').count()).toBe(0);
    expect(files).toEqual([]);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'paint-fontlib.png') });
    await p.getByLabel('Find a font').fill('lobst');
    await expect.poll(() => p.locator('#fontTiles .ftile').count()).toBeGreaterThan(0);
    await p.getByRole('button', { name: 'Lobster', exact: true }).click();
    await expect.poll(() => p.locator('#fontlib').isVisible()).toBe(false);
    expect(files.filter((f) => f.endsWith('/fonts/files/lobster.woff2'))).toHaveLength(1);
    expect(await p.locator('#fonts button.on').getAttribute('data-font')).toBe('lobster');
    expect(await p.evaluate(() => document.activeElement?.id)).toBe('textInput');
    expect(await page()).not.toBe(before);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'paint-fontlib-picked.png') });
    await p.getByRole('button', { name: 'Done', exact: true }).click();

    // After a restart the kept font is in the bar and chosen, with nothing downloaded.
    files.length = 0;
    await p.reload();
    await expect.poll(() => p.locator('#fonts button[data-font="lobster"]').count()).toBe(1);
    expect(await p.evaluate(() => document.fonts.check('20px "PS lobster"'))).toBe(true);
    expect(files).toEqual([]);

    // Offline: the list comes from the copy kept on the tablet; a kept font is under Mine; another font says why not.
    await ctx.setOffline(true);
    await p.getByRole('button', { name: 'Text', exact: true }).click();
    const c2 = at(300, 300); await p.mouse.click(c2.x, c2.y);
    await p.getByRole('button', { name: 'More fonts' }).click();
    await p.locator('#fontGroups button', { hasText: 'Mine' }).click();
    await expect.poll(() => p.locator('#fontTiles .ftile').count()).toBe(1);
    await p.locator('#fontGroups button', { hasText: 'Handwriting' }).click();
    await p.locator('#fontTiles .ftile').first().click();
    await p.getByText('That font needs the internet', { exact: false }).waitFor();
    expect(errors).toEqual([]);
    await browser.close();
  }, 90_000);
});
