//! Minimal Anthropic Messages API client for the `generateRecipes`
//! resolver. Talks HTTP directly via `reqwest` — no SDK — because the only
//! call we make is `messages.create` with a single user message.
//!
//! The prompt is ported verbatim from `packages/app/lib/claude.ts`. Don't
//! drift it without thinking — small wording changes have measurable
//! effects on generated recipe quality.

use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::models::{CookwareRow, IngredientRow, parse_json_strings};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MODEL: &str = "claude-sonnet-4-6";
const MAX_TOKENS: u32 = 4096;
const TEMPERATURE: f32 = 1.0;
/// Generation can take 20-40s; the shared client's 15s default isn't enough.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedRecipe {
    pub title: String,
    pub description: Option<String>,
    pub instructions: String,
    pub servings: Option<i32>,
    pub prep_time: Option<i32>,
    pub cook_time: Option<i32>,
    pub tags: Option<Vec<String>>,
    pub required_cookware: Option<Vec<String>>,
    pub ingredients: Vec<GeneratedIngredient>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedIngredient {
    pub ingredient_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
}

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    temperature: f32,
    messages: Vec<MessagePart<'a>>,
}

#[derive(Serialize)]
struct MessagePart<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text { text: String },
    #[serde(other)]
    Other,
}

pub async fn generate_recipes(
    client: &reqwest::Client,
    api_key: &str,
    base_url: Option<&str>,
    prompt: &str,
) -> anyhow::Result<Vec<GeneratedRecipe>> {
    let body = MessagesRequest {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        messages: vec![MessagePart {
            role: "user",
            content: prompt,
        }],
    };
    let base = base_url.unwrap_or(DEFAULT_BASE_URL).trim_end_matches('/');
    let endpoint = format!("{base}/v1/messages");
    let resp = client
        .post(&endpoint)
        .timeout(REQUEST_TIMEOUT)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .context("Anthropic API request failed")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API returned {status}: {text}");
    }
    let parsed: MessagesResponse = resp
        .json()
        .await
        .context("Anthropic API returned malformed JSON")?;
    let text: String = parsed
        .content
        .into_iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text),
            _ => None,
        })
        .collect();
    parse_recipes_json(&text).context("could not parse recipes from Anthropic response")
}

/// Strip optional ```` ```json …``` ```` markdown fences and JSON-parse the
/// remainder. Matches the TS `text.replace(/^```(?:json)?\n?/m, '')…` cleanup.
fn parse_recipes_json(text: &str) -> anyhow::Result<Vec<GeneratedRecipe>> {
    let mut s = text.trim().to_string();
    if let Some(stripped) = s.strip_prefix("```json") {
        s = stripped.trim_start_matches('\n').to_string();
    } else if let Some(stripped) = s.strip_prefix("```") {
        s = stripped.trim_start_matches('\n').to_string();
    }
    if let Some(stripped) = s.strip_suffix("```") {
        s = stripped.trim_end_matches('\n').to_string();
    }
    let trimmed = s.trim();
    serde_json::from_str(trimmed).map_err(Into::into)
}

/// Build the user-message prompt. Verbatim port of `lib/claude.ts`. Composting
/// rules attach when any cookware row carries the `waste-cycler` or `compost`
/// tag — see CLAUDE.md "Composting tips".
pub fn build_recipe_prompt(ingredients: &[IngredientRow], cookware: &[CookwareRow]) -> String {
    let ingredient_list = ingredients
        .iter()
        .map(format_ingredient_for_prompt)
        .collect::<Vec<_>>()
        .join(", ");
    let ingredient_list = if ingredient_list.is_empty() {
        "none listed".to_string()
    } else {
        ingredient_list
    };

    let cookware_list = if cookware.is_empty() {
        "standard kitchen equipment".to_string()
    } else {
        cookware
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>()
            .join(", ")
    };

    let composters: Vec<&CookwareRow> = cookware
        .iter()
        .filter(|c| {
            parse_json_strings(c.tags_json.as_deref())
                .iter()
                .any(|t| t == "waste-cycler" || t == "compost")
        })
        .collect();

    let compost_context = if composters.is_empty() {
        String::new()
    } else {
        let mut clauses: Vec<String> = Vec::with_capacity(composters.len());
        for c in &composters {
            let suffix = match c.notes.as_deref() {
                Some(n) if !n.is_empty() => format!(" (composting device — {n})"),
                _ => " (composting device)".to_string(),
            };
            clauses.push(format!("a {}{suffix}", c.name));
        }
        let joined = clauses.join(" and ");
        format!(
            "\n\nThe family owns {joined}. For each recipe, append a final \
             instruction step starting with \"Compost:\" listing which scraps \
             from that recipe can go into the composter and which cannot, \
             based on the device's rules."
        )
    };

    format!(
        "You are a helpful home chef.\n\n\
         Available ingredients: {ingredient_list}\n\
         Available cookware: {cookware_list}\n\n\
         Generate 3 practical family recipes using primarily these ingredients. \
         Favor cookware the family owns. Default to 2 servings unless ingredients \
         clearly suggest more.\n\n\
         Tag guidance:\n\
         - If a recipe contains alcohol, high-mercury fish (swordfish, king mackerel, \
         tilefish, bigeye tuna), or excessive caffeine, add the \"breastfeeding-alert\" tag.\n\
         - If a recipe features galactagogues (oats, fenugreek, brewer's yeast, flaxseed, \
         fennel), add the \"lactation\" tag.\n\
         - Do NOT add \"breastfeeding-safe\" automatically — that is user opt-in only.\n\n\
         Ingredient item_size guidance:\n\
         - Use itemSize / itemSizeUnit when an ingredient is packaged in discrete countable \
         units with a measurable size (e.g. \"2 16oz pepper steaks\" → quantity 2, unit \
         \"whole\", itemSize 16, itemSizeUnit \"oz\"; \"1 15oz can of beans\" → quantity 1, \
         unit \"can\", itemSize 15, itemSizeUnit \"oz\").\n\
         - Leave itemSize/itemSizeUnit null for bulk measurements (e.g. \"2 cups flour\" → \
         quantity 2, unit \"cup\", itemSize null).{compost_context}\n\n\
         Respond with ONLY a valid JSON array — no markdown, no explanation — matching this schema:\n\
         [\n  \
           {{\n    \
             \"title\": \"string\",\n    \
             \"description\": \"string\",\n    \
             \"instructions\": \"string (full step-by-step, each step on a new line starting with a number)\",\n    \
             \"servings\": number,\n    \
             \"prepTime\": number (minutes),\n    \
             \"cookTime\": number (minutes),\n    \
             \"tags\": [\"string\"],\n    \
             \"requiredCookware\": [\"string\"],\n    \
             \"ingredients\": [\n      \
               {{ \"ingredientName\": \"string\", \"quantity\": number | null, \"unit\": \"string | null\", \"itemSize\": number | null, \"itemSizeUnit\": \"string | null\" }}\n    \
             ]\n  \
           }}\n\
         ]"
    )
}

