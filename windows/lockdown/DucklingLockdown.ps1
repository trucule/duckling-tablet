#Requires -Version 5.1
<#
    DucklingLockdown.ps1: the Windows parts of Duckling's lockdown, run by DucklingService as SYSTEM.

    Taken from the Surface project's KidTablet module (proven on Scarlett's Surface Pro X): the child's local account
    with automatic sign-in, her per-user settings, the Assigned Access kiosk applied through the MDM bridge, and the
    clean-up of that older setup. The service builds the kiosk XML itself; this script applies it.

    Every action prints one line of JSON as its last output. Errors go to stderr with a non-zero exit code.

      -Action Status
      -Action EnsureChild    -UserName <name> [-FullName <name>]
      -Action ChildSettings  -UserName <name>
      -Action ApplyKiosk     -XmlPath <file>
      -Action RemoveKiosk
      -Action MigrateKidTablet -Destination <folder> [-UserName <name>]
      -Action Release
      -Action LogoffUser     -UserName <name>
#>
param(
    [Parameter(Mandatory)][ValidateSet('Status', 'EnsureChild', 'ChildSettings', 'ApplyKiosk', 'RemoveKiosk', 'MigrateKidTablet', 'Release', 'LogoffUser')]
    [string]$Action,
    [string]$UserName,
    [string]$FullName,
    [string]$XmlPath,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$WinlogonKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$ProfileId   = '{8E1D6B52-4C3A-4F0E-9B7D-2A6C5E8F1D30}'
$HiveName    = 'DucklingChildHive'
$BuiltIn     = @('Administrator', 'DefaultAccount', 'Guest', 'WDAGUtilityAccount', 'defaultuser0', 'defaultuser100000')

function Out-Json($o) { $o | ConvertTo-Json -Depth 6 -Compress }

function Set-RegValue {
    param([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord')
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force -ErrorAction Stop | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force -ErrorAction Stop | Out-Null
}

function Assert-SafeUserName([string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 20 -or $Name -match '["/\\\[\]:;|=,+*?<>@]' -or $Name.Trim() -ne $Name) {
        throw "'$Name' cannot be a Windows account name. Use up to 20 letters, digits, spaces, dots, dashes or underscores."
    }
}

function Get-Edition {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    # Windows 11 still reports "Windows 10" in ProductName; build 22000 and later is Windows 11.
    $name = [string]$cv.ProductName
    if ([int]$cv.CurrentBuildNumber -ge 22000) { $name = $name -replace '^Windows 10', 'Windows 11' }
    [pscustomobject]@{ EditionID = [string]$cv.EditionID; Build = [int]$cv.CurrentBuildNumber; Name = $name }
}

function Test-KioskSupported($ed) { ($ed.EditionID -notlike 'Core*') -and ($ed.Build -ge 22621) }

function Get-AssignedAccess {
    try { Get-CimInstance -Namespace 'root\cimv2\mdm\dmmap' -ClassName 'MDM_AssignedAccess' -ErrorAction Stop } catch { $null }
}

function Get-StandardAccounts {
    $admins = @()
    try { $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { ($_.Name -split '\\')[-1] }) } catch { }
    @(Get-LocalUser | Where-Object { $_.Enabled -and ($BuiltIn -notcontains $_.Name) -and ($admins -notcontains $_.Name) } |
        ForEach-Object { [pscustomobject]@{ name = $_.Name; fullName = [string]$_.FullName } })
}

function New-RandomPassword {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + 'a1!') -AsPlainText -Force
}

function Get-UserSid([string]$Name) {
    $u = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
    if (-not $u) { throw "Local account '$Name' does not exist." }
    $u.SID.Value
}

# Runs $Script against the account's HKCU: the live hive while it is signed in, otherwise NTUSER.DAT loaded for the
# moment. Before the first sign-in there is no profile yet; the service runs this again at that sign-in.
function Invoke-UserHive([string]$Name, [scriptblock]$Script) {
    $sid = Get-UserSid $Name
    $live = "Registry::HKEY_USERS\$sid"
    if (Test-Path $live) { & $Script $live; return $true }
    $prof = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
    if (-not $prof) { return $false }
    & reg.exe load "HKU\$HiveName" (Join-Path $prof.LocalPath 'NTUSER.DAT') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not load the child account registry hive.' }
    try { & $Script "Registry::HKEY_USERS\$HiveName" }
    finally {
        [GC]::Collect(); [GC]::WaitForPendingFinalizers(); Start-Sleep -Milliseconds 500
        & reg.exe unload "HKU\$HiveName" | Out-Null
    }
    $true
}

function Get-OldKidTablet {
    $tasks = @()
    try { $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like 'KidTablet-*' } | ForEach-Object { $_.TaskName }) } catch { }
    $paths = @(
        (Join-Path $env:ProgramData 'KidTablet'),
        (Join-Path $env:ProgramFiles 'KidTablet'),
        'C:\KidTabletApps',
        (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules\KidTablet'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Kid Apps')
    ) | Where-Object { Test-Path $_ }
    [pscustomobject]@{ present = ($tasks.Count -gt 0 -or @($paths).Count -gt 0); tasks = $tasks; paths = @($paths) }
}

