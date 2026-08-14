# Controll Server Monitor

> **Superseded on Windows.** [`controll-server-monitor-rs`](../controll-server-monitor-rs) is the current dashboard: a Windows Service plus a native desktop app, which monitors continuously in the background rather than only while a browser tab is open, and needs no PHP or web server.
>
> This app still works and is kept as the cross-platform option and as a reference implementation. **New features should go to the Rust version.** The two share an identical SQLite schema, so `data/monitor.sqlite` can be copied between them.

A standalone PHP web app (not a WordPress plugin) that gives you one dashboard showing the live "condition" of every WordPress site running the **Controll Server Connection Speed Test** plugin: overall diagnostics rating, disk usage, CPU/memory load, disk alert status, active plugin count.

It only ever probes a site when you have this dashboard open and the browser tab is in the foreground — nothing runs in the background, no cron, no persistent connection. Closing the tab or switching away stops all polling. (This limitation is exactly what the Rust rewrite exists to remove.)

## How it works

- Each monitored WordPress site exposes a secured REST endpoint (`/wp-json/csst/v1/stats`) added by the plugin, gated by a per-site API key generated on that site's own "Server Speed Test" admin page (Remote Monitoring API panel).
- This app stores the list of sites (label, endpoint URL, API key) in a local SQLite database (`data/monitor.sqlite`).
- The **Dashboard** page polls every registered site every 30 seconds via server-side cURL (`api/probe_all.php`, run in parallel with `curl_multi`) while the tab is open and visible, and renders a card per site.
- The **Setup** page is where you register sites: paste the Endpoint URL and API Key copied from each site's plugin admin page, with a "Test Connection" button before saving.

## Requirements

- PHP with `pdo_sqlite`, `sqlite3`, and `curl` extensions enabled
- A place to run it: any PHP-capable web server (this was built and tested against Laragon)

## Setup

1. Point a PHP web server's document root at this folder (e.g. add a Laragon vhost, or any Apache/Nginx + PHP-FPM setup).
2. Visit `/setup.php`, add each site: label, Endpoint URL, API Key (from that site's Remote Monitoring API panel).
3. Visit `/index.php` for the live dashboard.

## Security notes — read before exposing this beyond your own machine

- **This app has no login of its own.** Anyone who can reach it on the network can see every registered site's label, endpoint URL, and full API key, and can add/edit/delete sites. It's built for local, single-operator use (e.g. via Laragon on your own PC) — do not deploy it to a publicly reachable host without adding authentication in front of it (HTTP Basic Auth via `.htaccess`, a VPN, or similar).
- `data/` and `includes/` both ship with `.htaccess` files (`Require all denied`) so the SQLite database and PHP includes can't be fetched directly over HTTP even if this were exposed. Verify these survive if you deploy to a different web server that doesn't honor `.htaccess` (e.g. Nginx needs an equivalent `location` block denying those paths) — this is the file containing every site's plaintext API key.
- API keys are stored in plaintext in the SQLite file, matching how the WordPress plugin itself stores its key (`wp_options`). Treat `data/monitor.sqlite` as sensitive.
- Outbound requests use `CURLOPT_SSL_VERIFYPEER`/`VERIFYHOST`, so HTTPS endpoints are certificate-validated normally; only use `http://` endpoints for local/dev testing.

## Notes

- **CSS gotcha that has bitten twice** (here and in the Rust rewrite): an element carrying both the `hidden` attribute and a class that sets an explicit `display` (e.g. `.csm-grid { display: grid }`) stays visible, because author styles beat the browser's default `[hidden]` rule. Always pair such a class with `.that-class[hidden] { display: none; }`.
- Built against <10 sites; `curl_multi` parallel probing keeps a full dashboard refresh bounded by the slowest single site rather than the sum of all of them, but hasn't been tuned for larger fleets.
- If a site's probe fails (unreachable, wrong/revoked key, plugin deactivated), its card shows an "Offline" tier with the error message rather than stale data.
- Regenerating or revoking a site's API key in the WordPress plugin immediately invalidates it here too — update the Setup entry with the new key (or delete the site if you no longer want it monitored).
