use async_graphql::{ComplexObject, Context, Object, SimpleObject};
use rusqlite::params;

use crate::db::{self, new_id, Pool};
use crate::graphql::recipe::Recipe;
use crate::graphql::sql_helpers::{json_str_list, resolve_kitchen_id};
use crate::models::{parse_json_strings, CookwareRow, RecipeRow};

#[derive(SimpleObject, Clone)]
#[graphql(complex)]
pub struct Cookware {
    pub id: String,
    pub name: String,
    pub brand: Option<String>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

#[ComplexObject]
impl Cookware {
    /// Recipes that require this cookware.
    async fn recipes(&self, ctx: &Context<'_>) -> async_graphql::Result<Vec<Recipe>> {
        let pool = ctx.data::<crate::db::Pool>()?;
        let cookware_id = self.id.clone();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT r.* FROM recipes r
                 JOIN recipe_cookware rc ON rc.recipe_id = r.id
                 WHERE rc.cookware_id = ?1
                 ORDER BY r.title",
            )?;
            let rows = stmt
                .query_map(params![cookware_id], RecipeRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Recipe::from).collect())
        })
        .await
    }
}

impl From<CookwareRow> for Cookware {
    fn from(r: CookwareRow) -> Self {
        Cookware {
            id: r.id,
            name: r.name,
            brand: r.brand,
            tags: parse_json_strings(r.tags_json.as_deref()),
            notes: r.notes,
            created_at: r.created_at,
        }
    }
}

#[derive(Default)]
pub struct CookwareQuery;

#[Object]
impl CookwareQuery {
    async fn cookware(
        &self,
        ctx: &Context<'_>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Vec<Cookware>> {
        let pool = ctx.data::<crate::db::Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let mut stmt =
                conn.prepare("SELECT * FROM cookware WHERE kitchen_id = ?1 ORDER BY name")?;
            let rows = stmt
                .query_map(params![kitchen_id], CookwareRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Cookware::from).collect())
        })
        .await
    }

    async fn cookware_item(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<Option<Cookware>> {
        let pool = ctx.data::<crate::db::Pool>()?;
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare("SELECT * FROM cookware WHERE id = ?1")?;
            match stmt.query_row(params![id], CookwareRow::from_row) {
                Ok(r) => Ok(Some(Cookware::from(r))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await
    }
}

#[derive(Default)]
pub struct CookwareMutation;

#[Object]
impl CookwareMutation {
    async fn add_cookware(
        &self,
        ctx: &Context<'_>,
        name: String,
        brand: Option<String>,
        tags: Option<Vec<String>>,
        notes: Option<String>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Cookware> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let id = new_id();
            let tags_text = json_str_list(tags.as_deref());
            conn.execute(
                "INSERT INTO cookware (id, name, brand, tags, notes, kitchen_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, name, brand, tags_text, notes, kitchen_id],
            )?;
            let mut stmt = conn.prepare("SELECT * FROM cookware WHERE id = ?1")?;
            let row = stmt.query_row(params![id], CookwareRow::from_row)?;
            Ok(Cookware::from(row))
        })
        .await
    }

    async fn update_cookware(
        &self,
        ctx: &Context<'_>,
        id: String,
        name: Option<String>,
        brand: Option<String>,
        tags: Option<Vec<String>>,
        notes: Option<String>,
    ) -> async_graphql::Result<Cookware> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let tags_text = tags
                .as_ref()
                .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".to_string()));
            conn.execute(
                "UPDATE cookware SET
                    name = COALESCE(?1, name),
                    brand = COALESCE(?2, brand),
                    tags = COALESCE(?3, tags),
                    notes = COALESCE(?4, notes)
                 WHERE id = ?5",
                params![name, brand, tags_text, notes, id],
            )?;
            let mut stmt = conn.prepare("SELECT * FROM cookware WHERE id = ?1")?;
            let row = stmt.query_row(params![id], CookwareRow::from_row)?;
            Ok(Cookware::from(row))
        })
        .await
    }

    async fn delete_cookware(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<bool> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            conn.execute("DELETE FROM cookware WHERE id = ?1", params![id])?;
            Ok(true)
        })
        .await
    }
}
