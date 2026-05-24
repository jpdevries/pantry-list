//! Tailscale integration: boot-time probe + status/connect/serve helpers.
//!
//! At startup we run `tailscale --version` once and stash the result in
//! [`TailscaleInfo`]. If the binary is missing, every downstream operation
//! short-circuits to `Unavailable` and the installer UI degrades to the
//! "tailscaled not detected" path.
//!
//! State machine surfaced to the SPA (see `routes::tailscale`):
//!
//! ```text
//!   Unavailable                       (no binary)
//!   NotConnected                      (binary present, BackendState != Running)
//!   AwaitingAuth { auth_url, .. }     (tailscale up in flight, login URL captured)
//!   ConnectedNoServe { tailnet }      (Running, but serve doesn't expose our port)
//!   Configured { url, tailnet }       (Running + serve exposes :443 → 127.0.0.1:$port)
//! ```
//!
//! We never call `tailscale up` synchronously — login can take a human
//! minute to complete. `start_connect` spawns a child, captures stderr to
//! pull out the login URL, and updates a shared `ConnectState` so the UI
//! can poll. See `routes::tailscale` for the HTTP plumbing.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// Resolved tailscale binary location + version string, captured once at boot.
/// `None` everywhere if the binary isn't on PATH.
#[derive(Debug, Clone)]
pub struct TailscaleInfo {
    pub path: PathBuf,
    pub version: String,
}

impl TailscaleInfo {
    /// Look up the binary and run `--version`. Returns `None` if either
    /// fails — we treat any failure as "not installed" rather than
    /// surfacing the error, since the installer just needs to know
    /// whether the integration is available.
    pub fn probe() -> Option<Self> {
        let path = which_tailscale()?;
        let version = Command::new(&path)
            .arg("--version")
            .output()
            .ok()
            .and_then(|out| {
                if !out.status.success() {
                    return None;
                }
                // First line of `tailscale --version` is the short version,
                // e.g. "1.96.5". Subsequent lines are commit/go metadata
                // we don't care about.
                let s = String::from_utf8_lossy(&out.stdout).to_string();
                s.lines().next().map(|l| l.trim().to_string())
            })?;
        Some(TailscaleInfo { path, version })
    }
}

fn which_tailscale() -> Option<PathBuf> {
    // `which` shells out to PATH; portable enough for macOS + Linux which
    // is everything we care about (Pi + dev). Could grow into a manual
    // PATH walk if we ever ship to a system without `which`, but the Pi
    // images we target all have it.
    let out = Command::new("which").arg("tailscale").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

/// Shared in-process state for an in-flight `tailscale up` invocation.
///
/// Held behind a `Mutex` on AppState. There's only ever one connect flow
/// running at a time (the UI is a single wizard step) so we don't bother
/// with a richer concurrency model.
#[derive(Debug, Default, Clone)]
pub struct ConnectState {
    /// Login URL parsed out of `tailscale up`'s stderr, once it appears.
    /// `None` between "we kicked off `up`" and "stderr produced a URL".
    pub auth_url: Option<String>,
    /// Last status line from the child (for debug/UI text).
    pub last_message: Option<String>,
    /// True while the child is alive.
    pub in_flight: bool,
}

pub type ConnectStateHandle = Arc<Mutex<ConnectState>>;

/// Public-facing tailscale state returned by /api/tailscale/status (and
/// folded into /api/setup-status).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TailscaleState {
    Unavailable {
        reason: String,
    },
    NotConnected,
    AwaitingAuth {
        auth_url: String,
    },
    ConnectedNoServe {
        tailnet: String,
    },
    Configured {
        url: String,
        tailnet: String,
    },
}

/// Subset of `tailscale status --json` we care about. The full schema is
/// huge and version-volatile; only pull what we need.
#[derive(Debug, Deserialize)]
struct StatusJson {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: Option<SelfNode>,
    #[serde(rename = "MagicDNSSuffix", default)]
    magic_dns_suffix: String,
}

#[derive(Debug, Deserialize)]
struct SelfNode {
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "HostName", default)]
    host_name: String,
}

