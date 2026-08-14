# Controll Server Connection Speed Test

This WordPress plugin adds an admin page that measures the speed between your browser (your PC) and your WordPress server.

## What it measures

- Latency (average round-trip time)
- Jitter (latency variation)
- Download throughput (server to browser)
- Upload throughput (browser to server)

## Installation

1. Copy the folder `controll-server-connection-speed-test` into `wp-content/plugins/`.
2. Activate **Controll Server Connection Speed Test** in WordPress.
3. Go to **Server Speed Test** in the WordPress admin menu.

## Beyond the speed test

The admin page also surfaces server diagnostics, live CPU/memory usage, a disk quota/alert monitor, a Duplicator Pro backup status card (last backup's success/failure and relative time, read directly from Duplicator's own database table when it's installed), and a secured `GET /wp-json/csst/v1/stats` REST endpoint (per-site API key) that the companion **Controll Server Monitor** dashboards (PHP and native Rust) poll. The plugin's own version number is shown under the page title and in that API response (`pluginVersion`), so a central dashboard can tell which sites are running an outdated copy.

## Notes

- Results are specific to the current browser, device, network path, and server load.
- This test runs from browser JavaScript, so it reflects real user conditions.
- Hosting limits such as `upload_max_filesize` and proxy buffering can affect upload/download values.
- The page is restricted to administrators.
- **If a "require login for all REST requests" hardening plugin/snippet is active** (e.g. the "Members" plugin's Private REST API option), it rejects every unauthenticated `/wp-json/...` request — including this plugin's own key-checked endpoint — *before* the plugin's own API key check ever runs, via WordPress's `rest_authentication_errors` filter. Regenerating the API key won't fix that kind of failure, since the key is never even reached. This plugin registers its own late-priority filter that clears such a lockdown specifically for its own `/csst/v1/` requests when a valid key is presented, leaving the lockdown intact for every other route — so this should self-resolve on sites with that kind of hardening enabled, but it's worth knowing about if a site still reports "not connected" after a key was confirmed correct.
