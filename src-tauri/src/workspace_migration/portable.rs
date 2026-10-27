//! Bounded directory transport. All policy paths are compiled, never manifest-selected.
use super::{BackupError, BackupErrorKind as K};
use crate::workspace_migration::stage;
use crate::workspace_service::selected::backup::{self as selected, BackupFacts};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
#[path = "portable_io.rs"]
pub(super) mod io;
use io::Identity;
use io::Root;

pub(super) type Result<T> = std::result::Result<T, BackupError>;
pub(super) fn error(kind: K, message: impl Into<String>) -> BackupError {
    BackupError {
        code: "capability_unavailable",
        kind,
        message: message.into(),
    }
}
pub(super) fn authority_error(
    e: crate::workspace_service::types::selected::AuthorityError,
) -> BackupError {
    use crate::workspace_service::types::selected::AuthorityErrorKind as A;
    error(
        match e.kind {
            A::Busy => K::Busy,
            A::RecoveryRequired | A::RecoveryConflict => K::RecoveryRequired,
            A::SourceLimit => K::SourceLimit,
            A::SourceChanged | A::WrongIdentity => K::SourceChanged,
            _ => K::InvalidMetadata,
        },
        e.message,
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sources {
    selected: String,
    retained: String,
    attachments: String,
    preview: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransportLimits {
    ledger_frames: usize,
    ledger_line_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Rules {
    pub format: u32,
    pub container: String,
    pub manifest: String,
    pub complete_state: String,
    pub bodies: String,
    pub metadata: String,
    pub database: String,
    pub archive: String,
    limit_sources: Sources,
    limits: TransportLimits,
    pub restored_manifest: String,
    pub omitted_scopes: Vec<String>,
}
pub(super) fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let r: Rules =
            serde_json::from_str(include_str!("../../../shared/workspace/export.v1.json"))
                .expect("compiled export vocabulary");
        assert_eq!(r.format, 1);
        assert_eq!(r.container, "directory");
        assert_eq!(
            r.limit_sources.selected,
            "shared/workspace/authority.v2.json"
        );
        assert_eq!(r.limit_sources.retained, "shared/workspace/staging.v1.json");
        assert_eq!(r.limit_sources.attachments, "shared/files/kinds.v1.json");
        assert_eq!(r.limit_sources.preview, "shared/files/bytes.v1.json");
        assert!(r.limits.ledger_frames > 0 && r.limits.ledger_line_bytes > 0);
        r
    })
}
#[derive(Debug, Clone, Copy)]
pub(super) struct Limits {
    pub body: u64,
    pub body_total: u64,
    pub database: u64,
    pub retained: u64,
    pub retained_total: u64,
    pub files: usize,
    pub entries: usize,
    pub path_bytes: usize,
    pub depth: usize,
    pub manifest: u64,
}
pub(super) fn limits() -> Result<Limits> {
    let (body, body_total, records, path_bytes, depth, database) = selected::source_limits();
    let stage = &stage::rules().limits;
    let files = records
        .checked_add(stage.files)
        .and_then(|x| x.checked_add(1))
        .ok_or_else(|| error(K::SourceLimit, "File budget overflow."))?;
    let entries = records
        .checked_mul(8)
        .and_then(|x| x.checked_add(1024))
        .and_then(|x| x.checked_add(stage.entries))
        .and_then(|x| x.checked_add(3))
        .ok_or_else(|| error(K::SourceLimit, "Entry budget overflow."))?;
    let retained = stage
        .file_bytes
        .max(crate::files::kinds::limits().attachment_bytes)
        .max(crate::files::kinds::limits().import_max_bytes)
        .max(crate::files::bytes::rules().limits.body_bytes);
    let manifest = database
        .checked_add(stage.manifest_bytes)
        .ok_or_else(|| error(K::SourceLimit, "Manifest budget overflow."))?;
    body_total
        .checked_add(database)
        .and_then(|x| x.checked_add(stage.total_bytes))
        .ok_or_else(|| error(K::SourceLimit, "Aggregate budget overflow."))?;
    Ok(Limits {
        body,
        body_total,
        database,
        retained,
        retained_total: stage.total_bytes,
        files,
        entries,
        path_bytes,
        depth,
        manifest,
    })
}
pub(super) fn checked_path(path: &str) -> Result<()> {
    let l = limits()?;
    if path.len() > l.path_bytes || path.split('/').count() > l.depth {
        return Err(error(
            K::SourceLimit,
            "A path exceeds the selected path budget.",
        ));
    }
    stage::valid_path(path)
        .map_err(|_| error(K::InvalidPath, "A contained relative path is required."))
}
// Storage adds only the compiled transport namespace to an admitted logical path.
pub(super) fn checked_storage_path(path: &str) -> Result<()> {
    let l = limits()?;
    let prefix = rules()
        .bodies
        .len()
        .max(rules().metadata.len() + 1 + rules().archive.len());
    if path.len()
        > l.path_bytes
            .checked_add(prefix + 1)
            .ok_or_else(|| error(K::SourceLimit, "Storage path overflow."))?
        || path.split('/').count() > l.depth + 2
    {
        return Err(error(
            K::SourceLimit,
            "A transport path exceeds its derived namespace bound.",
        ));
    }
    stage::valid_path(path)
        .map_err(|_| error(K::InvalidPath, "A contained relative path is required."))
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Namespace {
    Bodies,
    Metadata,
    Originals,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Category {
    CanonicalBody,
    Database,
    Retained,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Key {
    pub namespace: Namespace,
    pub path: String,
}
impl Key {
    pub(super) fn physical(&self) -> String {
        match self.namespace {
            Namespace::Bodies => format!("{}/{}", rules().bodies, self.path),
            Namespace::Metadata => format!("{}/{}", rules().metadata, self.path),
            Namespace::Originals => {
                format!("{}/{}/{}", rules().metadata, rules().archive, self.path)
            }
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Part {
    pub namespace: Namespace,
    pub path: String,
    pub category: Category,
    pub bytes: String,
    pub hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Exclusion {
    pub namespace: Namespace,
    pub path: String,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub format: u32,
    pub state: String,
    pub authority: String,
    pub workspace_id: String,
    pub schema_version: i64,
    pub schema_revision: String,
    pub metadata_epoch: String,
    pub parts: Vec<Part>,
    pub directories: Vec<Key>,
    pub exclusions: Vec<Exclusion>,
    pub omitted_scopes: Vec<String>,
}
impl Part {
    fn key(&self) -> Key {
        Key {
            namespace: self.namespace.clone(),
            path: self.path.clone(),
        }
    }
    pub(super) fn physical(&self) -> String {
        self.key().physical()
    }
}
impl Exclusion {
    fn key(&self) -> Key {
        Key {
            namespace: self.namespace.clone(),
            path: self.path.clone(),
        }
    }
}
fn number(text: &str) -> Result<u64> {
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(error(
            K::InvalidManifest,
            "A byte/count field is not canonical decimal text.",
        ));
    }
    text.parse().map_err(|_| {
        error(
            K::SourceLimit,
            "A declared count exceeds its integer bound.",
        )
    })
}
fn hash_valid(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn part_cap(category: &Category) -> Result<u64> {
    let l = limits()?;
    Ok(match category {
        Category::CanonicalBody => l.body,
        Category::Database => l.database,
        Category::Retained => l.retained,
    })
}
fn add_part_budget(totals: &mut [u64; 3], category: &Category, bytes: u64) -> Result<()> {
    let l = limits()?;
    let (index, cap) = match category {
        Category::CanonicalBody => (0, l.body_total),
        Category::Database => (1, l.database),
        Category::Retained => (2, l.retained_total),
    };
    totals[index] = totals[index]
        .checked_add(bytes)
        .filter(|sum| *sum <= cap)
        .ok_or_else(|| {
            error(
                K::SourceLimit,
                "The category aggregate exceeds its declared support limit.",
            )
        })?;
    Ok(())
}
fn exclusion(key: &Key) -> Option<String> {
    let folded = stage::folded_path(&key.path);
    if matches!(key.namespace, Namespace::Bodies | Namespace::Originals) {
        if let Some(reason) = stage::exclusion(&key.path) {
            return Some(reason);
        }
        if [
            stage::rules().marker.as_str(),
            stage::rules().manifest.as_str(),
            rules().restored_manifest.as_str(),
        ]
        .iter()
        .any(|path| folded == stage::folded_path(path))
        {
            return Some("source_control_artifact".into());
        }
        if folded
            == stage::folded_path(&format!(
                "{}/{}",
                crate::ledger::LEDGER_DIR,
                crate::ledger::writer::LOCK_FILE
            ))
        {
            return Some("operational_state".into());
        }
    }
    None
}
fn insert_name(names: &mut BTreeMap<String, bool>, path: &str, directory: bool) -> Result<()> {
    let folded = stage::folded_path(path);
    if names.insert(folded, directory).is_some() {
        return Err(error(
            K::InvalidPath,
            "Portable names collide under the existing filesystem fold.",
        ));
    }
    Ok(())
}
fn verify_prefixes(names: &BTreeMap<String, bool>) -> Result<()> {
    for name in names.keys() {
        for (offset, _) in name.match_indices('/') {
            if names.get(&name[..offset]) == Some(&false) {
                return Err(error(
                    K::InvalidPath,
                    "A portable file is also a directory prefix.",
                ));
            }
        }
    }
    Ok(())
}
fn expanded_names(manifest: &Manifest) -> Result<()> {
    let l = limits()?;
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    let mut bytes = 0u64;
    for path in manifest
        .parts
        .iter()
        .map(Part::physical)
        .chain(manifest.directories.iter().map(Key::physical))
    {
        for end in path
            .match_indices('/')
            .map(|(offset, _)| offset)
            .chain(std::iter::once(path.len()))
        {
            let prefix = &path[..end];
            let folded = stage::folded_path(prefix);
            if let Some(existing) = names.get(&folded) {
                if existing != prefix {
                    return Err(error(
                        K::InvalidPath,
                        "Directory prefixes alias under the existing filesystem fold.",
                    ));
                }
            } else {
                bytes = bytes
                    .checked_add((folded.len() + prefix.len()) as u64)
                    .filter(|sum| *sum <= l.manifest)
                    .ok_or_else(|| {
                        error(
                            K::SourceLimit,
                            "Expanded path coverage exceeds its byte budget.",
                        )
                    })?;
                if names.len() >= l.entries {
                    return Err(error(
                        K::SourceLimit,
                        "Expanded path coverage exceeds its entry budget.",
                    ));
                }
                names.insert(folded, prefix.into());
            }
        }
    }
    Ok(())
}
pub(super) fn preflight(manifest: &Manifest) -> Result<()> {
    let l = limits()?;
    if manifest.format != rules().format
        || manifest.state != rules().complete_state
        || manifest.authority != stage::rules().authority
        || manifest.omitted_scopes != rules().omitted_scopes
    {
        return Err(error(
            K::InvalidManifest,
            "The portable format or declared omission contract is unsupported.",
        ));
    }
    if manifest.parts.len() > l.files
        || manifest
            .parts
            .len()
            .checked_add(manifest.directories.len())
            .and_then(|n| n.checked_add(manifest.exclusions.len()))
            .is_none_or(|n| n > l.entries)
    {
        return Err(error(
            K::SourceLimit,
            "Portable entry coverage exceeds its bound.",
        ));
    }
    let mut names = BTreeMap::new();
    let mut totals = [0; 3];
    let mut dbs = 0;
    for part in &manifest.parts {
        checked_path(&part.path)?;
        insert_name(&mut names, &part.physical(), false)?;
        let size = number(&part.bytes)?;
        if size > part_cap(&part.category)? {
            return Err(error(
                K::SourceLimit,
                "A declared part exceeds its category limit.",
            ));
        }
        add_part_budget(&mut totals, &part.category, size)?;
        if !hash_valid(&part.hash) {
            return Err(error(
                K::InvalidManifest,
                "A part hash is not canonical SHA-256.",
            ));
        }
        if exclusion(&part.key()).is_some() {
            return Err(error(
                K::InvalidManifest,
                "An excluded source is present as a payload.",
            ));
        }
        if part.namespace == Namespace::Metadata {
            if part.path != rules().database || part.category != Category::Database {
                return Err(error(
                    K::InvalidManifest,
                    "Only the captured canonical database is a metadata payload.",
                ));
            }
            dbs += 1;
        } else if part.category == Category::Database
            || (part.namespace == Namespace::Originals && part.category != Category::Retained)
        {
            return Err(error(
                K::InvalidManifest,
                "Part category disagrees with its namespace.",
            ));
        }
    }
    if dbs != 1 {
        return Err(error(
            K::RequiredPartMissing,
            "Exactly one canonical metadata snapshot is required.",
        ));
    }
    for directory in &manifest.directories {
        checked_path(&directory.path)?;
        if exclusion(directory).is_some()
            || (directory.namespace == Namespace::Metadata && directory.path != rules().archive)
        {
            return Err(error(
                K::InvalidManifest,
                "A directory is excluded or outside the supported namespace.",
            ));
        }
        insert_name(&mut names, &directory.physical(), true)?;
    }
    verify_prefixes(&names)?;
    expanded_names(manifest)?;
    let mut excluded = BTreeSet::new();
    for item in &manifest.exclusions {
        checked_path(&item.path)?;
        let physical = stage::folded_path(&item.key().physical());
        let expected = if item.namespace == Namespace::Metadata {
            operational_metadata(&item.path).then(|| "operational_state".to_owned())
        } else {
            exclusion(&item.key())
        };
        if names.contains_key(&physical)
            || !excluded.insert(physical)
            || expected.as_deref() != Some(item.reason.as_str())
        {
            return Err(error(
                K::InvalidManifest,
                "An exclusion conflicts with declared content.",
            ));
        }
    }
    number(&manifest.schema_revision)?;
    number(&manifest.metadata_epoch)?;
    Ok(())
}
fn prefixes(path: &str, out: &mut BTreeSet<String>) {
    for (offset, _) in path.match_indices('/') {
        out.insert(path[..offset].into());
    }
}
fn covered_tree(root: &Root, manifest: &Manifest, has_manifest: bool) -> Result<()> {
    let mut files = BTreeSet::new();
    let mut directories = BTreeSet::from([rules().bodies.clone(), rules().metadata.clone()]);
    for part in &manifest.parts {
        let path = part.physical();
        prefixes(&path, &mut directories);
        files.insert(path);
    }
    for key in &manifest.directories {
        let path = key.physical();
        prefixes(&path, &mut directories);
        directories.insert(path);
    }
    if has_manifest {
        files.insert(rules().manifest.clone());
    }
    let mut actual_files = BTreeSet::new();
    let mut actual_directories = BTreeSet::new();
    let mut count = 0;
    for entry in walkdir::WalkDir::new(&root.path)
        .follow_links(false)
        .min_depth(1)
        .max_depth(limits()?.depth + 4)
    {
        let entry = entry.map_err(|_| {
            error(
                K::InvalidManifest,
                "Bundle membership cannot be read completely.",
            )
        })?;
        count += 1;
        if count > limits()?.entries {
            return Err(error(
                K::SourceLimit,
                "Bundle membership exceeds its entry bound.",
            ));
        }
        let rel = entry
            .path()
            .strip_prefix(&root.path)
            .ok()
            .and_then(Path::to_str)
            .ok_or_else(|| error(K::InvalidPath, "A bundle path is not supported UTF-8."))?;
        if entry.file_type().is_symlink()
            || !(entry.file_type().is_file() || entry.file_type().is_dir())
        {
            return Err(error(
                K::InvalidPath,
                "Bundle membership contains a link or special file.",
            ));
        }
        if entry.file_type().is_dir() {
            actual_directories.insert(rel.into());
        } else {
            actual_files.insert(rel.into());
        }
    }
    if actual_files != files || actual_directories != directories {
        let missing = files.difference(&actual_files).next().is_some();
        return Err(error(
            if missing {
                K::RequiredPartMissing
            } else {
                K::InvalidManifest
            },
            "Bundle membership disagrees with its complete manifest.",
        ));
    }
    root.validate()
}
fn part_bytes(root: &Root, part: &Part) -> Result<(Vec<u8>, io::Stamp)> {
    let result = root.read(&part.physical(), part_cap(&part.category)?)?;
    if result.0.len() as u64 != number(&part.bytes)?
        || crate::ledger::sha256_hex(&result.0) != part.hash
    {
        return Err(error(
            K::PartMismatch,
            "A required portable part does not match its recorded bytes.",
        ));
    }
    Ok(result)
}
fn database_part(manifest: &Manifest) -> &Part {
    manifest
        .parts
        .iter()
        .find(|p| p.category == Category::Database)
        .expect("preflight database")
}
fn verify(root: &Root, manifest: &Manifest, has_manifest: bool) -> Result<BackupFacts> {
    preflight(manifest)?;
    // Reject physical links before comparing hashes, including hostile metadata.
    covered_tree(root, manifest, has_manifest)?;
    let database = database_part(manifest);
    let (database_bytes, _) = part_bytes(root, database)?;
    step(
        "validate_database_captured",
        &root.path,
        &root.path.join(database.physical()),
    );
    let facts = selected::read_offline(&database_bytes, &manifest.workspace_id, limits()?.database)
        .map_err(|e| error(K::InvalidMetadata, e.message))?;
    part_bytes(root, database)?;
    if facts.schema_version != manifest.schema_version
        || facts.schema_revision.to_string() != manifest.schema_revision
        || facts.epoch.to_string() != manifest.metadata_epoch
    {
        return Err(error(
            K::InvalidMetadata,
            "Portable header disagrees with the actual SQLite snapshot.",
        ));
    }
    let records: BTreeMap<_, _> = facts
        .records
        .iter()
        .map(|record| (record.path.as_str(), record))
        .collect();
    let bodies: BTreeMap<_, _> = manifest
        .parts
        .iter()
        .filter(|part| part.namespace == Namespace::Bodies)
        .map(|part| (part.path.as_str(), part))
        .collect();
    for record in &facts.records {
        let part = bodies
            .get(record.path.as_str())
            .ok_or_else(|| error(K::RequiredPartMissing, "A canonical body is missing."))?;
        if part.category != Category::CanonicalBody || part.hash != record.body_hash {
            return Err(error(
                K::InvalidMetadata,
                "A body does not match its canonical metadata identity.",
            ));
        }
    }
    for part in &manifest.parts {
        if part.category == Category::CanonicalBody
            && (part.namespace != Namespace::Bodies || !records.contains_key(part.path.as_str()))
        {
            return Err(error(
                K::InvalidMetadata,
                "A declared canonical body has no metadata identity.",
            ));
        }
        if part.namespace == Namespace::Bodies
            && part.path.ends_with(".md")
            && !records.contains_key(part.path.as_str())
            && !stage::retained_carrier(&part.path)
        {
            return Err(error(
                K::RequiredPartMissing,
                "An ordinary body has no canonical metadata identity.",
            ));
        }
        if part.category == Category::Database {
            continue;
        }
        let (bytes, _) = part_bytes(root, part)?;
        if part.namespace == Namespace::Bodies {
            verify_body_part(root, manifest, &bodies, part, &bytes)?;
        }
    }
    verify_ledger(root, manifest, &bodies)?;
    covered_tree(root, manifest, has_manifest)?;
    Ok(facts)
}
fn verify_body_part(
    root: &Root,
    manifest: &Manifest,
    bodies: &BTreeMap<&str, &Part>,
    part: &Part,
    bytes: &[u8],
) -> Result<()> {
    let path = &part.path;
    if crate::files::kinds::is_whiteboard(path) {
        return Err(error(
            K::UnsupportedDependency,
            "Canvas dependency verification is not yet supported by this portable slice.",
        ));
    }
    if part.category == Category::CanonicalBody
        || (crate::knowledge::is_knowledge_path(path) && path.ends_with(".md"))
    {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| error(K::InvalidMetadata, "A current Markdown body is not UTF-8."))?;
        let dependencies = crate::files::media::backup_dependencies(path, text)
            .map_err(|message| error(K::UnsupportedDependency, message))?;
        for dependency in dependencies {
            if !bodies.contains_key(dependency.as_str()) {
                return Err(error(
                    K::RequiredPartMissing,
                    "A required local Markdown dependency is missing or excluded.",
                ));
            }
        }
    }
    let folded = stage::folded_path(path);
    if folded.starts_with(".comments/") && folded.ends_with(".json") {
        if bytes.len() > crate::vault::comments::MAX_FILE_BYTES {
            return Err(error(
                K::SourceLimit,
                "Comment sidecar exceeds its native bound.",
            ));
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| error(K::InvalidMetadata, "Comment sidecar is not UTF-8."))?;
        crate::vault::comments::parse_comments(text)
            .map_err(|_| error(K::InvalidMetadata, "Comment sidecar is invalid."))?;
    }
    if folded.starts_with(".trash/") && folded.ends_with("/.trashed.json") {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| error(K::InvalidMetadata, "Trash manifest is not UTF-8."))?;
        let item = crate::vault::trash::parse_manifest(text)
            .ok_or_else(|| error(K::InvalidMetadata, "Trash manifest is invalid."))?;
        let parent = path.rsplit_once('/').expect("trash parent").0;
        let target = format!("{parent}/{}", item.path);
        let exists = bodies.contains_key(target.as_str())
            || manifest.directories.iter().any(|directory| {
                directory.namespace == Namespace::Bodies && directory.path == target
            });
        if !exists {
            return Err(error(
                K::RequiredPartMissing,
                "A Trash manifest's retained item is missing.",
            ));
        }
    }
    root.validate()
}
fn verify_ledger(root: &Root, manifest: &Manifest, bodies: &BTreeMap<&str, &Part>) -> Result<()> {
    use crate::ledger;
    let prefix = format!("{}/", ledger::LEDGER_DIR);
    let store_path = format!("{prefix}store.json");
    let has_ledger = bodies.keys().any(|path| path.starts_with(&prefix));
    let has_knowledge = bodies
        .keys()
        .any(|path| crate::knowledge::is_knowledge_path(path) && path.ends_with(".md"));
    let projection_part = bodies.get(ledger::manifest::MANIFEST_PATH);
    if !has_ledger && !has_knowledge && projection_part.is_none() {
        return Ok(());
    }
    let store_part = bodies
        .get(store_path.as_str())
        .ok_or_else(|| error(K::InvalidLedger, "Canonical ledger identity is missing."))?;
    let (store_bytes, _) = part_bytes(root, store_part)?;
    let store: ledger::store::StoreInfo = serde_json::from_slice(&store_bytes)
        .map_err(|_| error(K::InvalidLedger, "Canonical ledger identity is invalid."))?;
    if store.format != ledger::store::STORE_FORMAT
        || store.store_id.len() != 32
        || !store
            .store_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error(
            K::InvalidLedger,
            "Canonical ledger format/identity is unsupported.",
        ));
    }
    let mut segments = BTreeMap::new();
    let mut lines = 0usize;
    for (path, part) in bodies {
        let Some(name) = path.strip_prefix(&prefix) else {
            continue;
        };
        if name == "store.json" {
            continue;
        }
        if !name.is_ascii() || ledger::segment::parse_segment_name(name).is_none() {
            return Err(error(
                K::InvalidLedger,
                "Unsupported ledger debris prevents complete verification.",
            ));
        }
        let (bytes, _) = part_bytes(root, part)?;
        for line in bytes.split(|byte| *byte == b'\n') {
            if !line.is_empty() {
                lines = lines
                    .checked_add(1)
                    .ok_or_else(|| error(K::SourceLimit, "Ledger count overflow."))?;
                if lines > rules().limits.ledger_frames
                    || line.len() as u64 > rules().limits.ledger_line_bytes
                {
                    return Err(error(
                        K::SourceLimit,
                        "Ledger parsing exceeds its explicit frame/line budget.",
                    ));
                }
            }
        }
        segments.insert(name.to_owned(), bytes);
    }
    let read = ledger::read_captured(store, &segments)
        .map_err(|e| error(K::InvalidLedger, e.to_string()))?;
    if !matches!(read.tail, ledger::segment::Tail::Clean) {
        return Err(error(
            K::InvalidLedger,
            "Ledger recovery must settle before complete backup.",
        ));
    }
    let state = ledger::reduce::reduce(&read.frames, &read.store.store_id);
    if !state.anomalies.is_empty() || !state.reconciliation_divergences.is_empty() {
        return Err(error(
            K::InvalidLedger,
            "Ledger semantics require reconciliation; backup will not repair them.",
        ));
    }
    let projection_part = projection_part
        .ok_or_else(|| error(K::InvalidLedger, "Projection manifest is missing."))?;
    let (bytes, _) = part_bytes(root, projection_part)?;
    let projection: ledger::manifest::Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| error(K::InvalidLedger, "Projection manifest is invalid."))?;
    if projection.format != ledger::manifest::MANIFEST_FORMAT {
        return Err(error(
            K::InvalidLedger,
            "Projection format requires an explicit supported migration.",
        ));
    }
    let projected: BTreeMap<_, _> = state
        .projection_paths
        .iter()
        .map(|(path, id)| {
            (
                format!("{}/{path}", crate::knowledge::KNOWLEDGE_DIR),
                id.clone(),
            )
        })
        .collect();
    let declared: BTreeMap<_, _> = projection
        .entries
        .iter()
        .map(|(path, entry)| (path.clone(), entry.belief_id.clone()))
        .collect();
    if projected != declared {
        return Err(error(
            K::InvalidLedger,
            "Projection coverage differs from the canonical ledger.",
        ));
    }
    for (path, entry) in &projection.entries {
        checked_path(path)?;
        let part = bodies.get(path.as_str()).ok_or_else(|| {
            error(
                K::RequiredPartMissing,
                "A canonical projection body is missing.",
            )
        })?;
        let (bytes, _) = part_bytes(root, part)?;
        let expected = ledger::reduce::project_belief(&state, &entry.belief_id)
            .map_err(|_| error(K::InvalidLedger, "A projection identity is unavailable."))?;
        let fact = ledger::reconcile::FileFact {
            hash: Some(ledger::sha256_hex(&bytes)),
            parses: std::str::from_utf8(&bytes).is_ok(),
        };
        if bytes != expected.bytes.as_bytes()
            || ledger::reconcile::classify_path(&fact, Some(entry), Some(&expected), false)
                != ledger::reconcile::PathClass::Match
        {
            return Err(error(
                K::InvalidLedger,
                "Canonical ledger, projection manifest and retained bytes disagree.",
            ));
        }
    }
    for path in bodies
        .keys()
        .filter(|path| crate::knowledge::is_knowledge_path(path) && path.ends_with(".md"))
    {
        if !projection.entries.contains_key(*path) {
            return Err(error(
                K::InvalidLedger,
                "A governed carrier is not accounted for by its canonical projection manifest.",
            ));
        }
    }
    // The global inventory accounts for Trash/reconciliation bytes independently.
    let _ = manifest;
    Ok(())
}

fn operational_metadata(rel: &str) -> bool {
    let names = &crate::workspace_migration::journal::rules().names;
    let folded = stage::folded_path(rel);
    let first = folded.split('/').next().unwrap_or("");
    first == names.lock
        || first.starts_with(&names.prepare_prefix)
        || first.starts_with(&names.retired_prefix)
        || ["-journal", "-wal", "-shm"]
            .iter()
            .any(|suffix| folded == format!("{}{suffix}", rules().database))
}
#[cfg(target_os = "macos")]
fn pending_metadata(rel: &str) -> bool {
    stage::folded_path(rel).split('/').next()
        == Some(
            crate::workspace_migration::journal::rules()
                .names
                .pending
                .as_str(),
        )
}
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SourcePart {
    metadata: bool,
    rel: String,
    identity: Identity,
    part: Part,
}
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Observed {
    metadata: bool,
    rel: String,
    directory: bool,
    identity: Identity,
}
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Inventory {
    parts: Vec<SourcePart>,
    directories: Vec<Key>,
    exclusions: Vec<Exclusion>,
    observed: Vec<Observed>,
}
#[cfg(target_os = "macos")]
fn inventory(bodies: &Root, metadata: &Root, facts: &BackupFacts) -> Result<Inventory> {
    let l = limits()?;
    let records: BTreeMap<_, _> = facts
        .records
        .iter()
        .map(|record| (record.path.as_str(), record))
        .collect();
    let mut out = Inventory {
        parts: Vec::new(),
        directories: Vec::new(),
        exclusions: Vec::new(),
        observed: Vec::new(),
    };
    let mut totals = [0; 3];
    for (is_metadata, root) in [(false, bodies), (true, metadata)] {
        let mut names = BTreeMap::new();
        for entry in walkdir::WalkDir::new(&root.path)
            .follow_links(false)
            .min_depth(1)
            .max_depth(l.depth + 2)
        {
            let entry = entry.map_err(|_| {
                error(
                    K::RequiredPartMissing,
                    "Source membership cannot be read completely.",
                )
            })?;
            if out.observed.len() >= l.entries {
                return Err(error(
                    K::SourceLimit,
                    "Source entry coverage exceeds its explicit bound.",
                ));
            }
            let rel = entry
                .path()
                .strip_prefix(&root.path)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| error(K::InvalidPath, "A source path is not supported UTF-8."))?
                .to_owned();
            if is_metadata {
                checked_storage_path(&rel)?;
            } else {
                checked_path(&rel)?;
            }
            let directory = entry.file_type().is_dir();
            if entry.file_type().is_symlink() || !(directory || entry.file_type().is_file()) {
                return Err(error(
                    K::InvalidPath,
                    "Source contains a link or special file.",
                ));
            }
            insert_name(&mut names, &rel, directory)?;
            let identity = root.identity(&rel)?;
            out.observed.push(Observed {
                metadata: is_metadata,
                rel: rel.clone(),
                directory,
                identity,
            });
            let (key, special) = if is_metadata {
                if pending_metadata(&rel) {
                    return Err(error(
                        K::RecoveryRequired,
                        "Paired recovery must finish before backup.",
                    ));
                }
                if operational_metadata(&rel) {
                    (
                        Key {
                            namespace: Namespace::Metadata,
                            path: rel.clone(),
                        },
                        Some("operational_state".to_owned()),
                    )
                } else if rel == rules().database && !directory {
                    // Never open/hash the live SQLite inode through an unrelated FD.
                    continue;
                } else if rel == rules().archive && directory {
                    (
                        Key {
                            namespace: Namespace::Metadata,
                            path: rel.clone(),
                        },
                        None,
                    )
                } else if let Some(original) = rel.strip_prefix(&format!("{}/", rules().archive)) {
                    let key = Key {
                        namespace: Namespace::Originals,
                        path: original.into(),
                    };
                    let excluded = exclusion(&key);
                    (key, excluded)
                } else {
                    return Err(error(
                        K::InvalidMetadata,
                        "Unknown private metadata storage cannot be exported by guessing.",
                    ));
                }
            } else {
                let key = Key {
                    namespace: Namespace::Bodies,
                    path: rel.clone(),
                };
                let excluded = exclusion(&key);
                (key, excluded)
            };
            if let Some(reason) = special {
                // Deliberately no file open, byte length or hash for excluded entries.
                out.exclusions.push(Exclusion {
                    namespace: key.namespace,
                    path: key.path,
                    reason,
                });
                continue;
            }
            if directory {
                out.directories.push(key);
                continue;
            }
            let category =
                if key.namespace == Namespace::Bodies && records.contains_key(key.path.as_str()) {
                    Category::CanonicalBody
                } else {
                    if key.namespace == Namespace::Bodies
                        && key.path.ends_with(".md")
                        && !stage::retained_carrier(&key.path)
                    {
                        return Err(error(
                            K::RequiredPartMissing,
                            "An ordinary body has no canonical metadata identity.",
                        ));
                    }
                    Category::Retained
                };
            if out.parts.len() >= l.files.saturating_sub(1) {
                return Err(error(
                    K::SourceLimit,
                    "Source file coverage exceeds its bound.",
                ));
            }
            let (bytes, stamp) = root.read(&rel, part_cap(&category)?)?;
            if stamp.identity != identity {
                return Err(error(
                    K::SourceChanged,
                    "A source file changed before capture.",
                ));
            }
            add_part_budget(&mut totals, &category, bytes.len() as u64)?;
            let hash = crate::ledger::sha256_hex(&bytes);
            if category == Category::CanonicalBody
                && records
                    .get(key.path.as_str())
                    .expect("known canonical path")
                    .body_hash
                    != hash
            {
                return Err(error(
                    K::SourceChanged,
                    "A visible body differs from its acknowledged canonical pair.",
                ));
            }
            out.parts.push(SourcePart {
                metadata: is_metadata,
                rel,
                identity,
                part: Part {
                    namespace: key.namespace,
                    path: key.path,
                    category,
                    bytes: bytes.len().to_string(),
                    hash,
                },
            });
        }
        verify_prefixes(&names)?;
        root.validate()?;
    }
    for record in &facts.records {
        if !out
            .parts
            .iter()
            .any(|part| part.part.namespace == Namespace::Bodies && part.part.path == record.path)
        {
            return Err(error(
                K::RequiredPartMissing,
                "A canonical body is missing from source coverage.",
            ));
        }
    }
    out.parts.sort_by_key(|a| a.part.physical());
    out.directories.sort();
    out.exclusions.sort_by_key(|a| a.key());
    out.observed
        .sort_by(|a, b| (a.metadata, &a.rel).cmp(&(b.metadata, &b.rel)));
    Ok(out)
}
fn separate(paths: &[&Path]) -> Result<()> {
    for (i, a) in paths.iter().enumerate() {
        let a = a
            .to_str()
            .ok_or_else(|| error(K::InvalidPath, "A root is not supported UTF-8."))?;
        let a = stage::folded_path(a);
        for b in &paths[i + 1..] {
            let b = b
                .to_str()
                .ok_or_else(|| error(K::InvalidPath, "A root is not supported UTF-8."))?;
            let b = stage::folded_path(b);
            if a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/")) {
                return Err(error(
                    K::DestinationUnavailable,
                    "Source and new destination roots must be separate.",
                ));
            }
        }
    }
    Ok(())
}
fn new_destination(path: &Path) -> Result<PathBuf> {
    stage::new_destination(path).map_err(|_| {
        error(
            K::DestinationUnavailable,
            "A new destination with an existing real parent is required.",
        )
    })
}
#[cfg(target_os = "macos")]
fn ledger_guard(root: &Root) -> Result<Option<io::ExistingLock>> {
    let path = root.path.join(crate::ledger::LEDGER_DIR);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(
            K::InvalidLedger,
            "Ledger ownership cannot be inspected.",
        )),
        Ok(_) => io::ExistingLock::acquire(
            &root.path,
            &format!(
                "{}/{}",
                crate::ledger::LEDGER_DIR,
                crate::ledger::writer::LOCK_FILE
            ),
        )
        .map(Some),
    }
}
#[cfg(all(test, target_os = "macos"))]
type TestStepAction = Box<dyn FnOnce(&Path, &Path)>;
#[cfg(all(test, target_os = "macos"))]
struct TestStep {
    name: &'static str,
    action: TestStepAction,
}
#[cfg(all(test, target_os = "macos"))]
thread_local! { static TEST_STEP: std::cell::RefCell<Option<TestStep>> = const { std::cell::RefCell::new(None) }; }
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn with_step<T>(
    name: &'static str,
    action: impl FnOnce(&Path, &Path) + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<TestStep>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_STEP.with(|cell| *cell.borrow_mut() = self.0.take());
        }
    }
    let previous = TEST_STEP.with(|cell| {
        cell.replace(Some(TestStep {
            name,
            action: Box::new(action),
        }))
    });
    let _reset = Reset(previous);
    run()
}
pub(super) fn step(name: &'static str, first: &Path, second: &Path) {
    #[cfg(all(test, target_os = "macos"))]
    {
        let action = TEST_STEP.with(|cell| {
            if cell.borrow().as_ref().is_some_and(|step| step.name == name) {
                cell.borrow_mut().take()
            } else {
                None
            }
        });
        if let Some(step) = action {
            (step.action)(first, second);
        }
    }
    #[cfg(not(all(test, target_os = "macos")))]
    {
        let _ = (name, first, second);
    }
}
#[cfg(target_os = "macos")]
pub(super) fn create_backup(source_root: &Path, destination: &Path) -> Result<super::BackupReport> {
    let source = selected::Source::open(source_root).map_err(authority_error)?;
    create_backup_inner(source, destination, None).map(|report| super::BackupReport { workspace_id: report.workspace_id })
}
#[cfg(target_os = "macos")]
pub(super) fn create_reserved_backup(
    expected: crate::workspace_service::authority::AdmittedBackupRead,
    output: &mut crate::workspace_service::authority::OutputReservation,
) -> Result<super::NativeCopyReport> {
    let destination = output.path().map_err(authority_error)?;
    let source = selected::Source::open_expected(expected).map_err(authority_error)?;
    create_backup_inner(source, &destination, Some(output))
}
#[cfg(target_os = "macos")]
fn create_backup_inner(
    source: selected::Source,
    destination: &Path,
    mut reserved: Option<&mut crate::workspace_service::authority::OutputReservation>,
) -> Result<super::NativeCopyReport> {
    let bodies = Root::open(source.root())?;
    let metadata = Root::open(source.metadata())?;
    let destination = new_destination(destination)?;
    separate(&[&bodies.path, &metadata.path, &destination])?;
    let ledger = ledger_guard(&bodies)?;
    let captured = inventory(&bodies, &metadata, &source.facts)?;
    source.validate().map_err(authority_error)?;
    if let Some(guard) = &ledger {
        guard.validate()?;
    }
    let output = match reserved.as_deref_mut() {
        Some(lease) => lease.create_root().map_err(authority_error)?.into_root(),
        None => Root::create(&destination)?,
    };
    output.directory(&rules().bodies)?;
    output.directory(&rules().metadata)?;
    step("export_captured", &bodies.path, &output.path);
    for directory in &captured.directories {
        output.directory(&directory.physical())?;
    }
    for captured_part in &captured.parts {
        let input = if captured_part.metadata {
            &metadata
        } else {
            &bodies
        };
        let (bytes, stamp) =
            input.read(&captured_part.rel, part_cap(&captured_part.part.category)?)?;
        if stamp.identity != captured_part.identity
            || bytes.len() as u64 != number(&captured_part.part.bytes)?
            || crate::ledger::sha256_hex(&bytes) != captured_part.part.hash
        {
            return Err(error(
                K::SourceChanged,
                "A source part changed before its copy.",
            ));
        }
        output.write_new(&captured_part.part.physical(), &bytes)?;
    }
    let database_key = Key {
        namespace: Namespace::Metadata,
        path: rules().database.clone(),
    };
    let snapshot_path = database_key.physical();
    let snapshot_identity = output.write_new(&snapshot_path, &[])?;
    source
        .snapshot_to(
            &output.path.join(&snapshot_path),
            limits()?.database,
            snapshot_identity.tuple(),
        )
        .map_err(authority_error)?;
    let (database_bytes, _) = output.read(&snapshot_path, limits()?.database)?;
    let mut parts: Vec<_> = captured
        .parts
        .iter()
        .map(|entry| entry.part.clone())
        .collect();
    parts.push(Part {
        namespace: Namespace::Metadata,
        path: rules().database.clone(),
        category: Category::Database,
        bytes: database_bytes.len().to_string(),
        hash: crate::ledger::sha256_hex(&database_bytes),
    });
    drop(database_bytes);
    parts.sort_by_key(Part::physical);
    let manifest = Manifest {
        format: rules().format,
        state: rules().complete_state.clone(),
        authority: stage::rules().authority.clone(),
        workspace_id: source.facts.workspace_id.clone(),
        schema_version: source.facts.schema_version,
        schema_revision: source.facts.schema_revision.to_string(),
        metadata_epoch: source.facts.epoch.to_string(),
        parts,
        directories: captured.directories.clone(),
        exclusions: captured.exclusions.clone(),
        omitted_scopes: rules().omitted_scopes.clone(),
    };
    step("export_copied", &bodies.path, &output.path);
    step("export_publish", &bodies.path, &output.path);
    match output.identity(&rules().manifest) {
        Err(error) if error.kind == K::RequiredPartMissing => {}
        _ => {
            return Err(error(
                K::DestinationUnavailable,
                "The new manifest slot is no longer absent.",
            ))
        }
    }
    verify(&output, &manifest, false)?;
    if inventory(&bodies, &metadata, &source.facts)? != captured {
        return Err(error(
            K::SourceChanged,
            "Source membership or included bytes changed during backup.",
        ));
    }
    source.validate().map_err(authority_error)?;
    if let Some(guard) = &ledger {
        guard.validate()?;
    }
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|_| error(K::InvalidManifest, "Portable manifest cannot be encoded."))?;
    if bytes.len() as u64 > limits()?.manifest {
        return Err(error(
            K::SourceLimit,
            "Portable manifest exceeds its derived transport bound.",
        ));
    }
    // Footprint-only check: never reacquire ActiveRoot under SQLite/ledger.
    if let Some(lease) = reserved.as_deref() { lease.validate().map_err(authority_error)?; }
    output.validate()?;
    // Readiness is create-new and last. Any preceding failure leaves no complete manifest.
    let summary = compact_summary(&manifest)?;
    if let Some(lease) = reserved.as_deref() { lease.publication_attempted(); }
    step("export_publication_attempt", &bodies.path, &output.path);
    output.write_new(&rules().manifest, &bytes)?;
    if let Some(lease) = reserved.as_deref() { lease.published(); }
    step("export_published", &bodies.path, &output.path);
    Ok(super::NativeCopyReport {
        workspace_id: manifest.workspace_id,
        summary: Some(summary),
    })
}
#[cfg(not(target_os = "macos"))]
pub(super) fn create_backup(
    _source_root: &Path,
    _destination: &Path,
) -> Result<super::BackupReport> {
    Err(error(
        K::UnsupportedPlatform,
        "Live portable backup requires the reviewed macOS descriptor alias boundary.",
    ))
}
#[derive(Debug)]
pub(super) struct Verified {
    root: Root,
    pub manifest: Manifest,
    pub manifest_hash: String,
    manifest_identity: Identity,
}
pub(super) fn validate_bundle(path: &Path) -> Result<Verified> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| error(K::RequiredPartMissing, "Backup input is unavailable."))?;
    if meta.is_file() {
        return Err(error(
            K::UnsupportedContainer,
            "Only bounded directory bundles are supported.",
        ));
    }
    validate_held_root(Root::open(path)?, None)
}
fn manifest_changed() -> BackupError {
    error(K::SourceChanged, "The original input manifest changed identity or bytes.")
}
fn same_manifest_bytes(root: &Root, identity: Identity, hash: Option<&str>) -> Result<Vec<u8>> {
    root.validate()?;
    if root.identity(&rules().manifest)? != identity { return Err(manifest_changed()); }
    let (bytes, stamp) = root.read(&rules().manifest, limits()?.manifest)?;
    if stamp.identity != identity
        || root.identity(&rules().manifest)? != identity
        || hash.is_some_and(|expected| crate::ledger::sha256_hex(&bytes) != expected)
    {
        return Err(manifest_changed());
    }
    Ok(bytes)
}
/// The original native descriptor reaches the existing complete validator.
/// No pathname reopen or retained validation inventory substitutes for it.
fn validate_held_root(root: Root, expected: Option<((u64, u64), &str)>) -> Result<Verified> {
    root.validate()?;
    let identity = root.identity(&rules().manifest)?;
    if expected.is_some_and(|(original, _)| original != (identity.dev, identity.ino)) {
        return Err(manifest_changed());
    }
    let bytes = same_manifest_bytes(&root, identity, expected.map(|(_, hash)| hash))?;
    let manifest_hash = crate::ledger::sha256_hex(&bytes);
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| error(K::InvalidManifest, "Portable manifest shape is invalid."))?;
    drop(bytes);
    verify(&root, &manifest, true)?;
    // The verification hook/metadata validator may have yielded to an external
    // replacement. Never bless its new inode even when its bytes are identical.
    same_manifest_bytes(&root, identity, Some(&manifest_hash))?;
    Ok(Verified { root, manifest, manifest_hash, manifest_identity: identity })
}
fn unchanged(verified: &Verified) -> Result<()> {
    same_manifest_bytes(&verified.root, verified.manifest_identity, Some(&verified.manifest_hash))?;
    verify(&verified.root, &verified.manifest, true)?;
    same_manifest_bytes(&verified.root, verified.manifest_identity, Some(&verified.manifest_hash))?;
    Ok(())
}
fn destination_part(key: &Key) -> (bool, String) {
    match key.namespace {
        Namespace::Bodies => (false, key.path.clone()),
        Namespace::Metadata => (true, key.path.clone()),
        Namespace::Originals => (true, format!("{}/{}", rules().archive, key.path)),
    }
}
fn installed_coverage(
    bodies: &Root,
    metadata: &Root,
    manifest: &Manifest,
    provenance: bool,
) -> Result<()> {
    for (is_metadata, root) in [(false, bodies), (true, metadata)] {
        let mut files = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for part in &manifest.parts {
            let (owner, path) = destination_part(&part.key());
            if owner == is_metadata {
                prefixes(&path, &mut directories);
                files.insert(path);
            }
        }
        for key in &manifest.directories {
            let (owner, path) = destination_part(key);
            if owner == is_metadata {
                prefixes(&path, &mut directories);
                directories.insert(path);
            }
        }
        // Both roots carry their own deny-only boundary; folder labels grant nothing.
        prefixes(&stage::rules().marker, &mut directories);
        files.insert(stage::rules().marker.clone());
        if !is_metadata && provenance {
            prefixes(&rules().restored_manifest, &mut directories);
            files.insert(rules().restored_manifest.clone());
        }
        // Source/bundle limits stay unchanged. Generated control entries have
        // their own small, vocabulary-derived output allowance.
        let mut control_directories = BTreeSet::new();
        prefixes(&stage::rules().marker, &mut control_directories);
        let mut control_files = 1usize;
        if !is_metadata && provenance {
            prefixes(&rules().restored_manifest, &mut control_directories);
            control_files += 1;
        }
        let output_entries = limits()?
            .entries
            .checked_add(control_directories.len())
            .and_then(|n| n.checked_add(control_files))
            .ok_or_else(|| error(K::SourceLimit, "Restore output entry budget overflow."))?;
        let mut actual_files = BTreeSet::new();
        let mut actual_directories = BTreeSet::new();
        let mut count = 0usize;
        for entry in walkdir::WalkDir::new(&root.path)
            .follow_links(false)
            .min_depth(1)
            .max_depth(limits()?.depth + 3)
        {
            let entry = entry
                .map_err(|_| error(K::SourceChanged, "Destination coverage cannot be verified."))?;
            count = count
                .checked_add(1)
                .filter(|n| *n <= output_entries)
                .ok_or_else(|| error(K::SourceLimit, "Destination coverage exceeds its bound."))?;
            let rel = entry
                .path()
                .strip_prefix(&root.path)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| {
                    error(K::InvalidPath, "A destination name is not supported UTF-8.")
                })?;
            if entry.file_type().is_symlink()
                || !(entry.file_type().is_file() || entry.file_type().is_dir())
            {
                return Err(error(
                    K::InvalidPath,
                    "A destination contains a link or special file.",
                ));
            }
            if entry.file_type().is_dir() {
                actual_directories.insert(rel.to_owned());
            } else {
                actual_files.insert(rel.to_owned());
            }
        }
        if files != actual_files || directories != actual_directories {
            return Err(error(
                K::SourceChanged,
                "Destination membership changed before inactive publication.",
            ));
        }
        root.validate()?;
    }
    Ok(())
}
pub(in crate::workspace_migration) fn restore_bundle(
    bundle: &Path,
    body_destination: &Path,
    metadata_destination: &Path,
) -> Result<crate::workspace_migration::restore::RestoreReport> {
    let verified = validate_bundle(bundle)?;
    let body_destination = new_destination(body_destination)?;
    let metadata_destination = new_destination(metadata_destination)?;
    separate(&[
        &verified.root.path,
        &body_destination,
        &metadata_destination,
    ])?;
    restore_verified(verified, |metadata| {
        Root::create(if metadata { &metadata_destination } else { &body_destination })
    }, None)
}
fn validate_restore_lease(reserved: Option<&crate::workspace_service::authority::OutputReservation>) -> Result<()> {
    if let Some(output) = reserved { output.validate().map_err(authority_error)?; }
    Ok(())
}
/// Shared writer: both path-library and native-held entrypoints use identical
/// preparing markers, copy, validation and final inactive publication.
fn restore_verified(
    verified: Verified,
    mut create_root: impl FnMut(bool) -> Result<Root>,
    reserved: Option<&crate::workspace_service::authority::OutputReservation>,
) -> Result<crate::workspace_migration::restore::RestoreReport> {
    validate_restore_lease(reserved)?;
    let bodies = create_root(false)?;
    let preparing = crate::workspace_migration::format_gate::marker_bytes("preparing", None)
        .map_err(|_| error(K::InvalidManifest, "Preparing marker cannot be encoded."))?;
    if preparing.len() as u64 > stage::rules().limits.marker_bytes {
        return Err(error(
            K::SourceLimit,
            "Preparing boundary exceeds its byte limit.",
        ));
    }
    let marker = bodies.write_new(&stage::rules().marker, &preparing)?;
    validate_restore_lease(reserved)?;
    let metadata = create_root(true)?;
    // Deny legacy ancestry before the first database/original carrier is installed.
    let metadata_marker = metadata.write_new(&stage::rules().marker, &preparing)?;
    step("restore_roots_sealed", &bodies.path, &metadata.path);
    for key in &verified.manifest.directories {
        let (in_metadata, path) = destination_part(key);
        (if in_metadata { &metadata } else { &bodies }).directory(&path)?;
    }
    for part in &verified.manifest.parts {
        let (bytes, _) = part_bytes(&verified.root, part)?;
        let (in_metadata, path) = destination_part(&part.key());
        (if in_metadata { &metadata } else { &bodies }).write_new(&path, &bytes)?;
    }
    step("restore_copied", &bodies.path, &metadata.path);
    let encoded = serde_json::to_vec(&verified.manifest)
        .map_err(|_| error(K::InvalidManifest, "Restore provenance cannot be encoded."))?;
    bodies.write_new(&rules().restored_manifest, &encoded)?;
    step("restore_publish", &bodies.path, &metadata.path);
    // Recheck every installed byte against the same complete input before readiness.
    for part in &verified.manifest.parts {
        let (in_metadata, path) = destination_part(&part.key());
        let root = if in_metadata { &metadata } else { &bodies };
        let (bytes, _) = root.read(&path, part_cap(&part.category)?)?;
        if bytes.len() as u64 != number(&part.bytes)?
            || crate::ledger::sha256_hex(&bytes) != part.hash
        {
            return Err(error(
                K::PartMismatch,
                "A restored part changed before publication.",
            ));
        }
    }
    installed_coverage(&bodies, &metadata, &verified.manifest, true)?;
    step(
        "restore_database_capture",
        &metadata.path,
        &metadata.path.join(&rules().database),
    );
    let (database_bytes, _) = metadata.read(&rules().database, limits()?.database)?;
    let database = database_part(&verified.manifest);
    if database_bytes.len() as u64 != number(&database.bytes)?
        || crate::ledger::sha256_hex(&database_bytes) != database.hash
    {
        return Err(error(
            K::PartMismatch,
            "Restored metadata no longer matches its verified snapshot.",
        ));
    }
    step(
        "restore_database_captured",
        &metadata.path,
        &metadata.path.join(&rules().database),
    );
    let facts = selected::read_offline(
        &database_bytes,
        &verified.manifest.workspace_id,
        limits()?.database,
    )
    .map_err(|e| error(K::InvalidMetadata, e.message))?;
    if metadata.read(&rules().database, limits()?.database)?.0 != database_bytes {
        return Err(error(
            K::PartMismatch,
            "Restored metadata changed during validation.",
        ));
    }
    if facts.epoch.to_string() != verified.manifest.metadata_epoch
        || facts.schema_revision.to_string() != verified.manifest.schema_revision
        || facts.schema_version != verified.manifest.schema_version
    {
        return Err(error(
            K::InvalidMetadata,
            "Restored metadata disagrees with its verified snapshot.",
        ));
    }
    unchanged(&verified)?;
    let (provenance, _) = bodies.read(&rules().restored_manifest, limits()?.manifest)?;
    if provenance != encoded {
        return Err(error(
            K::PartMismatch,
            "Restore provenance changed before inactive publication.",
        ));
    }
    let marker_bytes = crate::workspace_migration::format_gate::marker_bytes(
        "restored_inactive",
        Some(crate::ledger::sha256_hex(&encoded)),
    )
    .map_err(|_| error(K::InvalidManifest, "Inactive marker cannot be encoded."))?;
    if marker_bytes.len() as u64 > stage::rules().limits.marker_bytes {
        return Err(error(
            K::SourceLimit,
            "Inactive boundary exceeds its byte limit.",
        ));
    }
    validate_restore_lease(reserved)?;
    if let Some(lease) = reserved { lease.publication_attempted(); }
    step("restore_publication_attempt", &bodies.path, &metadata.path);
    metadata.finish_marker(&stage::rules().marker, metadata_marker, &marker_bytes)?;
    validate_restore_lease(reserved)?;
    bodies.finish_marker(&stage::rules().marker, marker, &marker_bytes)?;
    if let Some(lease) = reserved { lease.published(); }
    step("restore_published", &bodies.path, &metadata.path);
    Ok(crate::workspace_migration::restore::RestoreReport {
        workspace_id: verified.manifest.workspace_id,
    })
}

