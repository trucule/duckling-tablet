# Duckling Tablet

A family subscription that turns an Android tablet, an iPad or a Windows device into a locked-down learning device
running ET Ducky's HTML learning apps. One backend, one child web app, one parent portal, three native shells, the
apps, and the public site, all in this repo. Owner: Chris Smith (ET Ducky LLC). Solo-maintained with Claude sessions;
every change is small, tested, and described by what it does.

## Read first

- The plan of record is `Duckling-Build-Plan.md`: decisions with dates and reasons (section 2), the state of every
  account and service (section 3), the specifications (sections 5 to 18), and the task list (section 19). It is kept
  identical in three places: `D:\Ducking_Docs\Duckling-Build-Plan.md` on Chris's PC, the Kid Tablet project doc
  `claude/duckling-tablet-build-plan.md`, and the session's working copy. Before writing it, read the project doc and
  merge, because another thread may have added rows since the working copy was made. Record a decision in the log
  the same session it is made.
- Languages (English and Spanish, how `tr()` and the dictionaries work): project doc `claude/duckling-languages.md`.
- `docs/ladders.md`: the grade scale, how an app maps grades onto its own levels, and the checks every app passes.
- `docs/blog.md` and `docs/blog-topics.md`: the blog rules, fact sources, and the topic record.
- `docs/Windows.md`: the Windows shell, service, installer, signing and release.
- `docs/backdrops.md`: the 360-degree photo backdrops behind the apps' 3D places, and how to add one.
- `backend/README.md`: endpoints and the local database setup. The root `README.md` folder table is older than the
  plan; trust the plan.

## Layout

| Path | What |
| --- | --- |
| `backend/` | Node 22, TypeScript, Fastify 5, PostgreSQL through `pg`. `src/routes/` per area, `src/db.ts` (`db.family`, `db.system`), `migrations/` numbered SQL, `test/` vitest on an embedded PostgreSQL plus Playwright browser tests of the built web app and portal |
| `web/` | The child's tablet app (Preact, Vite) at app.ducklingtablet.com, loaded by every shell. `src/screens/`, `src/state.ts`, `src/shell.ts` (the `window.DucklingShell` bridge), `src/i18n/` |
| `portal/` | The parent portal (Preact, Vite) at parents.ducklingtablet.com. `src/screens/Family.tsx` is the one family page |
| `apps/<id>/` | One learning app per folder: `index.html`, `manifest.json`, `tile.png`, `phrases.json`, `demo.gif`. Packaged and signed by `tools/publish.mjs`; every app gets `tools/duckling-compat.js` (per-app storage, narrator, `window.KidTablet`) |
| `android/`, `ios/`, `windows/` | The shells. Each shows `web/` and runs installed packages from local storage. `ios/project.yml` (xcodegen) holds `MARKETING_VERSION` |
| `site/` | Static public site, no build step. `site/blog/posts/*.md` are the source of `site/blog/` |
| `fonts/` | Paint Studio's font library, served by the API |
| `tools/` | `publish.mjs`, `phrases.mjs`, `ladder-check.mjs`, `pill-check.mjs`, `demos.mjs`, `blog.mjs`, the compat script, font library builders |
| `deploy/` | `deploy.ps1` (ssh wrapper Chris runs), `deploy-remote.sh` (runs on the droplet), nginx and systemd files, `env.example` |
| `docs/` | The documents listed above |
| `.github/workflows/` | `ios.yml` (TestFlight upload), `android.yml`, `windows.yml`. All run by hand only |

## Working rules

- Prose anywhere (docs, UI text, emails, store listings, blog, commit messages): no em-dashes, no en dashes, plain
  declarative sentences, no promotional or comparison language, no idioms, no decorative unicode. No app counts, no
  "currently", no version numbers in text a reader sees; they go stale. The blog linter (`node tools/blog.mjs check`)
  encodes the full list; apply the same rules by hand elsewhere.
- Commit messages state the result and, when there was one, the failure the change ends. Not how it was found.
- Fix the whole class of a bug, not the instance that surfaced.
- Ship only tested work: run the tests that cover the change and look at a screenshot of any UI before calling it done.
- Another thread may be committing to `main`. `git pull -q origin main` before working and before every push.
- Buttons that lead to a system permission request say Continue or Open settings, never Allow (App Review 5.1.1(iv)).
  `backend/test/windows-web.test.ts` fails on one in the iPad and Android parent areas.
- Every line a person reads in `web/` or `portal/` goes through `tr()` and has a Spanish entry; `backend/test/i18n.test.ts`
  fails otherwise. Apps, manifests, emails and the shells are checked the same way (`node tools/lang-check.mjs`, also
  in that test). The deploy runs both before it builds and stops when English and Spanish are not paired. Spanish is
  neutral Latin American, tú to the parent.
- Apps never read the grade directly; they call `KidTablet.rungFor` or `KidTablet.levelFor` (`docs/ladders.md`). No
  app control within 210 by 72 px of the top right, where the Home pill sits (`tools/pill-check.mjs`).
- AI apps are described as finding and suggesting, never deciding. Prompts and replies are never stored or logged.

## What Claude never does

- Runs a deploy, opens SSH or scp to the droplet, reads `/opt/duckling/.env`, or connects to the production
  database. Propose the command; Chris runs it.
