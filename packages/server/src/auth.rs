//! Shared owner-vs-guest predicate for `/api/*` routes.
//!
//! Mirrors the frontend's `lib/isTrustedNetwork.ts` model so the two
//! sides agree on who can read/write owner-gated state:
//!   - Loopback hosts (same machine as the server) → owner.
//!   - Forwarded HTTPS (e.g. behind Caddy / Tailscale Serve) → owner.
//!   - `PANTRY_TRUST_LAN=true` → every LAN visitor → owner. Matches the
//!     `<meta name="trust-lan">` flag the SPA shell emits when this env
//!     var is set; without this branch the React UI would offer write
//!     actions that the backend then 403s.
//!
//! Threat model is intentionally identical to the frontend's: anyone on
//! the LAN of a `PANTRY_TRUST_LAN=true` deployment is treated as the
//! owner. Suitable for a single-user home device; not for a multi-tenant
//! deployment, which would terminate HTTPS and skip the env var.

use axum::http::HeaderMap;

pub fn is_owner(headers: &HeaderMap) -> bool {
    is_loopback(headers) || is_forwarded_https(headers) || is_trust_lan_enabled()
}

fn is_loopback(headers: &HeaderMap) -> bool {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let hostname = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(&host)
        .trim_start_matches('[')
        .trim_end_matches(']');
    hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
}

fn is_forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|p| p.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

fn is_trust_lan_enabled() -> bool {
    std::env::var("PANTRY_TRUST_LAN")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
}
