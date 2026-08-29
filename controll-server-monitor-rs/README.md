# Controll Server Monitor (native)

A native Windows rewrite of `controll-server-monitor` (the PHP dashboard) — same UI and behavior, but split into two pieces:

- **A Windows Service** that owns all the real work: the site registry, stats polling, and keep-alive pinging. It starts at boot and runs whether or not anyone is logged in and whether or not the desktop app is open.
- **A desktop app** (Tauri) — a native window with a system tray icon, which is a thin client onto the service.

Closing the app window hides it to the tray; the service keeps monitoring regardless. Even quitting the app entirely does not stop monitoring.

## What it does

- Same dashboard as the PHP version: Card view (all sites at a glance) and List view (one site, trend charts), same color-coded health stats, same disk/CPU/memory usage-vs-quota detail lines.
- Polls registered sites' `/wp-json/csst/v1/stats` endpoints (from the **Controll Server Connection Speed Test** WordPress plugin) while the dashboard is open. Each site's card also shows its Duplicator Pro backup status and plugin version — a version behind the newest one currently seen across the fleet is flagged, so outdated installs are easy to spot.
- Pings every registered site's home page every 5 minutes, continuously, from the service. The OK/FAIL badge shows the real HTTP status (or connection error) returned, not just a bare pass/fail. Every ping is persisted (30-day retention) rather than only the most recent result — click a site's row in the Keep-Alive panel to expand its actual ping history. A desktop notification fires when a site's keep-alive transitions from OK to FAIL.
- All timestamps display in 24-hour local time, converted from the UTC the backend stores.

## Backing up registered sites

Setup screen → **Export Sites (JSON)** downloads every registered site's label, endpoint URL, API key, and keep-alive URL. From inside the desktop app this opens a native "Save As" dialog; opened as a plain browser tab it falls back to a normal browser download. **Bulk Import (JSON)** (bottom-right of the Add a Site card) reads that file back and re-registers each site, skipping any whose endpoint URL is already registered so re-importing the same backup twice is safe. Use this after reinstalling Windows or moving to a new PC instead of re-entering every site's API key by hand — keep the exported file somewhere safe, since it contains live API keys in plaintext.

## Installing

