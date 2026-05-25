//! Shared resolver helpers — kitchen id lookup, slug generation, sub-recipe
//! linking. Each helper takes a `&mut Connection` so callers can do all of
//! their work inside a single `db::with_conn` closure.

use rusqlite::{params, Connection};

/// Resolve a kitchen slug (or `None` → "home") to its primary-key id.
pub fn resolve_kitchen_id(conn: &Connection, slug: Option<&str>) -> rusqlite::Result<String> {
    let s = slug.unwrap_or("home");
    let mut stmt = conn.prepare("SELECT id FROM kitchens WHERE slug = ?1")?;
    let row = stmt.query_row(params![s], |r| r.get::<_, String>(0));
    match row {
        Ok(id) => Ok(id),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(rusqlite::Error::QueryReturnedNoRows)
        }
        Err(e) => Err(e),
    }
}

/// Slug-ify a title the same way the TS resolver does:
/// lowercase, strip non-alphanumeric (keep `-` and space), collapse spaces to
/// `-`, collapse consecutive `-`.
pub fn to_slug(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let lower = title.to_lowercase();
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || ch == ' ' || ch == '-' {
            out.push(ch);
        }
    }
    let trimmed = out.trim();
    // Collapse runs of whitespace to single hyphens, then collapse hyphen runs.
    let mut collapsed = String::with_capacity(trimmed.len());
    let mut prev_dash = false;
    let mut in_word = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            if in_word && !prev_dash {
                collapsed.push('-');
                prev_dash = true;
            }
        } else if ch == '-' {
            if in_word && !prev_dash {
                collapsed.push('-');
                prev_dash = true;
            }
        } else {
            collapsed.push(ch);
            prev_dash = false;
            in_word = true;
        }
    }
    if collapsed.ends_with('-') {
        collapsed.pop();
    }
    collapsed
}

fn slug_taken(conn: &Connection, table: &str, slug: &str, exclude_id: Option<&str>) -> rusqlite::Result<bool> {
    let sql = if exclude_id.is_some() {
        format!("SELECT 1 FROM {table} WHERE slug = ?1 AND id != ?2 LIMIT 1")
    } else {
        format!("SELECT 1 FROM {table} WHERE slug = ?1 LIMIT 1")
    };
    let mut stmt = conn.prepare(&sql)?;
    let exists = if let Some(ex) = exclude_id {
        stmt.exists(params![slug, ex])?
    } else {
        stmt.exists(params![slug])?
    };
    Ok(exists)
}

/// Generate a unique slug by appending `-2`, `-3`, … until one is free.
pub fn unique_slug(
    conn: &Connection,
    table: &str,
    title: &str,
    exclude_id: Option<&str>,
) -> rusqlite::Result<String> {
    let base = to_slug(title);
    let mut candidate = base.clone();
    let mut suffix = 2;
    loop {
        if !slug_taken(conn, table, &candidate, exclude_id)? {
            return Ok(candidate);
        }
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
}

/// Normalize a productMeta input string into a re-serialized JSON string ready
/// to persist, or `None`. Unparseable JSON becomes `None` rather than erroring.
pub fn normalize_product_meta(input: Option<&str>) -> Option<String> {
    let s = input?;
    if s.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(s).ok()?;
    if !parsed.is_object() {
        return None;
    }
    serde_json::to_string(&parsed).ok()
}

/// JSON-stringify a string list, matching `JSON.stringify(arr ?? [])`.
pub fn json_str_list(v: Option<&[String]>) -> String {
    serde_json::to_string(v.unwrap_or(&[])).unwrap_or_else(|_| "[]".to_string())
}

/// Populate `source_recipe_id` for any ingredient whose `ingredient_name`
/// case-insensitively matches an existing recipe title (excluding the parent
/// recipe). Mirrors `autoLinkSubRecipeIngredients` in the TS resolver.
pub fn auto_link_sub_recipe_ingredients(
    conn: &Connection,
    parent_recipe_id: Option<&str>,
    ingredients: &mut [super::recipe::RecipeIngredientInput],
) -> rusqlite::Result<()> {
    use std::collections::{HashMap, HashSet};

    let mut names: HashSet<String> = HashSet::new();
    for ing in ingredients.iter() {
        if ing.source_recipe_id.is_some() {
            continue;
        }
        let trimmed = ing.ingredient_name.trim();
        if trimmed.is_empty() {
            continue;
        }
        names.insert(trimmed.to_lowercase());
    }
    if names.is_empty() {
        return Ok(());
    }
    let names_vec: Vec<String> = names.into_iter().collect();
    let placeholders = std::iter::repeat("?")
        .take(names_vec.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = if parent_recipe_id.is_some() {
        format!(
            "SELECT id, lower(title) AS t FROM recipes WHERE lower(title) IN ({placeholders}) AND id != ?{}",
            names_vec.len() + 1
        )
    } else {
        format!(
            "SELECT id, lower(title) AS t FROM recipes WHERE lower(title) IN ({placeholders})"
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let parent_owned: Option<String> = parent_recipe_id.map(|s| s.to_string());
    let mut params_vec: Vec<&dyn rusqlite::ToSql> =
        names_vec.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    if let Some(pid) = parent_owned.as_ref() {
        params_vec.push(pid as &dyn rusqlite::ToSql);
    }
    let rows = stmt.query_map(params_vec.as_slice(), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut by_title: HashMap<String, String> = HashMap::new();
    for row in rows {
        let (id, t) = row?;
        by_title.insert(t, id);
    }

    if by_title.is_empty() {
        return Ok(());
    }
    for ing in ingredients.iter_mut() {
        if ing.source_recipe_id.is_some() {
            continue;
        }
        let key = ing.ingredient_name.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        if let Some(id) = by_title.get(&key) {
            ing.source_recipe_id = Some(id.clone());
        }
    }
    Ok(())
}
