<#
Pings a WordPress site on an interval to stop a shared host from putting it to
sleep. Run once with -Install to register a Windows Scheduled Task that keeps
doing this in the background while this PC is on.

Pings all come from this one machine's public IP, which is easy to whitelist
in Wordfence's country blocking / firewall allowlist — unlike a third-party
uptime service, which pings from many rotating IPs. Use -ShowIp to print the
exact IP to whitelist.

This is a standalone ops script, not part of the plugin itself — package.ps1
excludes it from the release ZIP.

Examples:
  .\keep-alive.ps1 -ShowIp                             # print the IP to whitelist in Wordfence
  .\keep-alive.ps1 -Url "https://example.com" -Install
  .\keep-alive.ps1 -Uninstall
  .\keep-alive.ps1 -Url "https://example.com"          # single ping, for manual testing
#>

param(
    [string]$Url,
    [int]$IntervalMinutes = 5,
    [int]$TimeoutSec = 30,
    [string]$LogPath,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$ShowIp,
    [string]$TaskName = "CSST-KeepAlive"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = $MyInvocation.MyCommand.Path
if (-not $LogPath) {
    $LogPath = Join-Path (Split-Path $scriptPath -Parent) "keep-alive.log"
}

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

if ($ShowIp) {
    $ip = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec $TimeoutSec).Trim()
    Write-Host "Public IP of this machine: $ip"
    Write-Host "Add this IP to Wordfence's country blocking allowlist / firewall allowlist so pings from this script aren't blocked as international traffic."
    exit 0
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "Scheduled task '$TaskName' was not found."
    }
    exit 0
}

if ($Install) {
    if ([string]::IsNullOrWhiteSpace($Url)) {
        throw "Pass -Url when installing, e.g. .\keep-alive.ps1 -Url 'https://example.com' -Install"
    }

    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Url `"$Url`" -TimeoutSec $TimeoutSec -LogPath `"$LogPath`""

    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description "Pings $Url every $IntervalMinutes minute(s) to stop the shared host from sleeping." `
        -Force | Out-Null

    Write-Host "Installed scheduled task '$TaskName': pings $Url every $IntervalMinutes minute(s)."
    Write-Host "Log file: $LogPath"
    Write-Host ""
    Write-Host "Note: this task runs on this PC's schedule and only while the PC is on."
    Write-Host "It will not keep the site awake overnight or while the PC is off/asleep."
    Write-Host "Run .\keep-alive.ps1 -ShowIp and whitelist that IP in Wordfence if pings start getting blocked as international traffic."
    exit 0
}

if ([string]::IsNullOrWhiteSpace($Url)) {
    throw "Url is required, e.g. .\keep-alive.ps1 -Url 'https://example.com'"
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing
    $stopwatch.Stop()
    Write-Log "OK   status=$($response.StatusCode) elapsedMs=$($stopwatch.ElapsedMilliseconds) url=$Url"
} catch {
    $stopwatch.Stop()
    Write-Log "FAIL elapsedMs=$($stopwatch.ElapsedMilliseconds) url=$Url error=$($_.Exception.Message)"
}
