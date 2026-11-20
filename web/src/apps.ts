// An app's name and description in the tablet's language. The catalog and the device config carry each app's English
// text and, when the manifest has it, an i18n entry per language; the entry for the current language wins and the
// English text stands in for anything it lacks. Every screen that names an app reads it through these two.
import { lang } from './i18n';
import type { AppI18n } from './api';

interface Named { name: string; description?: string; i18n?: AppI18n | null }

export function appName(a: Named): string {
  return a.i18n?.[lang.value]?.name || a.name;
}

export function appDescription(a: Named): string {
  return a.i18n?.[lang.value]?.description || a.description || '';
}
