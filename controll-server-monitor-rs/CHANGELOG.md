# Changelog

All notable changes to this app are documented here.

## [0.1.6] - 2026-08-27

- Setup screen now suggests a Label automatically from the target site's own WordPress Site Title, once the Endpoint URL field loses focus — looked up server-side via the standard, unauthenticated `/wp-json/` index route (new `GET /api/site_name` endpoint), since a direct browser fetch to an arbitrary third-party site would hit CORS. Never overwrites a Label already typed, and fails silently (leaves the field blank) if the site is unreachable or its REST API is locked down.

## [0.1.5] - 2026-08-06

- Export Sites now shows a real native Windows "Save As" dialog when run from inside the desktop app (via `tauri-plugin-dialog` + a small custom `write_export_file` command), instead of silently dropping the file into the browser's default downloads folder. Opening the same Setup page directly in a browser tab still uses the plain download behavior, since a webpage can't summon a native dialog on its own.

## [0.1.4] - 2026-08-06

- Setup screen: "Export Sites (JSON)" button (below the Sites table) backs up every registered site's label, endpoint URL, API key, and keep-alive URL to a downloadable JSON file. "Bulk Import (JSON)" button (bottom-right of the Add a Site card) restores from that file — skips any site whose endpoint URL is already registered, so re-importing is safe. Purely client-side; reuses the existing `/api/sites` endpoints, no new backend routes.

## [0.1.3] - 2026-08-06

- Keep-alive confidence: the OK/FAIL badge now shows the actual HTTP status (or connection error) returned, not just a bare pass/fail.
- Every keep-alive ping is now persisted (new `keepalive_pings` table, 30-day retention), not just the most recent result — click a site's row in the Keep-Alive panel to expand its real ping history instead of only ever seeing "the last one." New `GET /api/keepalive/history?siteId=&limit=` endpoint backs this.
- Desktop notification when a site's keep-alive transitions from OK to FAIL (only on fresh failures, not repeatedly for one that's still down), via the browser Notification API — works both in the Tauri app window and when the dashboard is opened directly in a browser.

## [0.1.2] - 2026-08-06

- All displayed timestamps (probe times, keep-alive pings, "Last refresh", site "Added" dates) now render in 24-hour time (e.g. `14:11`) instead of 12-hour AM/PM.

## [0.1.1] - 2026-08-06

- Site cards now show Duplicator Pro's last backup status and the site's plugin version, flagging any site running behind the newest version currently seen across the fleet.
- Fixed timestamps (probe times, keep-alive pings, site "Added" dates) displaying as raw UTC — they're now reformatted into the viewer's local timezone.
- Fixed a bug where the Setup screen's Sites table always showed "Not pinged yet" regardless of actual keep-alive history (`KeepAliveStatus.site_id` was missing its camelCase JSON rename, so the frontend's lookup by `siteId` always missed).

## [0.1.0] - 2026-08-01

Initial release: a native Windows replacement for the PHP `controll-server-monitor` dashboard, split into a background Windows Service and a Tauri desktop client.

### Architecture

- **Windows Service** (`ControllServerMonitor`, LocalSystem, auto-start at boot) owns the site registry, stats probing, and keep-alive pinging. It runs independently of login state and of whether the GUI is open — closing or crashing the desktop app does not stop monitoring.
- **Tauri desktop app** — a native window rather than a browser tab, acting as a thin client over the service's local HTTP API.
- **Shared `common` crate** holds the SQLite registry, prober, keep-alive loop, axum routes, and the frontend assets, which are embedded into the service binary via `rust-embed` and reused directly as the Tauri app's frontend.
- API is bound to **127.0.0.1:8091** only — loopback, not reachable from other machines. Port 8091 rather than 8090 so it can run alongside the PHP dashboard during a transition.

### Features

- Same dashboard as the PHP version: Card and List views, color-coded stats, disk/CPU/memory usage-vs-quota detail lines.
- Continuous keep-alive pinging of every registered site every 5 minutes, from the service. This replaces the per-site PowerShell + Scheduled Task approach that the WordPress plugin generates, which only ran while the registering user was logged in.
- System tray icon: click to show the window; right-click for a menu showing **live service state** with **Start Service** / **Stop Service** items (each enabled only when applicable). Status is polled every 3 seconds so changes made elsewhere — services.msc, a crash — are reflected.
- Closing the window hides it to the tray instead of exiting.
- NSIS installer registers and starts the service, then installs the app. Uninstalling stops and removes the service.

### Data

- Stored machine-wide in `C:\ProgramData\ControllServerMonitor\` (`monitor.sqlite`, `keep-alive.log`), because the service runs as LocalSystem and has no user profile.
- The SQLite schema is identical to the PHP dashboard's, so an existing `monitor.sqlite` can be copied across to carry registered sites over.

### Known limitations

- Start/Stop from the tray raises a UAC prompt each time. Changing service state requires elevation and the app runs unelevated; loosening the service's security descriptor to avoid this was considered and rejected.
- The app icon is a generated placeholder in the brand accent (`#ec3013`), not a designed logo.
- No automated test suite — verification has been manual throughout.
