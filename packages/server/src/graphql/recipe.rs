use std::collections::HashMap;
use std::path::PathBuf;

use async_graphql::{ComplexObject, Context, InputObject, Object, SimpleObject};
use rusqlite::{params, types::Value, Connection, ToSql};

use crate::config::ServerConfig;
use crate::db::{self, new_id, now_iso, Pool};
use crate::graphql::cookware::Cookware;
use crate::graphql::sql_helpers::{
    auto_link_sub_recipe_ingredients, json_str_list, resolve_kitchen_id, unique_slug,
};
use crate::models::{parse_json_strings, CookwareRow, RecipeIngredientRow, RecipeRow};

/// Schedule the post-insert/update `{slug}.jpg` copy on a background blocking
/// thread. The helper itself sleeps in a retry loop because variant
/// generation is async — `{uuid}-400.jpg` may not exist yet when the recipe
/// row is written. Mirrors `copyFriendlyPhoto(...).catch(() => {})` in the
/// TS `insertRecipe()` / `updateRecipe`.
fn schedule_friendly_photo_copy(
    photo_url: Option<&str>,
    slug: Option<&str>,
    uploads_dir: PathBuf,
) {
    let Some(photo) = photo_url else { return };
    if !photo.starts_with("/uploads/") {
        return;
    }
    let Some(slug) = slug else { return };
    if slug.is_empty() {
        return;
    }
    let photo = photo.to_string();
    let slug = slug.to_string();
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            crate::image::copy_friendly_photo(&photo, &slug, &uploads_dir);
        })
        .await;
    });
}

#[derive(SimpleObject, Clone)]
pub struct RecipeIngredient {
    pub ingredient_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
    pub source_recipe_id: Option<String>,
}

impl From<RecipeIngredientRow> for RecipeIngredient {
    fn from(r: RecipeIngredientRow) -> Self {
        RecipeIngredient {
            ingredient_name: r.ingredient_name,
            quantity: r.quantity,
            unit: r.unit,
            item_size: r.item_size,
            item_size_unit: r.item_size_unit,
            source_recipe_id: r.source_recipe_id,
        }
    }
}

#[derive(InputObject, Clone, Debug)]
pub struct RecipeIngredientInput {
    pub ingredient_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
    pub source_recipe_id: Option<String>,
}

#[derive(SimpleObject, Clone)]
#[graphql(complex)]
pub struct Recipe {
    pub id: String,
    pub slug: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub instructions: String,
    pub servings: Option<i32>,
    pub prep_time: Option<i32>,
    pub cook_time: Option<i32>,
    pub tags: Vec<String>,
    pub source: String,
    pub source_url: Option<String>,
    pub photo_url: Option<String>,
    pub step_photos: Vec<String>,
    pub last_made_at: Option<String>,
    pub queued: bool,
    pub created_at: String,
}

impl From<RecipeRow> for Recipe {
    fn from(r: RecipeRow) -> Self {
        Recipe {
            id: r.id,
            slug: r.slug,
            title: r.title,
            description: r.description,
            instructions: r.instructions,
            servings: r.servings.map(|n| n as i32),
            prep_time: r.prep_time.map(|n| n as i32),
            cook_time: r.cook_time.map(|n| n as i32),
            tags: parse_json_strings(r.tags_json.as_deref()),
            source: r.source,
            source_url: r.source_url,
            photo_url: r.photo_url,
            step_photos: parse_json_strings(r.step_photos_json.as_deref()),
            last_made_at: r.last_made_at,
            queued: r.queued,
            created_at: r.created_at,
        }
    }
}

