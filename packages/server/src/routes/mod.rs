//! Non-GraphQL HTTP endpoints that live alongside the GraphQL handler on the
//! same port, mirroring the Node `graphql-server.ts` surface.

pub mod fetch_recipe;
pub mod lookup_barcode;
pub mod plu;
pub mod recipe_ics;
pub mod settings;
pub mod upload;
pub mod wikibooks;