/// Subset of `tailscale serve status --json`. Layout (as of 1.x):
/// `{ "TCP": {"443": {"HTTPS": true}}, "Web": {"<host>:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:4001"}}}} }`.
/// We only need to know whether *some* handler proxies our local port.
#[derive(Debug, Deserialize, Default)]
struct ServeStatusJson {
    #[serde(rename = "Web", default)]
    web: serde_json::Map<String, serde_json::Value>,
}

/// Synchronously read tailscale's current state. Safe to call from a
/// blocking context (uses `Command::output`); axum handlers should wrap
/// it in `tokio::task::spawn_blocking`.
pub fn read_status(
    info: Option<&TailscaleInfo>,
    connect: &ConnectStateHandle,
    graphql_port: u16,
) -> TailscaleState {
    let Some(info) = info else {
        return TailscaleState::Unavailable {
            reason: "tailscale binary not found on PATH".to_string(),
        };
    };

    // If a `tailscale up` flow is in flight and produced a login URL,
    // surface it regardless of what `status` says — the user is mid-login
    // and we want the UI to keep showing the link until backend flips to
    // Running.
    {
        let guard = connect.lock().expect("connect state mutex poisoned");
        if let (true, Some(url)) = (guard.in_flight, guard.auth_url.clone()) {
            return TailscaleState::AwaitingAuth { auth_url: url };
        }
    }

    let status: StatusJson = match run_json(&info.path, &["status", "--json"]) {
        Ok(v) => v,
        Err(_) => return TailscaleState::NotConnected,
    };

    if status.backend_state != "Running" {
        return TailscaleState::NotConnected;
    }

    let tailnet = pretty_tailnet(&status);
    let serve_url = check_serve(&info.path, graphql_port, &status);

    match serve_url {
        Some(url) => TailscaleState::Configured { url, tailnet },
        None => TailscaleState::ConnectedNoServe { tailnet },
    }
}

fn pretty_tailnet(s: &StatusJson) -> String {
    // Prefer the MagicDNS hostname (`pantry-host.tail-1234.ts.net`) when
    // available; fall back to the bare hostname for self-hosted control
    // planes that don't run MagicDNS.
    if let Some(self_node) = &s.self_node {
        if !self_node.dns_name.is_empty() {
            return self_node.dns_name.trim_end_matches('.').to_string();
        }
        if !self_node.host_name.is_empty() && !s.magic_dns_suffix.is_empty() {
            return format!(
                "{}.{}",
                self_node.host_name,
                s.magic_dns_suffix.trim_end_matches('.')
            );
        }
        if !self_node.host_name.is_empty() {
            return self_node.host_name.clone();
        }
    }
    s.magic_dns_suffix.trim_end_matches('.').to_string()
}

fn check_serve(bin: &std::path::Path, graphql_port: u16, s: &StatusJson) -> Option<String> {
    let serve: ServeStatusJson = run_json(bin, &["serve", "status", "--json"]).ok()?;
    let needle = format!("http://127.0.0.1:{graphql_port}");
    // Each `Web` entry is keyed by `<host>:<port>` and has a Handlers map
    // of `<path>` → `{ Proxy: "..." }`. Walk both layers looking for a
    // proxy that points at our local port.
    for (host_key, val) in serve.web.iter() {
        let handlers = val.get("Handlers")?.as_object()?;
        for (_path, h) in handlers.iter() {
            let proxy = h.get("Proxy").and_then(|v| v.as_str()).unwrap_or("");
            if proxy == needle {
                // Found it. Compose the user-facing URL from the host key
                // (e.g. `pantry-host.tail-1234.ts.net:443`) + the tailnet
                // suffix as a fallback.
                let host = host_key.split(':').next().unwrap_or(host_key);
                if !host.is_empty() {
                    return Some(format!("https://{host}"));
                }
                let tn = pretty_tailnet(s);
                if !tn.is_empty() {
                    return Some(format!("https://{tn}"));
                }
            }
        }
    }
    None
}

