//! Quote-anchored body edits (M55.5): the resolver under `edit_note`.
//!
//! An edit names the passage it replaces by quoting it, exactly as get_note
//! prints the note's body: raw markdown, no trimming, no case or Unicode
//! normalizing. A quote that matches nowhere, or more than once without an
//! `occurrence`, is refused with every appearance listed, rather than guessed
//! at. Every edit is matched against the body as it is now, and they land in
//! one splice or not at all.
//!
//! Pure: no I/O and no clock. `vault::write::edit_note` reads and writes under
//! the note's path lock; this only plans. Its TS twin is `src/engine/quote.ts`,
//! and both replay `src-tauri/fixtures/quote-cases.json`, which pins every
//! message byte for byte (D3: twins held by a shared case file, the `link.rs`
//! precedent). Offsets here are bytes and the twin's are UTF-16 units, so the
//! cases pin lines and code-point contexts, never offsets. M70's comment
//! anchors are the next caller.

/// The most edits one call may carry.
pub const MAX_EDITS: usize = 100;
/// Code points of context shown on each side of a listed match.
pub const CONTEXT_CHARS: usize = 40;
/// Code points of a listed match shown before the context after it.
pub const MATCH_CHARS: usize = 80;
/// Matches listed under a refused edit before the rest are counted.
pub const MAX_LISTED: usize = 20;

/// One replacement: the passage quoted in `old`, the markdown in `new`, and
/// which appearance of `old` is meant (counting from 1) when there are several.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteEdit {
    pub old: String,
    pub new: String,
    pub occurrence: Option<usize>,
}

/// The body every edit lands in, and the 1-based line where each edit's new
/// text starts in it, in the order the edits were given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub text: String,
    pub lines: Vec<usize>,
}

const NOTHING_WRITTEN: &str = "Nothing was written.";

/// Plan `edits` against `body`, the note body as `vault::write::read_note`
/// returns it. `prefix` is every byte before it (BOM, fences and YAML): it is
/// never matched or changed, and is asked only to say that a quote missing
/// from the body sits in the frontmatter. A refusal lists every failing edit,
/// one message per line, and ends with "Nothing was written.".
pub fn plan_edits(body: &str, prefix: &str, edits: &[QuoteEdit]) -> Result<Planned, String> {
    if edits.is_empty() {
        return Err(refusal(vec![
            "edit_note needs at least one edit.".to_string()
        ]));
    }
    if edits.len() > MAX_EDITS {
        return Err(refusal(vec![format!(
            "edit_note takes at most {MAX_EDITS} edits in one call; this call has {}.",
            edits.len()
        )]));
    }
    let mut failures = Vec::new();
    let mut spans = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        match resolve(body, prefix, index + 1, edit) {
            Ok(start) => spans.push((start, start + edit.old.len())),
            Err(lines) => failures.extend(lines),
        }
    }
    if !failures.is_empty() {
        return Err(refusal(failures));
    }
    for i in 0..spans.len() {
        for j in i + 1..spans.len() {
            let start = spans[i].0.max(spans[j].0);
            if start < spans[i].1.min(spans[j].1) {
                failures.push(format!(
                    "Edits {} and {} overlap at line {}; each edit must replace a passage of \
                     its own.",
                    i + 1,
                    j + 1,
                    line_at(body, start)
                ));
            }
        }
    }
    if !failures.is_empty() {
        return Err(refusal(failures));
    }
    let mut order: Vec<usize> = (0..spans.len()).collect();
    order.sort_by_key(|&i| spans[i].0);
    let mut text = String::with_capacity(body.len());
    let mut lines = vec![0; edits.len()];
    let mut at = 0;
    for i in order {
        text.push_str(&body[at..spans[i].0]);
        lines[i] = line_at(&text, text.len());
        text.push_str(&edits[i].new);
        at = spans[i].1;
    }
    text.push_str(&body[at..]);
    Ok(Planned { text, lines })
}

/// Where edit `i` lands in `body`, or the lines that say why it cannot.
fn resolve(body: &str, prefix: &str, i: usize, edit: &QuoteEdit) -> Result<usize, Vec<String>> {
    if edit.old.is_empty() {
        return Err(vec![format!(
            "Edit {i}: `old` is empty \u{2014} quote the text to replace."
        )]);
    }
    if edit.new == edit.old {
        return Err(vec![format!(
            "Edit {i}: `new` is the same as `old`, so it changes nothing."
        )]);
    }
    if edit.occurrence == Some(0) {
        return Err(vec![format!("Edit {i}: `occurrence` counts from 1.")]);
    }
    let found = matches(body, &edit.old);
    match (found.len(), edit.occurrence) {
        (0, _) if prefix.contains(edit.old.as_str()) => Err(vec![format!(
            "Edit {i}: the quoted text is in the frontmatter, which edit_note never changes. \
             Use update_frontmatter for properties."
        )]),
        (0, _) => Err(vec![format!(
            "Edit {i}: the quoted text is not in the note's body. Quote it exactly as get_note \
             shows it, spacing, line breaks and markdown included, or read the note again if it \
             may have changed."
        )]),
        (1, None) => Ok(found[0]),
        (n, None) => Err(listed(
            format!(
                "Edit {i}: the quoted text appears {n} times. Pass `occurrence` (counting from \
                 1) or quote a longer passage:"
            ),
            body,
            &edit.old,
            &found,
        )),
        (n, Some(k)) if k > n => Err(listed(
            format!(
                "Edit {i}: `occurrence` is {k}, but the quoted text appears {n} {}:",
                if n == 1 { "time" } else { "times" }
            ),
            body,
            &edit.old,
            &found,
        )),
        (_, Some(k)) => Ok(found[k - 1]),
    }
}

