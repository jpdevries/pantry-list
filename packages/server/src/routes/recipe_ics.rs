//! `/api/recipe-ics?slug=<slug>` — calendar export for a single recipe.
//!
//! Port of `packages/app/pages/api/recipe-ics.ts`. Renders a real `.ics`
//! payload that iOS Safari can open (data: URIs are blocked there, so
//! the client redirects to this endpoint when on iOS). DTSTART is
//! anchored to the next meal slot — breakfast 8 am, lunch noon, dinner
//! 6:30 pm — based on the recipe's tags, then the start time is rolled
//! back by `prepTime + cookTime` so the food is ready at meal time.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, TimeZone, Timelike, Utc};
use serde::Deserialize;

use crate::db::Pool;
use crate::models::{CookwareRow, RecipeIngredientRow, RecipeRow};
use crate::AppState;

#[derive(Deserialize)]
pub struct IcsQuery {
    pub slug: String,
}

struct Ingredient {
    name: String,
    quantity: Option<f64>,
    unit: Option<String>,
    item_size: Option<f64>,
    item_size_unit: Option<String>,
}

fn load_recipe(pool: &Pool, slug: &str) -> anyhow::Result<Option<(RecipeRow, Vec<Ingredient>, Vec<String>)>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT * FROM recipes WHERE slug = ?1")?;
    let row = stmt.query_row([slug], RecipeRow::from_row).ok();
    let Some(recipe) = row else {
        return Ok(None);
    };

    let mut ing_stmt = conn.prepare(
        "SELECT * FROM recipe_ingredients WHERE recipe_id = ?1 ORDER BY sort_order",
    )?;
    let ingredients: Vec<Ingredient> = ing_stmt
        .query_map([&recipe.id], RecipeIngredientRow::from_row)?
        .filter_map(|r| r.ok())
        .map(|r| Ingredient {
            name: r.ingredient_name,
            quantity: r.quantity,
            unit: r.unit,
            item_size: r.item_size,
            item_size_unit: r.item_size_unit,
        })
        .collect();

    let mut cw_stmt = conn.prepare(
        "SELECT c.* FROM cookware c \
         JOIN recipe_cookware rc ON rc.cookware_id = c.id \
         WHERE rc.recipe_id = ?1",
    )?;
    let cookware: Vec<String> = cw_stmt
        .query_map([&recipe.id], CookwareRow::from_row)?
        .filter_map(|r| r.ok())
        .map(|r| r.name)
        .collect();

    Ok(Some((recipe, ingredients, cookware)))
}

fn parse_tags(json: Option<&str>) -> Vec<String> {
    let raw = json.unwrap_or("");
    if raw.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn format_ingredient(i: &Ingredient) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(q) = i.quantity {
        parts.push(trim_trailing_zero(q));
    }
    if let Some(sz) = i.item_size {
        let unit = i.item_size_unit.as_deref().unwrap_or("");
        parts.push(format!("{}{}", trim_trailing_zero(sz), unit));
    } else if let Some(u) = &i.unit {
        if !u.is_empty() {
            parts.push(u.clone());
        }
    }
    parts.push(i.name.clone());
    parts.join(" ")
}

