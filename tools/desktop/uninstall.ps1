<#
.SYNOPSIS
  Removes the installed WooSSH Explorer desktop app for the current user.

.DESCRIPTION
  Runs the generated uninstaller silently and reports whether the install
  directory and shortcuts are gone. Saved hosts and known_hosts under
  %APPDATA%\WooSSH Explorer are intentionally kept.

.EXAMPLE
  npm run uninstall-app
#>
[CmdletBinding()]
param([switch]$PassThru)

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\WooSSH Explorer'
$uninstaller = Join-Path $installDir 'Uninstall WooSSH Explorer.exe'

if (-not (Test-Path $uninstaller)) {
  Write-Host 'WooSSH Explorer does not appear to be installed.'
  return
}

Write-Host 'Uninstalling WooSSH Explorer ...'
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
Start-Sleep -Seconds 4

$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WooSSH Explorer.lnk'
$startLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WooSSH Explorer.lnk'

$result = [pscustomobject]@{
  ExitCode      = $process.ExitCode
  InstallDir    = Test-Path $installDir
  DesktopLink   = Test-Path $desktopLink
  StartMenuLink = Test-Path $startLink
  SettingsKept  = Test-Path (Join-Path $env:APPDATA 'WooSSH Explorer')
}

if ($PassThru) { $result } else { $result | Format-List }
