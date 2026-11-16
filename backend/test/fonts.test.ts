// The font library as served: every listed font has its file and its preview sheet, the files go out with the right
// types and long caching to any origin, and a name that is not a font file finds nothing.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import fontRoutes, { FONTS_DIR } from '../src/routes/fonts.js';

const lib = JSON.parse(readFileSync(join(FONTS_DIR, 'library.json'), 'utf8')) as { groups: string[]; fonts: { id: string; name: string; group: string; sheet: string; cell: number }[] };

describe('font library', () => {
  it('lists about a thousand fonts, each with its file and sheet, none twice, and none of Paint Studio’s own', () => {
    expect(lib.fonts.length).toBeGreaterThan(900);
    expect(new Set(lib.fonts.map((f) => f.id)).size).toBe(lib.fonts.length);
    for (const f of lib.fonts) {
      expect(existsSync(join(FONTS_DIR, 'files', `${f.id}.woff2`)), f.id).toBe(true);
      expect(existsSync(join(FONTS_DIR, 'sheets', f.sheet)), f.sheet).toBe(true);
      expect(lib.groups).toContain(f.group);
    }
    expect(readdirSync(join(FONTS_DIR, 'files')).length).toBe(lib.fonts.length);
    const builtIn = readdirSync(join(FONTS_DIR, '..', 'apps', 'paint-studio', 'fonts')).filter((n) => n.endsWith('.woff2')).map((n) => n.slice(0, -6));
    expect(lib.fonts.filter((f) => builtIn.includes(f.id))).toEqual([]);
    expect(readFileSync(join(FONTS_DIR, 'LICENSES.txt'), 'utf8')).toContain(`${lib.fonts[0].name} (${lib.fonts[0].id}.woff2)`);
  });

  it('serves the list, sheets and fonts to any origin, and nothing else', async () => {
    const app = Fastify(); await app.register(fontRoutes, {});
    const list = await app.inject({ url: '/fonts/library.json', headers: { origin: 'duckling-app://local' } });
    expect(list.statusCode).toBe(200);
    expect(list.headers['access-control-allow-origin']).toBe('*');
    expect(list.json().fonts.length).toBe(lib.fonts.length);
    const f = lib.fonts[0];
    const font = await app.inject({ url: `/fonts/files/${f.id}.woff2` });
    expect(font.statusCode).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.headers['cache-control']).toBe('public, max-age=2592000');
    expect(font.rawPayload.subarray(0, 4).toString()).toBe('wOF2');
    const sheet = await app.inject({ url: `/fonts/sheets/${f.sheet}` });
    expect(sheet.statusCode).toBe(200); expect(sheet.headers['content-type']).toBe('image/webp');
    for (const bad of ['/fonts/files/..%2Flibrary.json', '/fonts/files/nope.woff2', '/fonts/files/Inter.woff2', '/fonts/sheets/..%2F..%2Fpackage.json', '/fonts/files/..%2F..%2Fbackend%2Fpackage.json', '/fonts/LICENSES.txt'])
      expect((await app.inject({ url: bad })).statusCode, bad).toBe(404);
    await app.close();
  });
});
