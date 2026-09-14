# Diagnostics/performance TODO

Proposals from the 2026-09-14 investigation into `nohsapp.co.za` reporting "needs-attention"
speed-test results despite the account's own resource usage all being well within its hosting
allowance. Root cause there turned out to be a mix of genuine shared-host contention (the physical
server running very hot from *other* websites on it) and this site's own heavier-than-typical
workload (HygixOS app sync traffic) — but the plugin currently has no way to show any of that
without SSHing into the box by hand. These close that gap.

## Design constraint: the audience is a non-technical site owner

**This applies to every item below.** The plugin's admin is not a developer. Anything shown to
them must:

1. **Use plain language, never jargon** — no "load average", "OPcache", "LVE", "SAVEQUERIES",
   "swap", "PID", "bootstrap". Say what it means in everyday terms instead.
2. **Always come with a next step**, not just a number. Every finding gets a suggested action,
   sorted into one of three buckets, and the UI should say which bucket it's in:
   - **You can do this yourself** — ideally the plugin does the hard part for them (generates a
     script/command to paste somewhere, points at the exact cPanel screen and setting), the same
     pattern the existing Keep-Alive script generator already uses.
   - **Ask your host to do this** — give them the literal sentence to send in a support ticket.
   - **Nothing to fix here** — purely informational (e.g. "this is caused by other websites
     sharing your server, not by yours").

## Done — shipped in v1.8.0 (2026-09-14)

Built in priority order: the two cheapest, highest-value items first (explain what Process
Monitor can't show; put the two most important numbers side by side), then the four new checks
that hang off the same diagnostics run, since they share the same plumbing and UI pattern.
Verified locally (see "Verification" below) — a real bug (unmeasurable diagnostics showing as
"Good" instead of "Unknown") was caught and fixed in the process.

- [x] **Explain the Process Monitor's real limitation, in plain terms.** Confirmed by direct SSH
  testing that shared hosting jails this list to the account's own processes only. Added a note
  in the UI pointing at the "Shared Server" reading instead of leaving the reader to hunt through
  an innocent-looking process list for a culprit that isn't there.
- [x] **Show how busy the shared server is, next to how much of your own allowance you're using.**
  Live Resource Usage now has a "Shared Server" card alongside "Your Website" (the account-scoped
  figure was already computed but silently discarded when LVE data was available — now always
  surfaced).
- [x] **Turn the two numbers above into one plain sentence automatically.** Both the live-polling
  panel and the on-demand Diagnostics Snapshot's "Load" card now generate the actual sentence
  ("your website itself isn't using too many resources... contacting your host is the best next
  step") instead of leaving the reader to compare two cards themselves.
- [x] **Detect whether the site is remembering repeated information, or looking it up fresh every
  time** (object cache). Surfaced as "Repeated Lookups" with a plain recommendation to ask the
  host about Redis/Memcached.
- [x] **Detect whether the server is keeping the site's code "warmed up"** (OPcache), read from
  inside a real web request as it has to be — confirmed via testing that WP-CLI can't see this
  (different PHP mode than real visits). Surfaced as "Code Readiness" with the exact cPanel
  setting to look for.
- [x] **Scheduled-tasks health check** (WP-Cron). Surfaced as "Scheduled Tasks", scored on actual
  overdue task count rather than total scheduled count (a healthy site normally has dozens
  scheduled for the future — that's not a problem by itself). Includes a ready-to-paste cPanel
  Cron Jobs command when real overdue tasks are found.
- [x] **Detect when the server is critically low on memory** (swap). Only shown when actually
  significant (≥85% of backup memory in use) — no permanent "everything's fine" clutter.

**Verification:** `php -l` and `node --check` on both changed files, then live-tested against a
local WordPress install (`hygixos.test` / `localhost:8080`) with this plugin active — ran a real
Diagnostics Snapshot, watched Live Resource Usage poll, and read the rendered page text and
console for errors. Caught and fixed one real bug this way: diagnostics that couldn't be measured
on that host (no `sys_getloadavg()` support) were showing as "Good" instead of "Unknown" — a green
checkmark next to "could not be measured" is exactly the kind of misleading signal this whole
effort is meant to prevent. Not yet tested against `nohsapp.co.za` itself or a live cPanel/LVE
host — the object-cache/OPcache/cron logic is straightforward enough to trust from code review,
but the "Shared Server" card and swap detection specifically want a real Linux host with
`sys_getloadavg()` and `/proc` available to see actual non-null numbers.

## Not started — remaining, in priority order

- [ ] **Bootstrap-independent "raw ping" endpoint.** `ajax_ping()` runs through `admin-ajax.php`,
  which means every "Latency" sample pays the full WordPress bootstrap (all active plugins) before
  the one-line handler executes. Add a second, lightweight ping that bypasses that (a tiny
  standalone script, or an mu-plugin hooked as early as possible) so Latency can be split into
  "raw web server" vs. "WordPress + plugins" — this alone would have shown directly which layer
  was slow instead of one blended number.
  - **Show the user:** "Website starts responding in: 0.7s" and, separately, "Your pages finish
    loading in: 0.1s after that."
  - **Suggested action:** Slow first number, fast second → **ask your host** ("My site is slow to
    start responding to any request, even a very simple one — can you check if the server is
    overloaded?"). Slow second number → **you can do this yourself** (deactivate unused plugins
    one at a time).
  - Largest remaining item: touches the speed-test measurement itself, needs a second latency
    series in the history UI, and a new unauthenticated endpoint to review for abuse potential.

- [ ] **A time-boxed "who's using your site right now" report**, run on demand only (a "Start
  Capture" button on the Process Monitor tab, ~60 seconds, then goes fully inactive — no standing
  logger, per earlier discussion). Confirmed by direct testing that a process's visitor and
  triggering plugin can't be read from the server's operating system at all; has to be captured
  from inside WordPress itself, for that one short window.
  - **Show the user:** A table — "What was happening" / "How often" / "Roughly where from" — with
    known activity translated into readable labels ("Your own Live Stats monitor," "A backup
    running") and a generic "An unrecognized plugin action" fallback.
  - **Suggested action:** Depends on what's found — mostly the user's own tools → nothing to fix;
    a lot of one unrecognized action → deactivate that plugin to test; unfamiliar locations → flag
    as a security question, not a performance one.
  - Second-largest remaining item: new AJAX actions (start/stop/report), a capped ring buffer, and
    an IP → city/country lookup for the "roughly where from" column.

- [ ] **Show which times of day the site tends to slow down**, as a simple chart on the Speed Test
  History panel. Shared-host contention often has a daily rhythm.
  - **Show the user:** "Your site tends to slow down between 2pm–4pm."
  - **Suggested action:** **Ask your host**, with the chart attached.
  - Needs history data to already show a pattern to be worth building — most useful once a site
    has accumulated a few weeks of speed-test runs, so lower urgency than the two items above.

- [ ] **(Bigger, optional) Let the desktop app check the server's overall health directly**,
  bypassing the website entirely — since asking a slow website "are you slow?" is partly
  self-defeating. Bigger architecture change than everything else on this list (touches
  `controll-server-monitor-rs`, not just the WordPress plugin); flagging as an idea, not proposing
  to build yet.
  - **Show the user:** A single plain "Server health: Good / Busy / Overloaded" indicator per
    registered site.
