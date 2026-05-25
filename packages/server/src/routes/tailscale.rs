//! HTTP surface for the installer's Tailscale step.
//!
//!   GET  /api/tailscale/status        → TailscaleState (public; the SPA
//!                                        polls this during the connect
//!                                        flow and needs to see updates
//!                                        without owner creds)
//!   POST /api/tailscale/connect       → spawn `tailscale up`; idempotent
//!   POST /api/tailscale/enable-serve  → run `tailscale serve --bg
//!                                        --https=443` against our port
//!
//! The two POST endpoints are owner-gated via `crate::auth::is_owner` —
//! matches the rest of the installer API surface and prevents random LAN
//! visitors from kicking off a Tailscale login on someone else's device.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::auth::is_owner;
use crate::tailscale::{enable_serve, read_status, start_connect, TailscaleState};
use crate::AppState;

/// Choose the hostname we register with the tailnet. Honors
/// `PANTRY_HOSTNAME` (so a sysadmin can pin a name regardless of the
/// system hostname), then falls back to `/etc/hostname` (always set on
/// systemd), then to a sensible literal so the call never hands tailscaled
/// an empty string. The bare literal `"pantry-host"` used to be hardcoded
/// here, which made the image-builder's HOSTNAME=... setting cosmetic —
/// every install registered as "pantry-host" regardless.
fn registration_hostname() -> String {
    if let Ok(v) = std::env::var("PANTRY_HOSTNAME") {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    if let Ok(v) = std::fs::read_to_string("/etc/hostname") {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    "pantry-host".to_string()
}

pub async fn status(State(state): State<Arc<AppState>>) -> Response {
    let s = compute_status(&state).await;
    json_response(StatusCode::OK, json!(s))
}

pub async fn connect(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !is_owner(&headers) {
        return forbidden();
    }
    let Some(info) = state.tailscale.clone() else {
        return json_response(
            StatusCode::CONFLICT,
            json!({ "error": "tailscale binary not installed" }),
        );
    };
    start_connect(&info, &state.tailscale_connect, &registration_hostname());
    // Return the freshly-updated status so the SPA can short-circuit
    // its first poll. Most of the time it'll be `awaiting_auth` once the
    // URL appears (which can take up to ~1s); the SPA continues to poll
    // /status to pick that up.
    let s = compute_status(&state).await;
    json_response(StatusCode::ACCEPTED, json!(s))
}

pub async fn enable_serve_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !is_owner(&headers) {
        return forbidden();
    }
    let Some(info) = state.tailscale.clone() else {
        return json_response(
            StatusCode::CONFLICT,
            json!({ "error": "tailscale binary not installed" }),
        );
    };
    let port = state.graphql_port;
    let res = tokio::task::spawn_blocking(move || enable_serve(&info, port)).await;
    match res {
        Ok(Ok(())) => {
            let s = compute_status(&state).await;
            json_response(StatusCode::OK, json!(s))
        }
        Ok(Err(e)) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("{e}") }),
        ),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("join error: {e}") }),
        ),
    }
}

async fn compute_status(state: &Arc<AppState>) -> TailscaleState {
    let info = state.tailscale.clone();
    let connect = Arc::clone(&state.tailscale_connect);
    let port = state.graphql_port;
    tokio::task::spawn_blocking(move || read_status(info.as_ref(), &connect, port))
        .await
        .unwrap_or(TailscaleState::Unavailable {
            reason: "status read task panicked".to_string(),
        })
}

fn json_response(code: StatusCode, body: serde_json::Value) -> Response {
    (
        code,
        [("cache-control", "private, no-store")],
        Json(body),
    )
        .into_response()
}

fn forbidden() -> Response {
    json_response(
        StatusCode::FORBIDDEN,
        json!({ "error": "Not available to guests" }),
    )
}
