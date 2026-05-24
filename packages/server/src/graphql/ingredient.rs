use async_graphql::{Context, InputObject, Object, SimpleObject};
use rusqlite::{params, types::Value, ToSql};

use crate::db::{self, new_id, now_iso, Pool};
use crate::graphql::sql_helpers::{
    json_str_list, normalize_product_meta, resolve_kitchen_id,
};
use crate::models::{parse_json_strings, IngredientRow};

#[derive(SimpleObject, Clone)]
pub struct Ingredient {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
    pub always_on_hand: bool,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub barcode: Option<String>,
    /// Serialized JSON string of the ProductMeta payload. Clients parse client-side.
    pub product_meta: Option<String>,
    pub created_at: String,
}

impl From<IngredientRow> for Ingredient {
    fn from(r: IngredientRow) -> Self {
        Ingredient {
            id: r.id,
            name: r.name,
            category: r.category,
            quantity: r.quantity,
            unit: r.unit,
            item_size: r.item_size,
            item_size_unit: r.item_size_unit,
            always_on_hand: r.always_on_hand,
            tags: parse_json_strings(r.tags_json.as_deref()),
            aliases: parse_json_strings(r.aliases_json.as_deref()),
            barcode: r.barcode,
            product_meta: r.product_meta,
            created_at: r.created_at,
        }
    }
}

#[derive(InputObject, Clone)]
pub struct IngredientInput {
    pub name: String,
    pub category: Option<String>,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub item_size: Option<f64>,
    pub item_size_unit: Option<String>,
    pub always_on_hand: Option<bool>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub barcode: Option<String>,
    pub product_meta: Option<String>,
}

#[derive(Default)]
pub struct IngredientQuery;

#[Object]
impl IngredientQuery {
    /// List pantry ingredients, optionally filtered by name (substring,
    /// case-insensitive), tags (must contain all), and kitchen.
    async fn ingredients(
        &self,
        ctx: &Context<'_>,
        name: Option<String>,
        tags: Option<Vec<String>>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Vec<Ingredient>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let has_tags = tags.as_ref().map(|t| !t.is_empty()).unwrap_or(false);
            let has_name = name.as_ref().map(|n| !n.is_empty()).unwrap_or(false);

            // Tag containment (PG `tags @> ARRAY[...]`) → JSON1:
            // NOT EXISTS (any query tag missing from row tags).
            let mut sql = String::from(
                "SELECT * FROM ingredients WHERE kitchen_id = ?1",
            );
            let mut p: Vec<Value> = vec![Value::Text(kitchen_id)];
            if has_name {
                sql.push_str(" AND name LIKE ?");
                sql.push_str(&(p.len() + 1).to_string());
                sql.push_str(" COLLATE NOCASE");
                p.push(Value::Text(format!("%{}%", name.as_ref().unwrap())));
            }
            if has_tags {
                // serialize as a JSON array, then use json_each in subquery
                let tag_json = serde_json::to_string(tags.as_ref().unwrap()).unwrap();
                let idx = p.len() + 1;
                sql.push_str(&format!(
                    " AND NOT EXISTS (SELECT 1 FROM json_each(?{idx}) AS q WHERE q.value NOT IN (SELECT value FROM json_each(tags)))",
                ));
                p.push(Value::Text(tag_json));
            }
            sql.push_str(" ORDER BY name");

            let params_dyn: Vec<&dyn ToSql> = p.iter().map(|v| v as &dyn ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_dyn.as_slice(), IngredientRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Ingredient::from).collect())
        })
        .await
    }
}

#[derive(Default)]
pub struct IngredientMutation;

