//! Process-wide configuration assembled at boot from environment variables.
//! Cloned into the GraphQL schema's `.data()` so resolvers (and `/upload`,
//! `/fetch-recipe`) can read settings without re-touching `std::env`.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct ServerConfig {
    /// Directory on disk where uploaded images live and where the variant
    /// pipeline writes its outputs. Mirrors `path.join(cwd, 'public/uploads')`
    /// from the Node `graphql-server.ts`.
    pub uploads_dir: PathBuf,
    /// When false, `/upload` saves the original but skips variant generation.
    /// Mirrors the `ENABLE_IMAGE_PROCESSING` env var on the Node side.
    pub image_processing: bool,
    /// Anthropic key for `generateRecipes`. `AI_API_KEY` is the canonical name;
    /// `ANTHROPIC_API_KEY` is accepted for compatibility with the TS server.
    pub anthropic_api_key: Option<String>,
    /// Caps concurrent image-variant pipelines. A single 12 MP decode can pin
    /// ~50 MB of RGB buffer on a Pi 3; running two in parallel can OOM the
    /// 1 GB box. Default = 1; override with `IMAGE_CONCURRENCY` on bigger
    /// hosts.
    pub image_semaphore: Arc<Semaphore>,
}

impl ServerConfig {
    pub fn from_env() -> Self {
        let uploads_dir = std::env::var("UPLOADS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("../app/public/uploads"));
        let image_processing = std::env::var("ENABLE_IMAGE_PROCESSING")
            .ok()
            .map(|v| !matches!(v.as_str(), "false" | "0" | ""))
            .unwrap_or(true);
        let anthropic_api_key = std::env::var("AI_API_KEY")
            .ok()
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
            .filter(|s| !s.is_empty());
        let image_concurrency = std::env::var("IMAGE_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|&n: &usize| n > 0)
            .unwrap_or(1);
        Self {
            uploads_dir,
            image_processing,
            anthropic_api_key,
            image_semaphore: Arc::new(Semaphore::new(image_concurrency)),
        }
    }
}
