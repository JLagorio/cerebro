//! Quote-anchored body edits (M55.5): the resolver under `edit_note`.
//!
//! An edit names the passage it replaces by quoting its raw saved body. A
//! large sheet summary in get_note is not in that body; quotes of it refuse.
//! Other passages are quoted exactly as get_note
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
//! cases pin lines and code-point contexts, never offsets.
//!
//! `comment_tools.rs` (M70.3) is the second caller: an agent's comment quote
//! is found by the same finder and listed in the same lines, and
//! `comment_matches` only filters what it finds down to the page's own text
//! (`src-tauri/fixtures/comment-tools.json` holds that filter).

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
    let found = occurrences_of(body, &edit.old);
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
/// the search goes on one code point later, so `aa` is in `aaa` twice. The
/// one matcher (`occurrencesOf` in the twin). An empty quote is in no body:
/// it would match everywhere.
pub fn occurrences_of(body: &str, quote: &str) -> Vec<usize> {
    let mut found = Vec::new();
    if quote.is_empty() {
        return found;
    }
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
pub(crate) fn listed(head: String, body: &str, quote: &str, found: &[usize]) -> Vec<String> {
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
pub(crate) fn line_at(text: &str, offset: usize) -> usize {
    1 + text[..offset].matches('\n').count()
}

/// The body around the match `start..end`, counted in code points: up to
/// `CONTEXT_CHARS` before it, at most `MATCH_CHARS` of it, and up to
/// `CONTEXT_CHARS` after that, with an ellipsis at each end that was cut,
/// JSON-escaped so a line break or a tab reads as one.
pub(crate) fn context(body: &str, start: usize, end: usize) -> String {
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

// --- Comment quotes (M70.3) ----------------------------------------------------
//
// An agent anchors a comment by quoting plain words as get_note prints the
// body, and a person anchors one by selecting what the page reads (M70.1's
// reader text). The two agree when the quote holds no markdown and every
// match counted lies in text the page shows, so a quote with markdown is
// refused and the finder's matches are filtered to the page's own text: not
// inside a fence, not on a `:::` line (a toggle's title excepted), not in a
// line's marker, a link's target, an image or a chip (a wikilink, an
// assignee, a footnote or a date, which the editor draws as one atom).

/// The characters a comment quote may not hold, because the page does not
/// show them as typed; a context stops at one as well.
const QUOTE_MARKDOWN: [char; 10] = ['*', '_', '`', '~', '[', ']', '<', '>', '\\', '|'];

/// The markdown a comment quote holds, named for its refusal, or `None`.
pub fn quote_markdown(quote: &str) -> Option<String> {
    quote.chars().find_map(|c| match c {
        '\n' | '\r' => Some("a line break".to_string()),
        '`' => Some("a backtick".to_string()),
        c if QUOTE_MARKDOWN.contains(&c) => Some(format!("`{c}`")),
        _ => None,
    })
}

/// The byte length of the run of `c` that opens `text`.
fn run_of(text: &str, c: char) -> usize {
    text.len() - text.trim_start_matches(c).len()
}

/// How many bytes of spaces and tabs open `text`.
fn blank_run(text: &str) -> usize {
    text.len() - text.trim_start_matches([' ', '\t']).len()
}

/// The bytes of `line` a block marker takes before its text: blockquote
/// `>`s, then a heading's `#`s, or a bullet or number and a task box.
fn marker_len(line: &str) -> usize {
    let mut at = blank_run(line);
    while line[at..].starts_with('>') {
        at += 1;
        at += blank_run(&line[at..]);
    }
    let rest = &line[at..];
    let spaced =
        |n: usize| rest.len() == n || rest[n..].starts_with(' ') || rest[n..].starts_with('\t');
    let hashes = run_of(rest, '#');
    if (1..=6).contains(&hashes) && spaced(hashes) {
        return at + hashes + blank_run(&rest[hashes..]);
    }
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let item = if rest.starts_with(['-', '*', '+']) && spaced(1) {
        1
    } else if (1..=9).contains(&digits)
        && rest[digits..].starts_with(['.', ')'])
        && spaced(digits + 1)
    {
        digits + 1
    } else {
        return at;
    };
    at += item + blank_run(&rest[item..]);
    for task in ["[ ]", "[x]", "[X]"] {
        let after = &line[at..];
        if after.starts_with(task) && (after.len() == 3 || after[3..].starts_with([' ', '\t'])) {
            return at + 3 + blank_run(&after[3..]);
        }
    }
    at
}

/// Whether `c` is a space as a JavaScript `\s` reads one, the class the
/// editor's date token grammar (`src/engine/dates.ts`) is written in.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// The byte length of the run of chars `keep` takes that opens `text`.
fn run_while(text: &str, keep: impl Fn(char) -> bool) -> usize {
    text.len() - text.trim_start_matches(keep).len()
}

/// The bytes `text` opens with when they read `\d{n}` then `sep` then
/// `\d{n}`, repeated for each `(sep, n)` after the first count.
fn digit_groups(text: &str, first: usize, rest: &[(char, usize)]) -> Option<usize> {
    let digits = |at: usize, n: usize| {
        (text.len() >= at + n && text.as_bytes()[at..at + n].iter().all(u8::is_ascii_digit))
            .then_some(at + n)
    };
    let mut at = digits(0, first)?;
    for &(sep, n) in rest {
        at = digits(at + text[at..].strip_prefix(sep).map(|_| 1)?, n)?;
    }
    Some(at)
}

/// A date then an optional time (`\d{4}-\d{2}-\d{2}(?:\s\d{2}:\d{2})?`).
fn dated(text: &str) -> Option<usize> {
    let at = digit_groups(text, 4, &[('-', 2), ('-', 2)])?;
    let time = text[at..]
        .chars()
        .next()
        .filter(|&c| js_space(c))
        .and_then(|c| {
            digit_groups(&text[at + c.len_utf8()..], 2, &[(':', 2)]).map(|n| n + c.len_utf8())
        });
    Some(at + time.unwrap_or(0))
}

/// The length of the date token `text` opens with, as `DATE_TOKEN_SOURCE`
/// reads one: the calendar, a date and time, an arrow and an end, and flags.
fn date_token_len(text: &str) -> Option<usize> {
    let mut at = text
        .strip_prefix('\u{1f4c5}')
        .map(|_| '\u{1f4c5}'.len_utf8())?;
    at += run_while(&text[at..], js_space);
    at += dated(&text[at..])?;
    let end = (|| {
        let mut to = at + run_while(&text[at..], js_space);
        to += text[to..]
            .strip_prefix('\u{2192}')
            .map(|_| '\u{2192}'.len_utf8())?;
        to += run_while(&text[to..], js_space);
        Some(to + dated(&text[to..])?)
    })();
    at = end.unwrap_or(at);
    let flags = (|| {
        let mut to = at + run_while(&text[at..], js_space);
        to += text[to..].strip_prefix("((").map(|_| 2)?;
        let n = run_while(&text[to..], |c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '|' || c == ':'
        });
        (n > 0 && text[to + n..].starts_with("))")).then_some(to + n + 2)
    })();
    Some(flags.unwrap_or(at))
}

/// The length of the chip `text` opens with, as `src/editor/markdown.ts`'s
/// CHIP_PATTERN finds one: `@[[target|alias]]`, `[[target|alias]]`, `[^id]`
/// or a date token. The editor draws each as one atom, and M70.1 counts no
/// match inside an atom.
fn chip_len(text: &str) -> Option<usize> {
    let link = |s: &str| {
        let rest = s.strip_prefix("[[")?;
        let target = run_while(rest, |c| !matches!(c, '[' | ']' | '|'));
        if target == 0 {
            return None;
        }
        let mut at = 2 + target;
        if s[at..].starts_with('|') {
            at += 1 + run_while(&s[at + 1..], |c| !matches!(c, '[' | ']'));
        }
        s[at..].starts_with("]]").then_some(at + 2)
    };
    if let Some(n) = text.strip_prefix('@').and_then(link) {
        return Some(n + 1);
    }
    if let Some(n) = link(text) {
        return Some(n);
    }
    if let Some(rest) = text.strip_prefix("[^") {
        let id = run_while(rest, |c| c != ']' && !js_space(c));
        if id > 0 && rest[id..].starts_with(']') {
            return Some(2 + id + 1);
        }
    }
    date_token_len(text)
}

/// The length of the image `text` opens with (`![alt](target)`): the page
/// draws its picture, and neither its alt text nor its target is text.
fn image_len(text: &str) -> Option<usize> {
    let rest = text.strip_prefix("![")?;
    let alt = run_while(rest, |c| c != ']');
    let rest = rest[alt..].strip_prefix("](")?;
    let target = run_while(rest, |c| c != ')');
    rest[target..]
        .starts_with(')')
        .then_some(2 + alt + 2 + target + 1)
}

/// `from..to` of `body` less what the page does not show as text there: every
/// link target (`](` to its `)`), every image and every chip.
fn page_text_in(body: &str, from: usize, to: usize, out: &mut Vec<(usize, usize)>) {
    let mut kept = from;
    let mut at = from;
    while at < to {
        let rest = &body[at..to];
        let cut = if rest.starts_with("](") {
            // A link's text keeps its `]`; its target goes.
            let open = at + 1;
            Some((
                open,
                body[open..to]
                    .find(')')
                    .map_or(to, |close| open + close + 1),
            ))
        } else if rest.starts_with(['!', '@', '[', '\u{1f4c5}']) {
            image_len(rest)
                .or_else(|| chip_len(rest))
                .map(|n| (at, at + n))
        } else {
            None
        };
        match cut {
            Some((start, end)) => {
                if start > kept {
                    out.push((kept, start));
                }
                kept = end;
                at = end;
            }
            None => at += rest.chars().next().map_or(1, char::len_utf8),
        }
    }
    if kept < to {
        out.push((kept, to));
    }
}

/// The byte ranges of `body` the page shows as text, in order: each line's
/// own text, less its marker, its link targets, its images and its chips,
/// outside every fence and every `:::` line but a toggle's title. A line's
/// `\r` is never text.
fn text_ranges(body: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    // The open fence: its character and how long its run was.
    let mut fence: Option<(char, usize)> = None;
    let mut start = 0;
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let (from, end) = (start, start + line.len());
        start += raw.len() + 1;
        let indent = run_of(line, ' ');
        let fenced = &line[indent..];
        if let Some((c, n)) = fence {
            let closing = run_of(fenced, c);
            if indent <= 3 && closing >= n && fenced[closing..].trim_matches([' ', '\t']).is_empty()
            {
                fence = None;
            }
            continue;
        }
        if indent <= 3 {
            if let Some(c) = ['`', '~'].into_iter().find(|c| run_of(fenced, *c) >= 3) {
                fence = Some((c, run_of(fenced, c)));
                continue;
            }
        }
        let lead = blank_run(line);
        let directive = &line[lead..];
        if directive.starts_with(":::") {
            let colons = run_of(directive, ':');
            if let Some(title) = directive[colons..].strip_prefix("toggle ") {
                page_text_in(body, end - title.len(), end, &mut out);
            }
            continue;
        }
        page_text_in(body, from + marker_len(line), end, &mut out);
    }
    out
}

/// The range of `ranges` holding all of `start..end`, if one does.
fn range_holding(ranges: &[(usize, usize)], start: usize, end: usize) -> Option<(usize, usize)> {
    ranges
        .iter()
        .copied()
        .find(|&(from, to)| from <= start && end <= to)
}

/// Every start of `quote` in `body` that reads as text on the page: the
/// finder's matches (`occurrences_of`), kept when one text range holds the
/// whole match. A comment's occurrence counts among these.
pub fn comment_matches(body: &str, quote: &str) -> Vec<usize> {
    let ranges = text_ranges(body);
    occurrences_of(body, quote)
        .into_iter()
        .filter(|&start| range_holding(&ranges, start, start + quote.len()).is_some())
        .collect()
}

/// The context a comment's anchor stores for the match `start..end`, from its
/// own line: the text before it back to the last markdown character or the
/// start of its text, and after it up to the next, each cut to
/// `CONTEXT_CHARS` code points nearest the match. `start..end` is one of
/// `comment_matches`'.
pub fn anchor_context(body: &str, start: usize, end: usize) -> (String, String) {
    let (from, to) = range_holding(&text_ranges(body), start, end).unwrap_or((start, end));
    let before = &body[from..start];
    let before = before
        .rfind(QUOTE_MARKDOWN)
        .map_or(before, |at| &before[at + 1..]);
    let after = &body[end..to];
    let after = after.find(QUOTE_MARKDOWN).map_or(after, |at| &after[..at]);
    let skip = before.chars().count().saturating_sub(CONTEXT_CHARS);
    (
        before.chars().skip(skip).collect(),
        after.chars().take(CONTEXT_CHARS).collect(),
    )
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
