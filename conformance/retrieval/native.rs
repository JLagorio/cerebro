//! M97.7 offline retrieval: real scoped producer controls and an explicit recorder.
//! No runtime route, CLI, socket, account, model or external provider is used.
use super::{search_notes_in, RunGrant};
use crate::native_producer_identity as producer_identity;
use crate::vault::{
    corpus::CorpusCache,
    testutil::{temp_vault, write},
};
use serde_json::{json, Map, Value};
use std::path::Path;

fn scoped(vault: &Path) -> RunGrant {
    let mut grant = RunGrant::unrestricted("m97-retrieval-fixture");
    grant.read_scope = Some(vec!["visible".into()]);
    grant.scope = Some(Vec::new());
    grant.tools = Some(vec!["search_notes".into()]);
    grant.vault = Some(vault.to_path_buf());
    grant
}

fn paths(answer: &Value) -> Vec<String> {
    // Same actual wire rows existing MCP tests inspect; no expected labels enter it.
    answer["content"][0]["text"]
        .as_str()
        .expect("text result")
        .lines()
        .filter_map(|line| line.strip_prefix("- "))
        .map(|line| line.split(" — ").next().expect("path").to_owned())
        .collect()
}

#[test]
fn m97_retrieval_real_search_default20_applies_scope_before_ranking() {
    let vault = temp_vault("m97-retrieval-default20");
    for index in 0..25 {
        write(
            &vault,
            &format!("visible/{index:03}.md"),
            "# Note\n\ncutoffneedle\n",
        );
    }
    write(
        &vault,
        "hidden/top.md",
        "# cutoffneedle\n\ncutoffneedle privatecanary\n",
    );
    let args: Map<String, Value> = serde_json::from_value(json!({"query":"cutoffneedle"})).unwrap();
    let answer = search_notes_in(&CorpusCache::new(1), &vault, &args, &scoped(&vault)).unwrap();
    let observed = paths(&answer);
    assert_eq!(observed.len(), 20);
    assert!(observed.iter().all(|path| path.starts_with("visible/")));
    assert!(!answer.to_string().contains("privatecanary"));
    assert!(!answer.to_string().contains("hidden/top.md"));
    assert!(answer["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("5 more not shown"));
    std::fs::remove_dir_all(vault).unwrap();
}

#[test]
fn m97_retrieval_real_search_requested_limit_is_capped_at100() {
    let vault = temp_vault("m97-retrieval-cap100");
    for index in 0..105 {
        write(
            &vault,
            &format!("visible/{index:03}.md"),
            "# Note\n\ncutoffneedle\n",
        );
    }
    let args: Map<String, Value> =
        serde_json::from_value(json!({"query":"cutoffneedle", "limit":101})).unwrap();
    let answer = search_notes_in(&CorpusCache::new(1), &vault, &args, &scoped(&vault)).unwrap();
    assert_eq!(paths(&answer).len(), 100);
    assert!(answer["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("The limit is at most 100."));
    std::fs::remove_dir_all(vault).unwrap();
}

#[test]
fn m97_retrieval_real_search_unavailable_root_is_error_not_no_matches() {
    let vault = temp_vault("m97-retrieval-unavailable");
    let absent = vault.join("never-created");
    let args: Map<String, Value> = serde_json::from_value(json!({"query":"cutoffneedle"})).unwrap();
    let answer = search_notes_in(&CorpusCache::new(1), &absent, &args, &scoped(&absent));
    assert!(
        answer.is_err(),
        "unavailable corpus must not become an empty successful answer"
    );
    std::fs::remove_dir_all(vault).unwrap();
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureLimits {
    queries: usize,
    documents: usize,
    document_bytes: usize,
    corpus_bytes: usize,
    query_bytes: usize,
    passages: usize,
    judgments: usize,
    quote_scalars: usize,
    path_bytes: usize,
    path_depth: usize,
    tool_result_bytes: usize,
    capture_bytes: usize,
    fixture_json_bytes: usize,
    tree_entries: usize,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureFormat {
    version: u32,
    producer: String,
    scenario: String,
    clock: String,
    surface: String,
    default_cutoff: usize,
    maximum_cutoff: usize,
    limits: CaptureLimits,
    query_kinds: Vec<String>,
    blank_query_scalars: Vec<u32>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusProvenance {
    synthetic: bool,
    author: String,
    note: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceDocument {
    path: String,
    markdown: String,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureCorpus {
    version: u32,
    provenance: CorpusProvenance,
    documents: Vec<SourceDocument>,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureQuery {
    id: String,
    kind: String,
    text: String,
    read_prefixes: Vec<String>,
    requested_limit: Option<u64>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureQueries {
    version: u32,
    queries: Vec<CaptureQuery>,
}

fn bytes_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn bounded_text(value: &str, cap: usize, empty: bool) -> bool {
    (empty || !value.is_empty()) && value.len() <= cap && !value.contains('\0')
}
fn fixture_path(value: &str, limits: &CaptureLimits) -> bool {
    let parts: Vec<&str> = value.split('/').collect();
    !value.is_empty()
        && value.len() <= limits.path_bytes
        && parts.len() <= limits.path_depth
        && parts.iter().all(|part| {
            let lower = part.to_ascii_lowercase();
            !part.is_empty()
                && ![
                    "credentials",
                    "id_rsa",
                    "id_ed25519",
                    "token",
                    "tokens",
                    "secrets",
                ]
                .contains(&lower.as_str())
                && !lower.ends_with(".pem")
                && !lower.ends_with(".key")
                && part.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_alphanumeric()
                        || byte == b'_'
                        || (index > 0 && (byte == b'.' || byte == b'-'))
                })
        })
}
fn fixture_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|row| {
        row.len() == expected.len() && expected.iter().all(|key| row.contains_key(*key))
    })
}
fn parse_fixture_inputs(
    format_raw: &[u8],
    corpus_raw: &[u8],
    queries_raw: &[u8],
) -> Result<(CaptureFormat, CaptureCorpus, CaptureQueries), &'static str> {
    let format: CaptureFormat =
        serde_json::from_slice(format_raw).map_err(|_| "retrieval format unavailable")?;
    let limits = &format.limits;
    if format.version != 1
        || format.producer != "mcp::search_notes_in"
        || format.scenario != "retrieval"
        || format.clock != "native_monotonic_per_query"
        || format.surface != "assistant_scoped_search_notes"
        || format.default_cutoff == 0
        || format.default_cutoff > format.maximum_cutoff
        || format.maximum_cutoff > limits.documents
        || [
            limits.queries,
            limits.documents,
            limits.document_bytes,
            limits.corpus_bytes,
            limits.query_bytes,
            limits.passages,
            limits.judgments,
            limits.quote_scalars,
            limits.path_bytes,
            limits.path_depth,
            limits.tool_result_bytes,
            limits.capture_bytes,
            limits.fixture_json_bytes,
            limits.tree_entries,
        ]
        .iter()
        .any(|value| *value == 0 || *value > 4 * 1024 * 1024)
        || format
            .query_kinds
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != format.query_kinds.len()
        || format.blank_query_scalars.is_empty()
        || format.blank_query_scalars.len() > 256
        || format
            .blank_query_scalars
            .iter()
            .any(|value| char::from_u32(*value).is_none())
        || format
            .blank_query_scalars
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err("unsupported retrieval format");
    }
    if corpus_raw.len() > limits.fixture_json_bytes || queries_raw.len() > limits.fixture_json_bytes
    {
        return Err("retrieval fixture JSON cap");
    }
    let corpus: CaptureCorpus =
        serde_json::from_slice(corpus_raw).map_err(|_| "retrieval corpus unavailable")?;
    let query_value: Value =
        serde_json::from_slice(queries_raw).map_err(|_| "retrieval queries unavailable")?;
    if !exact_keys(&query_value, &["version", "queries"])
        || !query_value["queries"].as_array().is_some_and(|rows| {
            rows.iter().all(|row| {
                exact_keys(
                    row,
                    &["id", "kind", "text", "readPrefixes", "requestedLimit"],
                )
            })
        })
    {
        return Err("retrieval query fields differ");
    }
    let queries: CaptureQueries =
        serde_json::from_value(query_value).map_err(|_| "retrieval queries unavailable")?;
    if corpus.version != 1
        || !corpus.provenance.synthetic
        || !bounded_text(&corpus.provenance.author, 256, false)
        || !bounded_text(&corpus.provenance.note, 4096, false)
        || corpus.documents.is_empty()
        || corpus.documents.len() > limits.documents
        || queries.version != 1
        || queries.queries.is_empty()
        || queries.queries.len() > limits.queries
    {
        return Err("retrieval fixture shape");
    }
    let mut total = 0usize;
    let mut paths = std::collections::BTreeSet::new();
    for source in &corpus.documents {
        total = total
            .checked_add(source.markdown.len())
            .ok_or("retrieval corpus overflow")?;
        if !fixture_path(&source.path, limits)
            || !source.path.ends_with(".md")
            || !bounded_text(&source.markdown, limits.document_bytes, true)
            || total > limits.corpus_bytes
            || !paths.insert(source.path.to_ascii_lowercase())
        {
            return Err("retrieval source refused");
        }
    }
    for source in &corpus.documents {
        let parts: Vec<_> = source.path.split('/').collect();
        for count in 1..parts.len() {
            if paths.contains(&parts[..count].join("/").to_ascii_lowercase()) {
                return Err("retrieval source is also a directory");
            }
        }
    }
    let mut ids = std::collections::BTreeSet::new();
    for query in &queries.queries {
        if !fixture_id(&query.id)
            || !ids.insert(&query.id)
            || !format.query_kinds.contains(&query.kind)
            || !bounded_text(&query.text, limits.query_bytes, false)
            || query
                .text
                .chars()
                .all(|character| format.blank_query_scalars.contains(&(character as u32)))
            || query.read_prefixes.len() > limits.documents
            || query
                .read_prefixes
                .iter()
                .any(|value| !fixture_path(value, limits))
            || query
                .read_prefixes
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != query.read_prefixes.len()
            || query
                .requested_limit
                .is_some_and(|value| value == 0 || value > 10000)
        {
            return Err("retrieval query refused");
        }
    }
    Ok((format, corpus, queries))
}

fn fixture_inputs() -> Result<(CaptureFormat, CaptureCorpus, CaptureQueries), &'static str> {
    parse_fixture_inputs(
        include_bytes!("format.v1.json"),
        include_bytes!("corpus.v1.json"),
        include_bytes!("queries.json"),
    )
}

#[cfg(unix)]
fn qualified_hash(path: &Path, cap: usize) -> Result<(usize, String), &'static str> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "fixture file open unavailable")?;
    let fingerprint = |meta: &std::fs::Metadata| {
        (
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    };
    let before = file
        .metadata()
        .map_err(|_| "fixture file metadata unavailable")?;
    if !before.is_file() || before.len() > cap as u64 {
        return Err("fixture file not bounded regular data");
    }
    let mut bytes = Vec::new();
    (&file)
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "fixture file read unavailable")?;
    let after = file
        .metadata()
        .map_err(|_| "fixture file metadata unavailable")?;
    let current = std::fs::symlink_metadata(path).map_err(|_| "fixture file path unavailable")?;
    if bytes.len() > cap
        || bytes.len() as u64 != after.len()
        || !current.is_file()
        || fingerprint(&before) != fingerprint(&after)
        || fingerprint(&after) != fingerprint(&current)
    {
        return Err("fixture file changed while reading");
    }
    Ok((bytes.len(), bytes_hash(&bytes)))
}
#[cfg(not(unix))]
fn qualified_hash(_path: &Path, _cap: usize) -> Result<(usize, String), &'static str> {
    Err("qualified fixture reads unsupported on this platform")
}

#[derive(Default)]
struct FixtureState {
    verified: usize,
    missing: std::collections::BTreeSet<String>,
    changed: std::collections::BTreeSet<String>,
    additional: std::collections::BTreeSet<String>,
    symlinks: std::collections::BTreeSet<String>,
}
fn fixture_state(
    root: &Path,
    corpus: &CaptureCorpus,
    limits: &CaptureLimits,
) -> Result<FixtureState, &'static str> {
    let expected: std::collections::BTreeMap<_, _> = corpus
        .documents
        .iter()
        .map(|row| {
            (
                row.path.clone(),
                (row.markdown.len(), bytes_hash(row.markdown.as_bytes())),
            )
        })
        .collect();
    let mut directories = std::collections::BTreeSet::new();
    for path in expected.keys() {
        let parts: Vec<_> = path.split('/').collect();
        for count in 1..parts.len() {
            directories.insert(parts[..count].join("/"));
        }
    }
    let mut state = FixtureState::default();
    let mut seen = std::collections::BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|_| "fixture inventory unavailable")? {
            visited += 1;
            if visited > limits.tree_entries {
                return Err("fixture inventory cap");
            }
            let entry = entry.map_err(|_| "fixture inventory entry unavailable")?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "fixture path escaped")?
                .to_str()
                .ok_or("fixture path unavailable")?
                .to_owned();
            let kind = entry
                .file_type()
                .map_err(|_| "fixture entry type unavailable")?;
            if kind.is_symlink() {
                state.symlinks.insert(relative);
                continue;
            }
            if kind.is_dir() {
                if !directories.contains(&relative) {
                    state.additional.insert(relative);
                }
                pending.push(path);
                continue;
            }
            match expected.get(&relative) {
                Some(wanted) if kind.is_file() => {
                    seen.insert(relative.clone());
                    if &qualified_hash(&path, limits.document_bytes)? == wanted {
                        state.verified += 1;
                    } else {
                        state.changed.insert(relative);
                    }
                }
                _ => {
                    state.additional.insert(relative);
                }
            }
        }
    }
    state.missing = expected
        .keys()
        .filter(|path| !seen.contains(*path))
        .cloned()
        .collect();
    Ok(state)
}
fn source_audit(before: &FixtureState, after: &FixtureState, count: usize) -> Value {
    let missing = before.missing.union(&after.missing).count();
    let changed = before.changed.union(&after.changed).count();
    let additional = before.additional.union(&after.additional).count();
    let symlinks = before.symlinks.union(&after.symlinks).count();
    json!({"verifiedBefore":before.verified,"verifiedAfter":after.verified,"missing":missing,"changed":changed,"additional":additional,"symlinks":symlinks,"unchanged":before.verified == count && after.verified == count && missing == 0 && changed == 0 && additional == 0 && symlinks == 0})
}
// The fixed untyped/all-fields fixture producer has empty, exact and widened
// forms. Unsupported query/read-error footers refuse rather than imply no hits.
fn capture_paths(
    text: &str,
    corpus: &CaptureCorpus,
    format: &CaptureFormat,
    query: &CaptureQuery,
    withheld: usize,
    capped: usize,
) -> Result<Vec<String>, &'static str> {
    let limits = &format.limits;
    let refused = "retrieval wire shape unsupported";
    let scope_note = if withheld == 0 {
        String::new()
    } else {
        format!(" ({withheld} notes outside this run's read scope were not searched)")
    };
    let cap_note = if capped == 0 {
        String::new()
    } else {
        format!(
            " ({capped} {} longer than 100 KB {} searched in {} first 100 KB)",
            super::plural(capped, "note", "notes"),
            super::plural(capped, "was", "were"),
            super::plural(capped, "its", "their")
        )
    };
    let limit_footer = query
        .requested_limit
        .is_some_and(|limit| limit > format.maximum_cutoff as u64);
    let empty = format!(
        "No notes matched \"{}\".{scope_note}{cap_note}{}",
        query.text,
        if limit_footer {
            "\n\nThe limit is at most 100."
        } else {
            ""
        }
    );
    if text == empty {
        return Ok(Vec::new());
    }
    let widened_prefix = format!("No note contains every word of \"{}\". ", query.text);
    let widened = text.starts_with(widened_prefix.as_str());
    let count_text = if widened {
        text.strip_prefix(widened_prefix.as_str()).ok_or(refused)?
    } else {
        text
    };
    let (shown_text, rest) = count_text.split_once(" of ").ok_or(refused)?;
    let (total_text, _) = rest.split_once(' ').ok_or(refused)?;
    let read_count = |value: &str| -> Result<usize, &'static str> {
        if value.is_empty()
            || value.starts_with('0')
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(refused);
        }
        let count = value.parse::<usize>().map_err(|_| refused)?;
        if count > limits.documents {
            return Err(refused);
        }
        Ok(count)
    };
    let shown = read_count(shown_text)?;
    let total = read_count(total_text)?;
    let cutoff = query
        .requested_limit
        .map_or(format.default_cutoff, |limit| {
            limit.min(format.maximum_cutoff as u64) as usize
        });
    if shown > cutoff || total < shown {
        return Err(refused);
    }
    let header = if widened {
        format!(
            "{widened_prefix}{shown} of {total} closest {}, best first{scope_note}{cap_note}:",
            super::plural(total, "match", "matches")
        )
    } else {
        format!(
            "{shown} of {total} {} {} \"{}\", best first{scope_note}{cap_note}:",
            super::plural(total, "note", "notes"),
            super::plural(total, "matches", "match"),
            query.text
        )
    };
    let header_prefix = format!("{header}\n");
    let mut body = text.strip_prefix(header_prefix.as_str()).ok_or(refused)?;
    let mut footers = Vec::new();
    if total > shown {
        footers.push(format!(
            "{} more not shown; raise limit (at most 100) or narrow the query.",
            total - shown
        ));
    }
    if limit_footer {
        footers.push("The limit is at most 100.".to_owned());
    }
    if !footers.is_empty() {
        let suffix = format!("\n\n{}", footers.join("\n"));
        body = body.strip_suffix(suffix.as_str()).ok_or(refused)?;
    }
    let mut paths = Vec::new();
    let mut unique = std::collections::BTreeSet::new();
    let mut detail_lines = 0usize;
    let mut matched = false;
    for line in body.split('\n') {
        if let Some(row) = line.strip_prefix("- ") {
            if widened && !paths.is_empty() && !matched {
                return Err(refused);
            }
            let (path, title) = row.split_once(" — ").ok_or(refused)?;
            if title.is_empty()
                || !fixture_path(path, limits)
                || !corpus.documents.iter().any(|source| source.path == path)
                || !unique.insert(path)
            {
                return Err(refused);
            }
            paths.push(path.to_owned());
            detail_lines = 0;
            matched = false;
        } else {
            if paths.is_empty() || !line.starts_with("  ") || line.len() == 2 || matched {
                return Err(refused);
            }
            if widened && line.starts_with("  matched: ") && line.len() > "  matched: ".len() {
                matched = true;
            } else {
                detail_lines += 1;
                if detail_lines > 1 {
                    return Err(refused);
                }
            }
        }
    }
    if paths.len() != shown || (widened && !matched) {
        return Err(refused);
    }
    Ok(paths)
}

