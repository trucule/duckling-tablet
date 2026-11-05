# Duckling Tablet

Code for Duckling Tablet: the backend, the shared web app, the parent portal, and the Android, iPad and Windows
apps. The product plan is the "Duckling Tablet: Product Plan" doc; setup and operations notes are in
`D:\Ducking_Docs`.

| Folder | Contents | State |
| --- | --- | --- |
| `backend/` | API on Node 22 + Fastify + SQLite: accounts, devices, catalog, settings, voice cache, app requests, admin publishing | Phase 1 core done, tested |
| `deploy/` | Droplet setup, systemd units, nginx and Caddy configs, `deploy.ps1` | Ready |
| `web/` | Child web app: home screen and Store | Next |
| `portal/` | Parent portal | Next |
| `android/`, `ios/`, `windows/` | Platform shells | Later phases |

## Backend quick start (development)

```powershell
cd backend
npm install
copy .env.example .env   # then set NODE_ENV=development, STORAGE=local, DATABASE_PATH=./data/duckling.db
npm run dev              # http://127.0.0.1:8787/health
npm test
```
