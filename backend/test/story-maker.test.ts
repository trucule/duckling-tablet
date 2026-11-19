// Story Maker acts each story out on a 3D stage, and it follows the tablet's language. The real compatibility script runs over a fake shell bridge whose
// narrator voice is the family's (an es- voice for a Spanish family). In Spanish the screen and the spoken prompts are
// Spanish, the writer is told to write in Spanish, and every line is spoken by a Spanish voice; in English nothing
// changes. The compatibility script itself speaks a line with an English voice unless the line is marked Spanish, so
// an app that is not translated yet is never read by a Spanish voice. Screenshots go to WEB_SHOTS when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { freePort } from './pg.js';

const APP = join(import.meta.dirname, '..', '..', 'apps', 'story-maker');
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

// A tenth of a second of silence, as a WAV file, for every narrator clip.
const SILENCE = (() => {
  const n = 2205, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
})();
// One scene as the writer would send it, in the language asked for.
const scene = (es: boolean) => JSON.stringify({
  title: es ? 'El globo rojo' : 'The red balloon', emoji: ['🎈', '🏰'],
  lines: [{ who: 'narrator', text: es ? 'Un día de sol, Bun llegó a un castillo.' : 'One sunny day, Bun came to a castle.', act: [{ who: 'bun', move: 'front', do: 'wave' }] },
    { who: 'bun', text: es ? '¡Qué bonito!' : 'How lovely!', mood: 'cheerful', act: [{ do: 'jump', prop: '🗺️' }, { do: 'fly' }] }],
  choices: [{ label: es ? 'Entrar' : 'Go in', emoji: '🚪' }, { label: es ? 'Esperar' : 'Wait', emoji: '⏳' }], summary: 'x',
  premise: es ? 'Bun quiere encontrar la corona perdida del castillo.' : 'Bun wants to find the castle\'s lost crown.'
});

// gl: 'on' gives the browser software WebGL, so the 3D stage runs; 'off' turns WebGL off, so the emoji strip shows.
const GL: Record<string, string[]> = { on: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], off: ['--disable-3d-apis'], default: [] };
async function open(voice: string, gl: 'on' | 'off' | 'default' = 'default') {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: GL[gl] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(`window.DucklingApp = { appId: () => 'story-maker', deviceToken: () => 'dev-1', apiUrl: () => 'https://api.example.test', childId: () => 'chd_1', childName: () => 'Ada', voice: () => '${voice}', levels: () => '{"reading":0}' };`);
  await ctx.addInitScript(COMPAT);
  const tts: { voice: string; text: string }[] = [], ai: any[] = [];
  const es = /^es-/.test(voice);
  await ctx.route('https://api.example.test/**', async (r) => {
    const u = new URL(r.request().url()), cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/tts') { tts.push({ voice: u.searchParams.get('voice')!, text: u.searchParams.get('text')! }); return r.fulfill({ status: 200, contentType: 'audio/wav', headers: cors, body: SILENCE }); }
    if (u.pathname === '/ai/messages') {
      ai.push(JSON.parse(r.request().postData() ?? '{}'));
      return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ content: [{ type: 'text', text: scene(es) }] }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' });
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => !!(window as any).STORY);
  return { browser, p, tts, ai, errors };
}

async function tellOne(p: import('playwright').Page) {
  await p.locator('#cast .pick').first().click();
  for (const box of ['places', 'kinds', 'dramas', 'lengths']) await p.locator(`#${box} .pick`).first().click();
  await p.locator('#go').click();
  await p.locator('#text p').first().waitFor();
}

describe('Story Maker openings', () => {
  it('starts each story at its beginning and keeps later scenes on the premise scene 1 set', async () => {
    const { browser, p, ai, errors } = await open('en-US-JennyNeural');
    await tellOne(p);
    expect(ai).toHaveLength(1);
    const first = ai[0].messages[0].content as string;
    expect(first).toContain('This is the OPENING scene, so begin at the beginning.');
    expect(first).toContain('"premise"');
    await p.getByRole('button', { name: /Go in/ }).click();
    await expect.poll(() => ai.length, { timeout: 20_000 }).toBe(2);
    const second = ai[1].messages[0].content as string;
    expect(second).toContain("The story began like this: Bun wants to find the castle's lost crown.");
    expect(second).not.toContain('OPENING scene');
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);
});

describe('Story Maker stage', () => {
  it('acts out each line on a 3D set for the place, from the stage directions the writer sends', async () => {
    const { browser, p, ai, errors } = await open('en-US-JennyNeural', 'on');
    await tellOne(p);
    expect(await p.evaluate(() => (window as any).STAGE.ok)).toBe(true);
    await p.locator('#scene.stage canvas').waitFor();
    expect(await p.locator('#scene span').count()).toBe(0);
    const user = ai[0].messages[0].content as string;
    expect(user).toContain('acted out by small 3D figures');
    expect(user).toContain('"act": [{"who"');
    // Directions are kept when every value is the stage's own; a direction with nothing usable left is dropped.
    const acts = await p.evaluate(() => (window as any).STORY.story.scenes[0].lines.map((l: any) => l.act));
    expect(acts).toEqual([[{ who: 'bun', move: 'front', do: 'wave', face: '', prop: '' }], [{ who: 'bun', move: '', do: 'jump', face: '', prop: '🗺️' }]]);
    const dbg = () => p.evaluate(() => (window as any).STAGE.debug());
    expect((await dbg()).set).toBe('castle');
    // Bun walks on, then to the front of the set for the narrator's line.
    await expect.poll(async () => (await dbg()).actors[0]?.z ?? 0, { timeout: 30_000 }).toBeGreaterThan(2.4);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'story-maker-stage.png') });
    // The cast's line: Bun holds the map.
    await expect.poll(async () => (await dbg()).props, { timeout: 30_000 }).toBe(1);
    expect(errors).toEqual([]);
    await browser.close();
  }, 90_000);

  it('shows the emoji strip when the tablet has no WebGL', async () => {
    const { browser, p, errors } = await open('en-US-JennyNeural', 'off');
    await tellOne(p);
    expect(await p.evaluate(() => (window as any).STAGE.ok)).toBe(false);
    expect(await p.locator('#scene canvas').count()).toBe(0);
    expect(await p.locator('#scene span').count()).toBeGreaterThan(0);
    await p.getByText('One sunny day, Bun came to a castle.').waitFor();
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);
});