#[test]
#[ignore = "explicit offline native retrieval capture; requires a new report path in an empty canonical private directory"]
fn record_retrieval_baseline() {
    use std::io::Write;
    use std::time::Instant;
    let (format, corpus, queries) = fixture_inputs().expect("bounded compiled retrieval fixtures");
    let native_inputs = producer_identity::native_input_identity();
    for key in [
        "CEREBRO_ACTION_TEST_DIR",
        "CEREBRO_ACTION_PROCESS_GATE",
        "CEREBRO_CRASH_VAULT",
        "CEREBRO_CRASH_POINT",
    ] {
        assert!(
            std::env::var_os(key).is_none(),
            "fixture overrides are not permitted"
        );
    }
    let output = std::path::PathBuf::from(
        std::env::var_os("CEREBRO_RETRIEVAL_NATIVE_OUT")
            .expect("CEREBRO_RETRIEVAL_NATIVE_OUT must name a new private report file"),
    );
    assert!(
        output.is_absolute() && !output.exists(),
        "report must be an absolute new file"
    );
    let parent = output.parent().expect("report needs a parent");
    assert_eq!(
        std::fs::canonicalize(parent).expect("report parent"),
        parent,
        "report parent must be canonical"
    );
    assert!(
        std::fs::read_dir(parent)
            .expect("report parent")
            .next()
            .is_none(),
        "report parent must be empty"
    );
    let mut report_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .expect("reserve new report file");
    let vault = parent.join("fixture");
    std::fs::create_dir(&vault).expect("create private fixture");
    for source in &corpus.documents {
        let target = vault.join(&source.path);
        std::fs::create_dir_all(target.parent().expect("source parent"))
            .expect("create fixture parents");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .expect("new fixture source");
        file.write_all(source.markdown.as_bytes())
            .expect("write synthetic fixture source");
        file.sync_all().expect("flush synthetic fixture source");
    }
    let baseline = fixture_state(&vault, &corpus, &format.limits).expect("observe initial fixture");
    assert_eq!(
        baseline.verified,
        corpus.documents.len(),
        "fixture must equal compiled inputs before search"
    );
    let source_files: Vec<_> = corpus.documents.iter().map(|source| json!({"path":source.path,"bytes":source.markdown.len(),"sha256":bytes_hash(source.markdown.as_bytes())})).collect();
    let mut observations = Vec::new();
    for query in &queries.queries {
        let before =
            fixture_state(&vault, &corpus, &format.limits).expect("observe pre-query sources");
        let mut grant = scoped(&vault);
        grant.read_scope = Some(query.read_prefixes.clone());
        let mut args = Map::new();
        args.insert("query".into(), Value::String(query.text.clone()));
        if let Some(limit) = query.requested_limit {
            args.insert("limit".into(), json!(limit));
        }
        let (effective_limit, _) =
            super::arg_limit(&args, format.default_cutoff, format.maximum_cutoff)
                .expect("valid query cutoff");
        let cache = CorpusCache::new(1);
        let started = Instant::now();
        let result = search_notes_in(&cache, &vault, &args, &grant);
        let duration = started.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(answer) => {
                let text = answer["content"][0]["text"]
                    .as_str()
                    .expect("native search text");
                assert!(
                    bounded_text(text, format.limits.tool_result_bytes, false),
                    "native search wire cap"
                );
                let snapshot = cache
                    .snapshot(&vault)
                    .expect("read the completed query cache");
                let (readable, withheld) = super::readable_entries(&snapshot, &grant);
                let admitted: Vec<_> = readable.iter().map(|entry| entry.path.clone()).collect();
                let capped =
                    crate::search::docs_of(&snapshot, |entry| grant.may_read(&entry.path)).capped;
                let hits = capture_paths(text, &corpus, &format, query, withheld, capped)
                    .expect("actual native hit rows");
                assert!(
                    hits.len() <= effective_limit,
                    "native search exceeds actual cutoff"
                );
                let after = fixture_state(&vault, &corpus, &format.limits)
                    .expect("observe post-query sources");
                let audit = source_audit(&before, &after, corpus.documents.len());
                observations.push(json!({"observation":{"queryId":query.id,"state":"ready","effectiveLimit":effective_limit,"hits":hits,"admittedPaths":admitted,"durationMs":duration,"costUsd":null,"cappedSourceCount":capped,"withheldSourceCount":withheld,"limitations":["Actual scoped Rust search over synthetic files; no HTTP/bearer, CLI or model call.","Duration includes this fresh in-process corpus cache; OS caches are not reset.","Returned paths do not establish exact passage display or answer support."]},"wireText":text,"errorCode":null,"sourceAudit":audit}));
            }
            Err(_) => {
                let after = fixture_state(&vault, &corpus, &format.limits)
                    .expect("observe failed-query sources");
                let audit = source_audit(&before, &after, corpus.documents.len());
                observations.push(json!({"observation":{"queryId":query.id,"state":"unavailable","effectiveLimit":null,"hits":[],"admittedPaths":[],"durationMs":duration,"costUsd":null,"cappedSourceCount":null,"withheldSourceCount":null,"limitations":["Actual native search failed; no empty-result claim is made."]},"wireText":null,"errorCode":"corpus_unavailable","sourceAudit":audit}));
            }
        }
    }
    let report = json!({"version":1,"scenario":format.scenario,"producer":format.producer,"observedAt":crate::runtime::now_utc(),"clock":format.clock,"nativeInputs":native_inputs,"corpusSha256":bytes_hash(include_bytes!("corpus.v1.json")),"queriesSha256":bytes_hash(include_bytes!("queries.json")),"formatSha256":bytes_hash(include_bytes!("format.v1.json")),"sourceFiles":source_files,"observations":observations,"limits":["Synthetic corpus; evaluation labels remain outside observation production.","The recorder never reads labels or expected result arrays.","Source hashes and entry audit cover the owned fixture tree; writes outside that tree were not instrumented.","Complete declared repository input identity is compiled in; actual toolchain, Cargo cache, environment and OS identity remain separate root evidence.","No model support, exact-passage coverage, model abstention, cost or retrieval quality threshold is measured."]});
    let bytes = serde_json::to_vec_pretty(&report).expect("bounded retrieval report");
    assert!(
        bytes.len() < format.limits.capture_bytes,
        "retrieval report cap"
    );
    report_file
        .write_all(&bytes)
        .expect("write actual retrieval observation");
    report_file
        .write_all(b"\n")
        .expect("finish actual retrieval observation");
    report_file
        .sync_all()
        .expect("flush actual retrieval observation");
    // Persist raw observations before asserting fixture invariants; a failure is
    // retained for root diagnosis and is never silently retried or accepted.
    for entry in report["observations"].as_array().expect("observations") {
        assert_eq!(
            entry["sourceAudit"]["unchanged"], true,
            "retrieval changed its fixture"
        );
        let observation = &entry["observation"];
        let admitted: std::collections::BTreeSet<_> = observation["admittedPaths"]
            .as_array()
            .expect("admitted paths")
            .iter()
            .map(|value| value.as_str().expect("path text"))
            .collect();
        assert!(
            observation["hits"]
                .as_array()
                .expect("hits")
                .iter()
                .all(|hit| admitted.contains(hit.as_str().expect("path text"))),
            "native retrieval leaked an ungranted path"
        );
    }
    std::fs::remove_dir_all(vault)
        .expect("remove owned synthetic fixture after successful capture");
}

