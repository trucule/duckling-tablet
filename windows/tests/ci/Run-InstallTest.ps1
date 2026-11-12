<#
    CI: installs the MSI, checks the service and its pipe, drives Duckling.exe against test.html (PIN, lockdown
    status, other apps, a real signed package from the production catalog installed and opened), takes screenshots,
    then uninstalls and checks that nothing is left. Fails on the first broken expectation.
#>
param([Parameter(Mandatory)][string]$Msi, [string]$Out = 'windows\out\ci')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$web = Join-Path $Out 'web'
New-Item -ItemType Directory -Force -Path $web | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'test.html') (Join-Path $web 'index.html')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Assert($cond, [string]$what) { if (-not $cond) { throw "FAILED: $what" } ; Write-Host "ok  $what" }
function Shot([string]$name) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Out "$name.png")); $g.Dispose()
    # Also into the log as a small JPEG in base64 lines, for readers who cannot download artifacts.
    $w = [math]::Min(960, $b.Width); $h = [int]($b.Height * $w / $b.Width)
    $small = New-Object System.Drawing.Bitmap $bmp, $w, $h
    $ms = New-Object System.IO.MemoryStream
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 70L
    $small.Save($ms, $enc, $ep)
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    for ($i = 0; $i -lt $b64.Length; $i += 4000) { Write-Host "SHOT $name $($b64.Substring($i, [math]::Min(4000, $b64.Length - $i)))" }
    $small.Dispose(); $bmp.Dispose()
}
function Pipe([string]$op, $argsObj = @{}) {
    $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'DucklingTablet', [System.IO.Pipes.PipeDirection]::InOut)
    $c.Connect(5000)
    $w = New-Object System.IO.StreamWriter($c); $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object System.IO.StreamReader($c)
    $w.WriteLine((@{ op = $op; args = $argsObj } | ConvertTo-Json -Compress -Depth 5))
    $line = $r.ReadLine(); $c.Dispose()
    $line | ConvertFrom-Json
}

# ---- Install
$log = Join-Path $Out 'install.log'
$p = Start-Process msiexec.exe -ArgumentList "/i `"$((Resolve-Path $Msi).Path)`" /qn /norestart /l*v `"$log`"" -Wait -PassThru
Assert ($p.ExitCode -eq 0) "msiexec install exit code 0 (was $($p.ExitCode))"
$svc = Get-Service DucklingTablet
Assert ($svc.Status -eq 'Running') 'service DucklingTablet is running'
$dir = Join-Path $env:ProgramFiles 'Duckling Tablet'
Assert (Test-Path (Join-Path $dir 'Duckling.exe')) 'Duckling.exe installed'
Assert (Test-Path (Join-Path $dir 'lockdown\DucklingLockdown.ps1')) 'lockdown script installed'
Assert (Test-Path "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Duckling Tablet.lnk") 'Start menu tile'
Start-Sleep -Seconds 3
$hello = Pipe 'hello'
Assert ($hello.ok -and $hello.value.arch -eq 'x64') "pipe hello answers ($($hello | ConvertTo-Json -Compress))"
$st = Pipe 'lockdownStatus'
Assert ($st.ok) "lockdownStatus answers: $($st | ConvertTo-Json -Compress -Depth 6)"
$acl = (Get-Acl "$env:ProgramData\Duckling\state").Access | ForEach-Object { $_.IdentityReference.Value }
Assert (-not ($acl -match 'Users')) "state folder is not readable by Users ($($acl -join ', '))"

# ---- The catalog entry to install: Count With Me, signed with the production key.
$cat = Invoke-RestMethod 'https://api.ducklingtablet.com/catalog'
$app = $cat.apps | Where-Object id -eq 'count-with-me' | Select-Object -First 1
Assert ($null -ne $app) 'count-with-me is in the catalog'
@{ id = $app.id; version = $app.latest.version; url = $app.latest.url; sha256 = $app.latest.sha256; signature = $app.latest.signature; permissions = @($app.latest.permissions) } |
    ConvertTo-Json | Set-Content (Join-Path $web 'app.json')

