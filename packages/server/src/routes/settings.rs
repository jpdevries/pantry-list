//! `/api/settings-read`, `/api/settings-write`, `/api/recipe-api-key`.
//!
//! Owner-gated reads + writes of user settings, layered on top of the
//! process environment. Mirrors `packages/app/pages/api/settings-{read,write}.ts`
//! and `recipe-api-key.ts`.
//!
//! Threat model: matches the Node version. Owner = same machine (loopback
//! Host header) OR HTTPS terminating somewhere this server trusts
//! (Tailscale cert, mkcert). LAN guests on plain HTTP get masked secrets
//! on read and a 403 on write. Host header is client-controlled, so this
//! is "good enough for a self-hosted home box" — a determined LAN
//! attacker can spoof it, same as in the Node implementation.
//!
//! Overrides storage: a single JSON object at `config.overrides_path`
//! whose keys are the allowed `SettingKey`s. settings-write merges the
//! incoming values in (empty/missing → delete the key); settings-read
//! merges the file on top of process.env at request time.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::AppState;

// ── Settings schema (mirror packages/shared/src/settings-schema.ts) ──

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
enum SettingKind {
    Text,
    Secret,
    Boolean,
}

const SETTINGS: &[(&str, SettingKind)] = &[
    ("RECIPE_API_KEY", SettingKind::Secret),
    ("PIXABAY_FALLBACK_ENABLED", SettingKind::Boolean),
    ("PIXABAY_API_KEY", SettingKind::Secret),
    ("SHOW_COCKTAILDB", SettingKind::Boolean),
    ("STORE_BARCODE_META", SettingKind::Boolean),
    ("PREFER_BROWSER_CHROME", SettingKind::Boolean),
    ("HARVEST_LOCATIONS", SettingKind::Text),
];

fn is_allowed(key: &str) -> bool {
    SETTINGS.iter().any(|(k, _)| *k == key)
}

fn is_secret(key: &str) -> bool {
    SETTINGS
        .iter()
        .any(|(k, kind)| *k == key && matches!(kind, SettingKind::Secret))
}

fn boolean_keys() -> HashSet<&'static str> {
    SETTINGS
        .iter()
        .filter(|(_, kind)| matches!(kind, SettingKind::Boolean))
        .map(|(k, _)| *k)
        .collect()
}

fn mask_secret(value: &str) -> String {
    // Matches packages/shared/src/settings-schema.ts maskSecret() default
    // (visibleStart=8, visibleEnd=5, with 8 bullet chars in between).
    let visible_start = 8usize;
    let visible_end = 5usize;
    if value.len() <= visible_start + visible_end + 2 {
        return value.to_string();
    }
    // value is opaque UTF-8 — slice by chars, not bytes, to avoid splitting
    // a multi-byte character on either edge.
    let chars: Vec<char> = value.chars().collect();
    let head: String = chars[..visible_start].iter().collect();
    let tail: String = chars[chars.len() - visible_end..].iter().collect();
    format!("{}{}{}", head, "•".repeat(8), tail)
}

// Auth predicate lives in `crate::auth` so settings, setup, and (PR 2+)
// the integration routes all agree on who counts as an owner.
use crate::auth::is_owner;

// ── Overrides file I/O ──

pub(crate) fn read_overrides(state: &AppState) -> BTreeMap<String, String> {
    let path = &state.config.overrides_path;
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return BTreeMap::new();
    };
    let Some(obj) = value.as_object() else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            out.insert(k.clone(), s.to_string());
        }
    }
    out
}

pub(crate) fn write_overrides(state: &AppState, map: &BTreeMap<String, String>) -> std::io::Result<()> {
    let path = &state.config.overrides_path;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let payload = serde_json::to_vec_pretty(map)?;
    // Trailing newline matches the Node version's `JSON.stringify(...) + '\n'`.
    let mut payload = payload;
    payload.push(b'\n');
    std::fs::write(path, payload)
}

fn lookup(_state: &AppState, overrides: &BTreeMap<String, String>, key: &str) -> Option<String> {
    // PREFER_BROWSER_CHROME is a per-user preference, not deployment config —
    // never fall back to the env var. Matches settings-read.ts behavior.
    if key == "PREFER_BROWSER_CHROME" {
        return overrides.get(key).cloned();
    }
    if let Some(v) = overrides.get(key) {
        return Some(v.clone());
    }
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

// ── /api/settings-read ──

#[derive(Deserialize)]
pub struct SettingsReadQuery {
    pub reveal: Option<String>,
}

pub async fn settings_read(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SettingsReadQuery>,
) -> Response {
    let owner = is_owner(&headers);
    let cache_control = ("cache-control", "private, no-store");

    if !owner {
        return (
            StatusCode::OK,
            [cache_control],
            Json(json!({ "locked": true, "values": null })),
        )
            .into_response();
    }

    let overrides = read_overrides(&state);

    if let Some(reveal_key) = query.reveal.as_deref() {
        if !is_allowed(reveal_key) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Unknown setting key" })),
            )
                .into_response();
        }
        let value = lookup(&state, &overrides, reveal_key);
        return (
            StatusCode::OK,
            [cache_control],
            Json(json!({ "locked": false, "key": reveal_key, "value": value })),
        )
            .into_response();
    }

    let mut values = serde_json::Map::new();
    let mut masked_keys: Vec<String> = Vec::new();
    for (key, _) in SETTINGS {
        let raw = lookup(&state, &overrides, key);
        match raw {
            None => {
                values.insert((*key).to_string(), Value::Null);
            }
            Some(v) if is_secret(key) => {
                values.insert((*key).to_string(), Value::String(mask_secret(&v)));
                masked_keys.push((*key).to_string());
            }
            Some(v) => {
                values.insert((*key).to_string(), Value::String(v));
            }
        }
    }
    (
        StatusCode::OK,
        [cache_control],
        Json(json!({
            "locked": false,
            "values": values,
            "maskedKeys": masked_keys,
        })),
    )
        .into_response()
}

