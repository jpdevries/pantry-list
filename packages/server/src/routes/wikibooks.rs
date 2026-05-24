//! `/api/wikibooks` — Hugging Face dataset proxy with on-disk cache.
//!
//! Port of `packages/app/pages/api/wikibooks.ts`. First request downloads
//! the gossminn/wikibooks-cookbook dataset (~3,900 CC-BY-SA recipes) in
//! 100-row batches, normalizes each row, and caches the result to
//! `config.cache_dir/wikibooks-cookbook.json`. Subsequent requests
//! serve from a process-local in-memory cache, falling back to the disk
//! cache on cold start.
//!
//! `GET /api/wikibooks?q=&offset=&limit=` — paginated search.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::AppState;

const HF_API_DEFAULT: &str = "https://datasets-server.huggingface.co";
const HF_API_PATH: &str = "/rows";
const DATASET: &str = "gossminn/wikibooks-cookbook";
const BATCH_SIZE: u32 = 100;
const CACHE_FILE_NAME: &str = "wikibooks-cookbook.json";

#[derive(Deserialize)]
pub struct WikibooksQuery {
    pub q: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct WikibooksEntry {
    slug: String,
    title: String,
    tags: Vec<String>,
    servings: Option<i64>,
    time: Option<String>,
    difficulty: Option<i64>,
    #[serde(rename = "sourceUrl")]
    source_url: String,
    ingredients: Vec<String>,
    instructions: String,
}

#[derive(Deserialize)]
struct HFResponse {
    rows: Vec<HFRow>,
    num_rows_total: i64,
}

#[derive(Deserialize)]
struct HFRow {
    row: HFRowInner,
}

#[derive(Deserialize)]
struct HFRowInner {
    recipe_data: HFRecipeData,
}

#[derive(Deserialize)]
struct HFRecipeData {
    infobox: HFInfobox,
    text_lines: Vec<HFTextLine>,
    title: String,
    url: String,
}

#[derive(Deserialize, Default)]
struct HFInfobox {
    category: Option<String>,
    difficulty: Option<i64>,
    servings: Option<Value>,
    time: Option<String>,
}

#[derive(Deserialize)]
struct HFTextLine {
    section: Option<String>,
    text: String,
}

fn to_slug(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for c in title.to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn extract_tags(info: &HFInfobox) -> Vec<String> {
    let mut tags = vec!["wikibooks".to_string()];
    let Some(raw) = info.category.as_deref() else {
        return tags;
    };
    let mut cat = raw.to_string();
    // Mirror the JS replacements in shared/src/wikibooks.ts.
    for prefix in &["/wiki/Category:", "/w/index.php?title=Category:"] {
        if let Some(rest) = cat.strip_prefix(prefix) {
            cat = rest.to_string();
            break;
        }
    }
    if let Some(amp) = cat.find('&') {
        cat = cat[..amp].to_string();
    }
    for prefix in &["Cookbook:Cuisine of ", "Cookbook:"] {
        if cat.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) {
            cat = cat[prefix.len()..].to_string();
            break;
        }
    }
    cat = cat.replace('_', " ");
    if cat.to_ascii_lowercase().ends_with(" recipes") {
        cat = cat[..cat.len() - 8].to_string();
    } else if cat.to_ascii_lowercase().ends_with("recipes") {
        cat = cat[..cat.len() - 7].to_string();
    }
    let cat = cat.trim().to_string();
    if !cat.is_empty() {
        tags.push(cat.to_ascii_lowercase());
    }
    tags
}

fn normalize_row(raw: HFRecipeData) -> WikibooksEntry {
    let ingredients: Vec<String> = raw
        .text_lines
        .iter()
        .filter(|l| l.section.as_deref() == Some("Ingredients") && !l.text.trim().is_empty())
        .map(|l| l.text.trim().to_string())
        .collect();
    let procedure: Vec<String> = raw
        .text_lines
        .iter()
        .filter(|l| l.section.as_deref() == Some("Procedure") && !l.text.trim().is_empty())
        .enumerate()
        .map(|(i, l)| format!("{}. {}", i + 1, l.text.trim()))
        .collect();
    let instructions = if procedure.is_empty() {
        raw.text_lines
            .iter()
            .filter(|l| {
                l.section
                    .as_deref()
                    .map(|s| !s.is_empty() && s != "Ingredients")
                    .unwrap_or(false)
                    && !l.text.trim().is_empty()
            })
            .map(|l| l.text.trim().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        procedure.join("\n")
    };
    let servings = raw.infobox.servings.as_ref().and_then(|v| match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    });
    WikibooksEntry {
        slug: to_slug(&raw.title),
        title: raw.title.clone(),
        tags: extract_tags(&raw.infobox),
        servings,
        time: raw.infobox.time.clone(),
        difficulty: raw.infobox.difficulty,
        source_url: raw.url,
        ingredients,
        instructions,
    }
}

fn search(query: &str, data: &[WikibooksEntry]) -> Vec<WikibooksEntry> {
    if query.trim().is_empty() {
        return data.to_vec();
    }
    let q = query.to_ascii_lowercase();
    data.iter()
        .filter(|r| {
            r.title.to_ascii_lowercase().contains(&q)
                || r.tags.iter().any(|t| t.contains(&q))
                || r.ingredients
                    .iter()
                    .any(|i| i.to_ascii_lowercase().contains(&q))
        })
        .cloned()
        .collect()
}

static DATA: OnceCell<Vec<WikibooksEntry>> = OnceCell::const_new();

async fn fetch_dataset(
    http: &reqwest::Client,
    base: &str,
) -> anyhow::Result<Vec<WikibooksEntry>> {
    let first_url = format!(
        "{base}{HF_API_PATH}?dataset={DATASET}&config=default&split=main&offset=0&length={BATCH_SIZE}"
    );
    let first: HFResponse = http
        .get(&first_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let total_rows = first.num_rows_total;
    let total_batches = (total_rows + BATCH_SIZE as i64 - 1) / BATCH_SIZE as i64;
    let mut out: Vec<WikibooksEntry> = Vec::with_capacity(total_rows as usize);
    for row in first.rows {
        out.push(normalize_row(row.row.recipe_data));
    }
    for batch in 1..total_batches {
        let offset = batch as u32 * BATCH_SIZE;
        let url = format!(
            "{base}{HF_API_PATH}?dataset={DATASET}&config=default&split=main&offset={offset}&length={BATCH_SIZE}"
        );
        let resp: HFResponse = http
            .get(&url)
            .timeout(Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        for row in resp.rows {
            out.push(normalize_row(row.row.recipe_data));
        }
    }
    Ok(out)
}

async fn load_or_fetch(state: &AppState) -> anyhow::Result<&'static Vec<WikibooksEntry>> {
    DATA.get_or_try_init(|| async {
        let path = state.config.cache_dir.join(CACHE_FILE_NAME);
        // 1. Disk cache
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if let Ok(parsed) = serde_json::from_slice::<Vec<WikibooksEntry>>(&bytes) {
                return Ok(parsed);
            }
        }
        // 2. Download + persist
        let base = state
            .config
            .wikibooks_base_url
            .as_deref()
            .unwrap_or(HF_API_DEFAULT);
        let entries = fetch_dataset(&state.http, base).await?;
        if let Err(e) = tokio::fs::create_dir_all(&state.config.cache_dir).await {
            tracing::warn!("could not create cache dir {}: {e}", state.config.cache_dir.display());
        }
        match serde_json::to_vec(&entries) {
            Ok(bytes) => {
                if let Err(e) = tokio::fs::write(&path, &bytes).await {
                    tracing::warn!("could not persist wikibooks cache to {}: {e}", path.display());
                }
            }
            Err(e) => tracing::warn!("could not serialize wikibooks cache: {e}"),
        }
        Ok(entries)
    })
    .await
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WikibooksQuery>,
) -> Response {
    let data = match load_or_fetch(&state).await {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("{e}") })),
            )
                .into_response();
        }
    };

    let q = query.q.unwrap_or_default();
    let offset = query.offset.unwrap_or(0).max(0) as usize;
    let limit = query.limit.unwrap_or(48).clamp(1, 100) as usize;

    let filtered = search(&q, data);
    let total = filtered.len();
    let end = (offset + limit).min(total);
    let start = offset.min(total);
    let page: Vec<WikibooksEntry> = filtered[start..end].to_vec();

    (
        StatusCode::OK,
        [("cache-control", "public, max-age=3600")],
        Json(serde_json::json!({
            "total": total,
            "offset": offset,
            "limit": limit,
            "results": page,
        })),
    )
        .into_response()
}