#[test]
fn m97_retrieval_fixture_inputs_replay_shared_cases() {
    let cases: Value = serde_json::from_slice(include_bytes!("validation-cases.v1.json"))
        .expect("shared retrieval cases");
    assert_eq!(cases["version"], 1);
    for case in cases["cases"].as_array().expect("cases") {
        let mut corpus: Value =
            serde_json::from_slice(include_bytes!("corpus.v1.json")).expect("corpus");
        let mut queries: Value =
            serde_json::from_slice(include_bytes!("queries.json")).expect("queries");
        if case["target"] != "none" {
            let target = if case["target"] == "corpus" {
                &mut corpus
            } else {
                &mut queries
            };
            let pointer = case["pointer"].as_str().expect("mutation pointer");
            let (parent, key) = pointer.rsplit_once('/').expect("mutation parent");
            let parent = target
                .pointer_mut(parent)
                .expect("known mutation parent")
                .as_object_mut()
                .expect("mutation object");
            if case["operation"] == "remove" {
                assert!(parent.remove(key).is_some());
            } else {
                parent.insert(key.to_owned(), case["value"].clone());
            }
        }
        let corpus = serde_json::to_vec(&corpus).expect("case corpus");
        let queries = serde_json::to_vec(&queries).expect("case queries");
        let result = parse_fixture_inputs(include_bytes!("format.v1.json"), &corpus, &queries);
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().expect("expected validity"),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn m97_retrieval_wire_shapes_replay_shared_cases() {
    let cases: Value =
        serde_json::from_slice(include_bytes!("wire-cases.v1.json")).expect("shared wire cases");
    assert_eq!(cases["version"], 1);
    let corpus: CaptureCorpus =
        serde_json::from_value(cases["corpus"].clone()).expect("synthetic wire corpus");
    let (format, _, _) = fixture_inputs().expect("capture contract");
    for case in cases["cases"].as_array().expect("wire cases") {
        let query = CaptureQuery {
            id: "wire".to_owned(),
            kind: "exact".to_owned(),
            text: case["queryText"].as_str().expect("query text").to_owned(),
            read_prefixes: vec!["visible".to_owned()],
            requested_limit: case["requestedLimit"].as_u64(),
        };
        let result = capture_paths(
            case["wire"].as_str().expect("wire text"),
            &corpus,
            &format,
            &query,
            case["withheld"].as_u64().expect("withheld") as usize,
            case["capped"].as_u64().expect("capped") as usize,
        );
        if case["valid"].as_bool().expect("case validity") {
            let expected: Vec<String> =
                serde_json::from_value(case["paths"].clone()).expect("expected paths");
            assert_eq!(
                result.expect("recognized native wire shape"),
                expected,
                "{}",
                case["name"]
            );
        } else {
            assert!(result.is_err(), "{}", case["name"]);
        }
    }
}

#[test]
fn m97_retrieval_real_search_empty_wire_is_recognized() {
    let cases: Value =
        serde_json::from_slice(include_bytes!("wire-cases.v1.json")).expect("shared wire cases");
    let corpus: CaptureCorpus =
        serde_json::from_value(cases["corpus"].clone()).expect("synthetic wire corpus");
    let (format, _, _) = fixture_inputs().expect("capture contract");
    let vault = temp_vault("m97-retrieval-empty-wire");
    for source in &corpus.documents {
        write(&vault, &source.path, &source.markdown);
    }
    let query = CaptureQuery {
        id: "empty".to_owned(),
        kind: "unanswerable".to_owned(),
        text: "quantum bananas".to_owned(),
        read_prefixes: vec!["visible".to_owned()],
        requested_limit: None,
    };
    let args: Map<String, Value> =
        serde_json::from_value(json!({"query":query.text})).expect("query args");
    let grant = scoped(&vault);
    let cache = CorpusCache::new(1);
    let answer = search_notes_in(&cache, &vault, &args, &grant).expect("actual successful search");
    let wire = answer["content"][0]["text"].as_str().expect("native text");
    let snapshot = cache.snapshot(&vault).expect("completed corpus");
    let (_, withheld) = super::readable_entries(&snapshot, &grant);
    let capped = crate::search::docs_of(&snapshot, |entry| grant.may_read(&entry.path)).capped;
    assert_eq!(wire, "No notes matched \"quantum bananas\". (1 notes outside this run's read scope were not searched)");
    assert!(
        capture_paths(wire, &corpus, &format, &query, withheld, capped)
            .expect("recognized measured empty")
            .is_empty()
    );
    std::fs::remove_dir_all(vault).expect("remove owned empty-search fixture");
}
