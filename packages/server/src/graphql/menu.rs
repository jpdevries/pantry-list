use async_graphql::{ComplexObject, Context, InputObject, Object, SimpleObject};
use rusqlite::params;

use crate::db::{self, new_id, Pool};
use crate::graphql::recipe::Recipe;
use crate::graphql::sql_helpers::{resolve_kitchen_id, unique_slug};
use crate::models::{MenuRecipeRow, MenuRow, RecipeRow};

#[derive(SimpleObject, Clone)]
#[graphql(complex)]
pub struct MenuRecipe {
    pub id: String,
    pub course: Option<String>,
    pub sort_order: i32,
    #[graphql(skip)]
    pub recipe_id: String,
}

#[ComplexObject]
impl MenuRecipe {
    async fn recipe(&self, ctx: &Context<'_>) -> async_graphql::Result<Option<Recipe>> {
        let pool = ctx.data::<Pool>()?;
        let recipe_id = self.recipe_id.clone();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare("SELECT * FROM recipes WHERE id = ?1")?;
            match stmt.query_row(params![recipe_id], RecipeRow::from_row) {
                Ok(r) => Ok(Some(Recipe::from(r))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await
    }
}

impl From<MenuRecipeRow> for MenuRecipe {
    fn from(r: MenuRecipeRow) -> Self {
        MenuRecipe {
            id: r.id,
            course: r.course,
            sort_order: r.sort_order as i32,
            recipe_id: r.recipe_id,
        }
    }
}

#[derive(SimpleObject, Clone)]
#[graphql(complex)]
pub struct Menu {
    pub id: String,
    pub slug: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub active: bool,
    pub category: Option<String>,
    pub source_url: Option<String>,
    pub created_at: String,
}

#[ComplexObject]
impl Menu {
    async fn recipes(&self, ctx: &Context<'_>) -> async_graphql::Result<Vec<MenuRecipe>> {
        let pool = ctx.data::<Pool>()?;
        let menu_id = self.id.clone();
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare(
                "SELECT * FROM menu_recipes WHERE menu_id = ?1 ORDER BY course, sort_order",
            )?;
            let rows = stmt
                .query_map(params![menu_id], MenuRecipeRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(MenuRecipe::from).collect())
        })
        .await
    }
}

impl From<MenuRow> for Menu {
    fn from(r: MenuRow) -> Self {
        Menu {
            id: r.id,
            slug: r.slug,
            title: r.title,
            description: r.description,
            active: r.active,
            category: r.category,
            source_url: r.source_url,
            created_at: r.created_at,
        }
    }
}

#[derive(InputObject, Clone)]
pub struct MenuRecipeInput {
    pub recipe_id: String,
    pub course: Option<String>,
    pub sort_order: Option<i32>,
}

#[derive(Default)]
pub struct MenuQuery;

#[Object]
impl MenuQuery {
    async fn menus(
        &self,
        ctx: &Context<'_>,
        kitchen_slug: Option<String>,
    ) -> async_graphql::Result<Vec<Menu>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let mut stmt = conn.prepare(
                "SELECT * FROM menus WHERE kitchen_id = ?1 ORDER BY created_at DESC",
            )?;
            let rows = stmt
                .query_map(params![kitchen_id], MenuRow::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(Menu::from).collect())
        })
        .await
    }

    async fn menu(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<Option<Menu>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let mut stmt = conn.prepare("SELECT * FROM menus WHERE slug = ?1 OR id = ?1")?;
            match stmt.query_row(params![id], MenuRow::from_row) {
                Ok(r) => Ok(Some(Menu::from(r))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e),
            }
        })
        .await
    }
}

#[derive(Default)]
pub struct MenuMutation;

