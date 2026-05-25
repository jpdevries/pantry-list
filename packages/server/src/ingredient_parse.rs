//! Port of `parseIngredientLine` from `packages/app/graphql-server.ts`.
//!
//! Takes a free-text recipe ingredient line ("1½ cups whole milk") and
//! splits it into `(name, quantity, unit)`. Recognizes ASCII fractions,
//! mixed numbers, decimals, integers, and the unicode vulgar-fraction
//! characters. The unit map is the same 40-entry table the TS version
//! ships, matched longest-first so "tablespoon" wins over "tbs".

use std::sync::LazyLock;

use regex::Regex;

/// Canonical pair list. Same set as the TS `UNIT_MAP`. Order doesn't matter
/// here; the matcher sorts longest-first internally before walking.
const UNIT_MAP: &[(&str, &str)] = &[
    ("tablespoon", "tbsp"), ("tablespoons", "tbsp"), ("tbsp", "tbsp"), ("tbs", "tbsp"),
    ("teaspoon", "tsp"), ("teaspoons", "tsp"), ("tsp", "tsp"),
    ("cup", "cup"), ("cups", "cup"),
    ("fl oz", "fl oz"), ("fluid ounce", "fl oz"), ("fluid ounces", "fl oz"),
    ("pint", "pt"), ("pints", "pt"), ("pt", "pt"),
    ("quart", "qt"), ("quarts", "qt"), ("qt", "qt"),
    ("gallon", "gal"), ("gallons", "gal"), ("gal", "gal"),
    ("milliliter", "ml"), ("milliliters", "ml"), ("ml", "ml"),
    ("liter", "l"), ("liters", "l"),
    ("ounce", "oz"), ("ounces", "oz"), ("oz", "oz"),
    ("pound", "lb"), ("pounds", "lb"), ("lbs", "lb"), ("lb", "lb"),
    ("gram", "g"), ("grams", "g"),
    ("kilogram", "kg"), ("kilograms", "kg"), ("kg", "kg"),
    ("slice", "slice"), ("slices", "slice"),
    ("clove", "clove"), ("cloves", "clove"),
    ("stalk", "stalk"), ("stalks", "stalk"), ("sprig", "stalk"), ("sprigs", "stalk"),
    ("bunch", "bunch"), ("bunches", "bunch"),
    ("can", "can"), ("cans", "can"),
    ("jar", "jar"), ("jars", "jar"),
    ("head", "head"), ("heads", "head"),
    ("dozen", "dozen"),
    ("pinch", "pinch"), ("pinches", "pinch"),
    ("dash", "dash"), ("dashes", "dash"),
];

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedIngredient {
    pub ingredient_name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
}

pub fn parse_ingredient_line(line: &str) -> ParsedIngredient {
    let trimmed = line.trim();
    let (quantity, after_qty) = parse_quantity(trimmed);
    let (unit, after_unit) = if quantity.is_some() {
        match_unit(after_qty)
    } else {
        (None, after_qty)
    };
    let ingredient_name = if quantity.is_some() {
        after_unit.trim().to_string()
    } else {
        trimmed.to_string()
    };
    ParsedIngredient {
        ingredient_name,
        quantity,
        unit,
    }
}

fn unicode_fraction(c: char) -> Option<f64> {
    match c {
        '½' => Some(0.5),
        '¼' => Some(0.25),
        '¾' => Some(0.75),
        '⅓' => Some(1.0 / 3.0),
        '⅔' => Some(2.0 / 3.0),
        '⅕' => Some(0.2),
        '⅖' => Some(0.4),
        '⅗' => Some(0.6),
        '⅘' => Some(0.8),
        '⅙' => Some(1.0 / 6.0),
        '⅚' => Some(5.0 / 6.0),
        '⅛' => Some(0.125),
        '⅜' => Some(0.375),
        '⅝' => Some(0.625),
        '⅞' => Some(0.875),
        _ => None,
    }
}

/// Pull a leading quantity off `s` if present and return it + the remaining
/// slice (whitespace-trimmed start). Recognizes:
///   - Unicode-fraction prefix: "½ ", "1½ ", "1 ½ "
///   - ASCII mixed:             "1 1/2 "
///   - ASCII fraction:          "1/2 "
///   - Decimal / integer:       "1.5 ", "3 "
fn parse_quantity(s: &str) -> (Option<f64>, &str) {
    if let Some((qty, rest)) = parse_unicode_quantity(s) {
        return (Some(qty), rest);
    }
    static ASCII_QTY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(\d+\s+\d+/\d+|\d+/\d+|\d*\.?\d+)\s+").unwrap()
    });
    if let Some(m) = ASCII_QTY.captures(s) {
        let raw = m.get(1).unwrap().as_str();
        if let Some(qty) = parse_ascii_quantity(raw) {
            let end = m.get(0).unwrap().end();
            return (Some(qty), &s[end..]);
        }
    }
    (None, s)
}

fn parse_unicode_quantity(s: &str) -> Option<(f64, &str)> {
    // [whole] [whitespace] frac [whitespace]
    let mut iter = s.char_indices().peekable();
    let mut whole_str = String::new();
    while let Some(&(_, c)) = iter.peek() {
        if c.is_ascii_digit() {
            whole_str.push(c);
            iter.next();
        } else {
            break;
        }
    }
    // optional whitespace between whole and fraction
    while let Some(&(_, c)) = iter.peek() {
        if c.is_whitespace() {
            iter.next();
        } else {
            break;
        }
    }
    let (frac_idx, frac_char) = iter.peek().copied()?;
    let frac = unicode_fraction(frac_char)?;
    iter.next();
    // require whitespace after the fraction char
    let (after_idx, after_char) = iter.peek().copied()?;
    if !after_char.is_whitespace() {
        return None;
    }
    let _ = (frac_idx, after_idx);
    let whole: f64 = if whole_str.is_empty() {
        0.0
    } else {
        whole_str.parse().ok()?
    };
    let rest_start = after_idx;
    let rest = s[rest_start..].trim_start();
    Some((whole + frac, rest))
}