// ── /api/settings-write ──

const UNCHANGED_SENTINEL: &str = "__UNCHANGED__";

/// Parse either `{ "values": { ... } }` JSON or form-encoded flat
/// key/value pairs. Returns a map of `key -> Option<String>` where
/// `None` means "delete this key" (empty string in the form / explicit
/// null in JSON).
fn parse_write_body(content_type: &str, body: &str) -> Option<BTreeMap<String, Option<String>>> {
    let ct = content_type.to_ascii_lowercase();
    let mut out: BTreeMap<String, Option<String>> = BTreeMap::new();

    if ct.contains("application/json") {
        let parsed: Value = serde_json::from_str(body).ok()?;
        let values = parsed.get("values")?.as_object()?;
        // Preserve unknown keys in JSON mode so the caller can return 400
        // — matches the Node `settings-write.ts` behavior: form-encoded
        // submissions silently filter unknown fields, JSON rejects them.
        for (k, v) in values {
            let entry = match v {
                Value::Null => None,
                Value::String(s) if s.is_empty() => None,
                Value::String(s) if s == UNCHANGED_SENTINEL => continue,
                Value::String(s) => Some(s.clone()),
                Value::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
                _ => return None,
            };
            out.insert(k.clone(), entry);
        }
        return Some(out);
    }

    // Form-encoded fallback. Unchecked checkboxes are absent from the
    // body, so collect the boolean keys we *saw* and default the rest
    // to "false".
    let mut seen_keys: HashSet<String> = HashSet::new();
    for pair in body.split('&').filter(|p| !p.is_empty()) {
        let mut it = pair.splitn(2, '=');
        let raw_key = it.next().unwrap_or("");
        let raw_val = it.next().unwrap_or("");
        let key = match urldecode(raw_key) {
            Some(k) => k,
            None => continue,
        };
        let value = match urldecode(raw_val) {
            Some(v) => v,
            None => continue,
        };
        if !is_allowed(&key) {
            continue;
        }
        if value == UNCHANGED_SENTINEL {
            seen_keys.insert(key);
            continue;
        }
        let entry = if value.is_empty() { None } else { Some(value) };
        out.insert(key.clone(), entry);
        seen_keys.insert(key);
    }
    // Boolean keys absent from the form = unchecked checkbox = "false".
    for bk in boolean_keys() {
        if !seen_keys.contains(bk) {
            out.insert(bk.to_string(), Some("false".into()));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub(crate) fn urldecode(s: &str) -> Option<String> {
    // application/x-www-form-urlencoded: `+` is space, `%XX` is byte.
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                let byte = u8::from_str_radix(hex, 16).ok()?;
                out.push(byte);
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub async fn settings_write(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !is_owner(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Not available to guests" })),
        )
            .into_response();
    }

    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let is_form = content_type
        .to_ascii_lowercase()
        .contains("application/x-www-form-urlencoded");

    let body_str = std::str::from_utf8(&body).unwrap_or("");
    let Some(incoming) = parse_write_body(content_type, body_str) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing values" })),
        )
            .into_response();
    };

    let mut current = read_overrides(&state);
    for (key, value) in incoming {
        if !is_allowed(&key) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Unknown or forbidden setting key: {key}") })),
            )
                .into_response();
        }
        match value {
            None => {
                current.remove(&key);
            }
            Some(v) => {
                current.insert(key, v);
            }
        }
    }

    if let Err(e) = write_overrides(&state, &current) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Write failed: {e}") })),
        )
            .into_response();
    }

    if is_form {
        // Form POST → redirect back to /settings (the Node version returned
        // 302 + Location with a JSON body; we match that for parity with
        // existing callers, including the Rex client adapter).
        let mut response =
            (StatusCode::FOUND, Json(json!({ "ok": true }))).into_response();
        response.headers_mut().insert(
            axum::http::header::LOCATION,
            axum::http::HeaderValue::from_static("/settings"),
        );
        return response;
    }

    (
        StatusCode::OK,
        [("cache-control", "private, no-store")],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

// ── /api/recipe-api-key ──

pub async fn recipe_api_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !is_owner(&headers) {
        return (
            StatusCode::OK,
            [("cache-control", "private, no-store")],
            Json(json!({ "key": Value::Null })),
        )
            .into_response();
    }
    // Check overrides first, then env. settings-write may have updated
    // RECIPE_API_KEY since process startup.
    let overrides = read_overrides(&state);
    let key = overrides
        .get("RECIPE_API_KEY")
        .cloned()
        .or_else(|| state.config.recipe_api_key.clone());
    (
        StatusCode::OK,
        [("cache-control", "private, no-store")],
        Json(json!({ "key": key })),
    )
        .into_response()
}
