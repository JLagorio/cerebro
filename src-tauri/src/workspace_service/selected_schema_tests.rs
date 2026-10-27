#![cfg(test)]
//! BL-23: shipped schema texts are frozen, a store is held to SQLite's own
//! model of them, and every production SQL statement in the selected service
//! and migration prepares on exactly the shipped stores it can run against.
use super::*;
use rusqlite::fallible_iterator::FallibleIterator;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

fn repo(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(path)
}

#[test]
fn the_loaded_bytes_match_the_committed_digest() {
    for (schema, sql, digest) in SHIPPED {
        assert_eq!(schema, std::fs::read_to_string(repo(sql)).unwrap(), "{sql}");
        assert_eq!(
            crate::ledger::sha256_hex(schema.as_bytes()),
            std::fs::read_to_string(repo(digest)).unwrap().trim(),
            "{sql} is a shipped schema and frozen: add a new version instead of editing it"
        );
    }
}

/// Anchors a NEW shipped schema file only: it never rewrites an existing
/// digest, so it cannot bless an edit to a schema that already shipped.
#[test]
#[ignore = "run explicitly to anchor a new schema version; see shared/workspace/README.md"]
fn write_selected_schema_digests() {
    for (schema, sql, digest) in SHIPPED {
        let anchored = format!("{}\n", crate::ledger::sha256_hex(schema.as_bytes()));
        match std::fs::read_to_string(repo(digest)) {
            Ok(existing) => {
                assert_eq!(existing, anchored, "{sql} shipped; it is never re-anchored")
            }
            Err(_) => std::fs::write(repo(digest), anchored).unwrap(),
        }
    }
}

#[test]
fn the_shipped_models_are_exactly_the_supported_store_versions() {
    let models = shipped().unwrap();
    assert_eq!(
        models.keys().copied().collect::<Vec<_>>(),
        vec![
            super::super::rules().schema_version,
            crate::workspace_migration::journal::rules().selected_schema_version,
            super::super::metadata::schema_version(),
        ]
    );
    for (version, objects) in models {
        assert!(
            objects
                .iter()
                .any(|o| o.kind == "table" && o.name == "records"),
            "store {version} keeps its records table"
        );
        assert!(
            objects.iter().all(|o| o.kind == "table" || o.sql.is_none()),
            "store {version} creates only tables and their automatic indexes"
        );
    }
}

fn store(schema: &str) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(schema).unwrap();
    conn
}

fn verify_store(conn: &Connection) -> Result<(), AuthorityError> {
    super::super::verify_schema_with_journal(conn, "memory")
}

