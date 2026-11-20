// An app's name, description and About text in the portal's language. The catalog carries each app's English text
// and, when the manifest has it, an i18n entry per language; the entry for the current language wins and the English
// text stands in for anything it lacks. Every place that names a catalog app reads it through these three.
import { lang } from './i18n';
import type { AppAbout, CatalogApp } from './api';

type Named = Pick<CatalogApp, 'name' | 'description' | 'about' | 'i18n'>;

export function appName(a: Named): string {
  return a.i18n?.[lang.value]?.name || a.name;
}

export function appDescription(a: Named): string {
  return a.i18n?.[lang.value]?.description || a.description || '';
}

export function appAbout(a: Named): AppAbout | null {
  return a.i18n?.[lang.value]?.about || a.about || null;
}
