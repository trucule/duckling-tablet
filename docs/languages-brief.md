# Spanish in every app: the brief

Duckling families choose a language, English or Spanish (project doc `claude/duckling-languages.md`). The tablet's
screens, the parent portal and the emails follow it. This brief is how each learning app follows it too: every word
the child sees or hears is in the child's language, and content that is about language (spelling words, reading
passages, letter names) is Spanish content, not a translation of the English item. Story Maker (`apps/story-maker`)
is the first app done this way and is the reference.

## How an app learns the language

```js
const LANG = window.KidTablet && window.KidTablet.language === 'es' ? 'es' : 'en';
```

`KidTablet.language` comes from the compatibility script (`tools/duckling-compat.js`): the shell's answer when it has
one, otherwise the family's narrator voice. In a plain browser it is `en`. Read it once at startup. Nothing else about
the bridge changes.

## The dictionary

One map per app, keyed by the English text, with `{name}` style placeholders kept in both languages, and one helper:

```js
const ES = {
  'Trace the letter {l}.': 'Traza la letra {l}.',
  'Great job!': '¡Muy bien!',
};
function T(s, vars) {
  let t = LANG === 'es' && ES[s] != null ? ES[s] : s;
  if (vars) t = t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return t;
}
```

Every string a person reads or hears goes through `T()`: screen text, button labels, prompts, feedback, level names,
hints, `aria-label`, `title`, `alt`, `placeholder`, text drawn on a canvas or in SVG, the document title, and every
narrator line. Markup written in HTML is translated at startup (walk the elements that carry text, or give them
`data-t` and set their text from `T()`); do not duplicate the markup per language. Strings built from parts
(`'Level ' + n`) become one key with a placeholder (`'Level {n}'`), since Spanish word order differs. Keep the English
key as the English text that was already there, so the English app does not change.

The app exposes a hook that `tools/ladder-check.mjs --lang es` reads:

```js
window.DucklingLang = {
  keys: () => Object.keys(ES),                           // every key with a Spanish line
  missing: () => [...USED].filter((k) => ES[k] == null), // keys T() was asked for that have no Spanish line
  allow: ['Duckling'],                                   // English words that are right on a Spanish screen
};
```

`USED` is a Set that `T()` adds every key to. A key asked for with no Spanish entry is a failure in the check. `allow`
is for words the scan would otherwise flag (the checker's list is in `tools/ladder-check.mjs`): a brand name, a letter
name, a loan word. It is not a way to leave text in English.

## Speech

Spanish lines are spoken by the Spanish narrator only when the utterance says it is Spanish. In the app's speech
helper:

```js
function say(t) { const u = new SpeechSynthesisUtterance(t); u.lang = LANG === 'es' ? 'es-MX' : 'en-US'; ... }
```

Without `u.lang` the compatibility script reads the line in English. Lines that contain the child's name stay
`private` as they are today. `KidTablet.say(text, opts)` already defaults to the child's language. Numbers read aloud
in Spanish are written as words where the English did the same ("tres" for "three"); digits stay digits.

Every narrator line the app asks for while it loads is recorded by `tools/phrases.mjs` in both languages and made
in the right voice before the app ships. Lines built at run time are made the first time a tablet asks.

## Content that is about language

- Word Wizard: a Spanish word bank per rung with the same rung count, accents and ñ spelled as letters the child
  taps, picture clues that fit the Spanish word, and vowel or syllable hints that are about Spanish (sílabas, h muda,
  b y v, c y s y z, la tilde) rather than English vowel teams.
- Read It Say It Make It: original Spanish passages per tier with the same tier count and comprehension questions,
  Spanish letter and sight-word rungs below them, and speech recognition in Spanish (see its agent's notes in the
  pull request; the Spanish model is served by the API, not packed in the app).
- Trace With Me: the Spanish alphabet including ñ, Spanish words for each letter with pictures that fit, Spanish
  sentences at the top rungs, cursive forms unchanged.
- Level Up: the reading subject gets Spanish items at every rung (letters, syllables, words, sentences, short
  passages); math, color, patterns, time and shapes translate their prompts and keep their problems.
- Story Maker: done; add the `DucklingLang` hook and check the Spanish screens with the scan.
- Count With Me, Number Line Rocket, Fraction Pizza, Pattern Machine, Tangram City, Robot Path, Light Bridge, Circuit
  Lab, Ecosystem Aquarium, Planet Explorer, Simon Orchestra, Music Box, Voice Band, Chemistry Lab, Kitchen Lab,
  Playground Lab, Camera Fun, My Avatar, Paint Studio, Draw With Me: translate every string, including names of
  planets, elements, animals, foods, instruments, colors, shapes, tools, and the Challenges and hints; the problems
  themselves do not change. Draw With Me's and Story Maker's writer prompts tell the model to answer in Spanish when
  `LANG` is `es`, the way Story Maker does.

Spanish content is written for the same grade band as the English rung it sits on (`docs/ladders.md`, grade bands)
and is original text. A bank in Spanish is as large as the English one at that rung.

## Tone and glossary

Neutral Latin American Spanish, tú to the child, short warm declarative sentences, no em dashes, opening ¿ and ¡ where
Spanish uses them. The same word for the same thing across apps:

| English | Spanish |
| --- | --- |
| Tap | Toca |
| Next | Siguiente |
| Try again | Intenta otra vez |
| Great job | Muy bien |
| Correct | Correcto |
| Level | Nivel |
| Stars | Estrellas |
| Play | Jugar |
| Start | Empezar |
| Done | Listo |
| Back | Atrás |
| Listen | Escucha |
| Hint | Pista |
| Score | Puntos |
| Home (the Duckling home screen) | Inicio |

Apps keep their English names in the code and the catalog id; the Spanish name goes in the manifest (below), and a
name shown inside the app comes from `T()` with the English name as the key.

## The manifest

```json
"i18n": {
  "es": {
    "name": "Mago de las palabras",
    "description": "...",
    "about": { "concept": "...", "progression": "...", "lifeSkills": ["..."] }
  }
}
```

Translate `name`, `description` and the three `about` fields with the same facts and no counts. Bump `version` by a
patch. Nothing else in the manifest changes.

## Checks, in this order

```
node tools/ladder-check.mjs <id> --drive --lang en              # the English app is unchanged
node tools/ladder-check.mjs <id> --drive --lang es --shots /tmp/es   # no untranslated keys, no English on screen
node tools/pill-check.mjs <id>
node tools/phrases.mjs <id>                                      # runs both languages and writes phrases.json
```

Look at the Spanish screenshots at pre-K, 2nd, 5th and 8th: Spanish text is longer than English, so buttons, labels
and prompts must still fit at 1024 x 640 (wrap or scale, never clip). Text drawn on a canvas is not scanned by the
checker, so it is checked by eye. The `--drive` hook of `docs/ladders.md` keeps running in both languages.

## What does not change

Game logic, ladders, rung counts, ids, element selectors the demo scripts use (`tools/demos.mjs`), stars, storage
keys, and the English text. One app per change. Nothing outside `apps/<id>/` except where this brief names it.

## What to report

The version, the number of keys, the content decisions (word banks, passages, names), the lines a native speaker
should read first (idioms, grade words, anything you were unsure of), and the check output. Spanish lines get a
native speaker's review before release, as the dictionaries did.
