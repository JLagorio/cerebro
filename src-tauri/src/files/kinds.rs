//! `shared/files/kinds.v1.json` — what a file is (M66.1).
//!
//! One row per extension: its kind, MIME, viewer, extractor, ingest rule,
//! Shiki language, icon, colour, bytes door and open policy, then an
//! `unknown` row for every extension the table does not name, and `names`,
//! exact filenames that override how a file is drawn. TypeScript reads the
//! same bytes through `src/engine/fileKinds.ts` and derives icons, languages
//! and the Inbox's capture rule from them; Rust alone enforces the doors and
//! the open verdict. Names rows are presentation, so Rust validates them and
//! never reads them.
//!
//! Load is STRICT: an unknown or missing field, a value outside its
//! vocabulary, or rows that disagree with each other fail the parse, in the
//! words `fileKinds.ts` uses (both replay the `refusals` in
//! `src-tauri/fixtures/file-kind-cases.json`). The compiled bytes are tested
//! against the committed digest and against the file on disk, the
//! `tools.rs` pattern.

use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

use serde_json::{Map, Value};

/// The table, bound at compile time.
pub const KINDS_JSON: &str = include_str!("../../../shared/files/kinds.v1.json");

/// Repo-relative location, for the tests that read the file on disk.
pub const KINDS_PATH: &str = "shared/files/kinds.v1.json";

/// The committed SHA-256 of the table's bytes. Regenerate it deliberately
/// after an edit (see `write_kinds_digest`).
pub const KINDS_DIGEST_PATH: &str = "shared/files/kinds.v1.sha256";

/// The format this build reads.
pub const FORMAT: u64 = 1;

macro_rules! vocabulary {
    ($(#[$doc:meta])* $name:ident { $($variant:ident => $word:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &[$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $word),+
                }
            }

            fn from_word(word: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|v| v.as_str() == word)
            }
        }
    };
}

vocabulary!(
    /// What a file is.
    Kind {
        Archive => "archive",
        Audio => "audio",
        Binary => "binary",
        Code => "code",
        Data => "data",
        Design => "design",
        Diagram => "diagram",
        Document => "document",
        Executable => "executable",
        Font => "font",
        Image => "image",
        Markdown => "markdown",
        Pdf => "pdf",
        Presentation => "presentation",
        Spreadsheet => "spreadsheet",
        Text => "text",
        Unknown => "unknown",
        Video => "video",
        Whiteboard => "whiteboard",
    }
);

vocabulary!(
    /// Which viewer draws the file inside the app.
    Viewer {
        Code => "code",
        Doc => "doc",
        Image => "image",
        Media => "media",
        None => "none",
        Pdf => "pdf",
        Table => "table",
    }
);

vocabulary!(
    /// Which reader turns the file into text.
    Extractor {
        Docx => "docx",
        Pdf => "pdf",
        Pptx => "pptx",
        Xlsx => "xlsx",
    }
);

vocabulary!(
    /// Whether the Inbox takes the file: as text, through an extractor or import preview, or not.
    Ingest {
        Capture => "capture",
        Extract => "extract",
        Import => "import",
        None => "none",
    }
);

vocabulary!(
    /// How the file's bytes reach the webview: the file scheme (media only),
    /// raw IPC (PDFs only), or not at all.
    Door {
        Scheme => "scheme",
        Ipc => "ipc",
        None => "none",
    }
);

vocabulary!(
    /// Whether the file may open in its default app outside Cerebro.
    OpenPolicy {
        Allow => "allow",
        Confirm => "confirm",
        Deny => "deny",
    }
);

/// The colours a row may name, as DS token suffixes.
const COLORS: &[&str] = &[
    "blue", "green", "n-400", "n-500", "orange", "pink", "purple", "red", "yellow",
];

