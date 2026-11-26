// The photo backdrops as served: every listed backdrop has its photo and its lighting, they go out with the right types
// and long caching to any origin, and a name that is not a backdrop file finds nothing.
// And as loaded on a tablet (tools/backdrops.js in a browser): a photo is downloaded once and kept; after that it loads
// with the API unreachable and without asking for the photo again, the app is told it is kept so it can show the photo
// with no drawn version before it, a lost copy answers null and is no longer called kept, and warm() fetches the
// photos the tablet does not have.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './pg.js';
import backdropRoutes, { BACKDROPS_DIR } from '../src/routes/backdrops.js';

const list = JSON.parse(readFileSync(join(BACKDROPS_DIR, 'backdrops.json'), 'utf8')) as { backdrops: Record<string, { sunAz: number; sunEl: number; sunColor: number[]; skyColor: number[]; groundColor: number[] }> };
const ids = Object.keys(list.backdrops);

describe('photo backdrops', () => {
  it('lists each backdrop with its photo, lighting, sun and colours', () => {
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const b = list.backdrops[id];
      expect(existsSync(join(BACKDROPS_DIR, `${id}.jpg`)), id).toBe(true);
      expect(existsSync(join(BACKDROPS_DIR, `${id}-light.png`)), id).toBe(true);
      expect(b.sunColor).toHaveLength(3); expect(b.skyColor).toHaveLength(3); expect(b.groundColor).toHaveLength(3);
      expect(Math.abs(b.sunEl)).toBeLessThanOrEqual(Math.PI / 2);
    }
  });

  it('serves the list, photos and lighting to any origin, and nothing else', async () => {
    const app = Fastify(); await app.register(backdropRoutes, {});
    const res = await app.inject({ url: '/backdrops/backdrops.json', headers: { origin: 'duckling-app://local' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const photo = await app.inject({ url: `/backdrops/${ids[0]}.jpg` });
    expect(photo.statusCode).toBe(200); expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.headers['cache-control']).toBe('public, max-age=2592000');
    expect([...photo.rawPayload.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    const light = await app.inject({ url: `/backdrops/${ids[0]}-light.png` });
    expect(light.statusCode).toBe(200); expect(light.headers['content-type']).toBe('image/png');
    for (const bad of ['/backdrops/..%2Fbackdrops.json', '/backdrops/nope.jpg', '/backdrops/Meadow.jpg', '/backdrops/..%2F..%2Fbackend%2Fpackage.json', `/backdrops/${ids[0]}.png`])
      expect((await app.inject({ url: bad })).statusCode, bad).toBe(404);
  });

  it('keeps a photo on the tablet: later loads need no API, a lost copy falls back, and warm() fetches the rest', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const three = readFileSync(join(root, 'apps', 'story-maker', 'three.min.js')), loader = readFileSync(join(root, 'tools', 'backdrops.js'));
    const port = await freePort();
    const server = createServer((req, res) => {
      if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(three); return; }
      if (req.url === '/backdrops.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(loader); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><script>window.KidTablet = { apiUrl: "https://api.example.test" };</script><script src="/three.js"></script><script src="/backdrops.js"></script>');
    }).listen(port, '127.0.0.1');
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      let up = true; const asked: string[] = [];
      await ctx.route('https://api.example.test/**', async (r) => {
        const name = new URL(r.request().url()).pathname.replace('/backdrops/', '');
        asked.push(name);
        if (!up) return r.abort();
        const file = join(BACKDROPS_DIR, name);
        if (!existsSync(file)) return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
        return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: name.endsWith('.json') ? 'application/json' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', body: readFileSync(file) });
      });
      const [a, b] = ids;
      const open = async () => { const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/`); return page; };
      const load = (page: import('playwright').Page, id: string) => page.evaluate(async (i) => {
        const B = (window as any).DucklingBackdrops, before = B.kept(i), set = await B.load(i, {});
        return { before, after: B.kept(i), ok: !!(set && set.map && set.map.image && set.light && set.meta), width: set ? set.map.image.width : 0 };
      }, id);

      // First visit: downloaded, decoded, kept.
      let page = await open();
      expect(await load(page, a)).toEqual({ before: false, after: true, ok: true, width: 4096 });
      expect(asked.filter((n) => n === `${a}.jpg`)).toHaveLength(1);
      await page.close();

      // Later visit with the API unreachable: known as kept before anything loads, and loaded from the tablet's copy.
      up = false; asked.length = 0;
      page = await open();
      expect(await load(page, a)).toEqual({ before: true, after: true, ok: true, width: 4096 });
      expect(asked.filter((n) => n !== 'backdrops.json')).toEqual([]);
      // A place the tablet does not have cannot be had offline: null, and the app keeps its drawn version.
      expect(await load(page, b)).toEqual({ before: false, after: false, ok: false, width: 0 });
      await page.close();

      // warm() downloads what is missing, and nothing that is kept.
      up = true; asked.length = 0;
      page = await open();
      await page.evaluate(([x, y]) => (window as any).DucklingBackdrops.warm([x, y]), [a, b]);
      await page.waitForFunction((y) => (window as any).DucklingBackdrops.kept(y), b, { timeout: 15_000 });
      expect(asked).toContain(`${b}.jpg`); expect(asked).toContain(`${b}-light.png`); expect(asked).not.toContain(`${a}.jpg`);
      await page.close();

      // The tablet's copy is gone (storage cleared) and the API is unreachable: null, and no longer called kept.
      up = false;
      page = await open();
      await page.evaluate(() => new Promise<void>((res) => { const r = indexedDB.deleteDatabase('duckling-backdrops'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
      await page.close();
      page = await open();
      expect(await load(page, a)).toEqual({ before: true, after: false, ok: false, width: 0 });
    } finally { await browser.close(); server.close(); }
  }, 60_000);
});