switch ($Action) {
    'Status' {
        $ed = Get-Edition
        $aa = Get-AssignedAccess
        $cfg = if ($aa) { [string]$aa.Configuration } else { '' }
        $auto = (Get-ItemProperty $WinlogonKey -ErrorAction SilentlyContinue)
        $autoUser = if ($auto -and [string]$auto.AutoAdminLogon -eq '1') { [string]$auto.DefaultUserName } else { '' }
        $old = Get-OldKidTablet
        Out-Json ([pscustomobject]@{
            edition = $ed.EditionID; build = $ed.Build; productName = $ed.Name
            kioskSupported = (Test-KioskSupported $ed)
            accounts = @(Get-StandardAccounts)
            autoSignInUser = $autoUser
            kioskApplied = ($cfg -like "*$ProfileId*")
            otherKiosk = ($cfg -ne '' -and $cfg -notlike "*$ProfileId*")
            oldKidTablet = $old.present
            computerName = $env:COMPUTERNAME
        })
    }

    'EnsureChild' {
        Assert-SafeUserName $UserName
        if ($BuiltIn -contains $UserName) { throw "$UserName is a built-in account." }
        $password = New-RandomPassword
        $existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
        if ($existing) {
            # An existing account (the child's account from the older setup, say) keeps its profile; only the password
            # changes, to a random one nobody types, since automatic sign-in signs her in.
            Set-LocalUser -Name $UserName -Password $password -PasswordNeverExpires $true
            if (-not $existing.Enabled) { Enable-LocalUser -Name $UserName }
        } else {
            $fn = if ($FullName) { $FullName } else { $UserName }
            New-LocalUser -Name $UserName -FullName $fn -Password $password -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
        }
        try { Add-LocalGroupMember    -SID 'S-1-5-32-545' -Member $UserName -ErrorAction Stop } catch { }   # Users: already a member
        try { Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $UserName -ErrorAction Stop } catch { }   # never an administrator

        $plain = [System.Net.NetworkCredential]::new('', $password).Password
        Set-RegValue $WinlogonKey 'AutoAdminLogon'    '1'               String
        Set-RegValue $WinlogonKey 'DefaultUserName'   $UserName         String
        Set-RegValue $WinlogonKey 'DefaultDomainName' $env:COMPUTERNAME String
        Set-RegValue $WinlogonKey 'DefaultPassword'   $plain            String
        Remove-ItemProperty -Path $WinlogonKey -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
        Remove-Variable plain

        # Waking from sleep returns to her session: with a password nobody knows, a sign-in prompt would lock her out.
        & powercfg.exe /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
        & powercfg.exe /SETDCVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
        & powercfg.exe /SETACTIVE SCHEME_CURRENT | Out-Null
        # The kiosk blocks the widget board, which otherwise shows "blocked by your administrator" at sign-in.
        try { Set-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Dsh' 'AllowNewsAndInterests' 0 } catch { }
        # Microphone and camera for her apps (Read It Say It, Camera Fun, Voice Band): allowed at the device level.
        $consent = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore'
        foreach ($cap in 'microphone', 'webcam') { try { Set-RegValue "$consent\$cap" 'Value' 'Allow' String } catch { } }
        Out-Json ([pscustomobject]@{ userName = $UserName; created = (-not $existing) })
    }

    'ChildSettings' {
        Assert-SafeUserName $UserName
        $done = Invoke-UserHive $UserName {
            param($root)
            $consent = "$root\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"
            foreach ($cap in 'microphone', 'webcam') {
                Set-RegValue "$consent\$cap" 'Value' 'Allow' String
                Set-RegValue "$consent\$cap\NonPackaged" 'Value' 'Allow' String
            }
            $cdm = "$root\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"
            foreach ($n in 'RotatingLockScreenOverlayEnabled', 'SubscribedContent-338387Enabled', 'SubscribedContent-338388Enabled',
                           'SubscribedContent-338389Enabled', 'SystemPaneSuggestionsEnabled', 'SoftLandingEnabled', 'SilentInstalledAppsEnabled') {
                Set-RegValue $cdm $n 0
            }
            # Edge swipes open Task View and notifications.
            Set-RegValue "$root\Software\Policies\Microsoft\Windows\EdgeUI" 'AllowEdgeSwipe' 0
            Set-RegValue "$root\Control Panel\Desktop" 'ScreenSaverIsSecure' '0' String
            # The older setup's home screen start and its Edge allowlist do not apply to Duckling.
            Remove-ItemProperty -Path "$root\Software\Microsoft\Windows\CurrentVersion\Run" -Name 'KidHome' -ErrorAction SilentlyContinue
            # Duckling starts at sign-in from here as well as from the kiosk's AutoLaunch, which Windows does not always
            # honor (the Surface setup needed the same). Duckling is single-instance, so two starts open one window.
            $duck = Join-Path ${env:ProgramFiles} 'Duckling Tablet\Duckling.exe'
            Set-RegValue "$root\Software\Microsoft\Windows\CurrentVersion\Run" 'Duckling' "`"$duck`"" String
            # Windows holds sign-in programs back until the desktop settles; with these, the Run entry starts at once.
            Set-RegValue "$root\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize" 'StartupDelayInMSec' 0
            Set-RegValue "$root\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize" 'WaitForIdleState' 0
            foreach ($k in 'URLBlocklist', 'URLAllowlist', 'AutoplayAllowlist', 'AudioCaptureAllowedUrls', 'VideoCaptureAllowedUrls', 'LocalNetworkAccessAllowedForUrls', 'InsecurePrivateNetworkRequestsAllowedForUrls') {
                Remove-Item "$root\Software\Policies\Microsoft\Edge\$k" -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        Out-Json ([pscustomobject]@{ applied = [bool]$done })
    }

    'ApplyKiosk' {
        if (-not (Test-Path $XmlPath)) { throw "Kiosk profile not found at $XmlPath." }
        $ed = Get-Edition
        if (-not (Test-KioskSupported $ed)) { throw "Windows $($ed.EditionID) (build $($ed.Build)) has no multi-app kiosk." }
        $aa = Get-AssignedAccess
        if (-not $aa) { throw 'The Assigned Access MDM bridge is not available on this device.' }
        $aa.Configuration = [System.Net.WebUtility]::HtmlEncode((Get-Content $XmlPath -Raw))
        Set-CimInstance -CimInstance $aa
        Out-Json ([pscustomobject]@{ applied = $true })
    }

    'RemoveKiosk' {
        $aa = Get-AssignedAccess
        if ($aa -and [string]$aa.Configuration) { $aa.Configuration = $null; Set-CimInstance -CimInstance $aa }
        Out-Json ([pscustomobject]@{ removed = $true })
    }

    'MigrateKidTablet' {
        # The Surface setup that came before Duckling: its tasks stop, and its folders move into $Destination (kept, not
        # deleted, so nothing is lost). Its kiosk is replaced when Duckling applies its own.
        $old = Get-OldKidTablet
        foreach ($t in $old.tasks) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
        Get-Process -Name 'KidHome' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        $moved = @()
        foreach ($p in $old.paths) {
            $name = ($p -replace '[:\\ ]+', '_').Trim('_')
            $dest = Join-Path $Destination $name
            if (Test-Path $dest) { $dest = "$dest-$(Get-Date -Format yyyyMMddHHmmss)" }
            try { Move-Item -LiteralPath $p -Destination $dest -Force; $moved += $p }
            catch {
                # A folder on another drive, or with a file in use: copy, then remove what can be removed.
                Copy-Item -LiteralPath $p -Destination $dest -Recurse -Force
                Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
                $moved += $p
            }
        }
        if ($UserName) { try { & $PSCommandPath -Action ChildSettings -UserName $UserName | Out-Null } catch { } }
        Out-Json ([pscustomobject]@{ tasks = $old.tasks; moved = $moved; destination = $Destination })
    }

    'Release' {
        if ($UserName) { try { Invoke-UserHive $UserName { param($root) Remove-ItemProperty -Path "$root\Software\Microsoft\Windows\CurrentVersion\Run" -Name 'Duckling' -ErrorAction SilentlyContinue } | Out-Null } catch { } }
        $aa = Get-AssignedAccess
        if ($aa -and [string]$aa.Configuration -like "*$ProfileId*") { $aa.Configuration = $null; Set-CimInstance -CimInstance $aa }
        Set-RegValue $WinlogonKey 'AutoAdminLogon' '0' String
        Remove-ItemProperty -Path $WinlogonKey -Name 'DefaultPassword' -ErrorAction SilentlyContinue
        Out-Json ([pscustomobject]@{ released = $true })
    }

    'LogoffUser' {
        Assert-SafeUserName $UserName
        $line = @(quser.exe 2>$null) | Where-Object { $_ -match "^\s*>?$([regex]::Escape($UserName))\s" } | Select-Object -First 1
        if (-not $line) { Out-Json ([pscustomobject]@{ signedOut = $false }); break }
        $id = ($line.Trim() -split '\s+') | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
        & logoff.exe $id
        Out-Json ([pscustomobject]@{ signedOut = $true; session = [int]$id })
    }
}