const TOP_KEYS: &[&str] = &[
    "format",
    "artifact_version",
    "limits",
    "unknown",
    "kinds",
    "names",
];
const LIMIT_KEYS: &[&str] = &["capture_max_bytes", "attachment_bytes", "import_max_bytes"];
const ROW_KEYS: &[&str] = &[
    "ext",
    "kind",
    "mime",
    "viewer",
    "extractor",
    "ingest",
    "shiki",
    "icon",
    "color",
    "bytes",
    "open",
];
const NAME_KEYS: &[&str] = &["name", "icon", "color", "shiki"];
const NULLABLE: &[&str] = &["extractor", "shiki", "color"];
const VOCAB_ORDER: &[&str] = &[
    "kind",
    "viewer",
    "extractor",
    "ingest",
    "bytes",
    "open",
    "color",
];
const UNKNOWN_ROW: &[(&str, Option<&str>)] = &[
    ("kind", Some("unknown")),
    ("mime", Some("application/octet-stream")),
    ("viewer", Some("code")),
    ("extractor", None),
    ("ingest", Some("none")),
    ("shiki", None),
    ("icon", Some("file")),
    ("color", None),
    ("bytes", Some("none")),
    ("open", Some("confirm")),
];

/// One extension's facts. The unknown row has an empty `ext`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindRow {
    pub ext: String,
    pub kind: Kind,
    pub mime: String,
    pub viewer: Viewer,
    pub extractor: Option<Extractor>,
    pub ingest: Ingest,
    pub shiki: Option<String>,
    pub icon: String,
    pub color: Option<String>,
    pub bytes: Door,
    pub open: OpenPolicy,
}

/// The table's caps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// The largest file the Inbox captures as text.
    pub capture_max_bytes: u64,
    pub attachment_bytes: u64,
    pub import_max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindTable {
    pub format: u64,
    pub artifact_version: u64,
    pub limits: Limits,
    pub unknown: KindRow,
    /// Sorted by `ext`, no repeat.
    pub kinds: Vec<KindRow>,
    /// The filename overrides, by name only: they are presentation.
    pub names: Vec<String>,
}

fn object<'a>(v: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("kinds: {label} must be an object"))
}

/// Missing keys in the expected order first, then unknown keys sorted.
fn keys(
    o: &Map<String, Value>,
    label: &str,
    required: &[&str],
    allowed: &[&str],
) -> Result<(), String> {
    if let Some(k) = required.iter().find(|k| !o.contains_key(**k)) {
        return Err(format!("kinds: {label} is missing {k}"));
    }
    let mut stray: Vec<&str> = o
        .keys()
        .map(String::as_str)
        .filter(|k| !allowed.contains(k))
        .collect();
    stray.sort_unstable();
    match stray.first() {
        Some(k) => Err(format!("kinds: {label} has an unknown field {k}")),
        None => Ok(()),
    }
}

fn strings(o: &Map<String, Value>, label: &str, fields: &[&str]) -> Result<(), String> {
    for f in fields {
        let Some(v) = o.get(*f) else { continue };
        if NULLABLE.contains(f) {
            if !v.is_null() && !v.is_string() {
                return Err(format!("kinds: {label} {f} must be a string or null"));
            }
        } else if !v.is_string() {
            return Err(format!("kinds: {label} {f} must be a string"));
        }
    }
    Ok(())
}

fn in_vocabulary(field: &str, word: &str) -> bool {
    match field {
        "kind" => Kind::from_word(word).is_some(),
        "viewer" => Viewer::from_word(word).is_some(),
        "extractor" => Extractor::from_word(word).is_some(),
        "ingest" => Ingest::from_word(word).is_some(),
        "bytes" => Door::from_word(word).is_some(),
        "open" => OpenPolicy::from_word(word).is_some(),
        "color" => COLORS.contains(&word),
        _ => false,
    }
}

fn vocab(o: &Map<String, Value>, label: &str) -> Result<(), String> {
    for f in VOCAB_ORDER {
        let Some(v) = o.get(*f) else { continue };
        let Some(word) = v.as_str() else { continue };
        if !in_vocabulary(f, word) {
            return Err(format!("kinds: {label} has an unknown {f} {word}"));
        }
    }
    Ok(())
}

fn not_empty(o: &Map<String, Value>, label: &str) -> Result<(), String> {
    if o.get("icon").and_then(Value::as_str) == Some("") {
        return Err(format!("kinds: {label} has an empty icon"));
    }
    if o.get("shiki").and_then(Value::as_str) == Some("") {
        return Err(format!("kinds: {label} has an empty shiki"));
    }
    Ok(())
}