#[ComplexObject]
impl Recipe {
    async fn required_cookware(
        &self,
        ctx: &Context<'_>,
    ) -> async_graphql::Result<Vec<Cookware>> {
        let pool = ctx.data::<Pool>()?;
        let recipe_id = self.id.clone();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT c.* FROM cookware c
                 JOIN recipe_cookware rc ON rc.cookware_id = c.id
                 WHERE rc.recipe_id = ?1
                 ORDER BY c.name",
            )?;
            let rows = stmt
                .query_map(params![recipe_id], CookwareRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Cookware::from).collect())
        })
        .await
    }

    async fn ingredients(
        &self,
        ctx: &Context<'_>,
    ) -> async_graphql::Result<Vec<RecipeIngredient>> {
        let pool = ctx.data::<Pool>()?;
        let recipe_id = self.id.clone();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM recipe_ingredients WHERE recipe_id = ?1 ORDER BY sort_order, id",
            )?;
            let rows = stmt
                .query_map(params![recipe_id], RecipeIngredientRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(RecipeIngredient::from).collect())
        })
        .await
    }

    async fn used_in(&self, ctx: &Context<'_>) -> async_graphql::Result<Vec<Recipe>> {
        let pool = ctx.data::<Pool>()?;
        let recipe_id = self.id.clone();
        let title_lower = self.title.to_lowercase();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT r.* FROM recipes r
                 JOIN recipe_ingredients ri ON ri.recipe_id = r.id
                 WHERE ri.recipe_id != ?1
                   AND (ri.source_recipe_id = ?1
                        OR (ri.source_recipe_id IS NULL
                            AND lower(ri.ingredient_name) = ?2))
                 ORDER BY r.title",
            )?;
            let rows = stmt
                .query_map(params![recipe_id, title_lower], RecipeRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Recipe::from).collect())
        })
        .await
    }

    /// Recursively unfurls sub-recipe ingredients for grocery-list use.
    async fn grocery_ingredients(
        &self,
        ctx: &Context<'_>,
    ) -> async_graphql::Result<Vec<RecipeIngredient>> {
        let pool = ctx.data::<Pool>()?;
        let recipe_id = self.id.clone();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM recipe_ingredients WHERE recipe_id = ?1 ORDER BY sort_order, id",
            )?;
            let rows: Vec<RecipeIngredientRow> = stmt
                .query_map(params![recipe_id], RecipeIngredientRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut expanded: Vec<RecipeIngredient> = Vec::new();
            for row in rows {
                let mut sub_recipe_id = row.source_recipe_id.clone();
                if sub_recipe_id.is_none() {
                    let mut name_stmt = conn.prepare(
                        "SELECT id FROM recipes
                         WHERE lower(title) = ?1 AND id != ?2 LIMIT 1",
                    )?;
                    let lookup = name_stmt.query_row(
                        params![row.ingredient_name.to_lowercase(), recipe_id],
                        |r| r.get::<_, String>(0),
                    );
                    if let Ok(id) = lookup {
                        sub_recipe_id = Some(id);
                    }
                }
                if let Some(sub_id) = sub_recipe_id {
                    let mut sub_stmt = conn.prepare(
                        "SELECT * FROM recipe_ingredients WHERE recipe_id = ?1 ORDER BY sort_order, id",
                    )?;
                    let sub_rows: Vec<RecipeIngredientRow> = sub_stmt
                        .query_map(params![sub_id], RecipeIngredientRow::from_row)?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    for sub in sub_rows {
                        let scaled = RecipeIngredient {
                            ingredient_name: sub.ingredient_name,
                            quantity: match (sub.quantity, row.quantity) {
                                (Some(a), Some(b)) => Some(a * b),
                                (Some(a), None) => Some(a),
                                (None, _) => None,
                            },
                            unit: sub.unit,
                            item_size: sub.item_size,
                            item_size_unit: sub.item_size_unit,
                            source_recipe_id: sub.source_recipe_id,
                        };
                        expanded.push(scaled);
                    }
                } else {
                    expanded.push(RecipeIngredient::from(row));
                }
            }
            // Merge by (lower(name), lower(unit ?? ''))
            let mut order: Vec<String> = Vec::new();
            let mut merged: HashMap<String, RecipeIngredient> = HashMap::new();
            for item in expanded {
                let unit_lower = item.unit.as_deref().unwrap_or("").to_lowercase();
                let key = format!("{}::{}", item.ingredient_name.to_lowercase(), unit_lower);
                if let Some(existing) = merged.get_mut(&key) {
                    if let (Some(a), Some(b)) = (existing.quantity, item.quantity) {
                        existing.quantity = Some(a + b);
                    }
                } else {
                    order.push(key.clone());
                    merged.insert(key, item);
                }
            }
            Ok(order.into_iter().filter_map(|k| merged.remove(&k)).collect())
        })
        .await
    }
}

