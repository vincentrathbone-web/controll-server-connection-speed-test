(function () {
  "use strict";

  const POLL_INTERVAL_MS = 2000;
  const KEEPALIVE_POLL_INTERVAL_MS = 15000;
  const MAX_HISTORY_SAMPLES = 900;
  const METRICS = [
    { key: "disk", unit: "%" },
    { key: "cpu", unit: "%" },
    { key: "mem", unit: "%" },
  ];

  const grid = document.getElementById("csm-grid");
  const emptyState = document.getElementById("csm-empty-state");
  const viewToggle = document.getElementById("csm-view-toggle");
  const refreshButton = document.getElementById("csm-refresh-btn");
  const pollStatusEl = document.getElementById("csm-poll-status");
  const cardViewBtn = document.getElementById("csm-view-card-btn");
  const listViewBtn = document.getElementById("csm-view-list-btn");
  const listViewEl = document.getElementById("csm-list-view");
  const sitePicker = document.getElementById("csm-site-picker");
  const keepAlivePanel = document.getElementById("csm-keepalive-panel");
  const keepAliveBody = document.getElementById("csm-keepalive-body");

  if (!grid) {
    return;
  }

  let timerId = null;
  let keepAliveTimerId = null;
  let inFlight = false;
  let currentView = "card";
  let sites = [];
  const history = {};
  // Latest plugin version reported by each site, keyed by site id. Used to
  // flag installs that are behind the newest version currently seen across
  // the fleet — no hardcoded "latest" version to keep updated by hand.
  const siteVersions = {};
  // Keep-alive panel: which sites' ping-history rows are currently expanded
  // (survives the table being rebuilt on every 15s poll), a short-lived
  // cache of each site's last-fetched history, and the previous ok/fail
  // state per site used to detect fresh failures worth alerting on.
  const expandedKeepAliveSiteIds = new Set();
  const previousKeepAliveOk = {};
  let notificationPermissionRequested = false;

  const TIERS = {
    good: { label: "Good", cls: "csm-tier-good" },
    watch: { label: "Needs attention", cls: "csm-tier-watch" },
    "needs-attention": { label: "Poor", cls: "csm-tier-needs-attention" },
    unknown: { label: "Unknown", cls: "csm-tier-unknown" },
  };

  function tierFor(rating) {
    return TIERS[rating] || TIERS.unknown;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function formatPercent(value) {
    return typeof value === "number" ? `${value}%` : "n/a";
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      return "n/a";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function formatDiskRatio(disk) {
    const freeBytes = disk?.freeBytes;
    const totalBytes = disk?.totalBytes;
    if (typeof freeBytes !== "number" || typeof totalBytes !== "number") {
      return null;
    }
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
  }

  function formatCoreValue(n) {
    return Number(n.toFixed(2)).toString();
  }

  function formatCpuRatio(live) {
    const used = live?.cpuUsedRaw;
    const max = live?.cpuMaxRaw;
    if (typeof used !== "number" || typeof max !== "number") {
      return null;
    }
    return `${formatCoreValue(used)} / ${formatCoreValue(max)} cores`;
  }

  function formatMemRatio(live) {
    const usedBytes = live?.usedRamBytes;
    const totalBytes = live?.totalRamBytes;
    if (typeof usedBytes !== "number" || typeof totalBytes !== "number") {
      return null;
    }
    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
  }

  // Numeric (not lexicographic) dotted-version comparison, e.g. "1.10.0" > "1.9.0".
  function compareVersions(a, b) {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }

  function getMaxKnownVersion() {
    const versions = Object.values(siteVersions);
    if (versions.length === 0) {
      return null;
    }
    return versions.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max));
  }

  function duplicatorStat(duplicatorBackup) {
    if (!duplicatorBackup || !duplicatorBackup.installed) {
      return { label: "Not installed", rating: "unknown", detail: "" };
    }
    const backup = duplicatorBackup.lastBackup;
    if (!backup) {
      return { label: "No backups", rating: "watch", detail: "" };
    }
    const rating = backup.isSuccess ? "good" : backup.isFailure ? "needs-attention" : "watch";
    return {
      label: backup.statusLabel || "Unknown",
      rating,
      detail: `${backup.relativeTime || ""}${backup.name ? ` — "${backup.name}"` : ""}`.trim(),
    };
  }

  function pluginVersionStat(pluginVersion) {
    if (typeof pluginVersion !== "string" || !pluginVersion) {
      return { label: "n/a", rating: "unknown", detail: "" };
    }
    const maxVersion = getMaxKnownVersion();
    const isOutdated = maxVersion && compareVersions(pluginVersion, maxVersion) < 0;
    return {
      label: `v${pluginVersion}`,
      rating: isOutdated ? "needs-attention" : "unknown",
      detail: isOutdated ? `Newest seen: v${maxVersion}` : "",
    };
  }

  function ratingForPercent(percent) {
    if (typeof percent !== "number") {
      return "unknown";
    }
    if (percent >= 90) {
      return "needs-attention";
    }
    if (percent >= 80) {
      return "watch";
    }
    return "good";
  }

  const STAT_RATING_CLASS = {
    good: "csm-stat-good",
    watch: "csm-stat-watch",
    "needs-attention": "csm-stat-bad",
  };

  function statClass(rating) {
    return STAT_RATING_CLASS[rating] || "";
  }

  function buildCard(site) {
    const div = document.createElement("div");
    div.className = "csm-card";
    div.dataset.siteId = String(site.id);
    div.innerHTML = `
      <div class="csm-site-card-header">
          <span class="csm-site-card-title">${escapeHtml(site.label)}</span>
          <span class="csm-tier csm-tier-unknown" data-role="tier">Pending</span>
      </div>
      <div class="csm-site-card-meta" data-role="meta">Not probed yet</div>
      <div class="csm-site-stat-grid" data-role="stats" hidden></div>
    `;
    return div;
  }

  function renderCard(card, result) {
    const tierEl = card.querySelector('[data-role="tier"]');
    const metaEl = card.querySelector('[data-role="meta"]');
    const statsEl = card.querySelector('[data-role="stats"]');

    if (!result) {
      return;
    }

    if (!result.ok) {
      tierEl.className = "csm-tier csm-tier-offline";
      tierEl.textContent = "Offline";
      metaEl.textContent = `${result.error || "Unreachable"} (probed ${formatLocalTime(result.probedAt)})`;
      statsEl.hidden = true;
      return;
    }

    const data = result.data || {};
    if (typeof data.pluginVersion === "string" && data.pluginVersion) {
      siteVersions[result.id] = data.pluginVersion;
    }
    const rating = data.interpretation?.overall?.rating || "unknown";
    const t = tierFor(rating);
    tierEl.className = `csm-tier ${t.cls}`;
    tierEl.textContent = t.label;
    metaEl.textContent = `Last probed ${formatLocalTime(result.probedAt)}`;

    const diskPercent = data.disk?.usedPercent;
    const cpuPercent = data.live?.cpuPercent;
    const memPercent = data.live?.memoryPercent;
    const alertActive = data.diskMonitor?.alertActive;
    const diskRatio = formatDiskRatio(data.disk);
    const cpuRatio = formatCpuRatio(data.live);
    const memRatio = formatMemRatio(data.live);

    const diskRating = data.interpretation?.disk?.rating || ratingForPercent(diskPercent);
    const cpuRating = ratingForPercent(cpuPercent);
    const memRating = ratingForPercent(memPercent);
    const diskMonitorRating = alertActive ? "needs-attention" : "good";
    const dup = duplicatorStat(data.duplicatorBackup);
    const pluginVer = pluginVersionStat(data.pluginVersion);

    statsEl.hidden = false;
    statsEl.innerHTML = `
      <div><b class="${statClass(diskRating)}">${formatPercent(diskPercent)}</b>Disk used${diskRatio ? `<span class="csm-stat-detail">${diskRatio}</span>` : ""}</div>
      <div><b class="${statClass(cpuRating)}">${formatPercent(cpuPercent)}</b>CPU load${cpuRatio ? `<span class="csm-stat-detail">${cpuRatio}</span>` : ""}</div>
      <div><b class="${statClass(memRating)}">${formatPercent(memPercent)}</b>Memory used${memRatio ? `<span class="csm-stat-detail">${memRatio}</span>` : ""}</div>
      <div><b class="${statClass(diskMonitorRating)}">${alertActive ? "ALERT" : "OK"}</b>Disk monitor</div>
      <div><b class="${statClass(dup.rating)}">${escapeHtml(dup.label)}</b>Duplicator backup${dup.detail ? `<span class="csm-stat-detail">${escapeHtml(dup.detail)}</span>` : ""}</div>
      <div><b class="${statClass(pluginVer.rating)}">${escapeHtml(pluginVer.label)}</b>Plugin version${pluginVer.detail ? `<span class="csm-stat-detail">${escapeHtml(pluginVer.detail)}</span>` : ""}</div>
      <div><b>${data.activePluginCount ?? "n/a"}</b>Active plugins</div>
      <div><b>${data.wpVersion || "n/a"}</b>WordPress</div>
    `;
  }

  function recordHistory(siteId, data) {
    if (!history[siteId]) {
      history[siteId] = [];
    }
    const diskPercent = data.disk?.usedPercent;
    const cpuPercent = data.live?.cpuPercent;
    const memPercent = data.live?.memoryPercent;

    history[siteId].push({
      t: new Date(),
      disk: typeof diskPercent === "number" ? diskPercent : null,
      cpu: typeof cpuPercent === "number" ? cpuPercent : null,
      mem: typeof memPercent === "number" ? memPercent : null,
      diskRatio: formatDiskRatio(data.disk),
      cpuRatio: formatCpuRatio(data.live),
      memRatio: formatMemRatio(data.live),
    });

    while (history[siteId].length > MAX_HISTORY_SAMPLES) {
      history[siteId].shift();
    }
  }

  function formatTimeLabel(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function buildChartSvg(samples, metricKey, unit) {
    const width = 600;
    const height = 160;
    const padding = { top: 10, right: 10, bottom: 20, left: 40 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const points = samples
      .map((s) => ({ t: s.t, v: s[metricKey] }))
      .filter((p) => typeof p.v === "number" && Number.isFinite(p.v));

    if (points.length < 2) {
      return '<div class="csm-chart-empty">Collecting data…</div>';
    }

    const values = points.map((p) => p.v);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const range = max - min;
    min = Math.max(0, min - range * 0.15);
    max = unit === "%" ? Math.min(100, max + range * 0.15) : max + range * 0.15;
    if (min === max) {
      max = min + 1;
    }

    const xFor = (i) => padding.left + (i / (points.length - 1)) * plotW;
    const yFor = (v) => padding.top + plotH - ((v - min) / (max - min)) * plotH;

    const linePath = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.v).toFixed(1)}`)
      .join(" ");
    const areaPath = `${linePath} L ${xFor(points.length - 1).toFixed(1)} ${(padding.top + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(padding.top + plotH).toFixed(1)} Z`;

    const gridLines = [0, 0.5, 1]
      .map((frac) => {
        const y = padding.top + plotH * frac;
        const value = max - frac * (max - min);
        const label = unit === "%" ? `${Math.round(value)}%` : Math.round(value);
        return `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="csm-chart-grid" />
                <text x="${padding.left - 6}" y="${(y + 4).toFixed(1)}" class="csm-chart-axis-label" text-anchor="end">${label}</text>`;
      })
      .join("");

    const gradientId = `csmGrad-${metricKey}`;
    const firstLabel = formatTimeLabel(points[0].t);
    const lastLabel = formatTimeLabel(points[points.length - 1].t);

    return `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--csm-color-accent)" stop-opacity="0.35" />
            <stop offset="100%" stop-color="var(--csm-color-accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${areaPath}" fill="url(#${gradientId})" stroke="none" />
        <path d="${linePath}" fill="none" stroke="var(--csm-color-accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <text x="${padding.left}" y="${height - 4}" class="csm-chart-axis-label">${firstLabel}</text>
        <text x="${width - padding.right}" y="${height - 4}" class="csm-chart-axis-label" text-anchor="end">${lastLabel}</text>
      </svg>
    `;
  }

  function renderListView() {
    if (currentView !== "list" || !listViewEl || !sitePicker || !sitePicker.value) {
      return;
    }
    const siteId = sitePicker.value;
    const samples = history[siteId] || [];
    const latest = samples[samples.length - 1];

    METRICS.forEach((metric) => {
      const statEl = listViewEl.querySelector(`[data-stat="${metric.key}"]`);
      const detailEl = listViewEl.querySelector(`[data-detail="${metric.key}"]`);
      const chartEl = listViewEl.querySelector(`[data-chart="${metric.key}"]`);
      if (statEl) {
        const value = latest ? latest[metric.key] : null;
        statEl.textContent = typeof value === "number" ? `${value}${metric.unit}` : "n/a";
      }
      if (detailEl) {
        detailEl.textContent = (latest && latest[`${metric.key}Ratio`]) || "";
      }
      if (chartEl) {
        chartEl.innerHTML = buildChartSvg(samples, metric.key, metric.unit);
      }
    });
  }

  function setView(view) {
    currentView = view;
    const isList = view === "list";
    grid.hidden = isList;
    if (listViewEl) {
      listViewEl.hidden = !isList;
    }
    if (sitePicker) {
      sitePicker.hidden = !isList;
    }
    if (cardViewBtn) {
      cardViewBtn.classList.toggle("is-active", !isList);
    }
    if (listViewBtn) {
      listViewBtn.classList.toggle("is-active", isList);
    }
    try {
      window.localStorage.setItem("csmView", view);
    } catch (error) {
      // Ignore storage failures (private browsing, disabled storage, etc).
    }
    if (isList) {
      renderListView();
    }
    if (timerId !== null) {
      stopPolling();
      startPolling();
    }
  }

  function applyResult(result) {
    const card = grid.querySelector(`[data-site-id="${result.id}"]`);
    if (card) {
      renderCard(card, result);
    }
    if (result.ok) {
      recordHistory(result.id, result.data || {});
    }
  }

  async function pollEverySite() {
    const response = await apiFetch("/api/probe_all", { cache: "no-store" });
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    results.forEach(applyResult);
  }

  async function pollSingleSite(siteId) {
    const response = await apiFetch(`/api/probe?id=${encodeURIComponent(siteId)}`, { cache: "no-store" });
    const result = await response.json();
    applyResult(result);
  }

  async function pollAll() {
    if (inFlight) {
      return;
    }
    inFlight = true;
    pollStatusEl.textContent = "Probing...";
    refreshButton.disabled = true;

    try {
      if (currentView === "list" && sitePicker && sitePicker.value) {
        await pollSingleSite(sitePicker.value);
      } else {
        await pollEverySite();
      }

      renderListView();
      pollStatusEl.textContent = `Last refresh: ${new Date().toLocaleTimeString([], { hour12: false })}`;
    } catch (error) {
      pollStatusEl.textContent = `Refresh failed: ${error.message || "Unknown error"}`;
    } finally {
      inFlight = false;
      refreshButton.disabled = false;
    }
  }

  function startPolling() {
    if (timerId !== null || sites.length === 0) {
      return;
    }
    pollAll();
    timerId = window.setInterval(pollAll, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  // "OK"/"FAIL" alone only says whether the request succeeded, not what the
  // server actually said — show the real HTTP status (or the connection
  // error when there wasn't one) so a claimed "OK" is actually verifiable.
  function formatPingDetail(entry) {
    if (typeof entry.httpCode === "number" && entry.httpCode > 0) {
      return `HTTP ${entry.httpCode}`;
    }
    return entry.error || "no response";
  }

  function renderKeepAliveHistoryTable(entries) {
    if (!entries || entries.length === 0) {
      return '<div class="csm-empty">No ping history recorded yet.</div>';
    }
    const rows = entries
      .map((e) => {
        const tier = e.ok ? TIERS.good : TIERS["needs-attention"];
        return `
          <tr>
            <td>${escapeHtml(formatLocalTime(e.pingAt))}</td>
            <td><span class="csm-tier ${tier.cls}">${e.ok ? "OK" : "FAIL"}</span></td>
            <td>${escapeHtml(formatPingDetail(e))}</td>
            <td>${e.elapsedMs} ms</td>
          </tr>
        `;
      })
      .join("");
    return `
      <table class="csm-table csm-keepalive-history-table">
        <thead><tr><th>Time</th><th>Result</th><th>Detail</th><th>Elapsed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadKeepAliveHistory(siteId) {
    const bodyEl = keepAliveBody.querySelector(`[data-history-body="${siteId}"]`);
    if (!bodyEl) {
      return;
    }
    try {
      const response = await apiFetch(`/api/keepalive/history?siteId=${encodeURIComponent(siteId)}&limit=30`, {
        cache: "no-store",
      });
      const data = await response.json();
      bodyEl.innerHTML = renderKeepAliveHistoryTable(Array.isArray(data.history) ? data.history : []);
    } catch (error) {
      bodyEl.innerHTML = `<div class="csm-empty">Failed to load history: ${escapeHtml(error.message || "Unknown error")}</div>`;
    }
  }

  function maybeRequestNotificationPermission() {
    if (!("Notification" in window) || notificationPermissionRequested) {
      return;
    }
    notificationPermissionRequested = true;
    if (Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  // Only alerts on a transition into failure (not on every already-failing
  // site at load time, which the visible FAIL badge already covers) so it
  // doesn't spam a notification every 15 seconds for a site that's still down.
  function checkForKeepAliveFailures(statuses) {
    const canNotify = "Notification" in window && Notification.permission === "granted";
    statuses.forEach((s) => {
      const wasOk = previousKeepAliveOk[s.siteId];
      if (canNotify && wasOk === true && s.ok === false) {
        try {
          new Notification(`Keep-alive failed: ${s.label}`, { body: formatPingDetail(s) });
        } catch (error) {
          // Never let a notification failure break polling.
        }
      }
      previousKeepAliveOk[s.siteId] = s.ok;
    });
  }

  function renderKeepAliveTable(statuses) {
    if (!keepAliveBody) {
      return;
    }
    if (statuses.length === 0) {
      keepAliveBody.innerHTML = '<tr><td colspan="5" class="csm-empty">No pings recorded yet — the background loop pings every 5 minutes, starting right after this app launches.</td></tr>';
      return;
    }
    keepAliveBody.innerHTML = statuses
      .map((s) => {
        const tier = s.ok ? TIERS.good : TIERS["needs-attention"];
        const sid = String(s.siteId);
        const isExpanded = expandedKeepAliveSiteIds.has(sid);
        return `
          <tr class="csm-keepalive-row" data-site-id="${sid}" title="Click to view ping history">
            <td>${escapeHtml(s.label)}</td>
            <td><span class="csm-tier ${tier.cls}">${s.ok ? "OK" : "FAIL"}</span> <span class="csm-stat-detail">${escapeHtml(formatPingDetail(s))}</span></td>
            <td>${escapeHtml(formatLocalTime(s.lastPingAt))}</td>
            <td>${s.elapsedMs} ms</td>
            <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(s.url)}</td>
          </tr>
          <tr class="csm-keepalive-history-row" ${isExpanded ? "" : "hidden"}>
            <td colspan="5"><div class="csm-keepalive-history" data-history-body="${sid}">Loading history…</div></td>
          </tr>
        `;
      })
      .join("");

    keepAliveBody.querySelectorAll(".csm-keepalive-row").forEach((row) => {
      row.addEventListener("click", function () {
        const sid = row.getAttribute("data-site-id");
        const historyRow = row.nextElementSibling;
        if (expandedKeepAliveSiteIds.has(sid)) {
          expandedKeepAliveSiteIds.delete(sid);
        } else {
          expandedKeepAliveSiteIds.add(sid);
          loadKeepAliveHistory(sid);
        }
        if (historyRow) {
          historyRow.hidden = !expandedKeepAliveSiteIds.has(sid);
        }
      });
    });

    // Rows left expanded across the periodic rebuild should show fresh data,
    // not freeze on whatever was loaded the first time they were opened.
    expandedKeepAliveSiteIds.forEach((sid) => loadKeepAliveHistory(sid));

    checkForKeepAliveFailures(statuses);
  }

  async function pollKeepAliveStatus() {
    try {
      const response = await apiFetch("/api/keepalive/status", { cache: "no-store" });
      const data = await response.json();
      renderKeepAliveTable(Array.isArray(data.statuses) ? data.statuses : []);
    } catch (error) {
      // Silent — this is a secondary panel, don't clobber the main poll status text.
    }
  }

  function startKeepAlivePolling() {
    if (keepAliveTimerId !== null) {
      return;
    }
    maybeRequestNotificationPermission();
    pollKeepAliveStatus();
    keepAliveTimerId = window.setInterval(pollKeepAliveStatus, KEEPALIVE_POLL_INTERVAL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopPolling();
      pollStatusEl.textContent = "Paused (tab hidden).";
    } else {
      startPolling();
    }
  });
  window.addEventListener("pagehide", stopPolling);

  refreshButton.addEventListener("click", function () {
    stopPolling();
    startPolling();
  });

  if (cardViewBtn && listViewBtn) {
    cardViewBtn.addEventListener("click", function () {
      setView("card");
    });
    listViewBtn.addEventListener("click", function () {
      setView("list");
    });
  }

  if (sitePicker) {
    sitePicker.addEventListener("change", renderListView);
    sitePicker.addEventListener("change", function () {
      if (timerId !== null) {
        stopPolling();
        startPolling();
      }
      try {
        window.localStorage.setItem("csmSelectedSite", sitePicker.value);
      } catch (error) {
        // Ignore storage failures.
      }
    });
  }

  async function init() {
    let data;
    try {
      const response = await apiFetch("/api/sites", { cache: "no-store" });
      data = await response.json();
    } catch (error) {
      pollStatusEl.textContent = `Failed to load sites: ${error.message || "Unknown error"}`;
      return;
    }

    sites = Array.isArray(data.sites) ? data.sites : [];

    if (sites.length === 0) {
      emptyState.hidden = false;
      pollStatusEl.textContent = "";
      refreshButton.disabled = true;
      return;
    }

    if (viewToggle) {
      viewToggle.hidden = false;
    }
    if (keepAlivePanel) {
      keepAlivePanel.hidden = false;
    }

    grid.hidden = false;
    grid.innerHTML = "";
    sites.forEach((site) => grid.appendChild(buildCard(site)));

    if (sitePicker) {
      sitePicker.innerHTML = sites
        .map((site) => `<option value="${site.id}">${escapeHtml(site.label)}</option>`)
        .join("");

      try {
        const savedSite = window.localStorage.getItem("csmSelectedSite");
        if (savedSite && sitePicker.querySelector(`option[value="${savedSite}"]`)) {
          sitePicker.value = savedSite;
        }
      } catch (error) {
        // Ignore storage failures.
      }
    }

    let initialView = "card";
    try {
      const savedView = window.localStorage.getItem("csmView");
      if (savedView === "list" || savedView === "card") {
        initialView = savedView;
      }
    } catch (error) {
      // Ignore storage failures.
    }

    if (cardViewBtn && listViewBtn) {
      setView(initialView);
    }

    if (!document.hidden) {
      startPolling();
    }
    startKeepAlivePolling();
  }

  init();
})();
