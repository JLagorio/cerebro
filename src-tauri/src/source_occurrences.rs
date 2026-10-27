//! Bounded on-demand raw Markdown occurrences. The summary link index is not
//! a source-position producer.
use crate::source_location::{SourceLocator, SourceReadError, SourceScope};
use crate::vault::corpus::Corpus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OccurrenceMode {
    Linked,
    Mention,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOccurrence {
    pub id: String,
    pub location: SourceLocator,
    pub target_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_fragment: Option<String>,
    pub via: String,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OccurrenceCounts {
    pub shown_occurrences: usize,
    pub shown_pages: usize,
    pub examined_sources: usize,
    pub capped_sources: usize,
    pub unavailable_sources: usize,
    pub unsupported_sources: usize,
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OccurrencePage {
    Ready {
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
        rows: Vec<SourceOccurrence>,
        #[serde(rename = "nextCursor")]
        next_cursor: Option<String>,
        truncated: bool,
        counts: OccurrenceCounts,
    },
    ChangedSnapshot {
        reason: String,
    },
}

pub fn find_source_occurrences(
    scope: &SourceScope<'_>,
    target_path: &str,
    mode: OccurrenceMode,
    cursor: Option<&str>,
) -> Result<OccurrencePage, SourceReadError> {
    let corpus = crate::vault::corpus::shared().snapshot(scope.vault)?;
    find_in_corpus(scope, &corpus, target_path, mode, cursor)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    version: u8,
    page_rows: usize,
    examined_sources: usize,
    examined_bytes: usize,
    cursor_bytes: usize,
    mention_boundary: String,
    mention_case: String,
    mention_candidates: Vec<String>,
    exclude_wikilinks: bool,
    fragment_trim_code_points: Vec<u32>,
}
fn limits() -> &'static Limits {
    static LIMITS: std::sync::OnceLock<Limits> = std::sync::OnceLock::new();
    LIMITS.get_or_init(|| {
        let value: Limits = serde_json::from_str(include_str!(
            "../../shared/knowledge/source-occurrences.v1.json"
        ))
        .expect("source occurrence limits");
        assert_eq!(value.version, 1);
        assert!(value
            .fragment_trim_code_points
            .iter()
            .all(|point| char::from_u32(*point).is_some()));
        assert_eq!(value.mention_boundary, "unicode-letter-number-underscore");
        assert_eq!(value.mention_case, "scalar-lowercase-original-boundaries");
        assert_eq!(
            value.mention_candidates,
            ["filename", "project-folder", "item-key", "title"]
        );
        assert!(
            value.exclude_wikilinks
                && value.page_rows > 0
                && value.examined_sources > 0
                && value.examined_bytes > 0
        );
        value
    })
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    target: String,
    mode: OccurrenceMode,
    scope: String,
    snapshot: String,
    source: usize,
    row: usize,
}
fn changed() -> OccurrencePage {
    OccurrencePage::ChangedSnapshot {
        reason: "Sources or readable scope changed. Refresh to search again.".into(),
    }
}
struct Span<'a> {
    start: usize,
    end: usize,
    target: &'a str,
}
/// Production wikilink grammar, retaining each raw span instead of deduping.
fn spans(text: &str) -> Vec<Span<'_>> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(open) = text[cursor..].find("[[") {
        let start = cursor + open;
        let inner_start = start + 2;
        let Some(close) = text[inner_start..].find("]]") else {
            break;
        };
        let inner_end = inner_start + close;
        let target = text[inner_start..inner_end]
            .split('|')
            .next()
            .unwrap_or("")
            .trim();
        if !target.is_empty() && !target.contains(['[', ']']) {
            out.push(Span {
                start,
                end: inner_end + 2,
                target,
            });
        }
        cursor = inner_end + 2;
    }
    out
}
fn identifier(c: char) -> bool {
    static IDENTIFIER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern =
        IDENTIFIER.get_or_init(|| regex::Regex::new(r"^[\p{L}\p{N}_]$").expect("mention boundary"));
    let mut buffer = [0; 4];
    pattern.is_match(c.encode_utf8(&mut buffer))
}

