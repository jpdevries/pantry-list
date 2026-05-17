use async_graphql::{EmptySubscription, MergedObject, Schema};

use crate::config::ServerConfig;
use crate::db::Pool;

mod cookware;
mod ingredient;
mod kitchen;
mod menu;
mod recipe;
mod sql_helpers;

use cookware::{CookwareMutation, CookwareQuery};
use ingredient::{IngredientMutation, IngredientQuery};
use kitchen::{KitchenMutation, KitchenQuery};
use menu::{MenuMutation, MenuQuery};
use recipe::{RecipeMutation, RecipeQuery};

/// Root Query type — async-graphql's `MergedObject` flattens each sub-object's
/// resolvers into a single top-level Query schema. One file per domain.
#[derive(MergedObject, Default)]
pub struct QueryRoot(
    IngredientQuery,
    RecipeQuery,
    CookwareQuery,
    KitchenQuery,
    MenuQuery,
);

#[derive(MergedObject, Default)]
pub struct MutationRoot(
    IngredientMutation,
    RecipeMutation,
    CookwareMutation,
    KitchenMutation,
    MenuMutation,
);

pub type AppSchema = Schema<QueryRoot, MutationRoot, EmptySubscription>;

pub fn build_schema(
    pool: Pool,
    http: reqwest::Client,
    config: ServerConfig,
) -> AppSchema {
    Schema::build(QueryRoot::default(), MutationRoot::default(), EmptySubscription)
        .data(pool)
        .data(http)
        .data(config)
        .finish()
}
