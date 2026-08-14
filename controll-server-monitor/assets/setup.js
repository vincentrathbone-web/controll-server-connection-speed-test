(function () {
  "use strict";

  const form = document.getElementById("csm-site-form");
  const testButton = document.getElementById("csm-test-btn");
  const resultEl = document.getElementById("csm-test-result");

  if (!form || !testButton || !resultEl) {
    return;
  }

  testButton.addEventListener("click", async function () {
    const endpointUrl = form.querySelector('[name="endpoint_url"]').value.trim();
    const apiKey = form.querySelector('[name="api_key"]').value.trim();

    if (!endpointUrl || !apiKey) {
      resultEl.textContent = "Enter an endpoint URL and API key first.";
      return;
    }

    testButton.disabled = true;
    resultEl.textContent = "Testing...";

    try {
      const body = new FormData();
      body.append("endpoint_url", endpointUrl);
      body.append("api_key", apiKey);

      const response = await fetch("api/probe.php", { method: "POST", body });
      const data = await response.json();

      if (data.ok) {
        const rating = data.data?.interpretation?.overall?.rating || "unknown";
        resultEl.textContent = `Connected. Overall rating: ${rating}.`;
      } else {
        resultEl.textContent = `Failed: ${data.error || "Unknown error"}`;
      }
    } catch (error) {
      resultEl.textContent = `Failed: ${error.message || "Unknown error"}`;
    } finally {
      testButton.disabled = false;
    }
  });

  document.querySelectorAll(".csm-row-test-btn").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      const id = btn.getAttribute("data-id");
      const resultEl = document.getElementById("csm-row-test-result-" + id);
      if (!resultEl) {
        return;
      }

      btn.disabled = true;
      resultEl.textContent = "Testing...";

      try {
        const response = await fetch("api/probe.php?id=" + encodeURIComponent(id));
        const data = await response.json();

        if (data.ok) {
          const rating = data.data?.interpretation?.overall?.rating || "unknown";
          resultEl.textContent = `Connected. Overall rating: ${rating}.`;
        } else {
          resultEl.textContent = `Failed: ${data.error || "Unknown error"}`;
        }
      } catch (error) {
        resultEl.textContent = `Failed: ${error.message || "Unknown error"}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