#[test]
fn a_store_built_from_each_shipped_file_passes() {
    for (schema, sql, _) in SHIPPED {
        verify_store(&store(schema)).unwrap_or_else(|e| panic!("{sql}: {}", e.message));
    }
    // A file-backed store, in the journal mode every store keeps.
    let dir = crate::vault::testutil::temp_vault("selected-schema-file-store");
    for (schema, sql, _) in SHIPPED {
        let path = dir.join(format!("{}.db", sql.rsplit('/').next().unwrap()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(schema).unwrap();
        super::super::verify_schema_with_journal(&conn, "delete")
            .unwrap_or_else(|e| panic!("{sql}: {}", e.message));
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_reformatted_or_commented_copy_is_refused_with_its_reason() {
    for (schema, sql, _) in SHIPPED {
        let version = model_of(schema).unwrap().0;
        let reformatted =
            schema.replacen("CREATE TABLE records (\n    ", "CREATE TABLE records (", 1);
        let commented = schema.replacen(
            "    path TEXT NOT NULL UNIQUE,\n",
            "    path TEXT NOT NULL UNIQUE, -- the visible body\n",
            1,
        );
        let respaced = schema.replacen("CREATE TABLE workspace (", "CREATE TABLE workspace  (", 1);
        for (variant, label) in [
            (&reformatted, "reformatted"),
            (&commented, "commented"),
            (&respaced, "respaced"),
        ] {
            assert_ne!(
                variant.as_str(),
                schema,
                "{sql} {label} variant changed nothing"
            );
            let error = verify_store(&store(variant)).unwrap_err();
            assert_eq!(
                error.kind,
                AuthorityErrorKind::InvalidMetadata,
                "{sql} {label}"
            );
            let table = if label == "respaced" {
                "workspace"
            } else {
                "records"
            };
            assert_eq!(
                error.message,
                format!("Canonical table {table} differs from shipped schema {version}."),
                "{sql} {label}"
            );
        }
        let extra = format!("{schema}CREATE INDEX extra_paths ON records(path);\n");
        let error = verify_store(&store(&extra)).unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "Canonical metadata holds a schema object that shipped schema {version} does not define."
            ),
            "{sql}"
        );
        let dropped = store(schema);
        dropped
            .execute_batch("DROP TABLE metadata_receipts;")
            .unwrap();
        let error = verify_store(&dropped).unwrap_err();
        assert!(
            error
                .message
                .starts_with("Canonical schema is incomplete: shipped schema"),
            "{sql}: {}",
            error.message
        );
        assert!(error.message.contains("table metadata_receipts"), "{sql}");
    }
}

/// The defect BL-23 names: a `--` line before a CREATE TABLE once dropped that
/// table from the hand-split expectation, refusing every store. SQLite's own
/// model stores no text outside a statement, so the shape is unchanged and a
/// store built either way passes.
#[test]
fn a_comment_between_statements_never_drops_an_expected_table() {
    for (schema, sql, _) in SHIPPED {
        let commented = schema
            .replace(
                "CREATE TABLE ",
                "-- canonical table follows;\nCREATE TABLE ",
            )
            .replace(";\n", "; /* between statements */\n");
        assert_ne!(commented, schema);
        assert_eq!(
            model_of(&commented).unwrap(),
            model_of(schema).unwrap(),
            "{sql}"
        );
        verify_store(&store(&commented)).unwrap_or_else(|e| panic!("{sql}: {}", e.message));
    }
}

// --- Every production statement prepares on its shipped stores -----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    Code,
    Comment,
    Literal,
}

/// Rust source split into code, comments and literals, byte by byte, with
/// each string literal's decoded value. Matching runs on code bytes only.
struct Lexed<'a> {
    text: &'a str,
    class: Vec<Class>,
    literals: BTreeMap<usize, (usize, String)>,
}

fn decode_escapes(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('0') => out.push('\0'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('\'') => out.push('\''),
            Some('x') => {
                let hex: String = chars.by_ref().take(2).collect();
                out.push(char::from(u8::from_str_radix(&hex, 16).unwrap()));
            }
            Some('u') => {
                let code: String = chars
                    .by_ref()
                    .skip_while(|c| *c == '{')
                    .take_while(|c| *c != '}')
                    .collect();
                out.push(char::from_u32(u32::from_str_radix(&code, 16).unwrap()).unwrap());
            }
            // A line continuation skips the newline and the next line's indent.
            Some('\n') => {
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
            }
            other => panic!("unknown escape \\{other:?}"),
        }
    }
    out
}

