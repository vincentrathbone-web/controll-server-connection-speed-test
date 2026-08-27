# Controll Server Monitoring — project guide

Three codebases that together monitor a fleet of WordPress sites. They are separate programs, not one app, and they talk over one HTTP contract.

```
controll-server-connection-speed-test/   WordPress plugin (v1.7.9)  — the data source, runs ON each monitored site
controll-server-monitor/                 PHP dashboard (v1.1.0)     — the original consumer, now superseded
controll-server-monitor-rs/              Rust: Windows Service + Tauri app (v0.1.6) — the current consumer
```

**The contract between them** is `GET /wp-json/csst/v1/stats`, authenticated with a per-site key in the `X-CSST-Api-Key` header. The plugin serves it; both dashboards consume it. Change the payload on one side and both consumers need checking.

## Which one is "live"

- **The WordPress plugin** is the mature piece — treat changes to it as production changes for anyone who has it installed.
- **The Rust app is the current desktop consumer.**
- **The PHP dashboard is superseded** by the Rust app but still works. Don't invest in new features there; port them to the Rust app instead. It remains useful as a reference implementation and for non-Windows use.

## Architecture of the Rust app

This is the part most likely to need work, and its shape is deliberate.

```
common/         shared lib — SQLite registry, prober, keep-alive loop, axum routes, embedded frontend
service/        Windows Service (windows-service crate). Owns ALL the real work. API on 127.0.0.1:8091
app/src-tauri/  Tauri v2 desktop app — native window, tray icon. A thin CLIENT of the service
```

The split is the whole point: **the service keeps monitoring whether or not the GUI is open, or anyone is logged in.** An earlier single-binary version couldn't do that, because closing the process stopped the pinging. Do not collapse these back together.

- Data lives in `C:\ProgramData\ControllServerMonitor\` (`monitor.sqlite` — sites plus 30-day persisted keep-alive ping history; `keep-alive.log`) — machine-wide, because the service runs as LocalSystem with no user profile and installs under Program Files.
- The SQLite schema is deliberately **identical to the PHP dashboard's**, so `monitor.sqlite` can be copied between them.
- The frontend in `common/static/` is compiled into the service binary via `rust-embed` *and* used directly as the Tauri app's frontend. One copy, two consumers.

## Building

Use the script. Do not call `cargo` directly unless you replicate what it sets.

```powershell
cd controll-server-monitor-rs
.\build.ps1            # service + app
.\build.ps1 -Bundle    # also the NSIS installer
```

WordPress plugin and PHP dashboard releases use their own `package.ps1` (see `packaging-skill.md` for the convention).

CI builds the Windows installer via `.github/workflows/build-windows.yml` on a `v*` tag push or manual dispatch, and publishes it as a GitHub Release with notes pulled from `controll-server-monitor-rs/CHANGELOG.md`.

## Hard-won gotchas

These all cost real time. Check here before debugging from scratch.

### Toolchain

- **GNU `windres` cannot parse a path containing spaces or a bare `-`.** If your checkout path has either, `windres` (which embeds the app icon/version info during a GNU-toolchain Tauri build) splits it into invalid arguments — the error is a baffling `gcc: error: unrecognized command-line option '-\'`. Fix: build into a space-free `CARGO_TARGET_DIR` outside the repo. CI sidesteps this by using the MSVC toolchain (`windows-latest` GitHub runners ship with it), which doesn't have this problem.
- **PATH doesn't persist between shell invocations** on some setups — if you're scripting the GNU toolchain, set cargo + MinGW on PATH at the top of every shell command that needs them.
- A harmless-but-permanent linker warning accompanies GNU Tauri builds: `.rsrc merge failure: multiple non-default manifests`. The binary is fine. Don't chase it.

### Packaging and installation

- **Tauri preserves a bundled resource's relative path.** `"resources": ["bin/foo.exe"]` lands at `$INSTDIR\bin\foo.exe`, *not* `$INSTDIR\foo.exe`. Getting this wrong once meant the installer silently registered nothing.
- **NSIS `ExecWait` fails silently on a missing path.** Always check the exit code and surface failures — a half-installed app looks identical to a totally broken one.
- **Tauri's NSIS default is a per-user install** (`%LOCALAPPDATA%`, no UAC). Anything needing elevation — like registering a service — requires `"installMode": "perMachine"`. The tell is the *absence* of a UAC prompt.

### Windows services

- Querying service state needs only `CONNECT` + `QUERY_STATUS`, which unelevated users have. **Changing** state needs elevation. That asymmetry is why the tray menu can show live status silently but prompts for UAC on start/stop.
- A logon-triggered *Scheduled Task* also requires elevation to register (this was verified, not assumed). The Scheduled Task approach was abandoned in favour of a real service anyway.

### Frontend

- **`[hidden]` loses to any class that sets `display`.** An element with both `hidden` and e.g. `.csm-grid { display: grid }` stays visible. Always pair with `.that-class[hidden] { display: none; }`. This bit twice, in two different codebases.
- **Never surface a bare `fetch()` failure to the user.** "Failed to fetch" reads like the *monitored site* is broken and sends debugging down the wrong path. All API calls go through `apiFetch()` in `api-base.js`, which names the actual cause. Keep it that way.
- The frontend is served from two different origins (the service over `127.0.0.1`, and `tauri.localhost` inside the webview). `api-base.js` resolves which to call. Root-relative `/api/` paths will silently break in the webview.

### Environment / hosting

- **Windows resolves `localhost` IPv6-first**, which some local Apache setups don't listen on — causing a multi-second timeout where `127.0.0.1` is instant. Use `127.0.0.1` in local test URLs.
- On CloudLinux/CageFS shared cPanel hosting, `uapi` works fine as the account user even though the cPanel UI sometimes hides "Manage API Tokens" behind a plan restriction — which is exactly why the plugin auto-detects quota via `shell_exec('uapi ...')` instead of the HTTP API.
- CloudLinux LVE CPU units: **100 = one physical core**. Divide raw units by 100 for core-equivalents.
- **A site-wide "require login for all REST requests" hardening plugin breaks the API key, and it looks exactly like a bad key.** Some hardening plugins' Private REST API option rejects every unauthenticated `/wp-json/...` call — including this plugin's own `csst/v1` endpoint — via WordPress's `rest_authentication_errors` filter, *before* the plugin's own permission_callback (the actual API key check) ever runs. Symptom: the desktop app says "not connected" and regenerating/updating the key never fixes it, because the key is never reached. Diagnose by curling a normally-public core route on that site directly (e.g. `/wp-json/wp/v2/types`) — if that *also* 401s with `rest_not_logged_in`, the whole REST API is locked down site-wide, not just this plugin. Fixed in the plugin itself (1.7.7+) with a filter that runs after the hardening plugin's and clears the rejection only for `/csst/v1/` requests carrying a valid key.

## Working style notes

- **No automated tests exist** in any of the three codebases. Verification has been manual throughout: `php -l`, `cargo build`, live browser testing, `curl`/`Invoke-WebRequest`, SSH. If you change behaviour, verify it by actually running it — don't assume.
- Prefer diagnosing over guessing when something "doesn't connect." Several real bugs here were in a different layer than first suspected.
