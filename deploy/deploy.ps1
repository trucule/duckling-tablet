<#
.SYNOPSIS
    Deploys the backend: runs deploy/deploy-remote.sh on the droplet over ssh, which pulls main from GitHub,
    installs and builds, applies migrations, restarts duckling-api and prints /health. Push first.
    Needs OpenSSH (built into Windows) and an SSH key that root@<droplet> accepts.

.PARAMETER Bootstrap
    First deploy only (or to rotate the database passwords): the script asks for the doadmin connection string on
    the droplet, creates the duckling_system and duckling_app roles and writes their URLs into /opt/duckling/.env.
    The doadmin string is typed on the droplet and kept nowhere.
#>
param(
    [string]$Server = '157.230.59.100',
    [string]$User = 'root',
    [switch]$Bootstrap
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ssh-agent.ps1')
Use-DucklingSshKey
$flag = if ($Bootstrap) { '--bootstrap' } else { '' }
# -t gives the bootstrap prompt a terminal; it is harmless otherwise.
ssh -t "$User@$Server" "bash /opt/duckling/src/deploy/deploy-remote.sh $flag"
Write-Host "Public check: https://api.ducklingtablet.com/health"