fn mention_ranges(text: &str, names: &[String]) -> Vec<std::ops::Range<usize>> {
    use std::collections::HashMap;
    let mut folded = String::new();
    let mut original = HashMap::from([(0, 0)]);
    for (at, c) in text.char_indices() {
        folded.extend(c.to_lowercase());
        original.insert(folded.len(), at + c.len_utf8());
    }
    let mut found = Vec::new();
    for name in names {
        let needle: String = name.chars().flat_map(char::to_lowercase).collect();
        if needle.is_empty() {
            continue;
        }
        let mut from = 0;
        while let Some(offset) = folded[from..].find(&needle) {
            let at = from + offset;
            if let (Some(&start), Some(&end)) =
                (original.get(&at), original.get(&(at + needle.len())))
            {
                if !text[..start].chars().next_back().is_some_and(identifier)
                    && !text[end..].chars().next().is_some_and(identifier)
                {
                    found.push(start..end);
                }
            }
            from = at
                + folded[at..]
                    .chars()
                    .next()
                    .expect("nonempty needle")
                    .len_utf8();
        }
    }
    found.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| b.end.cmp(&a.end)));
    let mut end = 0;
    found.retain(|range| {
        if range.start < end {
            false
        } else {
            end = range.end;
            true
        }
    });
    found
}
struct Candidate<'a> {
    text: &'a str,
    range: std::ops::Range<usize>,
    key: Option<&'a str>,
    fragment: Option<String>,
}
fn occurrence_fragment(value: Option<&str>) -> Option<String> {
    value
        .map(|text| {
            text.trim_matches(|ch| limits().fragment_trim_code_points.contains(&(ch as u32)))
        })
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}
fn source_candidates<'a>(
    entry: &'a crate::vault::entry::Entry,
    body: &'a str,
    fields: &'a [crate::search::MetaField],
    target: &crate::vault::entry::Entry,
    index: &crate::vault::link::TargetIndex<'_>,
    mode: OccurrenceMode,
    names: &[String],
) -> Vec<Candidate<'a>> {
    let links = spans(body);
    let mut out = Vec::new();
    if mode == OccurrenceMode::Linked {
        for span in links {
            let Some((resolved, fragment)) = index.resolve_with_fragment(span.target) else {
                continue;
            };
            if resolved.path == target.path {
                out.push(Candidate {
                    text: body,
                    range: span.start..span.end,
                    key: None,
                    fragment: occurrence_fragment(fragment),
                });
            }
        }
        let mut sorted: Vec<_> = fields.iter().collect();
        sorted.sort_by(|a, b| a.key.cmp(&b.key));
        for field in sorted {
            for raw in entry.relationships.get(&field.key).into_iter().flatten() {
                let Some((resolved, fragment)) = index.resolve_with_fragment(raw) else {
                    continue;
                };
                if resolved.path != target.path {
                    continue;
                }
                let Some(at) = field.text.find(raw.trim()) else {
                    continue;
                };
                out.push(Candidate {
                    text: &field.text,
                    range: at..at + raw.trim().len(),
                    key: Some(&field.key),
                    fragment: occurrence_fragment(fragment),
                });
                break;
            }
        }
    } else {
        let mut link = 0;
        for range in mention_ranges(body, names) {
            while link < links.len() && links[link].end <= range.start {
                link += 1;
            }
            if link < links.len() && links[link].start < range.end {
                continue;
            }
            out.push(Candidate {
                text: body,
                range,
                key: None,
                fragment: None,
            });
        }
    }
    out
}

/// Mention discovery is the same bounded query, not another scanning engine.
pub fn find_mentions(
    scope: &SourceScope<'_>,
    target_path: &str,
    cursor: Option<&str>,
) -> Result<OccurrencePage, SourceReadError> {
    find_source_occurrences(scope, target_path, OccurrenceMode::Mention, cursor)
}

