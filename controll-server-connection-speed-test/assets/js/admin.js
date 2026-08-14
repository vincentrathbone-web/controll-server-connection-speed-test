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

  let stopped = false;
  let historyRecords = [];

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
    return date.toLocaleString();
  }

  function renderHistory(records) {
    historyRecords = Array.isArray(records) ? records : [];
    exportCsvButton.disabled = historyRecords.length === 0;

    if (historyRecords.length === 0) {
      historyBodyEl.innerHTML = "<tr><td colspan=\"10\">No tests yet.</td></tr>";
      renderWindowComparisons();
      return;
    }

    const rows = historyRecords
      .map((row) => {
        return `
          <tr>
            <td>${formatDate(String(row.timestamp || ""))}</td>
            <td>${Number(row.latencyMs || 0).toFixed(1)} ms</td>
            <td>${Number(row.jitterMs || 0).toFixed(1)} ms</td>
            <td>${Number(row.packetLossPct || 0).toFixed(1)}%</td>
            <td>${Number(row.latencyP50Ms || 0).toFixed(1)} ms</td>
            <td>${Number(row.latencyP95Ms || 0).toFixed(1)} ms</td>
            <td>${Number(row.downloadMbps || 0).toFixed(2)} Mbps</td>
            <td>${Number(row.uploadMbps || 0).toFixed(2)} Mbps</td>
            <td>${String(row.qualityGrade || "n/a")}</td>
            <td>${String(row.pingSamples || "-")}</td>
          </tr>
        `;
      })
      .join("");

    historyBodyEl.innerHTML = rows;
    renderWindowComparisons();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
    diagnosticsOutputEl.hidden = true;

    try {
      const response = await postForm("csst_server_diagnostics", {});
      const data = await response.json();
      if (!data.success) {
        throw new Error(data?.data?.message || "Diagnostics failed");
      }

      diagnosticsStatusEl.textContent = formatDiagnosticsStatus(data.data);
      diagnosticsOutputEl.textContent = formatDiagnosticsOutput(data.data);
      diagnosticsOutputEl.hidden = false;
    } catch (error) {
      diagnosticsStatusEl.textContent = `Diagnostics error: ${error.message || "Unknown error"}`;
    } finally {
      diagnosticsButton.disabled = false;
    }
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

  function formatDiagnosticsOutput(diagnostics) {
    const interpretation = diagnostics?.interpretation || {};
    const lines = [
      `Overall: ${interpretation?.overall?.rating || "n/a"}`,
      `${interpretation?.overall?.summary || "No interpretation available."}`,
      "",
      `Database: ${interpretation?.database?.rating || "n/a"}`,
      `${interpretation?.database?.summary || ""}`,
      `PHP Benchmark: ${interpretation?.phpBenchmark?.rating || "n/a"}`,
      `${interpretation?.phpBenchmark?.summary || ""}`,
      `Load: ${interpretation?.load?.rating || "n/a"}`,
      `${interpretation?.load?.summary || ""}`,
      `Memory: ${interpretation?.memory?.rating || "n/a"}`,
      `${interpretation?.memory?.summary || ""}`,
      "",
      "Raw Metrics:",
      JSON.stringify(diagnostics, null, 2),
    ];

    return lines.join("\n");
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
  tabButtons.forEach((button) => {
    button.addEventListener("click", function () {
      const targetId = button.getAttribute("data-target");
      if (targetId) {
        activateTab(targetId);
      }
    });
  });

  loadHistory().catch((error) => {
    setStatus(`History error: ${error.message || "Unable to load history"}`);
  });
})();
