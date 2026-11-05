#!/usr/bin/env bash
# Deploys the backend on the droplet itself (run as root): pulls main from GitHub into /opt/duckling/src, installs
# and builds, applies migrations as duckling_system, restarts the service and checks /health.
#
#   bash /opt/duckling/src/deploy/deploy-remote.sh              # every deploy
#   bash /opt/duckling/src/deploy/deploy-remote.sh --bootstrap  # first deploy, or to rotate the database passwords:
#                                                               # asks for the doadmin connection string, creates the
#                                                               # roles and writes their URLs into /opt/duckling/.env
#
# deploy.ps1 runs this over ssh; the DigitalOcean web console works too. The repo is reached through the read-only
# deploy key set up by setup-droplet.sh (ssh host alias github-duckling).
set -euo pipefail

SRC=/opt/duckling/src
ENV_FILE=/opt/duckling/.env
test -f /opt/duckling/ca-certificate.crt || { echo "Missing /opt/duckling/ca-certificate.crt (see Backend-Setup.md step 3)"; exit 1; }
test -f "$ENV_FILE" || { echo "Missing $ENV_FILE (run setup-droplet.sh first)"; exit 1; }

cd "$SRC"
git fetch --quiet origin main
git reset --quiet --hard origin/main
echo "source at $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"

cd "$SRC/backend"
# The droplet has 1 GB shared with Pitch Jam: keep npm and tsc small.
export NODE_OPTIONS=--max-old-space-size=384
npm ci --no-audit --no-fund --loglevel=error
npm run build
npm prune --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$SRC"

if [ "${1:-}" = "--bootstrap" ]; then
  read -rsp 'doadmin connection string (postgresql://doadmin:...@private-host:25060/duckling?sslmode=require): ' DATABASE_URL_ADMIN; echo
  export DATABASE_URL_ADMIN
  DOTENV_CONFIG_PATH="$ENV_FILE" node dist/bootstrap.js --write "$ENV_FILE"
  unset DATABASE_URL_ADMIN
fi

DOTENV_CONFIG_PATH="$ENV_FILE" node dist/migrate.js
systemctl restart duckling-api
sleep 2
if curl -fsS http://127.0.0.1:8787/health; then echo; echo "deployed"; else echo; journalctl -u duckling-api -n 30 --no-pager; exit 1; fi