fn run_json<T: for<'de> Deserialize<'de>>(
    bin: &std::path::Path,
    args: &[&str],
) -> anyhow::Result<T> {
    let out = Command::new(bin).args(args).output()?;
    if !out.status.success() {
        anyhow::bail!(
            "{} {:?} exited {}",
            bin.display(),
            args,
            out.status.code().unwrap_or(-1)
        );
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

/// Spawn `tailscale up` in the background. Captures stderr (where the login
/// URL is printed) and updates `connect` as the URL appears and as the
/// child eventually exits.
///
/// Idempotent: if a connect is already in flight, this is a no-op. If
/// tailscale is already in `Running` state, `up` returns immediately with
/// no URL — the caller should call `read_status` afterward to confirm.
///
/// Returns immediately after spawning; reading stderr happens on a
/// background thread (cheap — one thread per connect attempt, which the
/// UI rate-limits to one at a time).
pub fn start_connect(info: &TailscaleInfo, connect: &ConnectStateHandle, hostname: &str) {
    {
        let mut guard = connect.lock().expect("connect state mutex poisoned");
        if guard.in_flight {
            return;
        }
        // Fresh attempt: clear any URL from a prior cancelled flow.
        guard.auth_url = None;
        guard.last_message = None;
        guard.in_flight = true;
    }

    let bin = info.path.clone();
    let hostname = hostname.to_string();
    let connect = Arc::clone(connect);

    std::thread::spawn(move || {
        let child = Command::new(&bin)
            .args(["up", "--hostname", &hostname, "--timeout", "0s"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let mut guard = connect.lock().expect("connect state mutex poisoned");
                guard.in_flight = false;
                guard.last_message = Some(format!("failed to spawn tailscale: {e}"));
                tracing::warn!("tailscale up spawn failed: {e}");
                return;
            }
        };

        // Stream stderr line-by-line. `tailscale up` prints something like:
        //   "To authenticate, visit:\n\n        https://login.tailscale.com/a/XXXXXXXX\n\n"
        // We capture the first URL we see and stash it for the UI.
        if let Some(stderr) = child.stderr.take() {
            let connect_for_thread = Arc::clone(&connect);
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if let Some(url) = extract_login_url(&line) {
                        let mut guard = connect_for_thread
                            .lock()
                            .expect("connect state mutex poisoned");
                        if guard.auth_url.is_none() {
                            tracing::info!("tailscale login URL captured");
                            guard.auth_url = Some(url);
                        }
                    }
                    let mut guard = connect_for_thread
                        .lock()
                        .expect("connect state mutex poisoned");
                    guard.last_message = Some(line);
                }
            });
        }

        // Wait for the child. `tailscale up` blocks until either auth
        // succeeds or it errors out — we don't impose a timeout because
        // the human user is the rate-limiting step.
        let exit = child.wait();
        let mut guard = connect.lock().expect("connect state mutex poisoned");
        guard.in_flight = false;
        guard.auth_url = None;
        match exit {
            Ok(s) if s.success() => {
                guard.last_message = Some("Tailscale connected.".to_string());
            }
            Ok(s) => {
                guard.last_message = Some(format!(
                    "tailscale up exited with code {}",
                    s.code().unwrap_or(-1)
                ));
            }
            Err(e) => {
                guard.last_message = Some(format!("tailscale up wait failed: {e}"));
            }
        }
    });
}

fn extract_login_url(line: &str) -> Option<String> {
    // tailscale prints the URL on its own line, indented with spaces.
    // Match the first `https://` token to be tolerant of upstream format
    // tweaks across versions.
    let idx = line.find("https://")?;
    let tail = &line[idx..];
    let end = tail
        .find(|c: char| c.is_whitespace())
        .unwrap_or(tail.len());
    Some(tail[..end].to_string())
}

/// Enable `tailscale serve --bg --https=443` proxying to the local
/// GraphQL port. Synchronous + blocking; wrap in `spawn_blocking` from
/// async contexts. Returns the updated TailscaleState so the caller can
/// hand it back to the UI in one round trip.
pub fn enable_serve(info: &TailscaleInfo, graphql_port: u16) -> anyhow::Result<()> {
    let out = Command::new(&info.path)
        .args([
            "serve",
            "--bg",
            "--https=443",
            &format!("http://127.0.0.1:{graphql_port}"),
        ])
        .output()?;
    if !out.status.success() {
        anyhow::bail!(
            "tailscale serve failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}
