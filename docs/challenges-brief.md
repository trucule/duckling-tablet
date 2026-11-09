# Challenges ladders for the free-play apps

The free-play apps (Music Box, Voice Band, Draw With Me, Chemistry Lab, Kitchen Lab, Playground Lab) open to a sandbox.
Each gets a Challenges mode built on top of that sandbox: a ladder of goals from pre-K to 8th grade that the child
completes with the sandbox's own tools. Free play stays exactly as it is and stays what the app opens to.

Read `docs/ladders.md` first. Everything there applies (grade bands, rules 1 to 8, the self-check hook), with the
additions below. A finished example of a grade-tagged ladder with a self-check hook is `apps/circuit-lab/index.html`
(search for `RUNG_GRADES`, `rungFor` and `DucklingLadder`).

## What to build

1. A "Challenges" button or tab, easy for a child to find, that enters the mode; a clear way back to free play.
2. `LEVELS`: 12 to 20 rungs, each `{ name, g, gen }`. `g` is the grade the rung is for (-1 pre-K .. 8), in rising
   order, with at least one rung at pre-K or K and at least one at 8th grade. A comment above the ladder names the
   grade band of each rung. Content matches the grade band table in `docs/ladders.md` for the app's subject, written
   as a teacher at that grade would recognise it.
3. `const START = KidTablet.rungFor(subject, LEVELS.map(l => l.g))` with the same fallbacks the other apps use
   (`levelFor`, then a fixed index for a browser with no bridge). The challenge mode opens on START the first time
   and on the saved rung afterwards.
4. `gen()` returns a fresh challenge each call: what the child is asked (short, warm, declarative, spoken through the
   app's existing narration helper), how the app checks it, and a hint. The check reads the sandbox's real state (the
   notes placed, the reaction made, the shape drawn, the object knocked down). A challenge the child cannot complete
   with the tools on screen is a bug. Content banks are large enough that forty draws at one rung do not repeat in an
   obvious way.
5. Adaptive ladder: four challenges right in a row moves up a rung, two missed in a row moves down one; the top rung
   keeps generating. A "missed" is a wrong check, a skip, or giving up; define it in the code. Progress (`P.lv`,
   streaks, stars) saves through the app's existing storage. Each completed challenge gives stars through the app's
   existing star path (`window.KID_STARS` or the app's own reporter), the same amount the app gives elsewhere.
6. `window.DucklingLadder` with `levels`, `start`, `label` (the current rung's name) and `exercise(i, n)`, which builds
   n challenges at rung i without touching the DOM and throws on a malformed one: missing or non-string text, `NaN`,
   `undefined` or `[object` in any text, a target the checker cannot reach, an answer missing from its choices.
7. Layout fits 1024 x 640 and 1280 x 800 landscape. Keep the top-right 210 px clear (Home pill). Finger taps work in
   scrolling panels. No em-dashes in any text or comment you write.
8. `manifest.json`: bump the patch version, set `ageMin` 4 and `ageMax` 14, and rewrite `about.progression` in one or
   two plain sentences covering free play and the Challenges ladder.
9. Do not rename or remove any element `tools/demos.mjs` uses for this app (look up its line in that file).

## Constraints

- Edit only `apps/<your-app>/`. Do not touch `tools/`, other apps or the backend. Do not run git commands that change
  state (no commit, add, stash, reset, checkout); the coordinator commits.
- For a bundled app with very long lines (embedded libraries or assets), edit only the app-code script blocks and
  never rewrite the file by retyping it; use targeted edits.
- Network: none needed. Plain `<script>` only, no new CDN loads.

## Checks before you report done

```
node tools/ladder-check.mjs <app-id> --drive --shots /tmp/shots-<app-id>
```

must print `ok` for all ten grades with `exercised N/N levels x40`. Then open the Challenges mode in a Playwright
script at pre-K, 2nd, 5th and 8th (pass `?levels={...}` the way ladder-check does), take screenshots, and look at them
with the Read tool: the challenge must be visible, readable, fit the screen and match the grade. Also complete at least
one challenge per grade band by driving the real sandbox (not by calling the checker directly) to prove the check
fires, and confirm free play still works and the demo selectors still exist.

Report: rung list (name and grade), what the check reads, the ladder-check output summary, the screenshot paths you
looked at, anything you could not do.
