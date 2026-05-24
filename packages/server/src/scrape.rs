//! Port of the three-tier recipe URL scraper from `graphql-server.ts`.
//!
//! Order of attempts:
//! 1. JSON-LD (`<script type="application/ld+json">…</script>`, `@type=Recipe`
//!    or `@graph` containing one). Most modern recipe sites have this.
//! 2. Schema.org microdata (`itemtype=…schema.org/Recipe` + `itemprop=…`).
//! 3. Heuristic HTML parsing (`class="*ingredient*"` containers, headings).
//!
//! Each tier returns `Option<ParsedRecipe>`. The orchestrator picks the
//! first one that yields a usable result. If all three miss, the route
//! falls back to a bare-title-only response (matches TS behavior).

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::db::Pool;
use crate::ingredient_parse::parse_ingredient_line;
use crate::iso_duration::parse_duration;

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParsedRecipe {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub servings: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prep_time: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cook_time: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photo_url: Option<String>,
    pub ingredients: Vec<ParsedRecipeIngredient>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub required_cookware: Vec<String>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParsedRecipeIngredient {
    pub ingredient_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
}

/// Walk all three tiers in order. Returns the first one that yielded a
/// title (and, for the heuristic tier, also some ingredients).
pub fn extract(html: &str) -> Option<ParsedRecipe> {
    if let Some(r) = extract_from_all_ld_json(html) {
        return Some(r);
    }
    if let Some(r) = extract_from_microdata(html) {
        if !r.title.is_empty() {
            return Some(r);
        }
    }
    if let Some(r) = extract_from_html_heuristic(html) {
        if !r.title.is_empty() && !r.ingredients.is_empty() {
            return Some(r);
        }
    }
    None
}

/// Bare-title fallback used when all three tiers miss. Tries `<h1>` then
/// `<title>`. Returns `None` if neither is present.
pub fn extract_title_only(html: &str) -> Option<String> {
    static H1: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<h1[^>]*>([^<]+)</h1>").unwrap());
    static TITLE_TAG: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<title[^>]*>([^<]+)</title>").unwrap());
    let raw = H1
        .captures(html)
        .or_else(|| TITLE_TAG.captures(html))
        .and_then(|c| c.get(1))
        .map(|m| decode_html_entities(m.as_str().trim()))?;
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// Walk every `<script type="application/ld+json">` block, JSON-parse each,
/// look for `@type=Recipe` or `@graph[].@type=Recipe`. Return the first hit
/// that yields a non-empty title.
fn extract_from_all_ld_json(html: &str) -> Option<ParsedRecipe> {
    static LDJSON_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)<script[^>]+type="application/ld\+json"[^>]*>([\s\S]*?)</script>"#)
            .unwrap()
    });
    for cap in LDJSON_BLOCK.captures_iter(html) {
        let Some(payload) = cap.get(1) else { continue };
        let Ok(data) = serde_json::from_str::<Value>(payload.as_str()) else {
            continue;
        };
        if is_recipe_or_graph(&data) {
            if let Some(r) = extract_from_ld_json(&data) {
                if !r.title.is_empty() {
                    return Some(r);
                }
            }
        }
    }
    None
}

fn is_recipe_or_graph(data: &Value) -> bool {
    if data.get("@graph").is_some() {
        return true;
    }
    matches_recipe_type(data)
}

fn matches_recipe_type(node: &Value) -> bool {
    match node.get("@type") {
        Some(Value::String(s)) => s == "Recipe",
        Some(Value::Array(arr)) => arr.iter().any(|v| v.as_str() == Some("Recipe")),
        _ => false,
    }
}

fn extract_from_ld_json(data: &Value) -> Option<ParsedRecipe> {
    if let Some(graph) = data.get("@graph").and_then(|v| v.as_array()) {
        for node in graph {
            if matches_recipe_type(node) {
                return extract_from_ld_json(node);
            }
        }
    }
    let title = data.get("name").and_then(|v| v.as_str())?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let description = data
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let instructions = parse_instructions(data.get("recipeInstructions"));
    let servings = parse_servings(data.get("recipeYield"));
    let prep_time = data
        .get("prepTime")
        .and_then(|v| v.as_str())
        .and_then(parse_duration);
    let cook_time = data
        .get("cookTime")
        .and_then(|v| v.as_str())
        .and_then(parse_duration);
    let tags = build_tags(data, &title);
    let photo_url = parse_photo_url(data.get("image"));
    let ingredients = data
        .get("recipeIngredient")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(parse_ingredient)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(ParsedRecipe {
        title,
        description,
        instructions,
        servings,
        prep_time,
        cook_time,
        tags,
        photo_url,
        ingredients,
        required_cookware: Vec::new(),
    })
}

