use async_graphql::{Context, Object, SimpleObject};
use rusqlite::params;

use crate::db::{self, new_id, Pool};
use crate::models::KitchenRow;

#[derive(SimpleObject, Clone)]
pub struct Kitchen {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub created_at: String,
}

impl From<KitchenRow> for Kitchen {
    fn from(r: KitchenRow) -> Self {
        Kitchen {
            id: r.id,
            slug: r.slug,
            name: r.name,
            created_at: r.created_at,
        }
    }
}

#[derive(Default)]
pub struct KitchenQuery;

#[Object]
impl KitchenQuery {
    /// All kitchens, ordered by creation time.
    async fn kitchens(&self, ctx: &Context<'_>) -> async_graphql::Result<Vec<Kitchen>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, |conn| {
            let mut stmt = conn.prepare("SELECT * FROM kitchens ORDER BY created_at")?;
            let rows = stmt
                .query_map([], KitchenRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Kitchen::from).collect())
        })
        .await
    }

    /// Lookup a kitchen by its slug.
    async fn kitchen(
        &self,
        ctx: &Context<'_>,
        slug: String,
    ) -> async_graphql::Result<Option<Kitchen>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare("SELECT * FROM kitchens WHERE slug = ?1")?;
            match stmt.query_row(params![slug], KitchenRow::from_row) {
                Ok(r) => Ok(Some(Kitchen::from(r))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await
    }
}

#[derive(Default)]
pub struct KitchenMutation;

#[Object]
impl KitchenMutation {
    async fn create_kitchen(
        &self,
        ctx: &Context<'_>,
        slug: String,
        name: String,
    ) -> async_graphql::Result<Kitchen> {
        if !slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(async_graphql::Error::new(
                "Slug must be lowercase letters, numbers, and hyphens only.",
            ));
        }
        if slug == "home" {
            return Err(async_graphql::Error::new("\"home\" is a reserved slug."));
        }
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let id = new_id();
            conn.execute(
                "INSERT INTO kitchens (id, slug, name) VALUES (?1, ?2, ?3)",
                params![id, slug, name],
            )?;
            let mut stmt = conn.prepare("SELECT * FROM kitchens WHERE id = ?1")?;
            let row = stmt.query_row(params![id], KitchenRow::from_row)?;
            Ok(Kitchen::from(row))
        })
        .await
    }

    async fn update_kitchen(
        &self,
        ctx: &Context<'_>,
        id: String,
        name: String,
    ) -> async_graphql::Result<Kitchen> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let updated = conn.execute(
                "UPDATE kitchens SET name = ?1 WHERE id = ?2 AND slug != 'home'",
                params![name, id],
            )?;
            if updated == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            let mut stmt = conn.prepare("SELECT * FROM kitchens WHERE id = ?1")?;
            let row = stmt.query_row(params![id], KitchenRow::from_row)?;
            Ok(Kitchen::from(row))
        })
        .await
        .map_err(|e| {
            let msg = e.message;
            if msg.contains("Query returned no rows") {
                async_graphql::Error::new(
                    "Kitchen not found or cannot rename the home kitchen.",
                )
            } else {
                async_graphql::Error::new(msg)
            }
        })
    }

    async fn delete_kitchen(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<bool> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            conn.execute(
                "DELETE FROM kitchens WHERE id = ?1 AND slug != 'home'",
                params![id],
            )?;
            Ok(true)
        })
        .await
    }
}