#[Object]
impl IngredientMutation {
    #[allow(clippy::too_many_arguments)]
    async fn add_ingredient(
        &self,
        ctx: &Context<'_>,
        name: String,
        category: Option<String>,
        quantity: Option<f64>,
        unit: Option<String>,
        item_size: Option<f64>,
        item_size_unit: Option<String>,
        always_on_hand: Option<bool>,
        tags: Option<Vec<String>>,
        aliases: Option<Vec<String>>,
        barcode: Option<String>,
        product_meta: Option<String>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Ingredient> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let id = new_id();
            let pm_json = normalize_product_meta(product_meta.as_deref());
            let tags_text = json_str_list(tags.as_deref());
            let aliases_text = aliases
                .as_ref()
                .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".to_string()));
            conn.execute(
                "INSERT INTO ingredients
                   (id, name, category, quantity, unit, item_size, item_size_unit,
                    always_on_hand, tags, aliases, barcode, product_meta, kitchen_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    id,
                    name,
                    category,
                    quantity,
                    unit,
                    item_size,
                    item_size_unit,
                    if always_on_hand.unwrap_or(false) { 1i64 } else { 0i64 },
                    tags_text,
                    aliases_text,
                    barcode,
                    pm_json,
                    kitchen_id,
                ],
            )?;
            let mut stmt = conn.prepare("SELECT * FROM ingredients WHERE id = ?1")?;
            let row = stmt.query_row(params![id], IngredientRow::from_row)?;
            Ok(Ingredient::from(row))
        })
        .await
    }

    async fn add_ingredients(
        &self,
        ctx: &Context<'_>,
        inputs: Vec<IngredientInput>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Vec<Ingredient>> {
        if inputs.is_empty() {
            return Ok(vec![]);
        }
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let tx = conn.transaction()?;
            let mut ids: Vec<String> = Vec::with_capacity(inputs.len());
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO ingredients
                       (id, name, category, quantity, unit, item_size, item_size_unit,
                        always_on_hand, tags, aliases, barcode, product_meta, kitchen_id)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                )?;
                for i in &inputs {
                    let id = new_id();
                    let pm_json = normalize_product_meta(i.product_meta.as_deref());
                    let tags_text = json_str_list(i.tags.as_deref());
                    let aliases_text = i
                        .aliases
                        .as_ref()
                        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".to_string()));
                    stmt.execute(params![
                        id,
                        i.name,
                        i.category,
                        i.quantity,
                        i.unit,
                        i.item_size,
                        i.item_size_unit,
                        if i.always_on_hand.unwrap_or(false) { 1i64 } else { 0i64 },
                        tags_text,
                        aliases_text,
                        i.barcode,
                        pm_json,
                        kitchen_id,
                    ])?;
                    ids.push(id);
                }
            }
            tx.commit()?;
            let placeholders = std::iter::repeat("?")
                .take(ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("SELECT * FROM ingredients WHERE id IN ({placeholders})");
            let mut stmt = conn.prepare(&sql)?;
            let params_dyn: Vec<&dyn ToSql> = ids.iter().map(|s| s as &dyn ToSql).collect();
            let rows = stmt
                .query_map(params_dyn.as_slice(), IngredientRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            // Preserve insert order — the IN clause returns rows in storage order.
            let mut by_id: std::collections::HashMap<String, Ingredient> =
                rows.into_iter().map(|r| (r.id.clone(), r.into())).collect();
            let ordered: Vec<Ingredient> = ids.into_iter().filter_map(|id| by_id.remove(&id)).collect();
            Ok(ordered)
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_ingredient(
        &self,
        ctx: &Context<'_>,
        id: String,
        name: Option<String>,
        category: Option<String>,
        quantity: Option<f64>,
        unit: Option<String>,
        item_size: Option<f64>,
        item_size_unit: Option<String>,
        always_on_hand: Option<bool>,
        tags: Option<Vec<String>>,
        aliases: Option<Vec<String>>,
        barcode: Option<String>,
        product_meta: Option<String>,
    ) -> async_graphql::Result<Ingredient> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let aoh_param: Option<i64> = always_on_hand.map(|b| if b { 1 } else { 0 });
            let aoh_is_true: i64 = if always_on_hand == Some(true) { 1 } else { 0 };
            let pm_json = product_meta.as_deref().and_then(|s| normalize_product_meta(Some(s)));
            let tags_text = tags
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".to_string()));
            let aliases_text = aliases
                .as_ref()
                .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".to_string()));
            conn.execute(
                "UPDATE ingredients SET
                    name = COALESCE(?1, name),
                    category = COALESCE(?2, category),
                    always_on_hand = COALESCE(?3, always_on_hand),
                    quantity = CASE WHEN ?4 = 1 THEN NULL ELSE ?5 END,
                    unit = CASE WHEN ?4 = 1 THEN NULL ELSE ?6 END,
                    item_size = COALESCE(?7, item_size),
                    item_size_unit = COALESCE(?8, item_size_unit),
                    tags = COALESCE(?9, tags),
                    aliases = COALESCE(?10, aliases),
                    barcode = COALESCE(?11, barcode),
                    product_meta = COALESCE(?12, product_meta),
                    updated_at = ?13
                 WHERE id = ?14",
                params![
                    name,
                    category,
                    aoh_param,
                    aoh_is_true,
                    quantity,
                    unit,
                    item_size,
                    item_size_unit,
                    tags_text,
                    aliases_text,
                    barcode,
                    pm_json,
                    now_iso(),
                    id,
                ],
            )?;
            let mut stmt = conn.prepare("SELECT * FROM ingredients WHERE id = ?1")?;
            let row = stmt.query_row(params![id], IngredientRow::from_row)?;
            Ok(Ingredient::from(row))
        })
        .await
    }

    async fn delete_ingredient(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<bool> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            conn.execute("DELETE FROM ingredients WHERE id = ?1", params![id])?;
            Ok(true)
        })
        .await
    }
}
