## [1.7.7] - 2026-08-06

- Fixed the Remote Monitoring API being unreachable on sites where a hardening plugin/snippet locks the whole REST API behind a login (e.g. the "Members" plugin's Private REST API option) — such plugins reject requests via `rest_authentication_errors` before our own API-key check ever runs, so no key would ever work. Added a filter that runs after theirs and clears their rejection only for `/csst/v1/` requests presenting a valid key, leaving the lockdown intact for every other route.
- All displayed timestamps (Speed Test History, Plugin Load Correlation) now render in 24-hour time (e.g. `14:11`) instead of 12-hour AM/PM.

## [1.7.6] - 2026-08-06

- Added a "Duplicator Pro Backup" card reporting the last backup's success/failure status and relative time (e.g. "5 hours ago"), read directly from Duplicator Pro's own backups table.
- Added the plugin version number under the admin page title, and to the remote monitoring API response (`pluginVersion`), so a central dashboard can tell which sites are running an outdated version.
- Fixed the "Memory Used" live card: when no cPanel/CloudLinux LVE account-level figure is available, it now falls back to this WordPress installation's own PHP memory usage (against its `memory_limit`) instead of the whole physical server's `/proc/meminfo` — the old fallback conflated this site with every other account sharing the box.

# Changelog

All notable changes to this plugin are documented here.

Entries below 1.4.0 were reconstructed from the released ZIP artefacts, as this project has no version control history.

## [1.7.5] - 2026-07-31

- Updated README's "Live Resource Usage" section, which was left describing only the pre-1.7.2 `sys_getloadavg()`/`/proc/meminfo` behavior — now documents the CloudLinux/LVE auto-detection (`lvecpu`/`lvememphy`, core-equivalent conversion, 10-second transient cache) added across 1.7.2–1.7.4, and the `cpuSource`/`memorySource`/`cpuUsedRaw`/`cpuMaxRaw` REST payload fields. No functional changes.

## [1.7.4] - 2026-07-31

- Fixed the 1.7.3 CloudLinux CPU quota figures being expressed in confusing raw percent-of-quota units (e.g. "2% / 100% CPU quota"). CloudLinux's own LVE CPU ("SPEED") limit is a percentage of one physical core — 100 = 1 core, 200 = 2 cores — so the raw uapi units are now converted to actual core-equivalents (`cpuUsedCores`/`cpuMaxCores` internally, still exposed as `cpuUsedRaw`/`cpuMaxRaw`). This also unified the field semantics with the system-load-average fallback, which was already core-based, so consumers like Controll Server Monitor no longer need source-specific formatting logic.

## [1.7.3] - 2026-07-31

- Fixed Live Resource Usage (and the REST `live` block) reporting the whole physical server's CPU/memory instead of this account's own limits on CloudLinux/LVE shared hosting — the same class of bug the disk quota feature fixed, but for CPU/RAM. Auto-detects via `uapi ResourceUsage get_usages`'s `lvecpu`/`lvememphy` entries (same shell_exec mechanism as disk quota, no config needed), cached for 10 seconds via a transient rather than the hourly cron used for disk quota, since these are meant to stay live rather than update once an hour. Falls back to system-wide `sys_getloadavg()`/`/proc/meminfo` when not on CloudLinux or shell_exec is unavailable. Renamed the 1.7.2 payload fields `loadAverage1min`/`cpuCores` to source-neutral `cpuUsedRaw`/`cpuMaxRaw` (meaning differs by `cpuSource`: system load-avg/cores vs CloudLinux CPU-quota units), and added `cpuSource`/`memorySource` fields so consumers know which is active.

## [1.7.2] - 2026-07-31

- Extended the `csst_live_stats` payload (and therefore the `/wp-json/csst/v1/stats` REST response's `live` block) with the raw figures behind the CPU/memory percentages: `loadAverage1min`, `cpuCores`, `totalRamBytes`, and `usedRamBytes`. Lets consumers like Controll Server Monitor show actual load-average/core-count and used/total RAM instead of only a bare percentage.

## [1.7.1] - 2026-07-31

- Added zero-configuration auto-detection for the cPanel disk quota feature: if the local `uapi` binary is reachable via `shell_exec()` (i.e. the plugin is installed on the same account it's monitoring, which is the normal case), disk figures are now sourced from it automatically — no username/API token/host entry needed. This also sidesteps hosts that hide the "Manage API Tokens" page via WHM Feature Manager restrictions, since it doesn't depend on that feature at all. Result is cached via a new hourly WP-Cron job (`csst_cpanel_shell_quota_refresh`) rather than shelling out on every request, since diagnostics/REST requests can now be polled every couple of seconds by the companion Controll Server Monitor dashboard. Falls back to the existing manual username/token/host configuration (1.7.0) when auto-detection isn't available, then to the server filesystem total as a last resort. The panel now shows an "Auto-detected" status banner with a manual "Check Now" button, and the manual fields are relabeled as a fallback.

## [1.7.0] - 2026-07-31

- Added a "Hosting Disk Quota (cPanel)" panel: Disk Space and the Disk diagnostics metric previously came from `disk_free_space()`/`disk_total_space()`, which report the server's total physical filesystem — on shared hosting this is almost always far bigger than the account's actual package allocation (e.g. showing 200+ GB total instead of a 25 GB package). If a cPanel username, API token, and host are configured, disk figures are now sourced from cPanel's UAPI `Quota::get_quota_info` instead, which reflects the real account quota. Falls back to the filesystem total automatically if not configured, if the cPanel call fails, or if the account has an unlimited quota — and the Disk card's summary text says explicitly which source is in play, including the failure reason when a configured lookup doesn't work. New `X-CSST` REST endpoint payload and Raw Metrics JSON also carry the `source` field (`cpanel` or `filesystem`).

## [1.6.1] - 2026-07-31

- Fixed the Keep-Alive script's scheduled task installation silently failing with "The task XML contains a value which is incorrectly formatted or out of range" (`Duration:P99999999DT23H59M59S`). `[TimeSpan]::MaxValue` overflows what Windows Task Scheduler's XML schema accepts for `-RepetitionDuration`; switched to a 10-year duration, which is effectively indefinite for this use case and well within range. Affected both the per-site generated script (`ajax_download_keep_alive_script`) and the standalone `keep-alive.ps1`.

## [1.6.0] - 2026-07-31

- Added "Remote Monitoring API" panel + secured REST endpoint (`GET /wp-json/csst/v1/stats`, header `X-CSST-Api-Key`) for the companion `controll-server-monitor` app to pull diagnostics/live CPU-mem/disk-alert status on demand. Read-only (no history side effects). See README.
- Added a Live Resource Usage panel: CPU load and memory-used sparkline charts polling a new lightweight `csst_live_stats` endpoint every 2 seconds, client-driven only — starts when the admin page loads, pauses via `visibilitychange` when the browser tab is hidden, resumes when focused, stops on navigating away. No cron or server-side always-on polling involved.

## [1.5.0] - 2026-07-31

- Redesigned the admin page as "ServerPulse" using the Modernist theme from the user's Claude Design project (`ServerPulse Dashboard.dc.html`): nav bar, an overall-rating banner with tiered icon/color, a Server Specs grid, tiered diagnostics cards (Database/PHP Benchmark/Load/Memory/Disk) with a collapsible raw-JSON panel, and a sortable/expandable Speed Test History table. Every existing feature (Process Monitor, Plugin Load Correlation, Keep Server Awake, disk monitor) was restyled to match rather than dropped. Diagnostics now auto-runs once on page load so the banner/specs/metrics are populated immediately. Verified end-to-end against a real WordPress install (Laragon).
- Added Plugin Load Correlation: each Diagnostics run now records active plugin count, query count/time (when `SAVEQUERIES` is enabled), peak memory, and the DB/PHP benchmark timings to a new `csst_diagnostics_history` option (200-record cap), rendered as a table so plugin-count impact on server metrics can be tracked over time. New `csst_diagnostics_history_list` AJAX action loads it on page open.
- Added a "Download Keep-Alive Script" button (Connection & Diagnostics → Keep Server Awake) backed by a new `csst_download_keep_alive_script` AJAX endpoint. It streams a `.ps1` generated on the fly with this site's URL and a per-site scheduled-task name already baked in, so downloading and running it with no arguments installs the keep-alive task — survives PC reinstalls with no manual editing.
- Added `keep-alive.ps1`, a standalone script that pings the site on an interval to stop the shared host from going to sleep between visits, with `-Install`/`-Uninstall` to manage it as a Windows Scheduled Task and `-ShowIp` to print the single IP to whitelist in Wordfence (deliberately single-machine, since a multi-IP uptime service like UptimeRobot is impractical to whitelist against strict Wordfence country blocking). Excluded from the release ZIP, same as `package.ps1`.
- Added automated disk space monitoring: an hourly WP-Cron check (`csst_disk_monitor_check`) that emails the site admin when disk usage reaches 90%, and keeps emailing every hour while it stays at or above that threshold
- Added disk usage percentage and rating to the Server Diagnostics Snapshot, alongside the automated monitor's last-checked status, so disk health is visible on demand as well as automatically
- Added Process Monitor tab listing top server processes by CPU usage (PID, user, CPU %, memory %, elapsed, command), backed by the `csst_process_list` AJAX endpoint
- Split the admin page into "Connection & Diagnostics" and "Process Monitor" tabs
- Fixed Server Diagnostics Snapshot showing every rating/summary twice — once as text, once nested inside the raw JSON dump
- Fixed plugin header version, which had been reverted to 1.0.1 while 1.4.0 was the released version
- Fixed truncated, invalid `package.json` that would have broken `package.ps1`
- Removed UTF-8 BOMs from `controll-server-connection-speed-test.php` and `package.json` to avoid "headers already sent" warnings
- Rewrote `README.md` to cover the full current feature set

## [1.4.0] - 2026-05-29

- Added Server Diagnostics Snapshot: database round-trip, PHP benchmark, memory, disk, load average, CPU count, total RAM, and `php.ini` limits

## [1.3.0] - 2026-05-29

- Added Trend Comparison panel with rolling 1 hour / 24 hour / 7 day averages

## [1.2.0] - 2026-05-29

- Added P50 and P95 latency percentiles and packet-loss tracking to results and history

## [1.1.0] - 2026-05-29

- Added persistent speed test history (capped at 200 records) and CSV export

## [1.0.5] - 2026-05-29

- Refinements to result presentation

## [1.0.4] - 2026-05-29

- Throughput measurement corrections

## [1.0.2] - 2026-05-29

- Packaging and versioning fixes

## [1.0.1] - 2026-05-29

- Initial release: latency, jitter, download, and upload measurement on an admin-only page