describe('Story Maker language', () => {
  it('tells the story in Spanish with Spanish voices on a Spanish tablet', async () => {
    const { browser, p, tts, ai, errors } = await open('es-MX-MarinaNeural');
    expect(await p.evaluate(() => (window as any).KidTablet.language)).toBe('es');
    await p.getByRole('heading', { name: 'Creador de cuentos' }).waitFor();
    await p.getByText('¿Quién sale en el cuento?').waitFor();
    await p.getByText('castillo', { exact: true }).waitFor();
    await p.getByRole('button', { name: '¡Cuenta el cuento! 📖' }).waitFor();
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'story-maker-es-setup.png') });
    await tellOne(p);
    expect(ai).toHaveLength(1);
    expect(ai[0].system).toContain('write every text value');
    expect(ai[0].system).toContain('Spanish');
    // The grade words drawn for the story are Spanish ones, never the English bank's.
    const words = (/spelled exactly: ([^.]+)\./.exec(ai[0].messages[0].content) ?? [])[1]?.split(', ') ?? [];
    expect(words.length).toBeGreaterThanOrEqual(6);
    const english = await p.evaluate(() => Object.values((window as any).STORY.RUNGS).flatMap((r: any) => r.bank));
    expect(words.filter((w) => english.includes(w))).toEqual([]);
    await p.getByText('Un día de sol, Bun llegó a un castillo.').waitFor();
    await p.getByRole('button', { name: /Entrar/ }).waitFor();
    // Every line asked of the narrator service is in a Spanish voice: the narrator, Bun, and the spoken prompts.
    await p.waitForTimeout(800);
    expect(tts.length).toBeGreaterThan(0);
    expect(tts.filter((t) => !/^es-/.test(t.voice))).toEqual([]);
    expect(tts.some((t) => t.voice === 'es-MX-DaliaNeural')).toBe(true);
    if (process.env.WEB_SHOTS) await p.screenshot({ path: join(process.env.WEB_SHOTS, 'story-maker-es-story.png') });
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);

  it('stays English with English voices on an English tablet', async () => {
    const { browser, p, tts, ai, errors } = await open('en-US-AnaNeural');
    expect(await p.evaluate(() => (window as any).KidTablet.language)).toBe('en');
    await p.getByRole('heading', { name: 'Story Maker' }).waitFor();
    await tellOne(p);
    expect(ai[0].system).not.toContain('Spanish');
    await p.waitForTimeout(800);
    expect(tts.filter((t) => !/^en-/.test(t.voice))).toEqual([]);
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);

  it('speaks a line in an English voice unless the line is marked Spanish', async () => {
    const { browser, p, tts } = await open('es-MX-MarinaNeural');
    await p.evaluate(() => {
      const a = new SpeechSynthesisUtterance('Count the apples.'); speechSynthesis.speak(a);
      const b = new SpeechSynthesisUtterance('Cuenta las manzanas.'); b.lang = 'es-MX'; speechSynthesis.speak(b);
      (window as any).KidTablet.say('Muy bien.');
    });
    await p.waitForTimeout(1500);
    const by = (text: string) => tts.find((t) => t.text === text)?.voice;
    expect(by('Count the apples.')).toBe('en-US-AnaNeural');
    expect(by('Cuenta las manzanas.')).toBe('es-MX-MarinaNeural');
    expect(by('Muy bien.')).toBe('es-MX-MarinaNeural');
    await browser.close();
  }, 60_000);

  it('uses the Spanish shelf story when the writer cannot be reached', async () => {
    const { browser, p, errors } = await open('es-MX-MarinaNeural');
    await p.evaluate(() => { (window as any).STORY.cfg.apiKey = ''; });
    await tellOne(p);
    await p.getByText('Una mañana de sol', { exact: false }).waitFor();
    await p.getByRole('button', { name: /Seguir el sonido/ }).waitFor();
    expect(errors).toEqual([]);
    await browser.close();
  }, 60_000);
});
