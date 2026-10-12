<#
.SYNOPSIS
  Removes the installed WooSSH desktop app for the current user.

.DESCRIPTION
  Runs the generated uninstaller silently and reports whether the install
  directory and shortcuts are gone. Saved hosts and known_hosts under
  %APPDATA%\WooSSH are intentionally kept.

.EXAMPLE
  npm run uninstall-app
#>
[CmdletBinding()]
param([switch]$PassThru)

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\WooSSH'
$uninstaller = Join-Path $installDir 'Uninstall WooSSH.exe'

if (-not (Test-Path $uninstaller)) {
  Write-Host 'WooSSH does not appear to be installed.'
  return
}

Write-Host 'Uninstalling WooSSH ...'
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
Start-Sleep -Seconds 4

$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WooSSH.lnk'
$startLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WooSSH.lnk'

$result = [pscustomobject]@{
  ExitCode      = $process.ExitCode
  InstallDir    = Test-Path $installDir
  DesktopLink   = Test-Path $desktopLink
  StartMenuLink = Test-Path $startLink
  SettingsKept  = Test-Path (Join-Path $env:APPDATA 'WooSSH')
}

if ($PassThru) { $result } else { $result | Format-List }
