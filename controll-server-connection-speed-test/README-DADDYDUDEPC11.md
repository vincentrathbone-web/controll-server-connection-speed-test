# Controll Server Connection Speed Test

A WordPress admin plugin that measures the real connection quality between your browser (your PC) and your WordPress server, keeps a history of every test, and reports what the server itself was doing at the time.

Everything runs from browser JavaScript against `admin-ajax.php`, so results reflect the true network path and real user conditions rather than a synthetic server-side benchmark.

## Interface

The admin page ("Server Speed Test" in the WordPress menu) is branded **ServerPulse** and follows the "Modernist" design system: a red-accent, sharp-cornered theme with Archivo type. It opens on an overall server rating banner (color/icon driven by the current diagnostics rating), a Server Specs grid, tiered Diagnostics Snapshot cards, and a sortable/expandable Speed Test History table. Diagnostics run automatically once on page load so the banner and specs are never empty. Only the on-page branding changed — the underlying plugin name, slug, and option names are untouched, so upgrading in place is safe.

## Features

### Connection test

- **Latency** — average round-trip time over 8 ping samples
- **Jitter** — variation between consecutive latency samples
- **Packet loss** — failed ping samples as a percentage
- **P50 / P95 latency** — median and 95th-percentile round-trip time, so a few bad samples are visible instead of being hidden by the average
- **Download throughput** — 3 parallel streams, 1 MB chunks, 8 second run
- **Upload throughput** — 1 MB chunks, 8 second run
- **Quality score** — the above combined into a single labelled rating

A test can be stopped mid-run with the Stop button.

### History and trends

- Every completed test is stored in the `csst_speed_test_history` option, newest first, capped at **200 records**
- **Trend Comparison** panel shows rolling averages over the last **1 hour**, **24 hours**, and **7 days** — this is what makes peak-hour degradation visible
- **Export CSV** produces the full history in a form you can send to your host or ISP

### Server Diagnostics Snapshot

An on-demand snapshot for when the server itself is the suspect rather than the network:

- Database round-trip time
- PHP compute benchmark
- Memory limit and current usage
- Disk free space
- System load average
- CPU count and total RAM (where the host exposes them)
- Relevant `php.ini` limits, including `upload_max_filesize` and `post_max_size`

### Hosting Disk Quota (cPanel)

By default, Disk Space and the Disk diagnostics metric come from PHP's `disk_free_space()`/`disk_total_space()`, which report the server's total physical filesystem — on shared hosting this is almost always far bigger than the account's actual package allocation (e.g. showing 200+ GB total instead of a 25 GB package), because PHP has no built-in way to see a hosting account's quota.

If your host runs cPanel, the **Hosting Disk Quota (cPanel)** panel (Server Speed Test admin page → scroll down) gets the real number instead — usually with no setup at all:

- **Auto-detected (default)**: if the plugin is installed on the same cPanel account it's monitoring — the normal case — it calls the local `uapi` command directly via PHP's `shell_exec()`, the same way cPanel's own web interface does internally. No username, token, or host to enter; nothing is stored. This works even when your host hides the "Manage API Tokens" page behind a plan-tier restriction, since it doesn't touch that feature at all. Result is cached and refreshed hourly via WP-Cron (not on every request, since Live Resource Usage and the companion Controll Server Monitor dashboard can poll every couple of seconds); use **Check Now** in the panel to refresh on demand.
- **Manual fallback**: if `shell_exec` is disabled on your host, the panel falls back to cPanel's UAPI over HTTPS instead:
  1. In cPanel, go to **Security → Manage API Tokens** and create a token.
  2. Enter your cPanel username, that token, and the host (e.g. `server.yourhost.co.za:2083` — the port defaults to `2083` if omitted) into the panel, then **Save**.
  3. Click **Test Connection** to verify before relying on it.

Once either path is active, Disk Space and the Disk metric reflect your actual package quota. If neither is available, or the account has an unlimited quota, everything falls back to the server filesystem total automatically — and the Disk card's summary text always says explicitly which source is in play, including the failure reason when a lookup doesn't work, so it's never silently wrong. The REST endpoint payload and Raw Metrics JSON also carry this as a `source` field (`cpanel-shell`, `cpanel`, or `filesystem`).

The manual fallback's username, host, and token are stored in `wp_options`, gated the same as everything else in this plugin by `manage_options`; the auto-detected path stores nothing beyond the cached usage numbers themselves. No other cPanel data is read or written either way.

### Process Monitor