fn lex(text: &str) -> Lexed<'_> {
    let b = text.as_bytes();
    let mut class = vec![Class::Code; b.len()];
    let mut literals = BTreeMap::new();
    let mut i = 0;
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    while i < b.len() {
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            let end = text[i..].find('\n').map_or(b.len(), |n| i + n);
            class[i..end].fill(Class::Comment);
            i = end;
            continue;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            let (mut depth, mut j) = (0usize, i);
            while j < b.len() {
                if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            class[i..j].fill(Class::Comment);
            i = j;
            continue;
        }
        let after_ident = i > 0 && ident(b[i - 1]);
        if !after_ident && matches!(b[i], b'r' | b'b' | b'c' | b'"') {
            let mut j = i;
            if matches!(b[j], b'b' | b'c') && matches!(b.get(j + 1), Some(b'r' | b'"')) {
                j += 1;
            }
            if b[j] == b'r' && matches!(b.get(j + 1), Some(b'"' | b'#')) {
                let mut k = j + 1;
                while b.get(k) == Some(&b'#') {
                    k += 1;
                }
                if b.get(k) == Some(&b'"') {
                    let hashes = k - (j + 1);
                    let close = format!("\"{}", "#".repeat(hashes));
                    let end = k + 1 + text[k + 1..].find(&close).expect("closed raw string");
                    literals.insert(i, (end + close.len(), text[k + 1..end].to_owned()));
                    class[i..end + close.len()].fill(Class::Literal);
                    i = end + close.len();
                    continue;
                }
            }
            if b[j] == b'"' {
                let mut k = j + 1;
                while b[k] != b'"' {
                    k += if b[k] == b'\\' { 2 } else { 1 };
                }
                literals.insert(i, (k + 1, decode_escapes(&text[j + 1..k])));
                class[i..=k].fill(Class::Literal);
                i = k + 1;
                continue;
            }
        }
        if b[i] == b'\'' {
            // A char literal, or a lifetime (which stays code).
            let rest = &text[i + 1..];
            let close = if rest.starts_with('\\') {
                rest[2..].find('\'').map(|n| n + 3)
            } else {
                rest.chars()
                    .next()
                    .filter(|c| rest[c.len_utf8()..].starts_with('\''))
                    .map(|c| c.len_utf8() + 1)
            };
            if let Some(len) = close {
                class[i..=i + len].fill(Class::Literal);
                i += len + 1;
                continue;
            }
        }
        i += 1;
    }
    Lexed {
        text,
        class,
        literals,
    }
}

impl Lexed<'_> {
    /// The next byte at or after `at` that is code and not whitespace.
    fn skip(&self, mut at: usize) -> usize {
        let b = self.text.as_bytes();
        while at < b.len() && (self.class[at] == Class::Comment || b[at].is_ascii_whitespace()) {
            at += 1;
        }
        at
    }
    fn code_at(&self, at: usize, needle: &str) -> bool {
        self.text[at..].starts_with(needle)
            && self.class[at..at + needle.len()]
                .iter()
                .all(|c| *c == Class::Code)
    }
    /// Code occurrences of `needle`.
    fn find_code(&self, needle: &str) -> Vec<usize> {
        let mut found = Vec::new();
        let mut from = 0;
        while let Some(n) = self.text[from..].find(needle) {
            let at = from + n;
            if self.code_at(at, needle) {
                found.push(at);
            }
            from = at + 1;
        }
        found
    }
    /// The end of the bracketed group opening at `open` (`(`, `[` or `{`).
    fn close_of(&self, open: usize) -> usize {
        let b = self.text.as_bytes();
        let (mut depth, mut at) = (0i32, open);
        loop {
            if self.class[at] == Class::Code {
                match b[at] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    return at + 1;
                }
            }
            at += 1;
        }
    }
    fn line(&self, at: usize) -> usize {
        self.text[..at].matches('\n').count() + 1
    }
    /// The identifier starting at `at`.
    fn word(&self, at: usize) -> &str {
        let end = self.text[at..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map_or(self.text.len(), |n| at + n);
        &self.text[at..end]
    }
}

/// What follows a `#[cfg(test)]`-like attribute at `at`, past any further
/// attributes and a visibility: `(module name, #[path] value, body start)`
/// when it declares a module, with `body start` set for an inline one.
fn test_module(lexed: &Lexed<'_>, at: usize) -> Option<(String, Option<String>, Option<usize>)> {
    let mut cursor = lexed.skip(lexed.close_of(at + 1));
    let mut path = None;
    while lexed.code_at(cursor, "#[") {
        let end = lexed.close_of(cursor + 1);
        let inside = lexed.skip(cursor + 2);
        if lexed.code_at(inside, "path") {
            let value = lexed.skip(lexed.skip(inside + 4) + 1);
            path = lexed.literals.get(&value).map(|(_, v)| v.clone());
        }
        cursor = lexed.skip(end);
    }
    if lexed.code_at(cursor, "pub") {
        cursor = lexed.skip(cursor + 3);
        if lexed.code_at(cursor, "(") {
            cursor = lexed.skip(lexed.close_of(cursor));
        }
    }
    if !lexed.code_at(cursor, "mod ") {
        return None;
    }
    cursor = lexed.skip(cursor + 3);
    let name = lexed.word(cursor).to_owned();
    cursor = lexed.skip(cursor + name.len());
    let body = lexed.code_at(cursor, "{").then_some(cursor);
    Some((name, path, body))
}

