//! Bluesky / AT Protocol integration.
//!
//! Browse-only today: capture the user's handle in setup so the rest of
//! the app can identify them on the AT network (e.g. "my recipes on the
//! feed"). No app password, no publish — that arrives when there's a
//! publish surface to wire it into.
//!
//! State machine surfaced to the SPA (see `routes::bluesky`):
//!
//! ```text
//!   NotConfigured                              (no handle stored)
//!   Configured { handle, did }                 (handle resolved to a DID)
//! ```
//!
//! Storage piggybacks on the same overrides file that `routes::settings`
//! uses, but the keys (`BLUESKY_HANDLE`, `BLUESKY_DID`) are *not* in the
//! `SETTINGS` allowlist. Only this module's `/api/bluesky/connect` route
//! ever writes them, so a LAN guest can't poke a fake handle through
//! the generic `/api/settings-write` surface.
//!
//! Handle resolution uses `bsky.social`'s public XRPC endpoint — same
//! pattern as `packages/shared/src/bluesky.ts`. We never store an app
//! password; if the resolve succeeds the handle exists on the network
//! and that's enough for the browse-only integration.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::routes::settings::{read_overrides, write_overrides};
use crate::AppState;

const HANDLE_KEY: &str = "BLUESKY_HANDLE";
const DID_KEY: &str = "BLUESKY_DID";

/// Public-facing bluesky state returned by /api/bluesky/status (and
/// folded into /api/setup-status). Snake-case tag for parity with
/// TailscaleState.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BlueskyState {
    NotConfigured,
    Configured { handle: String, did: String },
}

/// Read the current bluesky state from the overrides file. Cheap (one
/// JSON read); safe to call from any handler. Returns NotConfigured if
/// either key is missing — partial state shouldn't surface to the UI.
pub fn read_status(state: &AppState) -> BlueskyState {
    let overrides = read_overrides(state);
    match (overrides.get(HANDLE_KEY), overrides.get(DID_KEY)) {
        (Some(handle), Some(did)) if !handle.is_empty() && !did.is_empty() => {
            BlueskyState::Configured {
                handle: handle.clone(),
                did: did.clone(),
            }
        }
        _ => BlueskyState::NotConfigured,
    }
}

/// Strip a leading `@` from a handle. `you.bsky.social` and `@you.bsky.social`
/// should both resolve.
fn normalize_handle(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_string()
}

/// Validate `handle` by calling `com.atproto.identity.resolveHandle` and
/// persisting the resulting DID. Returns the new state for the UI to
/// short-circuit its first poll.
///
/// `http` is the shared `reqwest::Client` from AppState so we reuse the
/// connection pool + rustls roots rather than spinning up a one-shot
/// client per request.
pub async fn connect(
    state: &Arc<AppState>,
    http: &reqwest::Client,
    raw_handle: &str,
) -> anyhow::Result<BlueskyState> {
    let handle = normalize_handle(raw_handle);
    if handle.is_empty() {
        anyhow::bail!("handle is empty");
    }

    // bsky.social hosts the universal handle resolver — see
    // packages/shared/src/bluesky.ts:HANDLE_RESOLVER_BASE for the same
    // choice on the TS side.
    let url = format!(
        "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle={}",
        urlencoding(&handle),
    );
    let res = http.get(&url).send().await?;
    if !res.status().is_success() {
        anyhow::bail!("could not resolve handle @{handle}");
    }

    #[derive(Deserialize)]
    struct ResolveResp {
        did: String,
    }
    let body: ResolveResp = res.json().await?;
    let did = body.did;

    // Persist into the overrides file. We rewrite both keys together so
    // a partial-write can't leave handle without DID (or vice versa).
    let mut overrides: BTreeMap<String, String> = read_overrides(state);
    overrides.insert(HANDLE_KEY.to_string(), handle.clone());
    overrides.insert(DID_KEY.to_string(), did.clone());
    write_overrides(state, &overrides)?;

    Ok(BlueskyState::Configured { handle, did })
}

/// Clear the persisted handle + DID. No-op if nothing was stored.
pub fn disconnect(state: &Arc<AppState>) -> anyhow::Result<BlueskyState> {
    let mut overrides = read_overrides(state);
    overrides.remove(HANDLE_KEY);
    overrides.remove(DID_KEY);
    write_overrides(state, &overrides)?;
    Ok(BlueskyState::NotConfigured)
}

/// Minimal application/x-www-form-urlencoded encoder for the handle
/// query param — `urlencoding` crate would be a one-line dep but the
/// handle character set is narrow enough that a hand-rolled encoder
/// keeps the dep tree leaner. Mirrors the same logic in `routes::settings`.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