fn format_ingredient_for_prompt(i: &IngredientRow) -> String {
    let qty = match i.quantity {
        Some(q) => match &i.unit {
            Some(u) if !u.is_empty() => format!("{q} {u}"),
            _ => format!("{q}"),
        },
        None => String::new(),
    };
    let qty = qty.trim().to_string();
    let size = match i.item_size {
        Some(s) => match &i.item_size_unit {
            Some(u) if !u.is_empty() => format!(" × {s}{u}"),
            _ => format!(" × {s}"),
        },
        None => String::new(),
    };
    let qty_part = if qty.is_empty() && size.is_empty() {
        String::new()
    } else {
        format!("{qty}{size}").trim().to_string()
    };
    if qty_part.is_empty() {
        i.name.clone()
    } else {
        format!("{} ({qty_part})", i.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_json_array() {
        let text = r#"[{"title":"X","instructions":"do it","ingredients":[]}]"#;
        let r = parse_recipes_json(text).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title, "X");
    }

    #[test]
    fn parses_json_wrapped_in_fences() {
        let text = "```json\n[{\"title\":\"Y\",\"instructions\":\"\",\"ingredients\":[]}]\n```";
        let r = parse_recipes_json(text).unwrap();
        assert_eq!(r[0].title, "Y");
    }

    #[test]
    fn parses_plain_fences_no_lang() {
        let text = "```\n[{\"title\":\"Z\",\"instructions\":\"\",\"ingredients\":[]}]\n```";
        let r = parse_recipes_json(text).unwrap();
        assert_eq!(r[0].title, "Z");
    }

    #[test]
    fn ingredient_formatting_with_qty_unit_size() {
        let i = IngredientRow {
            id: "x".into(),
            name: "Tomato Paste".into(),
            category: None,
            quantity: Some(3.0),
            unit: Some("can".into()),
            item_size: Some(6.0),
            item_size_unit: Some("oz".into()),
            always_on_hand: false,
            tags_json: None,
            aliases_json: None,
            barcode: None,
            product_meta: None,
            created_at: String::new(),
        };
        assert_eq!(
            format_ingredient_for_prompt(&i),
            "Tomato Paste (3 can × 6oz)"
        );
    }

    #[test]
    fn ingredient_formatting_bare_name() {
        let i = IngredientRow {
            id: "x".into(),
            name: "Salt".into(),
            category: None,
            quantity: None,
            unit: None,
            item_size: None,
            item_size_unit: None,
            always_on_hand: false,
            tags_json: None,
            aliases_json: None,
            barcode: None,
            product_meta: None,
            created_at: String::new(),
        };
        assert_eq!(format_ingredient_for_prompt(&i), "Salt");
    }

    #[test]
    fn prompt_includes_composting_when_tagged() {
        let cookware = vec![CookwareRow {
            id: "c1".into(),
            name: "Lomi".into(),
            brand: None,
            tags_json: Some(r#"["waste-cycler"]"#.into()),
            notes: Some("Avoid citrus peels".into()),
            created_at: String::new(),
        }];
        let prompt = build_recipe_prompt(&[], &cookware);
        assert!(prompt.contains("composting device — Avoid citrus peels"));
        assert!(prompt.contains("Compost:"));
    }

    #[test]
    fn prompt_omits_composting_when_no_match() {
        let cookware = vec![CookwareRow {
            id: "c1".into(),
            name: "Cast Iron Skillet".into(),
            brand: None,
            tags_json: Some(r#"["pan"]"#.into()),
            notes: None,
            created_at: String::new(),
        }];
        let prompt = build_recipe_prompt(&[], &cookware);
        assert!(!prompt.contains("Compost:"));
    }
}