Run the installer from `bundle\nsis\`. It will prompt for **Administrator access** — this is required to register a Windows Service, and is the same prompt antivirus and backup tools show. The installer registers and starts the service, then installs the desktop app.

If that UAC prompt does **not** appear, something is wrong: the installer is running in per-user mode and service registration will fail silently. See the caveats section.

Uninstalling stops and removes the service. Installing over an existing per-machine install is fine; the installer stops and re-registers the service as part of the process.

## Data location

`C:\ProgramData\ControllServerMonitor\`

- `monitor.sqlite` — registered sites (`sites` table) and persisted keep-alive ping history (`keepalive_pings` table, 30-day retention, one row per ping — backs the Keep-Alive panel's per-site history view)
- `keep-alive.log` — plain-text ping log (kept alongside the database, not read back by the UI)

This is machine-wide rather than per-user because the service runs as LocalSystem, which has no user profile.

**Migrating from the PHP version**: both use an identical SQLite schema, so copying the PHP app's `data\monitor.sqlite` into the folder above brings across already-registered sites instead of re-entering them.

## Registering sites

Go to Setup, paste the Endpoint URL and API Key from each WordPress site's "Remote Monitoring API" panel (Server Speed Test admin page → scroll to the bottom). Keep-Alive URL is optional — if left blank, the site's home page is derived from the Endpoint URL's origin (scheme + host + port).

**Windows "localhost" quirk**: if a site's endpoint is on this same machine (e.g. a local Laragon test site), use `127.0.0.1` instead of `localhost` in the Endpoint/Keep-Alive URLs — Windows can resolve `localhost` to the IPv6 loopback address first, which some local Apache setups don't listen on, causing a real (multi-second) connection timeout. Real domain names aren't affected.

## Managing the service

Right-click the tray icon. The menu shows the service's live state (running / stopped / not installed) and offers **Start Service** or **Stop Service**, whichever applies.

Starting and stopping a service requires elevation, so those two items trigger a UAC prompt — the app itself runs unelevated. Reading the state does not, so the menu stays accurate without prompting. State is polled every few seconds, so changes made elsewhere (services.msc, a crash) show up too.

The service is registered as **Automatic** (start type `SERVICE_AUTO_START`), so Windows starts it during boot, before anyone logs in — no need to open the app. It also has recovery actions set: if it exits unexpectedly, or fails to start at boot, the Service Control Manager restarts it automatically (5s, then 15s, then every 60s). Running `install` again — e.g. a version upgrade — re-applies all of this to the existing service.

Equivalently, from an elevated prompt:

```powershell
sc start ControllServerMonitor
sc stop ControllServerMonitor
```

The service binary also self-registers, from an **elevated** prompt:

```powershell
.\controll-server-monitor-service.exe install
.\controll-server-monitor-service.exe uninstall
```

Running it with `run` (or no arguments) outside the Service Control Manager starts the server in the foreground instead — useful for debugging.

## Building from source

Requires Rust (rustup) and `cargo-tauri`. This project targets the **GNU** toolchain (`rustup default stable-x86_64-pc-windows-gnu`) with MinGW-w64 for linking, to avoid the multi-GB Visual Studio Build Tools the default MSVC toolchain needs.

```powershell
.\build.ps1           # build service + app
.\build.ps1 -Bundle   # also produce the NSIS installer
```

Use the script rather than calling `cargo` directly. It sets two things this machine needs:

1. Cargo and MinGW on `PATH` (a fresh shell here does not reliably inherit them).
2. `CARGO_TARGET_DIR` to a **space-free path** (`C:\controll-build` by default). GNU `windres`, which embeds the app icon and version info, cannot parse this project's own path — it contains spaces and a bare `-`, which it splits into invalid command-line arguments. Building elsewhere sidesteps it entirely.

## Architecture

```
common/   shared library — SQLite registry, prober, keep-alive loop, axum routes, embedded frontend
service/  Windows Service binary (windows-service crate), hosts the HTTP API on 127.0.0.1:8091
app/      Tauri desktop app — native window + tray icon, loads the same frontend
```

The frontend assets in `common/static/` are compiled into the service binary via `rust-embed`, and also used directly as the Tauri app's frontend. `assets/api-base.js` resolves which origin to call: same-origin when served by the service over `127.0.0.1`, and the service's address explicitly when running inside the Tauri webview.

The API listens on **127.0.0.1:8091** only — it is not reachable from other machines. Port 8091 (not 8090) means it can run alongside the PHP version during a transition. CORS is permissive on that listener because the Tauri webview calls it cross-origin from `tauri.localhost`; this is safe only because the socket is loopback-only. **If the bind address is ever widened beyond 127.0.0.1, the CORS policy must be tightened at the same time.**

`GET /api/keepalive/history?siteId=<id>&limit=<n>` returns a site's persisted ping history (newest first, `limit` capped at 500) — backs the Keep-Alive panel's expandable per-site rows.

**Native file dialogs from plain JS, no bundler.** The frontend has no npm/webpack build step — it's static files loaded via `<script>` tags. Export Sites needs a real native "Save As" dialog only when running inside the Tauri window (a plain browser tab can't get one at all — see the caveats below). This uses `tauri-plugin-dialog` plus one narrow custom command (`write_export_file`, a plain `std::fs::write`) rather than pulling in `tauri-plugin-fs`'s broader filesystem surface for a single write. Two things make this reachable from vanilla JS with no bundler:

- `"app": { "withGlobalTauri": true }` in `tauri.conf.json` injects `window.__TAURI__` into the webview, exposing `core.invoke` and each permitted plugin's JS bindings (e.g. `window.__TAURI__.dialog.save(...)`) directly to plain `<script>` code.
- `app/src-tauri/capabilities/default.json` grants the main window `dialog:allow-save` (plus `core:default`). Tauri v2 validates permission identifiers at build time — an unrecognized one fails the build immediately rather than misbehaving silently at runtime. Custom app-defined commands (`write_export_file`) aren't gated by this ACL system at all; it only applies to plugin-provided commands.

`setup.js` checks for `window.__TAURI__.core`/`.dialog` at call time and falls back to the plain `<a download>` blob trick when absent, so the same page still works correctly when opened directly in a browser against the service (where no native dialog is possible).

## Caveats and lessons learned

Things that have already gone wrong here, kept so they don't go wrong twice.

**The service and the app are separate processes, deliberately.** The service does the monitoring; the app only looks at it. Quitting or crashing the app must never stop monitoring. An earlier single-binary design was abandoned precisely because it couldn't offer that.

**A silently unregistered service looks exactly like a completely broken app.** Every API call fails, the dashboard shows nothing, and the natural assumption is that the *monitored site* is at fault. Two separate installer bugs produced this:

- Tauri preserves a bundled resource's relative path, so the service binary lands in `$INSTDIR\bin\`, not `$INSTDIR\`. The install hook pointed at the wrong path and NSIS's `ExecWait` failed without complaint.
- Tauri's NSIS bundler defaults to a **per-user** install with no UAC prompt, so registration would have failed for lack of elevation regardless. Fixed with `"installMode": "perMachine"`.

The install hook now checks exit codes and reports failures in a dialog. Keep it that way.

**Never let a raw `fetch()` error reach the user.** The browser reports an unreachable service as "Failed to fetch", which reads like a problem with the site being monitored. That misdiagnosis cost an evening and an unnecessary API-key rotation. All calls go through `apiFetch()` in `api-base.js`, which says plainly that the background service can't be reached.

**Service permissions are asymmetric.** Reading state needs only `CONNECT` + `QUERY_STATUS` and works unelevated; starting or stopping needs elevation. This is why the tray menu shows live status silently but raises a UAC prompt for Start/Stop. The alternative — granting the user start/stop rights via `sc sdset` at install time — was deliberately rejected as a needless weakening of the service's security descriptor.

**A JSON field missing its camelCase rename breaks the JS that reads it, silently.** `KeepAliveStatus.site_id` had no `#[serde(rename = "siteId")]` while every sibling field did, so it serialized as `site_id` — but `setup.js` looked up `map[s.siteId]`, always got `undefined`, and every site showed "Not pinged yet" regardless of real ping history, with no error anywhere to point at the cause. When a JS lookup against an API response silently comes back empty/undefined, check the actual JSON key names match what the JS expects — don't assume a struct's `#[derive(Serialize)]` output matches its neighbors just because they're declared the same way.

**A webpage cannot show a native "Save As" dialog, ever — including inside this app's own Tauri window, by default.** The `download` attribute on an `<a>` always saves straight to the browser's configured downloads folder with no prompt; that's a deliberate cross-browser security restriction (a page can't be allowed to choose where on disk it writes), not a bug to work around. Getting an actual native picker requires the app side to opt in explicitly — here, `tauri-plugin-dialog` plus a capability grant (`dialog:allow-save`) — and even then it only works when the page is running inside the Tauri window itself; the exact same page opened in a plain browser tab against the service is back to the browser's own download behavior, because there is no native app around it to ask.

**`[hidden]` loses to any class that sets `display`.** An element carrying both `hidden` and a class like `.csm-grid { display: grid }` stays visible. Pair every such class with `.that-class[hidden] { display: none; }`. This has bitten in both this codebase and the PHP one.

**Windows may resolve `localhost` to IPv6 first**, which some local Apache setups don't listen on — producing a genuine multi-second timeout where `127.0.0.1` connects instantly. Use `127.0.0.1` for local endpoints.

**There are no automated tests.** Everything here has been verified by running it. If you change behaviour, run it.
