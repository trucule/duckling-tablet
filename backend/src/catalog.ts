// Catalog helpers shared by the public catalog, device config and admin publishing. app and app_version are global
// tables: readable by duckling_app without a family, written by duckling_system.
import type { Ctx } from './context.js';
import type { Q } from './db.js';

export interface AppAbout { concept: string; progression: string; lifeSkills: string[] }
// The name, description and About text in another language, keyed by language code; a tablet or portal in that
// language shows them and falls back to the English fields for anything missing.
export type AppI18n = Partial<Record<'es', { name: string; description: string; about?: AppAbout | null }>>;

export interface CatalogApp {
  id: string; name: string; description: string; subjects: string[]; ageMin: number | null; ageMax: number | null;
  starter: boolean; tileUrl: string | null; demoUrl: string | null; about: AppAbout | null; i18n: AppI18n | null; latest: null | { version: string; url: string; sha256: string; signature: string; size: number; minShell: string | null; permissions: string[]; publishedAt: Date };
}

// Versions compare numerically by dot-separated parts (1.10.0 > 1.9.2).
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

// Takes a transaction when the caller has one, otherwise reads straight from the app pool.
export async function listCatalog(ctx: Ctx, q?: Q): Promise<CatalogApp[]> {
  const read = <T = any>(sql: string) => (q ? q.all<T>(sql) : ctx.db.query<T>(sql));
  const apps = await read('SELECT * FROM app ORDER BY lower(name)');
  const versions = await read('SELECT * FROM app_version');
  return apps.map((a) => {
    const vs = versions.filter((v) => v.app_id === a.id).sort((x, y) => compareVersions(y.version, x.version));
    const v = vs[0];
    return {
      id: a.id, name: a.name, description: a.description, subjects: a.subjects, ageMin: a.age_min, ageMax: a.age_max,
      starter: a.starter, tileUrl: a.tile_key ? ctx.storage.publicUrl(a.tile_key) : null,
      demoUrl: a.demo_key ? ctx.storage.publicUrl(a.demo_key) : null, about: a.about ?? null, i18n: a.i18n ?? null,
      latest: v ? { version: v.version, url: ctx.storage.publicUrl(v.package_key), sha256: v.sha256, signature: v.signature, size: v.size,
        minShell: v.min_shell, permissions: v.permissions, publishedAt: v.published_at } : null,
    };
  }).filter((a) => a.latest);
}