fn parse_ingredient(line: &str) -> ParsedRecipeIngredient {
    let p = parse_ingredient_line(line);
    ParsedRecipeIngredient {
        ingredient_name: p.ingredient_name,
        quantity: p.quantity,
        unit: p.unit,
    }
}

fn parse_instructions(val: Option<&Value>) -> String {
    let Some(v) = val else {
        return String::new();
    };
    let steps = flatten_instruction_steps(v);
    if steps.is_empty() {
        if let Some(s) = v.as_str() {
            return s.to_string();
        }
        return String::new();
    }
    steps
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n")
}

fn flatten_instruction_steps(val: &Value) -> Vec<String> {
    if let Some(s) = val.as_str() {
        return vec![s.to_string()];
    }
    if let Some(arr) = val.as_array() {
        let mut out = Vec::new();
        for step in arr {
            if let Some(s) = step.as_str() {
                out.push(s.to_string());
                continue;
            }
            if let Some(obj) = step.as_object() {
                if obj.get("@type").and_then(|v| v.as_str()) == Some("HowToSection") {
                    if let Some(items) = obj.get("itemListElement") {
                        out.extend(flatten_instruction_steps(items));
                    }
                } else if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                    out.push(text.to_string());
                }
            }
        }
        return out;
    }
    Vec::new()
}

fn parse_servings(val: Option<&Value>) -> Option<u32> {
    let v = val?;
    if let Some(n) = v.as_f64() {
        // JS `Math.round(2.5)` is 3 (half-up). Rust `f64::round` is half-away-
        // from-zero, identical for positives.
        if n.is_finite() && n >= 0.0 {
            return Some(n.round() as u32);
        }
        return None;
    }
    if let Some(s) = v.as_str() {
        return js_parse_int_leading(s);
    }
    if let Some(arr) = v.as_array() {
        return arr.first().and_then(|x| parse_servings(Some(x)));
    }
    None
}

/// Match JS `parseInt(s, 10)` for the common case: read leading digits,
/// ignore everything after. Returns `None` if no leading digit.
fn js_parse_int_leading(s: &str) -> Option<u32> {
    let head: String = s
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if head.is_empty() {
        None
    } else {
        head.parse().ok()
    }
}

fn parse_photo_url(val: Option<&Value>) -> Option<String> {
    let v = val?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = v.as_array() {
        if let Some(first) = arr.first() {
            if let Some(s) = first.as_str() {
                return Some(s.to_string());
            }
            if let Some(url) = first.get("url").and_then(|v| v.as_str()) {
                return Some(url.to_string());
            }
        }
    }
    if let Some(url) = v.get("url").and_then(|v| v.as_str()) {
        return Some(url.to_string());
    }
    None
}

fn build_tags(data: &Value, title: &str) -> Vec<String> {
    let mut raw: Vec<String> = Vec::new();
    if let Some(k) = data.get("keywords") {
        if let Some(s) = k.as_str() {
            raw.extend(s.split(',').map(|s| s.trim().to_string()));
        } else if let Some(arr) = k.as_array() {
            raw.extend(
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string()),
            );
        }
    }
    if let Some(c) = data.get("recipeCategory") {
        if let Some(s) = c.as_str() {
            raw.push(s.to_string());
        } else if let Some(arr) = c.as_array() {
            raw.extend(
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string()),
            );
        }
    }
    let title_lower = title.to_lowercase();
    raw.into_iter()
        .filter(|t| filter_tag(t, &title_lower))
        .collect()
}

fn filter_tag(tag: &str, title_lower: &str) -> bool {
    if tag.is_empty() {
        return false;
    }
    let tag_lower = tag.to_lowercase();
    if title_lower.is_empty() {
        return true;
    }
    if tag_lower.contains(title_lower) || title_lower.contains(&tag_lower) {
        return false;
    }
    static HOW_TO: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^how to (make|cook|prepare)\b").unwrap());
    if HOW_TO.is_match(tag) {
        return false;
    }
    static RECIPE_INGR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\b(recipe|ingredients)\s*$").unwrap());
    if RECIPE_INGR.is_match(tag) {
        for word in title_lower.split_whitespace() {
            if tag_lower.contains(word) {
                return false;
            }
        }
    }
    true
}

// ── Microdata ─────────────────────────────────────────────────────────────────

