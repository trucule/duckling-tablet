# Duckling Tablet backend

Node 22, Fastify 5, SQLite (better-sqlite3), DigitalOcean Spaces for files. Runs under systemd on the droplet behind
the web server already there (nginx or Caddy). Memory is capped at 300 MB because the droplet is shared.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts on 127.0.0.1:8787 with reload |
| `npm test` | API tests (fakes for Azure, email and ET Ducky) |
| `npm run build` | Compiles to `dist/` |
| `node dist/backup.js` | Snapshot of the database to Spaces `backups/` (30 days kept) |

## Who can call what

| Caller | Header | Used by |
| --- | --- | --- |
| Parent | `Authorization: Bearer <session>` or the `dt_session` cookie | Parent portal, parent screens in the apps |
| Device | `Authorization: Device <device token>` | The tablet apps |
| Admin | `Authorization: Bearer <ADMIN_TOKEN>` | Your publish tool |

## Endpoints

| Method and path | Caller | Purpose |
| --- | --- | --- |
| `POST /auth/email-link` `{email}` | anyone | Emails a one-time sign-in link (15 minutes) |
| `POST /auth/verify` `{token}` | anyone | Signs in; creates the family on first sign-in; returns `sessionToken` and sets the cookie |
| `POST /auth/logout` | parent | Ends the session |
| `GET /family` | parent | Parents, children, devices |
| `DELETE /family` `{confirm:"DELETE"}` | parent | Deletes the account and all data; devices are told to release |
| `POST /children`, `PUT /children/:id`, `DELETE /children/:id` | parent | Child profile: firstName, grade, levels (per subject 1 to 10), theme |
| `POST /devices/pairing-codes` `{childId?}` | parent | Six-digit code, 15 minutes |
| `POST /devices/pair` `{code, platform, name}` | the new device | Returns `deviceToken` and the config; starter apps are installed |
| `GET /devices`, `GET/PUT /devices/:id` | parent | Devices and their config; rename or assign a child |
| `PUT/DELETE /devices/:id/apps/:app` | parent | Install or uninstall remotely |
| `PUT/DELETE /devices/:id/hidden/:app` | parent | Hide an app from that device (and uninstall it) |
| `PUT /devices/:id/settings` `{allowlist?, limits?}` | parent | Website allowlist (with optional tiles), daily minutes, bedtime |
| `POST /devices/:id/travel` `{hours}` | parent | Lift the allowlist for N hours (default 6, 0 ends it) |
| `POST /devices/:id/release` | parent | Remote removal: the device releases on its next check-in |
| `POST /device/checkin` `{shellVersion?, battery?, pushToken?}` | device | Records status, returns config |
| `GET /device/config` | device | Child profile, installed apps with package URLs, allowlist, travel, limits, state |
| `PUT/DELETE /device/apps/:app` | device | The child installs and uninstalls freely; hidden apps are refused |
| `POST /device/released` | device | The device has released the lockdown |
| `POST /device/apps-installed` `{apps: [{package, label, icon?, allowed?, dailyMinutes?}]}` | device | The tablet's own apps, for the Other apps section; `allowed` and `dailyMinutes` are applied when sent (the iPad, where the parent picks apps on the device) and left to the portal when absent |
| `GET /catalog` | anyone | Every published app with its newest version |
| `GET /tts?text=&voice=&rate=&private=` | device | Shared voice cache: 302 to the CDN clip; `private=1` returns audio without storing it |
| `GET/POST /requests` | parent | App requests; one open per family; each becomes an ET Ducky ticket |
| `POST /hooks/etducky` | ET Ducky | Ticket status back to the request (HMAC signed) |
| `PUT /admin/apps/:id` | admin | App metadata (name, description, subjects, ages, starter, about, and `i18n.es` with the same fields in Spanish) |
| `POST /admin/apps/:id/versions?version=&signature=&request=` | admin | Upload a signed package zip; `request` marks it shipped and installs it for that family |
| `POST /admin/voice/pregenerate` `{lines}` | admin | Fill the voice cache with an app's fixed lines |
| `GET /admin/requests`, `GET /admin/stats` | admin | Your view |
| `GET /health` | anyone | Liveness |

Device states: `active`, `release` (the device must undo the lockdown), `released`. A device of a deleted family gets
HTTP 410 `{"error":"release"}` and must release.

## ET Ducky contract

- Create: `POST {ETDUCKY_API_URL}/tickets` with `Authorization: Bearer {ETDUCKY_API_KEY}` and
  `{type:"App request", source:"duckling-tablet", externalId, title, body}`; respond `{id}`.
- Status: ET Ducky posts `{ticketId, status}` to `https://api.ducklingtablet.com/hooks/etducky` with header
  `x-etducky-signature` = hex HMAC-SHA256 of the raw body using `ETDUCKY_WEBHOOK_SECRET`. Statuses New, Planned,
  In Progress, Declined map to requested, planned, building, declined. Shipping happens through publishing.

## Not built yet

Billing and entitlement (Phase 3), push through Firebase, the web app, the portal, and the publish tool.
