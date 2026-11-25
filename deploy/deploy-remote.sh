#!/usr/bin/env bash
# Deploys the backend on the droplet itself (run as root): pulls main from GitHub into /opt/duckling/src, installs
# and builds, applies migrations as duckling_system, restarts the service and checks /health.
#
#   bash /opt/duckling/src/deploy/deploy-remote.sh              # every deploy
#   bash /opt/duckling/src/deploy/deploy-remote.sh --background # the same, detached: survives the web console
#                                                               # closing or going idle; follow it with
#                                                               # tail -f /root/duckling-deploy.log
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

if [ "${1:-}" = "--background" ]; then
  shift
  setsid nohup bash "$SRC/deploy/deploy-remote.sh" "$@" > /root/duckling-deploy.log 2>&1 < /dev/null &
  disown
  echo "deploy running in the background; tail -f /root/duckling-deploy.log (it ends with: deployed)"
  exit 0
fi

cd "$SRC"
if [ -z "${DUCKLING_PULLED:-}" ]; then
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  echo "source at $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
  # bash reads a script as it runs, so the rest of this run must use the file that was just pulled, not the old one.
  DUCKLING_PULLED=1 exec bash "$SRC/deploy/deploy-remote.sh" "$@"
fi

# Files the service reads as the duckling user: readable by its group, nothing else. A file copied in by hand as root
# would otherwise be unreadable to the service (that happened with the FCM key on 2026-11-06).
for f in /opt/duckling/.env /opt/duckling/ca-certificate.crt /opt/duckling/fcm-service-account.json; do
  [ -f "$f" ] && chown root:duckling "$f" && chmod 640 "$f"
done

# Apple's root certificates, which verify every App Store purchase and server notification (APPLE_ROOT_CERTS).
mkdir -p /opt/duckling/apple-root-certs
for u in certificateauthority/AppleRootCA-G3.cer certificateauthority/AppleRootCA-G2.cer appleca/AppleIncRootCertificate.cer; do
  c=$(basename "$u")
  [ -s "/opt/duckling/apple-root-certs/$c" ] || curl -fsSL "https://www.apple.com/$u" -o "/opt/duckling/apple-root-certs/$c" || echo "could not fetch $c"
done

# English and Spanish stay paired: an app, manifest or shell line with no Spanish stops the deploy before anything is
# built or published (tools/lang-check.mjs needs only Node). The web app and the portal are checked once the backend's
# test tools are installed, below.
node "$SRC/tools/lang-check.mjs"

cd "$SRC/backend"
# The droplet has 1 GB shared with Pitch Jam: keep npm and tsc small.
export NODE_OPTIONS=--max-old-space-size=384
npm ci --no-audit --no-fund --loglevel=error
npx vitest run test/i18n.test.ts --reporter=dot
npm run build
npm prune --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$SRC"

# The child web app (app.ducklingtablet.com): built here, served by nginx from /opt/duckling/www/app.
cd "$SRC/web"
npm ci --no-audit --no-fund --loglevel=error
npm run build
mkdir -p /opt/duckling/www/app
rsync -a --delete "$SRC/web/dist/" /opt/duckling/www/app/

# The parent portal (parents.ducklingtablet.com): built here, served by nginx from /opt/duckling/www/portal.
cd "$SRC/portal"
npm ci --no-audit --no-fund --loglevel=error
npm run build
mkdir -p /opt/duckling/www/portal
rsync -a --delete "$SRC/portal/dist/" /opt/duckling/www/portal/

# The publish tool's dependencies, so `node tools/publish.mjs` works on the droplet.
cd "$SRC/tools" && npm ci --no-audit --no-fund --loglevel=error
cd "$SRC/backend"

# The public site: static files that nginx serves from /opt/duckling/www/site.
mkdir -p /opt/duckling/www/site
rsync -a --delete "$SRC/site/" /opt/duckling/www/site/

if [ "${1:-}" = "--bootstrap" ]; then
  read -rsp 'doadmin connection string (postgresql://doadmin:...@private-host:25060/duckling?sslmode=require): ' DATABASE_URL_ADMIN; echo
  export DATABASE_URL_ADMIN
  DOTENV_CONFIG_PATH="$ENV_FILE" node dist/bootstrap.js --write "$ENV_FILE"
  unset DATABASE_URL_ADMIN
fi

DOTENV_CONFIG_PATH="$ENV_FILE" node dist/migrate.js
systemctl restart duckling-api
# Node and the first database connection take a few seconds on this droplet: wait up to 60 s for /health, and only
# then call it a failure (a fixed short sleep failed healthy deploys and skipped the app publish below).
healthy=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/health; then echo; healthy=1; break; fi
  systemctl is-active --quiet duckling-api || break
  sleep 2
done
if [ "$healthy" != 1 ]; then echo; echo "duckling-api did not answer /health"; journalctl -u duckling-api -n 40 --no-pager; exit 1; fi

# Apps: any app or version in apps/ that the catalog does not have yet is packaged, signed and published. Versions the
# catalog already has are left alone, so this is cheap on a deploy with no app changes.
cd "$SRC"
DOTENV_CONFIG_PATH="$ENV_FILE" node tools/publish.mjs all | grep -v 'already published' || true
echo "deployed"
