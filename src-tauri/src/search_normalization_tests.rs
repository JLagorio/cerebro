//! M97.8: measured cafe/café miss; actual production ranker and raw excerpts.
use super::*;
fn doc<'a>(path: &'a str, title: &'a str, body: &'a str) -> Doc<'a> {
    Doc { path, title, body, kind: None, meta: &[] }
}
#[test]
fn normalization_finds_the_reviewed_latin_accent_miss() {
    let docs = [doc("visible/accent.md", "Retrospective", "The café is ready.")];
    let result = rank("cafe", &docs, 20);
    assert_eq!(result.total, 1);
    assert_eq!(result.hits[0].matched, vec!["cafe"]);
    assert_eq!(result.hits[0].excerpt.as_ref().unwrap().text, "The café is ready.");
}
#[test]
fn normalization_keeps_original_exact_hits_before_stronger_aliases() {
    let docs = [doc("a.md", "café café café", "café café café"), doc("z.md", "Notes", "cafe")];
    let result = rank("cafe", &docs, 20);
    assert_eq!(result.total, 2);
    assert_eq!(result.hits.iter().map(|h| h.index).collect::<Vec<_>>(), vec![1, 0]);
    let reverse = rank("café", &docs, 20);
    assert_eq!(reverse.hits.iter().map(|h| h.index).collect::<Vec<_>>(), vec![0, 1]);
}
#[test]
fn normalization_keeps_original_utf8_excerpt_and_highlight_positions() {
    let body = "Unrelated line\r\n🧠 The café serves lunch.\r\n";
    let docs = [doc("accent.md", "Lunch", body)];
    let result = rank("cafe", &docs, 20);
    assert_eq!(result.total, 1);
    let excerpt = result.hits[0].excerpt.as_ref().unwrap();
    assert_eq!(excerpt.at, ExcerptAt::Line(2));
    assert_eq!(&body.lines().nth(1).unwrap()[excerpt.raw_range.clone()], "🧠 The café serves lunch.");
    assert_eq!(excerpt.ranges.iter().map(|r| &excerpt.text[r.clone()]).collect::<Vec<_>>(), vec!["café"]);
}
#[test]
fn normalization_does_not_strip_greek_or_japanese_distinctions() {
    assert_eq!(rank("か", &[doc("kana.md", "", "が")], 20).total, 0);
    assert_eq!(rank("α", &[doc("greek.md", "", "ά")], 20).total, 0);
    assert_eq!(rank("が", &[doc("kana.md", "", "が")], 20).total, 1);
}
#[test]
fn normalization_respects_original_field_scope_and_result_cap() {
    let docs = [doc("a.md", "café", "unrelated"), doc("b.md", "café", "unrelated"), doc("c.md", "café", "unrelated")];
    let query = parse_query("cafe");
    assert_eq!(rank_scoped(&query, &docs, 20, Scope::Content).total, 0);
    let result = rank_scoped(&query, &docs, 1, Scope::Name);
    assert_eq!(result.total, 3);
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].index, 0);
    assert!(result.hits[0].excerpt.is_none());
}
#[test]
fn normalization_returns_original_query_terms_for_accented_queries() {
    let result = rank("café", &[doc("ascii.md", "", "cafe")], 20);
    assert_eq!(result.total, 1);
    assert_eq!(result.hits[0].matched, vec!["café"]);
    assert_eq!(result.hits[0].excerpt.as_ref().unwrap().text, "cafe");
}

#[test]
fn normalization_reports_widening_when_only_alias_fallback_adds_a_hit() {
    let docs = [doc("exact.md", "", "cafe"), doc("alias.md", "", "résumé")];
    let result = rank("cafe resume", &docs, 20);
    assert_eq!(result.total, 2);
    assert_eq!(result.hits.iter().map(|hit| hit.index).collect::<Vec<_>>(), vec![0, 1]);
    assert!(result.widened, "the added alias is a partial fallback, not an all-term hit");
}
