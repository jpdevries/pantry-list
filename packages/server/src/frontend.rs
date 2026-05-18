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
use std::sync::Arc;
use std::sync::OnceLock;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::Embed;
use serde::Deserialize;

use crate::db::Pool;
use crate::AppState;

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

/// Open Graph + page-title injection for detail-page URLs. Looked up at
/// request time from SQLite so the SPA shell ships with real
/// Bluesky / iMessage / Twitter link-preview metadata without a per-route
/// server-rendered React pass. Same shape the Rex `<Head>` tag emitted in
/// `getServerSideProps` mode.
#[derive(Default)]
pub struct OgMeta {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    /// `og:type` — "article" for recipes, "website" for menus (mirrors the
    /// existing Rex Head tags). Empty = "website" default.
    pub og_type: Option<&'static str>,
}

fn shell_html(
    manifest: &Manifest,
    page_js: &str,
    default_palette: Option<&str>,
    trust_lan: bool,
    og: &OgMeta,
) -> String {
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
    // `trust-lan` opts every LAN visitor into owner-mode (Add/Edit/Delete/etc.)
    // — see `isOwner()` in packages/app/lib/isTrustedNetwork.ts. Default off;
    // the Pi deployment sets `PANTRY_TRUST_LAN=true` because it's single-user.
    let trust_lan_meta = if trust_lan {
        "<meta name=\"trust-lan\" content=\"true\">"
    } else {
        ""
    };
    // Render the open-graph block. Matches the tags packages/app/pages/
    // recipes/[slug].tsx + menus/[slug].tsx emit via <Head>, so scrapers
    // (Bluesky, iMessage, etc.) see the same preview metadata they got
    // from the Rex SSR build.
    let (title_html, og_meta_html) = render_og(og);
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
{trust_lan_meta}
{css_links}
{title_html}
{og_meta_html}
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
        trust_lan_meta = trust_lan_meta,
        css_links = css_links,
        title_html = title_html,
        og_meta_html = og_meta_html,
        app_script = html_escape_attr(&manifest.app_script),
        page_js = html_escape_attr(page_js),
    )
}

/// Produce the `<title>` element + the og:* / twitter:card / description
/// `<meta>` tags. Returns ("<title>...</title>", "<meta>...") when an OG
/// payload is present, falls back to a generic Pantry Host title otherwise.
fn render_og(og: &OgMeta) -> (String, String) {
    let raw_title = og.title.as_deref().unwrap_or("");
    let title_text = if raw_title.is_empty() {
        "Pantry Host".to_string()
    } else {
        format!("{raw_title} — Pantry Host")
    };
    let title_html = format!("<title>{}</title>", html_escape_attr(&title_text));

    if og.title.is_none() && og.description.is_none() && og.image.is_none() {
        return (title_html, String::new());
    }
    let og_type = og.og_type.unwrap_or("website");
    let mut metas = String::new();
    metas.push_str(&format!(
        "<meta property=\"og:title\" content=\"{}\">\n",
        html_escape_attr(&title_text)
    ));
    metas.push_str(&format!(
        "<meta property=\"og:type\" content=\"{}\">\n",
        html_escape_attr(og_type)
    ));
    if let Some(d) = og.description.as_deref().filter(|s| !s.is_empty()) {
        metas.push_str(&format!(
            "<meta property=\"og:description\" content=\"{}\">\n",
            html_escape_attr(d)
        ));
        metas.push_str(&format!(
            "<meta name=\"description\" content=\"{}\">\n",
            html_escape_attr(d)
        ));
    }
    if let Some(img) = og.image.as_deref().filter(|s| !s.is_empty()) {
        metas.push_str(&format!(
            "<meta property=\"og:image\" content=\"{}\">\n",
            html_escape_attr(img)
        ));
    }
    let twitter = if og.image.as_deref().filter(|s| !s.is_empty()).is_some() {
        "summary_large_image"
    } else {
        "summary"
    };
    metas.push_str(&format!(
        "<meta name=\"twitter:card\" content=\"{twitter}\">"
    ));
    (title_html, metas)
}

