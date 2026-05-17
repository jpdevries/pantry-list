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

mod db;
mod error;
mod graphql;
mod models;

use crate::graphql::{build_schema, AppSchema};

#[derive(Clone)]
struct AppState {
    schema: AppSchema,
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

    let schema = build_schema(pool);
    let state = AppState { schema };

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
        .route("/upload", post(not_implemented_upload))
        .route("/fetch-recipe", post(not_implemented_fetch_recipe))
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

// Phase 2 ports only the GraphQL surface. These endpoints stay on the Node
// graphql-server.ts until a follow-up phase ports image processing + recipe
// URL scraping. Return a recognizable 501 so clients fail loudly during the
// transition.
async fn not_implemented_upload() -> impl IntoResponse {
    let body = serde_json::json!({
        "error": "/upload is not implemented in the Rust backend yet. Run the Node graphql-server for image uploads."
    });
    (axum::http::StatusCode::NOT_IMPLEMENTED, Json(body))
}

async fn not_implemented_fetch_recipe() -> impl IntoResponse {
    let body = serde_json::json!({
        "error": "/fetch-recipe is not implemented in the Rust backend yet. Run the Node graphql-server for recipe URL imports."
    });
    (axum::http::StatusCode::NOT_IMPLEMENTED, Json(body))
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
