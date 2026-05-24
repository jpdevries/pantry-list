//! `/api/lookup-barcode?code=<EAN/UPC>` — Open Food Facts proxy.
//!
//! Port of `packages/app/pages/api/lookup-barcode.ts`. Returns the same
//! JSON shape (`name`, `brand`, `category`, `quantity`, `unit`,
//! `itemSize`, `itemSizeUnit`, `barcode`, `meta`) so the existing
//! BarcodeScanner client works unchanged.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::AppState;

const ML_PER_FLOZ: f64 = 29.5735;
const G_PER_OZ: f64 = 28.3495;
const SOFT_META_CAP: usize = 8 * 1024;

#[derive(Deserialize)]
pub struct BarcodeQuery {
    pub code: Option<String>,
}

fn map_category(categories: &str) -> &'static str {
    let lower = categories.to_ascii_lowercase();
    // Order matters — frozen first so "frozen blueberries" doesn't fall
    // into "fruit". Mirrors the order in lookup-barcode.ts.
    if lower.contains("frozen") {
        return "frozen";
    }
    if lower.contains("fruit") || lower.contains("berry") || lower.contains("melon") {
        return "fruit";
    }
    if lower.contains("produce") || lower.contains("vegetable") || lower.contains("salad") {
        return "vegetables";
    }
    if lower.contains("dairy")
        || lower.contains("milk")
        || lower.contains("cheese")
        || lower.contains("yogurt")
    {
        return "dairy";
    }
    if lower.contains("egg") {
        return "eggs";
    }
    if lower.contains("seafood")
        || lower.contains("fish")
        || lower.contains("shrimp")
        || lower.contains("salmon")
    {
        return "seafood & fish";
    }
    if lower.contains("meat")
        || lower.contains("poultry")
        || lower.contains("chicken")
        || lower.contains("beef")
        || lower.contains("pork")
    {
        return "meat & poultry";
    }
    if lower.contains("tofu") || lower.contains("tempeh") || lower.contains("soy") {
        return "tofu & tempeh";
    }
    if lower.contains("bean")
        || lower.contains("lentil")
        || lower.contains("legume")
        || lower.contains("chickpea")
    {
        return "legumes & pulses";
    }
    if lower.contains("almond milk")
        || lower.contains("oat milk")
        || lower.contains("soy milk")
        || lower.contains("coconut milk")
        || lower.contains("plant-based milk")
        || lower.contains("rice milk")
    {
        return "plant-based milks";
    }
    if lower.contains("nut")
        || lower.contains("seed")
        || lower.contains("almond")
        || lower.contains("peanut")
    {
        return "nuts & seeds";
    }
    if lower.contains("deli")
        || lower.contains("charcuterie")
        || lower.contains("sausage")
        || lower.contains("salami")
    {
        return "deli & charcuterie";
    }
    if lower.contains("beverage")
        || lower.contains("drink")
        || lower.contains("juice")
        || lower.contains("soda")
        || lower.contains("water")
        || lower.contains("coffee")
        || lower.contains("tea")
    {
        return "beverages";
    }
    if lower.contains("condiment")
        || lower.contains("sauce")
        || lower.contains("ketchup")
        || lower.contains("mustard")
        || lower.contains("mayo")
    {
        return "condiments & sauces";
    }
    if lower.contains("oil") || lower.contains("vinegar") {
        return "oils & vinegars";
    }
    if lower.contains("spice") || lower.contains("herb") || lower.contains("seasoning") {
        return "herbs & spices";
    }
    if lower.contains("flour") || lower.contains("sugar") || lower.contains("baking") {
        return "baking";
    }
    if lower.contains("snack")
        || lower.contains("chip")
        || lower.contains("cracker")
        || lower.contains("cookie")
    {
        return "snacks";
    }
    if lower.contains("can") || lower.contains("jar") || lower.contains("canned") {
        return "canned & jarred";
    }
    if lower.contains("grain")
        || lower.contains("rice")
        || lower.contains("pasta")
        || lower.contains("cereal")
        || lower.contains("bread")
    {
        return "dry goods & grains";
    }
    "other"
}

