//! Selected-store staging into new inactive roots. No activation or IPC door.
use super::{format_gate, selected_sqlite};
use crate::workspace_service::{
    types::values::{PropertyValue, RelationResolution},
    value,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageError {
    /// Operational policy code; `kind` is a bounded diagnostic, not a new destiny.
    pub code: &'static str,
    pub kind: &'static str,
    pub message: String,
}
pub type StageResult<T> = Result<T, StageError>;
pub(super) fn error(kind: &'static str, message: impl Into<String>) -> StageError {
    StageError {
        code: "capability_unavailable",
        kind,
        message: message.into(),
    }
}
fn io_error(e: std::io::Error) -> StageError {
    error("io_unavailable", e.to_string())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Limits {
    pub entries: usize,
    pub files: usize,
    pub depth: usize,
    pub file_bytes: u64,
    pub total_bytes: u64,
    pub metadata_bytes: usize,
    pub database_bytes: u64,
    pub manifest_bytes: u64,
    pub marker_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExcludedFilenamePattern {
    directory: String,
    prefix: String,
    suffix: String,
    reason: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rules {
    pub format: u32,
    pub authority: String,
    pub marker: String,
    pub manifest: String,
    pub database: String,
    pub archive: String,
    pub limits: Limits,
    excluded_components: BTreeMap<String, String>,
    excluded_paths: BTreeMap<String, String>,
    excluded_filename_patterns: Vec<ExcludedFilenamePattern>,
    private_filename_prefixes: Vec<String>,
    retained_conversion_prefixes: Vec<String>,
    activation_blockers: Vec<String>,
}
pub(super) fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let r: Rules =
            serde_json::from_str(include_str!("../../../shared/workspace/staging.v1.json"))
                .expect("shipped staging rules");
        assert_eq!(r.format, 1);
        assert_eq!(r.marker, format_gate::FORMAT_MARKER);
        assert!(r.limits.files > 0 && r.limits.entries >= r.limits.files && r.limits.depth > 0);
        assert!(r.limits.file_bytes <= r.limits.total_bytes && r.limits.metadata_bytes > 0);
        r
    })
}
/// Internal proposal, not a deserializable authorized mutation or a YAML codec.
#[derive(Debug, Clone)]
pub struct RecordProposal {
    pub id: String,
    pub path: String,
    pub body_start: usize,
    pub metadata_json: String,
    pub required_parts: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EntryKind {
    File,
    Directory,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceEntry {
    path: String,
    kind: EntryKind,
    exclusion: Option<String>,
    bytes: Option<u64>,
    hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Disposition {
    Converted,
    Retained,
    Excluded,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileDisposition {
    path: String,
    disposition: Disposition,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecordInfo {
    pub id: String,
    pub path: String,
    pub body_start: usize,
    pub revision: u64,
    pub body_hash: String,
    pub metadata_hash: String,
    pub required_parts: Vec<String>,
}
#[derive(Debug, Clone)]
pub(super) struct RecordData {
    pub info: RecordInfo,
    pub metadata: String,
}
#[derive(Debug)]
pub struct StagePlan {
    source: PathBuf,
    workspace_id: String,
    inventory: Vec<SourceEntry>,
    records: Vec<RecordData>,
}
impl StagePlan {
    pub(super) fn check_reviewed_sources(
        &self,
        expected: &BTreeMap<&str, &str>,
    ) -> StageResult<()> {
        let captured: BTreeMap<_, _> = self
            .inventory
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        if expected.iter().any(|(path, hash)| {
            !captured.get(path).is_some_and(|entry| {
                entry.kind == EntryKind::File
                    && entry.exclusion.is_none()
                    && entry.hash.as_deref() == Some(*hash)
            })
        }) {
            return Err(error(
                "stale_inventory",
                "The captured stage sources differ from the reviewed semantic inputs.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Location {
    Body,
    Metadata,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Part {
    location: Location,
    path: String,
    bytes: u64,
    hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: u32,
    workspace_id: String,
    source: PathBuf,
    bodies: PathBuf,
    metadata: PathBuf,
    inventory: Vec<SourceEntry>,
    dispositions: Vec<FileDisposition>,
    records: Vec<RecordInfo>,
    parts: Vec<Part>,
}
#[derive(Debug)]
pub struct StagedConversion {
    manifest: Manifest,
    manifest_hash: String,
}
#[derive(Debug)]
pub struct StageValidation {
    pub whole_root_accounted: bool,
    pub activation_blockers: Vec<String>,
}
pub(super) fn canonical_root(root: &Path) -> StageResult<PathBuf> {
    let meta = fs::symlink_metadata(root).map_err(io_error)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(error("invalid_root", "A real directory is required."));
    }
    fs::canonicalize(root).map_err(io_error)
}
pub(super) fn valid_path(path: &str) -> StageResult<()> {
    if crate::files::bytes::rel_refusal("migration", path).is_some() {
        return Err(error(
            "invalid_path",
            "A contained relative path is required.",
        ));
    }
    Ok(())
}
pub(super) fn read_bounded(root: &Path, rel: &str, cap: u64) -> StageResult<Vec<u8>> {
    valid_path(rel)?;
    let opened = crate::files::bytes::open_in(root, "migration", rel).map_err(|_| {
        error(
            "read_unavailable",
            "A required file is unavailable or outside its root.",
        )
    })?;
    if opened.path != root.join(rel) {
        return Err(error("symlink", "Symlink reads are unsupported."));
    }
    let mut file = opened.file;
    let before = file.metadata().map_err(io_error)?;
    if !before.is_file() || before.len() > cap {
        return Err(error("source_limit", "Required file exceeds its bound."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let after = file.metadata().map_err(io_error)?;
    if bytes.len() as u64 > cap {
        return Err(error("source_limit", "Required file exceeds its bound."));
    }
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || after.len() != bytes.len() as u64
    {
        return Err(error(
            "stale_inventory",
            "A required file changed during its read.",
        ));
    }
    Ok(bytes)
}
// Reuse Cerebro's existing filesystem-name fold, never a second name policy.
// This is for reserved identities only; ordinary path bytes/extensions stay intact.
pub(super) fn folded_path(path: &str) -> String {
    crate::knowledge::disk_folded(&path.nfc().collect::<String>())
}
pub(super) fn exclusion(path: &str) -> Option<String> {
    let lower = folded_path(path);
    for component in lower.split('/') {
        if let Some(reason) = rules().excluded_components.get(component) {
            return Some(reason.clone());
        }
        if rules()
            .private_filename_prefixes
            .iter()
            .any(|p| component == p || component.starts_with(&format!("{p}.")))
        {
            return Some("private_credentials".into());
        }
    }
    if let Some((_, reason)) = rules()
        .excluded_paths
        .iter()
        .find(|(p, _)| lower == **p || lower.starts_with(&format!("{p}/")))
    {
        return Some(reason.clone());
    }
    if let Some((directory, filename)) = lower.rsplit_once('/') {
        if let Some(pattern) = rules().excluded_filename_patterns.iter().find(|pattern| {
            directory == pattern.directory
                && filename.strip_prefix(&pattern.prefix).is_some_and(|rest| {
                    rest.strip_suffix(&pattern.suffix)
                        .is_some_and(|middle| !middle.is_empty())
                })
        }) {
            return Some(pattern.reason.clone());
        }
    }
    // This stage has no private-mail admission. Reuse the table's path vocabulary;
    // do not reinterpret general gitignore rules as migration authority.
    crate::policy::mail::is_kept_out_of_git(&lower)
        .then(|| "private_mail_requires_separate_admission".into())
}
fn discover(root: &Path) -> StageResult<Vec<SourceEntry>> {
    if canonical_root(root)? != root {
        return Err(error("root_changed", "Source root binding changed."));
    }
    let mut entries = Vec::new();
    let mut names = BTreeSet::new();
    let mut total = 0_u64;
    let mut files = 0;
    for item in walkdir::WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .max_depth(rules().limits.depth + 1)
    {
        let item =
            item.map_err(|_| error("read_unavailable", "Source discovery was incomplete."))?;
        if entries.len() >= rules().limits.entries || item.depth() > rules().limits.depth {
            return Err(error(
                "source_limit",
                "Source discovery exceeds its entry/depth limit.",
            ));
        }
        let path = item
            .path()
            .strip_prefix(root)
            .ok()
            .and_then(Path::to_str)
            .ok_or_else(|| error("invalid_path", "Source path is not supported UTF-8."))?
            .to_owned();
        valid_path(&path)?;
        if !names.insert(folded_path(&path)) {
            return Err(error(
                "path_collision",
                "Source paths collide under normalized comparison.",
            ));
        }
        let kind = item.file_type();
        if kind.is_symlink() || !(kind.is_file() || kind.is_dir()) {
            return Err(error(
                "unsupported_file",
                "Symlinks and special files prevent complete discovery.",
            ));
        }
        let excluded = exclusion(&path);
        let (bytes, hash) = if kind.is_file() {
            files += 1;
            if files > rules().limits.files {
                return Err(error(
                    "source_limit",
                    "Source discovery exceeds its file limit.",
                ));
            }
            if excluded.is_some() {
                (None, None)
            } else {
                let bytes = read_bounded(
                    root,
                    &path,
                    rules()
                        .limits
                        .file_bytes
                        .min(rules().limits.total_bytes.saturating_sub(total)),
                )?;
                total += bytes.len() as u64;
                (
                    Some(bytes.len() as u64),
                    Some(crate::ledger::sha256_hex(&bytes)),
                )
            }
        } else {
            (None, None)
        };
        entries.push(SourceEntry {
            path,
            kind: if kind.is_file() {
                EntryKind::File
            } else {
                EntryKind::Directory
            },
            exclusion: excluded,
            bytes,
            hash,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
fn id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}
fn check_relations(value: &PropertyValue, ids: &BTreeSet<String>) -> StageResult<()> {
    match value {
        PropertyValue::Relation {
            resolution: RelationResolution::Resolved { target_id },
            ..
        } if !ids.contains(target_id) => {
            return Err(error(
                "missing_relation_identity",
                "A resolved relation has no converted target identity.",
            ))
        }
        PropertyValue::Array { value } => {
            for v in value {
                check_relations(v, ids)?;
            }
        }
        PropertyValue::Object { value } => {
            for v in value.values() {
                check_relations(v, ids)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn canonical_metadata(source: &str) -> StageResult<String> {
    let decoded = value::decode_tagged(source).map_err(|e| error("invalid_metadata", e.message))?;
    if !matches!(decoded, PropertyValue::Object { .. }) {
        return Err(error(
            "invalid_metadata",
            "Record metadata must be a tagged object.",
        ));
    }
    serde_json::to_string(&decoded)
        .map_err(|_| error("invalid_metadata", "Metadata cannot be encoded."))
}
fn body_conflict(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    bytes.starts_with(b"---\n") || bytes.starts_with(b"---\r\n")
}
// The frontmatter reader strips BOM for interpretation; a file without a
// metadata fence still owns that BOM as its visible body bytes.
pub(super) fn body_start(source: &str) -> usize {
    let (block, body) = crate::vault::parse::split_frontmatter(source);
    if block.is_some() {
        source.len() - body.len()
    } else {
        0
    }
}
pub(super) fn retained_carrier(path: &str) -> bool {
    !path.ends_with(".md")
        || crate::knowledge::is_knowledge_path(path)
        || rules()
            .retained_conversion_prefixes
            .iter()
            .any(|prefix| folded_path(path).starts_with(prefix))
}
pub fn prepare_stage(
    source: &Path,
    workspace_id: &str,
    proposals: Vec<RecordProposal>,
) -> StageResult<StagePlan> {
    let source = canonical_root(source)?;
    format_gate::guard_legacy_access(&source)?;
    if !id_valid(workspace_id) || proposals.len() > rules().limits.files {
        return Err(error(
            "invalid_identity",
            "A canonical workspace UUID and bounded record set are required.",
        ));
    }
    let inventory = discover(&source)?;
    if inventory.iter().any(|e| {
        let folded = folded_path(&e.path);
        folded == rules().manifest || folded == rules().marker
    }) {
        return Err(error(
            "reserved_path",
            "Source contains selected-format staging paths.",
        ));
    }
    // The marker always creates this exact directory spelling. A source alias
    // cannot be merged with it without silently changing retained path bytes.
    let control_directory = Path::new(&rules().marker)
        .parent()
        .and_then(Path::to_str)
        .expect("shipped marker parent");
    if inventory.iter().any(|e| {
        e.kind == EntryKind::Directory
            && e.path != control_directory
            && folded_path(&e.path) == folded_path(control_directory)
    }) {
        return Err(error(
            "reserved_directory_alias",
            "Source control directory spelling conflicts with the staging marker directory.",
        ));
    }
    let by_path: BTreeMap<_, _> = inventory.iter().map(|e| (e.path.as_str(), e)).collect();
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for p in &proposals {
        if !id_valid(&p.id) || p.id == workspace_id {
            return Err(error(
                "invalid_identity",
                "A canonical separate record UUID is required.",
            ));
        }
        if !ids.insert(p.id.clone()) || !paths.insert(p.path.clone()) {
            return Err(error(
                "duplicate_identity",
                "Record IDs and paths must be unique.",
            ));
        }
    }
    let mut records = Vec::new();
    let mut metadata_bytes = 0;
    for p in proposals {
        valid_path(&p.path)?;
        if retained_carrier(&p.path) {
            return Err(error(
                "retained_carrier",
                "This carrier must remain verbatim until its governed adapter is accepted.",
            ));
        }
        let source_entry = by_path
            .get(p.path.as_str())
            .filter(|e| e.kind == EntryKind::File && e.exclusion.is_none())
            .ok_or_else(|| {
                error(
                    "missing_record",
                    "A record must name an included source file.",
                )
            })?;
        let original = read_bounded(&source, &p.path, rules().limits.file_bytes)?;
        if Some(crate::ledger::sha256_hex(&original)) != source_entry.hash {
            return Err(error("stale_inventory", "Record changed after discovery."));
        }
        let text = std::str::from_utf8(&original).map_err(|_| {
            error(
                "unsupported_encoding",
                "Ordinary converted Markdown must be UTF-8.",
            )
        })?;
        let start = body_start(text);
        let body = &text[start..];
        if p.body_start != start {
            return Err(error(
                "invalid_body_boundary",
                "Proposal does not match the existing source body boundary.",
            ));
        }
        if body_conflict(body.as_bytes()) {
            return Err(error(
                "body_format_conflict",
                "Converted body contains a frontmatter candidate.",
            ));
        }
        let metadata = canonical_metadata(&p.metadata_json)?;
        metadata_bytes += metadata.len();
        if metadata_bytes > rules().limits.metadata_bytes {
            return Err(error(
                "source_limit",
                "Combined metadata exceeds its bound.",
            ));
        }
        check_relations(
            &value::decode_tagged(&metadata).map_err(|e| error("invalid_metadata", e.message))?,
            &ids,
        )?;
        let mut parts = BTreeSet::new();
        for part in &p.required_parts {
            valid_path(part)?;
            if !parts.insert(part.clone())
                || !by_path
                    .get(part.as_str())
                    .is_some_and(|e| e.kind == EntryKind::File && e.exclusion.is_none())
            {
                return Err(error(
                    "missing_required_part",
                    "Required attachment/part is missing, excluded or duplicated.",
                ));
            }
        }
        records.push(RecordData {
            info: RecordInfo {
                id: p.id,
                path: p.path,
                body_start: p.body_start,
                revision: 1,
                body_hash: crate::ledger::sha256_hex(body.as_bytes()),
                metadata_hash: crate::ledger::sha256_hex(metadata.as_bytes()),
                required_parts: parts.into_iter().collect(),
            },
            metadata,
        });
    }
    records.sort_by(|a, b| a.info.id.cmp(&b.info.id));
    Ok(StagePlan {
        source,
        workspace_id: workspace_id.into(),
        inventory,
        records,
    })
}
fn check_inventory(source: &Path, expected: &[SourceEntry]) -> StageResult<()> {
    if discover(source).map_err(|_| {
        error(
            "stale_inventory",
            "Source root can no longer be completely inventoried.",
        )
    })? != expected
    {
        return Err(error(
            "stale_inventory",
            "Source membership or retained bytes changed after inventory.",
        ));
    }
    Ok(())
}
pub(super) fn new_destination(path: &Path) -> StageResult<PathBuf> {
    if fs::symlink_metadata(path).is_ok() {
        return Err(error(
            "destination_exists",
            "Staging requires new absent destination directories.",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| error("invalid_root", "Destination needs an existing parent."))?;
    let parent = canonical_root(parent)?;
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| error("invalid_path", "Destination name is invalid."))?;
    valid_path(name)?;
    Ok(parent.join(name))
}
fn roots_separate(source: &Path, bodies: &Path, metadata: &Path) -> StageResult<()> {
    for (a, b) in [(source, bodies), (source, metadata), (bodies, metadata)] {
        if a.starts_with(b) || b.starts_with(a) {
            return Err(error(
                "overlapping_roots",
                "Source, visible body and metadata roots must be separate.",
            ));
        }
    }
    Ok(())
}
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}
fn ensure_directories(root: &Path, relative: &Path) -> StageResult<()> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match create_private_directory(&current) {
            Ok(()) => sync_dir(current.parent().unwrap())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let meta = fs::symlink_metadata(&current).map_err(io_error)?;
                if !meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(error(
                        "unsupported_file",
                        "A destination directory was replaced.",
                    ));
                }
            }
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}
pub(super) fn sync_dir(path: &Path) -> StageResult<()> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(io_error)
}
fn write_new(root: &Path, rel: &str, bytes: &[u8]) -> StageResult<()> {
    valid_path(rel)?;
    let relative = Path::new(rel);
    ensure_directories(root, relative.parent().unwrap())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let path = root.join(rel);
    let mut file = options.open(&path).map_err(io_error)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(io_error)?;
    sync_dir(path.parent().unwrap())
}
fn part(location: Location, path: String, bytes: &[u8]) -> Part {
    Part {
        location,
        path,
        bytes: bytes.len() as u64,
        hash: crate::ledger::sha256_hex(bytes),
    }
}
fn dispositions(inventory: &[SourceEntry], records: &[RecordInfo]) -> Vec<FileDisposition> {
    inventory
        .iter()
        .filter(|e| e.kind == EntryKind::File)
        .map(|e| FileDisposition {
            path: e.path.clone(),
            disposition: if e.exclusion.is_some() {
                Disposition::Excluded
            } else if records.iter().any(|r| r.path == e.path) {
                Disposition::Converted
            } else {
                Disposition::Retained
            },
        })
        .collect()
}
pub fn stage_conversion(
    plan: StagePlan,
    bodies: &Path,
    metadata: &Path,
) -> StageResult<StagedConversion> {
    check_inventory(&plan.source, &plan.inventory)?;
    let bodies = new_destination(bodies)?;
    let metadata = new_destination(metadata)?;
    roots_separate(&plan.source, &bodies, &metadata)?;
    create_private_directory(&bodies).map_err(io_error)?;
    sync_dir(bodies.parent().unwrap())?;
    write_new(
        &bodies,
        &rules().marker,
        &format_gate::marker_bytes("preparing", None)?,
    )?;
    create_private_directory(&metadata).map_err(io_error)?;
    sync_dir(metadata.parent().unwrap())?;
    let mut parts = Vec::new();
    for entry in &plan.inventory {
        if entry.exclusion.is_some() {
            continue;
        }
        if entry.kind == EntryKind::Directory {
            ensure_directories(&bodies, Path::new(&entry.path))?;
            continue;
        }
        let original = read_bounded(&plan.source, &entry.path, rules().limits.file_bytes)?;
        if Some(crate::ledger::sha256_hex(&original)) != entry.hash {
            return Err(error("stale_inventory", "Source changed while staging."));
        }
        let archived = format!("{}/{}", rules().archive, entry.path);
        write_new(&metadata, &archived, &original)?;
        parts.push(part(Location::Metadata, archived, &original));
        let body = plan
            .records
            .iter()
            .find(|r| r.info.path == entry.path)
            .map_or(original.as_slice(), |r| &original[r.info.body_start..]);
        write_new(&bodies, &entry.path, body)?;
        parts.push(part(Location::Body, entry.path.clone(), body));
    }
    #[cfg(test)]
    fail_at("after_bodies")?;
    selected_sqlite::create(&metadata, &plan.workspace_id, &plan.records)?;
    let database = read_bounded(&metadata, &rules().database, rules().limits.database_bytes)?;
    parts.push(part(
        Location::Metadata,
        rules().database.clone(),
        &database,
    ));
    #[cfg(test)]
    fail_at("after_database")?;
    let records: Vec<_> = plan.records.into_iter().map(|r| r.info).collect();
    parts.sort_by(|a, b| (&a.location, &a.path).cmp(&(&b.location, &b.path)));
    let manifest = Manifest {
        format: rules().format,
        workspace_id: plan.workspace_id,
        source: plan.source,
        bodies,
        metadata,
        dispositions: dispositions(&plan.inventory, &records),
        inventory: plan.inventory,
        records,
        parts,
    };
    check_contents(&manifest)?;
    check_inventory(&manifest.source, &manifest.inventory)?;
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|_| error("invalid_manifest", "Stage manifest could not be encoded."))?;
    if bytes.len() as u64 > rules().limits.manifest_bytes {
        return Err(error(
            "source_limit",
            "Complete manifest exceeds its bound.",
        ));
    }
    let manifest_hash = crate::ledger::sha256_hex(&bytes);
    write_new(&manifest.bodies, &rules().manifest, &bytes)?;
    #[cfg(test)]
    fail_at("after_manifest")?;
    // Final source discovery immediately precedes publication. External editors
    // are not locked by this library; activation must revalidate independently.
    check_inventory(&manifest.source, &manifest.inventory)?;
    let marker = format_gate::marker_bytes("staged_inactive", Some(manifest_hash.clone()))?;
    let temporary = format!("{}.next", rules().marker);
    write_new(&manifest.bodies, &temporary, &marker)?;
    fs::rename(
        manifest.bodies.join(&temporary),
        manifest.bodies.join(&rules().marker),
    )
    .map_err(io_error)?;
    sync_dir(manifest.bodies.join(&rules().marker).parent().unwrap())?;
    let stage = StagedConversion {
        manifest,
        manifest_hash,
    };
    validate_cutover(&stage)?;
    Ok(stage)
}
fn check_layout(m: &Manifest) -> StageResult<()> {
    for location in [Location::Body, Location::Metadata] {
        let root = if location == Location::Body {
            &m.bodies
        } else {
            &m.metadata
        };
        let mut files: BTreeSet<String> = m
            .parts
            .iter()
            .filter(|p| p.location == location)
            .map(|p| p.path.clone())
            .collect();
        if location == Location::Body {
            files.insert(rules().marker.clone());
            files.insert(rules().manifest.clone());
        }
        let mut dirs = BTreeSet::new();
        for file in &files {
            let mut parent = Path::new(file).parent();
            while let Some(path) = parent.filter(|p| !p.as_os_str().is_empty()) {
                dirs.insert(path.to_str().unwrap().to_string());
                parent = path.parent();
            }
        }
        if location == Location::Body {
            dirs.extend(
                m.inventory
                    .iter()
                    .filter(|e| e.kind == EntryKind::Directory && e.exclusion.is_none())
                    .map(|e| e.path.clone()),
            );
        }
        let limit = rules().limits.entries * 3 + 8;
        for (i, item) in walkdir::WalkDir::new(root)
            .follow_links(false)
            .min_depth(1)
            .max_depth(rules().limits.depth + 3)
            .into_iter()
            .enumerate()
        {
            let item = item.map_err(|_| {
                error(
                    "stage_layout_changed",
                    "Staged layout cannot be completely inspected.",
                )
            })?;
            if i >= limit {
                return Err(error("source_limit", "Staged layout exceeds its bound."));
            }
            let rel = item
                .path()
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| error("stage_layout_changed", "Staged path is invalid."))?;
            let kind = item.file_type();
            if kind.is_symlink()
                || (kind.is_file() && !files.contains(rel))
                || (kind.is_dir() && !dirs.contains(rel))
                || !(kind.is_file() || kind.is_dir())
            {
                return Err(error(
                    "stage_layout_changed",
                    "Staged root contains an unaccounted or unsupported entry.",
                ));
            }
        }
    }
    Ok(())
}
fn check_contents(m: &Manifest) -> StageResult<()> {
    if m.format != rules().format
        || !id_valid(&m.workspace_id)
        || m.inventory.len() > rules().limits.entries
        || m.records.len() > rules().limits.files
    {
        return Err(error(
            "invalid_manifest",
            "Unsupported or oversized stage manifest.",
        ));
    }
    roots_separate(&m.source, &m.bodies, &m.metadata)?;
    check_layout(m)?;
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for record in &m.records {
        valid_path(&record.path)?;
        if !id_valid(&record.id)
            || record.id == m.workspace_id
            || record.revision != 1
            || !ids.insert(record.id.clone())
            || !paths.insert(record.path.clone())
        {
            return Err(error(
                "duplicate_identity",
                "Manifest identities/revisions are invalid or duplicated.",
            ));
        }
    }
    if m.dispositions != dispositions(&m.inventory, &m.records) {
        return Err(error(
            "invalid_manifest",
            "Every source file needs its exact disposition.",
        ));
    }
    let mut expected = BTreeMap::new();
    let mut inventory_paths = BTreeSet::new();
    for entry in &m.inventory {
        valid_path(&entry.path)?;
        if !inventory_paths.insert(&entry.path) {
            return Err(error(
                "invalid_manifest",
                "Source inventory repeats a path.",
            ));
        }
        if entry.kind == EntryKind::Directory || entry.exclusion.is_some() {
            continue;
        }
        let hash = entry.hash.clone().ok_or_else(|| {
            error(
                "invalid_manifest",
                "An included source file lacks its hash.",
            )
        })?;
        expected.insert(
            (
                Location::Metadata,
                format!("{}/{}", rules().archive, entry.path),
            ),
            hash.clone(),
        );
        let hash = m
            .records
            .iter()
            .find(|r| r.path == entry.path)
            .map_or(hash, |r| r.body_hash.clone());
        expected.insert((Location::Body, entry.path.clone()), hash);
    }
    let db_key = (Location::Metadata, rules().database.clone());
    let mut seen = BTreeSet::new();
    for p in &m.parts {
        valid_path(&p.path)?;
        let key = (p.location.clone(), p.path.clone());
        if !seen.insert(key.clone()) || (key != db_key && expected.get(&key) != Some(&p.hash)) {
            return Err(error(
                "invalid_manifest",
                "Stage part inventory is inconsistent.",
            ));
        }
        let root = if p.location == Location::Body {
            &m.bodies
        } else {
            &m.metadata
        };
        let cap = if key == db_key {
            rules().limits.database_bytes
        } else {
            rules().limits.file_bytes
        };
        let bytes = read_bounded(root, &p.path, cap)?;
        if p.location == Location::Body && paths.contains(&p.path) && body_conflict(&bytes) {
            return Err(error(
                "body_format_conflict",
                "Converted body contains conflicting legacy frontmatter.",
            ));
        }
        if p.bytes != bytes.len() as u64 || p.hash != crate::ledger::sha256_hex(&bytes) {
            return Err(error(
                "stage_part_changed",
                "A required staged part changed.",
            ));
        }
    }
    expected.insert(db_key, String::new());
    if seen != expected.keys().cloned().collect() {
        return Err(error(
            "missing_required_part",
            "A required archived, visible or metadata part is missing.",
        ));
    }
    for r in &m.records {
        let archived = read_bounded(
            &m.metadata,
            &format!("{}/{}", rules().archive, r.path),
            rules().limits.file_bytes,
        )?;
        let source = std::str::from_utf8(&archived)
            .map_err(|_| error("invalid_manifest", "Converted source archive is not UTF-8."))?;
        let start = body_start(source);
        let body = &source[start..];
        if r.body_start != start || r.body_hash != crate::ledger::sha256_hex(body.as_bytes()) {
            return Err(error(
                "invalid_manifest",
                "Converted body disagrees with its exact source archive.",
            ));
        }
        if !m
            .inventory
            .iter()
            .any(|e| e.path == r.path && e.kind == EntryKind::File && e.exclusion.is_none())
            || r.required_parts
                .iter()
                .any(|p| !expected.contains_key(&(Location::Body, p.clone())))
        {
            return Err(error(
                "missing_required_part",
                "Record source or required part is missing.",
            ));
        }
    }
    let rows = selected_sqlite::read(&m.metadata, &m.workspace_id)?;
    if rows.len() != m.records.len() {
        return Err(error(
            "invalid_metadata",
            "Database record count differs from the manifest.",
        ));
    }
    for row in rows {
        if !m.records.iter().any(|r| {
            r.id == row.info.id
                && r.path == row.info.path
                && r.revision == row.info.revision
                && r.body_hash == row.info.body_hash
                && r.metadata_hash == crate::ledger::sha256_hex(row.metadata.as_bytes())
        }) {
            return Err(error(
                "invalid_metadata",
                "Database row differs from the manifest.",
            ));
        }
        check_relations(
            &value::decode_tagged(&row.metadata)
                .map_err(|e| error("invalid_metadata", e.message))?,
            &ids,
        )?;
    }
    Ok(())
}
pub fn validate_cutover(stage: &StagedConversion) -> StageResult<StageValidation> {
    let m = &stage.manifest;
    if canonical_root(&m.source)? != m.source
        || canonical_root(&m.bodies)? != m.bodies
        || canonical_root(&m.metadata)? != m.metadata
    {
        return Err(error(
            "root_changed",
            "Stage roots no longer match their binding.",
        ));
    }
    let marker = format_gate::read_marker(&m.bodies)?
        .ok_or_else(|| error("invalid_format", "Selected-format marker is missing."))?;
    if marker.state != "staged_inactive"
        || marker.manifest_hash.as_deref() != Some(&stage.manifest_hash)
    {
        return Err(error(
            "inactive_workspace",
            "Stage publication is incomplete or changed.",
        ));
    }
    let manifest = read_bounded(&m.bodies, &rules().manifest, rules().limits.manifest_bytes)?;
    if crate::ledger::sha256_hex(&manifest) != stage.manifest_hash {
        return Err(error("invalid_manifest", "Published manifest changed."));
    }
    check_inventory(&m.source, &m.inventory)?;
    check_contents(m)?;
    Ok(StageValidation {
        whole_root_accounted: true,
        activation_blockers: rules().activation_blockers.clone(),
    })
}
/// Reopen a checked stage using separate trusted roots/identity. Manifest values
/// never register a workspace or become a receipt/capability.
pub fn open_staged(
    source: &Path,
    bodies: &Path,
    metadata: &Path,
    workspace_id: &str,
) -> StageResult<StagedConversion> {
    let source = canonical_root(source)?;
    let bodies = canonical_root(bodies)?;
    let metadata = canonical_root(metadata)?;
    let marker = format_gate::read_marker(&bodies)?
        .ok_or_else(|| error("invalid_format", "Selected-format marker is missing."))?;
    if marker.state != "staged_inactive" {
        return Err(error(
            "inactive_workspace",
            "Stage publication is incomplete.",
        ));
    }
    let bytes = read_bounded(&bodies, &rules().manifest, rules().limits.manifest_bytes)?;
    let hash = crate::ledger::sha256_hex(&bytes);
    if marker.manifest_hash.as_deref() != Some(&hash) {
        return Err(error(
            "invalid_manifest",
            "Manifest hash does not match publication.",
        ));
    }
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| error("invalid_manifest", "Manifest shape is invalid."))?;
    if manifest.source != source
        || manifest.bodies != bodies
        || manifest.metadata != metadata
        || manifest.workspace_id != workspace_id
    {
        return Err(error(
            "wrong_binding",
            "Stage manifest does not match trusted roots and workspace.",
        ));
    }
    let stage = StagedConversion {
        manifest,
        manifest_hash: hash,
    };
    validate_cutover(&stage)?;
    Ok(stage)
}
/// Canonical metadata-only inspection remains possible when a visible body has
/// a format conflict. It never parses body YAML or changes grants.
pub fn read_staged_metadata(stage: &StagedConversion, record_id: &str) -> StageResult<String> {
    let m = &stage.manifest;
    let db_part = m
        .parts
        .iter()
        .find(|p| p.location == Location::Metadata && p.path == rules().database)
        .ok_or_else(|| {
            error(
                "missing_required_part",
                "Metadata database is missing from manifest.",
            )
        })?;
    let bytes = read_bounded(
        &m.metadata,
        &rules().database,
        rules().limits.database_bytes,
    )?;
    if crate::ledger::sha256_hex(&bytes) != db_part.hash {
        return Err(error("stage_part_changed", "Canonical metadata changed."));
    }
    selected_sqlite::read(&m.metadata, &m.workspace_id)?
        .into_iter()
        .find(|r| r.info.id == record_id)
        .map(|r| r.metadata)
        .ok_or_else(|| error("missing_record", "Record identity is unavailable."))
}
#[cfg(test)]
thread_local! { static FAILURE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
fn fail_at(point: &str) -> StageResult<()> {
    if FAILURE.with(|v| v.borrow().as_deref() == Some(point)) {
        Err(error(
            "injected_failure",
            "Test interrupted a staging boundary.",
        ))
    } else {
        Ok(())
    }
}
#[cfg(test)]
fn stage_with_failure(
    plan: StagePlan,
    bodies: &Path,
    metadata: &Path,
    point: &str,
) -> StageResult<StagedConversion> {
    FAILURE.with(|v| *v.borrow_mut() = Some(point.into()));
    let result = stage_conversion(plan, bodies, metadata);
    FAILURE.with(|v| *v.borrow_mut() = None);
    result
}

#[cfg(all(test,unix))]
#[path = "stage_schema4_tests.rs"]
mod schema4_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    const WORKSPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const RECORD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf, RecordProposal) {
        let base = crate::vault::testutil::temp_vault(name);
        let source = base.join("source");
        fs::create_dir_all(source.join("attachments")).unwrap();
        let bytes =
            b"---\r\nname: '007'\r\ngrants: []\r\n---\r\n# Page\r\n![image](attachments/a.bin)\r\n";
        fs::write(source.join("page.md"), bytes).unwrap();
        fs::write(source.join("attachments/a.bin"), [0, 1, 2, 255]).unwrap();
        let body_start = bytes.windows(6).position(|v| v == b"# Page").unwrap();
        let record = RecordProposal {
            id: RECORD.into(), path: "page.md".into(), body_start,
            metadata_json: r#"{"kind":"object","value":{"name":{"kind":"string","value":"007"},"grants":{"kind":"array","value":[]},"unknown":{"kind":"decimal","value":"9007199254740993.125"}}}"#.into(),
            required_parts: vec!["attachments/a.bin".into()],
        };
        (
            source,
            base.join("new-bodies"),
            base.join("new-metadata"),
            record,
        )
    }
    #[test]
    fn source_changed_after_inventory_refuses_staging_without_touching_new_bytes() {
        let (source, bodies, metadata, record) = fixture("m99-stage-stale");
        let plan = prepare_stage(&source, WORKSPACE, vec![record]).unwrap();
        fs::write(source.join("page.md"), b"new human bytes").unwrap();
        assert_eq!(
            stage_conversion(plan, &bodies, &metadata).unwrap_err().kind,
            "stale_inventory"
        );
        assert_eq!(
            fs::read(source.join("page.md")).unwrap(),
            b"new human bytes"
        );
        assert!(!bodies.exists());
        assert!(!metadata.exists());
    }
    #[test]
    fn new_deleted_and_moved_files_invalidate_whole_root_coverage() {
        for change in ["new", "deleted", "moved"] {
            let (source, bodies, metadata, record) = fixture("m99-stage-coverage");
            let plan = prepare_stage(&source, WORKSPACE, vec![record]).unwrap();
            match change {
                "new" => fs::write(source.join("new.md"), b"new").unwrap(),
                "deleted" => fs::remove_file(source.join("attachments/a.bin")).unwrap(),
                _ => {
                    fs::rename(source.join("attachments/a.bin"), source.join("moved.bin")).unwrap()
                }
            }
            assert_eq!(
                stage_conversion(plan, &bodies, &metadata).unwrap_err().kind,
                "stale_inventory"
            );
            assert!(!bodies.exists());
        }
    }
    #[test]
    fn duplicate_identity_and_missing_required_attachment_refuse_before_destination_creation() {
        let (source, bodies, metadata, record) = fixture("m99-stage-parts");
        fs::write(source.join("second.md"), b"# Second").unwrap();
        let mut duplicate = record.clone();
        duplicate.path = "second.md".into();
        duplicate.body_start = 0;
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record.clone(), duplicate])
                .unwrap_err()
                .kind,
            "duplicate_identity"
        );
        fs::remove_file(source.join("attachments/a.bin")).unwrap();
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record])
                .unwrap_err()
                .kind,
            "missing_required_part"
        );
        assert!(!bodies.exists());
        assert!(!metadata.exists());
    }
    #[test]
    fn checked_stage_preserves_originals_typed_metadata_and_remains_inactive() {
        let (source, bodies, metadata, record) = fixture("m99-stage-clean");
        let original = fs::read(source.join("page.md")).unwrap();
        let expected = serde_json::from_str::<serde_json::Value>(&record.metadata_json).unwrap();
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        let checked = validate_cutover(&stage).unwrap();
        assert!(checked.whole_root_accounted);
        assert!(!checked.activation_blockers.is_empty());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &read_staged_metadata(&stage, RECORD).unwrap()
            )
            .unwrap(),
            expected
        );
        assert_eq!(fs::read(source.join("page.md")).unwrap(), original);
        assert_eq!(
            fs::read(bodies.join("attachments/a.bin")).unwrap(),
            [0, 1, 2, 255]
        );
        assert!(bodies.join("page.md").is_file());
        assert!(metadata.join("workspace.db").is_file());
        assert_eq!(
            super::super::format_gate::guard_legacy_access(&bodies)
                .unwrap_err()
                .kind,
            "selected_authority_required"
        );
    }
    #[test]
    fn injected_body_yaml_cannot_replace_staged_metadata_or_broaden_grants() {
        let (source, bodies, metadata, record) = fixture("m99-stage-yaml-conflict");
        let original = fs::read(source.join("page.md")).unwrap();
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        let canonical = read_staged_metadata(&stage, RECORD).unwrap();
        fs::write(
            bodies.join("page.md"),
            b"---\ngrants: ['all']\n---\n# Injected\n",
        )
        .unwrap();
        assert_eq!(
            validate_cutover(&stage).unwrap_err().kind,
            "body_format_conflict"
        );
        assert_eq!(read_staged_metadata(&stage, RECORD).unwrap(), canonical);
        assert_eq!(fs::read(source.join("page.md")).unwrap(), original);
    }
    #[test]
    fn retained_trash_reconciliation_ledger_and_unknown_hidden_bytes_are_not_dropped() {
        let (source, bodies, metadata, record) = fixture("m99-stage-retained");
        let paths = [
            ".trash/old/.trashed.json",
            ".cerebro/reconcile-backup/old.md",
            ".cerebro/ledger/store.json",
            ".unknown/content.bin",
        ];
        for path in paths {
            fs::create_dir_all(source.join(path).parent().unwrap()).unwrap();
            fs::write(source.join(path), b"verbatim compatibility bytes\r\n").unwrap();
        }
        fs::write(source.join(".env"), b"must never be copied").unwrap();
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        validate_cutover(&stage).unwrap();
        for path in paths {
            assert_eq!(
                fs::read(bodies.join(path)).unwrap(),
                b"verbatim compatibility bytes\r\n"
            );
        }
        assert!(!bodies.join(".env").exists());
        let manifest = fs::read_to_string(bodies.join(".cerebro/staged-manifest.json")).unwrap();
        assert!(manifest.contains("excluded"));
        assert!(!manifest.contains("must never be copied"));
    }
    #[test]
    fn existing_destination_never_changes_originals() {
        let (source, bodies, metadata, record) = fixture("m99-stage-existing");
        let original = fs::read(source.join("page.md")).unwrap();
        fs::create_dir(&metadata).unwrap();
        fs::write(metadata.join("sentinel"), b"keep").unwrap();
        let plan = prepare_stage(&source, WORKSPACE, vec![record]).unwrap();
        assert_eq!(
            stage_conversion(plan, &bodies, &metadata).unwrap_err().kind,
            "destination_exists"
        );
        assert_eq!(fs::read(source.join("page.md")).unwrap(), original);
        assert_eq!(fs::read(metadata.join("sentinel")).unwrap(), b"keep");
        assert!(!bodies.exists());
    }
    #[test]
    fn publication_failures_leave_originals_and_an_explicit_inactive_destination() {
        for point in ["after_bodies", "after_database", "after_manifest"] {
            let (source, bodies, metadata, record) = fixture("m99-stage-interrupt");
            let original = fs::read(source.join("page.md")).unwrap();
            let error = stage_with_failure(
                prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
                &bodies,
                &metadata,
                point,
            )
            .unwrap_err();
            assert_eq!(error.kind, "injected_failure");
            assert_eq!(fs::read(source.join("page.md")).unwrap(), original);
            assert_eq!(
                super::super::format_gate::guard_legacy_access(&bodies)
                    .unwrap_err()
                    .kind,
                "inactive_workspace"
            );
            assert!(open_staged(&source, &bodies, &metadata, WORKSPACE).is_err());
        }
    }
    #[test]
    fn restart_checks_binding_required_parts_and_manifest_without_inventing_authority() {
        let (source, bodies, metadata, record) = fixture("m99-stage-reopen");
        stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        let reopened = open_staged(&source, &bodies, &metadata, WORKSPACE).unwrap();
        assert!(validate_cutover(&reopened).unwrap().whole_root_accounted);
        assert!(open_staged(&source, &bodies, &metadata, RECORD).is_err());
        fs::remove_file(bodies.join("attachments/a.bin")).unwrap();
        assert!(open_staged(&source, &bodies, &metadata, WORKSPACE).is_err());
        fs::write(bodies.join("attachments/a.bin"), [0, 1, 2, 255]).unwrap();
        fs::write(bodies.join(".cerebro/staged-manifest.json"), b"{}").unwrap();
        assert!(open_staged(&source, &bodies, &metadata, WORKSPACE).is_err());
    }
    #[test]
    fn final_validation_detects_new_source_files_and_unlisted_destination_files() {
        let (source, bodies, metadata, record) = fixture("m99-stage-final-discovery");
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        fs::write(source.join("late.md"), b"late source").unwrap();
        assert_eq!(
            validate_cutover(&stage).unwrap_err().kind,
            "stale_inventory"
        );
        fs::remove_file(source.join("late.md")).unwrap();
        fs::write(bodies.join("unlisted.md"), b"unlisted destination").unwrap();
        assert_eq!(
            validate_cutover(&stage).unwrap_err().kind,
            "stage_layout_changed"
        );
    }
    #[test]
    fn missing_database_and_manifest_part_omission_refuse_reopen() {
        let (source, bodies, metadata, record) = fixture("m99-stage-broken-pairs");
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        let db = fs::read(metadata.join("workspace.db")).unwrap();
        fs::remove_file(metadata.join("workspace.db")).unwrap();
        assert!(open_staged(&source, &bodies, &metadata, WORKSPACE).is_err());
        fs::write(metadata.join("workspace.db"), db).unwrap();
        let mut manifest = stage.manifest.clone();
        manifest.parts.retain(|p| p.path != "attachments/a.bin");
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(bodies.join(&rules().manifest), &bytes).unwrap();
        fs::write(
            bodies.join(&rules().marker),
            format_gate::marker_bytes("staged_inactive", Some(crate::ledger::sha256_hex(&bytes)))
                .unwrap(),
        )
        .unwrap();
        assert!(open_staged(&source, &bodies, &metadata, WORKSPACE).is_err());
    }
    #[test]
    fn private_exclusions_never_record_secret_hashes_or_satisfy_required_parts() {
        let (source, bodies, metadata, mut record) = fixture("m99-stage-private");
        fs::write(source.join(".env"), b"SECRET=private").unwrap();
        fs::write(source.join(".environment.md"), b"ordinary hidden content").unwrap();
        let plan = prepare_stage(&source, WORKSPACE, vec![record.clone()]).unwrap();
        let excluded = plan.inventory.iter().find(|e| e.path == ".env").unwrap();
        assert!(excluded.exclusion.is_some());
        assert!(excluded.hash.is_none());
        assert!(excluded.bytes.is_none());
        let stage = stage_conversion(plan, &bodies, &metadata).unwrap();
        validate_cutover(&stage).unwrap();
        assert_eq!(
            fs::read(bodies.join(".environment.md")).unwrap(),
            b"ordinary hidden content"
        );
        record.required_parts.push(".env".into());
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record])
                .unwrap_err()
                .kind,
            "missing_required_part"
        );
    }
    #[test]
    fn unsafe_paths_oversize_sources_and_governed_conversion_never_complete() {
        let (source, bodies, metadata, mut record) = fixture("m99-stage-bounds");
        let file = fs::File::create(source.join("large.bin")).unwrap();
        file.set_len(rules().limits.file_bytes + 1).unwrap();
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record.clone()])
                .unwrap_err()
                .kind,
            "source_limit"
        );
        fs::remove_file(source.join("large.bin")).unwrap();
        record.path = "../page.md".into();
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record.clone()])
                .unwrap_err()
                .kind,
            "invalid_path"
        );
        record.path = "knowledge/concept.md".into();
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record])
                .unwrap_err()
                .kind,
            "retained_carrier"
        );
        assert!(!bodies.exists());
        assert!(!metadata.exists());
    }
    #[cfg(unix)]
    #[test]
    fn source_and_destination_symlinks_are_refused_without_following_them() {
        use std::os::unix::fs::symlink;
        let (source, bodies, metadata, record) = fixture("m99-stage-symlinks");
        symlink(source.join("page.md"), source.join("alias.md")).unwrap();
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record.clone()])
                .unwrap_err()
                .kind,
            "unsupported_file"
        );
        fs::remove_file(source.join("alias.md")).unwrap();
        symlink(&source, &metadata).unwrap();
        assert_eq!(
            stage_conversion(
                prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
                &bodies,
                &metadata
            )
            .unwrap_err()
            .kind,
            "destination_exists"
        );
        assert!(!bodies.exists());
    }
    #[test]
    fn repair_governed_aliases_refuse_conversion_and_retain_exact_projection_bytes() {
        let mut admitted = Vec::new();
        for alias in [
            "knowledge",
            "Knowledge",
            "\u{212a}nowledge",
            "know\u{200c}ledge",
        ] {
            let (source, bodies, metadata, mut record) = fixture("m99-fix1-governed");
            fs::create_dir(source.join(alias)).unwrap();
            record.path = format!("{alias}/concept.md");
            fs::rename(source.join("page.md"), source.join(&record.path)).unwrap();
            let original = fs::read(source.join(&record.path)).unwrap();
            assert!(crate::knowledge::is_knowledge_path(&record.path));
            if !matches!(prepare_stage(&source,WORKSPACE,vec![record.clone()]),Err(e) if e.kind=="retained_carrier")
            {
                admitted.push(alias);
            }
            assert!(!bodies.exists());
            assert!(!metadata.exists());
            let stage = stage_conversion(
                prepare_stage(&source, WORKSPACE, Vec::new()).unwrap(),
                &bodies,
                &metadata,
            )
            .unwrap();
            validate_cutover(&stage).unwrap();
            assert_eq!(fs::read(source.join(&record.path)).unwrap(), original);
            assert_eq!(fs::read(bodies.join(&record.path)).unwrap(), original);
            assert_eq!(
                fs::read(metadata.join("originals").join(&record.path)).unwrap(),
                original
            );
        }
        assert!(
            admitted.is_empty(),
            "governed aliases admitted: {admitted:?}"
        );
    }
    #[test]
    fn repair_cli_and_retained_aliases_share_existing_disk_name_semantics() {
        let mut admitted = Vec::new();
        for alias in [
            ".claude",
            ".CLAUDE",
            ".cl\u{200c}aude",
            "\u{200c}.claude",
            ".cerebro",
            ".TRASH",
            ".COMMENTS",
        ] {
            let (source, bodies, metadata, mut record) = fixture("m99-fix1-retained");
            fs::create_dir_all(source.join(alias).join("agents")).unwrap();
            record.path = format!("{alias}/agents/worker.md");
            fs::rename(source.join("page.md"), source.join(&record.path)).unwrap();
            let original = fs::read(source.join(&record.path)).unwrap();
            if !matches!(prepare_stage(&source,WORKSPACE,vec![record.clone()]),Err(e) if e.kind=="retained_carrier")
            {
                admitted.push(alias);
            }
            assert!(!bodies.exists());
            assert!(!metadata.exists());
            let stage = stage_conversion(
                prepare_stage(&source, WORKSPACE, Vec::new()).unwrap(),
                &bodies,
                &metadata,
            )
            .unwrap();
            validate_cutover(&stage).unwrap();
            assert_eq!(fs::read(bodies.join(&record.path)).unwrap(), original);
            assert_eq!(
                fs::read(metadata.join("originals").join(&record.path)).unwrap(),
                original
            );
        }
        assert!(
            admitted.is_empty(),
            "retained aliases admitted: {admitted:?}"
        );
    }
    #[test]
    fn repair_control_directory_aliases_refuse_before_output_without_renaming_source() {
        for alias in [".CEREBRO", ".cere\u{200c}bro", "\u{200c}.cerebro"] {
            for private_only in [false, true] {
                let (source, bodies, metadata, record) = fixture("m99-fix1-control-alias");
                let rel = format!(
                    "{alias}/{}",
                    if private_only {
                        "runtime.db"
                    } else {
                        "agents/worker.md"
                    }
                );
                fs::create_dir_all(source.join(&rel).parent().unwrap()).unwrap();
                let original = b"private or retained original bytes";
                fs::write(source.join(&rel), original).unwrap();
                let inventory = discover(&canonical_root(&source).unwrap()).unwrap();
                let row = inventory.iter().find(|e| e.path == rel).unwrap();
                if private_only {
                    assert!(row.exclusion.is_some());
                    assert!(row.bytes.is_none());
                    assert!(row.hash.is_none());
                }
                let result = prepare_stage(&source, WORKSPACE, vec![record]);
                assert!(
                    matches!(result, Err(e) if e.code == "capability_unavailable" && e.kind == "reserved_directory_alias"),
                    "control directory alias must refuse before a staging plan: {alias}"
                );
                assert!(!bodies.exists());
                assert!(!metadata.exists());
                assert_eq!(fs::read(source.join(&rel)).unwrap(), original);
                assert!(fs::read_dir(&source)
                    .unwrap()
                    .any(|e| e.unwrap().file_name() == alias));
            }
        }
    }
    #[test]
    fn repair_private_aliases_are_excluded_without_hashing_or_copying_bytes() {
        let mut disclosed = Vec::new();
        for rel in [
            ".e\u{200c}nv",
            "\u{200c}.ssh/key",
            ".cerebro/runt\u{200c}ime.db",
            "so\u{200c}urces/mail/thread.md",
        ] {
            let (source, bodies, metadata, record) = fixture("m99-fix1-private-alias");
            fs::create_dir_all(source.join(rel).parent().unwrap()).unwrap();
            fs::write(source.join(rel), b"private fixture bytes").unwrap();
            let plan = prepare_stage(&source, WORKSPACE, vec![record]).unwrap();
            let row = plan.inventory.iter().find(|e| e.path == rel).unwrap();
            if row.exclusion.is_none() || row.hash.is_some() || row.bytes.is_some() {
                disclosed.push(rel);
            }
            let stage = stage_conversion(plan, &bodies, &metadata).unwrap();
            validate_cutover(&stage).unwrap();
            if bodies.join(rel).exists() || metadata.join("originals").join(rel).exists() {
                disclosed.push(rel);
            }
            assert_eq!(
                fs::read(source.join(rel)).unwrap(),
                b"private fixture bytes"
            );
        }
        assert!(
            disclosed.is_empty(),
            "private aliases inventoried/copied: {disclosed:?}"
        );
    }
    #[test]
    fn repair_reserved_manifest_aliases_cannot_appear_as_retained_source_files() {
        let mut admitted = Vec::new();
        for rel in [
            ".CEREBRO/staged-manifest.json",
            ".cerebro/staged-\u{200c}manifest.json",
        ] {
            let (source, bodies, metadata, record) = fixture("m99-fix1-reserved");
            fs::create_dir_all(source.join(rel).parent().unwrap()).unwrap();
            fs::write(source.join(rel), b"{}\n").unwrap();
            if !matches!(prepare_stage(&source,WORKSPACE,vec![record]),Err(e) if e.kind=="reserved_path")
            {
                admitted.push(rel);
            }
            assert!(!bodies.exists());
            assert!(!metadata.exists());
            assert_eq!(fs::read(source.join(rel)).unwrap(), b"{}\n");
        }
        assert!(
            admitted.is_empty(),
            "reserved aliases admitted: {admitted:?}"
        );
    }
    #[test]
    fn repair_name_folding_does_not_broaden_ordinary_carriers_or_extensions() {
        let (source, bodies, metadata, mut record) = fixture("m99-fix1-ordinary");
        fs::create_dir(source.join("knowledge-archive")).unwrap();
        record.path = "knowledge-archive/page.md".into();
        fs::rename(source.join("page.md"), source.join(&record.path)).unwrap();
        for rel in [".environment.md", ".claude-extra.md"] {
            fs::write(source.join(rel), b"ordinary hidden bytes").unwrap();
        }
        let plan = prepare_stage(&source, WORKSPACE, vec![record.clone()]).unwrap();
        let stage = stage_conversion(plan, &bodies, &metadata).unwrap();
        validate_cutover(&stage).unwrap();
        for rel in [".environment.md", ".claude-extra.md"] {
            assert_eq!(
                fs::read(bodies.join(rel)).unwrap(),
                b"ordinary hidden bytes"
            );
        }
        record.path = "knowledge-archive/page.MD".into();
        assert_eq!(
            prepare_stage(&source, WORKSPACE, vec![record])
                .unwrap_err()
                .kind,
            "retained_carrier"
        );
    }
    #[cfg(unix)]
    fn repair_public_modes(root: &Path) -> Vec<(PathBuf, u32)> {
        use std::os::unix::fs::PermissionsExt;
        walkdir::WalkDir::new(root)
            .into_iter()
            .map(|e| e.unwrap())
            .filter_map(|e| {
                let mode = fs::symlink_metadata(e.path()).unwrap().permissions().mode() & 0o777;
                (mode & 0o077 != 0).then(|| (e.path().to_path_buf(), mode))
            })
            .collect()
    }
    #[cfg(unix)]
    #[test]
    fn repair_metadata_and_sqlite_journal_stay_private_under_a_public_parent() {
        use std::os::unix::fs::PermissionsExt;
        let (source, bodies, metadata, record) = fixture("m99-fix1-private-modes");
        let parent = metadata.parent().unwrap();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(source.join("page.md"), fs::Permissions::from_mode(0o600)).unwrap();
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        validate_cutover(&stage).unwrap();
        let mut public = repair_public_modes(&metadata);
        public.extend(repair_public_modes(&bodies));
        let connection = rusqlite::Connection::open(metadata.join("workspace.db")).unwrap();
        connection
            .execute_batch("BEGIN IMMEDIATE; UPDATE records SET metadata=metadata||' ';")
            .unwrap();
        let journal = metadata.join("workspace.db-journal");
        assert!(
            journal.is_file(),
            "exercise actual rollback journal before commit"
        );
        public.extend(repair_public_modes(&metadata));
        connection.execute_batch("ROLLBACK").unwrap();
        drop(connection);
        assert_eq!(
            fs::metadata(parent).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(source.join("page.md"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(
            public.is_empty(),
            "new output modes expose private source metadata: {public:?}"
        );
        assert_eq!(
            fs::metadata(&metadata).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(metadata.join("workspace.db"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[cfg(unix)]
    #[test]
    fn repair_interrupted_stages_keep_every_created_directory_and_file_private() {
        use std::os::unix::fs::PermissionsExt;
        let mut public = Vec::new();
        for point in ["after_bodies", "after_database", "after_manifest"] {
            let (source, bodies, metadata, record) = fixture("m99-fix1-interrupted-modes");
            let parent = metadata.parent().unwrap();
            fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                stage_with_failure(
                    prepare_stage(&source, WORKSPACE, vec![record]).unwrap(),
                    &bodies,
                    &metadata,
                    point
                )
                .unwrap_err()
                .kind,
                "injected_failure"
            );
            public.extend(repair_public_modes(&metadata));
            public.extend(repair_public_modes(&bodies));
            assert_eq!(
                fs::metadata(parent).unwrap().permissions().mode() & 0o777,
                0o755
            );
            assert_eq!(
                format_gate::guard_legacy_access(&bodies).unwrap_err().kind,
                "inactive_workspace"
            );
        }
        assert!(
            public.is_empty(),
            "interrupted stage permissions: {public:?}"
        );
    }
}

#[cfg(test)]
mod backup_secret_tests {
    use super::*;

    const WORKSPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const RECORD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SYNTHETIC: &[u8] = b"synthetic connector credential fixture only\r\n";
    const SECRET_PATHS: &[&str] = &[
        crate::connectors::CONFIG_PATH,
        ".cerebro/.connectors.json.1234.7.tmp",
        ".cerebro/CONNECTORS.JSON",
        ".cerebro/connec\u{200c}tors.json",
        ".cerebro/.CONNEC\u{200c}TORS.JSON.1234.7.TMP",
    ];

    fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = crate::vault::testutil::temp_vault(label);
        let source = base.join("source");
        fs::create_dir_all(source.join(".cerebro")).unwrap();
        fs::write(source.join("page.md"), b"# A retained page\n").unwrap();
        (source, base.join("bodies"), base.join("metadata"))
    }

    #[test]
    fn backup_boundary_excludes_connector_config_and_abandoned_write_temps_from_both_outputs() {
        for rel in SECRET_PATHS {
            let (source, bodies, metadata) = fixture("m99-backup-secret-outputs");
            fs::write(source.join(rel), SYNTHETIC).unwrap();
            let plan = prepare_stage(&source, WORKSPACE, Vec::new()).unwrap();
            let stage = stage_conversion(plan, &bodies, &metadata).unwrap();
            validate_cutover(&stage).unwrap();

            assert!(!bodies.join(rel).exists(), "private body copy: {rel}");
            assert!(
                !metadata.join("originals").join(rel).exists(),
                "private original archive copy: {rel}"
            );
            let manifest: serde_json::Value = serde_json::from_slice(
                &fs::read(bodies.join(".cerebro/staged-manifest.json")).unwrap(),
            )
            .unwrap();
            let entry = manifest["inventory"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["path"] == *rel)
                .unwrap();
            assert_eq!(entry["exclusion"], "private_credentials");
            assert!(entry["hash"].is_null());
            assert!(entry["bytes"].is_null());
            let disposition = manifest["dispositions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["path"] == *rel)
                .unwrap();
            assert_eq!(disposition["disposition"], "excluded");
            assert_eq!(fs::read(source.join(rel)).unwrap(), SYNTHETIC);
            assert_eq!(
                fs::read(bodies.join("page.md")).unwrap(),
                b"# A retained page\n"
            );
        }
    }

    #[test]
    fn backup_boundary_excludes_connector_bytes_before_the_content_read_limit() {
        for rel in [
            crate::connectors::CONFIG_PATH,
            ".cerebro/.connectors.json.1234.7.tmp",
        ] {
            let (source, bodies, metadata) = fixture("m99-backup-secret-unread");
            let file = fs::File::create(source.join(rel)).unwrap();
            let length = rules().limits.file_bytes + 1;
            file.set_len(length).unwrap();
            drop(file);
            let plan = prepare_stage(&source, WORKSPACE, Vec::new()).unwrap();
            let observed = plan
                .inventory
                .iter()
                .find(|entry| entry.path == rel)
                .unwrap();
            assert_eq!(observed.exclusion.as_deref(), Some("private_credentials"));
            assert!(observed.hash.is_none());
            assert!(observed.bytes.is_none());
            let stage = stage_conversion(plan, &bodies, &metadata).unwrap();
            validate_cutover(&stage).unwrap();
            assert!(!bodies.join(rel).exists());
            assert!(!metadata.join("originals").join(rel).exists());
            assert_eq!(fs::metadata(source.join(rel)).unwrap().len(), length);
        }
    }

    #[test]
    fn backup_boundary_does_not_exclude_neighboring_retained_files() {
        let (source, bodies, metadata) = fixture("m99-backup-secret-neighbors");
        for rel in [
            ".cerebro/connectors.json.notes",
            ".cerebro/.connectors.json.1234.7.tmp.md",
            ".cerebro/.connectors.json.1234.7.other",
            "docs/connectors.json",
            "docs/.connectors.json.1234.7.tmp",
        ] {
            fs::create_dir_all(source.join(rel).parent().unwrap()).unwrap();
            fs::write(source.join(rel), b"ordinary retained bytes\n").unwrap();
        }
        let stage = stage_conversion(
            prepare_stage(&source, WORKSPACE, Vec::new()).unwrap(),
            &bodies,
            &metadata,
        )
        .unwrap();
        validate_cutover(&stage).unwrap();
        for rel in [
            ".cerebro/connectors.json.notes",
            ".cerebro/.connectors.json.1234.7.tmp.md",
            ".cerebro/.connectors.json.1234.7.other",
            "docs/connectors.json",
            "docs/.connectors.json.1234.7.tmp",
        ] {
            assert_eq!(
                fs::read(bodies.join(rel)).unwrap(),
                b"ordinary retained bytes\n"
            );
            assert_eq!(
                fs::read(metadata.join("originals").join(rel)).unwrap(),
                b"ordinary retained bytes\n"
            );
        }
    }

    #[test]
    fn backup_boundary_cannot_count_an_excluded_connector_secret_as_a_required_part() {
        for rel in [
            crate::connectors::CONFIG_PATH,
            ".cerebro/.connectors.json.1234.7.tmp",
        ] {
            let (source, bodies, metadata) = fixture("m99-backup-secret-required");
            fs::write(source.join(rel), SYNTHETIC).unwrap();
            let record = RecordProposal {
                id: RECORD.into(),
                path: "page.md".into(),
                body_start: 0,
                metadata_json: r#"{"kind":"object","value":{}}"#.into(),
                required_parts: vec![rel.into()],
            };
            let refused = prepare_stage(&source, WORKSPACE, vec![record]).unwrap_err();
            assert_eq!(refused.kind, "missing_required_part");
            assert!(!bodies.exists());
            assert!(!metadata.exists());
            assert_eq!(fs::read(source.join(rel)).unwrap(), SYNTHETIC);
        }
    }
}
