<#
.SYNOPSIS
  Installs the built WooSSH Explorer desktop app for the current user.

.DESCRIPTION
  Runs the NSIS installer silently (per-user, no admin prompt), then checks that
  the Desktop and Start Menu shortcuts really exist. The app is installed to
  %LOCALAPPDATA%\Programs\WooSSH Explorer and appears in Add/Remove programs.

.EXAMPLE
  npm run install-app
#>
[CmdletBinding()]
param(
  [string]$Setup,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not $Setup) {
  $candidate = Get-ChildItem -Path (Join-Path $repo 'release') -Filter 'WooSSH Explorer-Setup-*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $candidate) {
    throw "No installer found in $repo\release. Build it first: npm run dist"
  }
  $Setup = $candidate.FullName
}

Write-Host "Installing $([System.IO.Path]::GetFileName($Setup)) ..."
$process = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
Start-Sleep -Seconds 4

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\WooSSH Explorer'
$exe = Join-Path $installDir 'WooSSH Explorer.exe'

# NSIS honours the install location it recorded on a previous install, and the product
# used to be called "SSH Explorer" — so an upgraded machine keeps the old directory while
# the executable inside is renamed. Find the executable wherever it actually landed rather
# than failing an install that in fact succeeded.
if (-not (Test-Path $exe)) {
  $legacy = Join-Path $env:LOCALAPPDATA 'Programs\SSH Explorer\WooSSH Explorer.exe'
  if (Test-Path $legacy) {
    $exe = $legacy
    $installDir = Split-Path $legacy -Parent
  }
}

$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WooSSH Explorer.lnk'
$startLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\WooSSH Explorer.lnk'

$result = [pscustomobject]@{
  Installer   = $Setup
  ExitCode    = $process.ExitCode
  InstallDir  = $installDir
  Executable  = Test-Path $exe
  DesktopLink = Test-Path $desktopLink
  StartLink   = Test-Path $startLink
}

if ($PassThru) { $result } else { $result | Format-List }

if (-not $result.Executable) { throw 'Install finished but the executable is missing.' }
if (-not $result.DesktopLink) { throw 'Install finished but the Desktop shortcut is missing.' }

Write-Host ''
Write-Host 'WooSSH Explorer is installed. Double-click the desktop shortcut to start it.'
