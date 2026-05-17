use std::net::SocketAddr;
use std::sync::Arc;

use async_graphql_axum::{GraphQLRequest, GraphQLResponse};
use axum::{
    extract::State,
    http::Method,
    response::{IntoResponse, Json},
    routing::post,
    Router,
};
use tower_http::cors::{Any, CorsLayer};

mod anthropic;
mod config;
mod db;
mod error;
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
        .route("/", post(graphql_handler))
        .route("/graphql", post(graphql_handler))
        .route("/upload", post(routes::upload::handle))
        .route("/fetch-recipe", post(routes::fetch_recipe::handle))
        .layer(cors)
        .with_state(Arc::new(state));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("GraphQL API ready at http://0.0.0.0:{port}/graphql");

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

#[allow(dead_code)]
async fn not_implemented(msg: &'static str) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({ "error": msg })),
    )
}
