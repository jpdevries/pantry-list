//! Embedded SPA frontend.
//!
//! The Rex production build (`packages/app/.rex/build/client/`) gives us
//! per-page JS chunks + a global CSS bundle, but no usable HTML shell —
//! `rex export` hangs (the V8 server bundle can't `require('node:sqlite')`
//! at SSR time) and `rex start` needs the same V8 runtime. So we treat the
//! frontend as a pure client-side SPA: bake `client/*` + `public/*` into
//! the binary with `rust-embed`, parse Rex's `manifest.json` at startup,
//! and generate an HTML shell per request based on which `pages` entry
//! matches the URL.
//!
//! Bootstrapping (mirrors what `rex start` would emit):
//!   1. `<div id="__rex">` — the React hydration target.
//!   2. `<script id="__REX_DATA__" type="application/json">{}</script>` —
//!      pageProps. Empty in our case (no SSR data; pages fetch client-side).
//!   3. `<script type="module" src="…/{app_script}">` — sets
//!      `window.__REX_APP__`.
//!   4. `<script type="module" src="…/{page_js}">` — sets
//!      `window.__REX_PAGES[path] = {default: PageComponent}` and calls
//!      `hydrateRoot(#__rex, …)`.
//!
//! Module scripts execute in source order, so `_app` runs before the page
//! bundle and `__REX_APP__` is defined by the time the page bundle hydrates.
//!
//! Per-chunk relative imports (`./chunk-foo.js` from inside a bundle)
//! resolve against the script's own URL — so every chunk must live at the
//! same URL prefix. We use Rex's convention, `/_rex/static/`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::OnceLock;

use axum::{
    extract::Path,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::Embed;
use serde::Deserialize;

/// Per-page JS bundles + shared chunks + global CSS, produced by
/// `rex build` and copied to `static/client/` before `cargo build`.
#[derive(Embed)]
#[folder = "static/client/"]
#[exclude = ".gitkeep"]
#[exclude = "*.map"]
struct ClientAssets;

/// `packages/app/public/` mirrored in: favicon, manifest, sw.js, app icons.
/// Served from the URL root (`/sw.js`, `/manifest.json`, etc.).
#[derive(Embed)]
#[folder = "static/public/"]
#[exclude = ".gitkeep"]
#[exclude = "uploads/**"]
struct PublicAssets;

#[derive(Deserialize, Debug)]
struct RawManifest {
    build_id: String,
    pages: HashMap<String, RawPage>,
    app_script: String,
    global_css: Vec<String>,
}

#[derive(Deserialize, Debug)]
struct RawPage {
    js: String,
}

/// Parsed manifest with pages pre-sorted by specificity so route matching is
/// just a linear walk.
pub struct Manifest {
    build_hash: String,        // first 8 chars of build_id; matches the
                               // hash embedded in chunk filenames.
    app_script: String,        // `_app-<hash>.js`
    global_css: Vec<String>,   // `globals-<hash>-<rev>.css`
    pages: Vec<RoutePage>,     // sorted: more-literal segments first.
    pages_by_path: HashMap<String, usize>, // exact-path -> index into pages.
}

struct RoutePage {
    pattern: String, // e.g. `/recipes/:slug`, `/at/*path`, `/list`
    js: String,      // e.g. `recipes-_slug_-7d06ebbd.js`
    segments: Vec<Seg>,
    /// Number of literal (non-:param, non-*splat) segments. Used to break ties
    /// between overlapping patterns: a request for `/menus/feeds/bluesky`
    /// should pick the literal `/menus/feeds/bluesky` page, not `/menus/:slug`.
    literal_count: usize,
}

enum Seg {
    Literal(String),
    Param,    // `:name` — matches one segment
    Splat,    // `*name` — matches all remaining segments (greedy, must be last)
}

static MANIFEST: OnceLock<Option<Manifest>> = OnceLock::new();

/// Parse + cache the manifest on first call. Returns None when no frontend
/// has been embedded (empty `static/`), in which case the server still runs
/// — it just serves a placeholder shell.
fn manifest() -> Option<&'static Manifest> {
    MANIFEST
        .get_or_init(|| {
            let raw = ClientAssets::get("manifest.json")
                .or_else(|| {
                    // Some Rex versions place the manifest at the build root,
                    // not inside client/. Try the public side too.
                    PublicAssets::get("manifest.json")
                })?;
            let parsed: RawManifest = serde_json::from_slice(&raw.data).ok()?;
            let build_hash = parsed.build_id.chars().take(8).collect::<String>();

            let mut pages: Vec<RoutePage> = parsed
                .pages
                .into_iter()
                .map(|(pattern, page)| {
                    let segments: Vec<Seg> = pattern
                        .split('/')
                        .filter(|s| !s.is_empty())
                        .map(|s| {
                            if let Some(name) = s.strip_prefix(':') {
                                let _ = name;
                                Seg::Param
                            } else if s.starts_with('*') || s.starts_with("[...") {
                                Seg::Splat
                            } else {
                                Seg::Literal(s.to_string())
                            }
                        })
                        .collect();
                    let literal_count = segments
                        .iter()
                        .filter(|s| matches!(s, Seg::Literal(_)))
                        .count();
                    RoutePage {
                        pattern,
                        js: page.js,
                        segments,
                        literal_count,
                    }
                })
                .collect();
            // Sort by literal-count desc, then segment-count desc — picks the
            // most-specific pattern when several match the same URL.
            pages.sort_by(|a, b| {
                b.literal_count
                    .cmp(&a.literal_count)
                    .then(b.segments.len().cmp(&a.segments.len()))
            });

            let pages_by_path: HashMap<String, usize> = pages
                .iter()
                .enumerate()
                .filter(|(_, p)| p.segments.iter().all(|s| matches!(s, Seg::Literal(_))))
                .map(|(i, p)| (p.pattern.clone(), i))
                .collect();

            Some(Manifest {
                build_hash,
                app_script: parsed.app_script,
                global_css: parsed.global_css,
                pages,
                pages_by_path,
            })
        })
        .as_ref()
}