pub fn find_in_corpus(
    scope: &SourceScope<'_>,
    corpus: &Corpus,
    target_path: &str,
    mode: OccurrenceMode,
    encoded: Option<&str>,
) -> Result<OccurrencePage, SourceReadError> {
    use crate::ledger::sha256_hex;
    use std::collections::HashSet;
    let mut admitted: Vec<_> = corpus
        .entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| (scope.admits)(&entry.path))
        .map(|(i, _)| i)
        .collect();
    admitted.sort_by(|a, b| corpus.entries[*a].path.cmp(&corpus.entries[*b].path));
    let paths: Vec<_> = admitted.iter().map(|&i| &corpus.entries[i].path).collect();
    let scope_id = sha256_hex(
        serde_json::to_string(&(scope.vault_id, paths))
            .map_err(|e| e.to_string())?
            .as_bytes(),
    );
    let facts: Vec<_> = admitted
        .iter()
        .map(|&i| {
            let text = &corpus.texts[i];
            serde_json::json!([
                corpus.entries[i].path,
                text.source.as_ref().map(|s| &s.raw_sha256),
                text.source.as_ref().map_or("unsupported", |s| s.carrier),
                text.capped,
                corpus.entries[i].parse_error
            ])
        })
        .collect();
    let snapshot_id = sha256_hex(
        serde_json::to_string(&facts)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    );
    let mut cursor = Cursor {
        version: limits().version,
        target: sha256_hex(target_path.as_bytes()),
        mode,
        scope: scope_id,
        snapshot: snapshot_id.clone(),
        source: 0,
        row: 0,
    };
    if let Some(encoded) = encoded {
        if encoded.len() > limits().cursor_bytes {
            return Ok(changed());
        }
        let Ok(parsed) = serde_json::from_str::<Cursor>(encoded) else {
            return Ok(changed());
        };
        if parsed.version != cursor.version
            || parsed.target != cursor.target
            || parsed.mode != mode
            || parsed.scope != cursor.scope
            || parsed.snapshot != cursor.snapshot
            || parsed.source > admitted.len()
        {
            return Ok(changed());
        }
        cursor = parsed;
    }
    let Some(target) = admitted
        .iter()
        .map(|&i| &corpus.entries[i])
        .find(|entry| entry.path == target_path)
    else {
        return if encoded.is_some() {
            Ok(changed())
        } else {
            Err("Target is unavailable.".into())
        };
    };
    let index = crate::vault::link::TargetIndex::build_readable(&corpus.entries, scope.admits);
    let mut names = vec![
        target
            .filename
            .strip_suffix(".md")
            .unwrap_or(&target.filename)
            .to_string(),
        target.title.clone(),
    ];
    if target.filename.eq_ignore_ascii_case("project.md") {
        names.push(target.folder.rsplit('/').next().unwrap_or("").into());
    }
    if let Some(key) = crate::vault::link::item_key(target) {
        names.push(key);
    }
    names.retain(|name| {
        !name.trim().is_empty()
            && index
                .resolve(name)
                .is_some_and(|entry| entry.path == target_path)
    });
    let mut rows = Vec::new();
    let mut pages = HashSet::new();
    let mut counts = OccurrenceCounts::default();
    let mut examined_bytes = 0;
    let mut at = cursor.source;
    let mut ordinal = cursor.row;
    'sources: while at < admitted.len() {
        if counts.examined_sources >= limits().examined_sources {
            break;
        }
        let i = admitted[at];
        let entry = &corpus.entries[i];
        let text = &corpus.texts[i];
        let fields = crate::search::searchable_fields(
            &entry.title,
            entry.entry_type.as_deref(),
            &entry.properties,
            &entry.relationships,
        );
        let bytes = fields.iter().fold(text.body.len(), |sum, field| {
            sum.saturating_add(field.text.len())
        });
        if examined_bytes + bytes > limits().examined_bytes {
            if bytes > limits().examined_bytes {
                counts.examined_sources += 1;
                counts.capped_sources += 1;
                at += 1;
                ordinal = 0;
            }
            break;
        }
        counts.examined_sources += 1;
        examined_bytes += bytes;
        if text.capped {
            counts.capped_sources += 1;
        }
        let Some(snapshot) = text.source.as_ref().filter(|_| entry.parse_error.is_none()) else {
            counts.unavailable_sources += 1;
            at += 1;
            ordinal = 0;
            continue;
        };
        if snapshot.carrier != "markdown" {
            counts.unsupported_sources += 1;
            at += 1;
            ordinal = 0;
            continue;
        }
        if entry.path == target_path {
            at += 1;
            ordinal = 0;
            continue;
        }
        let candidates =
            source_candidates(entry, &text.body, &fields, target, &index, mode, &names);
        if ordinal > candidates.len() {
            return Ok(changed());
        }
        let mut unlocatable = false;
        while ordinal < candidates.len() {
            let item = &candidates[ordinal];
            let location = crate::source_location::locate_window(
                scope.vault_id,
                &entry.path,
                snapshot,
                item.text,
                item.range.clone(),
                item.key,
            );
            ordinal += 1;
            let Some(location) = location else {
                unlocatable = true;
                continue;
            };
            let id = sha256_hex(
                serde_json::to_string(&serde_json::json!([
                    location.path,
                    location.source_hash,
                    location.kind,
                    location.property_key,
                    location.body_utf8_range,
                    target_path,
                    item.fragment
                ]))
                .map_err(|e| e.to_string())?
                .as_bytes(),
            );
            pages.insert(entry.path.as_str());
            rows.push(SourceOccurrence {
                id,
                location,
                target_path: target_path.into(),
                target_fragment: item.fragment.clone(),
                via: item.key.unwrap_or("body").into(),
            });
            if rows.len() == limits().page_rows {
                if ordinal == candidates.len() {
                    at += 1;
                    ordinal = 0;
                }
                if unlocatable && !text.capped {
                    counts.capped_sources += 1;
                }
                break 'sources;
            }
        }
        if unlocatable && !text.capped {
            counts.capped_sources += 1;
        }
        at += 1;
        ordinal = 0;
    }
    counts.shown_occurrences = rows.len();
    counts.shown_pages = pages.len();
    cursor.source = at;
    cursor.row = ordinal;
    let truncated = at < admitted.len();
    let next_cursor = if truncated {
        Some(serde_json::to_string(&cursor).map_err(|e| e.to_string())?)
    } else {
        None
    };
    Ok(OccurrencePage::Ready {
        snapshot_id,
        rows,
        next_cursor,
        truncated,
        counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_location::SourceSnapshot;
    use crate::vault::{corpus::CorpusText, entry::Entry};

    fn source(path: &str, title: &str, body: &str) -> (Entry, CorpusText) {
        let mut entry = Entry::empty_for_test(path);
        entry.title = title.into();
        (
            entry,
            CorpusText {
                search_fields: None,
                source: Some(SourceSnapshot {
                    raw_sha256: crate::ledger::sha256_hex(body.as_bytes()),
                    carrier: "markdown",
                    body_start_utf8: 0,
                    searched_body_bytes: body.len(),
                    capped: false,
                }),
                body: body.into(),
                capped: false,
            },
        )
    }
    fn corpus(mut rows: Vec<(Entry, CorpusText)>) -> Corpus {
        rows.sort_by(|a, b| a.0.path.cmp(&b.0.path));
        let (entries, texts) = rows.into_iter().unzip();
        Corpus { entries, texts }
    }
    fn run(
        corpus: &Corpus,
        target: &str,
        mode: OccurrenceMode,
        cursor: Option<&str>,
        admits: &dyn Fn(&str) -> bool,
    ) -> serde_json::Value {
        serde_json::to_value(
            find_in_corpus(
                &SourceScope {
                    vault: std::path::Path::new("/test"),
                    vault_id: "vault",
                    admits,
                },
                corpus,
                target,
                mode,
                cursor,
            )
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn replays_the_shared_occurrence_cases() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/knowledge/source-occurrences-cases.json"
        ))
        .unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let rows = case["sources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|input| {
                    let (mut entry, text) = source(
                        input["path"].as_str().unwrap(),
                        input["title"].as_str().unwrap(),
                        input["body"].as_str().unwrap(),
                    );
                    if let Some(key) = input.get("key") {
                        entry.properties.insert("key".into(), key.clone());
                    }
                    if let Some(rel) = input.get("relationships") {
                        entry.relationships = serde_json::from_value(rel.clone()).unwrap();
                    }
                    (entry, text)
                })
                .collect();
            let page = run(
                &corpus(rows),
                case["targetPath"].as_str().unwrap(),
                serde_json::from_value(case["mode"].clone()).unwrap(),
                None,
                &|_| true,
            );
            let actual: Vec<_> = page["rows"].as_array().unwrap().iter().map(|row| {
                let loc = &row["location"];
                let mut out = serde_json::json!({"path":loc["path"], "quote":loc["quote"], "kind":loc["kind"]});
                if let Some(key) = loc.get("propertyKey") { out["key"] = key.clone(); }
                if let Some(fragment) = row.get("targetFragment") { out["fragment"] = fragment.clone(); }
                if let Some(range) = loc.get("bodyUtf8Range") { out["start"] = range["start"].clone(); out["end"] = range["end"].clone(); }
                out
            }).collect();
            assert_eq!(
                serde_json::json!(actual),
                case["expected"],
                "{}",
                case["name"]
            );
            if let Some(expected_ids) = case.get("expectedIds") {
                let ids: Vec<_> = page["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["id"].clone())
                    .collect();
                assert_eq!(
                    serde_json::json!(ids),
                    *expected_ids,
                    "{} IDs",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn repeated_body_links_have_distinct_occurrences_and_page_inside_source() {
        let data = corpus(vec![
            source("target.md", "Target", ""),
            source("a.md", "Source", &"[[target]] ".repeat(52)),
        ]);
        let first = run(&data, "target.md", OccurrenceMode::Linked, None, &|_| true);
        assert_eq!(first["rows"].as_array().unwrap().len(), 50);
        let second = run(
            &data,
            "target.md",
            OccurrenceMode::Linked,
            first["nextCursor"].as_str(),
            &|_| true,
        );
        assert_eq!(second["rows"].as_array().unwrap().len(), 2);
        assert!(second["nextCursor"].is_null());
        let ids: std::collections::HashSet<_> = first["rows"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["rows"].as_array().unwrap())
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 52);
    }
    #[test]
    fn cursor_refuses_changed_scope_and_corpus() {
        let mut data = corpus(vec![
            source("target.md", "Target", ""),
            source("a.md", "Source", &"[[target]] ".repeat(51)),
        ]);
        let first = run(&data, "target.md", OccurrenceMode::Linked, None, &|_| true);
        let cursor = first["nextCursor"].as_str().unwrap();
        let revoked = run(
            &data,
            "target.md",
            OccurrenceMode::Linked,
            Some(cursor),
            &|p| p != "a.md",
        );
        assert_eq!(revoked["status"], "changedSnapshot");
        assert!(revoked.get("rows").is_none());
        data.texts[0].source.as_mut().unwrap().raw_sha256 = "b".repeat(64);
        assert_eq!(
            run(
                &data,
                "target.md",
                OccurrenceMode::Linked,
                Some(cursor),
                &|_| true
            )["status"],
            "changedSnapshot"
        );
    }
    #[test]
    fn capped_scan_does_not_claim_no_mentions() {
        let mut rows: Vec<_> = (0..501)
            .map(|i| source(&format!("a{i:03}.md"), "Quiet", "quiet"))
            .collect();
        rows.push(source("target.md", "Target", ""));
        let page = run(
            &corpus(rows),
            "target.md",
            OccurrenceMode::Mention,
            None,
            &|_| true,
        );
        assert_eq!(page["rows"], serde_json::json!([]));
        assert_eq!(page["counts"]["examinedSources"], 500);
        assert!(page["nextCursor"].is_string());
        assert_eq!(page["truncated"], true);
    }
    #[test]
    fn source_past_work_budget_advances_and_discloses_capping() {
        let (mut huge, text) = source("a.md", "Huge", "");
        huge.properties.insert(
            "large".into(),
            serde_json::Value::String("x".repeat(8 * 1024 * 1024 + 1)),
        );
        let data = corpus(vec![
            (huge, text),
            source("b.md", "Source", "Target"),
            source("target.md", "Target", ""),
        ]);
        let first = run(&data, "target.md", OccurrenceMode::Mention, None, &|_| true);
        assert_eq!(first["counts"]["cappedSources"], 1);
        assert!(first["nextCursor"].is_string());
        let second = run(
            &data,
            "target.md",
            OccurrenceMode::Mention,
            first["nextCursor"].as_str(),
            &|_| true,
        );
        assert_eq!(second["rows"].as_array().unwrap().len(), 1);
        assert!(second["nextCursor"].is_null());
    }
    #[test]
    fn unavailable_unsupported_and_long_unlocatable_links_are_disclosed() {
        let name = "x".repeat(241);
        let (unreadable, mut absent) = source("a.md", "Unreadable", "");
        absent.source = None;
        let (board, mut unsupported) = source("b.canvas", "Board", "target");
        unsupported.source.as_mut().unwrap().carrier = "unsupported";
        let data = corpus(vec![
            (unreadable, absent),
            (board, unsupported),
            source("c.md", "Long", &format!("[[{name}]]")),
            source("target.md", &name, ""),
        ]);
        let page = run(&data, "target.md", OccurrenceMode::Linked, None, &|_| true);
        assert_eq!(page["counts"]["unavailableSources"], 1);
        assert_eq!(page["counts"]["unsupportedSources"], 1);
        assert_eq!(page["counts"]["cappedSources"], 1);
    }

    #[test]
    fn backlink_opens_the_recorded_occurrence_with_same_read_source_hash() {
        let vault = crate::vault::testutil::temp_vault("source-occurrence-open");
        let raw = "---\nstatus_note: original\n---\n😀 [[target|one]] and [[target#Notes|two]].\n";
        crate::vault::testutil::write(&vault, "source.md", raw);
        crate::vault::testutil::write(&vault, "target.md", "# Target\n");
        let vault_id = crate::runtime::scope::derive_vault_id(&vault);
        let scope = SourceScope {
            vault: &vault,
            vault_id: &vault_id,
            admits: &|_| true,
        };
        let page =
            find_source_occurrences(&scope, "target.md", OccurrenceMode::Linked, None).unwrap();
        let OccurrencePage::Ready { rows, .. } = page else {
            panic!("first query is ready")
        };
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(
                row.location.source_hash,
                crate::ledger::sha256_hex(raw.as_bytes())
            );
            assert!(matches!(
                crate::source_location::resolve_source(&scope, &row.location).unwrap(),
                crate::source_location::ResolveSourceResult::Exact { .. }
            ));
        }
        let _ = std::fs::remove_dir_all(vault);
    }
}