# ---- Drive the shell
$server = Start-Process python -ArgumentList (Join-Path $PSScriptRoot 'server.py'), 8123, "`"$web`"" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$shell = Start-Process (Join-Path $dir 'Duckling.exe') -ArgumentList '--web-app=http://127.0.0.1:8123/' -PassThru
$deadline = (Get-Date).AddMinutes(4)
while (-not (Test-Path (Join-Path $web 'result.json')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
Shot '1-home'
Assert (Test-Path (Join-Path $web 'result.json')) 'the test page reported'
$r = Get-Content (Join-Path $web 'result.json') -Raw | ConvertFrom-Json
Write-Host ($r | ConvertTo-Json -Depth 6)
Assert (-not $r.error) "no error on the page ($($r.error))"
Assert ($r.hasShell) 'window.DucklingShell exists for the web app origin'
Assert ($r.platform -eq 'windows') 'platform is windows'
Assert ($r.typeofSubscribe -eq 'undefined') 'only Windows methods are exposed'
Assert (-not $r.hasPinBefore -and $r.hasPinAfter) 'PIN set'
Assert (-not $r.verifyWrong -and $r.verifyRight) 'PIN verified'
Assert ($null -ne $r.status.windows) 'lockdown status carries the Windows details'
Assert ($r.token -eq 'ci-token') 'device token kept by the service'
Assert ($r.badInstall.ok -eq $false) "a package with the wrong checksum is refused ($($r.badInstall.message))"
Assert ($r.install.ok -eq $true) "the signed package installs ($($r.install.message))"
Assert ($r.installed.'count-with-me' -eq $app.latest.version) 'installed version recorded'
Assert (Test-Path "$env:ProgramData\Duckling\apps\count-with-me\index.html") 'package unpacked'
Assert ($null -ne $r.wifi) 'Wi-Fi scan answered'
$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-Path (Join-Path $web 'opened.json')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 8
Shot '2-app'
$state = Pipe 'state'
Assert ($state.value.allowedHosts -contains 'pbskids.org') 'allowed hosts kept by the service'

# A tap on the Home pill (top right) leaves the app; the home screen is told it is in front again.
Add-Type -Namespace Duck -Name Mouse -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'
$sb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[Duck.Mouse]::SetCursorPos($sb.Right - 8 - 88, $sb.Top + 6 + 28) | Out-Null
[Duck.Mouse]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [Duck.Mouse]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path (Join-Path $web 'back.json')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Start-Sleep -Seconds 2
Shot '3-back'
Assert (Test-Path (Join-Path $web 'back.json')) 'the Home pill closed the app and the home screen came back'

# ---- Removal from the parent area: refused once the parent window ends, accepted with it.
$end = Pipe 'endParent'
$refused = Pipe 'release'
Assert (-not $refused.ok) "release needs the parent PIN ($($refused.error))"
Pipe 'verifyPin' @{ pin = '2468' } | Out-Null
$released = Pipe 'release'
Assert ($released.ok) 'release with the parent PIN'
Assert (-not (Test-Path "$env:ProgramData\Duckling\apps\count-with-me")) 'apps removed on release'
Stop-Process -Id $shell.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
# release uninstalls the MSI by itself after a few seconds
$deadline = (Get-Date).AddSeconds(120)
# Windows Installer deletes the service before it removes the files, so wait for both.
while (((Get-Service DucklingTablet -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $dir 'Duckling.exe'))) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
Assert (-not (Get-Service DucklingTablet -ErrorAction SilentlyContinue)) 'release uninstalled Duckling (service gone)'
Assert (-not (Test-Path (Join-Path $dir 'Duckling.exe'))) 'program files removed'
Copy-Item "$env:ProgramData\Duckling\logs\*" $Out -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\Duckling\shell.log" $Out -ErrorAction SilentlyContinue
Get-Content (Join-Path $Out 'service.log') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "LOG service $_" }
Get-Content (Join-Path $Out 'shell.log') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "LOG shell $_" }
Write-Host 'All Windows install checks passed.'
