use thiserror::Error;

/// Reserved for future use — keeps a place to attach error context if/when we
/// outgrow the inlined `async_graphql::Error::new` style. Phase-2 resolvers
/// raise `async_graphql::Error` directly.
#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    BadInput(String),
}
