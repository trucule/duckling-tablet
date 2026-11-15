# Dot-sourced by deploy.ps1, Publish-Release.ps1 and Build-Release.ps1. Puts the deploy key into the Windows ssh-agent
# so its passphrase is typed once on this PC instead of at every ssh and scp. Windows keeps keys added to its agent
# across sign-outs and restarts, protected by your Windows account; `ssh-add -d <key>` removes it again.
function Use-DucklingSshKey {
    param([string]$Key = (Join-Path $HOME '.ssh\id_duckling_ed25519'))
    if (-not (Test-Path $Key)) { return }
    $svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -ne 'Running') {
        Write-Host 'ssh will ask for the key passphrase at each connection. To type it once per PC, run this once in an administrator PowerShell, then run the script again:' -ForegroundColor Yellow
        Write-Host '  Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent' -ForegroundColor Yellow
        return
    }
    $pub = $null
    if (Test-Path "$Key.pub") { $pub = ((Get-Content "$Key.pub" -Raw) -split '\s+')[1] }
    $loaded = (& ssh-add -L 2>$null) -join "`n"
    if ($pub -and $loaded.Contains($pub)) { return }
    Write-Host 'Adding the deploy key to ssh-agent (one passphrase prompt; later runs on this PC ask for none).'
    & ssh-add $Key
    if ($LASTEXITCODE -ne 0) { throw 'ssh-add failed: the passphrase was not accepted.' }
}
