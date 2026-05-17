-- Canonical SQLite schema for pantry-host.
--
-- Single source of truth. Loaded by:
--   - packages/app/lib/db.ts                 (Node, node:sqlite, via shared/sql/schema.ts)
--   - packages/web/lib/db.ts                 (browser, @sqlite.org/sqlite-wasm, via shared/sql/schema.ts)
--   - packages/server/src/db.rs              (Rust, rusqlite, include_str!)
--
-- Conventions:
--   - IDs are TEXT (UUIDs); callers supply `crypto.randomUUID()` on insert.
--   - Timestamps are TEXT (ISO 8601), defaulted with strftime(...,'now').
--   - Tag/alias/photo array columns are TEXT containing JSON (default '[]').
--   - product_meta is TEXT containing JSON.
--   - Booleans are INTEGER 0/1.
--   - Decimals are REAL.
--
-- Every statement is wrapped in `IF NOT EXISTS` so it's idempotent on existing
-- databases.

CREATE TABLE IF NOT EXISTS kitchens (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO kitchens (id, slug, name) VALUES (lower(hex(randomblob(16))), 'home', 'Home');

CREATE TABLE IF NOT EXISTS ingredients (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT,
  quantity       REAL,
  unit           TEXT,
  item_size      REAL,
  item_size_unit TEXT,
  always_on_hand INTEGER NOT NULL DEFAULT 0,
  tags           TEXT NOT NULL DEFAULT '[]',
  aliases        TEXT,
  barcode        TEXT,
  product_meta   TEXT,
  kitchen_id     TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ingredients_kitchen ON ingredients(kitchen_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_name    ON ingredients(name);
CREATE INDEX IF NOT EXISTS idx_ingredients_barcode ON ingredients(barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS recipes (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  slug              TEXT,
  description       TEXT,
  instructions      TEXT NOT NULL,
  servings          INTEGER DEFAULT 2,
  prep_time         INTEGER,
  cook_time         INTEGER,
  tags              TEXT NOT NULL DEFAULT '[]',
  step_photos       TEXT NOT NULL DEFAULT '[]',
  source            TEXT DEFAULT 'manual',
  source_url        TEXT,
  photo_url         TEXT,
  last_made_at      TEXT,
  queued            INTEGER NOT NULL DEFAULT 0,
  kitchen_id        TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_recipes_kitchen ON recipes(kitchen_id);
CREATE INDEX IF NOT EXISTS idx_recipes_slug    ON recipes(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS cookware (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  brand       TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  notes       TEXT,
  kitchen_id  TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cookware_kitchen ON cookware(kitchen_id);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id               TEXT PRIMARY KEY,
  recipe_id        TEXT REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_name  TEXT NOT NULL,
  quantity         REAL,
  unit             TEXT,
  item_size        REAL,
  item_size_unit   TEXT,
  source_recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  sort_order       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);

CREATE TABLE IF NOT EXISTS recipe_cookware (
  recipe_id   TEXT NOT NULL REFERENCES recipes(id)  ON DELETE CASCADE,
  cookware_id TEXT NOT NULL REFERENCES cookware(id) ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, cookware_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_cookware_recipe   ON recipe_cookware(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_cookware_cookware ON recipe_cookware(cookware_id);

CREATE TABLE IF NOT EXISTS menus (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  slug        TEXT UNIQUE,
  description TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  category    TEXT,
  source_url  TEXT,
  kitchen_id  TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_menus_kitchen ON menus(kitchen_id);

CREATE TABLE IF NOT EXISTS menu_recipes (
  id         TEXT PRIMARY KEY,
  menu_id    TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  course     TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_menu_recipes_menu ON menu_recipes(menu_id);
