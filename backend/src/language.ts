// The languages Duckling speaks. A family has one (family.language); a child may override it (child.language). Text a
// browser or tablet sends (navigator.language, "es-MX") is reduced to one of these, and anything else is English.
export const LANGUAGES = ['en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

export function languageOf(input: unknown): Language {
  const base = typeof input === 'string' ? input.trim().toLowerCase().split(/[-_]/)[0] : '';
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Language) : 'en';
}

// The narrator for a language: the voice in the server's settings (NARRATOR_VOICE for English, NARRATOR_VOICE_ES for
// Spanish).
export function narratorFor(cfg: { NARRATOR_VOICE: string; NARRATOR_VOICE_ES: string }, lang: Language): string {
  return lang === 'es' ? cfg.NARRATOR_VOICE_ES : cfg.NARRATOR_VOICE;
}
