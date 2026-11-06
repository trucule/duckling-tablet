# Duckling Tablet

Code for Duckling Tablet: the backend, the shared web app, the parent portal, and the Android, iPad and Windows
apps. The product plan is the "Duckling Tablet: Product Plan" doc; setup and operations notes are in
`D:\Ducking_Docs`.

| Folder | Contents | State |
| --- | --- | --- |
| `backend/` | API on Node 22 + Fastify + PostgreSQL (row-level security per family): accounts, devices, catalog, settings, voice cache, app requests, admin publishing | Phase 1 core done, tested on PostgreSQL |
| `apps/` | 20 of the 23 apps from the Surface project, one folder each with `manifest.json`, `index.html` and `tile.png` | Camera Fun, Read It Say It Make It and Story Maker still to port |
| `tools/` | `publish.mjs`: key pair, package, sign, upload to the catalog | Ready |
| `web/` | Child web app (Preact + Vite) at app.ducklingtablet.com: pairing, home, Library, parent PIN and area, shell bridge | Phase 2 core done, browser-tested |
| `site/` | Public site at ducklingtablet.com: product page, app library, privacy policy, children's privacy notice, terms, support, Windows download, Stripe return pages. Static HTML and CSS, no build step; deployed by `deploy-remote.sh` | Live |
| `deploy/` | `setup-droplet.sh`, `deploy-remote.sh` (runs on the droplet: pull, build, migrate, restart), `deploy.ps1` (ssh wrapper), systemd unit, nginx and Caddy configs | Ready |
| `web/` | Child web app: home screen and Store | Next |
| `portal/` | Parent portal | Next |
| `android/`, `ios/`, `windows/` | Platform shells | Later phases |

## Backend quick start (development)

```powershell
cd backend
npm install
npm test                 # starts its own PostgreSQL (embedded-postgres), no Docker or local install needed
```

Running the API locally needs a PostgreSQL 16 or newer with the two roles. Once, as a superuser or the database owner,
with `DATABASE_URL_ADMIN` pointing at an empty database called `duckling`:

```powershell
copy .env.example .env                      # set NODE_ENV=development and STORAGE=local
$env:DATABASE_URL_ADMIN='postgresql://postgres:...@127.0.0.1:5432/duckling'
npm run db:bootstrap                        # creates duckling_system and duckling_app, prints their two URLs for .env
npm run db:migrate                          # applies backend/migrations as duckling_system
npm run dev                                 # http://127.0.0.1:8787/health
```

Database rules (build plan, section 5): every request for a parent or a device runs as `duckling_app` inside a
transaction scoped to one family (`db.family(familyId, ...)`), and row-level security hides every other family's rows.
`duckling_system` owns the tables and is used only through `db.system(...)` for migrations, webhooks, admin publishing
and the voice cache index. Lookups that happen before the family is known (sessions, device tokens, sign-in links,
pairing codes) go through `SECURITY DEFINER` functions. `test/rls.test.ts` checks the policies directly.
