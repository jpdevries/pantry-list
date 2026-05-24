//! HTTP surface for the installer's Bluesky step.
//!
//!   GET  /api/bluesky/status      → BlueskyState (public; the SPA needs
//!                                    to render the panel before owner
//!                                    creds are known)
//!   POST /api/bluesky/connect     → resolve handle, persist handle + DID
//!   POST /api/bluesky/disconnect  → clear persisted handle + DID
//!
//! The two POST endpoints are owner-gated via `crate::auth::is_owner` —
//! matches `routes::tailscale` and the rest of the installer API surface.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::auth::is_owner;
use crate::bluesky::{connect as do_connect, disconnect as do_disconnect, read_status};
use crate::AppState;

pub async fn status(State(state): State<Arc<AppState>>) -> Response {
    let s = read_status(&state);
    json_response(StatusCode::OK, json!(s))
}

#[derive(Deserialize)]
pub struct ConnectBody {
    pub handle: String,
}

pub async fn connect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<ConnectBody>>,
) -> Response {
    if !is_owner(&headers) {
        return forbidden();
    }
    let Some(Json(body)) = body else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Missing handle" }),
        );
    };
    let http = state.http.clone();
    match do_connect(&state, &http, &body.handle).await {
        Ok(s) => json_response(StatusCode::OK, json!(s)),
        // Resolve failures (bad handle, network blip) are the only
        // expected error here — surface the message verbatim so the SPA
        // can show it inline below the input.
        Err(e) => json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": format!("{e}") }),
        ),
    }
}

pub async fn disconnect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !is_owner(&headers) {
        return forbidden();
    }
    match do_disconnect(&state) {
        Ok(s) => json_response(StatusCode::OK, json!(s)),
        Err(e) => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("{e}") }),
        ),
    }
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
