# Changelog

All notable changes to this app are documented here.

## [1.1.0] - 2026-07-31

- Added a **List view** alongside the existing Card view: a site picker plus per-metric trend rows (Disk Used, CPU Load, Memory Used), each showing a current-value tile and a red-gradient area chart built from probes taken during the current browser session (resets on reload — nothing is persisted server-side).
- List view now probes only the currently focused site (`api/probe.php?id=`) instead of every registered site, reducing load on the monitored sites when you're not looking at the rest of them; Card view still probes everyone.
- Reduced the poll interval from 30 seconds to 2 seconds.
- Added a "Test Connection" button to each saved-site row on the Setup page, next to Edit/Delete.
- Card view stat numbers (Disk, CPU, Memory, Disk Monitor) are now color-coded green/amber/red based on the underlying WP plugin's own disk rating (for Disk) or 80%/90% thresholds (for CPU/Memory), so problem sites stand out at a glance across a large site list instead of blending into uniform black text.
- Disk, CPU, and Memory stats now show the actual usage-vs-allocation figures (e.g. "50.5 GB / 100.0 GB", "0.01 / 1 cores") underneath the percentage, in both Card and List view — requires Controll Server Connection Speed Test 1.7.4+ for the CPU/memory figures to reflect real account limits (CloudLinux/LVE-aware) rather than the whole physical server's.
- View and selected site now persist across reloads via `localStorage`.

## [1.0.0] - 2026-07-31

- Initial release: standalone PHP + SQLite dashboard for monitoring multiple WordPress sites running the **Controll Server Connection Speed Test** plugin's Remote Monitoring API.
- Dashboard page polls every registered site every 30 seconds via server-side cURL (`api/probe_all.php`, `curl_multi`), only while the tab is open and visible — pauses on `visibilitychange`, stops on navigating away.
- Setup page to add, edit, test, and delete monitored sites (label, endpoint URL, API key), stored in `data/monitor.sqlite`.
- `.htaccess` deny rules on `data/` and `includes/` so the SQLite database (which holds plaintext per-site API keys) isn't directly downloadable over HTTP.
