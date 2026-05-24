//! `/api/plu` — PLU (Price Look-Up) code lookup. Port of
//! `packages/app/pages/api/plu.ts`, backed by the same IFPS dataset
//! bundled at `packages/shared/src/plu-codes.json` (~1,500 records).
//!
//! `GET /api/plu?name=banana`
//! `GET /api/plu?name=banana,avocado`         (comma-delimited batch)
//! `GET /api/plu?name=banana&name=avocado`    (repeated param batch)
//! `GET /api/plu?code=4011`                   (reverse lookup)
//!
//! Same JSON shape as the Node and feed (Express) versions so clients
//! can swap base URLs without branching.

use std::sync::OnceLock;

use axum::{
    extract::RawQuery,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PLU_JSON: &str = include_str!("../../../shared/src/plu-codes.json");

#[derive(Deserialize, Serialize, Clone, Debug)]
struct PluRecord {
    plu: String,
    category: String,
    commodity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    variety: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aka: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    botanical: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
    type_: Option<String>,
}

fn dataset() -> &'static Vec<PluRecord> {
    static DATA: OnceLock<Vec<PluRecord>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(PLU_JSON).expect("plu-codes.json must parse"))
}

fn by_code() -> &'static std::collections::HashMap<String, PluRecord> {
    static IDX: OnceLock<std::collections::HashMap<String, PluRecord>> = OnceLock::new();
    IDX.get_or_init(|| {
        let mut m = std::collections::HashMap::with_capacity(dataset().len());
        for rec in dataset() {
            m.insert(rec.plu.clone(), rec.clone());
        }
        m
    })
}

fn is_plu_code(code: &str) -> bool {
    let clean = code.trim();
    if !clean.chars().all(|c| c.is_ascii_digit()) || !(4..=5).contains(&clean.len()) {
        return false;
    }
    if clean.len() == 4 {
        let n: u32 = clean.parse().unwrap_or(0);
        return (3000..=4999).contains(&n);
    }
    // 5 digits: must start with 9, base must fall in 3000–4999.
    if !clean.starts_with('9') {
        return false;
    }
    let base: u32 = clean[1..].parse().unwrap_or(0);
    (3000..=4999).contains(&base)
}

fn lookup_by_code(code: &str) -> Option<(PluRecord, bool)> {
    let clean = code.trim();
    if !is_plu_code(clean) {
        return None;
    }
    if clean.len() == 5 && clean.starts_with('9') {
        let base = &clean[1..];
        return by_code().get(base).map(|r| (r.clone(), true));
    }
    by_code().get(clean).map(|r| (r.clone(), false))
}

/// Normalize a query for matching: lowercase, strip leading "organic ",
/// naive-stem trailing plural on the last word. Mirrors `normalize()`
/// in `packages/shared/src/plu.ts`.
fn normalize(q: &str) -> (String, bool) {
    let trimmed = q.trim().to_ascii_lowercase();
    let (text, organic) = if let Some(rest) = trimmed.strip_prefix("organic ") {
        (rest.trim_start().to_string(), true)
    } else {
        (trimmed, false)
    };
    let mut text = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    text = naive_stem(&text);
    (text, organic)
}