#[derive(Default)]
pub struct RecipeQuery;

#[Object]
impl RecipeQuery {
    async fn recipes(
        &self,
        ctx: &Context<'_>,
        title: Option<String>,
        tags: Option<Vec<String>>,
        cookware: Option<Vec<String>>,
        queued: Option<bool>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Vec<Recipe>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let has_tags = tags.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
            let has_cookware = cookware.as_ref().map(|c| !c.is_empty()).unwrap_or(false);

            if let Some(t) = &title {
                if !t.is_empty() {
                    let pattern = format!("%{}%", t);
                    let mut stmt = conn.prepare(
                        "SELECT * FROM recipes
                         WHERE kitchen_id = ?1 AND title LIKE ?2 COLLATE NOCASE
                         ORDER BY created_at DESC",
                    )?;
                    let rows = stmt
                        .query_map(params![kitchen_id, pattern], RecipeRow::from_row)?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    return Ok(rows.into_iter().map(Recipe::from).collect());
                }
            }

            // Compose dynamic filters: tag overlap (PG `&&`) → EXISTS json_each.
            if has_tags && has_cookware {
                let tags_list = tags.unwrap();
                let cookware_list = cookware.unwrap();
                let tag_placeholders = (0..tags_list.len())
                    .map(|i| format!("?{}", i + 2))
                    .collect::<Vec<_>>()
                    .join(",");
                let cw_offset = 2 + tags_list.len();
                let cw_placeholders = (0..cookware_list.len())
                    .map(|i| format!("?{}", i + cw_offset))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT DISTINCT r.* FROM recipes r
                     JOIN recipe_cookware rc ON rc.recipe_id = r.id
                     WHERE r.kitchen_id = ?1
                       AND EXISTS (SELECT 1 FROM json_each(r.tags) AS rt WHERE rt.value IN ({tag_placeholders}))
                       AND rc.cookware_id IN ({cw_placeholders})
                     ORDER BY r.created_at DESC"
                );
                let mut p: Vec<Value> = vec![Value::Text(kitchen_id)];
                for t in &tags_list {
                    p.push(Value::Text(t.clone()));
                }
                for c in &cookware_list {
                    p.push(Value::Text(c.clone()));
                }
                let mut stmt = conn.prepare(&sql)?;
                let params_dyn: Vec<&dyn ToSql> = p.iter().map(|v| v as &dyn ToSql).collect();
                let rows = stmt
                    .query_map(params_dyn.as_slice(), RecipeRow::from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                return Ok(rows.into_iter().map(Recipe::from).collect());
            }

            if has_tags {
                let tags_list = tags.unwrap();
                let tag_placeholders = (0..tags_list.len())
                    .map(|i| format!("?{}", i + 2))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT * FROM recipes
                     WHERE kitchen_id = ?1
                       AND EXISTS (SELECT 1 FROM json_each(tags) AS rt WHERE rt.value IN ({tag_placeholders}))
                     ORDER BY created_at DESC"
                );
                let mut p: Vec<Value> = vec![Value::Text(kitchen_id)];
                for t in &tags_list {
                    p.push(Value::Text(t.clone()));
                }
                let mut stmt = conn.prepare(&sql)?;
                let params_dyn: Vec<&dyn ToSql> = p.iter().map(|v| v as &dyn ToSql).collect();
                let rows = stmt
                    .query_map(params_dyn.as_slice(), RecipeRow::from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                return Ok(rows.into_iter().map(Recipe::from).collect());
            }

            if has_cookware {
                let cookware_list = cookware.unwrap();
                let cw_placeholders = (0..cookware_list.len())
                    .map(|i| format!("?{}", i + 2))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT DISTINCT r.* FROM recipes r
                     JOIN recipe_cookware rc ON rc.recipe_id = r.id
                     WHERE r.kitchen_id = ?1 AND rc.cookware_id IN ({cw_placeholders})
                     ORDER BY r.created_at DESC"
                );
                let mut p: Vec<Value> = vec![Value::Text(kitchen_id)];
                for c in &cookware_list {
                    p.push(Value::Text(c.clone()));
                }
                let mut stmt = conn.prepare(&sql)?;
                let params_dyn: Vec<&dyn ToSql> = p.iter().map(|v| v as &dyn ToSql).collect();
                let rows = stmt
                    .query_map(params_dyn.as_slice(), RecipeRow::from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                return Ok(rows.into_iter().map(Recipe::from).collect());
            }

            if let Some(q) = queued {
                let mut stmt = conn.prepare(
                    "SELECT * FROM recipes WHERE kitchen_id = ?1 AND queued = ?2 ORDER BY created_at DESC",
                )?;
                let rows = stmt
                    .query_map(params![kitchen_id, if q { 1i64 } else { 0i64 }], RecipeRow::from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                return Ok(rows.into_iter().map(Recipe::from).collect());
            }

            let mut stmt =
                conn.prepare("SELECT * FROM recipes WHERE kitchen_id = ?1 ORDER BY created_at DESC")?;
            let rows = stmt
                .query_map(params![kitchen_id], RecipeRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Recipe::from).collect())
        })
        .await
    }

    async fn recipe(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<Option<Recipe>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let mut stmt =
                conn.prepare("SELECT * FROM recipes WHERE slug = ?1 OR id = ?1")?;
            match stmt.query_row(params![id], RecipeRow::from_row) {
                Ok(r) => Ok(Some(Recipe::from(r))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await
    }
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

/// Insert a recipe row + its ingredient and cookware children. Returns the
/// inserted recipe row. Mirrors the TS `insertRecipe()` helper.
#[allow(clippy::too_many_arguments)]
fn insert_recipe(
    conn: &mut Connection,
    title: &str,
    description: Option<&str>,
    instructions: &str,
    servings: Option<i64>,
    prep_time: Option<i64>,
    cook_time: Option<i64>,
    tags: Option<&[String]>,
    required_cookware_ids: Option<&[String]>,
    source: &str,
    source_url: Option<&str>,
    photo_url: Option<&str>,
    step_photos: Option<&[String]>,
    kitchen_id: &str,
    ingredients: Vec<RecipeIngredientInput>,
) -> rusqlite::Result<RecipeRow> {
    let slug = unique_slug(conn, "recipes", title, None)?;
    let recipe_id = new_id();
    let instructions_norm = instructions.replace("\\n", "\n");
    let tags_text = json_str_list(tags);
    let step_photos_text = json_str_list(step_photos);

    conn.execute(
        "INSERT INTO recipes
           (id, title, slug, description, instructions, servings, prep_time, cook_time,
            tags, source, source_url, photo_url, step_photos, kitchen_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            recipe_id,
            title,
            slug,
            description,
            instructions_norm,
            servings.unwrap_or(2),
            prep_time,
            cook_time,
            tags_text,
            source,
            source_url,
            photo_url,
            step_photos_text,
            kitchen_id,
        ],
    )?;

    if let Some(cw_ids) = required_cookware_ids {
        for cw_id in cw_ids {
            conn.execute(
                "INSERT INTO recipe_cookware (recipe_id, cookware_id)
                 VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                params![recipe_id, cw_id],
            )?;
        }
    }

    if !ingredients.is_empty() {
        let mut linked = ingredients;
        auto_link_sub_recipe_ingredients(conn, Some(&recipe_id), &mut linked)?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO recipe_ingredients
                   (id, recipe_id, ingredient_name, quantity, unit, item_size,
                    item_size_unit, source_recipe_id, sort_order)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            )?;
            for (idx, ing) in linked.iter().enumerate() {
                stmt.execute(params![
                    new_id(),
                    recipe_id,
                    ing.ingredient_name,
                    ing.quantity,
                    ing.unit,
                    ing.item_size,
                    ing.item_size_unit,
                    ing.source_recipe_id,
                    idx as i64,
                ])?;
            }
        }
        tx.commit()?;
    }

    let mut stmt = conn.prepare("SELECT * FROM recipes WHERE id = ?1")?;
    stmt.query_row(params![recipe_id], RecipeRow::from_row)
}