A second tab listing the top server processes by CPU usage — PID, user, CPU %, memory %, elapsed time, and command. Availability depends on what your hosting environment permits; on restricted or containerised hosts this may return nothing.

### Plugin Load Correlation

Each time Diagnostics runs, active plugin count is recorded to the `csst_diagnostics_history` option (newest first, capped at 200 records) alongside:

- Query count and total query time — requires `define('SAVEQUERIES', true);` in `wp-config.php`; shows as n/a otherwise
- Peak PHP memory usage
- The database round-trip and PHP benchmark timings from the same diagnostics run
- The overall diagnostics rating

This builds a history you can use to see whether adding plugins is actually correlating with slower server-side metrics, without installing a separate query-profiling plugin.

### Live Resource Usage

A CPU and memory sparkline chart in the main dashboard, polling a lightweight endpoint (`csst_live_stats`) every 2 seconds — separate from the heavier Diagnostics Snapshot benchmark, so it's cheap enough to run continuously:

- On **CloudLinux/LVE shared hosting** (the common case — the same `shell_exec`-based auto-detection used for the disk quota feature, no configuration needed), CPU and memory figures are this account's own resource limits, not the whole physical server's: CPU is read from `uapi ResourceUsage get_usages`'s `lvecpu` entry and expressed in actual core-equivalents (CloudLinux's CPU "SPEED" limit is a percentage of one physical core — 100 = 1 core, 200 = 2 cores), and memory comes from the matching `lvememphy` entry in bytes. Cached for 10 seconds via a WP transient (not the hourly cron the disk quota feature uses) so it stays meaningfully live without spawning a `uapi` subprocess on every single poll.
- Otherwise, falls back to system-wide figures: **CPU Load** from `sys_getloadavg()`'s 1-minute load average as a percentage of the logical core count (capped at 100%), and **Memory Used** from `/proc/meminfo`'s `MemTotal`/`MemAvailable`. Requires a Linux-like host; on Windows or hosts without `/proc/meminfo` they show `n/a`, same graceful degradation as the rest of the diagnostics.
- The REST payload's `live` block exposes which source is active per metric (`cpuSource`/`memorySource`: `cpanel-lve` or `system`), plus `cpuUsedRaw`/`cpuMaxRaw` (core-equivalents either way) and `usedRamBytes`/`totalRamBytes`, so a consumer like Controll Server Monitor can show the actual usage-vs-allocation figures, not just a bare percentage.
- Runs only while the admin page is open and the browser tab is in the foreground: starts on load, pauses on `visibilitychange` when the tab is hidden, resumes when it's focused again, and stops entirely on navigating away. No cron job for the polling itself — this is client-driven, unlike the disk space monitor.

### Remote Monitoring API

A read-only REST endpoint for polling this site's condition from an external dashboard, without logging into WordPress:

- `GET /wp-json/csst/v1/stats` returns the same data as the Server Diagnostics Snapshot plus the Live Resource Usage figures (CPU/memory), as JSON
- Authenticated with a per-site API key sent as the `X-CSST-Api-Key` request header — no key, wrong key, or a key after revocation all return `401`/`403` and no data
- The **Remote Monitoring API** panel at the bottom of the admin page generates and revokes this key. Generating a new key immediately invalidates the previous one. Revoking clears it entirely and disables the endpoint until a new key is generated
- The endpoint is read-only and does not write to `csst_diagnostics_history` — polling it as often as you like has no effect on the Plugin Load Correlation history, unlike clicking Run Diagnostics in the admin page
- Intended for use with [Controll Server Monitor (native)](../controll-server-monitor-rs), a companion Windows app that polls this endpoint across multiple sites and displays their live condition side by side. It runs as a background Windows Service, so it keeps polling and keep-alive pinging without anyone being logged in. A [PHP version](../controll-server-monitor) of the same dashboard also exists and is still supported for non-Windows use. Any client that can send a GET request with the header works equally well

### Automated disk space monitoring

- Runs on WP-Cron every hour (`csst_disk_monitor_check`), independent of anyone viewing the admin page
- If disk usage reaches **90%**, emails the site admin address (`admin_email`) with the current usage, free/total space, and a link back to this page
- Keeps sending that email every hour for as long as usage stays at or above 90% — stops automatically once usage drops back below the threshold, no acknowledgement needed
- The Server Diagnostics Snapshot shows both the live disk usage percentage/rating and the automated monitor's last-checked status (last check time, alert state, and how many alert emails have gone out)
- Scheduling is set up on plugin activation and cleared on deactivation; `init()` also re-schedules defensively if the cron event is ever missing

## Installation

