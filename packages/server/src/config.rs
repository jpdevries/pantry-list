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
    /// Override the Anthropic API base URL. Used by the integration test harness
    /// to point the Messages client at a local mock. Empty = use the real API.
    pub anthropic_base_url: Option<String>,
    /// Caps concurrent image-variant pipelines. A single 12 MP decode can pin
    /// ~50 MB of RGB buffer on a Pi 3; running two in parallel can OOM the
    /// 1 GB box. Default = 1; override with `IMAGE_CONCURRENCY` on bigger
    /// hosts.
    pub image_semaphore: Arc<Semaphore>,
    /// JSON file where /api/settings-write persists user overrides. Layered
    /// on top of process.env by /api/settings-read so Settings-page edits
    /// take effect without a server restart. Default sits next to the
    /// SQLite DB so all per-host state lives in the same directory.
    pub overrides_path: PathBuf,
    /// recipe-api.com key. Owner-gated read via /api/recipe-api-key.
    pub recipe_api_key: Option<String>,
    /// Cache dir for the Wikibooks dataset download. Default sits next to
    /// the SQLite DB. Override with `CACHE_DIR`.
    pub cache_dir: PathBuf,
    /// Override the Open Food Facts API base URL. Used by the integration
    /// test harness to point the barcode lookup at a local mock. Empty =
    /// use the real `https://world.openfoodfacts.org`.
    pub off_base_url: Option<String>,
    /// Override the Hugging Face datasets-server base URL. Same pattern as
    /// `off_base_url` — empty = use the real `datasets-server.huggingface.co`.
    pub wikibooks_base_url: Option<String>,
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
        let anthropic_base_url = std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_end_matches('/').to_string());
        let image_concurrency = std::env::var("IMAGE_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|&n: &usize| n > 0)
            .unwrap_or(1);
        // Both .settings-overrides.json and the wikibooks cache default next
        // to the SQLite DB so a Pi user can wipe one directory to factory-
        // reset every per-host artifact.
        let db_dir = std::env::var("SQLITE_DB_PATH")
            .ok()
            .map(PathBuf::from)
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("."));
        let overrides_path = std::env::var("OVERRIDES_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| db_dir.join(".settings-overrides.json"));
        let recipe_api_key = std::env::var("RECIPE_API_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        let cache_dir = std::env::var("CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| db_dir.join(".cache"));
        let off_base_url = std::env::var("OFF_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_end_matches('/').to_string());
        let wikibooks_base_url = std::env::var("WIKIBOOKS_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_end_matches('/').to_string());
        Self {
            uploads_dir,
            image_processing,
            anthropic_api_key,
            anthropic_base_url,
            image_semaphore: Arc::new(Semaphore::new(image_concurrency)),
            overrides_path,
            recipe_api_key,
            cache_dir,
            off_base_url,
            wikibooks_base_url,
        }
    }
}
