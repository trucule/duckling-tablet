// The portal speaks the family's language (GET /family); before sign-in, the browser's.
// Text is written in English in the code and looked up by that English text: tr('Install') gives "Instalar" in Spanish
// and "Install" in English or when a line has no translation. {name} in a line is replaced from vars. Messages from the
// API are English and go through the same lookup (api.ts), so one dictionary covers both.
// i18n.test.ts in backend/test fails when a tr() line in portal/src has no Spanish entry.
import { signal } from '@preact/signals';
import { es } from './i18n/es';

export type Lang = 'en' | 'es';
// Each language's name in itself, so a parent finds their own whatever the page is in.
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', es: 'Español' };
const DICTS: Record<Lang, Record<string, string>> = { en: {}, es };

export function langOf(input: unknown): Lang {
  const base = typeof input === 'string' ? input.trim().toLowerCase().split(/[-_]/)[0] : '';
  return base === 'es' ? 'es' : 'en';
}

export const lang = signal<Lang>(langOf(typeof navigator !== 'undefined' ? navigator.language : 'en'));

export function setLang(l: unknown) {
  const next = langOf(l);
  if (lang.value !== next) lang.value = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

export function tr(text: string, vars?: Record<string, string | number>): string {
  const line = DICTS[lang.value][text] ?? text;
  return vars ? line.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : line;
}

// Plurals: one line for one, another for any other count, both written in English and looked up.
export const trn = (n: number, one: string, other: string, vars?: Record<string, string | number>) =>
  tr(n === 1 ? one : other, { n, ...vars });