fn trim_trailing_zero(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        // Drop noise: 1.5 not 1.5000…
        let s = format!("{:.6}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn parse_instruction_steps(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| {
            // Strip leading "1. " / "2) " style numbering.
            let trimmed = line.trim_start();
            let mut chars = trimmed.chars().peekable();
            let mut digits = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_ascii_digit() {
                    digits.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            if !digits.is_empty() {
                if let Some(&c) = chars.peek() {
                    if c == '.' || c == ')' {
                        chars.next();
                        while let Some(&c) = chars.peek() {
                            if c.is_whitespace() {
                                chars.next();
                            } else {
                                break;
                            }
                        }
                        return chars.collect::<String>().trim().to_string();
                    }
                }
            }
            trimmed.trim().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn ics_esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

fn ics_fold(line: &str) -> String {
    // RFC 5545 §3.1: lines fold at 75 octets. We fold at chars, which is
    // close enough for ASCII-heavy recipe content.
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= 75 {
        return line.to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + 75).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        if start == 0 {
            parts.push(chunk);
        } else {
            parts.push(format!(" {chunk}"));
        }
        start = end;
    }
    parts.join("\r\n")
}

fn ics_timestamp(dt: DateTime<Utc>) -> String {
    // RFC 5545 form: 20260517T223415Z
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second(),
    )
}

fn iso_duration(minutes: i64) -> String {
    let h = minutes / 60;
    let m = minutes % 60;
    let mut out = String::from("PT");
    if h > 0 {
        out.push_str(&format!("{h}H"));
    }
    if m > 0 {
        out.push_str(&format!("{m}M"));
    }
    out
}

fn resolve_photo_url(
    headers: &HeaderMap,
    photo_url: Option<&str>,
    slug: Option<&str>,
) -> Option<String> {
    let url = photo_url?.trim();
    if url.is_empty() {
        return None;
    }
    if url.starts_with("http") {
        return Some(url.to_string());
    }
    if url.starts_with("/uploads/") {
        let slug = slug?;
        let host = headers.get("host").and_then(|v| v.to_str().ok())?;
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                if host.contains("localhost") {
                    "http".to_string()
                } else {
                    "https".to_string()
                }
            });
        return Some(format!("{proto}://{host}/uploads/{slug}.jpg"));
    }
    None
}

