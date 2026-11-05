<#
.SYNOPSIS
    Deploys the backend to the droplet: copies the source, installs and builds there, applies database migrations
    as duckling_system, restarts the service, and checks /health. Run from D:\VS_Projects\DucklingTablet in
    PowerShell. Needs OpenSSH (built into Windows) and an SSH key that root@<droplet> accepts.

.PARAMETER Bootstrap
    First deploy only (or to rotate the database passwords): asks for the doadmin connection string on the droplet,
    creates the duckling_system and duckling_app roles and the schema, and writes DATABASE_URL_SYSTEM and
    DATABASE_URL_APP into /opt/duckling/.env. The doadmin string is typed on the droplet and kept nowhere.
#>
param(
    [string]$Server = '157.230.59.100',
    [string]$User = 'root',
    [switch]$Bootstrap
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $env:TEMP "duckling-backend-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Path $stage | Out-Null

# Source only: no node_modules, dist, data or .env.
robocopy (Join-Path $root 'backend') $stage /E /XD node_modules dist data /XF .env /NFL /NDL /NJH /NJS | Out-Null
$tar = "$stage.tgz"
tar -czf $tar -C $stage .

scp $tar "$User@${Server}:/tmp/duckling-backend.tgz"

$bootstrapStep = ''
if ($Bootstrap) {
    $bootstrapStep = @'
read -rsp 'doadmin connection string (postgresql://doadmin:...@private-host:25060/duckling?sslmode=require): ' DATABASE_URL_ADMIN; echo
export DATABASE_URL_ADMIN
DOTENV_CONFIG_PATH=/opt/duckling/.env node dist/bootstrap.js --write /opt/duckling/.env
unset DATABASE_URL_ADMIN
'@
}

$remote = @"
set -e
test -f /opt/duckling/ca-certificate.crt || { echo 'Missing /opt/duckling/ca-certificate.crt (see deploy/setup-droplet.sh)'; exit 1; }
cd /opt/duckling/backend
find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf /tmp/duckling-backend.tgz -C /opt/duckling/backend
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev
chown -R root:root /opt/duckling/backend
$bootstrapStep
DOTENV_CONFIG_PATH=/opt/duckling/.env node dist/migrate.js
systemctl restart duckling-api
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo
"@
# -t gives the bootstrap prompt a terminal; it is harmless otherwise.
ssh -t "$User@$Server" $remote
Remove-Item $stage -Recurse -Force; Remove-Item $tar -Force
Write-Host "Deployed. Public check: https://api.ducklingtablet.com/health"
