// The photo backdrops as served: every listed backdrop has its photo and its lighting, they go out with the right types
// and long caching to any origin, and a name that is not a backdrop file finds nothing.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
});
