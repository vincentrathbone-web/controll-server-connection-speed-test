// These assets are served two different ways: directly by the Windows Service
// over http://127.0.0.1:8091 (browser use), and from inside the Tauri webview,
// which serves them from tauri.localhost. In the second case root-relative
// /api/ paths would hit the webview's own origin instead of the service, so
// resolve them against the service explicitly whenever we aren't already on it.
(function () {
  const SERVICE_ORIGIN = "http://127.0.0.1:8091";
  const onService =
    window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

  window.API_BASE = onService ? "" : SERVICE_ORIGIN;
  window.apiUrl = (path) => window.API_BASE + path;

  // fetch() reports an unreachable service as a bare "Failed to fetch", which
  // reads like the monitored site is at fault rather than the service being
  // down. Every call goes through here so that failure names itself.
  window.apiFetch = async function (path, options) {
    try {
      return await fetch(window.apiUrl(path), options);
    } catch (err) {
      throw new Error(
        "Cannot reach the Controll Server Monitor background service at " +
          SERVICE_ORIGIN +
          ". It may not be installed or running — check Services for 'Controll Server Monitor'."
      );
    }
  };

  // The service hands back timestamps as UTC. Newer ones are unambiguous ISO
  // 8601 ("...Z"); a few older ones (e.g. a site's created_at, stored in a
  // SQLite schema shared with the PHP dashboard) are naive "YYYY-MM-DD
  // HH:MM:SS" with no timezone marker, which browsers misparse as local time.
  // Normalize the naive form to explicit UTC before handing it to Date(), then
  // reformat into the viewer's actual local timezone for display.
  window.formatLocalTime = function (timestamp) {
    if (!timestamp) {
      return "";
    }
    const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp);
    const normalized = hasTimezone ? timestamp : `${timestamp.replace(" ", "T")}Z`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      return timestamp;
    }
    return date.toLocaleString([], { hour12: false });
  };
})();
