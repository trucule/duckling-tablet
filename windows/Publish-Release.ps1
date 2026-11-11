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
    # A version already published for this architecture is left as it is: the server keeps one file per version, and
    # devices and the Microsoft Store may already have its hash.
    $live = $null
    try { $live = Invoke-RestMethod "https://api.ducklingtablet.com/windows/release?arch=$arch" -TimeoutSec 20 } catch { }
    if ($live -and $live.version -eq $Version) { Write-Host "$name : $Version is already published for $arch ($($live.url)); skipped." -ForegroundColor Yellow; continue }
    Write-Host "Uploading $name ..."
    scp $f "$User@${Server}:/tmp/$name"
    if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
    # The script goes to bash on its standard input: Windows PowerShell drops double quotes from arguments to native
    # programs, so nothing is quoted on the command line. The admin token is read from .env on the droplet (the file
    # is not sourced: some of its values are not shell syntax) and never leaves it.
    $script = @"
set -e
T=`$(grep -m1 '^ADMIN_TOKEN=' /opt/duckling/.env | cut -d= -f2- | tr -d '"\r')
trap 'rm -f /tmp/$name' EXIT
curl -sS --fail-with-body -X POST 'http://127.0.0.1:8787/admin/windows/releases?version=$Version&arch=$arch' -H "authorization: Bearer `$T" -H 'content-type: application/x-msi' --data-binary @/tmp/$name
echo
# Windows PowerShell ends piped text with a carriage return and newline; the last line is this comment, which bash
# ignores either way.
"@
    ($script -replace "`r", '') | ssh "$User@$Server" 'bash -s'
    if ($LASTEXITCODE -ne 0) { throw "publishing $name failed" }
}
Write-Host "Published. Check: https://api.ducklingtablet.com/windows/release"
# (Every step above stops the script on a failure, so reaching this line means both uploads were accepted.)
