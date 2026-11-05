# Duckling Tablet

Code for Duckling Tablet: the backend, the shared web app, the parent portal, and the Android, iPad and Windows
apps. The product plan is the "Duckling Tablet: Product Plan" doc; setup and operations notes are in
`D:\Ducking_Docs`.

| Folder | Contents | State |
| --- | --- | --- |
| `backend/` | API on Node 22 + Fastify + PostgreSQL (row-level security per family): accounts, devices, catalog, settings, voice cache, app requests, admin publishing | Phase 1 core done, tested on PostgreSQL |
| `deploy/` | Droplet setup, systemd units, nginx and Caddy configs, `deploy.ps1` | Ready |
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
