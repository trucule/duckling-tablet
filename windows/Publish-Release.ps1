<#
.SYNOPSIS
    Publishes signed Duckling Tablet MSIs: copies them to the droplet and posts them to the API's admin route there
    (the admin token stays in /opt/duckling/.env and is read on the droplet). Every Windows tablet's service then
    installs the new version within a day, at a quiet moment.

.EXAMPLE
    .\windows\Publish-Release.ps1 -Version 1.0.1 -Files .\windows\out\DucklingTablet-1.0.1-arm64.msi, .\windows\out\DucklingTablet-1.0.1-x64.msi
#>
param(
    [Parameter(Mandatory)][ValidatePattern('^\d{1,4}\.\d{1,4}\.\d{1,6}$')][string]$Version,
    [Parameter(Mandatory)][string[]]$Files,
    [string]$Server = '157.230.59.100',
    [string]$User = 'root'
)
$ErrorActionPreference = 'Stop'
foreach ($f in $Files) {
    $name = Split-Path $f -Leaf
    if ($name -notmatch "^DucklingTablet-$([regex]::Escape($Version))-(arm64|x64)\.msi$") { throw "$name is not DucklingTablet-$Version-<arm64|x64>.msi" }
    $arch = $Matches[1]
    $sig = Get-AuthenticodeSignature $f
    if ($sig.Status -ne 'Valid') { throw "$name is not signed (signature status $($sig.Status)). Build it with Build-Release.ps1 and the YubiKey." }
    Write-Host "Uploading $name ..."
    scp $f "$User@${Server}:/tmp/$name"
    if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
    $cmd = "set -a; . /opt/duckling/.env; set +a; curl -sS --fail-with-body -X POST 'http://127.0.0.1:8787/admin/windows/releases?version=$Version&arch=$arch' -H `"authorization: Bearer `$ADMIN_TOKEN`" -H 'content-type: application/x-msi' --data-binary @/tmp/$name; echo; rm -f /tmp/$name"
    ssh "$User@$Server" $cmd
    if ($LASTEXITCODE -ne 0) { throw "publishing $name failed" }
}
Write-Host "Published. Check: https://api.ducklingtablet.com/windows/release"
