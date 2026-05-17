#![allow(dead_code)]
//! Raw row layouts mirror the SQLite schema 1:1. Some fields are populated by
//! `row.get(...)` but never read by resolvers that map them to renamed
//! GraphQL fields; rustc still flags those as dead. The annotation above
//! silences that.

use rusqlite::Row;

#[derive(Debug, Clone)]
pub struct KitchenRow {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub created_at: String,
}

impl KitchenRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            slug: row.get("slug")?,
            name: row.get("name")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct IngredientRow {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
    pub always_on_hand: bool,
    /// Raw JSON text from the `tags` column; resolver parses to a list.
    pub tags_json: Option<String>,
    pub aliases_json: Option<String>,
    pub barcode: Option<String>,
    /// Raw JSON text from `product_meta`. Exposed verbatim as a String over
    /// GraphQL (the TS resolver did the same — clients parse client-side).
    pub product_meta: Option<String>,
    pub created_at: String,
}

impl IngredientRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let always_on_hand: i64 = row.get("always_on_hand").unwrap_or(0);
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            category: row.get("category").ok(),
            quantity: row.get("quantity").ok(),
            unit: row.get("unit").ok(),
            item_size: row.get("item_size").ok(),
            item_size_unit: row.get("item_size_unit").ok(),
            always_on_hand: always_on_hand != 0,
            tags_json: row.get("tags").ok(),
            aliases_json: row.get("aliases").ok(),
            barcode: row.get("barcode").ok(),
            product_meta: row.get("product_meta").ok(),
            created_at: row.get("created_at").unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct RecipeRow {
    pub id: String,
    pub title: String,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub instructions: String,
    pub servings: Option<i64>,
    pub prep_time: Option<i64>,
    pub cook_time: Option<i64>,
    pub tags_json: Option<String>,
    pub step_photos_json: Option<String>,
    pub source: String,
    pub source_url: Option<String>,
    pub photo_url: Option<String>,
    pub last_made_at: Option<String>,
    pub queued: bool,
    pub created_at: String,
}

impl RecipeRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let queued: i64 = row.get("queued").unwrap_or(0);
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            slug: row.get("slug").ok(),
            description: row.get("description").ok(),
            instructions: row.get("instructions")?,
            servings: row.get("servings").ok(),
            prep_time: row.get("prep_time").ok(),
            cook_time: row.get("cook_time").ok(),
            tags_json: row.get("tags").ok(),
            step_photos_json: row.get("step_photos").ok(),
            source: row.get("source").unwrap_or_else(|_| "manual".to_string()),
            source_url: row.get("source_url").ok(),
            photo_url: row.get("photo_url").ok(),
            last_made_at: row.get("last_made_at").ok(),
            queued: queued != 0,
            created_at: row.get("created_at").unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct RecipeIngredientRow {
    pub id: String,
    pub recipe_id: Option<String>,
    pub ingredient_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
    pub source_recipe_id: Option<String>,
    pub sort_order: Option<i64>,
}

impl RecipeIngredientRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            recipe_id: row.get("recipe_id").ok(),
            ingredient_name: row.get("ingredient_name")?,
            quantity: row.get("quantity").ok(),
            unit: row.get("unit").ok(),
            item_size: row.get("item_size").ok(),
            item_size_unit: row.get("item_size_unit").ok(),
            source_recipe_id: row.get("source_recipe_id").ok(),
            sort_order: row.get("sort_order").ok(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct CookwareRow {
    pub id: String,
    pub name: String,
    pub brand: Option<String>,
    pub tags_json: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

impl CookwareRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            brand: row.get("brand").ok(),
            tags_json: row.get("tags").ok(),
            notes: row.get("notes").ok(),
            created_at: row.get("created_at").unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct MenuRow {
    pub id: String,
    pub title: String,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub active: bool,
    pub category: Option<String>,
    pub source_url: Option<String>,
    pub created_at: String,
}

impl MenuRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let active: i64 = row.get("active").unwrap_or(1);
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            slug: row.get("slug").ok(),
            description: row.get("description").ok(),
            active: active != 0,
            category: row.get("category").ok(),
            source_url: row.get("source_url").ok(),
            created_at: row.get("created_at").unwrap_or_default(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct MenuRecipeRow {
    pub id: String,
    pub menu_id: String,
    pub recipe_id: String,
    pub course: Option<String>,
    pub sort_order: i64,
}

impl MenuRecipeRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            menu_id: row.get("menu_id")?,
            recipe_id: row.get("recipe_id")?,
            course: row.get("course").ok(),
            sort_order: row.get("sort_order").unwrap_or(0),
        })
    }
}

/// Parse a JSON-array TEXT column into a `Vec<String>`. Defaults to empty.
pub fn parse_json_strings(s: Option<&str>) -> Vec<String> {
    let Some(s) = s else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<String>>(s) {
        Ok(v) => v,
        Err(_) => Vec::new(),
    }
}