- Enters a password, a verification code, a key or bank details for Chris; ticks an agreement, attestation or
  certification; presses Submit or Send on a statement made to Apple, Google or Microsoft in his name. Fill the form
  in, say it is ready, and let him press it.
- Bypasses a security block or a permission classifier refusal. Report it and stop.
- Moves a store release lever Chris did not ask for (App Store release, Play rollout, the Windows release feed).

Secrets live only in `/opt/duckling/.env` on the droplet and Chris's password manager. `deploy/env.example` lists the
names. Never commit `.env` or a signing key.

## Tenancy and data

- Every family-owned table carries `family_id` with a row-level security policy. A request for a parent or a device
  runs inside `db.family(familyId, fn)` as `duckling_app`; system work (webhooks, publishing, migrations) runs inside
  `db.system(fn)` as the owner, on purpose and nowhere else. Lookups before the family is known go through the
  `SECURITY DEFINER` functions. Any new table or query keeps this and gets a case in `backend/test/rls.test.ts`.
- Logs carry no tokens, PINs, child names or email bodies (`src/logging.ts`). Times are UTC.
- The child's name is spoken but never stored in the shared voice cache. Microphone and camera input stays on the
  device, including a Camera Fun photo used as that tablet's background.
- Never edit a migration that has been applied. Add the next number and fix forward.

## Build and test

```
cd backend && npm ci && npm test            # every suite; each file starts its own PostgreSQL, files run one at a time
cd backend && npx vitest run test/api.test.ts
cd backend && npm run typecheck
cd web && npm ci && npm run build            # web/dist; the browser tests skip when it is missing
cd portal && npm ci && npm run build         # portal/dist, same
cd tools && npm ci                           # the publish tool's dependencies, which web.test.ts also needs
npx playwright install chromium              # once per machine, for the browser tests
```

Apps: after changing `apps/<id>/`, bump `version` in its manifest, run `node tools/ladder-check.mjs --drive <id>`
(all grades), `node tools/pill-check.mjs` and `node tools/lang-check.mjs`, then `node tools/phrases.mjs <id>`, which rewrites `phrases.json`
and records the source hash the publish tool checks. `node tools/demos.mjs <id>` re-records the demo GIF.
`node tools/load-time.mjs <id>` prints what loads when on a first and a later opening; run it before and after a change
to how an app loads its pictures, models or textures. A changed
app with no version bump is refused at deploy ("already published (DIFFERENT bytes)") and tablets keep the old one.

Blog: write `site/blog/posts/<slug>.md`, `node tools/blog.mjs check`, then `node tools/blog.mjs build` and commit the
rendered files. A weekly scheduled task drafts posts as pull requests on `blog/<slug>` branches; Chris merges.

Windows: `windows\Build-Release.ps1` on Chris's PC (EV signing); CI builds an unsigned MSI and installs it on a
Windows runner. iPad: run `ios.yml` by hand (`gh workflow run ios.yml --ref main`); the build number comes from the run
number, the version from `ios/project.yml`. Android: `android.yml` the same way; the version code comes from the run
number, the version from `versionName` in `android/app/build.gradle.kts`. Bump the version for each store release.
Store listings, custom product pages and custom store listings live in App Store Connect and Play Console; what each
one says and targets is recorded in the plan (section 2 and the accounts table in section 3).

## Deploy model (Chris runs it)

`.\deploy\deploy.ps1` from `D:\VS_Projects\DucklingTablet` after `git pull`. On the droplet `deploy-remote.sh` pulls
`main`, builds the backend, `web/` and `portal/`, rsyncs `site/`, applies new migrations as `duckling_system`,
restarts `duckling-api`, checks `/health`, then publishes any app version the catalog does not have. Schema goes out
with or before the code that reads it. There is no cloud staging environment.

Admin operations (trial changes, complimentary licenses) are `PUT /admin/families/...` calls with the admin token,
run on the droplet; the exact commands are in the plan, section 18.

## Remote (claude.ai) sessions

- The container clones GitHub and can push to `main`. It cannot reach ducklingtablet.com or the droplet; Chris
  reports what a deployed endpoint answers. WebFetch of the site needs his approval.
- `D:\VS_Projects\DucklingTablet` is a clone of the same repo on Chris's PC, reachable through the device bridge
  when he connects the folder. Do not edit files there; commit, and he pulls.
- Chrome automation signs in as Chris to App Store Connect, Play Console, Partner Center and the service consoles.
  The rules under "What Claude never does" apply there.
- Many files are plain UTF-8 without a BOM; PowerShell files keep whatever BOM and line endings they have.
- Deleting files in connected folders is off by default; move unwanted files into `_to_delete/`.

## Ignore

`node_modules/`, `dist/`, `_to_delete/`, `*.bak`, the `LOCAL_STORAGE_DIR` folder of a local run, `windows/out/`,
build output under `android/` and `ios/`. Do not read them for context or count them
as source.

## Keeping this file current

One rule, one place: a repo-wide rule lives here, a folder rule in that folder's doc, and the other carries a
pointer at most. No facts that change on their own (counts, versions, branch names, "currently"). When a fact here
turns out wrong, fix it in the same change that found it.