/// Inspect the URL path; if it matches one of the detail-page patterns
/// that the Rex `<Head>` previously populated via `getServerSideProps`,
/// fetch the matching row from SQLite and return its OG metadata.
///
/// Patterns handled (slug is the last segment):
///   /recipes/:slug
///   /menus/:slug
///   /kitchens/:kitchen/recipes/:slug
///   /kitchens/:kitchen/menus/:slug
///
/// Returns `None` for any URL that doesn't match (no DB hit, no extra cost
/// on the SPA hot path). Returns `Some(OgMeta::default())` on a DB miss so
/// the caller can still render the shell without crashing.
async fn lookup_og_meta(state: &AppState, headers: &HeaderMap, path: &str) -> Option<OgMeta> {
    // Reserved segments that are explicit page bundles, not slug values.
    const RESERVED: &[&str] = &["new", "import", "export", "feeds", "edit"];
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (table, slug): (&str, &str) = match segs.as_slice() {
        ["recipes", slug] if !RESERVED.contains(slug) => ("recipes", slug),
        ["menus", slug] if !RESERVED.contains(slug) => ("menus", slug),
        ["kitchens", _, "recipes", slug] if !RESERVED.contains(slug) => ("recipes", slug),
        ["kitchens", _, "menus", slug] if !RESERVED.contains(slug) => ("menus", slug),
        _ => return None,
    };
    let pool = state.pool.clone();
    let slug_owned = slug.to_string();
    let table_owned = table.to_string();
    let row = tokio::task::spawn_blocking(move || lookup_row(&pool, &table_owned, &slug_owned))
        .await
        .ok()
        .and_then(|r| r.ok())
        .flatten();
    let mut meta = OgMeta {
        og_type: Some(if table == "recipes" { "article" } else { "website" }),
        ..OgMeta::default()
    };
    if let Some((title, description, photo_url)) = row {
        meta.title = title;
        meta.description = description;
        meta.image = photo_url.map(|p| absolutize_url(&p, headers));
    }
    Some(meta)
}

fn lookup_row(
    pool: &Pool,
    table: &str,
    slug: &str,
) -> rusqlite::Result<Option<(Option<String>, Option<String>, Option<String>)>> {
    let conn = pool.get().map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e.to_string())))
    })?;
    // Recipes have their own photo_url column. Menus don't — the schema
    // doesn't carry one — so we LEFT JOIN to menu_recipes -> recipes and
    // pick the first linked recipe's photo. Same fallback the Node
    // packages/app/pages/menus/[slug].tsx did via
    //   'query($id:String!){menu(id:$id){title description recipes{photoUrl}}}'
    // ⊕ `initialPhoto = recipes[0]?.photoUrl`.
    let sql = match table {
        "recipes" => "SELECT title, description, photo_url FROM recipes WHERE slug = ?1",
        "menus" => {
            "SELECT m.title, m.description, \
                    (SELECT r.photo_url FROM recipes r \
                       JOIN menu_recipes mr ON mr.recipe_id = r.id \
                       WHERE mr.menu_id = m.id AND r.photo_url IS NOT NULL \
                       ORDER BY mr.sort_order LIMIT 1) AS photo_url \
             FROM menus m WHERE m.slug = ?1"
        }
        _ => return Ok(None),
    };
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query([slug])?;
    match rows.next()? {
        None => Ok(None),
        Some(row) => Ok(Some((row.get(0)?, row.get(1)?, row.get(2)?))),
    }
}

/// Turn a relative `/uploads/foo.jpg` into a full `https://host/uploads/foo.jpg`
/// for og:image — most social scrapers prefer absolute URLs even though many
/// will accept relative ones. Leaves `http(s)://` URLs alone.
fn absolutize_url(url: &str, headers: &HeaderMap) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_else(|| if host.starts_with("localhost") || host.starts_with("127.") { "http" } else { "https" });
    let path = if url.starts_with('/') {
        url.to_string()
    } else {
        format!("/{url}")
    };
    format!("{scheme}://{host}{path}")
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
/// or the SPA shell with the page bundle that matches the URL. Detail-page
/// URLs (`/recipes/:slug`, `/menus/:slug`, kitchen variants) get an extra
/// SQLite lookup so the shell carries real Bluesky / iMessage / Twitter
/// preview metadata.
pub async fn serve_spa(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    // /kitchens/home/<rest> → /<rest>. Mirrors packages/app/middleware.ts —
    // canonical internal links always use the long form, the URL bar gets
    // the friendlier short alias. 308 keeps the method and signals search
    // engines this is the canonical URL. Query string is preserved (the Rex
    // middleware dropped it because Rex's middleware runtime stripped the
    // query before invocation; axum hands us the full Uri).
    if let Some(target) = kitchen_home_redirect(&uri) {
        return (
            StatusCode::PERMANENT_REDIRECT,
            [(header::LOCATION, HeaderValue::try_from(target).unwrap_or(HeaderValue::from_static("/")))],
        )
            .into_response();
    }

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
    let trust_lan = std::env::var("PANTRY_TRUST_LAN")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    // Look up OG metadata for detail-page URLs. Returns None for every
    // other URL so the rest of the site costs zero extra DB queries.
    let og = lookup_og_meta(&state, &headers, path)
        .await
        .unwrap_or_default();
    let html = shell_html(
        manifest,
        page_js,
        default_palette.as_deref(),
        trust_lan,
        &og,
    );
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))],
        html,
    )
        .into_response()
}

fn kitchen_home_redirect(uri: &Uri) -> Option<String> {
    let path = uri.path();
    // Bare /kitchens/home (with or without trailing slash) → /
    let stripped = if path == "/kitchens/home" || path == "/kitchens/home/" {
        "/".to_string()
    } else if let Some(rest) = path.strip_prefix("/kitchens/home/") {
        format!("/{rest}")
    } else {
        return None;
    };
    Some(match uri.query() {
        Some(q) if !q.is_empty() => format!("{stripped}?{q}"),
        _ => stripped,
    })
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