/// One directory descriptor and bounded evidence survive native review.
#[derive(Debug)]
pub(crate) struct CheckedBackupInput {
    root: Root,
    manifest_identity: (u64, u64),
    manifest_hash: String,
    summary: CheckedBackupSummary,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckedBackupSummary {
    pub workspace_id: String,
    pub format: u32,
    pub schema_version: i64,
    pub part_count: usize,
    pub total_bytes: String,
}
impl CheckedBackupInput {
    pub(crate) fn path(&self) -> &Path { &self.root.path }
    pub(crate) fn summary(&self) -> &CheckedBackupSummary { &self.summary }
}
fn compact_summary(manifest: &Manifest) -> Result<CheckedBackupSummary> {
    let total = manifest.parts.iter().try_fold(0u64, |total, part| {
        total.checked_add(number(&part.bytes)?).ok_or_else(|| error(K::SourceLimit, "Summary byte total overflow."))
    })?;
    Ok(CheckedBackupSummary { workspace_id: manifest.workspace_id.clone(), format: manifest.format, schema_version: manifest.schema_version, part_count: manifest.parts.len(), total_bytes: total.to_string() })
}
pub(super) fn check_input(path: &Path) -> Result<CheckedBackupInput> {
    let Verified { root, manifest, manifest_hash, manifest_identity } = validate_bundle(path)?;
    let summary = compact_summary(&manifest)?;
    let manifest_identity = (manifest_identity.dev, manifest_identity.ino);
    // Manifest/parts and transient offline database bytes drop before returning.
    Ok(CheckedBackupInput { root, manifest_identity, manifest_hash, summary })
}
pub(super) fn restore_reserved(
    input: CheckedBackupInput,
    output: &mut crate::workspace_service::authority::OutputReservation,
) -> Result<crate::workspace_migration::restore::RestoreReport> {
    let CheckedBackupInput { root, manifest_identity, manifest_hash, summary: _ } = input;
    let verified = validate_held_root(root, Some((manifest_identity, &manifest_hash)))?;
    let destination = output.path().map_err(authority_error)?;
    separate(&[&verified.root.path, &destination])?;
    let children = &crate::workspace_service::backup_policy::rules().restore_children;
    let container = output.create_root().map_err(authority_error)?.into_root();
    // Container and child descriptors remain inside the outer lease owner.
    // The kernel never reconstructs these choices from renderer paths.
    restore_verified(verified, |metadata| {
        container.validate()?;
        container.create_child(if metadata { &children.metadata } else { &children.bodies })
    }, Some(output))
}