fn positive(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_u64).filter(|n| *n > 0)
}

/// `^[a-z0-9]+$`.
fn is_ext(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// A lowercase `type/subtype`, each part a token starting with a letter or
/// digit (the TS reader's regex, spelled out).
fn is_mime(s: &str) -> bool {
    let token = |t: &str| {
        let mut bytes = t.bytes();
        matches!(bytes.next(), Some(b) if b.is_ascii_lowercase() || b.is_ascii_digit())
            && bytes
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$&^_.+-".contains(&b))
    };
    match s.split_once('/') {
        Some((kind, sub)) => token(kind) && token(sub),
        None => false,
    }
}

fn text(o: &Map<String, Value>, key: &str) -> String {
    o.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional(o: &Map<String, Value>, key: &str) -> Option<String> {
    o.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A checked row's typed form. Only called after `strings` and `vocab`, so
/// every word is known.
fn typed(o: &Map<String, Value>, ext: &str) -> KindRow {
    let word = |key: &str| o.get(key).and_then(Value::as_str).unwrap_or_default();
    KindRow {
        ext: ext.to_string(),
        kind: Kind::from_word(word("kind")).unwrap_or(Kind::Unknown),
        mime: text(o, "mime"),
        viewer: Viewer::from_word(word("viewer")).unwrap_or(Viewer::Code),
        extractor: o
            .get("extractor")
            .and_then(Value::as_str)
            .and_then(Extractor::from_word),
        ingest: Ingest::from_word(word("ingest")).unwrap_or(Ingest::None),
        shiki: optional(o, "shiki"),
        icon: text(o, "icon"),
        color: optional(o, "color"),
        bytes: Door::from_word(word("bytes")).unwrap_or(Door::None),
        open: OpenPolicy::from_word(word("open")).unwrap_or(OpenPolicy::Confirm),
    }
}

fn check_row(o: &Map<String, Value>, ext: &str) -> Result<(), String> {
    let mime = text(o, "mime");
    if !is_mime(&mime) {
        return Err(format!(
            "kinds: {ext} mime {mime} is not a lowercase type/subtype"
        ));
    }
    not_empty(o, ext)?;
    let row = typed(o, ext);
    if row.bytes == Door::Scheme && !matches!(row.kind, Kind::Image | Kind::Audio | Kind::Video) {
        return Err(format!(
            "kinds: {ext} serves bytes by scheme but is not an image, audio or video"
        ));
    }
    if row.bytes == Door::Ipc && row.kind != Kind::Pdf {
        return Err(format!("kinds: {ext} serves bytes by ipc but is not a pdf"));
    }
    if row.ingest == Ingest::Capture && !matches!(row.kind, Kind::Markdown | Kind::Text) {
        return Err(format!(
            "kinds: {ext} is captured but is not markdown or text"
        ));
    }
    if row.ingest == Ingest::Import && row.kind != Kind::Data {
        return Err(format!("kinds: {ext} is imported but is not data"));
    }
    if row.ingest == Ingest::Extract && row.extractor.is_none() {
        return Err(format!("kinds: {ext} is extracted but names no extractor"));
    }
    if row.extractor.is_some()
        && !matches!(
            row.kind,
            Kind::Pdf | Kind::Document | Kind::Presentation | Kind::Spreadsheet
        )
    {
        return Err(format!(
            "kinds: {ext} names an extractor but is not a pdf, document, presentation or spreadsheet"
        ));
    }
    Ok(())
}

/// Parse and check a table, refusing in the words `fileKinds.ts` uses.
pub fn parse(raw: &str) -> Result<KindTable, String> {
    let value: Value = serde_json::from_str(raw).map_err(|e| format!("kinds: {e}"))?;
    let top = object(&value, "the table")?;
    keys(top, "the table", TOP_KEYS, TOP_KEYS)?;
    let format = &top["format"];
    if format.as_u64() != Some(FORMAT) {
        return Err(format!("kinds: format must be {FORMAT}, not {format}"));
    }
    let artifact_version = positive(top.get("artifact_version"))
        .ok_or("kinds: artifact_version must be a positive integer")?;

    let limits = object(&top["limits"], "limits")?;
    keys(limits, "limits", LIMIT_KEYS, LIMIT_KEYS)?;
    for k in LIMIT_KEYS {
        if positive(limits.get(*k)).is_none() {
            return Err(format!("kinds: limits {k} must be a positive integer"));
        }
    }
    let limits = Limits {
        capture_max_bytes: positive(limits.get("capture_max_bytes")).unwrap_or_default(),
        import_max_bytes: positive(limits.get("import_max_bytes")).unwrap_or_default(),
        attachment_bytes: positive(limits.get("attachment_bytes")).unwrap_or_default(),
    };

    let unknown = object(&top["unknown"], "unknown")?;
    let unknown_keys = &ROW_KEYS[1..];
    keys(unknown, "unknown", unknown_keys, unknown_keys)?;
    strings(unknown, "unknown", unknown_keys)?;
    if UNKNOWN_ROW
        .iter()
        .any(|(k, want)| unknown[*k].as_str() != *want)
    {
        return Err(
            "kinds: the unknown row must be kind unknown, application/octet-stream, \
                    viewer code, no extractor, ingest none, no shiki, icon file, no color, \
                    bytes none, open confirm"
                .into(),
        );
    }
    let unknown = typed(unknown, "");

    let rows = top["kinds"]
        .as_array()
        .ok_or("kinds: kinds must be a list")?;
    let mut kinds: Vec<KindRow> = Vec::with_capacity(rows.len());
    for (i, value) in rows.iter().enumerate() {
        let row = object(value, &format!("kinds[{i}]"))?;
        let label = match row.get("ext").and_then(Value::as_str) {
            Some(ext) => ext.to_string(),
            None => format!("kinds[{i}]"),
        };
        keys(row, &label, ROW_KEYS, ROW_KEYS)?;
        strings(row, &label, ROW_KEYS)?;
        let ext = text(row, "ext");
        if !is_ext(&ext) {
            return Err(format!("kinds: ext {ext} must match ^[a-z0-9]+$"));
        }
        if let Some(prev) = kinds.last() {
            if prev.ext == ext {
                return Err(format!("kinds: ext {ext} is listed twice"));
            }
            if prev.ext > ext {
                return Err(format!("kinds: ext {ext} is out of order"));
            }
        }
        vocab(row, &ext)?;
        check_row(row, &ext)?;
        kinds.push(typed(row, &ext));
    }

    let rows = top["names"]
        .as_array()
        .ok_or("kinds: names must be a list")?;
    let mut names: Vec<String> = Vec::with_capacity(rows.len());
    for (i, value) in rows.iter().enumerate() {
        let row = object(value, &format!("names[{i}]"))?;
        let label = match row.get("name").and_then(Value::as_str) {
            Some(name) => name.to_string(),
            None => format!("names[{i}]"),
        };
        keys(row, &label, &["name"], NAME_KEYS)?;
        strings(row, &label, NAME_KEYS)?;
        let name = text(row, "name");
        if name.is_empty() || name.bytes().any(|b| b.is_ascii_uppercase()) || name.contains('/') {
            return Err(format!(
                "kinds: name {name} must be lowercase with no slash"
            ));
        }
        if let Some(prev) = names.last() {
            if *prev == name {
                return Err(format!("kinds: name {name} is listed twice"));
            }
            if *prev > name {
                return Err(format!("kinds: name {name} is out of order"));
            }
        }
        if !["icon", "color", "shiki"]
            .iter()
            .any(|k| row.contains_key(*k))
        {
            return Err(format!("kinds: name {name} overrides nothing"));
        }
        vocab(row, &name)?;
        not_empty(row, &name)?;
        names.push(name);
    }

    Ok(KindTable {
        format: FORMAT,
        artifact_version,
        limits,
        unknown,
        kinds,
        names,
    })
}

/// The compiled-in table. `the_shipped_table_validates` loads the same
/// bytes, so a failure here is a build nobody tested.
pub fn table() -> &'static KindTable {
    static LOADED: OnceLock<KindTable> = OnceLock::new();
    LOADED.get_or_init(|| parse(KINDS_JSON).expect("the compiled file-kind table validates"))
}

/// The table's caps.
pub fn limits() -> &'static Limits {
    &table().limits
}

/// The extension: the last path segment, ASCII-lowercased, after its last
/// dot. None when there is no dot, or the dot is the segment's first or last
/// character (`.env`, `notes.`). `extOf` in `fileKinds.ts` says the same.
pub fn ext_of(name: &str) -> Option<String> {
    let base = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    match base.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < base.len() => Some(base[dot + 1..].to_string()),
        _ => None,
    }
}