1. Copy the folder `controll-server-connection-speed-test` into `wp-content/plugins/`.
2. Activate **Controll Server Connection Speed Test** in WordPress.
3. Go to **Server Speed Test** in the WordPress admin menu.

## Requirements

- WordPress with a user holding the `manage_options` capability
- PHP 7.4 or later (the plugin uses typed properties and class constants)

## Security

- Every page view and AJAX endpoint checks `manage_options`
- All AJAX requests are nonce-verified against `csst_speed_test_nonce`
- All rendered output is escaped

## Notes and caveats

- Results are specific to the current browser, device, network path, and server load. Two people testing the same site will legitimately get different numbers.
- Hosting limits such as `upload_max_filesize`, `post_max_size`, and proxy buffering can cap the upload and download figures well below the true line speed. Check the Diagnostics snapshot before concluding the connection is slow.
- Throughput measured through `admin-ajax.php` includes WordPress bootstrap overhead, so it reads slightly lower than a raw static-file transfer.
- Process Monitor depends on host permissions and is expected to be unavailable on many shared hosts.

## Keeping a sleeping shared host awake

Some shared hosts suspend a site after a period of no traffic and take several seconds to resume on the next request. WP-Cron can't fix this on its own — it only fires when someone visits the site, so it can't wake up a host that's already asleep. Something outside the site needs to ping it on an interval instead.

This is deliberately a single-machine approach rather than a third-party uptime monitor: services like UptimeRobot ping from a large, rotating pool of IPs, which is impractical to whitelist against a Wordfence setup that blocks international traffic. Pinging from one known machine only ever needs one IP allowed through.

> **If you use [Controll Server Monitor (native)](../controll-server-monitor-rs), you don't need the script below.** That app's Windows Service already pings every registered site every 5 minutes, from boot, without anyone being logged in — which is strictly better than the Scheduled Task described here, since a logon-triggered task only runs while the registering user is signed in. The script remains the right choice for a site you don't monitor with that app, or on a machine where you don't want to install it.

### Download Keep-Alive Script (recommended)

On the **Server Speed Test** admin page, under **Connection & Diagnostics → Keep Server Awake**, click **Download Keep-Alive Script**. This downloads a `.ps1` file generated on the fly with this site's URL and a per-site task name already baked in — no editing required.

Run the downloaded script with no arguments and it installs a Windows Scheduled Task that pings this exact site every 5 minutes:

```powershell
.\csst-keep-alive-your-site-com.ps1
```

Because the URL is embedded in the file itself, this survives a Windows reinstall with zero setup: just come back to this admin page, click the button again, and run the new download. Other options baked into the same file:

```powershell
.\csst-keep-alive-your-site-com.ps1 -ShowIp      # print the IP to whitelist in Wordfence
.\csst-keep-alive-your-site-com.ps1 -Uninstall   # remove the scheduled task
.\csst-keep-alive-your-site-com.ps1 -PingOnce    # one-off manual ping, no install
```

### Whitelisting in Wordfence

1. Run `.\csst-keep-alive-your-site-com.ps1 -ShowIp` and note the printed IP (your PC's static public IP).
2. In WordPress admin, go to **Wordfence → All Options → Country Blocking** and add that IP to the country-blocking allowlist so it bypasses the international-traffic block.
3. Also add it under **Wordfence → Firewall → Blocking → Allowlisted IP addresses** so the general firewall rules don't catch it either.

This only needs doing once as long as the IP stays static. If the IP ever changes, re-run `-ShowIp` and update both Wordfence entries.

Each ping is logged next to the script (`<task-name>.log`). The scheduled task only runs while the PC registering it is on — it won't help overnight or while the machine is off.

### Generic script (advanced / non-Windows-admin-page use)

`keep-alive.ps1` in the plugin root (not included in the release ZIP) is the same script without a site baked in — pass `-Url` explicitly. Useful for scripting or for pinging a site this plugin isn't installed on.

```powershell
.\keep-alive.ps1 -Url "https://your-site.example.com" -Install
.\keep-alive.ps1 -Uninstall
.\keep-alive.ps1 -ShowIp
```

## Packaging

Releases are built with `package.ps1`, which bumps the patch version, syncs it across `package.json`, the plugin header, `readme.txt`, and `CHANGELOG.md`, strips UTF-8 BOMs, and emits a versioned ZIP with a single correctly-named root folder.

```powershell
.\package.ps1
```

Use `-NoBump` to repackage the current version without incrementing it. Set the version in `package.json` first when cutting a minor or major release, since the script only ever bumps the patch component.
