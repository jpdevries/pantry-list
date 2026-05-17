//! `POST /upload` — multipart image upload + UUID rename + background variant
//! generation. Drop-in replacement for the Node `graphql-server.ts` handler;
//! same request shape, same response shape, same filenames on disk.
//!
//! Flow:
//! 1. Find the `file` field, validate extension + size (max 10 MB).
//! 2. Stream the body to `{uploads_dir}/{uuid}.{ext}` — never buffered fully
//!    in memory (Pi 3 has 1 GB RAM total).
//! 3. Respond `200 { "url": "/uploads/{uuid}.{ext}" }` *immediately*.
//! 4. Spawn a detached task that runs the variant pipeline behind a
//!    semaphore (`config.image_semaphore`) so two simultaneous uploads
//!    don't fight for the same RAM.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::AppState;

const MAX_UPLOAD_BYTES: u64 = 10 * 1024 * 1024;
const ALLOWED_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];

pub async fn handle(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    if let Err(e) = tokio::fs::create_dir_all(&state.config.uploads_dir).await {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("uploads dir: {e}"),
        );
    }

    let (dest_path, uuid_str, ext) =
        match save_file_field(&mut multipart, &state.config.uploads_dir).await {
            Ok(Some(triple)) => triple,
            Ok(None) => return err(StatusCode::BAD_REQUEST, "No file uploaded".into()),
            Err((status, msg)) => return err(status, msg),
        };

    if state.config.image_processing && ext != "gif" {
        let sem = state.config.image_semaphore.clone();
        let dest = dest_path.clone();
        let uploads = state.config.uploads_dir.clone();
        let uuid_for_task = uuid_str.clone();
        tokio::spawn(async move {
            let Ok(_permit) = sem.acquire_owned().await else {
                return;
            };
            let result = tokio::task::spawn_blocking(move || {
                crate::image::process_uploaded_image(&dest, &uploads, &uuid_for_task)
            })
            .await;
            match result {
                Ok(Ok(())) => tracing::debug!("variants generated for {uuid_str}"),
                Ok(Err(e)) => tracing::error!("variant generation failed: {e:#}"),
                Err(e) => tracing::error!("variant generation task panicked: {e}"),
            }
        });
    }

    let filename = dest_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    (
        StatusCode::OK,
        Json(json!({ "url": format!("/uploads/{filename}") })),
    )
        .into_response()
}

/// Find the first `file` field, stream it to disk, return its destination
/// path + UUID stem + extension. Returns `Ok(None)` if the multipart body
/// has no `file` field; `Err((status, msg))` on a recoverable parse/IO
/// error that the caller should bubble back to the client.
async fn save_file_field(
    multipart: &mut Multipart,
    uploads_dir: &Path,
) -> Result<Option<(PathBuf, String, String)>, (StatusCode, String)> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("multipart parse: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let original = field.file_name().map(str::to_string);
        let ext = original
            .as_deref()
            .and_then(|n| Path::new(n).extension())
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "jpg".to_string());
        if !ALLOWED_EXT.contains(&ext.as_str()) {
            return Err((StatusCode::BAD_REQUEST, "Invalid file type".into()));
        }
        let uuid_str = Uuid::new_v4().to_string();
        let dest_path = uploads_dir.join(format!("{uuid_str}.{ext}"));

        let mut file = tokio::fs::File::create(&dest_path)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("create file: {e}")))?;
        let mut bytes_written = 0u64;
        loop {
            let chunk = match field.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&dest_path).await;
                    return Err((StatusCode::BAD_REQUEST, format!("chunk: {e}")));
                }
            };
            bytes_written += chunk.len() as u64;
            if bytes_written > MAX_UPLOAD_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(&dest_path).await;
                return Err((StatusCode::BAD_REQUEST, "File too large (max 10 MB)".into()));
            }
            if let Err(e) = file.write_all(&chunk).await {
                drop(file);
                let _ = tokio::fs::remove_file(&dest_path).await;
                return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}")));
            }
        }
        file.flush()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("flush: {e}")))?;
        return Ok(Some((dest_path, uuid_str, ext)));
    }
    Ok(None)
}

fn err(status: StatusCode, msg: String) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}
