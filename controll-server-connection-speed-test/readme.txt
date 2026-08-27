=== Controll Server Connection Speed Test ===
Contributors: controll
Tags: monitoring, uptime, diagnostics, speed test, server
Requires at least: 5.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.7.9
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Measures real browser-to-server speed, tracks server diagnostics over time, and offers a secured API for remote fleet monitoring.

== Description ==

Controll Server Connection Speed Test ("ServerPulse") measures the real connection quality between your browser and your WordPress server — latency, jitter, packet loss, and download/upload throughput — run entirely from browser JavaScript against `admin-ajax.php`, so results reflect true network conditions rather than a synthetic server-side benchmark.

Beyond the speed test, it gives you an ongoing picture of server health and a way to keep a shared host from going to sleep between visits.

**Connection test**

* Latency, jitter, and packet loss over 8 ping samples
* P50 / P95 latency percentiles, so a few bad samples aren't hidden by an average
* Download (3 parallel streams) and upload throughput, 8 seconds each
* A single combined quality grade
* Persistent history (200 records), CSV export, and rolling 1-hour / 24-hour / 7-day trend comparison

**Server Diagnostics Snapshot**

* Database round-trip, PHP compute benchmark, memory limit vs. usage, load average, CPU count, total RAM
* Hosting Disk Quota (cPanel) — your real account quota via `uapi`, auto-detected, hourly-cached, no setup required
* Live Resource Usage — 2-second CPU/memory sparklines, account-scoped on CloudLinux/LVE shared hosting
* Duplicator Pro Backup card — last backup status and age, read directly from Duplicator's own table
* Plugin Load Correlation — active plugin count, query count/time, peak memory, and benchmark timings recorded on every diagnostics run
* Process Monitor tab — top server processes by CPU, where hosting permits it

**Automation**

* Hourly disk-usage monitor that emails the site admin while usage stays at or above 90%
* Remote Monitoring API — a read-only, API-key-gated REST endpoint (`GET /wp-json/csst/v1/stats`) for pulling a site's condition into an external dashboard
* Keep-Alive Script generator — one click downloads a Windows PowerShell script pre-configured with your site's URL, which installs a Scheduled Task pinging your site every 5 minutes so a shared host doesn't put it to sleep

= Desktop companion app =

For monitoring a fleet of sites at once, pair this plugin with Controll Server Monitor, a free, open-source Windows desktop app and background service that polls every registered site's Remote Monitoring API and keep-alive URL continuously — even when nobody is logged in. A download link is available directly on this plugin's admin page.

== Installation ==

1. Upload the plugin files to the `/wp-content/plugins/controll-server-connection-speed-test` directory, or install the plugin through the WordPress Plugins screen directly.
2. Activate the plugin through the 'Plugins' screen in WordPress.
3. Go to **Server Speed Test** in the WordPress admin menu.

== Frequently Asked Questions ==

= Does this slow down my site for visitors? =

No. Every feature here only runs on the admin-only "Server Speed Test" page, or in response to an explicit request to the Remote Monitoring API. Nothing runs on front-end page loads.

= Do I need a cPanel account for the disk/CPU features to work? =

No. Disk usage and Live Resource Usage fall back gracefully to filesystem totals and system-wide load average when cPanel/CloudLinux isn't available — they just won't reflect your specific hosting account's quota in that case.

= Where do I get the desktop companion app? =

From the "Download Desktop App" link on this plugin's admin page.

= Is my API key secure? =

The Remote Monitoring API key is compared using a timing-safe comparison (`hash_equals`) and can be regenerated or revoked at any time from the admin page. It is stored the same way WordPress stores other plugin settings.

== Screenshots ==

1. The Server Speed Test admin page, showing the overall server rating banner and diagnostics snapshot.

== Changelog ==

= 1.7.9 =
* Hardening pass ahead of the WordPress.org directory submission: switched `parse_url()` to `wp_parse_url()`, added `wp_unslash()` before sanitizing several request fields, and documented the plugin's two deliberately-unescaped raw-file-download outputs (the speed-test payload and the generated keep-alive script) for the automated Plugin Check tool. No user-facing behavior changes.

= 1.7.8 =
* Added a "Download Desktop App" link to the admin page tab bar, pointing at the companion Controll Server Monitor project's latest release.

= 1.7.7 =
* Fixed the Remote Monitoring API being unreachable on sites where a hardening plugin locks the whole REST API behind a login.
* Timestamps now render in 24-hour time.

= 1.7.6 =
* Added a Duplicator Pro Backup card reporting the last backup's status and relative time.
* Added the plugin version number to the admin page and the Remote Monitoring API response.
* Fixed the Memory Used live card conflating this site's usage with the whole physical server's when no cPanel/CloudLinux figure is available.

= 1.7.5 =
* Documentation update only, no functional changes.

= 1.7.4 =
* Fixed CloudLinux CPU quota figures being expressed in confusing raw percent-of-quota units; now converted to actual core-equivalents.

= 1.7.3 =
* Fixed Live Resource Usage reporting the whole physical server's CPU/memory instead of this account's own limits on CloudLinux/LVE shared hosting.

= 1.7.2 =
* Extended the live stats payload with the raw figures behind the CPU/memory percentages.

= 1.7.1 =
* Added zero-configuration auto-detection for the cPanel disk quota feature via the local `uapi` binary.

= 1.7.0 =
* Added a Hosting Disk Quota (cPanel) panel reflecting your real account quota instead of the server's total filesystem.

= 1.6.1 =
* Fixed the Keep-Alive script's scheduled task installation failing with an out-of-range duration error.

= 1.6.0 =
* Added the Remote Monitoring API and a Live Resource Usage panel with CPU/memory sparkline charts.

= 1.5.0 =
* Redesigned the admin page ("ServerPulse"), added Plugin Load Correlation, the Keep-Alive Script generator, automated disk space monitoring, and a Process Monitor tab.

= 1.4.0 =
* Added the Server Diagnostics Snapshot.

= 1.3.0 =
* Added the Trend Comparison panel.

= 1.2.0 =
* Added P50/P95 latency percentiles and packet-loss tracking.

= 1.1.0 =
* Added persistent speed test history and CSV export.

= 1.0.1 =
* Initial release: latency, jitter, download, and upload measurement on an admin-only page.

== Upgrade Notice ==

= 1.7.9 =
Internal code-quality hardening ahead of the WordPress.org directory submission. No breaking changes.