#[derive(Default)]
pub struct RecipeMutation;

#[Object]
impl RecipeMutation {
    #[allow(clippy::too_many_arguments)]
    async fn create_recipe(
        &self,
        ctx: &Context<'_>,
        title: String,
        description: Option<String>,
        instructions: String,
        servings: Option<i32>,
        prep_time: Option<i32>,
        cook_time: Option<i32>,
        tags: Option<Vec<String>>,
        required_cookware_ids: Option<Vec<String>>,
        photo_url: Option<String>,
        step_photos: Option<Vec<String>>,
        source_url: Option<String>,
        ingredients: Vec<RecipeIngredientInput>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Recipe> {
        let pool = ctx.data::<Pool>()?;
        let uploads_dir = ctx.data::<ServerConfig>()?.uploads_dir.clone();

        enum CreateOutcome {
            Idempotent(RecipeRow),
            Inserted(RecipeRow),
        }

        let outcome = db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;

            // 60s idempotency guard against double-submits, matching the TS
            // resolver. ISO 8601 UTC compares lexicographically.
            let cutoff = chrono::Utc::now() - chrono::Duration::seconds(60);
            let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
            let recent: Result<RecipeRow, _> = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM recipes
                     WHERE kitchen_id = ?1 AND lower(title) = ?2 AND created_at > ?3
                     ORDER BY created_at DESC LIMIT 1",
                )?;
                stmt.query_row(
                    params![kitchen_id, title.to_lowercase(), cutoff_iso],
                    RecipeRow::from_row,
                )
            };
            if let Ok(r) = recent {
                return Ok(CreateOutcome::Idempotent(r));
            }