fn extract_from_microdata(html: &str) -> Option<ParsedRecipe> {
    static CONTAINER_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)<[^>]+itemtype="[^"]*schema\.org/Recipe[^"]*"[^>]*>([\s\S]*)"#).unwrap()
    });
    let block = CONTAINER_RE
        .captures(html)
        .and_then(|c| c.get(1))?
        .as_str();

    static NAME_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)itemprop="name"[^>]*>([^<]+)"#).unwrap());
    static NAME_NESTED_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)itemprop="name"[\s\S]*?<(?:span|h[1-6]|p)[^>]*>([^<]+)"#).unwrap()
    });
    let title_raw = NAME_RE
        .captures(block)
        .or_else(|| NAME_NESTED_RE.captures(block))
        .and_then(|c| c.get(1))
        .map(|m| decode_html_entities(m.as_str().trim()))?;
    if title_raw.is_empty() {
        return None;
    }

    // Ingredients
    let mut ings: Vec<String> = Vec::new();
    static ING_NESTED_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)itemprop="recipeIngredient"[\s\S]*?<span[^>]*>([\s\S]*?)</span>\s*</span>"#,
        )
        .unwrap()
    });
    static ING_DIRECT_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)itemprop="recipeIngredient"[^>]*>([^<]+)<"#).unwrap());
    for cap in ING_NESTED_RE.captures_iter(block) {
        if let Some(c) = cap.get(1) {
            let text = decode_html_entities(strip_tags(c.as_str()).trim());
            if !text.is_empty() {
                ings.push(text);
            }
        }
    }
    if ings.is_empty() {
        for cap in ING_DIRECT_RE.captures_iter(block) {
            if let Some(c) = cap.get(1) {
                let text = decode_html_entities(c.as_str().trim());
                if !text.is_empty() {
                    ings.push(text);
                }
            }
        }
    }

    // Instructions
    let mut steps: Vec<String> = Vec::new();
    static INSTR_NESTED_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)itemprop="recipeInstructions?"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)</span>"#,
        )
        .unwrap()
    });
    static INSTR_DIRECT_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)itemprop="recipeInstructions?"[^>]*>([^<]+)<"#).unwrap()
    });
    for cap in INSTR_NESTED_RE.captures_iter(block) {
        if let Some(c) = cap.get(1) {
            let text = decode_html_entities(strip_tags(c.as_str()).trim());
            if !text.is_empty() {
                steps.push(text);
            }
        }
    }
    if steps.is_empty() {
        for cap in INSTR_DIRECT_RE.captures_iter(block) {
            if let Some(c) = cap.get(1) {
                let text = decode_html_entities(c.as_str().trim());
                if !text.is_empty() {
                    steps.push(text);
                }
            }
        }
    }
    let instructions = if steps.is_empty() {
        String::new()
    } else {
        steps
            .into_iter()
            .enumerate()
            .map(|(i, s)| format!("{}. {}", i + 1, s))
            .collect::<Vec<_>>()
            .join("\n")
    };

    // Times + servings
    static PREP_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)itemprop="prepTime"[^>]*content="([^"]+)""#).unwrap()
    });
    static COOK_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)itemprop="cookTime"[^>]*content="([^"]+)""#).unwrap()
    });
    static SERV_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)itemprop="recipeYield"[^>]*(?:content="([^"]+)"|>([^<]+))"#).unwrap()
    });
    let prep_time = PREP_RE
        .captures(block)
        .and_then(|c| c.get(1))
        .and_then(|m| parse_duration(m.as_str()));
    let cook_time = COOK_RE
        .captures(block)
        .and_then(|c| c.get(1))
        .and_then(|m| parse_duration(m.as_str()));
    let servings = SERV_RE
        .captures(block)
        .and_then(|c| c.get(1).or_else(|| c.get(2)))
        .and_then(|m| js_parse_int_leading(m.as_str()));

    Some(ParsedRecipe {
        title: title_raw,
        description: None,
        instructions,
        servings,
        prep_time,
        cook_time,
        tags: Vec::new(),
        photo_url: None,
        ingredients: ings.iter().map(|s| parse_ingredient(s)).collect(),
        required_cookware: Vec::new(),
    })
}

// ── Heuristic HTML ───────────────────────────────────────────────────────────