fn match_pattern(segments: &[Seg], url_segs: &[&str]) -> bool {
    let mut i = 0;
    while i < segments.len() {
        match &segments[i] {
            Seg::Splat => return true, // greedy — eats the rest.
            Seg::Param => {
                if i >= url_segs.len() {
                    return false;
                }
            }
            Seg::Literal(lit) => {
                if i >= url_segs.len() || url_segs[i] != lit {
                    return false;
                }
            }
        }
        i += 1;
    }
    i == url_segs.len()
}

fn find_page<'a>(manifest: &'a Manifest, path: &str) -> Option<&'a RoutePage> {
    // Normalize: strip trailing slash (except for the root) before lookup.
    let path = path.trim_end_matches('/');
    let lookup = if path.is_empty() { "/" } else { path };
    if let Some(&idx) = manifest.pages_by_path.get(lookup) {
        return Some(&manifest.pages[idx]);
    }
    let url_segs: Vec<&str> = lookup.split('/').filter(|s| !s.is_empty()).collect();
    manifest
        .pages
        .iter()
        .find(|p| match_pattern(&p.segments, &url_segs))
}

fn shell_html(manifest: &Manifest, page_js: &str, default_palette: Option<&str>) -> String {
    let css_links: String = manifest
        .global_css
        .iter()
        .map(|css| {
            format!(
                "<link rel=\"stylesheet\" href=\"/_rex/static/{}\">",
                html_escape_attr(css)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let palette_meta = default_palette
        .map(|p| {
            format!(
                "<meta name=\"default-palette\" content=\"{}\">",
                html_escape_attr(p)
            )
        })
        .unwrap_or_default();
    // The theme-init inline script is a near-verbatim copy of the one in
    // packages/app/pages/_document.tsx: applies localStorage-backed theme
    // pre-paint to avoid a flash of unstyled content.
    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Cache-Control" content="no-cache, must-revalidate">
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<meta name="theme-color" content="#f4f4f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="no">
<meta name="mobile-web-app-capable" content="no">
<meta name="apple-mobile-web-app-title" content="Pantry Host">
<meta name="build-hash" content="{build_hash}">
{palette_meta}
{css_links}
<title>Pantry Host</title>
</head>
<body>
<script>(function(){{if(typeof localStorage==='undefined')return;try{{var b=document.body,t=localStorage.getItem('theme-preference')||'system',hcStored=localStorage.getItem('high-contrast'),hc=hcStored!==null?hcStored==='true':matchMedia('(prefers-contrast:more)').matches,p=localStorage.getItem('theme-palette');if(!p){{var m=document.querySelector('meta[name="default-palette"]');if(m)p=m.getAttribute('content')}}if(t!=='system')b.dataset.colorScheme=t;if(hc)b.dataset.highContrast='';if(p&&p!=='default')b.dataset.theme=p;var dark=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);b.style.colorScheme=dark?'dark':'light'}}catch(e){{}}}})()</script>
<div id="__rex"></div>
<script id="__REX_DATA__" type="application/json">{{}}</script>
<script type="module" src="/_rex/static/{app_script}"></script>
<script type="module" src="/_rex/static/{page_js}"></script>
</body>
</html>"##,
        build_hash = html_escape_attr(&manifest.build_hash),
        palette_meta = palette_meta,
        css_links = css_links,
        app_script = html_escape_attr(&manifest.app_script),
        page_js = html_escape_attr(page_js),
    )
}

fn placeholder_html() -> String {
    r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pantry Host (frontend not built)</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#27272a}code{background:#f4f4f5;padding:0.1rem 0.4rem;border-radius:0.25rem}</style>
</head>
<body>
<h1>Pantry Host</h1>
<p>The GraphQL API is up at <code>/graphql</code>, but no frontend has been embedded into this binary.</p>
<p>Build it locally:</p>
<pre><code>cd packages/app &amp;&amp; npm run build
packages/server/scripts/sync-frontend.sh
cargo build --release -p pantry-server</code></pre>
</body>
</html>"##
        .to_string()
}

/// Plain HTTP response for an embedded asset, with a content-type derived
/// from the file extension.
fn embedded_response(path: &str, data: Cow<'static, [u8]>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = (StatusCode::OK, data.into_owned()).into_response();
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    // Rex JS/CSS chunks have hash-suffixed filenames and are immutable.
    // Long-cache them with `immutable` so the SW + browser don't refetch
    // on every page navigation. Other public assets (favicon, manifest, sw.js)
    // get a short cache since their URLs are stable across deploys.
    let cache_value = if path.ends_with(".js") || path.ends_with(".css") || path.contains("-7") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=300"
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_value),
    );
    response
}