fn parse_ascii_quantity(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.contains('/') {
        let has_space = raw.chars().any(char::is_whitespace);
        if has_space {
            let mut parts = raw.split_whitespace();
            let whole: f64 = parts.next()?.parse().ok()?;
            let frac = parts.next()?;
            let mut sf = frac.split('/');
            let n: f64 = sf.next()?.parse().ok()?;
            let d: f64 = sf.next()?.parse().ok()?;
            if d == 0.0 {
                return None;
            }
            Some(whole + n / d)
        } else {
            let mut sf = raw.split('/');
            let n: f64 = sf.next()?.parse().ok()?;
            let d: f64 = sf.next()?.parse().ok()?;
            if d == 0.0 {
                return None;
            }
            Some(n / d)
        }
    } else {
        raw.parse().ok()
    }
}

/// Match a unit prefix on `s` (case-insensitive). Returns the canonical form
/// + the remaining slice (whitespace-trimmed start). The TS version replaces
/// internal spaces with `\s+` and uses a `(?=\s|$)` lookahead; we use `\b`
/// since every unit key ends in a word character.
fn match_unit(s: &str) -> (Option<String>, &str) {
    static UNIT_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        let mut pairs: Vec<&(&str, &str)> = UNIT_MAP.iter().collect();
        pairs.sort_by_key(|&&(k, _)| std::cmp::Reverse(k.len()));
        pairs
            .into_iter()
            .map(|&(key, canonical)| {
                let escaped = regex::escape(key);
                let pat_body = escaped.replace(' ', r"\s+");
                let pat = format!(r"(?i)^{pat_body}\b");
                (Regex::new(&pat).unwrap(), canonical)
            })
            .collect()
    });
    for (re, canonical) in UNIT_PATTERNS.iter() {
        if let Some(m) = re.find(s) {
            let rest = s[m.end()..].trim_start();
            return (Some((*canonical).to_string()), rest);
        }
    }
    (None, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_quantity_and_unit() {
        let p = parse_ingredient_line("1 cup flour");
        assert_eq!(p.quantity, Some(1.0));
        assert_eq!(p.unit.as_deref(), Some("cup"));
        assert_eq!(p.ingredient_name, "flour");
    }

    #[test]
    fn ascii_fraction() {
        let p = parse_ingredient_line("1/2 cup sugar");
        assert_eq!(p.quantity, Some(0.5));
        assert_eq!(p.unit.as_deref(), Some("cup"));
        assert_eq!(p.ingredient_name, "sugar");
    }

    #[test]
    fn ascii_mixed_number() {
        let p = parse_ingredient_line("1 1/2 cups water");
        assert_eq!(p.quantity, Some(1.5));
        assert_eq!(p.unit.as_deref(), Some("cup"));
        assert_eq!(p.ingredient_name, "water");
    }

    #[test]
    fn decimal_quantity() {
        let p = parse_ingredient_line("1.5 tablespoons sugar");
        assert_eq!(p.quantity, Some(1.5));
        assert_eq!(p.unit.as_deref(), Some("tbsp"));
        assert_eq!(p.ingredient_name, "sugar");
    }

    #[test]
    fn unicode_fraction_alone() {
        let p = parse_ingredient_line("½ cup milk");
        assert_eq!(p.quantity, Some(0.5));
        assert_eq!(p.unit.as_deref(), Some("cup"));
        assert_eq!(p.ingredient_name, "milk");
    }

    #[test]
    fn unicode_fraction_with_whole() {
        let p = parse_ingredient_line("1½ cups oats");
        assert_eq!(p.quantity, Some(1.5));
        assert_eq!(p.unit.as_deref(), Some("cup"));
        assert_eq!(p.ingredient_name, "oats");
    }

    #[test]
    fn longest_unit_wins() {
        // "tablespoon" must beat "tbs"
        let p = parse_ingredient_line("3 tablespoons vanilla");
        assert_eq!(p.unit.as_deref(), Some("tbsp"));
        assert_eq!(p.ingredient_name, "vanilla");
    }

    #[test]
    fn multi_word_unit() {
        let p = parse_ingredient_line("2 fl oz syrup");
        assert_eq!(p.quantity, Some(2.0));
        assert_eq!(p.unit.as_deref(), Some("fl oz"));
        assert_eq!(p.ingredient_name, "syrup");
    }

    #[test]
    fn no_quantity_returns_full_line() {
        let p = parse_ingredient_line("salt to taste");
        assert_eq!(p.quantity, None);
        assert_eq!(p.unit, None);
        assert_eq!(p.ingredient_name, "salt to taste");
    }

    #[test]
    fn quantity_without_recognized_unit() {
        let p = parse_ingredient_line("1 large egg");
        assert_eq!(p.quantity, Some(1.0));
        assert_eq!(p.unit, None);
        assert_eq!(p.ingredient_name, "large egg");
    }

    #[test]
    fn trims_input_line() {
        let p = parse_ingredient_line("  2 cups flour  ");
        assert_eq!(p.quantity, Some(2.0));
        assert_eq!(p.unit.as_deref(), Some("cup"));
        assert_eq!(p.ingredient_name, "flour");
    }
}