/// The row the table names for this path's extension, if any.
fn row_for(name: &str) -> Option<&'static KindRow> {
    let ext = ext_of(name)?;
    let kinds = &table().kinds;
    kinds
        .binary_search_by(|row| row.ext.as_str().cmp(ext.as_str()))
        .ok()
        .map(|i| &kinds[i])
}

/// The row for a path's extension, or the unknown row.
pub fn lookup(name: &str) -> &'static KindRow {
    row_for(name).unwrap_or(&table().unknown)
}

/// One answer to whether a path names a JSON Canvas board.
pub fn is_whiteboard(name: &str) -> bool {
    lookup(name).kind == Kind::Whiteboard
}

/// The heads that mark a program, whatever the file is called: a `#!`
/// script, ELF, Mach-O (both widths, both byte orders), a fat Mach-O or a Java
/// class (`CAFEBABE`), and a PE (`MZ`).
const SIGNS: &[&[u8]] = &[
    b"#!",
    &[0x7F, 0x45, 0x4C, 0x46],
    &[0xFE, 0xED, 0xFA, 0xCE],
    &[0xFE, 0xED, 0xFA, 0xCF],
    &[0xCE, 0xFA, 0xED, 0xFE],
    &[0xCF, 0xFA, 0xED, 0xFE],
    &[0xCA, 0xFE, 0xBA, 0xBE],
    b"MZ",
];

