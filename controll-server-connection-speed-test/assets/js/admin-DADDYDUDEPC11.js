(function () {
  "use strict";

  const config = window.CSSTConfig || {};
  const defaults = config.defaults || {};

  const startButton = document.getElementById("csst-start");
  const stopButton = document.getElementById("csst-stop");
  const statusEl = document.getElementById("csst-status");

  const latencyEl = document.getElementById("csst-latency");
  const jitterEl = document.getElementById("csst-jitter");
  const downloadEl = document.getElementById("csst-download");
  const uploadEl = document.getElementById("csst-upload");
  const summaryEl = document.getElementById("csst-summary");
  const historyBodyEl = document.getElementById("csst-history-body");
  const exportCsvButton = document.getElementById("csst-export-csv");
  const diagnosticsButton = document.getElementById("csst-run-diagnostics");
  const diagnosticsStatusEl = document.getElementById("csst-diagnostics-status");
  const diagnosticsOutputEl = document.getElementById("csst-diagnostics-output");
  const window1hEl = document.querySelector("#csst-window-1h .csst-window-metrics");
  const window24hEl = document.querySelector("#csst-window-24h .csst-window-metrics");
  const window7dEl = document.querySelector("#csst-window-7d .csst-window-metrics");
  const tabButtons = document.querySelectorAll(".csst-tab-button");
  const tabViews = document.querySelectorAll(".csst-tab-view");
  const refreshProcessesButton = document.getElementById("csst-refresh-processes");
  const processesStatusEl = document.getElementById("csst-processes-status");
  const processesBodyEl = document.getElementById("csst-processes-body");
  const downloadKeepAliveButton = document.getElementById("csst-download-keep-alive");
  const pluginLoadStatusEl = document.getElementById("csst-plugin-load-status");
  const pluginLoadBodyEl = document.getElementById("csst-plugin-load-body");
  const bannerIconEl = document.getElementById("csst-banner-icon");
  const bannerIconPathEl = document.getElementById("csst-banner-icon-path");
  const bannerLabelEl = document.getElementById("csst-banner-label");
  const bannerSummaryEl = document.getElementById("csst-banner-summary");
  const specsGridEl = document.getElementById("csst-specs-grid");
  const metricsGridEl = document.getElementById("csst-metrics-grid");
  const historyTableEl = document.getElementById("csst-history-table");
  const liveCpuValueEl = document.getElementById("csst-live-cpu-value");
  const liveRamValueEl = document.getElementById("csst-live-ram-value");
  const liveCpuChartEl = document.getElementById("csst-live-cpu-chart");
  const liveRamChartEl = document.getElementById("csst-live-ram-chart");
  const generateApiKeyButton = document.getElementById("csst-generate-api-key");
  const revokeApiKeyButton = document.getElementById("csst-revoke-api-key");
  const apiKeyInputEl = document.getElementById("csst-api-key");
  const apiKeyStatusEl = document.getElementById("csst-api-key-status");
  const cpanelUsernameInput = document.getElementById("csst-cpanel-username");
  const cpanelTokenInput = document.getElementById("csst-cpanel-token");
  const cpanelHostInput = document.getElementById("csst-cpanel-host");
  const saveCpanelButton = document.getElementById("csst-save-cpanel");
  const testCpanelButton = document.getElementById("csst-test-cpanel");
  const clearCpanelButton = document.getElementById("csst-clear-cpanel");
  const cpanelStatusEl = document.getElementById("csst-cpanel-status");
  const refreshCpanelShellButton = document.getElementById("csst-refresh-cpanel-shell");
  const cpanelShellStatusEl = document.getElementById("csst-cpanel-shell-status");
  const duplicatorStatusEl = document.getElementById("csst-duplicator-status");

  let stopped = false;
  let historyRecords = [];
  let historySortKey = null;
  let historySortAsc = true;
  let expandedHistoryIds = new Set();

  function circleD(cx, cy, r) {
    return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
  }

  const ICON_D = {
    "check-circle": `${circleD(12, 12, 10)} M8 12 L11 15 L16 9`,
    "alert-triangle": "M12 3 L2 21 H22 Z M12 9 L12 13 M12 17 L12 17.01",
    "x-circle": `${circleD(12, 12, 10)} M9 9 L15 15 M15 9 L9 15`,
    "help-circle": `${circleD(12, 12, 10)} M9.5 9 a2.5 2.5 0 1 1 3.5 2.3 c-1 0.4 -1 1.2 -1 1.7 M12 17 L12 17.01`,
    globe: `${circleD(12, 12, 10)} M2 12 H22 M12 2 C8 6 8 18 12 22 M12 2 C16 6 16 18 12 22`,
    cpu: "M4 4 H20 V20 H4 Z M9 9 H15 V15 H9 Z",
    "memory-stick": "M2 10 H22 V18 H2 Z M6 10 V14 M10 10 V14 M14 10 V14 M18 10 V14",
    "hard-drive": "M3 10 H21 V20 H3 Z M3 13 H21 M7 17 L7.01 17 M11 17 L11.01 17",
    database: `M3 5 a9 3 0 0 0 18 0 a9 3 0 0 0 -18 0 M3 5 V19 A9 3 0 0 0 21 19 V5 M3 12 A9 3 0 0 0 21 12`,
    zap: "M13 2 L3 14 L12 14 L11 22 L21 10 L12 10 Z",
  };

  const TIERS = {
    good: { icon: "check-circle", label: "Good" },
    watch: { icon: "alert-triangle", label: "Needs attention" },
    "needs-attention": { icon: "x-circle", label: "Poor" },
    unknown: { icon: "help-circle", label: "Unknown" },
  };

  function tierFor(rating) {
    return TIERS[rating] || TIERS.unknown;
  }

  function tierClass(rating) {
    return `csst-tier-${TIERS[rating] ? rating : "unknown"}`;
  }

  function tierBadgeHtml(rating) {
    const t = tierFor(rating);
    return `<span class="csst-tier ${tierClass(rating)}"><svg class="csst-ico" width="14" height="14" viewBox="0 0 24 24"><path d="${ICON_D[t.icon]}"></path></svg>${t.label}</span>`;
  }

  function renderBanner(diagnostics) {
    const overall = diagnostics?.interpretation?.overall || {};
    const rating = overall.rating || "unknown";
    const t = tierFor(rating);
    bannerIconEl.className = `csst-banner-icon ${tierClass(rating)}`;
    bannerIconPathEl.setAttribute("d", ICON_D[t.icon] || "");
    bannerLabelEl.textContent = t.label;
    bannerSummaryEl.textContent = overall.summary || "No interpretation available.";
  }

  function renderSpecs(diagnostics) {
    if (!diagnostics) {
      return;
    }
    const disk = diagnostics.disk || {};
    const diskLabel = disk.freeBytes !== null && disk.freeBytes !== undefined && disk.totalBytes
      ? `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}`
      : "n/a";

    const specs = [
      { label: "WordPress", value: diagnostics.wpVersion || "n/a", icon: "globe" },
      { label: "CPU Cores", value: diagnostics.cpuLogicalCores ?? "n/a", icon: "cpu" },
      { label: "System RAM", value: formatBytes(diagnostics.totalSystemRamBytes), icon: "memory-stick" },
      { label: "Memory Limit", value: diagnostics.memoryLimit || "n/a", icon: "hard-drive" },
      { label: "Disk Space", value: diskLabel, icon: "hard-drive" },
    ];

    specsGridEl.innerHTML = specs
      .map((s) => `
        <div class="csst-card csst-spec-card">
          <div class="csst-spec-icon"><svg class="csst-ico" width="18" height="18" viewBox="0 0 24 24"><path d="${ICON_D[s.icon]}"></path></svg></div>
          <div>
            <div class="csst-spec-value">${escapeHtml(s.value)}</div>
            <div class="csst-spec-label">${escapeHtml(s.label)}</div>
          </div>
        </div>
      `)
      .join("");
  }

  function renderMetricsGrid(diagnostics) {
    const interpretation = diagnostics?.interpretation || {};
    const diskMonitorNote = formatDiskMonitorLine(diagnostics?.diskMonitor);

    const diskPercent = diagnostics?.disk?.usedPercent;
    const metrics = [
      { label: "Database", icon: "database", key: "database", value: `${diagnostics?.dbQueryMs ?? "n/a"} ms round-trip` },
      { label: "PHP Benchmark", icon: "zap", key: "phpBenchmark", value: `${diagnostics?.phpBenchmarkMs ?? "n/a"} ms` },
      { label: "Load", icon: "cpu", key: "load", value: `${diagnostics?.cpuLogicalCores ?? "n/a"} logical cores` },
      { label: "Memory", icon: "memory-stick", key: "memory", value: `${diagnostics?.memoryLimit ?? "n/a"} limit` },
      { label: "Disk", icon: "hard-drive", key: "disk", value: diskPercent !== null && diskPercent !== undefined ? `${diskPercent}% used` : "n/a", extraMeta: diskMonitorNote },
    ];

    metricsGridEl.innerHTML = metrics
      .map((m) => {
        const info = interpretation[m.key] || {};
        const rating = info.rating || "unknown";
        const extraMeta = m.extraMeta ? `<div class="csst-card-meta">${escapeHtml(m.extraMeta)}</div>` : "";
        return `
          <div class="csst-card">
            <div class="csst-metric-head">
              <div class="csst-metric-head-left">
                <div class="csst-spec-icon"><svg class="csst-ico" width="18" height="18" viewBox="0 0 24 24"><path d="${ICON_D[m.icon]}"></path></svg></div>
                <span class="csst-metric-title">${escapeHtml(m.label)}</span>
              </div>
              ${tierBadgeHtml(rating)}
            </div>
            <p class="csst-card-body">${escapeHtml(info.summary || "")}</p>
            <div class="csst-card-meta">${escapeHtml(m.value)}</div>
            ${extraMeta}
          </div>
        `;
      })
      .join("");
  }

  // Mirrors CSST_Plugin::render_duplicator_status_html() on the PHP side so
  // the card looks the same on first page load and after a diagnostics run.
  function renderDuplicatorBackup(diagnostics) {
    if (!duplicatorStatusEl) {
      return;
    }
    const status = diagnostics?.duplicatorBackup;
    if (!status) {
      return;
    }

    if (!status.installed) {
      duplicatorStatusEl.innerHTML = '<span id="csst-duplicator-badge" class="csst-tier csst-tier-unknown">Not detected</span> <span>Duplicator Pro was not detected on this site.</span>';
      return;
    }

    const backup = status.lastBackup;
    if (!backup) {
      duplicatorStatusEl.innerHTML = '<span id="csst-duplicator-badge" class="csst-tier csst-tier-unknown">No backups</span> <span>Duplicator Pro is installed but no backups have run yet.</span>';
      return;
    }

    const tier = backup.isSuccess ? "good" : (backup.isFailure ? "needs-attention" : "watch");
    duplicatorStatusEl.innerHTML = `
      <span id="csst-duplicator-badge" class="csst-tier csst-tier-${tier}">${escapeHtml(backup.statusLabel)}</span>
      <span>"${escapeHtml(backup.name)}" — ${escapeHtml(backup.relativeTime || "unknown time")}</span>
    `;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function resetResults() {
    latencyEl.textContent = "-";
    jitterEl.textContent = "-";
    downloadEl.textContent = "-";
    uploadEl.textContent = "-";
    summaryEl.hidden = true;
    summaryEl.textContent = "";
  }

  function formatMs(value) {
    return `${value.toFixed(1)} ms`;
  }

  function formatMbps(bytes, elapsedMs) {
    const bits = bytes * 8;
    const seconds = elapsedMs / 1000;
    const mbps = bits / seconds / 1000000;
    return `${mbps.toFixed(2)} Mbps`;
  }

  function bytesElapsedToMbps(bytes, elapsedMs) {
    const bits = bytes * 8;
    const seconds = elapsedMs / 1000;
    return bits / seconds / 1000000;
  }

  function formatDate(value) {
    const date = new Date(value.replace(" ", "T"));
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString([], { hour12: false });
  }

  function sortedHistoryRecords() {
    if (!historySortKey) {
      return historyRecords;
    }
    const key = historySortKey;
    const asc = historySortAsc;
    return [...historyRecords].sort((a, b) => {
      const av = key === "dt" ? toTimestamp(a) : Number(a[key] || 0);
      const bv = key === "dt" ? toTimestamp(b) : Number(b[key] || 0);
      return (av > bv ? 1 : av < bv ? -1 : 0) * (asc ? 1 : -1);
    });
  }

  function rowId(row, index) {
    return String(row.id || row.timestamp || index);
  }

  function renderHistory(records) {
    historyRecords = Array.isArray(records) ? records : [];
    exportCsvButton.disabled = historyRecords.length === 0;

    if (historyRecords.length === 0) {
      historyBodyEl.innerHTML = "<tr><td colspan=\"6\">No tests yet.</td></tr>";
      renderWindowComparisons();
      return;
    }

    const rows = sortedHistoryRecords()
      .map((row, index) => {
        const id = rowId(row, index);
        const expanded = expandedHistoryIds.has(id);
        return `
          <tr class="csst-history-row" data-row-id="${escapeHtml(id)}">
            <td>${escapeHtml(formatDate(String(row.timestamp || "")))}</td>
            <td>${Number(row.latencyMs || 0).toFixed(1)} ms</td>
            <td>${Number(row.downloadMbps || 0).toFixed(2)} Mbps</td>
            <td>${Number(row.uploadMbps || 0).toFixed(2)} Mbps</td>
            <td>${tierBadgeHtml(row.qualityGrade)}</td>
            <td style="text-align:right">
              <span class="csst-chev ${expanded ? "is-open" : ""}">
                <svg class="csst-ico" width="16" height="16" viewBox="0 0 24 24"><path d="M6 9 L12 15 L18 9"></path></svg>
              </span>
            </td>
          </tr>
          <tr ${expanded ? "" : "hidden"}>
            <td colspan="6">
              <div class="csst-detail-grid">
                <div><b>${Number(row.jitterMs || 0).toFixed(1)} ms</b>Jitter</div>
                <div><b>${Number(row.packetLossPct || 0).toFixed(1)}%</b>Packet loss</div>
                <div><b>${Number(row.latencyP50Ms || 0).toFixed(1)} ms</b>P50</div>
                <div><b>${Number(row.latencyP95Ms || 0).toFixed(1)} ms</b>P95</div>
                <div><b>${escapeHtml(row.pingSamples || "-")}</b>Ping samples</div>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    historyBodyEl.innerHTML = rows;
    renderWindowComparisons();
  }

  function toggleHistoryRow(id) {
    if (expandedHistoryIds.has(id)) {
      expandedHistoryIds.delete(id);
    } else {
      expandedHistoryIds.add(id);
    }
    renderHistory(historyRecords);
  }

  function handleHistorySort(key) {
    historySortAsc = historySortKey === key ? !historySortAsc : true;
    historySortKey = key;
    renderHistory(historyRecords);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const LIVE_STATS_INTERVAL_MS = 2000;
  const LIVE_STATS_MAX_SAMPLES = 60;
  const liveCpuSamples = [];
  const liveRamSamples = [];
  let liveStatsTimerId = null;
  let liveStatsInFlight = false;

  function drawSparkline(canvas, samples) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const values = samples.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (values.length < 2) {
      return;
    }

    const accentStyle = getComputedStyle(canvas).getPropertyValue("--csst-color-accent").trim() || "#ec3013";
    const stepX = width / (LIVE_STATS_MAX_SAMPLES - 1);
    const startIndex = LIVE_STATS_MAX_SAMPLES - samples.length;

    ctx.beginPath();
    let started = false;
    samples.forEach((value, index) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return;
      }
      const x = (startIndex + index) * stepX;
      const y = height - (Math.min(100, Math.max(0, value)) / 100) * height;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = accentStyle;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  function pushSample(samples, value) {
    samples.push(value);
    while (samples.length > LIVE_STATS_MAX_SAMPLES) {
      samples.shift();
    }
  }

  async function pollLiveStats() {
    if (liveStatsInFlight) {
      return;
    }
    liveStatsInFlight = true;

    try {
      const response = await postForm("csst_live_stats", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Live stats failed");
      }

      const cpuPercent = data.data?.cpuPercent;
      const memoryPercent = data.data?.memoryPercent;

      pushSample(liveCpuSamples, typeof cpuPercent === "number" ? cpuPercent : null);
      pushSample(liveRamSamples, typeof memoryPercent === "number" ? memoryPercent : null);

      liveCpuValueEl.textContent = typeof cpuPercent === "number" ? `${cpuPercent}%` : "n/a";
      liveRamValueEl.textContent = typeof memoryPercent === "number" ? `${memoryPercent}%` : "n/a";

      drawSparkline(liveCpuChartEl, liveCpuSamples);
      drawSparkline(liveRamChartEl, liveRamSamples);
    } catch (error) {
      liveCpuValueEl.textContent = "error";
      liveRamValueEl.textContent = "error";
    } finally {
      liveStatsInFlight = false;
    }
  }

  function startLiveStats() {
    if (liveStatsTimerId !== null) {
      return;
    }
    pollLiveStats();
    liveStatsTimerId = window.setInterval(pollLiveStats, LIVE_STATS_INTERVAL_MS);
  }

  function stopLiveStats() {
    if (liveStatsTimerId !== null) {
      window.clearInterval(liveStatsTimerId);
      liveStatsTimerId = null;
    }
  }

  function renderProcesses(processes) {
    if (!Array.isArray(processes) || processes.length === 0) {
      processesBodyEl.innerHTML = "<tr><td colspan=\"6\">No process data available.</td></tr>";
      return;
    }

    const rows = processes
      .map((row) => {
        return `
          <tr>
            <td>${escapeHtml(row.pid)}</td>
            <td>${escapeHtml(row.user)}</td>
            <td>${escapeHtml(row.cpuPct)}</td>
            <td>${escapeHtml(row.memPct)}</td>
            <td>${escapeHtml(row.elapsed)}</td>
            <td>${escapeHtml(row.command)}</td>
          </tr>
        `;
      })
      .join("");

    processesBodyEl.innerHTML = rows;
  }

  async function loadProcesses() {
    refreshProcessesButton.disabled = true;
    processesStatusEl.textContent = "Loading process list...";

    try {
      const response = await postForm("csst_process_list", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Unable to load process list");
      }

      const payload = data.data || {};
      if (!payload.available) {
        processesStatusEl.textContent = payload.message || "Process list not available on this host.";
        renderProcesses([]);
        return;
      }

      const generatedAt = payload.generatedAt ? ` (${payload.generatedAt})` : "";
      processesStatusEl.textContent = `Process list loaded${generatedAt}.`;
      renderProcesses(payload.processes || []);
    } catch (error) {
      processesStatusEl.textContent = `Process list error: ${error.message || "Unknown error"}`;
      renderProcesses([]);
    } finally {
      refreshProcessesButton.disabled = false;
    }
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "n/a";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  function renderPluginLoadHistory(records) {
    const rows = Array.isArray(records) ? records : [];
    pluginLoadStatusEl.textContent = rows.length === 0
      ? "No diagnostics runs recorded yet."
      : `${rows.length} diagnostics run(s) recorded.`;

    if (rows.length === 0) {
      pluginLoadBodyEl.innerHTML = "<tr><td colspan=\"8\">No diagnostics runs recorded yet.</td></tr>";
      return;
    }

    const html = rows
      .map((row) => {
        const queryCount = row.queryCount === null || row.queryCount === undefined ? "n/a" : String(row.queryCount);
        const queryTotalMs = row.queryTotalMs === null || row.queryTotalMs === undefined
          ? "n/a"
          : `${Number(row.queryTotalMs).toFixed(2)} ms`;
        return `
          <tr>
            <td>${escapeHtml(formatDate(String(row.timestamp || "")))}</td>
            <td>${escapeHtml(row.activePluginCount)}</td>
            <td>${escapeHtml(queryCount)}</td>
            <td>${escapeHtml(queryTotalMs)}</td>
            <td>${escapeHtml(formatBytes(row.peakMemoryBytes))}</td>
            <td>${Number(row.dbQueryMs || 0).toFixed(2)} ms</td>
            <td>${Number(row.phpBenchmarkMs || 0).toFixed(2)} ms</td>
            <td>${escapeHtml(row.overallRating || "n/a")}</td>
          </tr>
        `;
      })
      .join("");

    pluginLoadBodyEl.innerHTML = html;
  }

  async function loadPluginLoadHistory() {
    const response = await postForm("csst_diagnostics_history_list", {});
    const data = await response.json();
    if (!data.success) {
      throw new Error(data?.data?.message || "Unable to load plugin load history");
    }
    renderPluginLoadHistory(data?.data?.history || []);
  }

  function activateTab(targetId) {
    tabViews.forEach((view) => {
      const isTarget = view.id === targetId;
      view.classList.toggle("csst-hidden", !isTarget);
      view.setAttribute("aria-hidden", isTarget ? "false" : "true");
    });

    tabButtons.forEach((button) => {
      const isTarget = button.getAttribute("data-target") === targetId;
      button.classList.toggle("is-active", isTarget);
      button.setAttribute("aria-selected", isTarget ? "true" : "false");
    });

    if (targetId === "csst-view-processes") {
      loadProcesses();
    }
  }

  function getPercentile(samples, percentile) {
    if (!samples.length) {
      return 0;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    const boundedIndex = Math.max(0, Math.min(index, sorted.length - 1));
    return sorted[boundedIndex];
  }

  function toTimestamp(row) {
    if (!row || !row.timestamp) {
      return 0;
    }
    const parsed = new Date(String(row.timestamp).replace(" ", "T")).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function summarizeWindow(records) {
    if (records.length === 0) {
      return "No tests";
    }

    const aggregate = records.reduce(
      (acc, row) => {
        acc.latency += Number(row.latencyMs || 0);
        acc.jitter += Number(row.jitterMs || 0);
        acc.download += Number(row.downloadMbps || 0);
        acc.upload += Number(row.uploadMbps || 0);
        acc.loss += Number(row.packetLossPct || 0);
        return acc;
      },
      { latency: 0, jitter: 0, download: 0, upload: 0, loss: 0 }
    );

    const count = records.length;
    return [
      `Tests: ${count}`,
      `Avg latency: ${(aggregate.latency / count).toFixed(1)} ms`,
      `Avg jitter: ${(aggregate.jitter / count).toFixed(1)} ms`,
      `Avg packet loss: ${(aggregate.loss / count).toFixed(1)}%`,
      `Avg download: ${(aggregate.download / count).toFixed(2)} Mbps`,
      `Avg upload: ${(aggregate.upload / count).toFixed(2)} Mbps`,
    ].join("\n");
  }

  function renderWindowComparisons() {
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;
    const oneDayMs = 24 * oneHourMs;
    const sevenDayMs = 7 * oneDayMs;

    const within1h = historyRecords.filter((row) => now - toTimestamp(row) <= oneHourMs);
    const within24h = historyRecords.filter((row) => now - toTimestamp(row) <= oneDayMs);
    const within7d = historyRecords.filter((row) => now - toTimestamp(row) <= sevenDayMs);

    window1hEl.textContent = summarizeWindow(within1h);
    window24hEl.textContent = summarizeWindow(within24h);
    window7dEl.textContent = summarizeWindow(within7d);
  }

  async function loadHistory() {
    const response = await postForm("csst_history_list", {});
    const data = await response.json();
    if (!data.success) {
      throw new Error(data?.data?.message || "Unable to load history");
    }
    renderHistory(data?.data?.history || []);
  }

  async function saveHistory(record) {
    const response = await postForm("csst_history_add", {
      latencyMs: String(record.latencyMs),
      jitterMs: String(record.jitterMs),
      packetLossPct: String(record.packetLossPct),
      latencyP50Ms: String(record.latencyP50Ms),
      latencyP95Ms: String(record.latencyP95Ms),
      downloadMbps: String(record.downloadMbps),
      uploadMbps: String(record.uploadMbps),
      qualityGrade: record.qualityGrade,
      pingSamples: record.pingSamples,
      clientInfo: record.clientInfo,
    });

    const data = await response.json();
    if (!data.success) {
      throw new Error(data?.data?.message || "Unable to save history");
    }

    renderHistory(data?.data?.history || []);
  }

  function getClientInfo() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection) {
      return "n/a";
    }

    const fields = [];
    if (connection.effectiveType) {
      fields.push(`effectiveType=${connection.effectiveType}`);
    }
    if (typeof connection.downlink === "number") {
      fields.push(`downlink=${connection.downlink}`);
    }
    if (typeof connection.rtt === "number") {
      fields.push(`rtt=${connection.rtt}`);
    }

    return fields.length > 0 ? fields.join(",") : "n/a";
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function exportHistoryAsCsv() {
    if (historyRecords.length === 0) {
      return;
    }

    const header = [
      "DateTime",
      "LatencyMs",
      "JitterMs",
      "PacketLossPct",
      "LatencyP50Ms",
      "LatencyP95Ms",
      "DownloadMbps",
      "UploadMbps",
      "Quality",
      "PingSamples",
    ];
    const lines = [header.join(",")];

    historyRecords.forEach((row) => {
      lines.push(
        [
          csvEscape(row.timestamp || ""),
          csvEscape(row.latencyMs || ""),
          csvEscape(row.jitterMs || ""),
          csvEscape(row.packetLossPct || ""),
          csvEscape(row.latencyP50Ms || ""),
          csvEscape(row.latencyP95Ms || ""),
          csvEscape(row.downloadMbps || ""),
          csvEscape(row.uploadMbps || ""),
          csvEscape(row.qualityGrade || ""),
          csvEscape(row.pingSamples || ""),
        ].join(",")
      );
    });

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `csst-history-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function runDiagnostics() {
    diagnosticsButton.disabled = true;
    diagnosticsStatusEl.textContent = "Running diagnostics...";

    try {
      const response = await postForm("csst_server_diagnostics", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Diagnostics failed");
      }

      diagnosticsStatusEl.textContent = formatDiagnosticsStatus(data.data);
      diagnosticsOutputEl.textContent = formatDiagnosticsOutput(data.data);
      renderBanner(data.data);
      renderSpecs(data.data);
      renderMetricsGrid(data.data);
      renderDuplicatorBackup(data.data);
      renderPluginLoadHistory(data.data?.pluginLoadHistory || []);
    } catch (error) {
      diagnosticsStatusEl.textContent = `Diagnostics error: ${error.message || "Unknown error"}`;
    } finally {
      diagnosticsButton.disabled = false;
    }
  }

  function downloadKeepAliveScript() {
    const url = `${config.ajaxUrl}?action=csst_download_keep_alive_script&nonce=${encodeURIComponent(config.nonce || "")}`;
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function applyApiKeyResult(data) {
    const hasKey = Boolean(data?.apiKey);
    apiKeyInputEl.value = data?.apiKey || "";
    revokeApiKeyButton.disabled = !hasKey;
    generateApiKeyButton.textContent = hasKey ? "Regenerate Key" : "Generate Key";
    apiKeyStatusEl.textContent = hasKey
      ? "Key generated. Copy it into Controll Server Monitor's setup screen now — it won't be shown in full again after you leave this page."
      : "No API key configured. Remote monitoring requests will be rejected until one is generated.";
  }

  async function handleGenerateApiKey() {
    generateApiKeyButton.disabled = true;
    try {
      const response = await postForm("csst_generate_api_key", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Unable to generate API key");
      }
      applyApiKeyResult(data.data);
    } catch (error) {
      apiKeyStatusEl.textContent = `Error: ${error.message || "Unknown error"}`;
    } finally {
      generateApiKeyButton.disabled = false;
    }
  }

  async function handleRevokeApiKey() {
    revokeApiKeyButton.disabled = true;
    try {
      const response = await postForm("csst_revoke_api_key", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Unable to revoke API key");
      }
      applyApiKeyResult(data.data);
    } catch (error) {
      apiKeyStatusEl.textContent = `Error: ${error.message || "Unknown error"}`;
    }
  }

  async function handleSaveCpanel() {
    saveCpanelButton.disabled = true;
    cpanelStatusEl.textContent = "Saving...";
    try {
      const response = await postForm("csst_save_cpanel_settings", {
        cpanel_username: cpanelUsernameInput.value.trim(),
        cpanel_api_token: cpanelTokenInput.value.trim(),
        cpanel_host: cpanelHostInput.value.trim(),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Unable to save cPanel settings");
      }
      cpanelTokenInput.value = "";
      cpanelTokenInput.placeholder = data.data?.hasToken
        ? "Saved — leave blank to keep it"
        : "Paste token from cPanel > Manage API Tokens";
      clearCpanelButton.disabled = !(data.data?.username && data.data?.host && data.data?.hasToken);
      cpanelStatusEl.textContent = "Saved. Click Test Connection to verify, or re-run diagnostics to see it applied.";
    } catch (error) {
      cpanelStatusEl.textContent = `Error: ${error.message || "Unknown error"}`;
    } finally {
      saveCpanelButton.disabled = false;
    }
  }

  async function handleTestCpanel() {
    testCpanelButton.disabled = true;
    cpanelStatusEl.textContent = "Testing...";
    try {
      const response = await postForm("csst_test_cpanel_quota", {
        cpanel_username: cpanelUsernameInput.value.trim(),
        cpanel_api_token: cpanelTokenInput.value.trim(),
        cpanel_host: cpanelHostInput.value.trim(),
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Connection test failed");
      }
      cpanelStatusEl.textContent = data.data?.unlimited
        ? "Connected, but cPanel reports an unlimited quota — nothing to calculate a percentage against."
        : `Connected. ${formatBytes(data.data?.usedBytes)} used of ${formatBytes(data.data?.totalBytes)} (${data.data?.usedPercent}%).`;
    } catch (error) {
      cpanelStatusEl.textContent = `Failed: ${error.message || "Unknown error"}`;
    } finally {
      testCpanelButton.disabled = false;
    }
  }

  async function handleClearCpanel() {
    if (!window.confirm("Disconnect cPanel quota lookup? Disk Space will go back to reporting total server filesystem.")) {
      return;
    }
    clearCpanelButton.disabled = true;
    try {
      const response = await postForm("csst_clear_cpanel_settings", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Unable to disconnect");
      }
      cpanelUsernameInput.value = "";
      cpanelHostInput.value = "";
      cpanelTokenInput.value = "";
      cpanelTokenInput.placeholder = "Paste token from cPanel > Manage API Tokens";
      cpanelStatusEl.textContent = "Disconnected — Disk Space currently reports total server filesystem.";
    } catch (error) {
      cpanelStatusEl.textContent = `Error: ${error.message || "Unknown error"}`;
    } finally {
      clearCpanelButton.disabled = false;
    }
  }

  async function handleRefreshCpanelShell() {
    const textEl = document.getElementById("csst-cpanel-shell-status-text");
    refreshCpanelShellButton.disabled = true;
    if (textEl) {
      textEl.textContent = "Checking…";
    }

    try {
      const response = await postForm("csst_refresh_cpanel_shell_quota", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Auto-detection failed");
      }
      const d = data.data || {};
      if (cpanelShellStatusEl) {
        cpanelShellStatusEl.style.background = "var(--csst-tier-good-bg)";
      }
      if (textEl) {
        textEl.textContent = d.unlimited
          ? "Auto-detected, but this account has an unlimited quota — nothing to calculate a percentage against."
          : `Auto-detected via local system access — no configuration needed. ${formatBytes(d.usedBytes)} used of ${formatBytes(d.totalBytes)} (${d.usedPercent}%). Last checked just now.`;
      }
    } catch (error) {
      if (cpanelShellStatusEl) {
        cpanelShellStatusEl.style.background = "var(--csst-tier-warn-bg)";
      }
      if (textEl) {
        textEl.textContent = `Not auto-detected on this host: ${error.message || "Unknown error"} Configure manually below as a fallback.`;
      }
    } finally {
      refreshCpanelShellButton.disabled = false;
    }
  }

  function handleCopyClick(event) {
    const button = event.target.closest(".csst-copy-btn");
    if (!button) {
      return;
    }
    const targetId = button.getAttribute("data-copy-target");
    const input = document.getElementById(targetId);
    if (!input || !input.value) {
      return;
    }
    navigator.clipboard.writeText(input.value).then(() => {
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1500);
    });
  }

  function handleToggleVisibilityClick(event) {
    const button = event.target.closest(".csst-toggle-visibility-btn");
    if (!button) {
      return;
    }
    const targetId = button.getAttribute("data-target");
    const input = document.getElementById(targetId);
    if (!input) {
      return;
    }
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    button.textContent = isHidden ? "Hide" : "Show";
  }

  async function postForm(action, extraFields) {
    const formData = new FormData();
    formData.append("action", action);
    formData.append("nonce", config.nonce || "");

    Object.entries(extraFields || {}).forEach(([key, value]) => {
      formData.append(key, value);
    });

    const response = await fetch(config.ajaxUrl, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;
  }

  async function pingOnce() {
    const start = performance.now();
    const response = await postForm("csst_ping", {});
    const data = await response.json();
    if (!data.success) {
      throw new Error(data?.data?.message || "Ping failed");
    }

    return performance.now() - start;
  }

  function calculateJitter(samples) {
    if (samples.length <= 1) {
      return 0;
    }

    const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / samples.length;

    return Math.sqrt(variance);
  }

  async function runLatencyTest(pingCount) {
    const samples = [];
    let lost = 0;

    for (let i = 0; i < pingCount; i += 1) {
      if (stopped) {
        throw new Error("Stopped");
      }

      try {
        const result = await pingOnce();
        samples.push(result);
      } catch (error) {
        lost += 1;
      }

      setStatus(`Latency test ${i + 1}/${pingCount}`);
    }

    if (samples.length === 0) {
      throw new Error("All latency pings failed");
    }

    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const jitter = calculateJitter(samples);
    const packetLossPct = (lost / pingCount) * 100;
    const p50 = getPercentile(samples, 50);
    const p95 = getPercentile(samples, 95);

    return {
      average,
      jitter,
      packetLossPct,
      p50,
      p95,
      lost,
      sent: pingCount,
      samples,
    };
  }

  function rateMetric(value, thresholds) {
    if (value <= thresholds.good) {
      return { score: 1, label: "good" };
    }
    if (value <= thresholds.watch) {
      return { score: 2, label: "watch" };
    }
    return { score: 3, label: "needs-attention" };
  }

  function rateMetricDescending(value, thresholds) {
    if (value >= thresholds.good) {
      return { score: 1, label: "good" };
    }
    if (value >= thresholds.watch) {
      return { score: 2, label: "watch" };
    }
    return { score: 3, label: "needs-attention" };
  }

  function computeConnectionRatings(metrics) {
    const latency = rateMetric(metrics.latencyMs, { good: 80, watch: 160 });
    const jitter = rateMetric(metrics.jitterMs, { good: 15, watch: 35 });
    const loss = rateMetric(metrics.packetLossPct, { good: 1, watch: 3 });
    const download = rateMetricDescending(metrics.downloadMbps, { good: 60, watch: 20 });
    const upload = rateMetricDescending(metrics.uploadMbps, { good: 20, watch: 8 });

    const overallScore = Math.max(
      latency.score,
      jitter.score,
      loss.score,
      download.score,
      upload.score
    );
    const overallLabel = overallScore === 1 ? "good" : overallScore === 2 ? "watch" : "needs-attention";

    return {
      overallLabel,
      details: {
        latency: latency.label,
        jitter: jitter.label,
        packetLoss: loss.label,
        download: download.label,
        upload: upload.label,
      },
    };
  }

  function formatDiagnosticsStatus(diagnostics) {
    const interpretation = diagnostics?.interpretation;
    const overall = interpretation?.overall;
    if (!overall || !overall.rating) {
      return "Diagnostics completed.";
    }
    return `Diagnostics completed. Overall server rating: ${overall.rating}.`;
  }

  function formatDiskMonitorLine(diskMonitor) {
    if (!diskMonitor || !diskMonitor.checkedAt) {
      return "Automated hourly disk monitoring is enabled; first check has not run yet.";
    }
    const percent = diskMonitor.usedPercent !== null && diskMonitor.usedPercent !== undefined
      ? `${diskMonitor.usedPercent}%`
      : "n/a";
    if (diskMonitor.alertActive) {
      return `ALERT ACTIVE — last checked ${diskMonitor.checkedAt} at ${percent} used. Emailed ${diskMonitor.alertCount} time(s), last at ${diskMonitor.lastAlertAt || "n/a"}.`;
    }
    return `Last checked ${diskMonitor.checkedAt} at ${percent} used. No alert active.`;
  }

  function formatDiagnosticsOutput(diagnostics) {
    const { interpretation: _omit, ...rawMetrics } = diagnostics || {};
    return JSON.stringify(rawMetrics, null, 2);
  }

  async function runDownloadWorker(endTime, chunkBytes) {
    let totalBytes = 0;

    while (performance.now() < endTime && !stopped) {
      const response = await postForm("csst_download", {
        size: String(chunkBytes),
        seed: String(Math.random()),
      });

      const buffer = await response.arrayBuffer();
      totalBytes += buffer.byteLength;
    }

    return totalBytes;
  }

  async function runDownloadTest(durationSec, parallel, chunkBytes) {
    const endTime = performance.now() + durationSec * 1000;
    const start = performance.now();

    const workers = Array.from({ length: parallel }, () =>
      runDownloadWorker(endTime, chunkBytes)
    );

    const byteResults = await Promise.all(workers);
    const totalBytes = byteResults.reduce((sum, value) => sum + value, 0);
    const elapsed = performance.now() - start;

    return {
      totalBytes,
      elapsed,
    };
  }

  function createPayloadBlob(size) {
    const bytes = new Uint8Array(size);

    // Web Crypto limits each call to 65536 bytes.
    const maxChunk = 65536;
    for (let offset = 0; offset < bytes.length; offset += maxChunk) {
      const chunk = bytes.subarray(offset, Math.min(offset + maxChunk, bytes.length));
      crypto.getRandomValues(chunk);
    }

    return new Blob([bytes], { type: "application/octet-stream" });
  }

  async function uploadOnce(payloadBlob) {
    const response = await postForm("csst_upload", {
      payload: payloadBlob,
      seed: String(Math.random()),
    });

    const data = await response.json();
    if (!data.success) {
      throw new Error(data?.data?.message || "Upload failed");
    }

    return Number(data?.data?.bytesReceived || payloadBlob.size);
  }

  async function runUploadTest(durationSec, chunkBytes) {
    const payloadBlob = createPayloadBlob(chunkBytes);
    const start = performance.now();
    const endTime = start + durationSec * 1000;
    let totalBytes = 0;

    while (performance.now() < endTime && !stopped) {
      const bytes = await uploadOnce(payloadBlob);
      totalBytes += bytes;
    }

    const elapsed = performance.now() - start;

    return {
      totalBytes,
      elapsed,
    };
  }

  function setRunningState(running) {
    startButton.disabled = running;
    stopButton.disabled = !running;
  }

  async function runAllTests() {
    stopped = false;
    setRunningState(true);
    resetResults();

    try {
      setStatus("Running latency test...");
      const latencyResult = await runLatencyTest(defaults.pingCount || 8);
      latencyEl.textContent = formatMs(latencyResult.average);
      jitterEl.textContent = formatMs(latencyResult.jitter);

      if (stopped) {
        throw new Error("Stopped");
      }

      setStatus("Running download test...");
      const downloadResult = await runDownloadTest(
        defaults.downloadDurationSec || 8,
        defaults.downloadParallel || 3,
        defaults.downloadChunkBytes || 1000000
      );
      downloadEl.textContent = formatMbps(downloadResult.totalBytes, downloadResult.elapsed);

      if (stopped) {
        throw new Error("Stopped");
      }

      setStatus("Running upload test...");
      const uploadResult = await runUploadTest(
        defaults.uploadDurationSec || 8,
        defaults.uploadChunkBytes || 1000000
      );
      uploadEl.textContent = formatMbps(uploadResult.totalBytes, uploadResult.elapsed);

      const latencyMs = Number(latencyResult.average.toFixed(1));
      const jitterMs = Number(latencyResult.jitter.toFixed(1));
      const packetLossPct = Number(latencyResult.packetLossPct.toFixed(1));
      const latencyP50Ms = Number(latencyResult.p50.toFixed(1));
      const latencyP95Ms = Number(latencyResult.p95.toFixed(1));
      const downloadMbps = Number(
        bytesElapsedToMbps(downloadResult.totalBytes, downloadResult.elapsed).toFixed(2)
      );
      const uploadMbps = Number(
        bytesElapsedToMbps(uploadResult.totalBytes, uploadResult.elapsed).toFixed(2)
      );
      const ratings = computeConnectionRatings({
        latencyMs,
        jitterMs,
        packetLossPct,
        downloadMbps,
        uploadMbps,
      });

      await saveHistory({
        latencyMs,
        jitterMs,
        packetLossPct,
        latencyP50Ms,
        latencyP95Ms,
        downloadMbps,
        uploadMbps,
        qualityGrade: ratings.overallLabel,
        pingSamples: latencyResult.samples.map((v) => v.toFixed(1)).join("|"),
        clientInfo: getClientInfo(),
      });

      const summary = [
        `Latency: ${latencyEl.textContent}`,
        `Jitter: ${jitterEl.textContent}`,
        `Packet Loss: ${packetLossPct.toFixed(1)}%`,
        `P50: ${latencyP50Ms.toFixed(1)} ms`,
        `P95: ${latencyP95Ms.toFixed(1)} ms`,
        `Download: ${downloadEl.textContent}`,
        `Upload: ${uploadEl.textContent}`,
        `Overall: ${ratings.overallLabel}`,
        `Ratings: latency=${ratings.details.latency}, jitter=${ratings.details.jitter}, loss=${ratings.details.packetLoss}, download=${ratings.details.download}, upload=${ratings.details.upload}`,
      ].join("\n");

      summaryEl.textContent = summary;
      summaryEl.hidden = false;

      setStatus("Completed.");
    } catch (error) {
      if (String(error && error.message) === "Stopped") {
        setStatus("Stopped.");
      } else {
        setStatus(`Error: ${error.message || "Unknown error"}`);
      }
    } finally {
      setRunningState(false);
    }
  }

  startButton.addEventListener("click", runAllTests);
  stopButton.addEventListener("click", function () {
    stopped = true;
  });
  exportCsvButton.addEventListener("click", exportHistoryAsCsv);
  diagnosticsButton.addEventListener("click", runDiagnostics);
  refreshProcessesButton.addEventListener("click", loadProcesses);
  downloadKeepAliveButton.addEventListener("click", downloadKeepAliveScript);
  generateApiKeyButton.addEventListener("click", handleGenerateApiKey);
  revokeApiKeyButton.addEventListener("click", handleRevokeApiKey);
  saveCpanelButton.addEventListener("click", handleSaveCpanel);
  testCpanelButton.addEventListener("click", handleTestCpanel);
  clearCpanelButton.addEventListener("click", handleClearCpanel);
  if (refreshCpanelShellButton) {
    refreshCpanelShellButton.addEventListener("click", handleRefreshCpanelShell);
  }
  document.addEventListener("click", handleCopyClick);
  document.addEventListener("click", handleToggleVisibilityClick);
  tabButtons.forEach((button) => {
    button.addEventListener("click", function () {
      const targetId = button.getAttribute("data-target");
      if (targetId) {
        activateTab(targetId);
      }
    });
  });

  historyTableEl.querySelector("thead").addEventListener("click", function (event) {
    const th = event.target.closest("th[data-sort]");
    if (th) {
      handleHistorySort(th.getAttribute("data-sort"));
    }
  });

  historyBodyEl.addEventListener("click", function (event) {
    const row = event.target.closest("tr.csst-history-row");
    if (row) {
      toggleHistoryRow(row.getAttribute("data-row-id"));
    }
  });

  loadHistory().catch((error) => {
    setStatus(`History error: ${error.message || "Unable to load history"}`);
  });

  loadPluginLoadHistory().catch((error) => {
    pluginLoadStatusEl.textContent = `Plugin load history error: ${error.message || "Unable to load history"}`;
  });

  runDiagnostics().catch(() => {
    /* runDiagnostics reports its own errors via diagnosticsStatusEl */
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopLiveStats();
    } else {
      startLiveStats();
    }
  });
  window.addEventListener("pagehide", stopLiveStats);

  if (!document.hidden) {
    startLiveStats();
  }
})();