fn extract_from_html_heuristic(html: &str) -> Option<ParsedRecipe> {
    let title = extract_title_only(html)?;

    let mut ingredients: Vec<String> = Vec::new();

    // Strategy 1: `class="*ingredient*"` container
    static ING_CONTAINER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)<(?:div|section|ul)[^>]*class="[^"]*ingredient[^"]*"[^>]*>([\s\S]*?)</(?:div|section|ul)>"#,
        )
        .unwrap()
    });
    static LI_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<li[^>]*>([\s\S]*?)</li>").unwrap());
    static BR_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
    static UNIT_HINT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\d|cup|tsp|tbsp|oz|lb|pinch|dash").unwrap());

    for cap in ING_CONTAINER.captures_iter(html) {
        if let Some(block) = cap.get(1) {
            let block_str = block.as_str();
            for li in LI_RE.captures_iter(block_str) {
                if let Some(text) = li.get(1) {
                    let cleaned = decode_html_entities(strip_tags(text.as_str()).trim());
                    if !cleaned.is_empty() && cleaned.len() < 200 {
                        ingredients.push(cleaned);
                    }
                }
            }
            if ingredients.is_empty() {
                let no_br = BR_RE.replace_all(block_str, "\n");
                let stripped = strip_tags(&no_br);
                for line in stripped.split('\n') {
                    let cleaned = decode_html_entities(line.trim());
                    if !cleaned.is_empty() && cleaned.len() < 200 && UNIT_HINT.is_match(&cleaned) {
                        ingredients.push(cleaned);
                    }
                }
            }
        }
    }

    // Strategy 2: heading "Ingredients" → <ul>
    if ingredients.is_empty() {
        static HEAD_ING: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)<h[2-4][^>]*>[^<]*ingredients[^<]*</h[2-4]>\s*([\s\S]*?)(?=<h[2-4]|</section|</article)")
                .unwrap()
        });
        for cap in HEAD_ING.captures_iter(html) {
            if let Some(block) = cap.get(1) {
                for li in LI_RE.captures_iter(block.as_str()) {
                    if let Some(text) = li.get(1) {
                        let cleaned = decode_html_entities(strip_tags(text.as_str()).trim());
                        if !cleaned.is_empty() && cleaned.len() < 200 {
                            ingredients.push(cleaned);
                        }
                    }
                }
                if !ingredients.is_empty() {
                    break;
                }
            }
        }
    }

    if ingredients.is_empty() {
        return None;
    }

    // Instructions — strategy A: container class
    let mut instructions = String::new();
    static INSTR_CONTAINER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)<(?:div|section|ol)[^>]*class="[^"]*(?:instruction|direction|step|method)[^"]*"[^>]*>([\s\S]*?)</(?:div|section|ol)>"#,
        )
        .unwrap()
    });
    for cap in INSTR_CONTAINER.captures_iter(html) {
        if let Some(block) = cap.get(1) {
            let mut steps: Vec<String> = Vec::new();
            for li in LI_RE.captures_iter(block.as_str()) {
                if let Some(text) = li.get(1) {
                    let cleaned = decode_html_entities(strip_tags(text.as_str()).trim());
                    if !cleaned.is_empty() {
                        steps.push(cleaned);
                    }
                }
            }
            if !steps.is_empty() {
                instructions = number_steps(steps);
                break;
            }
        }
    }

    // Instructions — strategy B: heading + content
    if instructions.is_empty() {
        static INSTR_HEAD: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)<h[2-4][^>]*>[^<]*(?:instruction|direction|method|step)[^<]*</h[2-4]>\s*([\s\S]*?)(?=<h[2-4]|</section|</article|<div\s)")
                .unwrap()
        });
        static SOCIAL_SKIP: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)^(share|tweet|pin|print|email|facebook|twitter)").unwrap()
        });
        static NUM_PREFIX: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^\d+\.").unwrap());
        for cap in INSTR_HEAD.captures_iter(html) {
            if let Some(block) = cap.get(1) {
                let block_str = block.as_str();
                let mut steps: Vec<String> = Vec::new();
                for li in LI_RE.captures_iter(block_str) {
                    if let Some(text) = li.get(1) {
                        let cleaned = decode_html_entities(strip_tags(text.as_str()).trim());
                        if !cleaned.is_empty() {
                            steps.push(cleaned);
                        }
                    }
                }
                if !steps.is_empty() {
                    instructions = number_steps(steps);
                    break;
                }
                // Plain-text fallback inside the heading block
                let with_lines = BR_RE.replace_all(block_str, "\n");
                let stripped = strip_tags(&with_lines);
                let mut plain: Vec<String> = Vec::new();
                for line in stripped.split('\n') {
                    let t = line.trim();
                    if t.is_empty() || t.len() >= 300 {
                        continue;
                    }
                    if SOCIAL_SKIP.is_match(t) || t.starts_with("http") {
                        continue;
                    }
                    plain.push(t.to_string());
                }
                if !plain.is_empty() {
                    let lines: Vec<String> = plain
                        .into_iter()
                        .enumerate()
                        .map(|(i, s)| {
                            if NUM_PREFIX.is_match(&s) {
                                s
                            } else {
                                format!("{}. {}", i + 1, s)
                            }
                        })
                        .collect();
                    instructions = lines.join("\n");
                    break;
                }
            }
        }
    }

    Some(ParsedRecipe {
        title,
        description: None,
        instructions,
        servings: None,
        prep_time: None,
        cook_time: None,
        tags: Vec::new(),
        photo_url: None,
        ingredients: ingredients.iter().map(|s| parse_ingredient(s)).collect(),
        required_cookware: Vec::new(),
    })
}