fn map_unit(off_unit: &str) -> Option<&'static str> {
    match off_unit.to_ascii_lowercase().as_str() {
        "ml" | "milliliter" | "millilitre" | "milliliters" | "millilitres" => Some("ml"),
        "l" | "liter" | "litre" | "liters" | "litres" => Some("L"),
        "oz" | "ounce" | "ounces" => Some("oz"),
        "fl oz" => Some("fl oz"),
        "lb" | "lbs" | "pound" | "pounds" => Some("lb"),
        "g" | "gram" | "grams" => Some("g"),
        "kg" | "kilogram" | "kilograms" => Some("kg"),
        _ => None,
    }
}

fn to_imperial(qty: f64, unit: &str) -> (f64, &'static str) {
    match unit {
        "ml" => {
            let floz = qty / ML_PER_FLOZ;
            let rounded = (floz * 2.0).round() / 2.0;
            if rounded >= 128.0 {
                ((floz / 128.0 * 10.0).round() / 10.0, "gal")
            } else if rounded >= 32.0 {
                ((floz / 32.0 * 10.0).round() / 10.0, "qt")
            } else {
                (if rounded == 0.0 { 1.0 } else { rounded }, "fl oz")
            }
        }
        "L" => to_imperial(qty * 1000.0, "ml"),
        "g" => {
            let oz = qty / G_PER_OZ;
            if oz >= 16.0 {
                let lb = (oz / 16.0 * 10.0).round() / 10.0;
                (lb, "lb")
            } else {
                let rounded = (oz * 2.0).round() / 2.0;
                (if rounded == 0.0 { 1.0 } else { rounded }, "oz")
            }
        }
        "kg" => to_imperial(qty * 1000.0, "g"),
        _ => {
            let static_unit = match unit {
                "fl oz" => "fl oz",
                "oz" => "oz",
                "lb" => "lb",
                "gal" => "gal",
                "qt" => "qt",
                "pt" => "pt",
                "cup" => "cup",
                "whole" => "whole",
                _ => "whole",
            };
            (qty, static_unit)
        }
    }
}

fn detect_unit_from_string(qty_str: &str) -> Option<&'static str> {
    let s = qty_str.to_ascii_lowercase();
    // Order matches lookup-barcode.ts — "fl oz" before "oz" so the
    // longer match wins.
    if regex_matches(&s, r"fl\s*oz") {
        return Some("fl oz");
    }
    if s.contains("ml") || s.contains("milliliter") || s.contains("millilitre") {
        return Some("ml");
    }
    if regex_matches(&s, r"\bl\b") || s.contains("liter") || s.contains("litre") {
        return Some("L");
    }
    if regex_matches(&s, r"\boz\b") {
        return Some("oz");
    }
    if regex_matches(&s, r"\blbs?\b") || s.contains("pound") {
        return Some("lb");
    }
    if regex_matches(&s, r"\bkg\b") || s.contains("kilogram") {
        return Some("kg");
    }
    if regex_matches(&s, r"\bg\b(?!rain)") || s.contains("gram") {
        return Some("g");
    }
    if regex_matches(&s, r"\bgal\b") || s.contains("gallon") {
        return Some("gal");
    }
    if regex_matches(&s, r"\bqt\b") || s.contains("quart") {
        return Some("qt");
    }
    if regex_matches(&s, r"\bpt\b") || s.contains("pint") {
        return Some("pt");
    }
    if regex_matches(&s, r"\bcup") {
        return Some("cup");
    }
    None
}

fn regex_matches(haystack: &str, pattern: &str) -> bool {
    // We pull regex in anyway for /fetch-recipe; one global re-compile per
    // call is fine for the few patterns we use here. If this becomes hot
    // we can swap to once-cell Regex.
    regex::Regex::new(pattern)
        .ok()
        .map(|r| r.is_match(haystack))
        .unwrap_or(false)
}

fn extract_first_number(s: &str) -> Option<f64> {
    let re = regex::Regex::new(r"([\d.]+)").ok()?;
    re.captures(s)?.get(1)?.as_str().parse().ok()
}

// ── OFF metadata allowlisting (mirror packages/shared/src/product-meta.ts) ──

fn trim_string<'a>(v: Option<&'a Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?.to_string();
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > max {
        // Truncate by char boundary, not bytes.
        Some(s.chars().take(max).collect())
    } else {
        Some(s)
    }
}