async fn fetch_og_image(http: &reqwest::Client, url: &str) -> Option<String> {
    let resp = http
        .get(url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let html = resp.text().await.ok()?;
    let re1 = regex::Regex::new(
        r#"(?i)<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']"#,
    )
    .ok()?;
    if let Some(c) = re1.captures(&html) {
        return Some(c.get(1)?.as_str().to_string());
    }
    let re2 = regex::Regex::new(
        r#"(?i)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']"#,
    )
    .ok()?;
    re2.captures(&html)?.get(1).map(|m| m.as_str().to_string())
}

fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = true;
    for c in s.to_ascii_lowercase().chars() {
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

pub async fn handle(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<IcsQuery>,
) -> Response {
    if query.slug.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing slug parameter").into_response();
    }

    let pool = state.pool.clone();
    let slug = query.slug.clone();
    let loaded = tokio::task::spawn_blocking(move || load_recipe(&pool, &slug)).await;
    let loaded = match loaded {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to generate ICS: {e}"),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to generate ICS: {e}"),
            )
                .into_response();
        }
    };
    let Some((recipe, ingredients, cookware)) = loaded else {
        return (StatusCode::NOT_FOUND, "Recipe not found").into_response();
    };

    let tags = parse_tags(recipe.tags_json.as_deref());

    // Photo URL: absolute > local via host > og:image from source.
    let mut photo_url =
        resolve_photo_url(&headers, recipe.photo_url.as_deref(), recipe.slug.as_deref());
    if photo_url.is_none() {
        if let Some(source) = recipe.source_url.as_deref() {
            photo_url = fetch_og_image(&state.http, source).await;
        }
    }

    let now = Utc::now();
    let slug_for_uid = recipe
        .slug
        .clone()
        .unwrap_or_else(|| slugify(&recipe.title));
    let uid = format!("recipe-{slug_for_uid}@pantryhost.app");

    // Meta + description body.
    let mut desc: Vec<String> = Vec::new();
    let mut meta_line: Vec<String> = Vec::new();
    if let Some(s) = recipe.servings {
        meta_line.push(format!("Servings: {s}"));
    }
    if let Some(p) = recipe.prep_time {
        meta_line.push(format!("Prep: {p} min"));
    }
    if let Some(c) = recipe.cook_time {
        meta_line.push(format!("Cook: {c} min"));
    }
    if !meta_line.is_empty() {
        desc.push(meta_line.join(" | "));
    }
    if let Some(d) = recipe.description.as_deref() {
        if !d.is_empty() {
            desc.push(d.to_string());
        }
    }
    if !ingredients.is_empty() {
        desc.push("INGREDIENTS".into());
        for ing in &ingredients {
            desc.push(format!("- {}", format_ingredient(ing)));
        }
    }
    let steps = parse_instruction_steps(&recipe.instructions);
    if !steps.is_empty() {
        desc.push(String::new());
        desc.push("INSTRUCTIONS".into());
        for (i, s) in steps.iter().enumerate() {
            desc.push(format!("{}. {s}", i + 1));
        }
    }
    if !cookware.is_empty() {
        desc.push(String::new());
        desc.push(format!("Cookware: {}", cookware.join(", ")));
    }
    desc.push(String::new());
    desc.push("Exported from Pantry Host — https://pantryhost.app".into());
    let description = ics_esc(&desc.join("\n"));

    // Meal slot anchoring.
    let tags_lower: Vec<String> = tags.iter().map(|t| t.to_ascii_lowercase()).collect();
    let (end_hour, end_minute) = if tags_lower.iter().any(|t| t == "breakfast") {
        (8u32, 0u32)
    } else if tags_lower.iter().any(|t| t == "lunch") {
        (12u32, 0u32)
    } else {
        (18u32, 30u32)
    };
    let total_minutes = recipe.prep_time.unwrap_or(0) + recipe.cook_time.unwrap_or(0);
    let total_minutes = if total_minutes == 0 { 30 } else { total_minutes };
    let mut end = Utc
        .with_ymd_and_hms(now.year(), now.month(), now.day(), end_hour, end_minute, 0)
        .single()
        .unwrap_or(now);
    if end <= now {
        end = end + ChronoDuration::days(1);
    }
    let start = end - ChronoDuration::minutes(total_minutes);
    let duration = iso_duration(total_minutes);

    let mut lines: Vec<String> = vec![
        "BEGIN:VCALENDAR".into(),
        "VERSION:2.0".into(),
        "PRODID:-//Pantry Host//Recipe Calendar//EN".into(),
        "CALSCALE:GREGORIAN".into(),
        "METHOD:PUBLISH".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{uid}"),
        format!("DTSTAMP:{}", ics_timestamp(now)),
        format!("DTSTART:{}", ics_timestamp(start)),
        format!("DURATION:{duration}"),
        ics_fold(&format!("SUMMARY:{}", ics_esc(&recipe.title))),
        ics_fold(&format!("DESCRIPTION:{description}")),
    ];

    if !tags.is_empty() {
        let categories: Vec<String> = tags.iter().map(|t| ics_esc(t)).collect();
        lines.push(ics_fold(&format!("CATEGORIES:{}", categories.join(","))));
    }
    if let Some(url) = recipe.source_url.as_deref() {
        if !url.is_empty() {
            lines.push(ics_fold(&format!("URL:{url}")));
        }
    }
    if let Some(p) = photo_url.as_deref() {
        if p.starts_with("http") {
            let fmt = if p.ends_with(".png") {
                "image/png"
            } else {
                "image/jpeg"
            };
            lines.push(ics_fold(&format!("ATTACH;FMTTYPE={fmt}:{p}")));
        }
    }
    if let Some(p) = recipe.prep_time {
        lines.push(format!("X-RECIPE-PREP-TIME:{p} min"));
    }
    if let Some(c) = recipe.cook_time {
        lines.push(format!("X-RECIPE-COOK-TIME:{c} min"));
    }
    if let Some(s) = recipe.servings {
        lines.push(format!("X-RECIPE-SERVINGS:{s}"));
    }
    if !cookware.is_empty() {
        let cw: Vec<String> = cookware.iter().map(|c| ics_esc(c)).collect();
        lines.push(ics_fold(&format!("X-RECIPE-COOKWARE:{}", cw.join(","))));
    }

    lines.push("END:VEVENT".into());
    lines.push("END:VCALENDAR".into());
    let body = lines.join("\r\n");

    let mut response = (StatusCode::OK, body).into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/calendar; charset=utf-8"),
    );
    response
}
