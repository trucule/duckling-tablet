# Duckling Tablet for Windows

How the Windows app is built, signed, published, installed and removed. The design is in the build plan (section 15).

## What it is

- `Duckling.exe`: the home screen (app.ducklingtablet.com in WebView2) with `window.DucklingShell`, the app runner
  (`https://apps.duckling.example/<id>/`), other apps with the Home pill, and a parent browser for Stripe and Wi-Fi
  sign-in pages.
- `DucklingService` (LocalSystem): device state in `C:\ProgramData\Duckling\state` (SYSTEM and Administrators
  only), signed app packages in `C:\ProgramData\Duckling\apps`, the kiosk, Wi-Fi, self-update, removal. The shell
  reaches it over the `DucklingTablet` pipe. Turning the lockdown off, changing the PIN, removing Duckling, choosing
  the child account and joining Wi-Fi need the parent PIN (30 minutes after it is entered).
- `lockdown\DucklingLockdown.ps1`: the child's account with automatic sign-in, her per-user settings, the Assigned
  Access kiosk through the MDM bridge, and moving the older KidTablet setup aside to
  `C:\ProgramData\Duckling\old-kidtablet`.
- Logs: `C:\ProgramData\Duckling\logs\service.log`, and `%LOCALAPPDATA%\Duckling\shell.log` in each account.

## Build and sign (your PC)

Needs the .NET 10 SDK (`winget install Microsoft.DotNet.SDK.10`), the Windows SDK's signtool, and the YubiKey.

```powershell
cd D:\VS_Projects\DucklingTablet
git fetch; git reset --hard origin/main
.\windows\Build-Release.ps1 -Version 1.0.0            # both architectures; -Arch arm64 for the Surface only
.\windows\Publish-Release.ps1 -Version 1.0.0 -Files .\windows\out\DucklingTablet-1.0.0-arm64.msi, .\windows\out\DucklingTablet-1.0.0-x64.msi
```

`Build-Release.ps1 -Publish` does both. Every tablet's service installs a higher published version within a day, when
nobody is signed in or between 2 and 5 at night, after checking its SHA-256 and that it is signed by ET Ducky LLC.

## Install on a device

1. Sign in with a parent's (administrator) Windows account and run the MSI.
2. Open Duckling Tablet from Start. Pair with a code from the parent portal, or sign up with email.
3. Set the PIN. The parent area lists three steps: the child's Windows account (an existing standard account or a new
   one), Lock the account to Duckling (Assigned Access; Windows 11 Pro, Enterprise or Education), Restart.

Silent install (ET Ducky or msiexec): `msiexec /i DucklingTablet-1.0.0-arm64.msi /qn`.

To use Windows yourself afterwards: Ctrl+Alt+Delete, Sign out, and hold Shift while the sign-in screen appears.

## Remove

From the parent area (Remove Duckling from this device), or uninstall from Settings in a parent's account. Either way
the kiosk and automatic sign-in are turned off and the device state and apps are removed. The child's account stays.
