# CLAUDE.md

Project context for AI agents working on this codebase.

> **Machine-specific context:** If a `CLAUDE.local.md` file exists in the repo root, read it for machine-specific setup notes (DB credentials, paths, local services, etc.). It is gitignored and varies per machine.

## What is this?

Pantry Host is a privacy-first kitchen companion for managing recipes, pantry ingredients, cookware, and grocery lists. It ships three ways: self-hosted with SQLite (Node 22+'s built-in `node:sqlite`), browser-native with `@sqlite.org/sqlite-wasm` (OPFS-backed), or as a static marketing page. All data stays on your hardware.

## Monorepo structure

```
pantry-host/
├── packages/
│   ├── app/          # Self-hosted Rex app (SQLite, SSR)
│   ├── shared/       # Shared types, adapters, constants, theme, components
│   ├── marketing/    # Static landing page (Vite, Cloudflare Pages)
│   ├── web/          # Browser-native PWA (@sqlite.org/sqlite-wasm + OPFS, Vite)
│   ├── mcp/          # MCP server (Model Context Protocol for AI integrations)
│   └── server/       # Rust GraphQL backend (phase-2 IoT rewrite, axum + async-graphql + rusqlite)
├── package.json      # npm workspaces root
├── .env.local        # App env vars (SQLITE_DB_PATH, AI_PROVIDER, AI_API_KEY)
├── .claude/          # Launch configs, settings
└── CLAUDE.md
```

### npm workspaces

Root `package.json` has `"workspaces": ["packages/*"]`. Run workspace scripts via:
```bash
npm run dev                    # packages/app (Rex @ 3000)
npm run dev:graphql            # packages/app GraphQL (4001, Node + node:sqlite)
npm run dev:graphql-rs         # packages/server (Rust GraphQL @ 4001, drop-in replacement for dev:graphql)
npm run dev:marketing          # packages/marketing (Vite @ 5173)
npm run dev:web                # packages/web (Vite @ 5174)
npm run dev:mcp                # packages/mcp (MCP server, stdio)
```

Or use `.claude/launch.json` configs: `pantry-host`, `graphql-server`, `graphql-server-rs`, `marketing`, `web`, `mcp-server`.

## packages/app — Self-hosted (Rex + SQLite)

### Rex framework (not Next.js)

Uses **Rex** (`@limlabs/rex`), a custom React bundler built on rolldown. Mimics Next.js file-based routing but is NOT Next.js.

**Critical Rex behaviors:**
- Client bundles served from `/_rex/static/` and `/_rex/router.js`
- Stale `.rex/build` causes hydration failures. Fix: `rm -rf .rex/build` + restart
- No `<Link>` component — all `<a>` tags trigger full page loads
- Rex 0.19.2 has Tailwind v4 built into its Rust binary
- Rex's bundler doesn't follow Node module resolution up the tree. Requires React symlinks in `packages/app/node_modules/` (handled by `postinstall` script)

### Dual servers

| Server | Port | Purpose |
|--------|------|---------|
| Rex dev server | 3000 | Frontend SSR + static assets |
| GraphQL server | 4001 | API (graphql-yoga + Pothos) |
| MCP server | 5001 | AI agent integration (optional, HTTP mode) |

### Database

SQLite via **Node 22+'s built-in `node:sqlite`** module (no native install). Configure with `SQLITE_DB_PATH=./pantry.db` (default).

Schema is the shared module `@pantry-host/shared/sql/schema` (single source of truth used by both the app and the web PWA). It's idempotent (`CREATE TABLE IF NOT EXISTS …`) and auto-applied by `lib/db.ts` on first connection.

Tables: `kitchens`, `ingredients`, `recipes`, `recipe_ingredients`, `recipe_cookware`, `cookware`, `menus`, `menu_recipes`.

Column conventions:
- IDs are TEXT (UUIDs supplied by JS via `crypto.randomUUID()`).
- Timestamps are TEXT ISO 8601 (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` default).
- Tag/alias/photo arrays are TEXT containing JSON (default `'[]'`); product_meta is JSON TEXT.
- Booleans are INTEGER 0/1; decimals are REAL.

### GraphQL schema

**`packages/app/lib/schema/index.ts` is the REAL schema.** The old dead files (`recipe.ts`, `ingredient.ts`, `cookware.ts`, `builder.ts`) have been deleted.

The `sql` wrapper in `lib/db.ts` is a thin tagged-template over `node:sqlite`:
```typescript
const [row] = await sql`SELECT * FROM recipes WHERE slug = ${slug}`;

// JS arrays expand to (?, ?, ?) for IN / VALUES lists:
sql`SELECT * FROM recipes WHERE id IN (${ids})`;

// JSON columns: caller stringifies explicitly.
sql`INSERT INTO ingredients (..., tags) VALUES (..., ${JSON.stringify(tags ?? [])})`;
```

A `bulkInsert(table, rows, cols)` helper is exported for the rare true bulk path (only `addIngredients` today).

### File structure

```
packages/app/
├── pages/               # Rex file-based routes
│   ├── _app.tsx         # App shell (Nav, OfflineBanner, SW, theme)
│   ├── _document.tsx    # SSR template (DEFAULT_THEME meta tag)
│   ├── index.tsx        # Dashboard
│   ├── list.tsx         # Grocery list
│   ├── ingredients.tsx  # Pantry
│   ├── cookware.tsx     # Cookware
│   ├── recipes/         # Recipe CRUD + import
│   ├── menus/           # Menu CRUD
│   ├── at/[...path].tsx # AT Protocol detail (recipe or collection)
│   └── kitchens/        # Multi-kitchen variants
├── components/          # React components
├── lib/
│   ├── gql.ts           # GraphQL HTTP client (POST to port 4001)
│   ├── db.ts            # Postgres connection (lazy-init proxy)
│   ├── schema/index.ts  # Pothos GraphQL schema
│   ├── cache.ts         # → @pantry-host/shared/cache
│   ├── claude.ts        # Anthropic SDK (AI recipes)
│   ├── apiStatus.ts     # API reachability polling
│   └── offlineQueue.ts  # Offline mutation queue
├── graphql-server.ts    # Standalone GraphQL server
├── schema.sql           # Database DDL
└── public/sw.js         # Service Worker
```

## packages/shared — Shared code

Exports used by all packages:

| Export | Description |
|--------|-------------|
| `@pantry-host/shared/constants` | Categories, units, common ingredients |
| `@pantry-host/shared/theme` | Theme management (system/light/dark, palettes, high contrast) |
| `@pantry-host/shared/cache` | localStorage cacheGet/cacheSet |
| `@pantry-host/shared/dailyQuote` | Seasonal daily quotes |
| `@pantry-host/shared/types` | TypeScript interfaces (Kitchen, Recipe, etc.) |
| `@pantry-host/shared/components/Footer` | Footer with conversions + theme controls |
| `@pantry-host/shared/components/AtRecipeDetail` | Detail view + import CTA for `exchange.recipe.recipe` AT URIs |
| `@pantry-host/shared/components/AtMenuDetail` | Detail view + import CTA for `exchange.recipe.collection` AT URIs |
| `@pantry-host/shared/components/PixabayImage` | Borrowed photo for recipe cards. Pass `inCard` to suppress grid tab-stop bloat (attribution anchors get `tabindex=-1`, overlay gets `aria-hidden`) |
| `@pantry-host/shared/bluesky` | Read-only AT Protocol client (`fetchBlueskyRecipe`, `fetchBlueskyCollection`, `listBlueskyRecipes`, etc.) |
| `@pantry-host/shared/bluesky-import` | `importBlueskyCollection({ atUri, gql, kitchenSlug?, onProgress? })` — fetches collection + each recipe + creates menu |
| `@pantry-host/shared/adapters/database` | DatabaseAdapter interface |
| `@pantry-host/shared/adapters/file-storage` | FileStorageAdapter interface |
| `@pantry-host/shared/sql/schema` | Canonical SQLite DDL string. Imported by both `packages/app/lib/db.ts` and `packages/web/lib/db.ts` — single source of truth, resolves the schema-drift gotcha. |

### Storage adapter pattern

```typescript
// DatabaseAdapter — node:sqlite (app) vs @sqlite.org/sqlite-wasm + OPFS (web)
interface DatabaseAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
}

// FileStorageAdapter — filesystem (app) vs OPFS (web)
interface FileStorageAdapter {
  getFile(path: string): Promise<Blob>;
  putFile(path: string, file: Blob): Promise<void>;
  deleteFile(path: string): Promise<void>;
  getURL(path: string): string;
}
```

## packages/marketing — Static landing page

Vite + React + Tailwind v4. Deploys to Cloudflare Pages via `vite build` → `dist/`.

Sections: Hero, Tiers (Browser/Self-hosted/Claude Code), Features, Philosophy, Footer.

## packages/web — Browser-native PWA

Vite + React Router + @sqlite.org/sqlite-wasm + Tailwind v4. Runs entirely in-browser — no server required.

### Key architecture

- **SQLite WASM** (`lib/db.ts`): The official `@sqlite.org/sqlite-wasm` build with the OPFS-SAH-Pool VFS for persistence (`/pantryhost.db` inside OPFS). Same tagged-template `sql` API as the app, so GraphQL resolvers in `lib/schema/index.ts` are byte-for-byte aligned with the app's. Falls back to in-memory if OPFS-SAH-Pool init fails (Safari private mode, sandboxed Playwright Chromium, etc.).
- **Local GraphQL** (`lib/gql.ts`): Executes GraphQL directly in-browser via `graphql()` from `graphql-js`. Same `gql<T>(query, variables)` API as the app's HTTP client.
- **Schema** (`lib/schema/index.ts`): Resolver code mirrors the app's; the only difference is the missing `generateRecipes` mutation (no server-side AI key). DDL comes from `@pantry-host/shared/sql/schema`.
- **OPFS storage** (`lib/storage-opfs.ts`): User file uploads live in the same OPFS volume.
- **Data export** (`lib/export.ts`): SQLite-flavored SQL dump for backup/migration to self-hosted.
- **No guest mode** — everything is local, user owns all features.
- **No AI generation** — no server-side API key available.

> **OPFS-SAH-Pool VFS notes:** No COOP/COEP headers required. The pool VFS uses synchronous-access-handles obtained ahead of time and works on the main thread in Chrome/Edge 102+, Safari 17+, Firefox 111+. Playwright's Chromium reports `createSyncAccessHandle: false` even on recent versions — the fallback to in-memory kicks in there. To verify persistence locally, open the dev server in your actual browser; the absence of `[db] OPFS-SAH-Pool unavailable…` in console means OPFS persistence is active.

### File structure

```
packages/web/
├── src/
│   ├── main.tsx         # Entry point (theme init, SQLite init)
│   ├── App.tsx          # React Router routes
│   ├── Layout.tsx       # Nav + Footer shell
│   ├── globals.css      # Theme tokens + Tailwind v4
│   └── pages/           # Page components (Home, Recipes, Ingredients, etc.)
├── lib/
│   ├── db.ts            # sqlite-wasm + OPFS-SAH-Pool tagged template wrapper
│   ├── gql.ts           # Local GraphQL executor
│   ├── schema/index.ts  # GraphQL schema (no AI)
│   ├── storage-opfs.ts  # OPFS file storage
│   ├── export.ts        # Data export
│   ├── apiStatus.ts     # Stub (always online)
│   └── offlineQueue.ts  # Stub (no remote server)
├── public/
│   ├── manifest.json    # PWA manifest
│   └── sw.js            # Service worker
├── index.html           # Vite entry
└── vite.config.ts       # Vite + React + Tailwind + @/ alias
```

## packages/mcp — MCP Server (AI integrations)

Exposes the PantryHost GraphQL API as MCP (Model Context Protocol) tools so external AI clients (Claude Desktop, IronClaw, Cursor, etc.) can interact with pantry data. Targets Tier 2 self-hosters.

### Architecture
- **Thin translation layer**: Talks to the GraphQL server over HTTP (`localhost:4001`), not directly to Postgres
- **Dual transport**: stdio (Claude Desktop) via default, HTTP on port 5001 via `--http` flag
- **Optional auth**: Set `MCP_API_KEY` env var to require `Authorization: Bearer` for HTTP transport

### Tools (30 total)
- **Read (9):** search_pantry, search_recipes, get_recipe, list_cookware, get_cookware, list_kitchens, get_kitchen, list_menus, get_menu
- **Write (16):** add_ingredient, add_ingredients, update_ingredient, remove_ingredient, create_recipe, update_recipe, set_recipe_photo, delete_recipe, mark_recipe_cooked, queue_recipe, add_cookware, update_cookware, delete_cookware, create_menu, update_menu, delete_menu, toggle_recipe_in_menu
- **AI (1):** generate_recipes (requires `AI_API_KEY` on the GraphQL server)

### Resources
`pantry://ingredients`, `pantry://recipes`, `pantry://cookware`, `pantry://menus`, `pantry://kitchens`

### File structure
```
packages/mcp/
├── src/
│   ├── index.ts              # Entrypoint (stdio or HTTP transport)
│   ├── server.ts             # McpServer setup, registers tools + resources
│   ├── graphql-client.ts     # gql<T>() for talking to GraphQL on port 4001
│   ├── tools/
│   │   ├── ingredients.ts    # Pantry CRUD
│   │   ├── recipes.ts        # Recipe CRUD + queue/cook
│   │   ├── cookware.ts       # Cookware CRUD
│   │   ├── menus.ts          # Menu CRUD
│   │   ├── kitchens.ts       # Kitchen CRUD
│   │   └── generate.ts       # AI recipe generation
│   └── resources/
│       └── pantry.ts         # pantry:// read-only resources
├── package.json
└── tsconfig.json
```

### Claude Desktop setup
```json
{
  "mcpServers": {
    "pantry-host": {
      "command": "npx",
      "args": ["tsx", "/path/to/packages/mcp/src/index.ts", "--stdio"],
      "env": { "GRAPHQL_URL": "http://localhost:4001/graphql" }
    }
  }
}
```

### Dependencies
- `@modelcontextprotocol/sdk` — MCP TypeScript SDK
- `zod` — Input schema validation (required by MCP SDK)
- Requires the GraphQL server to be running on port 4001

## packages/server — Rust GraphQL backend (phase 2)

IoT-targeted Rust rewrite of `packages/app/graphql-server.ts`. Drop-in replacement for the GraphQL endpoint that the React app, web PWA, and MCP server talk to. ~3 MB stripped release binary, built for Pi 3-class devices.

### Stack
- **axum 0.8** + **async-graphql 7** — HTTP + GraphQL execution
- **rusqlite 0.31 + r2d2** — bundled SQLite C library, small connection pool
- **tokio** — async runtime; resolvers offload DB calls via `spawn_blocking`

### Scope (phase 2)

Ports the full GraphQL CRUD surface — every query and every non-AI mutation that `packages/app/lib/schema/index.ts` defines:
- Queries: `kitchens`, `kitchen`, `ingredients`, `recipes`, `recipe`, `cookware`, `cookwareItem`, `menus`, `menu`
- Mutations: ingredient/cookware/kitchen/menu CRUD, `createRecipe`, `updateRecipe`, `deleteRecipe`, `completeRecipe`, `toggleRecipeQueued`, `toggleRecipeInMenu`, `addIngredients` (bulk)

Three Node-server endpoints stay unported and return HTTP 501 / a recognizable GraphQL error:
- `POST /upload` — multipart image upload + sharp variants
- `POST /fetch-recipe` — JSON-LD recipe scraping
- `generateRecipes` GraphQL mutation — Anthropic SDK call

Use `npm run dev:graphql` (Node server) when those features are needed.

### File structure
```
packages/server/
├── Cargo.toml                # opt-level=z, LTO, panic=abort for minimum binary size
├── src/
│   ├── main.rs               # axum server, CORS, graceful shutdown, 501 stubs
│   ├── db.rs                 # rusqlite pool, schema apply, ID + timestamp helpers
│   ├── error.rs              # AppError stub for contextual errors (reserved)
│   ├── models.rs             # rusqlite Row → struct conversions per table
│   └── graphql/
│       ├── mod.rs            # MergedObject Query/Mutation roots
│       ├── sql_helpers.rs    # kitchen lookup, unique_slug, sub-recipe linking
│       ├── kitchen.rs        # Kitchen type + queries + mutations
│       ├── ingredient.rs     # Ingredient + queries + mutations
│       ├── recipe.rs         # Recipe + RecipeIngredient + queries + mutations
│       ├── cookware.rs       # Cookware + queries + mutations
│       └── menu.rs           # Menu + MenuRecipe + queries + mutations
└── README.md
```

### Run

```bash
npm run dev:graphql-rs                                 # from repo root
# or: cd packages/server && SQLITE_DB_PATH=../app/pantry.db cargo run
# or: npm run build:graphql-rs (release)
```

Configurable via `SQLITE_DB_PATH` (default `./pantry.db`), `GRAPHQL_PORT` (default `4001`), and `RUST_LOG` (default `info`).

### Schema source of truth

The SQLite DDL lives in `packages/shared/src/sql/schema.sql` (canonical SQL) and is `include_str!`'d into the Rust binary at compile time. `packages/shared/src/sql/schema.ts` ships the same SQL embedded as a TS string for the Node and browser SQLite consumers. **Both files must be kept in sync** — they're side-by-side specifically so changes show up in the same diff. If you edit one, edit the other.

## packages/feed — Firehose indexer (Fly.io)

A thin AT Protocol firehose indexer that powers the Bluesky feed pages in both web and app packages. Runs on Fly.io at `feed.pantryhost.app`; clients call it cross-origin.

- Subscribes to the AT firehose for `exchange.recipe.recipe` and `exchange.recipe.collection`
- Stores record pointers + values in SQLite (`better-sqlite3` + WAL), cursor-indexed on `(collection, created_at, at_uri)`
- `GET /api/recipes?collection=&cursor=&limit=` — paginated feed. Cursor format `"<createdAt>|<atUri>"`. Defaults to `exchange.recipe.recipe`; pass `collection=exchange.recipe.collection` for menus
- `GET /api/handles` — all publishers that have ever appeared in the firehose
- `GET /api/recipe-url?url=…` — cross-origin URL proxy for the browser PWA (bypasses CORS for sites that don't set `access-control-allow-origin: *`)
- `GET /api/markets?lat=&lng=` — OSM Overpass proxy for nearby farmers' markets and farms
- `GET /api/plu?name=banana` (or `&name=…` repeated, or `?code=4011`) — IFPS PLU lookup. Returns produce-code candidates backed by the bundled `plu-codes.json` (~1,500 rows). Self-hosted mirror at `:3000/api/plu` has identical shape.
- No auth on reads; cache-control: 30s on `/api/recipes`; 86400s on `/api/plu` (static data).
- Data is always re-fetched live from each author's PDS at render time. The indexer only tells us records exist — values in the response are the most recent seen, but the detail page re-fetches to guarantee freshness.

## Pantry identifiers (barcode + PLU)

**`ingredients.barcode` is overloaded**: it stores any printed product identifier, UPC/EAN *and* PLU. Discriminate by length:

| Length, content | Type | Metadata source |
|---|---|---|
| 8, 12, or 13 digits | UPC-A / EAN-8 / EAN-13 (packaged) | Open Food Facts → `product_meta` populated with `nutriments`, `nutriscore_grade`, `nova_group`, `labels_tags`, `allergens_tags`, etc. |
| 4 digits in 3000–4999 | Conventional PLU (produce) | IFPS → `product_meta.plu_source: "ifps"` with `commodity`, `variety`, `size`, `organic: false`, `category` |
| 5 digits starting with 9 | Organic PLU variant | Same IFPS record as the 4-digit base, with `organic: true` |

`shared/src/plu.ts` exports `isPluCode(code)` as the canonical check — anything matching goes down the PLU path; otherwise treat as barcode. `buildPluMeta(rec, organic)` constructs the IFPS-flavored `ProductMeta`. Callers (pantry filter, `IngredientMetaPanel`, MCP tools) should branch on `plu_source === 'ifps'` and/or `isPluCode(barcode)` to render correctly — PLU rows don't have nutrition, OFF rows don't have commodity/variety.

The pantry filter's `i.barcode?.includes(q)` predicate matches both — typing `4011` finds the banana row, typing `011863118764` finds the cheese row.

## Conventions

### Styling
- **Tailwind CSS v4** — `@import "tailwindcss"` + `@source` directives
- CSS custom properties for theming: `--color-bg-body`, `--color-accent`, etc.
- Palettes: default, rosé, rebecca purple, claude
- Dark mode via `data-color-scheme` attribute on `<body>` + `@media (prefers-color-scheme: dark)` for system default. Managed by `@pantry-host/shared/theme`
- High contrast mode via `data-high-contrast` attribute on `<body>`

### Accessibility
- **`aria-describedby` pattern**: Action buttons use `aria-label` + `aria-describedby` pointing to the item name element (better for i18n).
- **Focus management**: Delete confirmations get `autoFocus`. Inline edit forms pass `autoFocus` to first input.
- **Scroll targets**: Category headings use `scroll-mt-20` to clear sticky navs.

### Icons
Font Awesome Pro 5.15.4 **Light** SVGs as inline React components. Source: `/Users/jpdevries/Downloads/fontawesome-pro-5.15.4-web/svgs/light/`. Copy SVG `<path>` into component, don't use an icon library.

### Theme defaulting
`DEFAULT_THEME=claude` env var → `<meta name="default-palette">` in `_document.tsx` → `getThemePalette()` reads it as fallback when no localStorage preference. Set in `.claude/launch.json`.

### GraphQL patterns
- App: `gql()` POSTs to `http://localhost:4001/graphql`
- Web: `gql()` executes GraphQL locally via `graphql-js`
- Same API signature: `gql<T>(query, variables): Promise<T>`
- Queries accept `$kitchenSlug: String` for multi-kitchen filtering

### AT Protocol / Bluesky
- **`/at/{did}/{collection}/{rkey}#stage` route** in both packages dispatches by collection type:
  - `exchange.recipe.recipe` → `AtRecipeDetail` (shared component)
  - `exchange.recipe.collection` → `AtMenuDetail` (shared component)
  - Other lexicons are rejected with a user-facing error
- **URL variant normalization**: `/at://…` and URL-encoded `/at%3A/…` are rewritten to `/at/…` at the Cloudflare edge (web) and by a client-side fallback in `main.tsx` / `_app.tsx`. Paste any `at://` form and it resolves.
- **QR share**: every AT detail page has a Share button that opens `QRCodeModal` with the current URL — scan to pick up the recipe/menu on another device.
- **Author handle resolution**: `fetchBlueskyRecipe` / `fetchBlueskyCollection` call `com.atproto.repo.describeRepo` to turn a DID into a handle. Best-effort; falls back to the DID if the lookup fails.
- **`sourceUrl`**: AT URIs (`at://did:plc:.../exchange.recipe.recipe/…`) are valid values and are rendered as Bluesky links on detail pages. Auto-tag `bluesky` on imports.
- **Bluesky feed pages** (`/recipes/feeds/bluesky`, `/menus/feeds/bluesky`) fetch from `feed.pantryhost.app/api/recipes` with cursor pagination. A "User Flow" fieldset toggles Browse & Import (cards are links to `/at/{uri}#stage`) vs Bulk Import (cards are checkboxes + a single Import CTA). Mode persists in `localStorage` under `bsky-feeds-mode` / `bsky-menu-feeds-mode`.
- **Bulk collection import** uses the shared `importBlueskyCollection` helper from `@pantry-host/shared/bluesky-import` — single helper, used by both the feed's bulk flow and the AT menu detail page's single-menu Import CTA, so the two flows can't drift.

### Recipe creation
When creating or suggesting recipes (via AI generation, MCP, or conversational requests):
- Always search for and set a `photoUrl` on new recipes. Use `WebSearch` to find a relevant recipe photo, then `WebFetch` to extract the image URL from the page's structured data or hero image.
- Use the `updateRecipe` mutation to set the `photoUrl` after creation if needed.
- If a recipe ships without a `photoUrl`, card grids fall back to Pixabay (opt-in; requires a key + the `pixabay-fallback-enabled` setting). Still prefer a real photo for detail-page heroes — the fallback is a nicety for grids, not a substitute.
- `sourceUrl` accepts both `https://…` URLs and `at://did:plc:.../exchange.recipe.recipe/…` AT URIs. AT URIs are rendered as Bluesky links on detail pages; auto-tag `bluesky` on imports.

### Recipe images
`photoUrl` supports two modes:
- **External URL** (e.g. `https://example.com/photo.jpg`) — served as-is via a plain `<img>`. Quick to set but no responsive variants, no offline caching.
- **Local upload** (e.g. `/uploads/{uuid}.jpg`) — processed by `sharp` on upload into 9 variants: 3 widths (400/800/1200) × WebP + JPEG + grayscale JPEG. Served via `<picture>` with `srcset` for responsive loading, `@media (monochrome)` for e-ink, and cached immutably by the service worker. **Preferred.**

To use local uploads: `POST /api/upload` with a `multipart/form-data` file field. The endpoint saves the original, generates variants in the background, and returns `{ url: "/uploads/{uuid}.ext" }`. Uploaded files use UUID filenames and are immutable — if an image needs replacing, upload a new file and update the recipe's `photoUrl`.

For batch processing existing uploads: `npx tsx packages/app/scripts/process-existing-uploads.ts` (idempotent).

The `ResponsiveImage` component (`components/ResponsiveImage.tsx`) handles both modes automatically — local uploads get `<picture>` with sources, external URLs get a plain `<img>` with `width`/`height` for CLS prevention.

### Composting tips
When the user asks to add composting tips to an existing recipe:
1. Query cookware for items tagged `waste-cycler` or `compost`
2. Read the cookware's `notes` field for device-specific rules (what it accepts/rejects)
3. If `notes` is empty, ask the user to provide their device's composting rules first, then save via `updateCookware`
4. Append a "Compost:" step to the recipe's instructions listing which scraps can/can't go in the device
5. Update the recipe via `updateRecipe` mutation

AI-generated recipes automatically include composting tips when composting cookware with notes is detected.

### Service Worker (`packages/app/public/sw.js`)

The SW provides offline support for the self-hosted app. Key design decisions:

**Caching strategies:**
- **Shell pages** (/, /list, /recipes, etc.) are pre-cached on install individually (not `addAll`) so one failure doesn't abort the entire install
- **Rex bundles** (`/_rex/`): network-first, cached for offline fallback
- **HTML navigation**: network-first, falls back to cache, last resort is cached homepage
- **Other same-origin** (images, fonts): stale-while-revalidate
- **Cross-origin** (GraphQL on port 4001, Google Fonts): ignored/passthrough

**Build-hash cleanup:** Rex prod builds embed an 8-char hash in filenames (e.g. `chunk-esm-557eb197.js`). Without cleanup, the cache accumulates dead entries across deploys. When a new bundle is fetched, the SW extracts the hash and purges all `/_rex/static/` entries with a different hash. No manual `CACHE_NAME` bumping needed.

**GraphQL data is NOT cached by the SW.** The SW runs on port 3000 and cannot intercept cross-origin requests to port 4001. Data caching is handled at the application level via `localStorage` (`lib/cache.ts`). Pages that depend on GraphQL (menus, recipes, grocery list) need at least one prior visit while online to populate the localStorage cache — otherwise they show skeleton UI offline.

**Testing offline:** Always test in prod mode (`rex build` + `rex start`). Dev mode uses different asset paths. On iOS, connect Safari remote debugger via Settings → Safari → Advanced → Web Inspector.

## Environment variables

```bash
SQLITE_DB_PATH=./pantry.db                                      # SQLite file path for app + migration script; default ./pantry.db
AI_PROVIDER=anthropic                                             # default: anthropic
AI_API_KEY=sk-ant-...                                             # optional, AI recipes
RECIPE_API_KEY=rapi_...                                         # optional, recipe-api.com import tab (owner-gated)
PIXABAY_API_KEY=                                                # optional, borrowed fallback images on recipe cards
PIXABAY_FALLBACK_ENABLED=true                                   # default true; feature dormant without a key
SHOW_COCKTAILDB=true                                            # default true, set false to hide TheCocktailDB import tab
GRAPHQL_PORT=4001                                               # default 4001
DEFAULT_THEME=claude                                            # auto-set by launch.json
MCP_PORT=5001                                                   # default 5001, MCP HTTP mode
MCP_API_KEY=                                                    # optional, bearer auth for MCP HTTP
GRAPHQL_URL=http://localhost:4001/graphql                       # MCP server's GraphQL target
APP_URL=http://localhost:3000                                   # MCP server's target for /api/upload (set_recipe_photo)
ENABLE_IMAGE_PROCESSING=true                                    # false: skip sharp variants, save disk (Pi)
```

## Dev vs Prod mode

Both modes read a local SQLite file at `$SQLITE_DB_PATH` (default `./pantry.db`).

### Dev mode (default)
Local app, local SQLite file on this machine.
```
preview_start pantry-host        # Rex dev server @ :3000
preview_start graphql-server     # GraphQL @ :4001 (local SQLite at ./pantry.db)
```

### Prod mode
With SQLite there's nothing networked to point at — the DB is just a file. To work against the Mini's data, either:
- **Sync the file** over Tailscale: `rsync -av jmini:~/code/pantry-host/packages/app/pantry.db packages/app/pantry.db` (one-way; do this before/after each session).
- **Mount remotely**: SSH-mount or SMB/NFS the Mini's repo, then point `SQLITE_DB_PATH` at the mounted path (writes are slow over the network — consider WAL mode + `PRAGMA synchronous=NORMAL` are already set).
- **Run the server on the Mini**: `ssh jmini` and start `graphql-server` there, hitting it over Tailscale at `http://100.125.77.118:4001/graphql`.

> The migration script `scripts/migrate-postgres-to-sqlite.ts` is the one-shot path from a previous Postgres install (set `DATABASE_URL=...` as source and `SQLITE_DB_PATH=...` as destination).

## Common tasks

### Clear stale Rex build cache
```bash
rm -rf .rex/build
```

### Install deps after monorepo changes
```bash
npm install  # from repo root, handles all workspaces
```

### Build packages
```bash
cd packages/marketing && npx vite build   # → dist/
cd packages/web && npx vite build         # → dist/
```

## Gotchas

1. **Blank pages after code changes**: Stale `.rex/build`. Delete it and restart.
2. **`react is not defined` in Rex V8**: npm workspaces hoists React to root. Rex doesn't walk up. The `postinstall` symlink script in `packages/app/package.json` fixes this.
3. **SW serving stale assets**: The SW auto-purges stale Rex bundles by build hash. If you still see issues, clear the cache: `caches.delete('pantry-host-shell').then(() => location.reload())`. Test offline behavior in prod mode only (`rex build` + `rex start`).
4. **No `<Link>` in app**: Rex uses plain `<a>` tags. The web package uses React Router `<Link>`.
5. **Tailwind v4 in Rex**: Rex 0.19.2 has Tailwind v4 built in. Don't use `@apply` — use plain CSS in `globals.css`.
6. **Guest mode (app only)**: Owner = `localhost` / `127.0.0.1` / HTTPS. Guest = HTTP on any other hostname (e.g. `http://192.168.x.x:3000`). Owners see Add, Edit, Delete, Import, inactive menus, batch scan, AI generation. Guests get read-only access to active content. The `isOwner()` function in `lib/isTrustedNetwork.ts` controls this. Not applicable to web package.
7. **SQLite-wasm WASM size**: ~700 KB gzipped. First load applies the schema and creates `/pantryhost.db` inside OPFS via the SAH-Pool VFS. Subsequent loads are instant. Falls back to in-memory if OPFS is unavailable (Safari private mode, sandboxed Playwright Chromium).
8. **Schema sync**: DDL lives in `@pantry-host/shared/sql/schema` — both `packages/app/lib/db.ts` and `packages/web/lib/db.ts` import the same string. **Resolver code** (`lib/schema/index.ts`) is still maintained per-package; the web copy is essentially the app's minus the `generateRecipes` mutation. Keep query/mutation surfaces in sync by hand when adding new operations.
9. **Rex router `query` unreliable in prod**: `useRouter().query` sometimes returns empty on dynamic routes in production builds. Always fall back to parsing `window.location.pathname` for route params (see `MenuDetailPage.tsx` for the pattern).
10. **Shared component Tailwind classes missing in app**: Rex's Tailwind v4 only scans `@source` paths. Add `@source "../../shared/src/components/";` to `globals.css` so shared component classes (grid-cols-7, flex-1, etc.) are generated.
11. **Rex SSR hook-state bug (local dev, Rex 0.20.0)**: a known regression can make every SSR route fail with `TypeError: Cannot read properties of null (reading 'useState')` — React resolves to null. Not caused by user code; reproduces at pristine `HEAD`. The pm2 prod build on the Mini is unaffected. Workaround: clear `.rex/build`, `npm install`, restart. If persistent, rebuild from a clean worktree.
12. **Adding a new shared component or module**: register it in `packages/shared/package.json` `exports` explicitly — Rex resolves shared modules through the exports map. After adding, stop the Rex dev server, clear `packages/app/.rex/build`, and restart. Hot-reload doesn't pick up new exports.
13. **`#stage` hash convention**: every internal link should end with `#stage` unless a specific anchor is intended. Both packages' Layout/shell wire the main content region as `<main id="stage">` and handle the hash scroll on route change. New internal links without `#stage` will appear to work but skip the intended scroll behavior.
14. **`data-bsky-card` marker**: every Bluesky feed card (recipes and menus, both browse and bulk modes) carries `data-bsky-card`. The Load more button's focus-management effect queries `[data-bsky-card]` to find the first newly-appended card after React paints so keyboard focus lands there. Don't rename or forget to add this on new feed layouts.
