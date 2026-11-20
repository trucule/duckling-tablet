// Speech models as served: every file of a model folder goes out with the right type and long caching to any origin,
// a path of any other shape (dotfiles, the README, a step up the tree) finds nothing, and the repo's models/README.md
// lists every file the app fetches.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import modelRoutes, { MODELS_DIR } from '../src/routes/models.js';

function appModelNames(): string[] {
  const list = readFileSync(join(MODELS_DIR, '..', 'apps', 'read-it-say-it', 'vosk', 'model-list.js'), 'utf8');
  return JSON.parse(/RISI_MODEL_NAMES\s*=\s*(\[[^\]]*\])/.exec(list)![1]) as string[];
}

function fakeModel() {
  const dir = mkdtempSync(join(tmpdir(), 'models-'));
  const m = join(dir, 'vosk-small-es');
  for (const d of ['am', 'conf', 'graph/phones']) mkdirSync(join(m, d), { recursive: true });
  writeFileSync(join(m, 'am', 'final.mdl'), Buffer.from([0, 0x42, 1, 2, 3]));
  writeFileSync(join(m, 'conf', 'model.conf'), '--min-active=200\n');
  writeFileSync(join(m, 'graph', 'phones', 'word_boundary.int'), '1 nonword\n');
  writeFileSync(join(m, 'graph', 'HCLr.fst'), Buffer.from([0xd6, 0xfd, 0xb2, 0x7e, 0, 0]));
  // Every file the app asks for, so the route is tried on each real name.
  for (const n of appModelNames()) { mkdirSync(join(m, ...n.split('/').slice(0, -1)), { recursive: true }); if (!existsSync(join(m, n))) writeFileSync(join(m, n), 'x'); }
  writeFileSync(join(m, '.gitkeep'), '');
  writeFileSync(join(dir, 'README.md'), '# models\n');
  return dir;
}

describe('speech models', () => {
  it('the repo has the folder the Spanish model goes in, and the README lists every file the app fetches', () => {
    expect(existsSync(join(MODELS_DIR, 'vosk-small-es', '.gitkeep'))).toBe(true);
    const readme = readFileSync(join(MODELS_DIR, 'README.md'), 'utf8');
    const names = appModelNames();
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) expect(readme, n).toContain(`\n${n}\n`);
    expect(readme).toContain('vosk-model-small-es-0.42');
  });

  it('serves a model file to any origin with its type and long caching, and nothing else', async () => {
    const app = Fastify(); await app.register(modelRoutes, { dir: fakeModel() });
    const mdl = await app.inject({ url: '/models/vosk-small-es/am/final.mdl', headers: { origin: 'duckling-app://local' } });
    expect(mdl.statusCode).toBe(200);
    expect(mdl.headers['access-control-allow-origin']).toBe('*');
    expect(mdl.headers['content-type']).toBe('application/octet-stream');
    expect(mdl.headers['cache-control']).toBe('public, max-age=2592000');
    expect(mdl.headers['x-content-type-options']).toBe('nosniff');
    expect(mdl.headers['etag']).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
    expect([...mdl.rawPayload]).toEqual([0, 0x42, 1, 2, 3]);
    const conf = await app.inject({ url: '/models/vosk-small-es/conf/model.conf' });
    expect(conf.statusCode).toBe(200);
    expect(conf.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(conf.body).toBe('--min-active=200\n');
    const deep = await app.inject({ url: '/models/vosk-small-es/graph/phones/word_boundary.int' });
    expect(deep.statusCode).toBe(200); expect(deep.headers['content-type']).toBe('text/plain; charset=utf-8');
    // Vosk's graph carries capitals in its name; the route once took lowercase only, and the Spanish listener never
    // started on the tablets (404 on graph/HCLr.fst). Every name the app asks for has to pass the path rule.
    const fst = await app.inject({ url: '/models/vosk-small-es/graph/HCLr.fst' });
    expect(fst.statusCode).toBe(200); expect([...fst.rawPayload].slice(0, 4)).toEqual([0xd6, 0xfd, 0xb2, 0x7e]);
    for (const n of appModelNames()) expect((await app.inject({ url: `/models/vosk-small-es/${n}` })).statusCode, n).toBe(200);
    for (const bad of ['/models/vosk-small-es/.gitkeep', '/models/vosk-small-es/graph/Gr.fst', '/models/vosk-small-es/am/nope.mdl', '/models/vosk-small-es/README.md',
      '/models/vosk-small-es/..%2FREADME.md', '/models/..%2FREADME.md', '/models/vosk-small-es/am%2F..%2F..%2FREADME.md', '/models/Vosk-Small-ES/am/final.mdl',
      '/models/vosk-small-es/am/final', '/models/vosk-small-es/a/b/c/d/final.mdl', '/models/nope/am/final.mdl', '/models/vosk-small-es/'])
      expect((await app.inject({ url: bad })).statusCode, bad).toBe(404);
    await app.close();
  });
});
