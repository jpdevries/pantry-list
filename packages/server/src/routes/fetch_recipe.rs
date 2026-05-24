//! `POST /fetch-recipe` — fetch a URL, scrape it, return a parsed recipe.
//!
//! Same wire shape as the Node `graphql-server.ts` endpoint:
//! - Request body: `{ "url": "https://..." }`
//! - 400 if `url` is missing
//! - 502 if the upstream fetch fails or returns non-2xx
//! - 422 if all three extraction tiers miss *and* there's no usable
//!   `<title>`/`<h1>` fallback
//! - 200 with the parsed payload otherwise

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;

#[derive(Deserialize)]
struct FetchBody {
    url: Option<String>,
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    body: axum::extract::Json<serde_json::Value>,
) -> Response {
    let parsed: FetchBody = match serde_json::from_value(body.0) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}")),
    };
    let Some(url) = parsed.url.filter(|s| !s.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "url is required".into());
    };

    let html = match fetch_html(&state.http, &url).await {
        Ok(h) => h,
        Err(e) => return err(StatusCode::BAD_GATEWAY, format!("Failed to fetch URL: {e}")),
    };

    let result = match crate::scrape::extract(&html) {
        Some(r) => r,
        None => {
            let Some(title) = crate::scrape::extract_title_only(&html) else {
                return err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "Could not extract recipe data from this page.".into(),
                );
            };
            crate::scrape::ParsedRecipe {
                title,
                ..Default::default()
            }
        }
    };

    let mut result = result;
    result.required_cookware = crate::scrape::detect_cookware(&state.pool, &result).await;

    (StatusCode::OK, Json(result)).into_response()
}

async fn fetch_html(client: &reqwest::Client, url: &str) -> anyhow::Result<String> {
    // 10s matches the AbortController timeout in the Node handler. The
    // shared client has a 15s ceiling on its own as a backstop.
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status().as_u16());
    }
    Ok(resp.text().await?)
}

fn err(status: StatusCode, msg: String) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}
