<#
    CI: installs one MSI, then a higher version over it, the way the service updates a tablet, and checks that the
    upgrade succeeds, the service is running the new version and only one Duckling Tablet is installed. Then removes
    it. Before afterInstallExecute an upgrade deleted and created the service again, which failed with error 1923 when
    the old service was still stopping and left nothing installed.
#>
param([Parameter(Mandatory)][string]$Old, [Parameter(Mandatory)][string]$New, [string]$Out = 'windows\out\ci')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Assert($cond, [string]$what) { if (-not $cond) { throw "FAILED: $what" } ; Write-Host "ok  $what" }
function Msi([string]$verb, [string]$file, [string]$log) {
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/$verb `"$file`" /qn /norestart /l*v `"$(Join-Path $Out $log)`""
    return $p.ExitCode
}
function Installed { @(Get-ChildItem HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq 'Duckling Tablet' }) }

Assert ((Msi 'i' (Resolve-Path $Old) 'upgrade-old.log') -eq 0) 'the older version installs'
$svc = Get-Service DucklingTablet
$svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
Assert ($svc.Status -eq 'Running') 'the older service runs'

$code = Msi 'i' (Resolve-Path $New) 'upgrade-new.log'
Assert ($code -eq 0 -or $code -eq 3010) "the newer version installs over it (exit $code)"
$svc = Get-Service DucklingTablet
$svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
Assert ($svc.Status -eq 'Running') 'the service runs after the upgrade'
$want = ([IO.Path]::GetFileNameWithoutExtension($New) -split '-')[1]
$have = (Get-ItemProperty 'HKLM:\SOFTWARE\ET Ducky\Duckling Tablet').Version
Assert ($have -eq $want) "the installed version is $want (have $have)"
$exe = (Get-Item 'C:\Program Files\Duckling Tablet\DucklingService.exe').VersionInfo.FileVersion
Assert ($exe -like "$want*") "the service file is the new one ($exe)"
Assert ((Installed).Count -eq 1) 'one Duckling Tablet is installed'

$code = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/x $((Get-ItemProperty 'HKLM:\SOFTWARE\ET Ducky\Duckling Tablet').ProductCode) /qn /norestart /l*v `"$(Join-Path $Out 'upgrade-remove.log')`""
Assert ($code.ExitCode -eq 0) 'it uninstalls'
Assert (-not (Get-Service DucklingTablet -ErrorAction SilentlyContinue)) 'the service is gone'
Assert ((Installed).Count -eq 0) 'nothing is left installed'
