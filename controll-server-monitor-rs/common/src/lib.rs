pub mod api;
pub mod db;
pub mod keepalive;
pub mod models;
pub mod prober;

use axum::extract::Path as AxumPath;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use db::Db;
use keepalive::KeepAliveState;
use rust_embed::RustEmbed;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

pub const DEFAULT_PORT: u16 = 8091;
pub const KEEP_ALIVE_INTERVAL_MINUTES: u64 = 5;

/// All timestamps this backend hands to the frontend use this one format:
/// unambiguous ISO 8601 UTC with an explicit "Z" suffix. `JSON.parse` +
/// `new Date(...)` on the frontend then always reads it as UTC and reformats
/// it into the browser's local timezone for display — never showing the raw
/// UTC string as if it were already local.
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S.%3fZ").to_string()
}

// Frontend assets are compiled directly into the binary — this is meant to be
// a single distributable service, not a folder of loose HTML/JS/CSS files that
// could go missing or be edited out from under it.
#[derive(RustEmbed)]
#[folder = "static/"]
struct Assets;

fn content_type_for(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

async fn serve_embedded(path: &str) -> impl IntoResponse {
    match Assets::get(path) {
        Some(file) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type_for(path)),
                (header::CACHE_CONTROL, "no-store"),
            ],
            file.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn serve_index() -> impl IntoResponse {
    serve_embedded("index.html").await
}

async fn serve_setup() -> impl IntoResponse {
    serve_embedded("setup.html").await
}

async fn serve_asset(AxumPath(file): AxumPath<String>) -> impl IntoResponse {
    serve_embedded(&format!("assets/{file}")).await
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub keepalive: Arc<KeepAliveState>,
}

/// Machine-wide data location. The service runs as LocalSystem with no user
/// profile, and its install directory is under Program Files, so neither an
/// exe-relative nor a per-user path is appropriate.
pub fn data_dir() -> PathBuf {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    PathBuf::from(base).join("ControllServerMonitor")
}

pub fn init_state() -> (AppState, PathBuf) {
    let dir = data_dir();
    let db_path = dir.join("monitor.sqlite");
    let log_path = dir.join("keep-alive.log");

    let db = Arc::new(Db::open(&db_path).expect("failed to open database"));
    let keepalive_state = Arc::new(KeepAliveState::new());

    keepalive::spawn_loop(
        Arc::clone(&db),
        Arc::clone(&keepalive_state),
        log_path.clone(),
        KEEP_ALIVE_INTERVAL_MINUTES,
    );

    (
        AppState {
            db,
            keepalive: keepalive_state,
        },
        log_path,
    )
}

pub fn build_router(state: AppState) -> Router {
    // The Tauri webview serves the frontend from its own origin
    // (tauri.localhost) and calls this API cross-origin. The listener is bound
    // to 127.0.0.1 only, so this is not reachable off-machine.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/sites", get(api::list_sites).post(api::add_site))
        .route(
            "/api/sites/:id",
            get(api::get_site).put(api::update_site).delete(api::delete_site),
        )
        .route("/api/probe", get(api::probe).post(api::probe_adhoc))
        .route("/api/probe_all", get(api::probe_all))
        .route("/api/keepalive/status", get(api::keepalive_status))
        .route("/api/keepalive/history", get(api::keepalive_history))
        .route("/assets/:file", get(serve_asset))
        .route("/", get(serve_index))
        .route("/setup.html", get(serve_setup))
        .layer(cors)
        .with_state(state)
}
