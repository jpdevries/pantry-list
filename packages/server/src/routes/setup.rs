//! First-boot installer state.
//!
//! Single-key persistence (`SETUP_COMPLETE`) stored in the same overrides
//! file that `settings.rs` uses, but deliberately *not* listed in that
//! module's `SETTINGS` allowlist — so it can't be poked via the public
//! `/api/settings-write` surface.
//!
//! Auth model:
//!   - GET  /api/setup-status   always public (the installer SPA itself
//!                              needs to call this with no credentials)
//!   - POST /api/setup-complete
//!       * when setup is currently incomplete → public (first-boot)
//!       * when setup is currently complete   → owner only (loopback or
//!                                              forwarded HTTPS), matching
//!                                              the rest of `/api/*`
//!
//! Integration state (`tailscale`, `bluesky`) is stubbed to
//! `{state: "not_configured"}` here in PR 1; the integration modules will
//! plug in real status getters in follow-up PRs.

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
use crate::bluesky::{read_status as read_bluesky, BlueskyState};
use crate::routes::settings::{read_overrides, write_overrides};
use crate::tailscale::{read_status, TailscaleState};
use crate::AppState;

const SETUP_COMPLETE_KEY: &str = "SETUP_COMPLETE";

pub(crate) fn is_setup_complete(state: &AppState) -> bool {
    read_overrides(state)
        .get(SETUP_COMPLETE_KEY)
        .map(|v| v == "true")
        .unwrap_or(false)
}

pub async fn setup_status(State(state): State<Arc<AppState>>) -> Response {
    let complete = is_setup_complete(&state);
    let tailscale = tailscale_for_summary(&state).await;
    let bluesky = bluesky_for_summary(&state);
    (
        StatusCode::OK,
        [("cache-control", "private, no-store")],
        Json(json!({
            "complete": complete,
            "integrations": {
                "tailscale": tailscale,
                "bluesky":   bluesky,
            },
        })),
    )
        .into_response()
}

/// Project the bluesky state onto the smaller summary shape the
/// installer's Summary page renders — same shape Tailscale uses, so
/// the SPA can render both rows from a shared component.
fn bluesky_for_summary(state: &Arc<AppState>) -> serde_json::Value {
    match read_bluesky(state) {
        BlueskyState::NotConfigured => json!({ "state": "not_configured" }),
        BlueskyState::Configured { handle, .. } => {
            json!({ "state": "connected", "label": format!("@{handle}") })
        }
    }
}

/// Project the full TailscaleState onto the smaller summary shape the
/// installer's Summary page renders. We collapse the connect-in-progress
/// flavors back to "not_configured" so a half-finished login doesn't
/// look complete on Summary; the Tailscale step itself uses the richer
/// /api/tailscale/status when it needs the auth URL.
async fn tailscale_for_summary(state: &Arc<AppState>) -> serde_json::Value {
    let info = state.tailscale.clone();
    let connect = std::sync::Arc::clone(&state.tailscale_connect);
    let port = state.graphql_port;
    let s = tokio::task::spawn_blocking(move || read_status(info.as_ref(), &connect, port))
        .await
        .unwrap_or(TailscaleState::NotConnected);
    match s {
        TailscaleState::Unavailable { reason } => {
            json!({ "state": "unavailable", "reason": reason })
        }
        TailscaleState::NotConnected | TailscaleState::AwaitingAuth { .. } => {
            json!({ "state": "not_configured" })
        }
        TailscaleState::ConnectedNoServe { tailnet } => {
            // Signed in but no HTTPS yet — surface that so Summary can
            // nudge the user back into the Tailscale step.
            json!({ "state": "connecting", "label": tailnet })
        }
        TailscaleState::Configured { url, .. } => {
            json!({ "state": "connected", "label": url })
        }
    }
}

#[derive(Deserialize, Default)]
pub struct CompleteBody {
    #[serde(default)]
    pub reset: bool,
}

pub async fn setup_complete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<CompleteBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let already_done = is_setup_complete(&state);

    // Re-running setup (or any call after first-boot) is owner-gated so
    // random LAN guests can't reset us back into the wizard.
    if already_done && !is_owner(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Not available to guests" })),
        )
            .into_response();
    }

    let mut current = read_overrides(&state);
    if body.reset {
        current.remove(SETUP_COMPLETE_KEY);
    } else {
        current.insert(SETUP_COMPLETE_KEY.to_string(), "true".to_string());
    }

    if let Err(e) = write_overrides(&state, &current) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Write failed: {e}") })),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        [("cache-control", "private, no-store")],
        Json(json!({ "complete": !body.reset })),
    )
        .into_response()
}
