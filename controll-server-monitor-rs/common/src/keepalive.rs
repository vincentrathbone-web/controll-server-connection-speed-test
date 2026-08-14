use crate::db::Db;
use crate::models::{KeepAliveStatus, Site};
use crate::now_iso;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::task::JoinSet;

pub struct KeepAliveState {
    pub statuses: Mutex<HashMap<i64, KeepAliveStatus>>,
}

impl KeepAliveState {
    pub fn new() -> Self {
        KeepAliveState {
            statuses: Mutex::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self) -> Vec<KeepAliveStatus> {
        let map = self.statuses.lock().unwrap();
        let mut list: Vec<KeepAliveStatus> = map.values().cloned().collect();
        list.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        list
    }
}

/// Uses the site's explicit keep_alive_url if set, otherwise pings the origin
/// (scheme://host[:port]/) parsed out of the stats endpoint URL — covers the
/// common case where the stats endpoint and the site root are the same host
/// without requiring a second URL to be entered for every site.
fn derive_keep_alive_url(site: &Site) -> Option<String> {
    if let Some(url) = &site.keep_alive_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let parsed = url::Url::parse(&site.endpoint_url).ok()?;
    let port_suffix = match parsed.port() {
        Some(port) => format!(":{port}"),
        None => String::new(),
    };
    Some(format!("{}://{}{}/", parsed.scheme(), parsed.host_str()?, port_suffix))
}

async fn ping_one(site: Site) -> KeepAliveStatus {
    // Unambiguous UTC (was a naive "YYYY-MM-DD HH:MM:SS" with no timezone
    // marker, which read as local time despite actually being UTC).
    let now = now_iso();

    let Some(url) = derive_keep_alive_url(&site) else {
        return KeepAliveStatus {
            site_id: site.id,
            label: site.label,
            url: String::new(),
            ok: false,
            http_code: 0,
            error: Some("Could not determine a keep-alive URL for this site.".to_string()),
            last_ping_at: now,
            elapsed_ms: 0,
        };
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client");

    let start = Instant::now();
    let response = client.get(&url).send().await;
    let elapsed_ms = start.elapsed().as_millis();

    match response {
        Ok(resp) => KeepAliveStatus {
            site_id: site.id,
            label: site.label,
            url,
            ok: resp.status().is_success(),
            http_code: resp.status().as_u16(),
            error: None,
            last_ping_at: now,
            elapsed_ms,
        },
        Err(err) => KeepAliveStatus {
            site_id: site.id,
            label: site.label,
            url,
            ok: false,
            http_code: 0,
            error: Some(err.to_string()),
            last_ping_at: now,
            elapsed_ms,
        },
    }
}

fn append_log(log_path: &PathBuf, status: &KeepAliveStatus) {
    let Some(parent) = log_path.parent() else { return };
    let _ = std::fs::create_dir_all(parent);

    let line = if status.ok {
        format!(
            "[{}] OK   label={} status={} elapsedMs={} url={}\n",
            status.last_ping_at, status.label, status.http_code, status.elapsed_ms, status.url
        )
    } else {
        format!(
            "[{}] FAIL label={} status={} elapsedMs={} url={} error={}\n",
            status.last_ping_at,
            status.label,
            status.http_code,
            status.elapsed_ms,
            status.url,
            status.error.as_deref().unwrap_or("unknown")
        )
    };

    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = file.write_all(line.as_bytes());
    }
}

const HISTORY_RETENTION_DAYS: i64 = 30;

async fn run_cycle(db: &Db, state: &KeepAliveState, log_path: &PathBuf) {
    let sites = match db.list_sites() {
        Ok(sites) => sites,
        Err(err) => {
            eprintln!("keep-alive: failed to list sites: {err}");
            return;
        }
    };

    let mut set = JoinSet::new();
    for site in sites {
        set.spawn(ping_one(site));
    }

    while let Some(result) = set.join_next().await {
        if let Ok(status) = result {
            append_log(log_path, &status);
            // Every ping is persisted, not just the latest, so a site's
            // actual track record survives a service restart and can be
            // inspected later instead of only ever showing "the last one".
            if let Err(err) = db.insert_keepalive_ping(&status) {
                eprintln!("keep-alive: failed to persist ping history: {err}");
            }
            state.statuses.lock().unwrap().insert(status.site_id, status);
        }
    }

    if let Err(err) = db.prune_keepalive_history(HISTORY_RETENTION_DAYS) {
        eprintln!("keep-alive: failed to prune ping history: {err}");
    }
}

pub fn spawn_loop(db: Arc<Db>, state: Arc<KeepAliveState>, log_path: PathBuf, interval_minutes: u64) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_minutes.max(1) * 60));
        loop {
            ticker.tick().await;
            run_cycle(&db, &state, &log_path).await;
        }
    });
}