fn trim_string_array(v: Option<&Value>, max: usize) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str().filter(|s| !s.is_empty()).map(str::to_string))
        .take(max)
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn trim_nutriments(v: Option<&Value>) -> Option<serde_json::Map<String, Value>> {
    let obj = v?.as_object()?;
    let mut out = serde_json::Map::new();
    for (k, val) in obj {
        // Keep finite f64 only, and only the _100g / _serving suffixed keys.
        let n = match val {
            Value::Number(num) => num.as_f64().filter(|x| x.is_finite()),
            _ => None,
        };
        let Some(n) = n else { continue };
        if k.ends_with("_100g") || k.ends_with("_serving") {
            out.insert(
                k.clone(),
                Value::Number(serde_json::Number::from_f64(n).unwrap()),
            );
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Mirror of `allowlistProductMeta()` from product-meta.ts: keep only the
/// allowlisted OFF fields, cap individual strings, enforce a soft total-
/// size cap by dropping the heaviest fields in order.
fn allowlist_product_meta(raw: &Value) -> Option<Value> {
    let mut meta = serde_json::Map::new();

    if let Some(code) = trim_string(raw.get("code"), 64) {
        meta.insert("code".into(), Value::String(code));
    }
    if let Some(brands) = trim_string(raw.get("brands"), 200) {
        let first = brands.split(',').next().unwrap_or("").trim().to_string();
        if !first.is_empty() {
            meta.insert("brands".into(), Value::String(first));
        }
    }
    if let Some(arr) = trim_string_array(raw.get("categories_tags"), 32) {
        meta.insert(
            "categories_tags".into(),
            Value::Array(arr.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(s) = trim_string(raw.get("ingredients_text"), 2000) {
        meta.insert("ingredients_text".into(), Value::String(s));
    }
    if let Some(arr) = trim_string_array(raw.get("allergens_tags"), 32) {
        meta.insert(
            "allergens_tags".into(),
            Value::Array(arr.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(s) = trim_string(raw.get("serving_size"), 100) {
        meta.insert("serving_size".into(), Value::String(s));
    }
    let serving_qty = match raw.get("serving_quantity") {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        Some(Value::String(s)) => s.parse::<f64>().ok().filter(|x| x.is_finite()),
        _ => None,
    };
    if let Some(q) = serving_qty {
        if let Some(n) = serde_json::Number::from_f64(q) {
            meta.insert("serving_quantity".into(), Value::Number(n));
        }
    }
    if let Some(ns) = raw.get("nutriscore_grade").and_then(|v| v.as_str()) {
        if ns.len() == 1 && "abcde".contains(ns) {
            meta.insert("nutriscore_grade".into(), Value::String(ns.to_string()));
        }
    }
    if let Some(n) = raw.get("nova_group").and_then(|v| v.as_i64()) {
        if (1..=4).contains(&n) {
            meta.insert("nova_group".into(), Value::Number(n.into()));
        }
    }
    if let Some(s) = trim_string(raw.get("ecoscore_grade"), 30) {
        meta.insert("ecoscore_grade".into(), Value::String(s));
    }
    if let Some(arr) = trim_string_array(raw.get("labels_tags"), 32) {
        meta.insert(
            "labels_tags".into(),
            Value::Array(arr.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(nut) = trim_nutriments(raw.get("nutriments")) {
        meta.insert("nutriments".into(), Value::Object(nut));
    }
    if let Some(s) = trim_string(raw.get("main_category"), 200) {
        meta.insert("main_category".into(), Value::String(s));
    }
    if let Some(s) = trim_string(raw.get("pnns_groups_1"), 100) {
        meta.insert("pnns_groups_1".into(), Value::String(s));
    }
    if let Some(s) = trim_string(raw.get("pnns_groups_2"), 100) {
        meta.insert("pnns_groups_2".into(), Value::String(s));
    }
    if meta.is_empty() {
        return None;
    }
    // Soft size cap — same drop order as product-meta.ts.
    let mut value = Value::Object(meta);
    let over_budget = |v: &Value| serde_json::to_string(v).map(|s| s.len() > SOFT_META_CAP).unwrap_or(false);
    let drop = |key: &str, v: &mut Value| {
        if let Value::Object(m) = v {
            m.remove(key);
        }
    };
    if over_budget(&value) {
        drop("ingredients_text", &mut value);
    }
    if over_budget(&value) {
        drop("categories_tags", &mut value);
    }
    if over_budget(&value) {
        drop("labels_tags", &mut value);
    }
    if over_budget(&value) {
        drop("nutriments", &mut value);
    }
    if over_budget(&value) {
        return None;
    }
    Some(value)
}

#[derive(Serialize)]
struct BarcodeResult {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    brand: Option<String>,
    category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantity: Option<f64>,
    unit: &'static str,
    #[serde(rename = "itemSize", skip_serializing_if = "Option::is_none")]
    item_size: Option<f64>,
    #[serde(rename = "itemSizeUnit", skip_serializing_if = "Option::is_none")]
    item_size_unit: Option<&'static str>,
    barcode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
}

pub async fn handle(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BarcodeQuery>,
) -> Response {
    let Some(code) = query.code.filter(|c| !c.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "code is required" })),
        )
            .into_response();
    };

    let core_fields = "product_name,brands,categories_tags,quantity,product_quantity,product_quantity_unit";
    let meta_fields = "nutriments,ingredients_text,allergens_tags,nutriscore_grade,nova_group,ecoscore_grade,serving_size,serving_quantity,labels_tags,main_category,pnns_groups_1,pnns_groups_2,code";
    let base = state
        .config
        .off_base_url
        .as_deref()
        .unwrap_or("https://world.openfoodfacts.org");
    let url = format!(
        "{base}/api/v2/product/{}.json?fields={core_fields},{meta_fields}",
        urlencoding(&code),
    );

    let response = match state
        .http
        .get(&url)
        .timeout(Duration::from_secs(8))
        .header("User-Agent", "PantryListApp/1.0 (family recipe management)")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Lookup failed: {e}") })),
            )
                .into_response();
        }
    };

    if !response.status().is_success() {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Lookup failed: HTTP {}", response.status()) })),
        )
            .into_response();
    }

    let body: Value = match response.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Lookup failed: {e}") })),
            )
                .into_response();
        }
    };

    let status = body.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
    let product = body.get("product");
    if status == 0 || product.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Product not found" })),
        )
            .into_response();
    }
    let product = product.unwrap();

    let name = product
        .get("product_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(name) = name else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Product found but name is missing" })),
        )
            .into_response();
    };

    let brand = product
        .get("brands")
        .and_then(|v| v.as_str())
        .and_then(|s| s.split(',').next().map(|x| x.trim().to_string()))
        .filter(|s| !s.is_empty());

    let categories_raw = product
        .get("categories_tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let category = map_category(&categories_raw);

    let mut qty: Option<f64> = None;
    let mut unit: Option<&'static str> = None;

    // Structured product_quantity / product_quantity_unit first.
    match product.get("product_quantity") {
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f > 0.0 {
                    qty = Some(f);
                }
            }
        }
        Some(Value::String(s)) => {
            if let Ok(f) = s.parse::<f64>() {
                if f.is_finite() && f > 0.0 {
                    qty = Some(f);
                }
            }
        }
        _ => {}
    }
    if let Some(off_unit) = product.get("product_quantity_unit").and_then(|v| v.as_str()) {
        unit = map_unit(off_unit);
    }

    // Fall back to parsing the free-text `quantity` string.
    let qty_str = product
        .get("quantity")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !qty_str.is_empty() {
        if qty.is_none() {
            if let Some(n) = extract_first_number(qty_str) {
                qty = Some(n);
            }
        }
        if unit.is_none() {
            unit = detect_unit_from_string(qty_str);
        }
    }

    let mut final_unit: &'static str = unit.unwrap_or("whole");

    if let Some(q) = qty {
        let (converted_qty, converted_unit) = to_imperial(q, final_unit);
        qty = Some(converted_qty);
        final_unit = converted_unit;
    }

    let mut item_size: Option<f64> = None;
    let mut item_size_unit: Option<&'static str> = None;
    // Promote measurable products to per-item-size + quantity=1 whole.
    if let Some(q) = qty {
        if final_unit != "whole" {
            item_size = Some(q);
            item_size_unit = Some(final_unit);
            qty = Some(1.0);
            final_unit = "whole";
        }
    }

    let meta = allowlist_product_meta(product);

    let result = BarcodeResult {
        name,
        brand,
        category,
        quantity: qty,
        unit: final_unit,
        item_size,
        item_size_unit,
        barcode: code,
        meta,
    };
    (StatusCode::OK, Json(result)).into_response()
}

fn urlencoding(s: &str) -> String {
    // Minimal RFC 3986 encoder for the path segment. The barcode is
    // numeric in practice; this is defensive against odd inputs.
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}
