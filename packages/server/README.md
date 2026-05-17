# @pantry-host/server — Rust GraphQL backend (phase 2)

IoT-targeted Rust rewrite of `packages/app/graphql-server.ts`. Drop-in
replacement for the GraphQL endpoint that the React app, web PWA, and MCP
server talk to.

**Phase 2 ports only the core GraphQL CRUD surface.** Three endpoints from
the Node server stay unported for now and return HTTP 501 / a recognizable
error:

- `POST /upload` — multipart image upload + `sharp` variant generation
- `POST /fetch-recipe` — JSON-LD scraping of recipe URLs
- `generateRecipes` GraphQL mutation — Anthropic SDK call

If you need any of those features, run the Node `graphql-server.ts` instead
(or run them on a sidecar port). They are scheduled for follow-up phase 2.x
sub-PRs.

## Stack

- **axum 0.8** — HTTP framework (Tokio, hyper)
- **async-graphql 7** — GraphQL schema and execution
- **rusqlite 0.31 + r2d2** — SQLite via the bundled C library; small pool
- **tokio** — async runtime, signal handling

Release binary ships at ~3 MB stripped (`opt-level = "z"`, LTO, panic=abort).
Targets Pi 3-class devices comfortably.

## Run it

```bash
# from packages/server/
SQLITE_DB_PATH=../app/pantry.db cargo run

# or release mode:
cargo build --release
SQLITE_DB_PATH=../app/pantry.db ./target/release/pantry-server
```

The repo-root convenience scripts:

```bash
npm run dev:graphql-rs       # cargo run from packages/server
npm run build:graphql-rs     # cargo build --release
```

Or use the `graphql-server-rs` launch config in `.claude/launch.json`.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `SQLITE_DB_PATH` | `./pantry.db` | Same file the Node server uses |
| `GRAPHQL_PORT` | `4001` | Same port — frontend `lib/gql.ts` works unchanged |
| `RUST_LOG` | `info` | `tracing-subscriber` filter (e.g. `debug`, `pantry_server=debug`) |

## Schema source of truth

The SQLite DDL lives in `packages/shared/src/sql/schema.sql` and is included
at compile time via `include_str!`. The TS-facing module
`packages/shared/src/sql/schema.ts` ships the same SQL embedded as a string
for the Node and browser SQLite consumers. **Both files must be kept in
sync**; they're side-by-side specifically so changes show up in the same diff.

## Why GraphQL still (and not REST)

Three downstream clients already speak GraphQL — `packages/app/lib/gql.ts`,
`packages/web/lib/gql.ts`, and `packages/mcp/src/graphql-client.ts`. Switching
to REST would force a rewrite across all of them with no measured win on a
2026-era Pi 3 (async-graphql's overhead is dwarfed by SQLite I/O). The REST
option stays on the table; revisit if profiling shows it matters.

## File layout

```
src/
├── main.rs               # axum server, route setup, graceful shutdown
├── db.rs                 # rusqlite pool, schema apply, ID + timestamp helpers
├── error.rs              # AppError stub for future contextual errors
├── models.rs             # rusqlite Row → struct conversions per table
└── graphql/
    ├── mod.rs            # MergedObject roots
    ├── sql_helpers.rs    # kitchen lookup, slug uniqueness, sub-recipe linking
    ├── kitchen.rs        # Kitchen type + queries + mutations
    ├── ingredient.rs     # Ingredient type + queries + mutations
    ├── recipe.rs         # Recipe + RecipeIngredient + queries + mutations
    ├── cookware.rs       # Cookware type + queries + mutations
    └── menu.rs           # Menu + MenuRecipe + queries + mutations
```