            let source_str = if source_url.is_some() { "url-import" } else { "manual" };
            let row = insert_recipe(
                conn,
                &title,
                description.as_deref(),
                &instructions,
                servings.map(|n| n as i64),
                prep_time.map(|n| n as i64),
                cook_time.map(|n| n as i64),
                tags.as_deref(),
                required_cookware_ids.as_deref(),
                source_str,
                source_url.as_deref(),
                photo_url.as_deref(),
                step_photos.as_deref(),
                &kitchen_id,
                ingredients,
            )?;
            Ok(CreateOutcome::Inserted(row))
        })
        .await?;

        let row = match outcome {
            CreateOutcome::Idempotent(r) => r,
            CreateOutcome::Inserted(r) => {
                schedule_friendly_photo_copy(r.photo_url.as_deref(), r.slug.as_deref(), uploads_dir);
                r
            }
        };
        Ok(Recipe::from(row))
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_recipe(
        &self,
        ctx: &Context<'_>,
        id: String,
        title: Option<String>,
        description: Option<String>,
        instructions: Option<String>,
        servings: Option<i32>,
        prep_time: Option<i32>,
        cook_time: Option<i32>,
        tags: Option<Vec<String>>,
        required_cookware_ids: Option<Vec<String>>,
        photo_url: Option<String>,
        step_photos: Option<Vec<String>>,
        source_url: Option<String>,
        ingredients: Option<Vec<RecipeIngredientInput>>,
    ) -> async_graphql::Result<Recipe> {
        let pool = ctx.data::<Pool>()?;
        let uploads_dir = ctx.data::<ServerConfig>()?.uploads_dir.clone();
        let row = db::with_conn(pool, move |conn| {
            let new_slug: Option<String> = if let Some(t) = title.as_ref() {
                Some(unique_slug(conn, "recipes", t, Some(&id))?)
            } else {
                None
            };
            let tags_text = tags
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".to_string()));
            let step_photos_text = step_photos
                .as_ref()
                .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "[]".to_string()));
            // photoUrl: NULL = keep, "" = clear, else set.
            let photo_url_param: Option<String> = photo_url.clone();
            conn.execute(
                "UPDATE recipes SET
                    title = COALESCE(?1, title),
                    slug  = COALESCE(?2, slug),
                    description = COALESCE(?3, description),
                    instructions = COALESCE(?4, instructions),
                    servings = COALESCE(?5, servings),
                    prep_time = COALESCE(?6, prep_time),
                    cook_time = COALESCE(?7, cook_time),
                    tags = COALESCE(?8, tags),
                    photo_url = CASE
                        WHEN ?9 IS NULL THEN photo_url
                        WHEN ?9 = '' THEN NULL
                        ELSE ?9
                    END,
                    step_photos = COALESCE(?10, step_photos),
                    source_url = COALESCE(?11, source_url),
                    source = CASE WHEN ?11 IS NOT NULL THEN 'url-import' ELSE source END
                 WHERE id = ?12",
                params![
                    title,
                    new_slug,
                    description,
                    instructions,
                    servings.map(|n| n as i64),
                    prep_time.map(|n| n as i64),
                    cook_time.map(|n| n as i64),
                    tags_text,
                    photo_url_param,
                    step_photos_text,
                    source_url,
                    id,
                ],
            )?;

            if let Some(cw_ids) = required_cookware_ids.as_ref() {
                conn.execute(
                    "DELETE FROM recipe_cookware WHERE recipe_id = ?1",
                    params![id],
                )?;
                for cw_id in cw_ids {
                    conn.execute(
                        "INSERT INTO recipe_cookware (recipe_id, cookware_id)
                         VALUES (?1, ?2) ON CONFLICT DO NOTHING",
                        params![id, cw_id],
                    )?;
                }
            }

            if let Some(ings) = ingredients {
                conn.execute(
                    "DELETE FROM recipe_ingredients WHERE recipe_id = ?1",
                    params![id],
                )?;
                if !ings.is_empty() {
                    let mut linked = ings;
                    auto_link_sub_recipe_ingredients(conn, Some(&id), &mut linked)?;
                    let tx = conn.transaction()?;
                    {
                        let mut stmt = tx.prepare(
                            "INSERT INTO recipe_ingredients
                               (id, recipe_id, ingredient_name, quantity, unit, item_size,
                                item_size_unit, source_recipe_id, sort_order)
                             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                        )?;
                        for (idx, ing) in linked.iter().enumerate() {
                            stmt.execute(params![
                                new_id(),
                                id,
                                ing.ingredient_name,
                                ing.quantity,
                                ing.unit,
                                ing.item_size,
                                ing.item_size_unit,
                                ing.source_recipe_id,
                                idx as i64,
                            ])?;
                        }
                    }
                    tx.commit()?;
                }
            }

            let mut stmt = conn.prepare("SELECT * FROM recipes WHERE id = ?1")?;
            stmt.query_row(params![id], RecipeRow::from_row)
        })
        .await?;
        schedule_friendly_photo_copy(row.photo_url.as_deref(), row.slug.as_deref(), uploads_dir);
        Ok(Recipe::from(row))
    }

    async fn delete_recipe(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<bool> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            conn.execute("DELETE FROM recipes WHERE id = ?1", params![id])?;
            Ok(true)
        })
        .await
    }

    /// Marks a recipe as having been made now. The `servings` arg is accepted
    /// for client convenience but not currently persisted (parity with the TS
    /// resolver).
    async fn complete_recipe(
        &self,
        ctx: &Context<'_>,
        id: String,
        servings: Option<i32>,
    ) -> async_graphql::Result<Recipe> {
        let _ = servings;
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let updated = conn.execute(
                "UPDATE recipes SET last_made_at = ?1 WHERE id = ?2",
                params![now_iso(), id],
            )?;
            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            let mut stmt = conn.prepare("SELECT * FROM recipes WHERE id = ?1")?;
            let row = stmt.query_row(params![id], RecipeRow::from_row)?;
            Ok(Recipe::from(row))
        })
        .await
        .map_err(|e| {
            if e.message.contains("Query returned no rows") {
                async_graphql::Error::new("Recipe not found")
            } else {
                e
            }
        })
    }

    async fn toggle_recipe_queued(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<Recipe> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let updated = conn.execute(
                "UPDATE recipes SET queued = CASE WHEN queued = 1 THEN 0 ELSE 1 END WHERE id = ?1",
                params![id],
            )?;
            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            let mut stmt = conn.prepare("SELECT * FROM recipes WHERE id = ?1")?;
            let row = stmt.query_row(params![id], RecipeRow::from_row)?;
            Ok(Recipe::from(row))
        })
        .await
        .map_err(|e| {
            if e.message.contains("Query returned no rows") {
                async_graphql::Error::new("Recipe not found")
            } else {
                e
            }
        })
    }

    /// Generate three recipes from the current pantry + cookware via the
    /// Anthropic Messages API and persist them as `source = "ai-generated"`.
    /// Requires `AI_API_KEY` (or `ANTHROPIC_API_KEY`) on the server.
    async fn generate_recipes(&self, ctx: &Context<'_>) -> async_graphql::Result<Vec<Recipe>> {
        let pool = ctx.data::<Pool>()?;
        let config = ctx.data::<ServerConfig>()?;
        let http = ctx.data::<reqwest::Client>()?;
        let api_key = config.anthropic_api_key.clone().ok_or_else(|| {
            async_graphql::Error::new(
                "AI_API_KEY not set on the Rust GraphQL server — set the env var \
                 or use the Node graphql-server.",
            )
        })?;
        let uploads_dir = config.uploads_dir.clone();

        // 1. Snapshot pantry + cookware on a blocking thread.
        let (ingredients, cookware) = db::with_conn(pool, |conn| {
            let mut i_stmt = conn.prepare("SELECT * FROM ingredients ORDER BY name")?;
            let ingredients: Vec<crate::models::IngredientRow> = i_stmt
                .query_map([], crate::models::IngredientRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut c_stmt = conn.prepare("SELECT * FROM cookware ORDER BY name")?;
            let cookware: Vec<CookwareRow> = c_stmt
                .query_map([], CookwareRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((ingredients, cookware))
        })
        .await?;

        // 2. Ask Anthropic — this is the only async-network step.
        let prompt = crate::anthropic::build_recipe_prompt(&ingredients, &cookware);
        let generated = crate::anthropic::generate_recipes(
            http,
            &api_key,
            config.anthropic_base_url.as_deref(),
            &prompt,
        )
        .await
        .map_err(|e| async_graphql::Error::new(e.to_string()))?;

        // 3. Insert each generated recipe back on a blocking thread, mapping
        //    `requiredCookware` names to ids using the snapshot we just read.
        let name_to_id: HashMap<String, String> = cookware
            .iter()
            .map(|c| (c.name.clone(), c.id.clone()))
            .collect();

        let rows = db::with_conn(pool, move |conn| {
            let home_kitchen_id = resolve_kitchen_id(conn, None)?;
            let mut out = Vec::with_capacity(generated.len());
            for r in generated {
                let cw_ids: Vec<String> = r
                    .required_cookware
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|n| name_to_id.get(&n).cloned())
                    .collect();
                let ings: Vec<RecipeIngredientInput> = r
                    .ingredients
                    .into_iter()
                    .map(|i| RecipeIngredientInput {
                        ingredient_name: i.ingredient_name,
                        quantity: i.quantity,
                        unit: i.unit,
                        item_size: i.item_size,
                        item_size_unit: i.item_size_unit,
                        source_recipe_id: None,
                    })
                    .collect();
                let row = insert_recipe(
                    conn,
                    &r.title,
                    r.description.as_deref(),
                    &r.instructions,
                    r.servings.map(|n| n as i64),
                    r.prep_time.map(|n| n as i64),
                    r.cook_time.map(|n| n as i64),
                    r.tags.as_deref(),
                    Some(&cw_ids),
                    "ai-generated",
                    None,
                    None,
                    None,
                    &home_kitchen_id,
                    ings,
                )?;
                out.push(row);
            }
            Ok(out)
        })
        .await?;

        // 4. Schedule friendly-slug copies (no-op when photo_url is None,
        //    which is the common case for AI-generated recipes — but keeps
        //    the helper in one place if a future model emits photoUrl).
        for row in &rows {
            schedule_friendly_photo_copy(
                row.photo_url.as_deref(),
                row.slug.as_deref(),
                uploads_dir.clone(),
            );
        }

        Ok(rows.into_iter().map(Recipe::from).collect())
    }
}
