#!/usr/bin/env bash
# One-time setup on the droplet (run as root): user, folders, Node 22, systemd units.
# Usage: scp -r deploy root@157.230.59.100:/tmp/duckling-deploy && ssh root@157.230.59.100 bash /tmp/duckling-deploy/setup-droplet.sh
set -euo pipefail

id duckling >/dev/null 2>&1 || useradd --system --home /opt/duckling --shell /usr/sbin/nologin duckling
mkdir -p /opt/duckling/backend /opt/duckling/data /opt/duckling/www/{app,portal,site}
chown -R duckling:duckling /opt/duckling/data

# Node 22 (Pitch Jam may already have Node; this only installs it when missing or older than 22).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y build-essential python3 >/dev/null   # in case better-sqlite3 has to compile

# .env starts from the template; fill in the secrets afterwards (nano /opt/duckling/.env).
[ -f /opt/duckling/.env ] || cp /tmp/duckling-deploy/env.example /opt/duckling/.env
chown root:duckling /opt/duckling/.env && chmod 640 /opt/duckling/.env

cp /tmp/duckling-deploy/duckling-api.service /tmp/duckling-deploy/duckling-backup.service /tmp/duckling-deploy/duckling-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable duckling-api duckling-backup.timer

echo
echo "Web server on this droplet:"
systemctl is-active --quiet nginx && echo "  nginx is running: use deploy/nginx-ducklingtablet.conf"
systemctl is-active --quiet caddy && echo "  Caddy is running: use deploy/Caddyfile.ducklingtablet"
echo "Memory:"; free -m | sed -n '1,2p'
echo
echo "Next: fill in /opt/duckling/.env, then run deploy.ps1 from your PC."