fn number_steps(steps: Vec<String>) -> String {
    steps
        .into_iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n")
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/// Match the 6-entity TS implementation exactly; intentionally narrower than
/// a full HTML entity decoder. Anything else passes through verbatim.
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn strip_tags(s: &str) -> String {
    static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    TAGS.replace_all(s, "").to_string()
}

/// Run the case-insensitive cookware substring scan against the recipe's
/// concatenated text. Mirrors `detectCookware` in the Node graphql-server.
pub async fn detect_cookware(pool: &Pool, recipe: &ParsedRecipe) -> Vec<String> {
    let mut parts = vec![recipe.title.clone()];
    if let Some(d) = &recipe.description {
        parts.push(d.clone());
    }
    parts.push(recipe.instructions.clone());
    for ing in &recipe.ingredients {
        parts.push(ing.ingredient_name.clone());
    }
    let text = parts.join(" ").to_lowercase();

    let names_result: async_graphql::Result<Vec<String>> =
        crate::db::with_conn(pool, |conn| {
            let mut stmt = conn.prepare("SELECT name FROM cookware")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await;
    let names = match names_result {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    static SIZE_SUFFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)\s+\d+[\w"]*$"#).unwrap());

    names
        .into_iter()
        .filter(|name| {
            let lower = name.to_lowercase();
            let base = SIZE_SUFFIX.replace(&lower, "").trim().to_string();
            text.contains(&lower) || (!base.is_empty() && text.contains(&base))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_six_named_entities() {
        assert_eq!(
            decode_html_entities("a &amp; b &nbsp;&lt;c&gt; &quot;x&quot; &#39;y&#39;"),
            "a & b  <c> \"x\" 'y'"
        );
    }

    #[test]
    fn jsonld_canonical_recipe() {
        let html = r##"
            <html><head>
            <script type="application/ld+json">
            {
              "@type": "Recipe",
              "name": "Test Pie",
              "description": "A test pie",
              "recipeIngredient": ["1 cup flour", "½ tsp salt"],
              "recipeInstructions": ["Mix.", "Bake."],
              "recipeYield": "8",
              "prepTime": "PT15M",
              "cookTime": "PT45M",
              "keywords": "dessert, baked",
              "image": "https://example.com/pie.jpg"
            }
            </script>
            </head></html>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(r.title, "Test Pie");
        assert_eq!(r.description.as_deref(), Some("A test pie"));
        assert_eq!(r.servings, Some(8));
        assert_eq!(r.prep_time, Some(15));
        assert_eq!(r.cook_time, Some(45));
        assert_eq!(r.tags, vec!["dessert".to_string(), "baked".to_string()]);
        assert_eq!(r.photo_url.as_deref(), Some("https://example.com/pie.jpg"));
        assert_eq!(r.ingredients.len(), 2);
        assert_eq!(r.ingredients[0].ingredient_name, "flour");
        assert_eq!(r.ingredients[0].quantity, Some(1.0));
        assert_eq!(r.ingredients[0].unit.as_deref(), Some("cup"));
        assert_eq!(r.ingredients[1].quantity, Some(0.5));
        assert_eq!(r.ingredients[1].unit.as_deref(), Some("tsp"));
        assert_eq!(r.instructions, "1. Mix.\n2. Bake.");
    }

    #[test]
    fn jsonld_graph_with_recipe() {
        let html = r##"
            <script type="application/ld+json">
            { "@graph": [
              { "@type": "WebSite", "name": "Cooking Blog" },
              { "@type": "Recipe", "name": "Graph Recipe",
                "recipeIngredient": ["2 eggs"],
                "recipeInstructions": "Crack and scramble." }
            ]}
            </script>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(r.title, "Graph Recipe");
        assert_eq!(r.ingredients[0].ingredient_name, "eggs");
        assert_eq!(r.ingredients[0].quantity, Some(2.0));
    }

    #[test]
    fn jsonld_image_array_of_objects() {
        let html = r##"
            <script type="application/ld+json">
            { "@type": "Recipe", "name": "X",
              "recipeIngredient": [],
              "image": [{ "url": "https://example.com/a.jpg" }, "fallback"] }
            </script>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(r.photo_url.as_deref(), Some("https://example.com/a.jpg"));
    }

    #[test]
    fn jsonld_howto_section_flattens() {
        let html = r##"
            <script type="application/ld+json">
            { "@type": "Recipe", "name": "X",
              "recipeIngredient": [],
              "recipeInstructions": [
                { "@type": "HowToSection", "itemListElement": [
                  { "@type": "HowToStep", "text": "Section step 1" },
                  { "@type": "HowToStep", "text": "Section step 2" }
                ]},
                { "@type": "HowToStep", "text": "Top-level step" }
              ]}
            </script>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(
            r.instructions,
            "1. Section step 1\n2. Section step 2\n3. Top-level step"
        );
    }

    #[test]
    fn jsonld_drops_seo_stuffed_tags() {
        // Title "Apple Pie", tag "Apple Pie Recipe" → drop because tag
        // contains the full title.
        let html = r##"
            <script type="application/ld+json">
            { "@type": "Recipe", "name": "Apple Pie",
              "recipeIngredient": [],
              "keywords": ["Apple Pie Recipe", "How to make apple pie", "dessert"] }
            </script>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(r.tags, vec!["dessert".to_string()]);
    }

    #[test]
    fn microdata_falls_back_when_no_jsonld() {
        let html = r##"
            <div itemtype="https://schema.org/Recipe">
              <h1 itemprop="name">Microdata Soup</h1>
              <meta itemprop="prepTime" content="PT10M">
              <meta itemprop="cookTime" content="PT30M">
              <span itemprop="recipeYield">4</span>
              <div itemprop="recipeIngredient">2 cups broth</div>
              <div itemprop="recipeIngredient">1 onion</div>
              <div itemprop="recipeInstructions">Simmer everything.</div>
            </div>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(r.title, "Microdata Soup");
        assert_eq!(r.prep_time, Some(10));
        assert_eq!(r.cook_time, Some(30));
        assert_eq!(r.servings, Some(4));
        assert_eq!(r.ingredients.len(), 2);
        assert_eq!(r.ingredients[0].ingredient_name, "broth");
        assert_eq!(r.ingredients[0].quantity, Some(2.0));
        assert!(r.instructions.contains("Simmer everything."));
    }

    #[test]
    fn heuristic_class_ingredient_container() {
        let html = r##"
            <html><head><title>Heuristic Bake</title></head>
            <body>
              <div class="ingredient-list">
                <ul>
                  <li>1 cup oats</li>
                  <li>2 tbsp honey</li>
                </ul>
              </div>
              <ol class="instructions-list">
                <li>Mix oats and honey.</li>
                <li>Bake at 350F for 20 minutes.</li>
              </ol>
            </body></html>
        "##;
        let r = extract(html).expect("extract");
        assert_eq!(r.title, "Heuristic Bake");
        assert_eq!(r.ingredients.len(), 2);
        assert_eq!(r.ingredients[0].ingredient_name, "oats");
        assert_eq!(r.ingredients[0].quantity, Some(1.0));
        assert_eq!(r.ingredients[0].unit.as_deref(), Some("cup"));
        assert!(r.instructions.contains("Mix oats and honey."));
        assert!(r.instructions.starts_with("1. "));
    }

    #[test]
    fn no_recipe_returns_none() {
        let html = "<html><body><p>Just an article, no recipe.</p></body></html>";
        assert!(extract(html).is_none());
    }

    #[test]
    fn title_only_fallback() {
        let html = "<html><head><title>Just A Page</title></head><body><p>No recipe here.</p></body></html>";
        assert_eq!(extract_title_only(html).as_deref(), Some("Just A Page"));
    }

    #[test]
    fn title_only_prefers_h1() {
        let html = "<html><head><title>Tab Title</title></head><body><h1>Page Heading</h1></body></html>";
        assert_eq!(extract_title_only(html).as_deref(), Some("Page Heading"));
    }
}
