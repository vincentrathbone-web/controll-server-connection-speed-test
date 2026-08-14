(function () {
  "use strict";

  const POLL_INTERVAL_MS = 2000;
  const MAX_HISTORY_SAMPLES = 900;
  const METRICS = [
    { key: "disk", unit: "%" },
    { key: "cpu", unit: "%" },
    { key: "mem", unit: "%" },
  ];

  const grid = document.getElementById("csm-grid");
  const refreshButton = document.getElementById("csm-refresh-btn");
  const pollStatusEl = document.getElementById("csm-poll-status");
  const cardViewBtn = document.getElementById("csm-view-card-btn");
  const listViewBtn = document.getElementById("csm-view-list-btn");
  const listViewEl = document.getElementById("csm-list-view");
  const sitePicker = document.getElementById("csm-site-picker");

  if (!grid) {
    return;
  }

  let timerId = null;
  let inFlight = false;
  let currentView = "card";
  const history = {};

  const TIERS = {
    good: { label: "Good", cls: "csm-tier-good" },
    watch: { label: "Needs attention", cls: "csm-tier-watch" },
    "needs-attention": { label: "Poor", cls: "csm-tier-needs-attention" },
    unknown: { label: "Unknown", cls: "csm-tier-unknown" },
  };

  function tierFor(rating) {
    return TIERS[rating] || TIERS.unknown;
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
    // Both sides are core-equivalents regardless of source: on CloudLinux/LVE
    // hosts this is the account's own CPU quota; otherwise it's system load
    // average vs logical core count.
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

  // Disk uses the WP plugin's own server-computed rating (respects the real
  // alert threshold and cPanel-quota source); CPU/memory have no equivalent
  // server-side rating, so mirror the same 80/90 thresholds client-side.
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
      metaEl.textContent = `${result.error || "Unreachable"} (probed ${result.probedAt})`;
      statsEl.hidden = true;
      return;
    }

    const data = result.data || {};
    const rating = data.interpretation?.overall?.rating || "unknown";
    const t = tierFor(rating);
    tierEl.className = `csm-tier ${t.cls}`;
    tierEl.textContent = t.label;
    metaEl.textContent = `Last probed ${result.probedAt}`;

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

    statsEl.hidden = false;
    statsEl.innerHTML = `
      <div><b class="${statClass(diskRating)}">${formatPercent(diskPercent)}</b>Disk used${diskRatio ? `<span class="csm-stat-detail">${diskRatio}</span>` : ""}</div>
      <div><b class="${statClass(cpuRating)}">${formatPercent(cpuPercent)}</b>CPU load${cpuRatio ? `<span class="csm-stat-detail">${cpuRatio}</span>` : ""}</div>
      <div><b class="${statClass(memRating)}">${formatPercent(memPercent)}</b>Memory used${memRatio ? `<span class="csm-stat-detail">${memRatio}</span>` : ""}</div>
      <div><b class="${statClass(diskMonitorRating)}">${alertActive ? "ALERT" : "OK"}</b>Disk monitor</div>
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
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
    const response = await fetch("api/probe_all.php", { cache: "no-store" });
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    results.forEach(applyResult);
  }

  async function pollSingleSite(siteId) {
    const response = await fetch(`api/probe.php?id=${encodeURIComponent(siteId)}`, { cache: "no-store" });
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
      pollStatusEl.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      pollStatusEl.textContent = `Refresh failed: ${error.message || "Unknown error"}`;
    } finally {
      inFlight = false;
      refreshButton.disabled = false;
    }
  }

  function startPolling() {
    if (timerId !== null) {
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

  refreshButton.addEventListener("click", function () {
    stopPolling();
    startPolling();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopPolling();
      pollStatusEl.textContent = "Paused (tab hidden).";
    } else {
      startPolling();
    }
  });
  window.addEventListener("pagehide", stopPolling);

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

    try {
      const savedSite = window.localStorage.getItem("csmSelectedSite");
      if (savedSite && sitePicker.querySelector(`option[value="${savedSite}"]`)) {
        sitePicker.value = savedSite;
      }
    } catch (error) {
      // Ignore storage failures.
    }

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
})();