fn has_sign(head: &[u8]) -> bool {
    SIGNS.iter().any(|sign| head.starts_with(sign))
}

fn head(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(4);
    std::fs::File::open(path)?.take(4).read_to_end(&mut head)?;
    Ok(head)
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Whether the file at `path` may open in its default app: the one reader of
/// the table's `open` column.
///
/// A regular file whose first bytes are a program's sign is Deny, whatever
/// its row says. A deny row is Deny. A regular file with an execute bit and
/// no row is Deny, but an execute bit on a known row is not a verdict:
/// exFAT and SMB volumes mark every file executable. Otherwise the row
/// decides, and an unknown extension confirms. A path that cannot be read
/// is Deny: the verdict never guesses. A folder (an `.app` or a `.pages`
/// bundle) is judged by its row alone.
pub fn open_policy(path: &Path) -> OpenPolicy {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Ok(meta) = std::fs::metadata(path) else {
        return OpenPolicy::Deny;
    };
    let bytes = if meta.is_file() {
        head(path).ok()
    } else {
        None
    };
    open_policy_for(&name, &meta, bytes.as_deref())
}

/// The same verdict for an already-open file. Media readers supply its own
/// metadata and sniffed head, so deciding the verdict never reopens a path.
pub(crate) fn open_policy_for(
    name: &str,
    meta: &std::fs::Metadata,
    head: Option<&[u8]>,
) -> OpenPolicy {
    let row = row_for(name);
    if meta.is_file() {
        match head {
            Some(head) if !has_sign(head) => {}
            _ => return OpenPolicy::Deny,
        }
        if row.is_none() && executable(meta) {
            return OpenPolicy::Deny;
        }
    }
    row.unwrap_or(&table().unknown).open
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(rel: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel)
    }

    fn cases() -> Value {
        let raw = std::fs::read_to_string(repo("src-tauri/fixtures/file-kind-cases.json"))
            .expect("read file-kind-cases.json");
        serde_json::from_str(&raw).expect("file-kind-cases.json is JSON")
    }

    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        let committed = std::fs::read_to_string(repo(KINDS_DIGEST_PATH))
            .expect("read the committed file-kind digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(KINDS_JSON.as_bytes()),
            committed,
            "the table changed without regenerating {KINDS_DIGEST_PATH} — run \
             `cargo test --lib files::kinds::tests::write_kinds_digest -- --ignored`"
        );
    }

    /// Re-stamp the digest after a deliberate table edit.
    #[test]
    #[ignore = "run explicitly after a deliberate file-kind table edit"]
    fn write_kinds_digest() {
        let digest = crate::ledger::sha256_hex(KINDS_JSON.as_bytes());
        std::fs::write(repo(KINDS_DIGEST_PATH), format!("{digest}\n")).unwrap();
    }

    #[test]
    fn the_compiled_table_is_the_file_on_disk() {
        // `include_str!` binds at compile time; a stale build that disagreed
        // with the tree would make every other test here meaningless.
        let disk = std::fs::read_to_string(repo(KINDS_PATH)).expect("read the file-kind table");
        assert_eq!(disk, KINDS_JSON);
    }

    #[test]
    fn the_shipped_table_validates() {
        let t = parse(KINDS_JSON).expect("the committed file-kind table must load");
        assert_eq!(t.format, FORMAT);
        assert!(!t.kinds.is_empty());
        assert!(!t.names.is_empty());
        assert_eq!(limits().capture_max_bytes, 4 * 1024 * 1024);
    }

    #[test]
    fn replays_the_shared_kind_cases() {
        let cases = cases();
        let kinds = cases["kinds"].as_array().expect("kinds cases");
        assert!(!kinds.is_empty());
        for case in kinds {
            let name = case["name"].as_str().unwrap();
            assert_eq!(ext_of(name).as_deref(), case["ext"].as_str(), "{name}: ext");
            let row = lookup(name);
            for (field, got) in [
                ("kind", row.kind.as_str()),
                ("mime", row.mime.as_str()),
                ("viewer", row.viewer.as_str()),
                ("bytes", row.bytes.as_str()),
                ("open", row.open.as_str()),
            ] {
                assert_eq!(Some(got), case[field].as_str(), "{name}: {field}");
            }
            assert_eq!(
                row.ingest == Ingest::Capture,
                case["capture"].as_bool().unwrap(),
                "{name}: capture"
            );
        }
    }

    /// Apply one refusal case's edit to the shipped table. A path segment
    /// under `kinds` or `names` picks the row by its ext or name.
    fn edited(case: &Value) -> String {
        let mut table: Value = serde_json::from_str(KINDS_JSON).unwrap();
        let at: Vec<&str> = case["at"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        let (last, path) = at.split_last().unwrap();
        let mut here = &mut table;
        for seg in path {
            here = step(here, seg);
        }
        let delete = case.get("delete").and_then(Value::as_bool) == Some(true);
        match here {
            Value::Array(rows) => {
                let i = pick(rows, last);
                if delete {
                    rows.remove(i);
                } else {
                    rows[i] = case["set"].clone();
                }
            }
            Value::Object(map) => {
                if delete {
                    map.shift_remove(*last);
                } else {
                    map.insert(last.to_string(), case["set"].clone());
                }
            }
            _ => panic!("{at:?} does not reach a row or an object"),
        }
        serde_json::to_string(&table).unwrap()
    }

    fn pick(rows: &[Value], key: &str) -> usize {
        rows.iter()
            .position(|r| r["ext"].as_str() == Some(key) || r["name"].as_str() == Some(key))
            .unwrap_or_else(|| panic!("no row {key}"))
    }

    fn step<'a>(here: &'a mut Value, seg: &str) -> &'a mut Value {
        match here {
            Value::Array(rows) => {
                let i = pick(rows, seg);
                &mut rows[i]
            }
            Value::Object(map) => map.get_mut(seg).unwrap_or_else(|| panic!("no key {seg}")),
            _ => panic!("cannot step into {seg}"),
        }
    }

    const RULES: &[&str] = &[
        "format",
        "fields",
        "ext",
        "ext_order",
        "name",
        "vocabulary",
        "mime",
        "door",
        "ingest",
        "extractor",
        "unknown_row",
        "limit",
        "empty",
    ];

    fn replay_refusals(rule: &str) {
        let cases = cases();
        let mine: Vec<&Value> = cases["refusals"]
            .as_array()
            .expect("refusal cases")
            .iter()
            .filter(|c| c["rule"] == rule)
            .collect();
        assert!(!mine.is_empty(), "no refusal case for {rule}");
        for case in mine {
            let want = case["error"].as_str().unwrap();
            assert_eq!(parse(&edited(case)).err().as_deref(), Some(want), "{rule}");
        }
    }

    #[test]
    fn every_refusal_case_names_a_rule_these_tests_replay() {
        for case in cases()["refusals"].as_array().unwrap() {
            let rule = case["rule"].as_str().unwrap();
            assert!(RULES.contains(&rule), "unreplayed rule {rule}");
        }
    }

    #[test]
    fn refuses_a_format_other_than_1() {
        replay_refusals("format");
    }

    #[test]
    fn refuses_an_unknown_or_missing_field() {
        replay_refusals("fields");
    }

    #[test]
    fn refuses_an_ext_outside_lowercase_letters_and_digits() {
        replay_refusals("ext");
    }

    #[test]
    fn refuses_exts_out_of_order_or_repeated() {
        replay_refusals("ext_order");
    }

    #[test]
    fn refuses_a_bad_name_row() {
        replay_refusals("name");
    }

    #[test]
    fn refuses_a_value_outside_its_vocabulary() {
        replay_refusals("vocabulary");
    }

    #[test]
    fn refuses_a_mime_that_is_not_lowercase_type_and_subtype() {
        replay_refusals("mime");
    }

    #[test]
    fn refuses_a_door_off_its_kinds() {
        replay_refusals("door");
    }

    #[test]
    fn refuses_an_ingest_off_its_kinds() {
        replay_refusals("ingest");
    }

    #[test]
    fn refuses_an_extractor_off_its_kinds() {
        replay_refusals("extractor");
    }

    #[test]
    fn refuses_any_other_unknown_row() {
        replay_refusals("unknown_row");
    }

    #[test]
    fn refuses_a_limit_that_is_not_positive() {
        replay_refusals("limit");
    }

    #[test]
    fn refuses_an_empty_icon_or_shiki() {
        replay_refusals("empty");
    }

    #[test]
    fn the_unknown_row_confirms() {
        let unknown = lookup("notes.xyz");
        assert_eq!(unknown, &table().unknown);
        assert_eq!(unknown.kind, Kind::Unknown);
        assert_eq!(unknown.open, OpenPolicy::Confirm);
        assert_eq!(lookup("no-extension").open, OpenPolicy::Confirm);
    }

    #[test]
    fn the_scan_set_is_markdown_diagram_and_whiteboard() {
        // The vault lists its page and diagram formats plus the shared
        // whiteboard kind. Attachment kinds remain outside the scan.
        assert_eq!(lookup("a.md").kind, Kind::Markdown);
        assert_eq!(lookup("a.mmd").kind, Kind::Diagram);
        assert!(is_whiteboard("a.canvas"));
        assert!(is_whiteboard("a.CANVAS"));
    }

    #[cfg(unix)]
    #[test]
    fn open_policy_reads_signs_rows_and_the_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cerebro-file-kinds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cases = cases();
        let open = cases["open"].as_array().expect("open cases");
        assert!(!open.is_empty());
        for (i, case) in open.iter().enumerate() {
            let name = case["name"].as_str().unwrap();
            let sub = dir.join(i.to_string());
            std::fs::create_dir_all(&sub).unwrap();
            let path = sub.join(name);
            let hex = case["head"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|j| u8::from_str_radix(&hex[j..j + 2], 16).unwrap())
                .collect();
            std::fs::write(&path, bytes).unwrap();
            let mode = u32::from_str_radix(case["mode"].as_str().unwrap(), 8).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(
                open_policy(&path).as_str(),
                case["verdict"].as_str().unwrap(),
                "{name} at {mode:o}: {}",
                case["why"]
            );
        }
        // A path that is not there never opens; a bundle folder is its row.
        assert_eq!(open_policy(&dir.join("missing.txt")), OpenPolicy::Deny);
        let bundle = dir.join("Deck.key");
        std::fs::create_dir_all(&bundle).unwrap();
        assert_eq!(open_policy(&bundle), OpenPolicy::Allow);
        let app = dir.join("Tool.app");
        std::fs::create_dir_all(&app).unwrap();
        assert_eq!(open_policy(&app), OpenPolicy::Deny);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
