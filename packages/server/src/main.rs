use std::net::SocketAddr;
use std::sync::Arc;

use async_graphql_axum::{GraphQLRequest, GraphQLResponse};
use axum::{
    extract::{Path as AxumPath, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

mod anthropic;
mod config;
mod db;
mod error;
mod frontend;
mod graphql;
mod image;
mod ingredient_parse;
mod iso_duration;
mod models;
mod routes;
mod scrape;

use crate::config::ServerConfig;
use crate::db::Pool;
use crate::graphql::{build_schema, AppSchema};

/// Shared state for axum routes. The GraphQL schema already has the pool +
/// http client + config in its `.data()` slot; the same handles live here so
/// the non-GraphQL routes (`/upload`, `/fetch-recipe`) can read them too.
#[derive(Clone)]
pub struct AppState {
    pub schema: AppSchema,
    pub pool: Pool,
    pub http: reqwest::Client,
    pub config: ServerConfig,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let db_path = std::env::var("SQLITE_DB_PATH").unwrap_or_else(|_| "./pantry.db".to_string());
    let port: u16 = std::env::var("GRAPHQL_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4001);

    let pool = db::init(&db_path)?;
    tracing::info!("SQLite database ready at {db_path}");

    let config = ServerConfig::from_env();
    if let Err(e) = std::fs::create_dir_all(&config.uploads_dir) {
        tracing::warn!(
            "could not create uploads dir {}: {e} (continuing; /upload will retry)",
            config.uploads_dir.display()
        );
    }

    // Single shared reqwest client: connection pool, DNS cache, rustls roots
    // are all amortized across `/fetch-recipe` and the Anthropic resolver.
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; PantryListBot/1.0)")
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let schema = build_schema(pool.clone(), http.clone(), config.clone());
    let state = AppState {
        schema,
        pool,
        http,
        config,
    };

    // The Node graphql-server.ts accepts POST on the root path for GraphQL and
    // serves multiple other endpoints on the same port. Mirror that surface so
    // the existing `lib/gql.ts` clients work unchanged.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::POST, Method::OPTIONS, Method::GET])
        .allow_headers(Any);

    let app = Router::new()
        // GraphQL: POST on `/` and `/graphql`. GET on `/` falls through to
        // the SPA shell handler below.
        .route("/", post(graphql_handler).get(frontend::serve_spa))
        .route("/graphql", post(graphql_handler))
        .route("/upload", post(routes::upload::handle))
        .route("/fetch-recipe", post(routes::fetch_recipe::handle))
        // Side endpoints that the SPA used to call as Next-style /api/*
        // routes. Now that the frontend is static, they live here.
        .route("/api/settings-read", get(routes::settings::settings_read))
        .route("/api/settings-write", post(routes::settings::settings_write))
        .route("/api/recipe-api-key", get(routes::settings::recipe_api_key))
        .route("/api/plu", get(routes::plu::handle))
        .route("/api/lookup-barcode", get(routes::lookup_barcode::handle))
        .route("/api/recipe-ics", get(routes::recipe_ics::handle))
        .route("/api/wikibooks", get(routes::wikibooks::handle))
        // Aliases that already had Rust-side homes — keep the old URLs
        // working too so the client doesn't need to change paths.
        .route("/api/upload", post(routes::upload::handle))
        .route("/api/fetch-recipe", post(routes::fetch_recipe::handle))
        .route("/api/graphql", post(graphql_handler))
        // Frontend assets: chunked JS/CSS at /_rex/static/<file>, uploaded
        // images served from disk, and a catch-all GET that returns either
        // an embedded public asset (sw.js, favicon, manifest.json…) or the
        // SPA shell with the page bundle that matches the URL.
        .route("/_rex/static/{*path}", get(frontend::serve_client))
        .route("/uploads/{*path}", get(serve_upload))
        .fallback(frontend::serve_spa)
        .layer(cors)
        .with_state(Arc::new(state));

    // Bind IPv6 unspecified so we accept both v4 and v6 (IPV6_V6ONLY is off
    // by default on Linux). Without this, mDNS clients that resolve our
    // `.local` name to an AAAA record get ERR_ADDRESS_UNREACHABLE.
    let addr = SocketAddr::from(([0u16; 8], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("GraphQL API ready at http://[::]:{port}/graphql");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn graphql_handler(
    State(state): State<Arc<AppState>>,
    req: GraphQLRequest,
) -> GraphQLResponse {
    state.schema.execute(req.into_inner()).await.into()
}

/// `GET /uploads/{*path}` — serve user-uploaded images from
/// `state.config.uploads_dir`. Mirrors what Rex did with `public/uploads/`
/// on the Node side. Uploaded files have UUID filenames and are immutable,
/// so a long `Cache-Control` is safe.
async fn serve_upload(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    // Reject any path that tries to climb out of the uploads dir. The
    // axum extractor already URL-decodes path segments; do a final string
    // check to be safe against percent-encoded `..`.
    if path.contains("..") || path.starts_with('/') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let full = state.config.uploads_dir.join(&path);
    match tokio::fs::read(&full).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&full).first_or_octet_stream();
            let mut res = (StatusCode::OK, bytes).into_response();
            if let Ok(ct) = HeaderValue::from_str(mime.as_ref()) {
                res.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
            res
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
