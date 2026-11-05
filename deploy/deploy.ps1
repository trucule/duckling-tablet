<#
.SYNOPSIS
    Deploys the backend to the droplet: copies the source, installs and builds there, restarts the service,
    and checks /health. Run from D:\VS_Projects\DucklingTablet in PowerShell. Needs OpenSSH (built into Windows)
    and an SSH key that root@<droplet> accepts.
#>
param(
    [string]$Server = '157.230.59.100',
    [string]$User = 'root'
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
$remote = @'
set -e
cd /opt/duckling/backend
find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf /tmp/duckling-backend.tgz -C /opt/duckling/backend
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev
chown -R root:root /opt/duckling/backend
systemctl restart duckling-api
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo
'@
ssh "$User@$Server" $remote
Remove-Item $stage -Recurse -Force; Remove-Item $tar -Force
Write-Host "Deployed. Public check: https://api.ducklingtablet.com/health"