/// Strip trailing `ies` -> `y`, or trailing `es`/`s` -> ``. Only fires
/// when the preceding char is alphanumeric (a poor stand-in for the JS
/// version's `(?<=\w)` lookbehind, which is enough for produce names).
fn naive_stem(s: &str) -> String {
    if s.len() >= 3 && s.ends_with("ies") {
        let prefix = &s[..s.len() - 3];
        if prefix.chars().last().map(|c| c.is_alphanumeric()).unwrap_or(false) {
            return format!("{prefix}y");
        }
    }
    if s.len() >= 2 && s.ends_with("es") {
        let prefix = &s[..s.len() - 2];
        if prefix.chars().last().map(|c| c.is_alphanumeric()).unwrap_or(false) {
            return prefix.to_string();
        }
    }
    if s.ends_with('s') && s.len() >= 2 {
        let prefix = &s[..s.len() - 1];
        if prefix.chars().last().map(|c| c.is_alphanumeric()).unwrap_or(false) {
            return prefix.to_string();
        }
    }
    s.to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Confidence {
    Exact,
    Partial,
}

fn score_record(rec: &PluRecord, q: &str) -> Option<(i32, Confidence)> {
    let commodity = rec.commodity.to_ascii_lowercase();
    let variety = rec.variety.as_deref().unwrap_or("").to_ascii_lowercase();
    let aka = rec.aka.as_deref().unwrap_or("").to_ascii_lowercase();
    let botanical = rec.botanical.as_deref().unwrap_or("").to_ascii_lowercase();

    let commodity_sing = naive_stem(&commodity);

    if q == commodity || q == commodity_sing {
        return Some((100, Confidence::Exact));
    }
    if commodity.contains(q) || q.contains(&commodity_sing) {
        let len = commodity.len().min(30) as i32;
        return Some((80 - len, Confidence::Partial));
    }
    if !variety.is_empty() && (variety.contains(q) || q.contains(&variety)) {
        return Some((60, Confidence::Partial));
    }
    if !aka.is_empty() && aka.contains(q) {
        return Some((50, Confidence::Partial));
    }
    if !botanical.is_empty() && botanical.contains(q) {
        return Some((30, Confidence::Partial));
    }
    None
}

fn size_bias(size: Option<&str>) -> i32 {
    match size {
        None => 5,
        Some(s) => {
            let lc = s.to_ascii_lowercase();
            if lc.is_empty() || lc == "all sizes" {
                5
            } else {
                0
            }
        }
    }
}

fn variety_bias(rec: &PluRecord) -> i32 {
    let mut bonus = 0;
    match rec.variety.as_deref() {
        None => bonus += 8,
        Some(v) => {
            let lc = v.to_ascii_lowercase();
            if lc.contains("includes ") || lc == "all varieties" || lc == "other" {
                bonus += 10;
            }
        }
    }
    if let Ok(plu) = rec.plu.parse::<u32>() {
        if (4000..=4299).contains(&plu) {
            bonus += 3;
        }
    }
    bonus
}

#[derive(Serialize)]
struct PluCandidate {
    plu: String,
    category: String,
    commodity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    variety: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aka: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    botanical: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "type")]
    type_: Option<String>,
    organic: bool,
    confidence: &'static str,
}

fn lookup_by_name(name: &str) -> Vec<PluCandidate> {
    let (q, organic) = normalize(name);
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<(i32, Confidence, &PluRecord)> = Vec::new();
    for rec in dataset() {
        if let Some((s, c)) = score_record(rec, &q) {
            let score = s + size_bias(rec.size.as_deref()) + variety_bias(rec);
            hits.push((score, c, rec));
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter()
        .take(20)
        .map(|(_score, conf, rec)| PluCandidate {
            plu: if organic {
                format!("9{}", rec.plu)
            } else {
                rec.plu.clone()
            },
            category: rec.category.clone(),
            commodity: rec.commodity.clone(),
            variety: rec.variety.clone(),
            size: rec.size.clone(),
            aka: rec.aka.clone(),
            botanical: rec.botanical.clone(),
            type_: rec.type_.clone(),
            organic,
            confidence: match conf {
                Confidence::Exact => "exact",
                Confidence::Partial => "partial",
            },
        })
        .collect()
}

const CACHE_CONTROL: (&str, &str) = ("cache-control", "public, max-age=86400");

pub async fn handle(RawQuery(qs): RawQuery) -> Response {
    let qs = qs.unwrap_or_default();
    let pairs = parse_query(&qs);

    // ?code=… reverse lookup
    if let Some(code) = pairs.iter().find_map(|(k, v)| (k == "code").then_some(v.as_str())) {
        if !is_plu_code(code) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "code must be a 4- or 5-digit PLU" })),
            )
                .into_response();
        }
        let (record, organic) = lookup_by_code(code)
            .map(|(r, o)| (Some(r), o))
            .unwrap_or((None, false));
        return (
            StatusCode::OK,
            [CACHE_CONTROL],
            Json(json!({
                "code": code,
                "record": record,
                "organic": organic,
            })),
        )
            .into_response();
    }

    // ?name=… (single, comma-separated, or repeated)
    let names: Vec<String> = pairs
        .iter()
        .filter(|(k, _)| k == "name")
        .flat_map(|(_, v)| v.split(',').map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "name or code query param required" })),
        )
            .into_response();
    }
    let results: Vec<Value> = names
        .iter()
        .map(|query| {
            json!({
                "query": query,
                "candidates": lookup_by_name(query),
            })
        })
        .collect();
    (
        StatusCode::OK,
        [CACHE_CONTROL],
        Json(json!({ "results": results })),
    )
        .into_response()
}

fn parse_query(qs: &str) -> Vec<(String, String)> {
    qs.split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let k = super::settings::urldecode(it.next().unwrap_or(""))?;
            let v = super::settings::urldecode(it.next().unwrap_or(""))?;
            Some((k, v))
        })
        .collect()
}
