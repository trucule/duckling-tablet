# Level ladders: pre-K to 8th grade in every app

Every child has a grade per subject (reading, math, science, logic, art, music) on one scale: -1 is pre-K, 0 is
kindergarten, 1 to 8 are 1st to 8th grade. The parent sets it on the Family page; the default is two years below the
child's age. The tablet hands the grades to each app through the compatibility script, and the app maps them onto its
own ladder of levels.

## What an app gets

- `KidTablet.levels`: the grades object, for example `{ reading: 0, math: 4 }`. A subject the parent never set is absent.
- `KidTablet.grade(subject)`: the grade for one subject, 2 when it is not set (where every app used to start).
- `KidTablet.levelFor(subject, rungs, whereSecondGradeWas)`: the index in a ladder of `rungs` levels where this child
  starts. Pre-K maps to index 0, 8th grade to `rungs - 1`, 2nd grade to `whereSecondGradeWas`, and the grades between
  spread evenly on each side of it. An app calls it once at load:

```js
const START = (window.KidTablet && KidTablet.levelFor ? KidTablet.levelFor('reading', LEVELS.length, 3) : 3);
```

Because the mapping is linear on each side of the 2nd grade rung, a ladder works best when its rungs are evenly spaced
in difficulty: one or two rungs per grade, pre-K at the bottom and real 8th grade material at the top. Twelve to twenty
rungs is the usual size. When a rung is added below the index named as 2nd grade, that index moves up by one.

## What each grade band means

Write content a teacher at that grade would recognize. Bigger numbers alone do not make a higher grade.

| Band | Reading | Math | Science | Logic | Music | Art |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-K, K | letter sounds, CVC words, sight words, listening to a sentence | count to 20, compare amounts, shapes, simple add within 10 | living and non-living, weather, animal needs, planets as names | copy a pattern, 2 to 3 step sequence, sort by one rule | steady beat, loud and soft, high and low, 2 to 3 note echoes | shapes and colors, draw what you see |
| 1st, 2nd | blends, digraphs, long vowels, two-syllable words, short passages with a question | add and subtract within 100, place value, time, money, halves and quarters, 2D and 3D shapes | habitats, life cycles, states of matter, simple circuits, day and night | repeat a pattern with a rule, loops, left and right turns | rhythm patterns, 4 to 5 note echoes, instrument families | proportion, symmetry, warm and cool colors |
| 3rd, 4th | multisyllable words, prefixes and suffixes, main idea, inference, fluent paragraphs | multiplication and division, fractions, area and perimeter, multi-digit arithmetic, rounding | food webs, energy, forces and motion, the solar system in order, rock cycle | nested loops, conditionals, growing patterns, debugging a sequence | reading rhythm notation, scales, melodic echoes of 6 to 8 notes | perspective basics, shading, composition |
| 5th, 6th | Greek and Latin roots, academic vocabulary, summarising, point of view, text evidence | decimals, percents, ratios, negative numbers, order of operations, volume, coordinate plane | ecosystems and cycles, chemical and physical change, electricity and magnetism, gravity and orbits, cells | variables, functions, function tables, algebraic rules, multi-step planning | intervals, major and minor, chords, time signatures | one and two point perspective, value and form |
| 7th, 8th | connotation, figurative language, argument and evidence, complex sentences, domain vocabulary | proportional reasoning, linear equations and slope, exponents, scientific notation, Pythagorean theorem, probability, statistics | Ohm's law, waves, genetics, plate tectonics, chemical reactions, Newton's laws, scale of the universe | algorithms, efficiency, boolean logic, recursion in plain words, systems with feedback | key signatures, chord progressions, reading a staff, composing to a rule | design principles, color theory, critique vocabulary |

## Rules for extending a ladder

1. Existing rungs keep working and keep their order. Harder rungs go above them. Each rung carries a `name` the child
   sees and, in a comment above the ladder, the grade band it is meant for.
2. Content banks are large enough that forty draws at one level do not repeat in an obvious way, and a generator never
   throws, loops forever, or produces a problem with no correct answer among the choices.
3. The screen still fits a landscape tablet at 1024 x 640 and 1280 x 800. Longer words, bigger numbers and more
   tiles need the layout to adapt (wrap, scale, scroll inside a panel). Typed answers get a number pad or keyboard
   inside the app, never the system keyboard alone.
4. Spoken prompts go through the app's existing narration helper. Text for the child is short, warm and declarative,
   with no em-dashes.
5. The level-up logic stays as it is, but the child must be able to climb to the top rung, and the top rung keeps
   generating fresh problems instead of ending.
6. The app exposes a self-check hook used by `tools/ladder-check.mjs --drive`:

```js
window.DucklingLadder = {
  levels: () => LEVELS.length,                 // number of rungs
  start: () => START,                          // the rung this child opened on
  label: () => LEVELS[P.lv].name,              // what the child sees now
  exercise: (i, n) => {                        // build n problems at rung i without touching the DOM;
    const out = [];                            // throw if a problem is malformed; return short samples
    for (let k = 0; k < n; k++) { const t = LEVELS[i].gen(); check(t); out.push(describe(t)); }
    return out;
  },
};
```

7. `manifest.json` gets a version bump, `ageMin` and `ageMax` that match the ladder (4 and 14 for a full one), and an
   `about.progression` that describes the whole ladder in one or two plain sentences.
8. The demo recording script in `tools/demos.mjs` drives the app at 2nd grade by its selectors and visible text; do
   not rename those elements.

## Checking a ladder

```
node tools/ladder-check.mjs <app-id> --drive --shots /tmp/shots
node tools/ladder-check.mjs --all
```

The first loads the app at every grade, exercises every rung forty times through the hook, and saves a screenshot per
grade. Look at pre-K, 2nd, 5th and 8th: the screen should look like that grade. The second is the smoke test for all
apps and runs in the compatibility test as well.
