<#
    Builds the Windows Service and the Tauri desktop app, then bundles the NSIS installer.

    Two machine-specific things this script exists to handle:

    1. This PC has no MSVC linker, so the Rust GNU toolchain + MinGW-w64 are used.
       Cargo and gcc are added to PATH explicitly because a fresh PowerShell
       session here does not reliably inherit them.

    2. GNU `windres` (which embeds the app icon and version info) cannot handle
       the spaces and the bare "-" in this project's path -- it splits them into
       invalid command-line arguments and fails. Building into a space-free
       CARGO_TARGET_DIR avoids that entirely.
#>

[CmdletBinding()]
param(
    [switch]$Bundle,
    [string]$TargetDir = 'C:\controll-build'
)

$ErrorActionPreference = 'Stop'

$mingwBin = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
$env:Path = "$env:USERPROFILE\.cargo\bin;$mingwBin;$env:Path"
$env:CARGO_TARGET_DIR = $TargetDir

$repoRoot = $PSScriptRoot
Set-Location $repoRoot

Write-Host 'Building Windows Service (release)...' -ForegroundColor Cyan
cargo build --release -p service
if ($LASTEXITCODE -ne 0) { throw 'service build failed' }

# The installer ships the service binary as a Tauri resource. Copying it to a
# fixed path inside src-tauri keeps tauri.conf.json independent of wherever
# CARGO_TARGET_DIR happens to point.
$binDir = Join-Path $repoRoot 'app\src-tauri\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item (Join-Path $TargetDir 'release\controll-server-monitor-service.exe') $binDir -Force

if ($Bundle) {
    Write-Host 'Building desktop app + NSIS installer...' -ForegroundColor Cyan
    cargo tauri build --config app/src-tauri/tauri.conf.json
} else {
    Write-Host 'Building desktop app (release)...' -ForegroundColor Cyan
    cargo build --release -p app
}
if ($LASTEXITCODE -ne 0) { throw 'app build failed' }

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  Service: $TargetDir\release\controll-server-monitor-service.exe"
Write-Host "  App:     $TargetDir\release\controll-server-monitor.exe"
if ($Bundle) {
    Write-Host "  Installer: $TargetDir\release\bundle\nsis\"
}