/// `GET /_rex/static/{file}` — Rex client bundles + shared chunks + CSS.
pub async fn serve_client(Path(path): Path<String>) -> Response {
    if let Some(asset) = ClientAssets::get(&path) {
        return embedded_response(&path, asset.data);
    }
    StatusCode::NOT_FOUND.into_response()
}

/// `GET /<file>` (when `<file>` matches a public asset name) — sw.js,
/// favicon.ico, manifest.json, icon-*.png, etc. Falls through to the SPA
/// shell handler when no match. Looks up the file by stripping the leading
/// '/' from the URL path.
fn try_serve_public(uri: &Uri) -> Option<Response> {
    let path = uri.path().trim_start_matches('/');
    if path.is_empty() {
        return None;
    }
    PublicAssets::get(path).map(|asset| embedded_response(path, asset.data))
}

/// Catch-all GET handler: serves either a public file (sw.js, favicon, …)
/// or the SPA shell with the page bundle that matches the URL.
pub async fn serve_spa(uri: Uri) -> Response {
    if let Some(response) = try_serve_public(&uri) {
        return response;
    }
    let Some(manifest) = manifest() else {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))],
            placeholder_html(),
        )
            .into_response();
    };
    let path = uri.path();
    let page_js = find_page(manifest, path)
        // Unmatched URL: fall back to the home page bundle. The home page
        // renders, and the client-side _app's effect can choose to handle
        // 404-ness once it sees that no page-specific data loads.
        .or_else(|| find_page(manifest, "/"))
        .map(|p| p.js.as_str())
        .unwrap_or("");

    let default_palette = std::env::var("DEFAULT_THEME").ok();
    let html = shell_html(manifest, page_js, default_palette.as_deref());
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))],
        html,
    )
        .into_response()
}

fn html_escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pat(s: &str) -> Vec<Seg> {
        s.split('/')
            .filter(|p| !p.is_empty())
            .map(|p| {
                if let Some(_n) = p.strip_prefix(':') {
                    Seg::Param
                } else if p.starts_with('*') {
                    Seg::Splat
                } else {
                    Seg::Literal(p.to_string())
                }
            })
            .collect()
    }

    fn segs(url: &str) -> Vec<&str> {
        url.split('/').filter(|s| !s.is_empty()).collect()
    }

    #[test]
    fn exact_match() {
        assert!(match_pattern(&pat("/recipes/import"), &segs("/recipes/import")));
        assert!(!match_pattern(&pat("/recipes/import"), &segs("/recipes")));
    }

    #[test]
    fn param_match() {
        assert!(match_pattern(&pat("/recipes/:slug"), &segs("/recipes/foo")));
        assert!(!match_pattern(&pat("/recipes/:slug"), &segs("/recipes/foo/bar")));
    }

    #[test]
    fn splat_match() {
        assert!(match_pattern(&pat("/at/*path"), &segs("/at/did/foo/bar")));
        assert!(match_pattern(&pat("/at/*path"), &segs("/at/one")));
    }
}
