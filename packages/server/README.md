# @pantry-host/server — Rust GraphQL backend + embedded SPA

IoT-targeted Rust rewrite of `packages/app/graphql-server.ts`. Drop-in
replacement for the GraphQL endpoint that the React app, web PWA, and MCP
server talk to — *plus* the side endpoints that live on the same port
*plus* the React frontend itself, baked into the binary:

- `POST /upload` — multipart image upload + UUID rename + background
  variant pipeline (3 widths × {WebP, JPEG q80, grayscale JPEG q80},
  16:9 center-crop, GIFs preserved as-is). Variant generation runs on
  a tokio blocking thread behind a semaphore so two concurrent uploads
  can't OOM a 1 GB Pi 3. Configure with `UPLOADS_DIR` and
  `IMAGE_CONCURRENCY` (default 1).
- `POST /fetch-recipe` — three-tier scraper: JSON-LD → schema.org
  microdata → heuristic HTML. Includes cookware substring detection
  against the cookware table.
- `generateRecipes` GraphQL mutation — direct HTTP call to the Anthropic
  Messages API (no SDK). Requires `AI_API_KEY` or `ANTHROPIC_API_KEY`.
- `GET /` (and any other GET that isn't an API path) — serves the Rex-built
  React app as a pure-client SPA. Per-page JS chunks live under
  `/_rex/static/`, uploaded images at `/uploads/`, and the HTML shell is
  generated per request from Rex's build manifest. See **Embedded
  frontend** below.

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
npm run sync-frontend        # rebuild + mirror packages/app -> static/
npm run build:pi             # cross-compile + Pi image for armv6/v7/arm64
                             # (re-syncs the frontend by default)
```

Or use the `graphql-server-rs` launch config in `.claude/launch.json`.

## Embedded frontend

The release binary contains the Rex-built React app baked in, so the Pi
just runs `pantry-server` and gets the full UI on `http://<host>:4001/`.

What's bundled:

| URL prefix          | Source                                          | Embedded? |
|---------------------|-------------------------------------------------|-----------|
| `GET /`             | HTML shell generated per request from manifest  | yes       |
| `GET /<any-page>`   | Same shell, but with the page bundle that matches the URL pattern (`/recipes/:slug`, `/at/*path`, …) | yes |
| `/_rex/static/<f>`  | `packages/app/.rex/build/client/<f>` (JS + CSS) | yes       |
| `/favicon.ico`, `/manifest.json`, `/sw.js`, `/icon-*.png`, `/pear.png` | `packages/app/public/<f>` | yes |
| `/uploads/<f>`      | `$UPLOADS_DIR/<f>` (user-uploaded images)       | no — disk |

The frontend lives in `packages/server/static/` (gitignored except for the
`.gitkeep` placeholders); `rust-embed` picks it up at compile time. A
`build.rs` walks the dir and emits `cargo:rerun-if-changed` for every file
so editing the SPA invalidates the Rust binary cache.

### Rebuilding the frontend

```bash
npm run sync-frontend -- --build         # rex build then mirror -> static/
cargo build --release -p pantry-server   # bake the new SPA into the binary
```

`npm run build:pi` runs the same `--build` mirror step once up front before
the per-target cross-compiles, so an Pi release picks up the latest SPA
automatically. Pass `--skip-frontend` to reuse what's already in `static/`
(handy when iterating on Rust-only changes).

### How the SPA boots

The server reads `static/client/manifest.json` (produced by `rex build`),
matches the request URL against the `pages` table (Rex's `:param` and
`*splat` patterns), and emits an HTML shell that loads:

1. `_app-<hash>.js` — sets `window.__REX_APP__`
2. `<page>-<hash>.js` — sets `window.__REX_PAGES[path]` and calls
   `hydrateRoot(#__rex, …)`

Module scripts execute in source order, so `_app` runs before the page
bundle and `__REX_APP__` is defined by the time hydration starts. There's
no server-side render — the `<div id="__rex">` ships empty and the page
bundle paints client-side.

This means `getServerSideProps` pages (e.g. `/recipes/:slug`) lose their
pre-rendered OG metadata. The page itself falls back to a client-side
fetch via `window.location.pathname`, so the recipe still loads — just
without SEO-friendly `<meta property="og:*">` tags. Acceptable trade-off
for a self-hosted home app; revisit if/when we care about Bluesky link
previews.

### `/api/*` parity

The Node `packages/app` shipped 10 Next.js-style API routes under
`/api/*`. All ten are now served by the Rust binary on the same paths
so the static SPA's `fetch('/api/...')` calls work unmodified:

| Route                  | Rust handler                            | Notes |
|------------------------|-----------------------------------------|-------|
| `POST /api/graphql`    | `graphql_handler` (alias of `/graphql`) | |
| `POST /api/upload`     | `routes::upload::handle` (alias)        | |
| `POST /api/fetch-recipe` | `routes::fetch_recipe::handle` (alias)| |
| `GET /api/settings-read` | `routes::settings::settings_read`     | Owner-gated; secrets masked unless `?reveal=KEY` |
| `POST /api/settings-write` | `routes::settings::settings_write`  | JSON or form-encoded; persists to `config.overrides_path` |
| `GET /api/recipe-api-key` | `routes::settings::recipe_api_key`   | Owner-gated reveal of `RECIPE_API_KEY` |
| `GET /api/plu`         | `routes::plu::handle`                   | IFPS dataset embedded via `include_str!`; same shape as `feed.pantryhost.app/api/plu` |
| `GET /api/lookup-barcode` | `routes::lookup_barcode::handle`     | Open Food Facts proxy with allowlisted `ProductMeta` |
| `GET /api/recipe-ics`  | `routes::recipe_ics::handle`            | Reads recipe + ingredients + cookware from SQLite, emits RFC 5545 calendar |
| `GET /api/wikibooks`   | `routes::wikibooks::handle`             | On first call, downloads ~3,900-entry HF dataset to `config.cache_dir`; subsequent requests serve from in-memory + disk cache |

"Owner" = request whose `Host` header is loopback (`localhost`,
`127.0.0.1`, `::1`) **or** whose `X-Forwarded-Proto` is `https` (covers
Tailscale-cert and mkcert setups). LAN guests on plain HTTP see masked
secrets on settings-read and a 403 on settings-write. Same threat model
as the Node version; spoofable `Host` isn't worse than what shipped
before, but a hardened deployment would want a real reverse-proxy auth
layer.

### New env vars (introduced by the port)

| Env var | Default | Notes |
|---|---|---|
| `OVERRIDES_PATH` | `<dirname(SQLITE_DB_PATH)>/.settings-overrides.json` | Settings-page edits persist here, layered on top of `process.env` at read time. |
| `RECIPE_API_KEY` | unset | Read by `/api/recipe-api-key` and surfaced in `/api/settings-read`. Owner-only. |
| `CACHE_DIR` | `<dirname(SQLITE_DB_PATH)>/.cache` | Disk-cache location for the Wikibooks dataset. |

## Pi cross-builds (`scripts/build-pi.sh`)

Cross-compiles a release binary for one or more Pi targets and bakes it into
a Pi-flavored Docker image. Each image is then started under QEMU emulation
to verify the binary boots before the script exits non-zero on failure.

> **On the verify base image:** there is no Docker Official Image for
> Raspberry Pi. The defaults are the closest userland we can pull anonymously
> for each Pi class:
>
> | Target       | Base image                               | Why                                                                                      |
> |--------------|------------------------------------------|------------------------------------------------------------------------------------------|
> | armv6        | `balenalib/rpi-raspbian:bookworm`        | Single-arch armv6+VFPv2 userland for Pi 1 / Zero. Deprecated upstream by Balena but still pulls; no actively-maintained alternative carries armv6 (Debian dropped it, dtcooper/raspberrypi-os only ships arm/v7 + arm64) |
> | armv7, arm64 | `debian:bookworm-slim`                   | Officially maintained by Debian, multi-arch, what Raspberry Pi OS is built on            |
>
> Override per-target with `--build-arg BASE_IMAGE=…` if you have something
> else (a custom Pi-flavored image, a private mirror, etc.).

```bash
./scripts/build-pi.sh                       # all three targets, build + verify
./scripts/build-pi.sh armv7                 # just armv7 (Pi 2/3 32-bit)
./scripts/build-pi.sh --no-verify all       # skip the docker run-through
./scripts/build-pi.sh --no-image arm64      # only emit the bare ELF
./scripts/build-pi.sh --integration armv7   # also run integration suite against image
```

### Integration tests against the built image

`--integration` re-runs `npm run test:integration` against each built image
instead of the locally-spawned native binary. The harness honors two env vars
(`INTEGRATION_SERVER_IMAGE`, `INTEGRATION_SERVER_PLATFORM`) and switches into
docker mode: it `docker run`s the image with bind-mounts for the SQLite path
and the uploads dir, points `ANTHROPIC_BASE_URL` at `host.docker.internal`
(the in-process mock server), and tears down the container on exit. The test
suite is byte-for-byte the same as native mode.

Foreign-arch images run under QEMU and are slow — expect armv7/arm64 to take
2–5× the native runtime on amd64 hosts, armv6 closer to 10×. Run a single
target while iterating:

```bash
./scripts/build-pi.sh --integration arm64
```

You can also invoke the harness directly without going through `build-pi.sh`:

```bash
INTEGRATION_SERVER_IMAGE=pantry-server:pi-arm64 \
INTEGRATION_SERVER_PLATFORM=linux/arm64 \
  npm run test:integration
```

| Target | Rust triple                        | Docker platform | Pi models       |
|--------|------------------------------------|-----------------|-----------------|
| armv6  | `arm-unknown-linux-gnueabihf`      | `linux/arm/v6`  | 1, Zero, Zero W |
| armv7  | `armv7-unknown-linux-gnueabihf`    | `linux/arm/v7`  | 2, 3 (32-bit)   |
| arm64  | `aarch64-unknown-linux-gnu`        | `linux/arm64`   | 3, 4, 5 (64-bit)|

Prerequisites: Docker, plus `cargo install cross --git https://github.com/cross-rs/cross`
(the install method recommended by cross-rs upstream). `packages/server/Cross.toml`
pins each target to `ghcr.io/cross-rs/<target>:0.2.5` for reproducibility —
both `:0.2.5` and `:main` are publicly pullable.

On a non-arm host the script registers `tonistiigi/binfmt` once so QEMU can
exec the foreign-arch binaries during verification.

#### Troubleshooting `Error response from daemon: error from registry: denied`

The cross-rs toolchain images on GHCR are public and pullable without
authentication. A `denied` error from the registry almost always means your
docker daemon is *sending* stale GHCR credentials and the server is rejecting
the auth attempt — even though anonymous would succeed:

```bash
docker logout ghcr.io                                                  # drop any stale token
docker pull ghcr.io/cross-rs/arm-unknown-linux-gnueabihf:0.2.5         # surfaces the real error
```

If `docker logout` doesn't help, check `~/.docker/config.json` for a leftover
`"ghcr.io"` entry under `auths` and remove it. On Docker Desktop with a
credentials helper (`credsStore`), you may also need to run
`docker-credential-<helper> erase` for `ghcr.io` or open Docker Desktop's
keychain UI and clear it there.

If your network requires authenticated pulls (corporate proxy, GHCR
anonymous-pull rate limit, or you'd just rather always be logged in), use a
GitHub personal access token. The token needs `read:packages` scope — nothing
else for pulling images.

1. Create a fine-grained or classic PAT at
   <https://github.com/settings/tokens> with at least `read:packages`.
2. Log docker in to GHCR, passing the token via stdin so it doesn't end up in
   your shell history:

   ```bash
   echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin
   ```

3. Retry the build. Cross's `docker pull` now goes out authenticated and the
   `denied` response goes away.

You can stash the token in a gitignored env file (`.env.build` is already
gitignored — it's a fine place) and source it before running the script:

```bash
# packages/server/scripts/.env.build
GHCR_PAT=ghp_xxxxxxxxxxxxxxxxxxxx
GHCR_USER=austin-liminal
```

…then in a wrapper or before `npm run build:pi`:

```bash
set -a; source packages/server/scripts/.env.build; set +a
echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
npm run build:pi
```

The token never lands in `~/.docker/config.json` in plaintext on macOS/Windows
— it's stored in the OS keychain via `credsStore`. On Linux without a
credential helper it *is* written to that file; `chmod 600` it.

Artifacts land in `packages/server/dist/pi/pantry-server-{armv6,armv7,arm64}`
and images are tagged `pantry-server:pi-{armv6,armv7,arm64}`.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `SQLITE_DB_PATH` | `./pantry.db` | Same file the Node server uses |
| `GRAPHQL_PORT` | `4001` | Same port — frontend `lib/gql.ts` works unchanged |
| `RUST_LOG` | `info` | `tracing-subscriber` filter (e.g. `debug`, `pantry_server=debug`) |
| `UPLOADS_DIR` | `../app/public/uploads` | Where `/upload` writes originals + variants |
| `IMAGE_PROCESSING` / `ENABLE_IMAGE_PROCESSING` | `true` | Set to `false`/`0` to skip variant generation (saves disk on Pi) |
| `IMAGE_CONCURRENCY` | `1` | Concurrent variant pipelines. Bump on amd64 hosts with more RAM |
| `AI_API_KEY` (or `ANTHROPIC_API_KEY`) | unset | Required for the `generateRecipes` mutation; otherwise it errors with a clear message |
| `OVERRIDES_PATH` | `<dirname(SQLITE_DB_PATH)>/.settings-overrides.json` | Where /api/settings-write persists overrides |
| `RECIPE_API_KEY` | unset | Surfaced by /api/recipe-api-key when the caller is an owner |
| `CACHE_DIR` | `<dirname(SQLITE_DB_PATH)>/.cache` | Disk cache for the Wikibooks dataset download |

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
build.rs                  # emits cargo:rerun-if-changed for everything
                          # under static/ so rust-embed picks up SPA
                          # edits without manual cache invalidation.
src/
├── main.rs               # axum server, AppState, graceful shutdown,
│                         # /uploads/* file serving
├── frontend.rs           # rust-embed + per-request HTML shell generator
├── config.rs             # ServerConfig (uploads dir, AI key, image semaphore,
│                         # overrides path, cache dir, recipe-api key)
├── db.rs                 # rusqlite pool, schema apply, ID + timestamp helpers
├── error.rs              # AppError stub for future contextual errors
├── models.rs             # rusqlite Row → struct conversions per table
├── image.rs              # sync variant pipeline + friendly-slug copy
├── scrape.rs             # JSON-LD + microdata + heuristic extractors
├── ingredient_parse.rs   # qty + unit parser (mirrors parseIngredientLine)
├── iso_duration.rs       # PT30M → 30 minutes
├── anthropic.rs          # Messages API client + prompt builder
├── routes/
│   ├── upload.rs         # POST /upload — multipart + variant kickoff
│   ├── fetch_recipe.rs   # POST /fetch-recipe — fetch + extract + cookware
│   ├── settings.rs       # /api/settings-read, /api/settings-write,
│   │                     # /api/recipe-api-key (shared auth helper)
│   ├── plu.rs            # /api/plu — IFPS lookup (embedded JSON)
│   ├── lookup_barcode.rs # /api/lookup-barcode — Open Food Facts proxy
│   │                     # + ProductMeta allowlist
│   ├── recipe_ics.rs     # /api/recipe-ics — RFC 5545 calendar export
│   └── wikibooks.rs      # /api/wikibooks — HF dataset proxy + cache
└── graphql/
    ├── mod.rs            # MergedObject roots
    ├── sql_helpers.rs    # kitchen lookup, slug uniqueness, sub-recipe linking
    ├── kitchen.rs        # Kitchen type + queries + mutations
    ├── ingredient.rs     # Ingredient type + queries + mutations
    ├── recipe.rs         # Recipe + RecipeIngredient + queries + mutations
    ├── cookware.rs       # Cookware type + queries + mutations
    └── menu.rs           # Menu + MenuRecipe + queries + mutations
static/                   # gitignored except for .gitkeep — populated by
                          # scripts/sync-frontend.sh and baked in at compile
├── client/               # rex build output (JS + CSS + manifest.json)
└── public/               # subset of packages/app/public (favicon, sw.js, …)
```
