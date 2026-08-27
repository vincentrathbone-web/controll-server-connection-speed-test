use crate::models::{ProbeResult, Site};
use crate::now_iso;
use std::time::Duration;
use tokio::task::JoinSet;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build HTTP client")
}

pub async fn probe(id: i64, label: &str, endpoint_url: &str, api_key: &str) -> ProbeResult {
    let probed_at = now_iso();
    let response = client()
        .get(endpoint_url)
        .header("X-CSST-Api-Key", api_key)
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return ProbeResult {
                id,
                label: label.to_string(),
                ok: false,
                http_code: 0,
                error: Some(describe_reqwest_error(&err)),
                data: None,
                probed_at,
            };
        }
    };

    let http_code = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let decoded: Option<serde_json::Value> = serde_json::from_str(&body).ok();

    if http_code != 200 || decoded.is_none() {
        let message = decoded
            .as_ref()
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Unexpected response (HTTP {})", http_code));

        return ProbeResult {
            id,
            label: label.to_string(),
            ok: false,
            http_code,
            error: Some(message),
            data: None,
            probed_at,
        };
    }

    ProbeResult {
        id,
        label: label.to_string(),
        ok: true,
        http_code,
        error: None,
        data: decoded,
        probed_at,
    }
}

fn describe_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "Connection timed out".to_string()
    } else if err.is_connect() {
        format!("Connection failed: {}", err)
    } else {
        err.to_string()
    }
}

pub async fn probe_all(sites: Vec<Site>) -> Vec<ProbeResult> {
    let mut set = JoinSet::new();
    for site in sites {
        set.spawn(async move { probe(site.id, &site.label, &site.endpoint_url, &site.api_key).await });
    }

    let mut results = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(result) = res {
            results.push(result);
        }
    }

    results.sort_by_key(|r| r.id);
    results
}

/// Looks up a WordPress site's own configured name (Settings → General →
/// Site Title) via the standard, unauthenticated `/wp-json/` index route, so
/// the Setup screen can suggest a Label instead of making the user retype
/// something WordPress already knows. Best-effort only: `None` on any
/// failure (unreachable site, non-JSON response, REST API locked down,
/// missing/blank `name` field) — the caller falls back to leaving the Label
/// field for the user to fill in themselves.
pub async fn fetch_site_name(endpoint_url: &str) -> Option<String> {
    let origin = crate::derive_origin(endpoint_url)?;
    let index_url = format!("{origin}wp-json/");

    let response = client()
        .get(&index_url)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body: serde_json::Value = response.json().await.ok()?;
    body.get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
