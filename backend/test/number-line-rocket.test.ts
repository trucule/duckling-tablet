// Number Line Rocket: the child's portrait rides in the rocket's porthole (KidTablet.portrait over the real
// compatibility script and a fake shell bridge), and a guess on 0 to 100 has marks every 10 to count and shows the
// number the rocket landed on. Screenshots go to WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { freePort } from './pg.js';

const APP = join(import.meta.dirname, '..', '..', 'apps', 'number-line-rocket');
const COMPAT = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'duckling-compat.js'), 'utf8');
let server: Server, url: string;
beforeAll(async () => {
  const port = await freePort();
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
  server = createServer((req, res) => {
    const p = join(APP, decodeURIComponent((req.url ?? '/').split('?')[0]));
    if (!p.startsWith(APP) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(port, '127.0.0.1');
  url = `http://127.0.0.1:${port}/index.html`;
});
afterAll(() => { server?.close(); });

const PORTRAIT = readFileSync(join(import.meta.dirname, '..', '..', 'apps', 'my-avatar', 'tile.png'));

async function open(portrait: boolean) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(`localStorage.setItem('number-line-rocket-v1', JSON.stringify({ lv: 4, streak: 0, miss: 0, stars: 0 }));`);
  await ctx.addInitScript(`window.DucklingApp = { appId: () => 'number-line-rocket', deviceToken: () => 'dev-1', apiUrl: () => 'https://api.example.test', childId: () => 'chd_1', childName: () => 'Ada', voice: () => 'en-US-AnaNeural', levels: () => '{"math":1}' };`);
  await ctx.addInitScript(COMPAT);
  const said: string[] = [];
  await ctx.route('https://api.example.test/**', async (r) => {
    const u = new URL(r.request().url()), cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/device/child/portrait') return portrait ? r.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: PORTRAIT }) : r.fulfill({ status: 404, headers: cors, body: '{}' });
    if (u.pathname === '/tts') { said.push(u.searchParams.get('text')!); return r.fulfill({ status: 404, headers: cors, body: '' }); }
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' });
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => typeof (window as any).DucklingLadder === 'object');
  return { browser, p, errors, said };
}

describe('Number Line Rocket', () => {
  it('flies the child in the porthole and shows where a guess landed', async () => {
    const { browser, p, errors } = await open(true);
    // The porthole's picture becomes the portrait (an image, not the astronaut's canvas).
    await p.waitForFunction(`(() => { const m = rocket && rocket.userData.pilot.material.map; return !!m && !!m.image && m.image.tagName === 'IMG'; })()`, null, { timeout: 10_000 });
    const task = await p.evaluate(`({ text: T.text, tick: T.tick, estimate: T.estimate, prompt: document.getElementById('prompt').textContent })`) as { text: string; tick: number; estimate: boolean; prompt: string };
    expect(task.estimate).toBe(true);
    expect(task.tick).toBe(10);
    expect(task.prompt).toContain('The marks count by 10.');
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'rocket-guess.png') });
    // Tap 20 past the target (or 20 before it near the end), launch, and read the landing.
    const at = await p.evaluate(`(() => {
      const v = T.value > 70 ? T.value - 20 : T.value + 20, w = new THREE.Vector3(xOf(T, v), LINE_Y, 0).project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return { v, x: r.left + (w.x + 1) / 2 * r.width, y: r.top + (1 - w.y) / 2 * r.height };
    })()`) as { v: number; x: number; y: number };
    await p.mouse.click(at.x, at.y);
    await p.locator('#launchBtn').click();
    await p.waitForFunction('!!reveal', null, { timeout: 10_000 });
    // The gold star, its number, the red gap, and the green number where the rocket landed.
    expect(await p.evaluate('reveal.children.length')).toBe(4);
    expect(await p.evaluate('Math.round(picked)')).toBe(at.v);
    if (process.env.WEB_SHOTS) { await p.waitForTimeout(700); await p.screenshot({ path: join(process.env.WEB_SHOTS, 'rocket-landed.png') }); }
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);

  it('keeps the astronaut when the child has no portrait', async () => {
    const { browser, p, errors } = await open(false);
    await p.waitForTimeout(1500);
    const tag = await p.evaluate('rocket.userData.pilot.material.map.image.tagName');
    expect(tag).toBe('CANVAS');
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);
});