/// Every start of `quote` in `body`, overlapping ones included: after a match
/// the search goes on one code point later, so `aa` is in `aaa` twice.
fn matches(body: &str, quote: &str) -> Vec<usize> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = body[from..].find(quote) {
        let start = from + offset;
        found.push(start);
        let step = body[start..].chars().next().map_or(1, char::len_utf8);
        from = start + step;
    }
    found
}

/// `head`, then one line per match (at most `MAX_LISTED`), then the count of
/// the rest.
fn listed(head: String, body: &str, quote: &str, found: &[usize]) -> Vec<String> {
    let mut lines = vec![head];
    for (k, &start) in found.iter().enumerate().take(MAX_LISTED) {
        lines.push(format!(
            "  {}. line {}: {}",
            k + 1,
            line_at(body, start),
            context(body, start, start + quote.len())
        ));
    }
    if found.len() > MAX_LISTED {
        lines.push(format!("  \u{2026} and {} more", found.len() - MAX_LISTED));
    }
    lines
}

/// The 1-based line `offset` falls on.
fn line_at(text: &str, offset: usize) -> usize {
    1 + text[..offset].matches('\n').count()
}

/// The body around the match `start..end`, counted in code points: up to
/// `CONTEXT_CHARS` before it, at most `MATCH_CHARS` of it, and up to
/// `CONTEXT_CHARS` after that, with an ellipsis at each end that was cut,
/// JSON-escaped so a line break or a tab reads as one.
fn context(body: &str, start: usize, end: usize) -> String {
    let before = body[..start].chars().count();
    let within = body[start..end].chars().count();
    let total = before + within + body[end..].chars().count();
    let from = before.saturating_sub(CONTEXT_CHARS);
    let to = total.min(before + within.min(MATCH_CHARS) + CONTEXT_CHARS);
    let mut shown: String = body.chars().skip(from).take(to - from).collect();
    if from > 0 {
        shown.insert(0, '\u{2026}');
    }
    if to < total {
        shown.push('\u{2026}');
    }
    serde_json::to_string(&shown).unwrap_or_default()
}

fn refusal(mut lines: Vec<String>) -> String {
    lines.push(NOTHING_WRITTEN.to_string());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const QUOTE_CASES: &str = include_str!("../../fixtures/quote-cases.json");

    fn edits_of(value: &Value) -> Vec<QuoteEdit> {
        value
            .as_array()
            .expect("edits is a list")
            .iter()
            .map(|edit| QuoteEdit {
                old: edit["old"].as_str().expect("old").to_string(),
                new: edit["new"].as_str().expect("new").to_string(),
                occurrence: edit
                    .get("occurrence")
                    .and_then(Value::as_u64)
                    .map(|k| usize::try_from(k).expect("a small occurrence")),
            })
            .collect()
    }

    #[test]
    fn replays_the_shared_quote_cases() {
        let file: Value = serde_json::from_str(QUOTE_CASES).expect("quote-cases.json parses");
        let cases = file["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        for case in cases {
            let why = case["why"].as_str().expect("a why");
            let body = case["body"].as_str().expect("a body");
            let prefix = case["prefix"].as_str().unwrap_or_default();
            let outcome = plan_edits(body, prefix, &edits_of(&case["edits"]));
            match (case.get("result"), case.get("refused")) {
                (Some(result), None) => {
                    let planned = outcome.unwrap_or_else(|e| panic!("{why}: {e}"));
                    assert_eq!(planned.text, result.as_str().expect("a result"), "{why}");
                    let lines: Vec<usize> = case["lines"]
                        .as_array()
                        .expect("lines")
                        .iter()
                        .map(|l| usize::try_from(l.as_u64().expect("a line")).unwrap())
                        .collect();
                    assert_eq!(planned.lines, lines, "{why}");
                }
                (None, Some(refused)) => {
                    let message = outcome.expect_err(why);
                    assert_eq!(message, refused.as_str().expect("a message"), "{why}");
                }
                _ => panic!("{why}: a case names exactly one of `result` and `refused`"),
            }
        }
    }

    #[test]
    fn the_limits_are_the_shared_ones() {
        let file: Value = serde_json::from_str(QUOTE_CASES).expect("quote-cases.json parses");
        let limits = &file["limits"];
        for (key, value) in [
            ("max_edits", MAX_EDITS),
            ("context_chars", CONTEXT_CHARS),
            ("match_chars", MATCH_CHARS),
            ("max_listed", MAX_LISTED),
        ] {
            assert_eq!(limits[key].as_u64(), Some(value as u64), "{key}");
        }
    }

    #[test]
    fn more_edits_than_the_limit_are_refused() {
        let body = "x".repeat(MAX_EDITS + 1);
        let one = QuoteEdit {
            old: "x".into(),
            new: "y".into(),
            occurrence: Some(1),
        };
        let edits = vec![one; MAX_EDITS + 1];
        assert_eq!(
            plan_edits(&body, "", &edits).unwrap_err(),
            "edit_note takes at most 100 edits in one call; this call has 101.\nNothing was \
             written."
        );
        // At the limit, the call is judged edit by edit instead.
        assert!(plan_edits(&body, "", &edits[..MAX_EDITS])
            .unwrap_err()
            .contains("Edits 1 and 2 overlap"));
    }
}
