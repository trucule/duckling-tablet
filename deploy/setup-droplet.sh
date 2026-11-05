#!/usr/bin/env bash
# One-time setup on the droplet (run as root): user, folders, Node 22, the systemd unit, the database CA certificate.
# Usage: scp -r deploy root@157.230.59.100:/tmp/duckling-deploy && ssh root@157.230.59.100 bash /tmp/duckling-deploy/setup-droplet.sh
set -euo pipefail

id duckling >/dev/null 2>&1 || useradd --system --home /opt/duckling --shell /usr/sbin/nologin duckling
mkdir -p /opt/duckling/backend /opt/duckling/www/{app,portal,site}

# Node 22 (Pitch Jam may already have Node; this only installs it when missing or older than 22).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# .env starts from the template; fill in the settings afterwards (nano /opt/duckling/.env).
[ -f /opt/duckling/.env ] || cp /tmp/duckling-deploy/env.example /opt/duckling/.env
chown root:duckling /opt/duckling/.env && chmod 640 /opt/duckling/.env

# The managed database's CA certificate: DigitalOcean > Databases > duckling-pg > Overview > Download CA certificate.
# Copy it here as /opt/duckling/ca-certificate.crt (scp), or paste it: nano /opt/duckling/ca-certificate.crt
if [ -f /tmp/duckling-deploy/ca-certificate.crt ]; then cp /tmp/duckling-deploy/ca-certificate.crt /opt/duckling/ca-certificate.crt; fi
[ -f /opt/duckling/ca-certificate.crt ] && chown root:duckling /opt/duckling/ca-certificate.crt && chmod 640 /opt/duckling/ca-certificate.crt

# The SQLite-era backup timer, if an earlier setup installed it.
systemctl disable --now duckling-backup.timer 2>/dev/null || true
rm -f /etc/systemd/system/duckling-backup.service /etc/systemd/system/duckling-backup.timer

cp /tmp/duckling-deploy/duckling-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable duckling-api

echo
echo "Web server on this droplet:"
systemctl is-active --quiet nginx && echo "  nginx is running: use deploy/nginx-ducklingtablet.conf"
systemctl is-active --quiet caddy && echo "  Caddy is running: use deploy/Caddyfile.ducklingtablet"
echo "Memory:"; free -m | sed -n '1,2p'
[ -f /opt/duckling/ca-certificate.crt ] || echo "Missing: /opt/duckling/ca-certificate.crt (see the comment in this script)."
echo
echo "Next: fill in /opt/duckling/.env, then run deploy.ps1 -Bootstrap from your PC the first time."
