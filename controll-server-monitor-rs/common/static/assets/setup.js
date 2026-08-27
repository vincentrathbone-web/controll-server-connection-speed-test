(function () {
  "use strict";

  const form = document.getElementById("csm-site-form");
  const formIdInput = document.getElementById("csm-form-id");
  const labelInput = document.getElementById("csm-label");
  const endpointInput = document.getElementById("csm-endpoint");
  const apiKeyInput = document.getElementById("csm-apikey");
  const keepAliveUrlInput = document.getElementById("csm-keepalive-url");
  const formTitle = document.getElementById("csm-form-title");
  const submitButton = document.getElementById("csm-submit-btn");
  const cancelButton = document.getElementById("csm-cancel-btn");
  const testButton = document.getElementById("csm-test-btn");
  const testResultEl = document.getElementById("csm-test-result");
  const noticeEl = document.getElementById("csm-notice");
  const errorEl = document.getElementById("csm-error");
  const sitesTable = document.getElementById("csm-sites-table");
  const sitesBody = document.getElementById("csm-sites-body");
  const emptyEl = document.getElementById("csm-empty");
  const sitesHeading = document.getElementById("csm-sites-heading");
  const exportButton = document.getElementById("csm-export-btn");
  const importButton = document.getElementById("csm-import-btn");
  const importFileInput = document.getElementById("csm-import-file");

  if (!form) {
    return;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function showNotice(message) {
    noticeEl.textContent = message;
    noticeEl.hidden = false;
    errorEl.hidden = true;
    window.setTimeout(() => { noticeEl.hidden = true; }, 4000);
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    noticeEl.hidden = true;
  }

  function resetForm() {
    form.reset();
    formIdInput.value = "";
    formTitle.textContent = "Add a Site";
    submitButton.textContent = "Add Site";
    cancelButton.hidden = true;
    testResultEl.textContent = "";
  }

  function enterEditMode(site) {
    formIdInput.value = site.id;
    labelInput.value = site.label;
    endpointInput.value = site.endpoint_url;
    apiKeyInput.value = site.api_key;
    keepAliveUrlInput.value = site.keep_alive_url || "";
    formTitle.textContent = `Edit ${site.label}`;
    submitButton.textContent = "Save Changes";
    cancelButton.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function fetchKeepAliveStatuses() {
    try {
      const response = await apiFetch("/api/keepalive/status", { cache: "no-store" });
      const data = await response.json();
      const map = {};
      (Array.isArray(data.statuses) ? data.statuses : []).forEach((s) => {
        map[s.siteId] = s;
      });
      return map;
    } catch (error) {
      return {};
    }
  }

  // "OK"/"FAIL" alone only says whether the request succeeded, not what the
  // server actually said — show the real HTTP status (or the connection
  // error when there wasn't one) alongside it.
  function formatPingDetail(status) {
    if (typeof status.httpCode === "number" && status.httpCode > 0) {
      return `HTTP ${status.httpCode}`;
    }
    return status.error || "no response";
  }

  function renderRow(site, keepAliveStatus) {
    const tr = document.createElement("tr");

    let keepAliveCell = '<span class="csm-poll-status">Not pinged yet</span>';
    if (keepAliveStatus) {
      const cls = keepAliveStatus.ok ? "csm-tier-good" : "csm-tier-needs-attention";
      keepAliveCell = `<span class="csm-tier ${cls}">${keepAliveStatus.ok ? "OK" : "FAIL"}</span> <span class="csm-poll-status">${escapeHtml(formatPingDetail(keepAliveStatus))} — ${escapeHtml(formatLocalTime(keepAliveStatus.lastPingAt))}</span>`;
    }

    tr.innerHTML = `
      <td>${escapeHtml(site.label)}</td>
      <td style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(site.endpoint_url)}</td>
      <td>${keepAliveCell}</td>
      <td>${escapeHtml(formatLocalTime(site.created_at))}</td>
      <td style="text-align:right;white-space:nowrap">
        <span class="csm-row-test-result" id="csm-row-test-result-${site.id}"></span>
        <button type="button" class="csm-btn csm-row-test-btn" data-id="${site.id}">Test Connection</button>
        <button type="button" class="csm-btn csm-row-edit-btn" data-id="${site.id}">Edit</button>
        <button type="button" class="csm-btn csm-btn-danger csm-row-delete-btn" data-id="${site.id}">Delete</button>
      </td>
    `;
    return tr;
  }

  let sitesCache = [];

  async function loadSites() {
    const [sitesResponse, keepAliveMap] = await Promise.all([
      apiFetch("/api/sites", { cache: "no-store" }),
      fetchKeepAliveStatuses(),
    ]);
    const data = await sitesResponse.json();
    sitesCache = Array.isArray(data.sites) ? data.sites : [];

    sitesHeading.textContent = `Sites (${sitesCache.length})`;

    if (sitesCache.length === 0) {
      emptyEl.hidden = false;
      sitesTable.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    sitesTable.hidden = false;
    sitesBody.innerHTML = "";
    sitesCache.forEach((site) => {
      sitesBody.appendChild(renderRow(site, keepAliveMap[site.id]));
    });

    wireRowButtons();
  }

  // Exports exactly what's needed to recreate every registered site — label,
  // endpoint URL, API key, keep-alive URL — as a backup to restore from after
  // reinstalling Windows or moving to a new PC, via Bulk Import below.
  // Only present inside the Tauri app window (injected via withGlobalTauri
  // in tauri.conf.json); absent when this same page is opened in a plain
  // browser tab against the service directly.
  function tauriApi() {
    const g = window.__TAURI__;
    if (g && g.core && g.dialog) {
      return g;
    }
    return null;
  }

  async function saveViaNativeDialog(tauri, fileName, jsonText) {
    const path = await tauri.dialog.save({
      defaultPath: fileName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) {
      return false; // user cancelled the dialog
    }
    await tauri.core.invoke("write_export_file", { path, contents: jsonText });
    return true;
  }

  function saveViaBrowserDownload(fileName, jsonText) {
    const blob = new Blob([jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleExport() {
    if (sitesCache.length === 0) {
      showError("No sites to export yet.");
      return;
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      sites: sitesCache.map((site) => ({
        label: site.label,
        endpoint_url: site.endpoint_url,
        api_key: site.api_key,
        keep_alive_url: site.keep_alive_url || null,
      })),
    };
    const jsonText = JSON.stringify(payload, null, 2);
    const fileName = `controll-server-monitor-sites-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

    const tauri = tauriApi();
    if (tauri) {
      try {
        const saved = await saveViaNativeDialog(tauri, fileName, jsonText);
        if (saved) {
          showNotice(`Exported ${sitesCache.length} site(s). Keep this file somewhere safe — it contains live API keys.`);
        }
      } catch (error) {
        showError(`Export failed: ${error.message || error}`);
      }
      return;
    }

    saveViaBrowserDownload(fileName, jsonText);
    showNotice(`Exported ${sitesCache.length} site(s). Keep this file somewhere safe — it contains live API keys.`);
  }

  function parseImportEntries(parsed) {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.sites)) {
      return parsed.sites;
    }
    return null;
  }

  async function handleImportFile(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      showError("That file isn't valid JSON.");
      return;
    }

    const entries = parseImportEntries(parsed);
    if (!entries) {
      showError('Expected a JSON file with a "sites" array — the format Export Sites (JSON) produces.');
      return;
    }

    importButton.disabled = true;
    importButton.textContent = "Importing...";

    // Re-importing the same backup twice (or a backup that overlaps with
    // sites added since) shouldn't create duplicates — skip anything whose
    // endpoint URL already matches a registered site.
    const existingUrls = new Set(sitesCache.map((site) => site.endpoint_url.trim().toLowerCase()));
    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of entries) {
      const label = String(entry.label || "").trim();
      const endpointUrl = String(entry.endpoint_url || entry.endpointUrl || "").trim();
      const apiKey = String(entry.api_key || entry.apiKey || "").trim();
      const keepAliveUrl = String(entry.keep_alive_url || entry.keepAliveUrl || "").trim() || null;

      if (!label || !endpointUrl || !apiKey) {
        failed++;
        continue;
      }
      if (existingUrls.has(endpointUrl.toLowerCase())) {
        skipped++;
        continue;
      }

      try {
        const response = await apiFetch("/api/sites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, endpoint_url: endpointUrl, api_key: apiKey, keep_alive_url: keepAliveUrl }),
        });
        if (response.ok) {
          added++;
          existingUrls.add(endpointUrl.toLowerCase());
        } else {
          failed++;
        }
      } catch (error) {
        failed++;
      }
    }

    importButton.disabled = false;
    importButton.textContent = "Bulk Import (JSON)";
    await loadSites();

    const parts = [`${added} added`];
    if (skipped > 0) parts.push(`${skipped} already existed`);
    if (failed > 0) parts.push(`${failed} failed`);
    showNotice(`Import complete: ${parts.join(", ")}.`);
  }

  function wireRowButtons() {
    sitesBody.querySelectorAll(".csm-row-test-btn").forEach((btn) => {
      btn.addEventListener("click", async function () {
        const id = btn.getAttribute("data-id");
        const resultEl = document.getElementById(`csm-row-test-result-${id}`);
        btn.disabled = true;
        if (resultEl) resultEl.textContent = "Testing...";

        try {
          const response = await apiFetch(`/api/probe?id=${encodeURIComponent(id)}`);
          const data = await response.json();
          if (data.ok) {
            const rating = data.data?.interpretation?.overall?.rating || "unknown";
            if (resultEl) resultEl.textContent = `Connected. Overall rating: ${rating}.`;
          } else {
            if (resultEl) resultEl.textContent = `Failed: ${data.error || "Unknown error"}`;
          }
        } catch (error) {
          if (resultEl) resultEl.textContent = `Failed: ${error.message || "Unknown error"}`;
        } finally {
          btn.disabled = false;
        }
      });
    });

    sitesBody.querySelectorAll(".csm-row-edit-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const id = Number(btn.getAttribute("data-id"));
        const site = sitesCache.find((s) => s.id === id);
        if (site) {
          enterEditMode(site);
        }
      });
    });

    sitesBody.querySelectorAll(".csm-row-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async function () {
        if (!window.confirm("Remove this site from monitoring?")) {
          return;
        }
        const id = btn.getAttribute("data-id");
        btn.disabled = true;
        try {
          const response = await apiFetch(`/api/sites/${encodeURIComponent(id)}`, { method: "DELETE" });
          const data = await response.json();
          if (data.ok) {
            showNotice("Site removed.");
            await loadSites();
          } else {
            showError(data.error || "Unable to delete site.");
          }
        } catch (error) {
          showError(error.message || "Unable to delete site.");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const payload = {
      label: labelInput.value.trim(),
      endpoint_url: endpointInput.value.trim(),
      api_key: apiKeyInput.value.trim(),
      keep_alive_url: keepAliveUrlInput.value.trim() || null,
    };

    const id = formIdInput.value;
    const isEdit = Boolean(id);
    submitButton.disabled = true;

    try {
      const response = await apiFetch(isEdit ? `/api/sites/${encodeURIComponent(id)}` : "/api/sites", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        showError(data.error || "Unable to save site.");
        return;
      }

      showNotice("Site saved.");
      resetForm();
      await loadSites();
    } catch (error) {
      showError(error.message || "Unable to save site.");
    } finally {
      submitButton.disabled = false;
    }
  });

  // Suggests a Label from the target site's own WordPress Site Title (a
  // server-side lookup, since a direct browser fetch to an arbitrary
  // third-party site would just hit CORS) once the endpoint URL is entered.
  // Never overwrites a Label the user already typed, and fails silently —
  // this is a convenience, not something worth surfacing an error for.
  endpointInput.addEventListener("blur", async function () {
    const endpointUrl = endpointInput.value.trim();
    if (!endpointUrl || labelInput.value.trim()) {
      return;
    }
    try {
      const response = await apiFetch(`/api/site_name?endpoint_url=${encodeURIComponent(endpointUrl)}`);
      const data = await response.json();
      if (data.name && !labelInput.value.trim()) {
        labelInput.value = data.name;
      }
    } catch (error) {
      // Best-effort only — leave the Label field for the user to fill in.
    }
  });

  cancelButton.addEventListener("click", resetForm);

  if (exportButton) {
    exportButton.addEventListener("click", handleExport);
  }

  if (importButton && importFileInput) {
    importButton.addEventListener("click", function () {
      importFileInput.click();
    });
    importFileInput.addEventListener("change", async function () {
      const file = importFileInput.files && importFileInput.files[0];
      // Reset immediately so selecting the same file again still fires "change".
      importFileInput.value = "";
      if (file) {
        await handleImportFile(file);
      }
    });
  }

  testButton.addEventListener("click", async function () {
    const endpointUrl = endpointInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!endpointUrl || !apiKey) {
      testResultEl.textContent = "Enter an endpoint URL and API key first.";
      return;
    }

    testButton.disabled = true;
    testResultEl.textContent = "Testing...";

    try {
      const response = await apiFetch("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint_url: endpointUrl, api_key: apiKey }),
      });
      const data = await response.json();

      if (data.ok) {
        const rating = data.data?.interpretation?.overall?.rating || "unknown";
        testResultEl.textContent = `Connected. Overall rating: ${rating}.`;
      } else {
        testResultEl.textContent = `Failed: ${data.error || "Unknown error"}`;
      }
    } catch (error) {
      testResultEl.textContent = `Failed: ${error.message || "Unknown error"}`;
    } finally {
      testButton.disabled = false;
    }
  });

  loadSites();
})();