/// Attribute starts that compile their item only under test.
fn test_cfgs(lexed: &Lexed<'_>) -> Vec<usize> {
    let mut found = lexed.find_code("#[cfg(test)]");
    found.extend(lexed.find_code("#[cfg(all(test"));
    found.sort_unstable();
    found
}

fn sources() -> Vec<(PathBuf, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    for dir in ["workspace_service", "workspace_migration"] {
        for item in walkdir::WalkDir::new(src.join(dir)).sort_by_file_name() {
            let item = item.unwrap();
            if item.path().extension().and_then(|e| e.to_str()) == Some("rs") {
                files.push((
                    item.path().to_path_buf(),
                    std::fs::read_to_string(item.path()).unwrap(),
                ));
            }
        }
    }
    files
}

/// Files that compile only under test: an `#![cfg(test)]` header, a module
/// declared under a test cfg in any scanned file, and every module a
/// test-only file declares in turn.
fn test_only(files: &[(PathBuf, String)]) -> BTreeSet<PathBuf> {
    let mut out = BTreeSet::new();
    for (path, text) in files {
        if text.starts_with("#![cfg(test)]") {
            out.insert(path.clone());
        }
        let lexed = lex(text);
        for at in test_cfgs(&lexed) {
            if let Some((name, declared, None)) = test_module(&lexed, at) {
                let dir = path.parent().unwrap();
                let file = match declared {
                    Some(declared) => dir.join(declared),
                    None if path.file_name().unwrap() == "mod.rs" => dir.join(format!("{name}.rs")),
                    None => continue,
                };
                out.insert(file);
            }
        }
    }
    loop {
        let before = out.len();
        for (path, text) in files {
            if !out.contains(path) {
                continue;
            }
            let lexed = lex(text);
            for at in lexed.find_code("#[path") {
                let value = lexed.skip(lexed.skip(at + "#[path".len()) + 1);
                if let Some((_, declared)) = lexed.literals.get(&value) {
                    out.insert(path.parent().unwrap().join(declared));
                }
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

/// What one call site's SQL argument is.
#[derive(Debug)]
enum Argument {
    Statement(String),
    /// A shipped schema initializer: the frozen text itself.
    Initializer(i64),
}

fn constant(text: &str, name: &str) -> Option<String> {
    let lexed = lex(text);
    for at in lexed.find_code(&format!("const {name}: &str =")) {
        let value = lexed.skip(at + format!("const {name}: &str =").len());
        if let Some((_, value)) = lexed.literals.get(&value) {
            return Some(value.clone());
        }
    }
    None
}

/// The SQL text of the argument starting at `at`, or why it cannot be read.
fn argument(lexed: &Lexed<'_>, at: usize, file: &Path) -> Result<(Argument, usize), String> {
    let at = lexed.skip(at);
    if let Some((end, value)) = lexed.literals.get(&at) {
        return Ok((Argument::Statement(value.clone()), *end));
    }
    if lexed.code_at(at, "&") {
        return argument(lexed, at + 1, file);
    }
    for (macro_name, include) in [("format!(", false), ("include_str!(", true)] {
        if lexed.code_at(at, macro_name) {
            let open = at + macro_name.len() - 1;
            let end = lexed.close_of(open);
            let inner = lexed.skip(open + 1);
            let (literal_end, value) = lexed
                .literals
                .get(&inner)
                .ok_or("the macro's first argument is not a literal")?;
            if lexed.skip(*literal_end) != end - 1 {
                return Err(format!("{macro_name} takes arguments beyond its literal"));
            }
            if include {
                let path = file.parent().unwrap().join(value);
                return Ok((
                    Argument::Statement(std::fs::read_to_string(path).map_err(|e| e.to_string())?),
                    end,
                ));
            }
            let mut expanded = String::new();
            let mut rest = value.as_str();
            while let Some(open) = rest.find('{') {
                expanded.push_str(&rest[..open]);
                let close = rest[open..].find('}').ok_or("unclosed capture")? + open;
                let name = &rest[open + 1..close];
                let text = std::fs::read_to_string(file).unwrap();
                expanded.push_str(
                    &constant(&text, name)
                        .ok_or(format!("capture {name} is not a file constant"))?,
                );
                rest = &rest[close + 1..];
            }
            expanded.push_str(rest);
            return Ok((Argument::Statement(expanded), end));
        }
    }
    let word_end = lexed.text[at..]
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
        .map_or(lexed.text.len(), |n| at + n);
    let path = &lexed.text[at..word_end];
    let last = path.rsplit("::").next().unwrap_or(path);
    let is_schema = path.contains("schema::") || file.ends_with("selected_schema.rs");
    if is_schema {
        let text = match last {
            "V2" => V2,
            "V3" => V3,
            "V4" => V4,
            _ => return Err(format!("{path} is not a shipped schema")),
        };
        return Ok((Argument::Initializer(model_of(text).unwrap().0), word_end));
    }
    Err(format!(
        "`{}` is not SQL text this rail can read",
        path.trim()
    ))
}

const SQL_METHODS: [&str; 10] = [
    "prepare",
    "prepare_cached",
    "execute",
    "execute_batch",
    "query_row",
    "query_row_and_then",
    "pragma_update",
    "pragma_update_and_check",
    "pragma_query_value",
    "pragma_query",
];

/// A call site whose SQL argument the rail cannot read from the source.
struct Unresolved {
    file: String,
    line: usize,
    function: String,
    why: String,
}

struct Found {
    statements: Vec<(String, String)>,
    initializers: Vec<(String, i64)>,
    unresolved: Vec<Unresolved>,
    production_files: Vec<PathBuf>,
}

/// Every production SQL call site in workspace_service/ and
/// workspace_migration/: each rusqlite SQL entry point found in code, with
/// its SQL argument read from the source. A call site this rail cannot read
/// is reported, never skipped.
fn discover() -> Found {
    let files = sources();
    let tests = test_only(&files);
    let mut found = Found {
        statements: Vec::new(),
        initializers: Vec::new(),
        unresolved: Vec::new(),
        production_files: Vec::new(),
    };
    for (path, text) in &files {
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "tests.rs" || name.ends_with("_tests.rs") {
            assert!(tests.contains(path), "{name} must compile only under test");
        }
        if tests.contains(path) {
            continue;
        }
        found.production_files.push(path.clone());
        let lexed = lex(text);
        // Inline test modules are not production.
        let mut excluded = Vec::new();
        for at in test_cfgs(&lexed) {
            if let Some((_, _, Some(body))) = test_module(&lexed, at) {
                excluded.push(at..lexed.close_of(body));
            }
        }
        let rel = path
            .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")))
            .unwrap()
            .display()
            .to_string();
        for method in SQL_METHODS {
            for at in lexed.find_code(&format!(".{method}")) {
                let after = at + 1 + method.len();
                let open = lexed.skip(after);
                if lexed.text[after..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                    || !lexed.code_at(open, "(")
                    || excluded.iter().any(|range| range.contains(&at))
                {
                    continue;
                }
                let site = format!("{rel}:{}", lexed.line(at));
                let resolved = if method.starts_with("pragma") {
                    // pragma_*(schema, "name", …): the schema argument, then a name.
                    let first = lexed.skip(open + 1);
                    let comma =
                        lexed.skip(lexed.text[first..].find(',').map_or(first, |n| first + n) + 1);
                    lexed
                        .literals
                        .get(&comma)
                        .map(|(end, name)| (Argument::Statement(format!("PRAGMA {name}")), *end))
                        .ok_or_else(|| "the pragma name is not a literal".to_owned())
                } else {
                    argument(&lexed, open + 1, path)
                };
                match resolved {
                    Ok((Argument::Statement(sql), _)) => found.statements.push((site, sql)),
                    Ok((Argument::Initializer(version), _)) => {
                        found.initializers.push((site, version))
                    }
                    Err(why) => {
                        let start = lexed.text[..at].rfind("fn ").expect("inside a fn");
                        found.unresolved.push(Unresolved {
                            file: rel.clone(),
                            line: lexed.line(at),
                            function: lexed.word(start + 3).to_owned(),
                            why,
                        });
                    }
                }
            }
        }
    }
    found
}

/// Identifiers an SQL text names, outside its string literals and comments.
fn sql_words(sql: &str) -> BTreeSet<String> {
    let mut words = BTreeSet::new();
    let mut chars = sql.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '\'' => {
                while let Some((_, c)) = chars.next() {
                    if c == '\'' && chars.peek().map(|(_, c)| *c) != Some('\'') {
                        break;
                    }
                    if c == '\'' {
                        chars.next();
                    }
                }
            }
            '-' if sql[at..].starts_with("--") => {
                for (_, c) in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let end = sql[at..]
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .map_or(sql.len(), |n| at + n);
                words.insert(sql[at..end].to_ascii_lowercase());
                while chars.peek().is_some_and(|(n, _)| *n < end) {
                    chars.next();
                }
            }
            _ => {}
        }
    }
    words
}

/// Call sites whose SQL is a parameter by design, each with its reason. An
/// entry that stops matching fails too, so the list cannot go stale.
const PARAMETER_SQL: [(&str, &str, &str); 1] = [(
    "src/workspace_service/selected_schema.rs",
    "model_of",
    "it runs a schema text on its own private in-memory database; production passes only \
     the shipped V2, V3 and V4 texts, which the other tests here hold",
)];

#[test]
fn every_production_statement_prepares_on_each_shipped_store_it_names() {
    let found = discover();
    let explained = |site: &Unresolved| {
        PARAMETER_SQL
            .iter()
            .any(|(file, function, _)| site.file == *file && site.function == *function)
    };
    let unexplained: Vec<String> = found
        .unresolved
        .iter()
        .filter(|site| !explained(site))
        .map(|site| {
            format!(
                "{}:{} in {}: {}",
                site.file, site.line, site.function, site.why
            )
        })
        .collect();
    assert!(
        unexplained.is_empty(),
        "SQL call sites this rail cannot read; give each a literal, a file constant or a \
         shipped schema constant:\n{}",
        unexplained.join("\n")
    );
    for (file, function, why) in PARAMETER_SQL {
        assert!(
            !why.is_empty()
                && found
                    .unresolved
                    .iter()
                    .any(|site| site.file == file && site.function == function),
            "{file} {function} holds no parameter SQL any more; drop its entry"
        );
    }
    for writer in [
        "workspace_service/selected.rs",
        "workspace_service/selected_store.rs",
        "workspace_service/selected_metadata.rs",
        "workspace_migration/selected_sqlite.rs",
    ] {
        assert!(
            found.production_files.iter().any(|p| p.ends_with(writer)),
            "{writer} must be scanned as production"
        );
    }
    assert!(
        found.statements.len() >= 40,
        "found only {} production statements; the discovery is broken",
        found.statements.len()
    );
    for (file, anchor) in [
        (
            "src/workspace_service/selected.rs",
            "UPDATE records SET revision=?1,metadata=?2",
        ),
        (
            "src/workspace_service/selected_store.rs",
            "UPDATE records SET revision=?1,body_hash=?2",
        ),
        (
            "src/workspace_service/selected_metadata.rs",
            "FROM metadata_requests WHERE request_key=?1",
        ),
        (
            "src/workspace_migration/selected_sqlite.rs",
            "INSERT INTO records VALUES",
        ),
    ] {
        assert!(
            found
                .statements
                .iter()
                .any(|(site, sql)| site.starts_with(file) && sql.contains(anchor)),
            "the rail no longer finds {anchor:?} in {file}"
        );
    }
    assert!(
        found.initializers.iter().any(|(site, version)| site
            .starts_with("src/workspace_migration/selected_sqlite.rs")
            && *version == super::super::metadata::schema_version()),
        "the explicit staging initializer is found as a shipped schema"
    );
    // Each identifier's first shipped store, from SQLite's own models.
    let models: BTreeMap<i64, Connection> = shipped()
        .unwrap()
        .keys()
        .map(|version| {
            let text = [V2, V3, V4]
                .into_iter()
                .find(|text| model_of(text).unwrap().0 == *version)
                .unwrap();
            (*version, store(text))
        })
        .collect();
    let mut introduced: BTreeMap<String, i64> = BTreeMap::new();
    for (version, conn) in models.iter().rev() {
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for table in tables {
            introduced.insert(table.clone(), *version);
            let columns: Vec<String> = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            for column in columns {
                introduced.insert(column, *version);
            }
        }
    }
    let oldest = *models.keys().next().unwrap();
    let mut failures = Vec::new();
    for (site, sql) in &found.statements {
        let floor = sql_words(sql)
            .iter()
            .filter_map(|word| introduced.get(word))
            .copied()
            .max()
            .unwrap_or(oldest);
        let mut prepared = BTreeSet::new();
        let mut errors = Vec::new();
        for (version, conn) in &models {
            let mut batch = rusqlite::Batch::new(conn, sql);
            let mut statements = 0;
            let outcome = loop {
                match batch.next() {
                    Ok(Some(_)) => statements += 1,
                    Ok(None) => break Ok(statements),
                    Err(e) => break Err(e.to_string()),
                }
            };
            match outcome {
                Ok(0) => errors.push(format!("store {version}: no statement")),
                Ok(_) => {
                    prepared.insert(*version);
                }
                Err(e) => errors.push(format!("store {version}: {e}")),
            }
        }
        let expected: BTreeSet<i64> = models.keys().copied().filter(|v| *v >= floor).collect();
        if prepared != expected {
            failures.push(format!(
                "{site}: prepares on {prepared:?}, names store {floor}+ so expects {expected:?} \
                 ({}) — {sql}",
                errors.join("; ")
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "statements that do not prepare on the shipped stores they name:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_rail_reads_literals_raw_strings_constants_and_reports_the_rest() {
    let text = r####"
const COLUMNS: &str = "id,path";
fn reads(conn: &Connection) {
    conn.query_row("SELECT id FROM records WHERE path=?1", [], |r| r.get(0));
    conn.prepare(r#"SELECT "path" FROM records"#);
    conn.execute(&format!("SELECT {COLUMNS} FROM records"), []);
    conn.execute_batch("SAVEPOINT a;\
        RELEASE a");
    // conn.execute("a comment is not a call site", []);
    conn.execute(sql, []);
    let lifetime: &'static str = "x"; let c = '"';
}
#[cfg(test)]
mod tests {
    fn inline() { conn.execute("not production", []); }
}
"####;
    let dir = crate::vault::testutil::temp_vault("selected-schema-rail");
    let file = dir.join("probe.rs");
    std::fs::write(&file, text).unwrap();
    let lexed = lex(text);
    let mut seen = Vec::new();
    let excluded: Vec<_> = test_cfgs(&lexed)
        .into_iter()
        .filter_map(|at| {
            test_module(&lexed, at)
                .and_then(|(_, _, body)| body)
                .map(|b| at..lexed.close_of(b))
        })
        .collect();
    for method in SQL_METHODS {
        for at in lexed.find_code(&format!(".{method}(")) {
            if excluded.iter().any(|r| r.contains(&at)) {
                continue;
            }
            seen.push(argument(&lexed, at + method.len() + 2, &file).map(|(a, _)| a));
        }
    }
    let rendered: BTreeSet<String> = seen
        .iter()
        .map(|r| match r {
            Ok(Argument::Statement(sql)) => sql.clone(),
            Ok(Argument::Initializer(v)) => format!("schema {v}"),
            Err(e) => format!("unresolved: {e}"),
        })
        .collect();
    let expected: BTreeSet<String> = [
        "SELECT id FROM records WHERE path=?1",
        "SELECT \"path\" FROM records",
        "SELECT id,path FROM records",
        "SAVEPOINT a;RELEASE a",
        "unresolved: `sql` is not SQL text this rail can read",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(rendered, expected);
    assert_eq!(
        seen.len(),
        5,
        "the comment and the inline test module hold no call site"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
