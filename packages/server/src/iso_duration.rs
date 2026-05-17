//! Port of `parseDuration` from `packages/app/graphql-server.ts`.
//!
//! Schema.org recipe markup expresses prep/cook times as ISO 8601 durations
//! ("PT30M", "PT1H15M"). We only ever care about hours + minutes — seconds
//! and the date components are ignored, matching the TS behavior.

use std::sync::LazyLock;

use regex::Regex;

static DURATION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"PT(?:(\d+)H)?(?:(\d+)M)?").unwrap());

/// Parse an ISO-8601 duration like `PT1H30M` into total minutes.
/// Returns `None` if the string doesn't contain a `PT…` token at all.
/// `PT` with no H/M groups returns `Some(0)` to match the TS implementation,
/// which evaluates `parseInt(undefined ?? '0', 10) * 60 + 0`.
pub fn parse_duration(iso: &str) -> Option<u32> {
    let m = DURATION_RE.captures(iso)?;
    let hours: u32 = m
        .get(1)
        .and_then(|g| g.as_str().parse().ok())
        .unwrap_or(0);
    let mins: u32 = m
        .get(2)
        .and_then(|g| g.as_str().parse().ok())
        .unwrap_or(0);
    Some(hours * 60 + mins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_only() {
        assert_eq!(parse_duration("PT30M"), Some(30));
    }

    #[test]
    fn hours_only() {
        assert_eq!(parse_duration("PT1H"), Some(60));
    }

    #[test]
    fn hours_and_minutes() {
        assert_eq!(parse_duration("PT1H30M"), Some(90));
        assert_eq!(parse_duration("PT2H15M"), Some(135));
    }

    #[test]
    fn pt_alone_is_zero_matching_ts() {
        // TS: `PT`.match(re) returns ["PT", undefined, undefined] → 0 * 60 + 0
        assert_eq!(parse_duration("PT"), Some(0));
    }

    #[test]
    fn no_pt_token_returns_none() {
        assert_eq!(parse_duration("30 minutes"), None);
        assert_eq!(parse_duration(""), None);
    }
}
