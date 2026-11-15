<#
.SYNOPSIS
    Builds the signed Duckling Tablet installers (MSI for ARM64 and x64) on your PC.

.DESCRIPTION
    Publishes Duckling.exe and DucklingService.exe (self-contained .NET) for each architecture, signs them and their
    own DLLs with the EV code-signing certificate in one signtool call (by thumbprint, as build-and-sign-agent.ps1
    does), builds the MSIs with WiX, and signs them in a second call. Plug in the YubiKey first; signtool asks for its
    PIN twice. With -Publish, a version not above the published one stops the script before it builds anything.
    Output: windows\out\DucklingTablet-<version>-<arch>.msi and their SHA-256.

    Needs the .NET 10 SDK (winget install Microsoft.DotNet.SDK.10) and the Windows SDK's signtool. WiX comes from
    NuGet during the build; nothing to install.

.PARAMETER Version
    Three numbers, above the last published version (the service updates only to a higher one).

.PARAMETER Publish
    Also uploads the signed MSIs to the API (Publish-Release.ps1), so every Windows tablet updates to them.

.EXAMPLE
    .\windows\Build-Release.ps1 -Version 1.0.0
.EXAMPLE
    .\windows\Build-Release.ps1 -Version 1.0.1 -Arch arm64 -Publish
#>
param(
    [Parameter(Mandatory)][ValidatePattern('^\d{1,4}\.\d{1,4}\.\d{1,6}$')][string]$Version,
    [ValidateSet('arm64', 'x64')][string[]]$Arch = @('arm64', 'x64'),
    [string]$Thumbprint   = 'AE9ECF54F3987150AD36DBFD15653CEF3F1109A1',
    [string]$TimestampUrl = 'http://timestamp.sectigo.com',
    [string]$SignTool     = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.28000.0\x64\signtool.exe',
    [switch]$SkipSigning,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out  = Join-Path $root 'out'

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

function Resolve-SignTool([string]$preferred) {
    if (Test-Path $preferred) { return $preferred }
    $c = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue | Sort-Object { $_.Directory.Parent.Name } -Descending
    if (-not $c) { throw 'signtool.exe not found. Install the Windows SDK, pass -SignTool, or use -SkipSigning for a test build.' }
    $c[0].FullName
}

function Invoke-CodeSign([string]$tool, [string[]]$paths) {
    # One signtool call for many files: one YubiKey PIN prompt.
    # The YubiKey sometimes drops a signing session mid-run (SignerSign 0x8010001f, a smart card communication error).
    # Files already signed are signed again on a retry, which is harmless.
    for ($try = 1; $try -le 3; $try++) {
        & $tool sign /fd sha256 /sha1 $Thumbprint /tr $TimestampUrl /td sha256 /v @paths
        if ($LASTEXITCODE -eq 0) { break }
        if ($try -eq 3) { throw "signtool sign failed (exit $LASTEXITCODE) after 3 tries. Unplug and replug the YubiKey, then run again." }
        Write-Host "signtool failed (exit $LASTEXITCODE); trying again in 5 seconds (try $($try + 1) of 3)" -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
    & $tool verify /pa @paths | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "signature verification failed (exit $LASTEXITCODE)" }
}

$sdks = & dotnet --list-sdks 2>$null
if (-not ($sdks -match '^10\.')) { throw 'The .NET 10 SDK is needed: winget install Microsoft.DotNet.SDK.10' }
$tool = if ($SkipSigning) { $null } else { Resolve-SignTool $SignTool }

Write-Step 'Unit tests'
& dotnet test (Join-Path $root 'tests\Duckling.Tests\Duckling.Tests.csproj') -c Release --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed.' }

# Publishing: the version must be above the one tablets already have, and the deploy key goes into ssh-agent now, so
# the build stops before any work for a used version and asks for every credential at the start.
if ($Publish) {
    foreach ($a in $Arch) {
        $live = $null
        try { $live = Invoke-RestMethod "https://api.ducklingtablet.com/windows/release?arch=$a" -TimeoutSec 20 } catch { }
        if ($live -and [version]$live.version -ge [version]$Version) {
            $v = [version]$live.version
            throw "$($live.version) is already published for $a; tablets update only to a higher version. Run again with -Version $($v.Major).$($v.Minor).$($v.Build + 1)."
        }
    }
    . (Join-Path $root '..\deploy\ssh-agent.ps1')
    Use-DucklingSshKey
}

# Both architectures are published first, then signed in one signtool call and their MSIs in a second: two YubiKey
# PIN prompts for the whole build.
foreach ($a in $Arch) {
    $pub = Join-Path $out "$a\publish"
    Write-Step "Publish $a"
    if (Test-Path $pub) { Remove-Item $pub -Recurse -Force }
    foreach ($proj in 'src\Duckling.Shell\Duckling.Shell.csproj', 'src\Duckling.Service\Duckling.Service.csproj') {
        & dotnet publish (Join-Path $root $proj) -c Release -r "win-$a" --self-contained true -o $pub -p:Version=$Version -p:DebugType=none --nologo -v quiet
        if ($LASTEXITCODE -ne 0) { throw "publish $proj ($a) failed" }
    }
}
if ($tool) {
    # The Microsoft Store requires every PE file in the package to carry a valid signature. Microsoft's own files
    # come signed; ours and any third-party file without a signature are signed here, then all are checked.
    Write-Step "Sign binaries ($($Arch -join ', '))"
    $pe = @(foreach ($a in $Arch) { Get-ChildItem (Join-Path $out "$a\publish") -Recurse -File -Include *.exe, *.dll })
    $unsigned = @($pe | Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -ne 'Valid' } | ForEach-Object { $_.FullName })
    if ($unsigned.Count) { Invoke-CodeSign $tool $unsigned }
    $bad = @($pe | Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -ne 'Valid' } | ForEach-Object { $_.FullName })
    if ($bad.Count) { throw "Not signed after signing: $($bad -join ', ')" }
}
$built = @()
foreach ($a in $Arch) {
    $pub = Join-Path $out "$a\publish"
    Write-Step "MSI $a"
    & dotnet build (Join-Path $root 'installer\Duckling.Installer.wixproj') -c Release -p:Arch=$a -p:Version=$Version "-p:PublishDir=$pub\" "-p:IntermediateOutputPath=$out\$a\obj\" -o (Join-Path $out $a) --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "MSI ($a) failed" }
    $msi = Join-Path $out "$a\DucklingTablet-$Version-$a.msi"
    if (-not (Test-Path $msi)) { $msi = Get-ChildItem (Join-Path $out $a) -Filter '*.msi' | Select-Object -First 1 -ExpandProperty FullName }
    $final = Join-Path $out "DucklingTablet-$Version-$a.msi"
    Copy-Item $msi $final -Force
    $built += $final
}
if ($tool) { Write-Step 'Sign MSIs'; Invoke-CodeSign $tool $built }

Write-Step 'Done'
foreach ($f in $built) {
    $h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
    $mb = [math]::Round((Get-Item $f).Length / 1MB, 1)
    Write-Host "$f  ($mb MB)  sha256 $h"
}
if ($Publish) { & (Join-Path $root 'Publish-Release.ps1') -Version $Version -Files $built }
