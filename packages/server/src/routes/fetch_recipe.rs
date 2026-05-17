//! Placeholder — implemented in a later commit.

use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Json},
};

use crate::AppState;

pub async fn handle(State(_state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "/fetch-recipe not yet wired in the Rust backend (phase 3 in progress)"
        })),
    )
}
