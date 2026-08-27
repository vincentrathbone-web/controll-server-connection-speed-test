use crate::models::SiteInput;
use crate::prober;
use crate::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;

pub async fn list_sites(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_sites() {
        Ok(sites) => Json(json!({ "sites": sites })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn get_site(State(state): State<AppState>, Path(id): Path<i64>) -> impl IntoResponse {
    match state.db.get_site(id) {
        Ok(Some(site)) => Json(site).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "Site not found").into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

fn validate_input(input: &SiteInput) -> Result<(), String> {
    if input.label.trim().is_empty() || input.endpoint_url.trim().is_empty() || input.api_key.trim().is_empty() {
        return Err("Label, endpoint URL, and API key are all required.".to_string());
    }
    if url::Url::parse(&input.endpoint_url).is_err() {
        return Err("Endpoint URL is not a valid URL.".to_string());
    }
    Ok(())
}

pub async fn add_site(State(state): State<AppState>, Json(input): Json<SiteInput>) -> impl IntoResponse {
    if let Err(message) = validate_input(&input) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response();
    }
    match state.db.add_site(&input) {
        Ok(id) => (StatusCode::CREATED, Json(json!({ "id": id }))).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}

pub async fn update_site(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<SiteInput>,
) -> impl IntoResponse {
    if let Err(message) = validate_input(&input) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response();
    }
    match state.db.update_site(id, &input) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}

pub async fn delete_site(State(state): State<AppState>, Path(id): Path<i64>) -> impl IntoResponse {
    match state.db.delete_site(id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ProbeQuery {
    id: Option<i64>,
}

#[derive(Deserialize)]
pub struct SiteNameQuery {
    endpoint_url: String,
}

/// Backs the Setup screen's auto-fill-Label-on-blur convenience. Always
/// responds 200 — a lookup failure is just `{ "name": null }`, not an error,
/// since this is a best-effort suggestion the user can freely overwrite.
pub async fn site_name(Query(query): Query<SiteNameQuery>) -> impl IntoResponse {
    let name = prober::fetch_site_name(&query.endpoint_url).await;
    Json(json!({ "name": name }))
}

#[derive(Deserialize)]
pub struct AdHocProbeInput {
    endpoint_url: String,
    api_key: String,
}

pub async fn probe(
    State(state): State<AppState>,
    Query(query): Query<ProbeQuery>,
) -> impl IntoResponse {
    let Some(id) = query.id else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": "id is required" }))).into_response();
    };

    match state.db.get_site(id) {
        Ok(Some(site)) => {
            let result = prober::probe(site.id, &site.label, &site.endpoint_url, &site.api_key).await;
            Json(result).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "ok": false, "error": "Site not found" }))).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "ok": false, "error": err.to_string() }))).into_response(),
    }
}

pub async fn probe_adhoc(Json(input): Json<AdHocProbeInput>) -> impl IntoResponse {
    if input.endpoint_url.trim().is_empty() || input.api_key.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "Endpoint URL and API key are both required to test." })),
        )
            .into_response();
    }
    let result = prober::probe(0, "Test", &input.endpoint_url, &input.api_key).await;
    Json(result).into_response()
}

pub async fn probe_all(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_sites() {
        Ok(sites) => {
            let results = prober::probe_all(sites).await;
            Json(json!({ "results": results })).into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}

pub async fn keepalive_status(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "statuses": state.keepalive.snapshot() }))
}

#[derive(Deserialize)]
pub struct KeepAliveHistoryQuery {
    #[serde(rename = "siteId")]
    site_id: Option<i64>,
    limit: Option<i64>,
}

pub async fn keepalive_history(
    State(state): State<AppState>,
    Query(query): Query<KeepAliveHistoryQuery>,
) -> impl IntoResponse {
    let Some(site_id) = query.site_id else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "siteId is required" }))).into_response();
    };
    // Cap regardless of what's requested — this backs an on-demand UI panel,
    // not a bulk export.
    let limit = query.limit.unwrap_or(50).clamp(1, 500);

    match state.db.get_keepalive_history(site_id, limit) {
        Ok(history) => Json(json!({ "history": history })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": err.to_string() }))).into_response(),
    }
}
