use anyhow::Context;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

/// Connection-pool type used by every resolver in this crate.
pub type Pool = r2d2::Pool<SqliteConnectionManager>;

/// Canonical schema, kept in lock-step with `packages/shared/src/sql/schema.ts`
/// (the TS source of truth for the Node and browser SQLite consumers).
///
/// `schema.sql` is the file copy maintained here; `include_str!` embeds it at
/// compile time so the Rust binary has zero filesystem dependencies at boot.
const SCHEMA_SQL: &str =
    include_str!("../../shared/src/sql/schema.sql");

/// Initialize the SQLite database at `path`, apply pragmas + schema, and
/// return a connection pool sized for an IoT-class device.
pub fn init(path: &str) -> anyhow::Result<Pool> {
    // `journal_mode = WAL` is a database-level setting that persists, so it
    // only needs to be set once on a single connection. Setting it from every
    // pooled connection in parallel races for the database lock — those
    // `database is locked` warnings are harmless but noisy.
    {
        let bootstrap = rusqlite::Connection::open(path)
            .context("failed to open SQLite database for bootstrap")?;
        bootstrap
            .execute_batch(
                "PRAGMA journal_mode = WAL;\
                 PRAGMA foreign_keys = ON;\
                 PRAGMA busy_timeout = 5000;",
            )
            .context("failed to apply boot pragmas")?;
        bootstrap
            .execute_batch(SCHEMA_SQL)
            .context("failed to apply schema")?;
    }

    // `foreign_keys` is per-connection — set it on every pooled connection.
    let manager = SqliteConnectionManager::file(path).with_init(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    });
    let pool = r2d2::Pool::builder()
        .max_size(4)
        .build(manager)
        .context("failed to build SQLite connection pool")?;
    Ok(pool)
}

/// Run a closure that needs a pooled SQLite connection on a blocking-friendly
/// thread. async-graphql resolvers stay `async`; rusqlite stays sync.
pub async fn with_conn<F, T>(pool: &Pool, f: F) -> async_graphql::Result<T>
where
    F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool
            .get()
            .map_err(|e| async_graphql::Error::new(format!("db pool: {e}")))?;
        f(&mut conn).map_err(|e| async_graphql::Error::new(e.to_string()))
    })
    .await
    .map_err(|e| async_graphql::Error::new(format!("db task join: {e}")))?
}

/// Generate an ISO-8601 UTC timestamp matching the format SQLite emits via
/// `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Used everywhere we set `updated_at`
/// or `last_made_at` from application code.
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// New UUID v4 in lowercase hex form, matching `crypto.randomUUID()` output.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
