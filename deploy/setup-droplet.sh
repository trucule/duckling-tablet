#!/usr/bin/env bash
# One-time setup on the droplet (run as root) after the repo is cloned to /opt/duckling/src:
#   bash /opt/duckling/src/deploy/setup-droplet.sh
# Creates the service user and folders, installs Node 22 if needed, the .env template, the systemd unit, and removes
# the SQLite-era backup timer. Safe to run again. How the clone gets there (deploy key) is in Backend-Setup.md.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

id duckling >/dev/null 2>&1 || useradd --system --home /opt/duckling --shell /usr/sbin/nologin duckling
mkdir -p /opt/duckling/www/{app,portal,site}

# Node 22 (Pitch Jam may already have Node; this only installs it when missing or older than 22).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# .env starts from the template; fill in the settings afterwards (nano /opt/duckling/.env).
[ -f /opt/duckling/.env ] || cp "$DIR/env.example" /opt/duckling/.env
chown root:duckling /opt/duckling/.env && chmod 640 /opt/duckling/.env

# The managed database's CA certificate (DigitalOcean > Databases > duckling-pg > Overview > Download CA certificate)
# goes to /opt/duckling/ca-certificate.crt; deploy-remote.sh refuses to run without it.
[ -f "$DIR/ca-certificate.crt" ] && cp "$DIR/ca-certificate.crt" /opt/duckling/ca-certificate.crt
if [ -f /opt/duckling/ca-certificate.crt ]; then chown root:duckling /opt/duckling/ca-certificate.crt && chmod 640 /opt/duckling/ca-certificate.crt; fi

# The SQLite-era pieces, if an earlier setup installed them.
systemctl disable --now duckling-backup.timer 2>/dev/null || true
rm -f /etc/systemd/system/duckling-backup.service /etc/systemd/system/duckling-backup.timer

cp "$DIR/duckling-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable duckling-api

echo
echo "Web server on this droplet:"
systemctl is-active --quiet nginx && echo "  nginx is running: use deploy/nginx-ducklingtablet.conf"
systemctl is-active --quiet caddy && echo "  Caddy is running: use deploy/Caddyfile.ducklingtablet"
echo "Memory:"; free -m | sed -n '1,2p'
[ -f /opt/duckling/ca-certificate.crt ] || echo "Missing: /opt/duckling/ca-certificate.crt"
echo
echo "Next: fill in /opt/duckling/.env, then: bash $DIR/deploy-remote.sh --bootstrap"
