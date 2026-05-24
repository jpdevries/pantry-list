//! Embedded first-boot installer SPA.
//!
//! Vite-built static site under `packages/installer-ui/`, mirrored into
//! `packages/server/static/installer/` and embedded with rust-embed.
//!
//! Vite is configured with `base: '/_setup/static/'`, so:
//!   - The HTML shell goes at `/setup` and `/setup/{*}`  (SPA history fallback)
//!   - Hashed JS/CSS chunks go at `/_setup/static/{*path}`
//!
//! This module ships no business logic — just byte-for-byte asset serving.
//! Routing decisions (redirecting `/` → `/setup` when setup is incomplete)
//! live in `main::route_by_setup`.
//!
//! When no installer assets are embedded (empty `static/installer/`),
//! falls back to a placeholder so the binary still boots.

use std::borrow::Cow;

use axum::{
    extract::Path,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "static/installer/"]
#[exclude = ".gitkeep"]
#[exclude = "*.map"]
struct InstallerAssets;

fn embedded_response(path: &str, data: Cow<'static, [u8]>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = (StatusCode::OK, data.into_owned()).into_response();
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    // Vite emits hashed asset filenames under base/assets/, so they're
    // safe to cache aggressively. The HTML shell at the SPA entry needs
    // to revalidate so deploys roll out cleanly.
    let cache = if path.ends_with(".html") {
        "no-cache, must-revalidate"
    } else {
        "public, max-age=31536000, immutable"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

fn placeholder_html() -> String {
    r##"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Pantry Host setup</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#27272a}code{background:#f4f4f5;padding:0.1rem 0.4rem;border-radius:0.25rem}</style>
</head><body>
<h1>Pantry Host setup</h1>
<p>The installer SPA isn't embedded in this binary. Build it:</p>
<pre><code>cd packages/installer-ui &amp;&amp; npm run build
cargo build --release -p pantry-server</code></pre>
</body></html>"##
        .to_string()
}

/// `GET /setup` and `GET /setup/{*path}` — the SPA shell. Always returns
/// `index.html` regardless of subpath; `react-router-dom` handles the rest
/// client-side.
pub async fn serve_index() -> Response {
    let Some(asset) = InstallerAssets::get("index.html") else {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))],
            placeholder_html(),
        )
            .into_response();
    };
    embedded_response("index.html", asset.data)
}

/// `GET /_setup/static/{*path}` — Vite-built assets (hashed JS/CSS/etc.).
pub async fn serve_asset(Path(path): Path<String>) -> Response {
    if let Some(asset) = InstallerAssets::get(&path) {
        return embedded_response(&path, asset.data);
    }
    StatusCode::NOT_FOUND.into_response()
}