#[Object]
impl MenuMutation {
    #[allow(clippy::too_many_arguments)]
    async fn create_menu(
        &self,
        ctx: &Context<'_>,
        title: String,
        description: Option<String>,
        active: Option<bool>,
        category: Option<String>,
        source_url: Option<String>,
        kitchen_slug: Option<String>,
        recipes: Vec<MenuRecipeInput>,
    ) -> async_graphql::Result<Menu> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let kitchen_id = resolve_kitchen_id(conn, kitchen_slug.as_deref())?;
            let slug = unique_slug(conn, "menus", &title, None)?;
            let id = new_id();
            let is_active = active.unwrap_or(true);
            conn.execute(
                "INSERT INTO menus
                   (id, title, slug, description, active, category, source_url, kitchen_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    id,
                    title,
                    slug,
                    description,
                    if is_active { 1i64 } else { 0i64 },
                    category,
                    source_url,
                    kitchen_id,
                ],
            )?;
            for (idx, r) in recipes.iter().enumerate() {
                conn.execute(
                    "INSERT INTO menu_recipes (id, menu_id, recipe_id, course, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        new_id(),
                        id,
                        r.recipe_id,
                        r.course,
                        r.sort_order.map(|n| n as i64).unwrap_or(idx as i64),
                    ],
                )?;
            }
            let mut stmt = conn.prepare("SELECT * FROM menus WHERE id = ?1")?;
            let row = stmt.query_row(params![id], MenuRow::from_row)?;
            Ok(Menu::from(row))
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_menu(
        &self,
        ctx: &Context<'_>,
        id: String,
        title: Option<String>,
        description: Option<String>,
        active: Option<bool>,
        category: Option<String>,
        source_url: Option<String>,
        recipes: Option<Vec<MenuRecipeInput>>,
    ) -> async_graphql::Result<Option<Menu>> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let new_slug: Option<String> = if let Some(t) = title.as_ref() {
                Some(unique_slug(conn, "menus", t, Some(&id))?)
            } else {
                None
            };
            let active_bit: Option<i64> = active.map(|b| if b { 1 } else { 0 });
            let updated = conn.execute(
                "UPDATE menus SET
                    title = COALESCE(?1, title),
                    slug = COALESCE(?2, slug),
                    description = COALESCE(?3, description),
                    active = COALESCE(?4, active),
                    category = ?5,
                    source_url = COALESCE(?6, source_url)
                 WHERE id = ?7",
                params![title, new_slug, description, active_bit, category, source_url, id],
            )?;
            if updated == 0 {
                return Ok(None);
            }
            if let Some(rs) = recipes {
                conn.execute("DELETE FROM menu_recipes WHERE menu_id = ?1", params![id])?;
                for (idx, r) in rs.iter().enumerate() {
                    conn.execute(
                        "INSERT INTO menu_recipes (id, menu_id, recipe_id, course, sort_order)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            new_id(),
                            id,
                            r.recipe_id,
                            r.course,
                            r.sort_order.map(|n| n as i64).unwrap_or(idx as i64),
                        ],
                    )?;
                }
            }
            let mut stmt = conn.prepare("SELECT * FROM menus WHERE id = ?1")?;
            let row = stmt.query_row(params![id], MenuRow::from_row)?;
            Ok(Some(Menu::from(row)))
        })
        .await
    }

    async fn delete_menu(
        &self,
        ctx: &Context<'_>,
        id: String,
    ) -> async_graphql::Result<bool> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            conn.execute("DELETE FROM menus WHERE id = ?1", params![id])?;
            Ok(true)
        })
        .await
    }

    /// Toggle a recipe's membership in a menu. Appends with `course = 'other'`
    /// when adding, removes the row when already present. Returns the
    /// containing menu.
    async fn toggle_recipe_in_menu(
        &self,
        ctx: &Context<'_>,
        menu_id: String,
        recipe_id: String,
        course: Option<String>,
    ) -> async_graphql::Result<Menu> {
        let pool = ctx.data::<Pool>()?;
        db::with_conn(pool, move |conn| {
            let existing_id: Option<String> = {
                let mut stmt = conn.prepare(
                    "SELECT id FROM menu_recipes WHERE menu_id = ?1 AND recipe_id = ?2",
                )?;
                stmt.query_row(params![menu_id, recipe_id], |r| r.get::<_, String>(0))
                    .ok()
            };
            if let Some(eid) = existing_id {
                conn.execute("DELETE FROM menu_recipes WHERE id = ?1", params![eid])?;
            } else {
                let next_order: i64 = {
                    let mut stmt = conn.prepare(
                        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM menu_recipes WHERE menu_id = ?1",
                    )?;
                    stmt.query_row(params![menu_id], |r| r.get::<_, i64>(0))?
                };
                conn.execute(
                    "INSERT INTO menu_recipes (id, menu_id, recipe_id, course, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        new_id(),
                        menu_id,
                        recipe_id,
                        course.unwrap_or_else(|| "other".to_string()),
                        next_order,
                    ],
                )?;
            }
            let mut stmt = conn.prepare("SELECT * FROM menus WHERE id = ?1")?;
            let row = stmt.query_row(params![menu_id], MenuRow::from_row)?;
            Ok(Menu::from(row))
        })
        .await
    }
}
