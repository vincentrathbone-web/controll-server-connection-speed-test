use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct Site {
    pub id: i64,
    pub label: String,
    pub endpoint_url: String,
    pub api_key: String,
    pub keep_alive_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SiteInput {
    pub label: String,
    pub endpoint_url: String,
    pub api_key: String,
    #[serde(default)]
    pub keep_alive_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub id: i64,
    pub label: String,
    pub ok: bool,
    #[serde(rename = "httpCode")]
    pub http_code: u16,
    pub error: Option<String>,
    pub data: Option<serde_json::Value>,
    #[serde(rename = "probedAt")]
    pub probed_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeepAliveStatus {
    // Every sibling field below is deliberately renamed to camelCase for the
    // JSON boundary; this one was missing its rename, so the setup screen's
    // `map[s.siteId] = s` (common/static/assets/setup.js) always looked up
    // `undefined` against the actual `site_id` key and every site showed
    // "Not pinged yet" regardless of real keep-alive history.
    #[serde(rename = "siteId")]
    pub site_id: i64,
    pub label: String,
    pub url: String,
    pub ok: bool,
    #[serde(rename = "httpCode")]
    pub http_code: u16,
    pub error: Option<String>,
    #[serde(rename = "lastPingAt")]
    pub last_ping_at: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u128,
}

/// One persisted row per keep-alive ping, so a site's actual track record
/// (not just its most recent result, which is all `KeepAliveStatus` holds in
/// memory and loses on every service restart) can be inspected later.
#[derive(Debug, Clone, Serialize)]
pub struct KeepAliveHistoryEntry {
    pub id: i64,
    pub ok: bool,
    #[serde(rename = "httpCode")]
    pub http_code: u16,
    pub error: Option<String>,
    #[serde(rename = "pingAt")]
    pub ping_at: String,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u64,
}
