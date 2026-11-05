// Catalog helpers shared by the public catalog, device config and admin publishing.
import type { Ctx } from './context.js';

export interface CatalogApp {
  id: string; name: string; description: string; subjects: string[]; ageMin: number | null; ageMax: number | null;
  starter: boolean; latest: null | { version: string; url: string; sha256: string; signature: string; size: number; minShell: string | null; permissions: string[]; publishedAt: string };
}

// Versions compare numerically by dot-separated parts (1.10.0 > 1.9.2).
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

export function listCatalog(ctx: Ctx): CatalogApp[] {
  const apps = ctx.db.prepare('SELECT * FROM app ORDER BY name COLLATE NOCASE').all() as any[];
  const versions = ctx.db.prepare('SELECT * FROM app_version').all() as any[];
  return apps.map((a) => {
    const vs = versions.filter((v) => v.app_id === a.id).sort((x, y) => compareVersions(y.version, x.version));
    const v = vs[0];
    return {
      id: a.id, name: a.name, description: a.description, subjects: JSON.parse(a.subjects), ageMin: a.age_min, ageMax: a.age_max,
      starter: !!a.starter,
      latest: v ? { version: v.version, url: ctx.storage.publicUrl(v.package_key), sha256: v.sha256, signature: v.signature, size: v.size,
        minShell: v.min_shell, permissions: JSON.parse(v.permissions), publishedAt: v.published_at } : null,
    };
  }).filter((a) => a.latest);
}
