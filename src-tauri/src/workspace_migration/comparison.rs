//! Disposable store protocol and real comparison harness. Never registered by the app.
use super::identity::WorkspaceManifest;
use crate::workspace_service::types::prototype::*;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct State {
    pub format: u8,
    pub identity: WorkspaceManifest,
    pub revision: u64,
    pub schema_revision: u64,
    pub records: BTreeMap<String, Record>,
    pub retained: BTreeMap<String, String>,
    pub archive: BTreeMap<String, String>,
}
#[derive(Debug, Clone)]
pub(crate) struct SeedRecord {
    pub id: String,
    pub path: String,
    pub body: Vec<u8>,
    pub properties: Properties,
}
#[derive(Debug, Clone)]
pub(crate) struct Seed {
    pub identity: WorkspaceManifest,
    pub records: Vec<SeedRecord>,
    pub retained: BTreeMap<String, Vec<u8>>,
    pub archive: BTreeMap<String, Vec<u8>>,
    pub dispositions: Vec<Disposition>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fault {
    None,
    AfterIntent,
    AfterVisible,
    AfterMetadata,
}
#[derive(Debug, Clone, Copy)]
pub(crate) enum Backend {
    Sidecar,
    Sqlite,
}

pub(crate) trait WorkspaceStore {
    fn root(&self) -> &Path;
    fn metadata_root(&self) -> &Path;
    fn load_state(&self) -> Result<State>;
    fn commit_state(&mut self, state: &State) -> Result<()>;
    fn read_record(&self, access: &PrototypeScope, id: &str) -> Result<RecordSnapshot> {
        let _lock = lock(self.root())?;
        no_pending(self.root())?;
        let state = self.load_state()?;
        check_scope(self.root(), &state, access)?;
        if !access.can_read(id) {
            return Err(error("scope_denied", "Record is outside readable scope."));
        }
        snapshot(
            self.root(),
            state
                .records
                .get(id)
                .ok_or_else(|| error("not_found", "No canonical metadata for this ID."))?,
        )
    }
    fn apply(
        &mut self,
        access: &PrototypeScope,
        mutation: Mutation,
        fault: Fault,
    ) -> Result<PrototypeOutcome> {
        apply(self, access, mutation, fault)
    }
    fn query(&self, access: &PrototypeScope, request: &QueryRequest) -> Result<QueryPage> {
        let _lock = lock(self.root())?;
        no_pending(self.root())?;
        let state = self.load_state()?;
        check_scope(self.root(), &state, access)?;
        let rows = state
            .records
            .values()
            .filter(|r| access.can_read(&r.id))
            .map(|r| snapshot(self.root(), r))
            .collect::<Result<Vec<_>>>()?;
        crate::workspace_service::query::execute(
            access,
            rows,
            state.revision,
            state.schema_revision,
            request,
        )
    }
    fn recover(&mut self) -> Result<()> {
        recover(self)
    }
    fn backup(&self, destination: &Path) -> Result<()> {
        backup(self, destination)
    }
}

use super::{
    identity::{self, RecordIdentity},
    inventory::{Carrier, MigrationInventory, Status, SyntaxNode},
    syntax::limits,
};
use crate::workspace_service::{
    query,
    types::values::{PropertyChange, PropertyValue, ValueSchema},
    value,
};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
};
const MAX_META: usize = 32 * 1024 * 1024;
const JOURNAL: &str = ".cerebro/prototype-journal.json";
const MARKER: &str = ".cerebro/prototype-owner.json";
fn io(e: std::io::Error) -> PrototypeError {
    error("io_unavailable", e.to_string())
}
fn json(e: serde_json::Error) -> PrototypeError {
    error("invalid_metadata", e.to_string())
}
/// Validate JSON syntax before serde's map decoding can discard duplicate names.
/// Input bytes, nesting and visited nodes are bounded before materialization.
pub(crate) fn decode_metadata<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    use serde::de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor};
    if bytes.len() > MAX_META {
        return Err(error("source_limit", "Metadata exceeds byte limit."));
    }
    struct Check<'a> {
        depth: usize,
        nodes: &'a mut usize,
    }
    impl<'de> DeserializeSeed<'de> for Check<'_> {
        type Value = ();
        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> std::result::Result<(), D::Error> {
            *self.nodes += 1;
            if self.depth > 96 || *self.nodes > 500_000 {
                return Err(D::Error::custom("Metadata nesting/node limit exceeded"));
            }
            deserializer.deserialize_any(self)
        }
    }
    impl<'de> Visitor<'de> for Check<'_> {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("bounded JSON without duplicate keys")
        }
        fn visit_bool<E: Error>(self, _: bool) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_i64<E: Error>(self, _: i64) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_u64<E: Error>(self, _: u64) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_f64<E: Error>(self, _: f64) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_str<E: Error>(self, _: &str) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_none<E: Error>(self) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_unit<E: Error>(self) -> std::result::Result<(), E> {
            Ok(())
        }
        fn visit_seq<A: SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> std::result::Result<(), A::Error> {
            while sequence
                .next_element_seed(Check {
                    depth: self.depth + 1,
                    nodes: self.nodes,
                })?
                .is_some()
            {}
            Ok(())
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<(), A::Error> {
            let mut seen = BTreeSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !seen.insert(key) {
                    return Err(A::Error::custom("Duplicate metadata name"));
                }
                map.next_value_seed(Check {
                    depth: self.depth + 1,
                    nodes: self.nodes,
                })?;
            }
            Ok(())
        }
    }
    let mut nodes = 0;
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    Check {
        depth: 0,
        nodes: &mut nodes,
    }
    .deserialize(&mut decoder)
    .map_err(json)?;
    decoder.end().map_err(json)?;
    serde_json::from_slice(bytes).map_err(json)
}
fn validate_intent(intent: &Intent) -> Result<()> {
    let invalid = || {
        error(
            "recovery_conflict",
            "Journal transition or recorded body hashes are inconsistent.",
        )
    };
    if intent.format != 1
        || intent.old_revision == 0
        || Some(intent.new_revision) != intent.old_revision.checked_add(1)
        || intent.old_schema == 0
    {
        return Err(invalid());
    }
    let changes_schema = is_type(intent.old_record.as_ref()) || is_type(intent.new_record.as_ref());
    let expected_schema = if changes_schema {
        intent.old_schema.checked_add(1)
    } else {
        Some(intent.old_schema)
    };
    if Some(intent.new_schema) != expected_schema {
        return Err(invalid());
    }
    for record in intent.old_record.iter().chain(intent.new_record.iter()) {
        if !ordinary(&record.path)
            || record.version.metadata_revision == 0
            || !is_hash(&record.version.body_hash)
        {
            return Err(invalid());
        }
        validate_properties(&record.properties)?;
    }
    match (&intent.old_record, &intent.new_record, &intent.body_change) {
        (Some(old), Some(new), None)
            if old.id == new.id
                && old.path == new.path
                && old.version.body_hash == new.version.body_hash
                && Some(new.version.metadata_revision)
                    == old.version.metadata_revision.checked_add(1) => {}
        (None, Some(new), Some(body))
            if new.version.metadata_revision == 1
                && body.path == new.path
                && body.before.is_none() =>
        {
            let bytes = body.after.as_ref().ok_or_else(invalid)?;
            validate_body(bytes)?;
            if hash(bytes) != new.version.body_hash {
                return Err(invalid());
            }
        }
        (Some(old), None, Some(body)) if body.path == old.path && body.after.is_none() => {
            let bytes = body.before.as_ref().ok_or_else(invalid)?;
            validate_body(bytes)?;
            if hash(bytes) != old.version.body_hash {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

fn hash(bytes: &[u8]) -> String {
    crate::ledger::sha256_hex(bytes)
}
fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn ordinary(path: &str) -> bool {
    super::inventory::valid_path(path)
        && path.ends_with(".md")
        && !path.starts_with("knowledge/")
        && !path.starts_with('.')
}
fn check_temp(root: &Path) -> Result<()> {
    let actual = fs::canonicalize(root).map_err(io)?;
    let temp = fs::canonicalize(std::env::temp_dir()).map_err(io)?;
    let slash_tmp = fs::canonicalize("/tmp").map_err(io)?;
    if actual == temp
        || actual == slash_tmp
        || (!actual.starts_with(&temp) && !actual.starts_with(&slash_tmp))
    {
        return Err(error(
            "not_disposable",
            "Prototype writes require a new temporary directory.",
        ));
    }
    Ok(())
}
fn new_root(root: &Path) -> Result<PathBuf> {
    if root.exists() {
        return Err(error("destination_exists", "Destination must not exist."));
    }
    let parent = root
        .parent()
        .ok_or_else(|| error("not_disposable", "A parent directory is required."))?;
    check_temp(parent)?;
    fs::create_dir(root).map_err(io)?;
    fs::canonicalize(root).map_err(io)
}
pub(crate) fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if !super::inventory::valid_path(relative) {
        return Err(error("unsafe_path", "Invalid contained relative path."));
    }
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(error("unsafe_path", "Prototype refuses symlinks."))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
    }
    Ok(path)
}
pub(crate) fn read_file(path: &Path, cap: usize) -> Result<Vec<u8>> {
    let mut file = File::open(path).map_err(io)?;
    let metadata = file.metadata().map_err(io)?;
    if !metadata.is_file() || metadata.len() > cap as u64 {
        return Err(error(
            "source_limit",
            "File is not regular or exceeds its byte limit.",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > cap {
        return Err(error("source_limit", "File grew beyond its byte limit."));
    }
    Ok(bytes)
}
fn sync_dir(path: &Path) -> Result<()> {
    File::open(path).map_err(io)?.sync_all().map_err(io)
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_META {
        return Err(error(
            "source_limit",
            "Atomic payload exceeds prototype limit.",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| error("unsafe_path", "Missing parent."))?;
    fs::create_dir_all(parent).map_err(io)?;
    let temp = parent.join(format!(".prototype-{:016x}.tmp", rand::random::<u64>()));
    let mut file = File::options()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(io)?;
    let result = (|| {
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        fs::rename(&temp, path).map_err(io)?;
        sync_dir(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub(crate) fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(json)
}
fn lock(root: &Path) -> Result<File> {
    let path = safe_path(root, ".cerebro/prototype.lock")?;
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .map_err(io)?;
    file.try_lock().map_err(|_| {
        error(
            "store_busy",
            "Another prototype operation holds the workspace lock.",
        )
    })?;
    Ok(file)
}
fn no_pending(root: &Path) -> Result<()> {
    if safe_path(root, JOURNAL)?.exists() {
        Err(error(
            "recovery_required",
            "A durable operation is pending recovery.",
        ))
    } else {
        Ok(())
    }
}
fn check_scope(root: &Path, state: &State, access: &PrototypeScope) -> Result<()> {
    if access.matches(root, &state.identity.workspace_id) {
        Ok(())
    } else {
        Err(error(
            "scope_denied",
            "Scope belongs to another disposable owner.",
        ))
    }
}
pub(crate) fn snapshot(root: &Path, record: &Record) -> Result<RecordSnapshot> {
    let path = safe_path(root, &record.path)?;
    if !path.exists() {
        return Err(error(
            "missing_body",
            "Canonical metadata has no visible body.",
        ));
    }
    let body = read_file(&path, limits().max_file_bytes)?;
    if hash(&body) != record.version.body_hash {
        return Err(error(
            "external_edit",
            "Visible body bytes differ; no automatic hash adoption.",
        ));
    }
    Ok(RecordSnapshot {
        record: record.clone(),
        body,
    })
}
fn validate_properties(properties: &Properties) -> Result<()> {
    value::decode_tagged(
        &serde_json::to_string(&PropertyValue::Object {
            value: properties.clone(),
        })
        .map_err(json)?,
    )
    .map_err(|e| error("schema_invalid", e.message))?;
    Ok(())
}
fn valid_relation_targets(value: &PropertyValue, records: &BTreeMap<String, Record>) -> bool {
    use crate::workspace_service::types::values::RelationResolution;
    match value {
        PropertyValue::Relation {
            resolution: RelationResolution::Resolved { target_id },
            ..
        } => records.contains_key(target_id),
        PropertyValue::Array { value } => value
            .iter()
            .all(|value| valid_relation_targets(value, records)),
        PropertyValue::Object { value } => value
            .values()
            .all(|value| valid_relation_targets(value, records)),
        _ => true,
    }
}
pub(crate) fn validate_state(state: &State) -> Result<()> {
    if state.format != 1
        || state.revision == 0
        || state.schema_revision == 0
        || state.revision > i64::MAX as u64
        || state.schema_revision > i64::MAX as u64
        || state.records.len() + state.retained.len() > limits().max_files
        || state.archive.len() > limits().max_files
    {
        return Err(error(
            "invalid_metadata",
            "Unsupported state or invalid persisted revision/count.",
        ));
    }
    identity::read_manifest(&encoded(&state.identity)?).map_err(|e| error(e.kind, e.detail))?;
    let ids = state
        .identity
        .records
        .iter()
        .map(|r| (r.record_id.as_str(), r.path.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut paths = BTreeSet::new();
    for (id, record) in &state.records {
        if id != &record.id
            || ids.get(id.as_str()) != Some(&record.path.as_str())
            || !ordinary(&record.path)
            || !paths.insert(&record.path)
            || record.version.metadata_revision == 0
            || record.version.metadata_revision > i64::MAX as u64
            || !is_hash(&record.version.body_hash)
        {
            return Err(error(
                "invalid_metadata",
                "Record identity, path or version is invalid.",
            ));
        }
        validate_properties(&record.properties)?;
        if !record
            .properties
            .values()
            .all(|value| valid_relation_targets(value, &state.records))
        {
            return Err(error(
                "unresolved_relation",
                "A resolved relation target is absent from the canonical record set.",
            ));
        }
    }
    for (path, digest) in state.retained.iter().chain(&state.archive) {
        if !super::inventory::valid_path(path) || !is_hash(digest) {
            return Err(error(
                "invalid_metadata",
                "Invalid retained/archive reference.",
            ));
        }
    }
    for path in state.retained.keys() {
        if paths.contains(path)
            || path == ".cerebro/workspace-manifest.json"
            || path.starts_with(".cerebro/prototype-")
            || path.starts_with(".cerebro/records/")
            || path.starts_with(".cerebro/originals/")
        {
            return Err(error(
                "invalid_metadata",
                "Retained source conflicts with prototype-owned metadata.",
            ));
        }
    }
    Ok(())
}
fn validate_body(body: &[u8]) -> Result<()> {
    if body.len() > limits().max_file_bytes {
        return Err(error("source_limit", "Body exceeds prototype limit."));
    }
    let source =
        std::str::from_utf8(body).map_err(|_| error("invalid_body", "Body must be UTF-8."))?;
    if crate::vault::parse::split_frontmatter(source).0.is_some() {
        return Err(error(
            "format_conflict",
            "Metadata frontmatter is not accepted in converted bodies.",
        ));
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    format: u8,
    backend: String,
    metadata_root: PathBuf,
    workspace_id: String,
}
fn backend_name(backend: Backend) -> &'static str {
    match backend {
        Backend::Sidecar => "sidecar",
        Backend::Sqlite => "sqlite",
    }
}
pub(crate) fn initialize(
    backend: Backend,
    root: &Path,
    metadata: &Path,
    seed: &Seed,
) -> Result<Box<dyn WorkspaceStore>> {
    if seed.records.len() > limits().max_files {
        return Err(error("source_limit", "Too many prototype records."));
    }
    identity::read_manifest(&encoded(&seed.identity)?).map_err(|e| error(e.kind, e.detail))?;
    let root = new_root(root)?;
    fs::create_dir(root.join(".cerebro")).map_err(io)?;
    let metadata = match backend {
        Backend::Sidecar => root.join(".cerebro"),
        Backend::Sqlite => {
            if metadata
                .parent()
                .map(fs::canonicalize)
                .transpose()
                .map_err(io)?
                .as_deref()
                != root.parent()
            {
                return Err(error(
                    "not_disposable",
                    "SQLite metadata must be a separate temporary sibling.",
                ));
            }
            new_root(metadata)?
        }
    };
    let mut state = State {
        format: 1,
        identity: seed.identity.clone(),
        revision: 1,
        schema_revision: 1,
        records: BTreeMap::new(),
        retained: BTreeMap::new(),
        archive: BTreeMap::new(),
    };
    let mut total = 0usize;
    for record in &seed.records {
        validate_body(&record.body)?;
        validate_properties(&record.properties)?;
        total = total
            .checked_add(record.body.len())
            .ok_or_else(|| error("source_limit", "Body total overflow."))?;
        if total > limits().max_total_bytes {
            return Err(error("source_limit", "Aggregate body limit exceeded."));
        }
        let record = Record {
            id: record.id.clone(),
            path: record.path.clone(),
            properties: record.properties.clone(),
            version: RecordVersion {
                metadata_revision: 1,
                body_hash: hash(&record.body),
            },
        };
        if state.records.insert(record.id.clone(), record).is_some() {
            return Err(error("invalid_metadata", "Duplicate record ID."));
        }
    }
    for (path, bytes) in &seed.retained {
        if bytes.len() > limits().max_file_bytes {
            return Err(error("source_limit", "Retained source exceeds limit."));
        }
        total += bytes.len();
        state.retained.insert(path.clone(), hash(bytes));
    }
    let mut archive_total = 0usize;
    for (path, bytes) in &seed.archive {
        archive_total = archive_total
            .checked_add(bytes.len())
            .ok_or_else(|| error("source_limit", "Archive size overflow."))?;
        if bytes.len() > limits().max_file_bytes {
            return Err(error("source_limit", "Archive source exceeds limit."));
        }
        state.archive.insert(path.clone(), hash(bytes));
    }
    if archive_total > limits().max_total_bytes {
        return Err(error("source_limit", "Aggregate archive limit exceeded."));
    }
    if total > limits().max_total_bytes {
        return Err(error(
            "source_limit",
            "Aggregate body/retained limit exceeded.",
        ));
    }
    validate_state(&state)?;
    for record in &seed.records {
        atomic_write(&safe_path(&root, &record.path)?, &record.body)?;
    }
    for (path, bytes) in &seed.retained {
        if state.records.values().any(|r| &r.path == path) {
            return Err(error(
                "invalid_metadata",
                "Retained carrier conflicts with ordinary record.",
            ));
        }
        atomic_write(&safe_path(&root, path)?, bytes)?;
    }
    for bytes in seed.archive.values() {
        atomic_write(
            &safe_path(&root, &format!(".cerebro/originals/{}.bytes", hash(bytes)))?,
            bytes,
        )?;
    }
    let mut store: Box<dyn WorkspaceStore> = match backend {
        Backend::Sidecar => Box::new(super::sidecar::Sidecar::new(root.clone(), metadata.clone())),
        Backend::Sqlite => Box::new(super::sqlite::Sqlite::create(
            root.clone(),
            metadata.clone(),
        )?),
    };
    store.commit_state(&state)?;
    atomic_write(
        &safe_path(&root, MARKER)?,
        &encoded(&Owner {
            format: 1,
            backend: backend_name(backend).into(),
            metadata_root: metadata,
            workspace_id: state.identity.workspace_id,
        })?,
    )?;
    Ok(store)
}
pub(crate) fn reopen(
    backend: Backend,
    root: &Path,
    metadata: &Path,
) -> Result<Box<dyn WorkspaceStore>> {
    check_temp(root)?;
    let root = fs::canonicalize(root).map_err(io)?;
    let owner: Owner = decode_metadata(&read_file(&safe_path(&root, MARKER)?, 65536)?)?;
    let expected = match backend {
        Backend::Sidecar => root.join(".cerebro"),
        Backend::Sqlite => fs::canonicalize(metadata).map_err(io)?,
    };
    if owner.format != 1
        || owner.backend != backend_name(backend)
        || owner.metadata_root != expected
    {
        return Err(error(
            "owner_mismatch",
            "Prototype owner/metadata binding mismatch.",
        ));
    }
    let mut store: Box<dyn WorkspaceStore> = match backend {
        Backend::Sidecar => Box::new(super::sidecar::Sidecar::new(root, expected)),
        Backend::Sqlite => Box::new(super::sqlite::Sqlite::open(root, expected)?),
    };
    let state = store.load_state()?;
    if state.identity.workspace_id != owner.workspace_id {
        return Err(error("owner_mismatch", "Workspace identity changed."));
    }
    store.recover()?;
    Ok(store)
}
pub(crate) fn scope(
    store: &dyn WorkspaceStore,
    read: &[String],
    write: &[String],
    create: &[String],
) -> Result<PrototypeScope> {
    let state = store.load_state()?;
    if create.iter().any(|path| !ordinary(path)) {
        return Err(error(
            "scope_denied",
            "Create paths must be ordinary Markdown.",
        ));
    }
    Ok(PrototypeScope::for_disposable_owner(
        store.root().to_owned(),
        state.identity.workspace_id,
        read.iter().cloned().collect(),
        write.iter().cloned().collect(),
        create.iter().cloned().collect(),
    ))
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    format: u8,
    old_revision: u64,
    new_revision: u64,
    old_schema: u64,
    new_schema: u64,
    old_record: Option<Record>,
    new_record: Option<Record>,
    body_change: Option<BodyChange>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BodyChange {
    path: String,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}
fn install(root: &Path, path: &str, bytes: Option<&[u8]>) -> Result<()> {
    let path = safe_path(root, path)?;
    if let Some(bytes) = bytes {
        atomic_write(&path, bytes)
    } else {
        fs::remove_file(&path).map_err(io)?;
        sync_dir(path.parent().unwrap())
    }
}
fn current_body(root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    let path = safe_path(root, path)?;
    if path.exists() {
        read_file(&path, limits().max_file_bytes).map(Some)
    } else {
        Ok(None)
    }
}
fn is_type(record: Option<&Record>) -> bool {
    record.is_some_and(
        |r| matches!(r.properties.get("type"),Some(PropertyValue::String{value}) if value=="Type"),
    )
}
fn next(value: u64) -> Result<u64> {
    value
        .checked_add(1)
        .ok_or_else(|| error("revision_limit", "Revision overflow."))
}
fn apply<S: WorkspaceStore + ?Sized>(
    store: &mut S,
    access: &PrototypeScope,
    mutation: Mutation,
    fault: Fault,
) -> Result<PrototypeOutcome> {
    let _lock = lock(store.root())?;
    no_pending(store.root())?;
    let state = store.load_state()?;
    check_scope(store.root(), &state, access)?;
    let (id, expected_schema) = match &mutation {
        Mutation::Create {
            id,
            expected_schema,
            ..
        }
        | Mutation::Patch {
            id,
            expected_schema,
            ..
        }
        | Mutation::Delete {
            id,
            expected_schema,
            ..
        } => (id.clone(), *expected_schema),
    };
    if expected_schema != state.schema_revision {
        return Err(error("stale_schema", "Schema revision changed."));
    }
    let old = state.records.get(&id).cloned();
    let mut changed = state.clone();
    let (new_record, body_change, keys) = match mutation {
        Mutation::Create {
            id,
            path,
            body,
            properties,
            ..
        } => {
            if !access.can_create(&path) || !ordinary(&path) {
                return Err(error("scope_denied", "Create path is outside scope."));
            }
            if old.is_some()
                || state
                    .identity
                    .records
                    .iter()
                    .any(|r| r.record_id == id || r.path == path)
                || current_body(store.root(), &path)?.is_some()
            {
                return Err(error(
                    "already_exists",
                    "Identity/path was already allocated or visible bytes exist.",
                ));
            }
            validate_body(&body)?;
            validate_properties(&properties)?;
            changed.identity.records.push(RecordIdentity {
                record_id: id.clone(),
                path: path.clone(),
                source_hash: hash(&body),
            });
            let keys = properties.keys().cloned().collect();
            let record = Record {
                id,
                path: path.clone(),
                properties,
                version: RecordVersion {
                    metadata_revision: 1,
                    body_hash: hash(&body),
                },
            };
            (
                Some(record),
                Some(BodyChange {
                    path,
                    before: None,
                    after: Some(body),
                }),
                keys,
            )
        }
        Mutation::Patch {
            expected, changes, ..
        } => {
            if !access.can_write(&id) || !access.can_read(&id) {
                return Err(error("scope_denied", "Record is outside write/read scope."));
            }
            let record = old
                .as_ref()
                .ok_or_else(|| error("not_found", "No record."))?;
            if record.version != expected {
                return Err(error("stale_revision", "Record version changed."));
            }
            snapshot(store.root(), record)?;
            let mut updated = record.clone();
            let mut keys = BTreeSet::new();
            for change in changes {
                let key = match &change {
                    PropertyChange::Set { key, .. } | PropertyChange::Remove { key } => key,
                };
                if key.is_empty() || !keys.insert(key.clone()) {
                    return Err(error(
                        "schema_invalid",
                        "Property changes require unique nonempty keys.",
                    ));
                }
                match change {
                    PropertyChange::Set { key, value } => {
                        updated.properties.insert(key, value);
                    }
                    PropertyChange::Remove { key } => {
                        updated.properties.remove(&key);
                    }
                }
            }
            validate_properties(&updated.properties)?;
            updated.version.metadata_revision = next(record.version.metadata_revision)?;
            (Some(updated), None, keys.into_iter().collect())
        }
        Mutation::Delete { expected, .. } => {
            if !access.can_write(&id) || !access.can_read(&id) {
                return Err(error("scope_denied", "Record is outside write/read scope."));
            }
            let record = old
                .as_ref()
                .ok_or_else(|| error("not_found", "No record."))?;
            if record.version != expected {
                return Err(error("stale_revision", "Record version changed."));
            }
            let old_body = snapshot(store.root(), record)?.body;
            (
                None,
                Some(BodyChange {
                    path: record.path.clone(),
                    before: Some(old_body),
                    after: None,
                }),
                Vec::new(),
            )
        }
    };
    if let Some(record) = &new_record {
        let body = match body_change.as_ref().and_then(|b| b.after.as_ref()) {
            Some(body) => body.clone(),
            None => {
                snapshot(
                    store.root(),
                    old.as_ref()
                        .ok_or_else(|| error("invalid_metadata", "Patch has no preimage."))?,
                )?
                .body
            }
        };
        let schema_rows = state
            .records
            .values()
            .filter(|r| is_type(Some(r)))
            .map(|r| snapshot(store.root(), r))
            .collect::<Result<Vec<_>>>()?;
        query::validate_changes(
            &schema_rows,
            &RecordSnapshot {
                record: record.clone(),
                body,
            },
            &keys,
        )?;
        changed.records.insert(id.clone(), record.clone());
    } else {
        changed.records.remove(&id);
    }
    changed.revision = next(state.revision)?;
    if is_type(old.as_ref()) || is_type(new_record.as_ref()) {
        changed.schema_revision = next(state.schema_revision)?;
    }
    validate_state(&changed)?;
    let intent = Intent {
        format: 1,
        old_revision: state.revision,
        new_revision: changed.revision,
        old_schema: state.schema_revision,
        new_schema: changed.schema_revision,
        old_record: old,
        new_record: new_record.clone(),
        body_change,
    };
    atomic_write(&safe_path(store.root(), JOURNAL)?, &encoded(&intent)?)?;
    if fault == Fault::AfterIntent {
        return Err(error("interrupted", "Stopped after durable intent."));
    }
    if let Some(body) = &intent.body_change {
        install(store.root(), &body.path, body.after.as_deref())?;
    }
    if fault == Fault::AfterVisible {
        return Err(error("interrupted", "Stopped after visible installation."));
    }
    store.commit_state(&changed)?;
    if fault == Fault::AfterMetadata {
        return Err(error("interrupted", "Stopped after metadata commit."));
    }
    fs::remove_file(safe_path(store.root(), JOURNAL)?).map_err(io)?;
    sync_dir(&store.root().join(".cerebro"))?;
    Ok(PrototypeOutcome {
        workspace_revision: changed.revision,
        schema_revision: changed.schema_revision,
        version: new_record.map(|r| r.version),
    })
}
fn recover<S: WorkspaceStore + ?Sized>(store: &mut S) -> Result<()> {
    let _lock = lock(store.root())?;
    let path = safe_path(store.root(), JOURNAL)?;
    if !path.exists() {
        return Ok(());
    }
    let intent: Intent = decode_metadata(&read_file(&path, MAX_META)?)?;
    validate_intent(&intent)?;
    let state = store.load_state()?;
    let target = intent
        .new_record
        .as_ref()
        .or(intent.old_record.as_ref())
        .ok_or_else(|| error("recovery_conflict", "Intent has no target."))?;
    let committed = if state.revision == intent.old_revision
        && state.schema_revision == intent.old_schema
        && state.records.get(&target.id) == intent.old_record.as_ref()
    {
        false
    } else if state.revision == intent.new_revision
        && state.schema_revision == intent.new_schema
        && state.records.get(&target.id) == intent.new_record.as_ref()
    {
        true
    } else {
        return Err(error(
            "recovery_conflict",
            "Metadata does not match either journal state.",
        ));
    };
    if intent.format != 1 || Some(intent.new_revision) != intent.old_revision.checked_add(1) {
        return Err(error(
            "recovery_conflict",
            "Invalid journal version transition.",
        ));
    }
    if let Some(body) = &intent.body_change {
        if !ordinary(&body.path) || body.path != target.path {
            return Err(error("recovery_conflict", "Journal body target mismatch."));
        }
        let current = current_body(store.root(), &body.path)?;
        if current != body.before && current != body.after {
            return Err(error(
                "recovery_conflict",
                "Third-party bytes prevent automatic recovery.",
            ));
        }
        let wanted = if committed { &body.after } else { &body.before };
        if &current != wanted {
            install(store.root(), &body.path, wanted.as_deref())?;
        }
    }
    if let Some(record) = state.records.get(&target.id) {
        snapshot(store.root(), record)?;
    }
    fs::remove_file(path).map_err(io)?;
    sync_dir(&store.root().join(".cerebro"))?;
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    format: u8,
    state: State,
    required: BTreeMap<String, String>,
    omitted: Vec<String>,
}
fn backup<S: WorkspaceStore + ?Sized>(store: &S, destination: &Path) -> Result<()> {
    let _lock = lock(store.root())?;
    no_pending(store.root())?;
    let state = store.load_state()?;
    let destination = new_root(destination)?;
    let mut required = BTreeMap::new();
    for record in state.records.values() {
        let body = snapshot(store.root(), record)?.body;
        let path = format!("bodies/{}", record.path);
        atomic_write(&safe_path(&destination, &path)?, &body)?;
        required.insert(path, hash(&body));
    }
    for (path, expected) in &state.retained {
        let bytes = read_file(&safe_path(store.root(), path)?, limits().max_file_bytes)?;
        if hash(&bytes) != *expected {
            return Err(error("external_edit", "Retained source changed."));
        }
        let target = format!("bodies/{path}");
        atomic_write(&safe_path(&destination, &target)?, &bytes)?;
        required.insert(target, expected.clone());
    }
    for expected in state.archive.values() {
        let name = format!(".cerebro/originals/{expected}.bytes");
        let bytes = read_file(&safe_path(store.root(), &name)?, limits().max_file_bytes)?;
        if hash(&bytes) != *expected {
            return Err(error("archive_corrupt", "Original archive hash mismatch."));
        }
        let target = format!("originals/{expected}.bytes");
        atomic_write(&safe_path(&destination, &target)?, &bytes)?;
        required.insert(target, expected.clone());
    }
    atomic_write(
        &safe_path(&destination, "backup.json")?,
        &encoded(&Backup {
            format: 1,
            state,
            required,
            omitted: vec![
                "unscoped ledger/attachments/comments".into(),
                "app-global operational history and credentials".into(),
            ],
        })?,
    )
}
pub(crate) fn restore(
    backend: Backend,
    backup: &Path,
    root: &Path,
    metadata: &Path,
) -> Result<Box<dyn WorkspaceStore>> {
    check_temp(backup)?;
    let backup = fs::canonicalize(backup).map_err(io)?;
    let manifest: Backup =
        decode_metadata(&read_file(&safe_path(&backup, "backup.json")?, MAX_META)?)?;
    if manifest.format != 1 || manifest.required.len() > limits().max_files * 3 {
        return Err(error("invalid_backup", "Unsupported or oversized backup."));
    }
    validate_state(&manifest.state)?;
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    for (path, expected) in &manifest.required {
        let bytes = read_file(&safe_path(&backup, path)?, limits().max_file_bytes)?;
        total += bytes.len();
        if total > limits().max_total_bytes * 2 || !is_hash(expected) || hash(&bytes) != *expected {
            return Err(error(
                "invalid_backup",
                "Backup part/hash/aggregate limit mismatch.",
            ));
        }
        files.insert(path.clone(), bytes);
    }
    let mut seed = Seed {
        identity: manifest.state.identity.clone(),
        records: Vec::new(),
        retained: BTreeMap::new(),
        archive: BTreeMap::new(),
        dispositions: Vec::new(),
    };
    for record in manifest.state.records.values() {
        let body = files
            .get(&format!("bodies/{}", record.path))
            .ok_or_else(|| error("invalid_backup", "Required body was omitted."))?
            .clone();
        if hash(&body) != record.version.body_hash {
            return Err(error("invalid_backup", "Body disagrees with metadata."));
        }
        seed.records.push(SeedRecord {
            id: record.id.clone(),
            path: record.path.clone(),
            body,
            properties: record.properties.clone(),
        });
    }
    for (path, expected) in &manifest.state.retained {
        let bytes = files
            .get(&format!("bodies/{path}"))
            .ok_or_else(|| error("invalid_backup", "Retained bytes omitted."))?;
        if hash(bytes) != *expected {
            return Err(error("invalid_backup", "Retained hash mismatch."));
        }
        seed.retained.insert(path.clone(), bytes.clone());
    }
    for (path, expected) in &manifest.state.archive {
        let bytes = files
            .get(&format!("originals/{expected}.bytes"))
            .ok_or_else(|| error("invalid_backup", "Original bytes omitted."))?;
        if hash(bytes) != *expected {
            return Err(error("invalid_backup", "Original hash mismatch."));
        }
        seed.archive.insert(path.clone(), bytes.clone());
    }
    let mut store = initialize(backend, root, metadata, &seed)?;
    let marker = safe_path(store.root(), MARKER)?;
    let owner = read_file(&marker, 65536)?;
    fs::remove_file(&marker).map_err(io)?;
    sync_dir(marker.parent().unwrap())?;
    store.commit_state(&manifest.state)?;
    atomic_write(&marker, &owner)?;
    Ok(store)
}
fn syntax_value(node: &SyntaxNode) -> Result<PropertyValue> {
    match node {
        SyntaxNode::Scalar(scalar) => {
            if !scalar.plain {
                return Ok(PropertyValue::String {
                    value: scalar.text.clone(),
                });
            }
            if let Ok(value) = value::decode_json(&scalar.text, ValueSchema::Plain) {
                return Ok(value);
            }
            match serde_yaml::from_str::<serde_yaml::Value>(&scalar.text) {
                Ok(serde_yaml::Value::String(_)) => Ok(PropertyValue::String {
                    value: scalar.text.clone(),
                }),
                Ok(serde_yaml::Value::Null) => Ok(PropertyValue::Null {}),
                _ => Err(error(
                    "unsupported_scalar",
                    "Non-JSON numeric/boolean YAML spelling requires a separate codec.",
                )),
            }
        }
        SyntaxNode::Sequence(nodes) => Ok(PropertyValue::Array {
            value: nodes.iter().map(syntax_value).collect::<Result<_>>()?,
        }),
        SyntaxNode::Mapping(pairs) => {
            let mut values = BTreeMap::new();
            for (key, node) in pairs {
                let SyntaxNode::Scalar(key) = key else {
                    return Err(error("unsupported_key", "Only string keys convert."));
                };
                if values
                    .insert(key.text.clone(), syntax_value(node)?)
                    .is_some()
                {
                    return Err(error("duplicate_key", "Duplicate metadata key."));
                }
            }
            Ok(PropertyValue::Object { value: values })
        }
        SyntaxNode::Alias => Err(error(
            "unsupported_alias",
            "Aliases retain their original source.",
        )),
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Disposition {
    path: String,
    disposition: String,
    reason: String,
}
fn convert_relation(
    value: &PropertyValue,
    index: &crate::vault::link::TargetIndex<'_>,
    ids: &BTreeMap<String, String>,
) -> Result<PropertyValue> {
    use crate::workspace_service::types::values::RelationResolution;
    match value {
        PropertyValue::String { value: spelling } => {
            let targets = crate::vault::parse::wikilink_targets(spelling);
            if targets.len() != 1 {
                return Err(error(
                    "unsupported_relation_shape",
                    "A scalar relation must preserve exactly one original wikilink.",
                ));
            }
            let (resolution, fragment) = match index.resolve_with_fragment(&targets[0]) {
                Some((entry, fragment)) => (
                    ids.get(&entry.path)
                        .map(|id| RelationResolution::Resolved {
                            target_id: id.clone(),
                        })
                        .unwrap_or(RelationResolution::Unresolved {}),
                    fragment.map(str::to_string),
                ),
                None => (RelationResolution::Unresolved {}, None),
            };
            Ok(PropertyValue::Relation {
                spelling: spelling.clone(),
                fragment,
                resolution,
            })
        }
        PropertyValue::Array { value } => Ok(PropertyValue::Array {
            value: value
                .iter()
                .map(|v| convert_relation(v, index, ids))
                .collect::<Result<_>>()?,
        }),
        _ => Err(error(
            "unsupported_relation_shape",
            "Relation syntax cannot be represented faithfully.",
        )),
    }
}
pub(crate) fn convert(inventory: &MigrationInventory) -> Result<Seed> {
    if inventory
        .rows
        .iter()
        .any(|row| row.carrier == Carrier::IdentityManifest)
    {
        return Err(error("existing_identity_requires_binding","Existing identity requires an explicit trusted source binding; the prototype never remints it silently."));
    }
    let mut selected = inventory.clone();
    selected.rows.clear();
    let mut properties = BTreeMap::new();
    let mut retained = BTreeMap::new();
    let mut archive = BTreeMap::new();
    let mut dispositions = Vec::new();
    let entries = inventory
        .rows
        .iter()
        .filter(|row| {
            row.status != Status::Blocked
                && matches!(row.carrier, Carrier::Markdown | Carrier::GovernedConcept)
        })
        .filter_map(|row| {
            row.original
                .as_ref()
                .and_then(|original| std::str::from_utf8(&original.bytes).ok())
                .map(|source| {
                    crate::vault::entry::build_entry(
                        &row.path,
                        source,
                        String::new(),
                        String::new(),
                    )
                })
        })
        .collect::<Vec<_>>();
    let by_path = entries
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let index = crate::vault::link::TargetIndex::build(&entries);
    let table = crate::vault::schema::table().map_err(|e| error("schema_unavailable", e))?;
    let schema = crate::vault::schema::VaultSchema::from_entries(&entries, table);
    for row in &inventory.rows {
        let original = row.original.as_ref().ok_or_else(|| {
            error(
                "inventory_unavailable",
                "Every requested source must retain readable original bytes.",
            )
        })?;
        archive.insert(row.path.clone(), original.bytes.clone());
        if !matches!(row.carrier, Carrier::Markdown) || row.status != Status::Ready {
            retained.insert(row.path.clone(), original.bytes.clone());
            dispositions.push(Disposition {
                path: row.path.clone(),
                disposition: "retained_unchanged".into(),
                reason: if row.issues.is_empty() {
                    format!("Compatibility carrier {:?}", row.carrier)
                } else {
                    row.issues
                        .iter()
                        .map(|issue| issue.kind.clone())
                        .collect::<Vec<_>>()
                        .join(",")
                },
            });
            continue;
        }
        let converted = (|| {
            let mut values = match &row.syntax {
                Some(node) => match syntax_value(node)? {
                    PropertyValue::Object { value } => value,
                    _ => return Err(error("unsupported_mapping", "Metadata root must be a map.")),
                },
                None => BTreeMap::new(),
            };
            let body = original
                .bytes
                .get(row.body_start.unwrap_or(0)..)
                .ok_or_else(|| error("invalid_body", "Inventory body offset is out of bounds."))?;
            validate_body(body)?;
            if let Some(entry) = by_path.get(row.path.as_str()) {
                for (key, value) in &mut values {
                    if schema
                        .field_for(entry, key)
                        .is_some_and(|def| def.kind == crate::vault::schema::FieldKind::Date)
                    {
                        if let PropertyValue::String { value: text } = value {
                            let raw = serde_json::to_string(text).map_err(json)?;
                            *value = value::decode_json(&raw, ValueSchema::Date)
                                .or_else(|_| value::decode_json(&raw, ValueSchema::Instant))
                                .map_err(|e| error("unsupported_date", e.message))?;
                        } else if !matches!(value, PropertyValue::Null {}) {
                            return Err(error(
                                "unsupported_date",
                                "Declared dates require the exact supported string grammar.",
                            ));
                        }
                    }
                    if entry.relationships.contains_key(key) {
                        convert_relation(value, &index, &BTreeMap::new())?;
                    }
                }
            }
            validate_properties(&values)?;
            Ok(values)
        })();
        match converted {
            Ok(values) => {
                properties.insert(row.path.clone(), values);
                selected.rows.push(row.clone());
                dispositions.push(Disposition{path:row.path.clone(),disposition:"converted".into(),reason:"Typed metadata; exact body and complete original archive retained. YAML comments/quoting remain archival.".into()});
            }
            Err(refusal) => {
                retained.insert(row.path.clone(), original.bytes.clone());
                dispositions.push(Disposition {
                    path: row.path.clone(),
                    disposition: "unsupported_retained".into(),
                    reason: format!("{}: {}", refusal.kind, refusal.detail),
                });
            }
        }
    }
    let plan = identity::plan_identities(&selected, None, &[], &[])
        .map_err(|e| error(e.kind, e.detail))?;
    let identity = plan
        .into_proposed_manifest(identity::mint_uuid_v4)
        .map_err(|e| error(e.kind, e.detail))?;
    let ids = identity
        .records
        .iter()
        .map(|record| (record.path.clone(), record.record_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut records = Vec::new();
    for record in &identity.records {
        let row = selected
            .rows
            .iter()
            .find(|r| r.path == record.path)
            .unwrap();
        let bytes = &row.original.as_ref().unwrap().bytes;
        let start = row.body_start.unwrap_or(0);
        let mut values = properties.remove(&record.path).unwrap();
        if let Some(entry) = by_path.get(record.path.as_str()) {
            for key in entry.relationships.keys() {
                if let Some(value) = values.get_mut(key) {
                    *value = convert_relation(value, &index, &ids)?;
                }
            }
        }
        validate_properties(&values)?;
        records.push(SeedRecord {
            id: record.record_id.clone(),
            path: record.path.clone(),
            body: bytes[start..].to_vec(),
            properties: values,
        });
    }
    Ok(Seed {
        identity,
        records,
        retained,
        archive,
        dispositions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        vault::testutil,
        workspace_migration::{
            identity::RecordIdentity,
            inventory::{inventory_workspace, InventoryScope},
        },
        workspace_service::types::values::{PropertyChange, PropertyValue},
    };
    const WORKSPACE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fn id(n: usize) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }
    fn seed(count: usize) -> Seed {
        let mut records = Vec::new();
        let mut identities = Vec::new();
        for n in 1..=count {
            let path = format!("pages/{n}.md");
            let body = format!("# Page {n}\n").into_bytes();
            identities.push(RecordIdentity {
                record_id: id(n),
                path: path.clone(),
                source_hash: crate::ledger::sha256_hex(&body),
            });
            records.push(SeedRecord {
                id: id(n),
                path,
                body,
                properties: BTreeMap::from([
                    ("rank".into(), PropertyValue::Decimal { value: "7".into() }),
                    (
                        "text".into(),
                        PropertyValue::String {
                            value: "007".into(),
                        },
                    ),
                ]),
            });
        }
        Seed {
            identity: WorkspaceManifest {
                format: 1,
                workspace_id: WORKSPACE.into(),
                records: identities,
            },
            records,
            retained: BTreeMap::new(),
            archive: BTreeMap::new(),
            dispositions: Vec::new(),
        }
    }
    fn paths(label: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = testutil::temp_vault(label);
        (base.join("bodies"), base.join("metadata"), base)
    }
    fn all(store: &dyn WorkspaceStore, count: usize) -> PrototypeScope {
        let ids = (1..=count).map(id).collect::<Vec<_>>();
        scope(store, &ids, &ids, &["pages/new.md".into()]).unwrap()
    }
    fn request() -> QueryRequest {
        QueryRequest {
            query: serde_json::json!({"sort":[{"field":"rank","dir":"asc"}]}),
            zone: "UTC".into(),
            today: "2026-10-23".into(),
            cursor: None,
        }
    }

    #[test]
    fn both_stores_publish_real_versions_and_reopen_without_reminting() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-store-restart");
            let input = seed(2);
            let mut store = initialize(backend, &root, &meta, &input).unwrap();
            let access = all(store.as_ref(), 2);
            let before = store.read_record(&access, &id(1)).unwrap();
            assert_eq!(before.record.version.metadata_revision, 1);
            assert_eq!(before.body, b"# Page 1\n");
            let outcome = store
                .apply(
                    &access,
                    Mutation::Patch {
                        id: id(1),
                        expected: before.record.version.clone(),
                        expected_schema: 1,
                        changes: vec![PropertyChange::Set {
                            key: "nullable".into(),
                            value: PropertyValue::Null {},
                        }],
                    },
                    Fault::None,
                )
                .unwrap();
            assert_eq!(outcome.version.as_ref().unwrap().metadata_revision, 2);
            drop(store);
            let store = reopen(backend, &root, &meta).unwrap();
            let after = store.read_record(&access, &id(1)).unwrap();
            assert_eq!(after.record.id, id(1));
            assert_eq!(
                after.record.properties.get("nullable"),
                Some(&PropertyValue::Null {})
            );
            assert_eq!(after.record.version.metadata_revision, 2);
            assert_eq!(std::fs::read(root.join("pages/1.md")).unwrap(), before.body);
            let _ = std::fs::remove_dir_all(base);
        }
    }
    #[test]
    fn both_stores_refuse_stale_versions_schema_and_scope_without_writes() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-store-refusals");
            let mut store = initialize(backend, &root, &meta, &seed(2)).unwrap();
            let access = all(store.as_ref(), 2);
            let before = store.read_record(&access, &id(1)).unwrap();
            let hidden = scope(store.as_ref(), &[id(2)], &[], &[]).unwrap();
            assert_eq!(
                store.read_record(&hidden, &id(1)).unwrap_err().kind,
                "scope_denied"
            );
            for (version, schema, kind) in [
                (
                    RecordVersion {
                        metadata_revision: 2,
                        ..before.record.version.clone()
                    },
                    1,
                    "stale_revision",
                ),
                (before.record.version.clone(), 2, "stale_schema"),
                (
                    RecordVersion {
                        body_hash: "0".repeat(64),
                        ..before.record.version.clone()
                    },
                    1,
                    "stale_revision",
                ),
            ] {
                assert_eq!(
                    store
                        .apply(
                            &access,
                            Mutation::Delete {
                                id: id(1),
                                expected: version,
                                expected_schema: schema
                            },
                            Fault::None
                        )
                        .unwrap_err()
                        .kind,
                    kind
                );
            }
            assert_eq!(store.read_record(&access, &id(1)).unwrap(), before);
            let _ = std::fs::remove_dir_all(base);
        }
    }
    #[test]
    fn both_stores_page_equal_sort_values_without_scope_leakage_and_refuse_changed_cursors() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-store-paging");
            let mut store = initialize(backend, &root, &meta, &seed(103)).unwrap();
            let access = all(store.as_ref(), 102);
            let first = store.query(&access, &request()).unwrap();
            assert_eq!(first.rows.len(), 100);
            assert_eq!(first.rows.first().unwrap().record.id, id(1));
            assert_eq!(first.rows.last().unwrap().record.id, id(100));
            let next = QueryRequest {
                cursor: first.cursor.clone(),
                ..request()
            };
            let second = store.query(&access, &next).unwrap();
            assert_eq!(
                second
                    .rows
                    .iter()
                    .map(|r| r.record.id.clone())
                    .collect::<Vec<_>>(),
                [id(101), id(102)]
            );
            assert!(second.cursor.is_none());
            let other = scope(store.as_ref(), &[id(1)], &[], &[]).unwrap();
            assert_eq!(store.query(&other, &next).unwrap_err().kind, "stale_cursor");
            let changed = QueryRequest {
                query: serde_json::json!({}),
                ..next.clone()
            };
            assert_eq!(
                store.query(&access, &changed).unwrap_err().kind,
                "stale_cursor"
            );
            let prior = store.read_record(&access, &id(1)).unwrap();
            store
                .apply(
                    &access,
                    Mutation::Patch {
                        id: id(1),
                        expected: prior.record.version,
                        expected_schema: 1,
                        changes: vec![PropertyChange::Remove { key: "text".into() }],
                    },
                    Fault::None,
                )
                .unwrap();
            assert_eq!(
                store.query(&access, &next).unwrap_err().kind,
                "stale_cursor"
            );
            let _ = std::fs::remove_dir_all(base);
        }
    }
    #[test]
    fn interrupted_create_and_delete_recover_only_coherent_old_or_new_states() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            for fault in [
                Fault::AfterIntent,
                Fault::AfterVisible,
                Fault::AfterMetadata,
            ] {
                let (root, meta, base) = paths("m99-store-recovery");
                let mut store = initialize(backend, &root, &meta, &seed(1)).unwrap();
                let access = all(store.as_ref(), 1);
                let outcome = store.apply(
                    &access,
                    Mutation::Create {
                        id: id(9),
                        path: "pages/new.md".into(),
                        body: b"# New\n".to_vec(),
                        properties: BTreeMap::new(),
                        expected_schema: 1,
                    },
                    fault,
                );
                assert_eq!(outcome.unwrap_err().kind, "interrupted");
                drop(store);
                let mut store = reopen(backend, &root, &meta).unwrap();
                let access = scope(store.as_ref(), &[id(1), id(9)], &[id(1), id(9)], &[]).unwrap();
                if fault == Fault::AfterMetadata {
                    assert_eq!(store.read_record(&access, &id(9)).unwrap().body, b"# New\n");
                } else {
                    assert_eq!(
                        store.read_record(&access, &id(9)).unwrap_err().kind,
                        "not_found"
                    );
                    assert!(!root.join("pages/new.md").exists());
                }
                let old = store.read_record(&access, &id(1)).unwrap();
                assert_eq!(
                    store
                        .apply(
                            &access,
                            Mutation::Delete {
                                id: id(1),
                                expected: old.record.version,
                                expected_schema: 1
                            },
                            fault
                        )
                        .unwrap_err()
                        .kind,
                    "interrupted"
                );
                drop(store);
                let store = reopen(backend, &root, &meta).unwrap();
                if fault == Fault::AfterMetadata {
                    assert_eq!(
                        store.read_record(&access, &id(1)).unwrap_err().kind,
                        "not_found"
                    );
                    assert!(!root.join("pages/1.md").exists());
                } else {
                    assert_eq!(
                        store.read_record(&access, &id(1)).unwrap().body,
                        b"# Page 1\n"
                    );
                }
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }
    #[test]
    fn visible_external_edits_and_copied_markdown_never_adopt_hidden_metadata() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-store-external");
            let store = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let access = all(store.as_ref(), 1);
            std::fs::write(root.join("pages/1.md"), b"# External\n").unwrap();
            assert_eq!(
                store.read_record(&access, &id(1)).unwrap_err().kind,
                "external_edit"
            );
            std::fs::copy(root.join("pages/1.md"), root.join("pages/copy.md")).unwrap();
            let empty = scope(store.as_ref(), &[id(88)], &[], &[]).unwrap();
            assert_eq!(
                store.read_record(&empty, &id(88)).unwrap_err().kind,
                "not_found"
            );
            std::fs::remove_file(root.join("pages/1.md")).unwrap();
            assert_eq!(
                store.read_record(&access, &id(1)).unwrap_err().kind,
                "missing_body"
            );
            let _ = std::fs::remove_dir_all(base);
        }
    }
    #[test]
    fn backup_restore_keeps_acknowledged_edits_and_rejects_missing_parts() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-store-backup");
            let mut store = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let access = all(store.as_ref(), 1);
            let before = store.read_record(&access, &id(1)).unwrap();
            store
                .apply(
                    &access,
                    Mutation::Patch {
                        id: id(1),
                        expected: before.record.version,
                        expected_schema: 1,
                        changes: vec![PropertyChange::Set {
                            key: "after".into(),
                            value: PropertyValue::String {
                                value: "acknowledged".into(),
                            },
                        }],
                    },
                    Fault::None,
                )
                .unwrap();
            let expected = store.read_record(&access, &id(1)).unwrap();
            let backup = base.join("backup");
            store.backup(&backup).unwrap();
            let restored = restore(
                backend,
                &backup,
                &base.join("restored"),
                &base.join("restored-meta"),
            )
            .unwrap();
            let read = all(restored.as_ref(), 1);
            assert_eq!(restored.read_record(&read, &id(1)).unwrap(), expected);
            std::fs::remove_file(backup.join("bodies/pages/1.md")).unwrap();
            assert!(restore(
                backend,
                &backup,
                &base.join("broken"),
                &base.join("broken-meta")
            )
            .is_err());
            let _ = std::fs::remove_dir_all(base);
        }
    }
    #[test]
    fn conversion_keeps_exact_decimals_null_strings_dates_unknown_maps_and_originals() {
        let base = testutil::temp_vault("m99-convert");
        let source="---\ntext: '007'\nday: '2024-02-29'\nunknown: {precise: 9007199254740993.125, empty: null}\n---\n# Title\r\nBody\r\n";
        testutil::write(&base, "source.md", source);
        let inventory = inventory_workspace(
            &base,
            &InventoryScope {
                paths: vec!["source.md".into()],
            },
        )
        .unwrap();
        let seed = convert(&inventory).unwrap();
        assert_eq!(seed.records.len(), 1);
        assert_eq!(seed.records[0].body, b"# Title\r\nBody\r\n");
        assert_eq!(
            seed.records[0].properties["text"],
            PropertyValue::String {
                value: "007".into()
            }
        );
        assert_eq!(
            seed.records[0].properties["day"],
            PropertyValue::String {
                value: "2024-02-29".into()
            }
        );
        assert_eq!(
            seed.records[0].properties["unknown"],
            PropertyValue::Object {
                value: BTreeMap::from([
                    (
                        "precise".into(),
                        PropertyValue::Decimal {
                            value: "9007199254740993.125".into()
                        }
                    ),
                    ("empty".into(), PropertyValue::Null {})
                ])
            }
        );
        assert_eq!(seed.archive["source.md"], source.as_bytes());
        assert_eq!(
            std::fs::read(base.join("source.md")).unwrap(),
            source.as_bytes()
        );
        let _ = std::fs::remove_dir_all(base);
    }
    #[test]
    fn recovery_refuses_tampered_intents_before_altering_visible_bytes() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-journal-tamper");
            let mut store = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let access = all(store.as_ref(), 1);
            assert_eq!(
                store
                    .apply(
                        &access,
                        Mutation::Create {
                            id: id(9),
                            path: "pages/new.md".into(),
                            body: b"new".to_vec(),
                            properties: BTreeMap::new(),
                            expected_schema: 1
                        },
                        Fault::AfterIntent
                    )
                    .unwrap_err()
                    .kind,
                "interrupted"
            );
            drop(store);
            let journal = root.join(JOURNAL);
            let mut intent: Intent = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
            intent.new_record.as_mut().unwrap().version.body_hash = "0".repeat(64);
            fs::write(&journal, serde_json::to_vec(&intent).unwrap()).unwrap();
            assert!(
                reopen(backend, &root, &meta).is_err(),
                "Invalid recorded postimage must not be silently discarded"
            );
            assert!(!root.join("pages/new.md").exists());
            assert!(journal.exists());
            let _ = fs::remove_dir_all(base);
        }
    }
    #[test]
    fn third_party_recovery_bytes_and_missing_metadata_are_never_adopted() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-third-party");
            let mut store = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let access = all(store.as_ref(), 1);
            store
                .apply(
                    &access,
                    Mutation::Create {
                        id: id(9),
                        path: "pages/new.md".into(),
                        body: b"new".to_vec(),
                        properties: BTreeMap::new(),
                        expected_schema: 1,
                    },
                    Fault::AfterVisible,
                )
                .unwrap_err();
            drop(store);
            fs::write(root.join("pages/new.md"), b"outside writer").unwrap();
            assert!(reopen(backend, &root, &meta).is_err());
            assert_eq!(
                fs::read(root.join("pages/new.md")).unwrap(),
                b"outside writer"
            );
            let _ = fs::remove_dir_all(base);
            let (root, meta, base) = paths("m99-missing-metadata");
            let store = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let metadata = store.metadata_root().to_owned();
            drop(store);
            match backend {
                Backend::Sidecar => {
                    fs::remove_file(metadata.join(format!("records/{}/1.json", id(1)))).unwrap()
                }
                Backend::Sqlite => fs::remove_file(metadata.join("workspace.db")).unwrap(),
            };
            assert!(reopen(backend, &root, &meta).is_err());
            assert_eq!(fs::read(root.join("pages/1.md")).unwrap(), b"# Page 1\n");
            let _ = fs::remove_dir_all(base);
        }
    }
    fn tagged(raw: &str) -> PropertyValue {
        value::decode_json(raw, ValueSchema::Plain).unwrap()
    }
    #[test]
    fn schema_revisions_real_validation_and_exact_unknown_values_survive_both_stores() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-schema");
            let mut input = seed(2);
            input.records[0].body = b"# Task\n".to_vec();
            input.records[0].properties = BTreeMap::from([
                ("type".into(), tagged("\"Type\"")),
                ("fields".into(), tagged(r#"{"flag":{"kind":"checkbox"}}"#)),
            ]);
            input.records[1]
                .properties
                .insert("type".into(), tagged("\"Task\""));
            input.records[1]
                .properties
                .insert("precise".into(), tagged("9007199254740993.125"));
            let mut store = initialize(backend, &root, &meta, &input).unwrap();
            let access = all(store.as_ref(), 2);
            let before = store.read_record(&access, &id(2)).unwrap();
            assert_eq!(
                store
                    .apply(
                        &access,
                        Mutation::Patch {
                            id: id(2),
                            expected: before.record.version.clone(),
                            expected_schema: 1,
                            changes: vec![PropertyChange::Set {
                                key: "flag".into(),
                                value: tagged("7")
                            }]
                        },
                        Fault::None
                    )
                    .unwrap_err()
                    .kind,
                "schema_invalid"
            );
            let mut query = request();
            query.query = serde_json::json!({"sort":[{"field":"precise","dir":"asc"}]});
            assert_eq!(
                store.query(&access, &query).unwrap_err().kind,
                "unsupported_query_value"
            );
            let t = store.read_record(&access, &id(1)).unwrap();
            let result = store
                .apply(
                    &access,
                    Mutation::Patch {
                        id: id(1),
                        expected: t.record.version,
                        expected_schema: 1,
                        changes: vec![PropertyChange::Set {
                            key: "label".into(),
                            value: tagged("\"Updated\""),
                        }],
                    },
                    Fault::None,
                )
                .unwrap();
            assert_eq!(result.schema_revision, 2);
            assert_eq!(
                store
                    .apply(
                        &access,
                        Mutation::Delete {
                            id: id(2),
                            expected: before.record.version.clone(),
                            expected_schema: 1
                        },
                        Fault::None
                    )
                    .unwrap_err()
                    .kind,
                "stale_schema"
            );
            drop(store);
            let store = reopen(backend, &root, &meta).unwrap();
            assert_eq!(store.read_record(&access, &id(2)).unwrap(), before);
            let _ = fs::remove_dir_all(base);
        }
    }
    #[test]
    fn conversion_uses_declared_dates_and_resolved_ids_without_changing_originals() {
        let base = testutil::temp_vault("m99-declared-values");
        let sources=[("Task.md","---\ntype: Type\nfields:\n  due: {kind: date}\n  project: {kind: relation}\n---\n# Task\n"),("record.md","---\ntype: Task\ndue: '2024-02-29'\nplain: '2024-02-29'\nproject: '[[target#section]]'\n---\n# Record\n"),("target.md","# Target\n")];
        for (path, source) in sources {
            testutil::write(&base, path, source);
        }
        let inventory = inventory_workspace(
            &base,
            &InventoryScope {
                paths: sources.iter().map(|(p, _)| p.to_string()).collect(),
            },
        )
        .unwrap();
        let converted = convert(&inventory).unwrap();
        let record = converted
            .records
            .iter()
            .find(|r| r.path == "record.md")
            .unwrap();
        let target = converted
            .records
            .iter()
            .find(|r| r.path == "target.md")
            .unwrap();
        assert_eq!(
            record.properties["due"],
            PropertyValue::Date {
                value: "2024-02-29".into()
            }
        );
        assert_eq!(
            record.properties["plain"],
            PropertyValue::String {
                value: "2024-02-29".into()
            }
        );
        assert_eq!(
            record.properties["project"],
            PropertyValue::Relation {
                spelling: "[[target#section]]".into(),
                fragment: Some("section".into()),
                resolution: crate::workspace_service::types::values::RelationResolution::Resolved {
                    target_id: target.id.clone()
                }
            }
        );
        for (path, source) in sources {
            assert_eq!(fs::read(base.join(path)).unwrap(), source.as_bytes());
        }
        let _ = fs::remove_dir_all(base);
    }
    #[test]
    fn restore_refuses_duplicate_part_names_and_leaves_no_active_destination() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-duplicate-backup");
            let store = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let backup = base.join("backup");
            store.backup(&backup).unwrap();
            let manifest = backup.join("backup.json");
            let source = fs::read_to_string(&manifest).unwrap();
            let hash = hash(b"# Page 1\n");
            let changed = source.replacen(
                "\"required\":{",
                &format!("\"required\":{{\"bodies/pages/1.md\":\"{hash}\","),
                1,
            );
            fs::write(manifest, changed).unwrap();
            let destination = base.join("restored");
            assert!(restore(backend, &backup, &destination, &base.join("restored-meta")).is_err());
            assert!(!destination.join(MARKER).exists());
            let _ = fs::remove_dir_all(base);
        }
    }
    #[test]
    fn conversion_retains_all_compatibility_and_unsupported_sources_explicitly() {
        let base = testutil::temp_vault("m99-retained-conversion");
        let sources=[("sheet.md","# Sheet\n```cerebro-sheet\n---\nname: Costs\n---\nAmount\n007\n```\n"),("knowledge/concept.md","---\ntitle: Retained\n---\nEvidence\n"),(".claude/agents/a.md","---\nname: a\n---\nCLI instructions\n"),("bad.md","---\nx: 1\n'x': 2\n---\nBad\n"),("source.md","---\nsource_system: notion\nsource_record_id: abc\nimport_hash: original\n---\n# Imported\n")];
        for (path, source) in sources {
            testutil::write(&base, path, source);
        }
        let inventory = inventory_workspace(
            &base,
            &InventoryScope {
                paths: sources.iter().map(|(path, _)| path.to_string()).collect(),
            },
        )
        .unwrap();
        let converted = convert(&inventory).unwrap();
        assert_eq!(converted.records.len(), 1);
        assert_eq!(converted.retained.len(), 4);
        assert_eq!(converted.dispositions.len(), 5);
        assert_eq!(
            converted.records[0].properties["import_hash"],
            tagged("\"original\"")
        );
        for (path, source) in sources {
            assert_eq!(converted.archive[path], source.as_bytes());
            assert_eq!(fs::read(base.join(path)).unwrap(), source.as_bytes());
        }
        let _ = fs::remove_dir_all(base);
    }
    #[test]
    fn two_handles_observe_lock_scope_and_current_persisted_versions() {
        for backend in [Backend::Sidecar, Backend::Sqlite] {
            let (root, meta, base) = paths("m99-locks");
            let mut first = initialize(backend, &root, &meta, &seed(1)).unwrap();
            let mut second = reopen(backend, &root, &meta).unwrap();
            let access = all(first.as_ref(), 1);
            let before = first.read_record(&access, &id(1)).unwrap();
            let held = lock(first.root()).unwrap();
            assert_eq!(
                second.read_record(&access, &id(1)).unwrap_err().kind,
                "store_busy"
            );
            drop(held);
            first
                .apply(
                    &access,
                    Mutation::Patch {
                        id: id(1),
                        expected: before.record.version.clone(),
                        expected_schema: 1,
                        changes: vec![PropertyChange::Remove { key: "text".into() }],
                    },
                    Fault::None,
                )
                .unwrap();
            assert_eq!(
                second
                    .apply(
                        &access,
                        Mutation::Delete {
                            id: id(1),
                            expected: before.record.version,
                            expected_schema: 1
                        },
                        Fault::None
                    )
                    .unwrap_err()
                    .kind,
                "stale_revision"
            );
            let after = second.read_record(&access, &id(1)).unwrap();
            assert!(!after.record.properties.contains_key("text"));
            fs::rename(root.join("pages/1.md"), root.join("pages/renamed.md")).unwrap();
            assert_eq!(
                first.read_record(&access, &id(1)).unwrap_err().kind,
                "missing_body"
            );
            assert_eq!(
                first.load_state().unwrap().records[&id(1)].path,
                "pages/1.md"
            );
            let _ = fs::remove_dir_all(base);
        }
    }
    #[test]
    fn sqlite_large_metadata_columns_refuse_before_materializing_full_text() {
        let (root, meta, base) = paths("m99-sqlite-column-limits");
        let store = initialize(Backend::Sqlite, &root, &meta, &seed(1)).unwrap();
        let connection =
            rusqlite::Connection::open(store.metadata_root().join("workspace.db")).unwrap();
        let oversized = "x".repeat(8192);
        connection
            .execute("UPDATE records SET path=?1", [&oversized])
            .unwrap();
        assert_eq!(store.load_state().unwrap_err().kind, "source_limit");
        connection
            .execute("UPDATE records SET path='pages/1.md', id=?1", [&oversized])
            .unwrap();
        assert_eq!(store.load_state().unwrap_err().kind, "source_limit");
        assert_eq!(fs::read(root.join("pages/1.md")).unwrap(), b"# Page 1\n");
        let _ = fs::remove_dir_all(base);
    }
    fn elapsed(start: std::time::Instant) -> u128 {
        start.elapsed().as_micros()
    }
    fn report_pages(store: &dyn WorkspaceStore, access: &PrototypeScope) -> Vec<RecordSnapshot> {
        let mut request = request();
        let mut rows = Vec::new();
        loop {
            let page = store.query(access, &request).unwrap();
            rows.extend(page.rows);
            match page.cursor {
                Some(cursor) => request.cursor = Some(cursor),
                None => break,
            }
        }
        rows
    }
    fn exercise_store(
        backend: Backend,
        base: &Path,
        input: &Seed,
        new_id: &str,
    ) -> (serde_json::Value, State, Vec<RecordSnapshot>) {
        let name = backend_name(backend);
        let root = base.join(format!("{name}-bodies"));
        let metadata = base.join(format!("{name}-metadata"));
        let mut timings = BTreeMap::<String, u128>::new();
        let start = std::time::Instant::now();
        let mut store = initialize(backend, &root, &metadata, input).unwrap();
        timings.insert("initialize_us".into(), elapsed(start));
        let ids = input
            .records
            .iter()
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        assert!(!ids.is_empty());
        let access = scope(store.as_ref(), &ids, &ids, &["pages/new.md".into()]).unwrap();
        let start = std::time::Instant::now();
        let before = store.read_record(&access, &ids[0]).unwrap();
        timings.insert("read_one_us".into(), elapsed(start));
        let start = std::time::Instant::now();
        let initial_pages = report_pages(store.as_ref(), &access);
        timings.insert("all_query_pages_us".into(), elapsed(start));
        let start = std::time::Instant::now();
        store
            .apply(
                &access,
                Mutation::Patch {
                    id: ids[0].clone(),
                    expected: before.record.version,
                    expected_schema: 1,
                    changes: vec![
                        PropertyChange::Set {
                            key: "nullable".into(),
                            value: PropertyValue::Null {},
                        },
                        PropertyChange::Remove { key: "text".into() },
                    ],
                },
                Fault::None,
            )
            .unwrap();
        timings.insert("patch_us".into(), elapsed(start));
        let start = std::time::Instant::now();
        let created = store
            .apply(
                &access,
                Mutation::Create {
                    id: new_id.into(),
                    path: "pages/new.md".into(),
                    body: b"# New\n".to_vec(),
                    properties: BTreeMap::new(),
                    expected_schema: 1,
                },
                Fault::None,
            )
            .unwrap();
        let added = scope(store.as_ref(), &[new_id.into()], &[new_id.into()], &[]).unwrap();
        store
            .apply(
                &added,
                Mutation::Delete {
                    id: new_id.into(),
                    expected: created.version.unwrap(),
                    expected_schema: 1,
                },
                Fault::None,
            )
            .unwrap();
        timings.insert("create_delete_us".into(), elapsed(start));
        let start = std::time::Instant::now();
        drop(store);
        let mut store = reopen(backend, &root, &metadata).unwrap();
        let after = store.read_record(&access, &ids[0]).unwrap();
        assert_eq!(after.record.version.metadata_revision, 2);
        assert_eq!(after.record.properties["nullable"], PropertyValue::Null {});
        assert!(!after.record.properties.contains_key("text"));
        timings.insert("restart_us".into(), elapsed(start));
        let snapshot = store.load_state().unwrap();
        let start = std::time::Instant::now();
        let backup = base.join(format!("{name}-backup"));
        store.backup(&backup).unwrap();
        let restored = restore(
            backend,
            &backup,
            &base.join(format!("{name}-restored")),
            &base.join(format!("{name}-restored-meta")),
        )
        .unwrap();
        assert_eq!(restored.load_state().unwrap(), snapshot);
        let restored_scope = scope(restored.as_ref(), &ids, &[], &[]).unwrap();
        assert_eq!(
            restored.read_record(&restored_scope, &ids[0]).unwrap(),
            after
        );
        timings.insert("backup_restore_us".into(), elapsed(start));
        let start = std::time::Instant::now();
        let visible = root.join(&after.record.path);
        fs::write(&visible, b"external editor bytes\n").unwrap();
        let refusal = store.read_record(&access, &ids[0]).unwrap_err();
        assert_eq!(refusal.kind, "external_edit");
        fs::write(&visible, &after.body).unwrap();
        assert_eq!(store.read_record(&access, &ids[0]).unwrap(), after);
        timings.insert("external_edit_probe_us".into(), elapsed(start));
        let start = std::time::Instant::now();
        let mut recovery = Vec::new();
        for (index, fault) in [
            Fault::AfterIntent,
            Fault::AfterVisible,
            Fault::AfterMetadata,
        ]
        .into_iter()
        .enumerate()
        {
            // Test fixture IDs are allocated explicitly outside the store, never from paths.
            let record_id = format!("ffffffff-ffff-4fff-8fff-{:012}", index + 1);
            let path = format!("recovery/{index}.md");
            let access = scope(
                store.as_ref(),
                std::slice::from_ref(&record_id),
                std::slice::from_ref(&record_id),
                std::slice::from_ref(&path),
            )
            .unwrap();
            assert_eq!(
                store
                    .apply(
                        &access,
                        Mutation::Create {
                            id: record_id.clone(),
                            path: path.clone(),
                            body: b"recovery body\n".to_vec(),
                            properties: BTreeMap::new(),
                            expected_schema: 1
                        },
                        fault
                    )
                    .unwrap_err()
                    .kind,
                "interrupted"
            );
            drop(store);
            store = reopen(backend, &root, &metadata).unwrap();
            let committed = fault == Fault::AfterMetadata;
            assert_eq!(
                store.load_state().unwrap().records.contains_key(&record_id),
                committed
            );
            assert_eq!(root.join(&path).exists(), committed);
            recovery.push(serde_json::json!({"boundary":format!("{fault:?}"),"outcome":if committed{"new_coherent"}else{"old_coherent"}}));
        }
        timings.insert("recovery_boundaries_us".into(), elapsed(start));
        (
            serde_json::json!({"backend":name,"timingsMicros":timings,"queriedRecords":initial_pages.len(),"backupRestore":"passed_with_post_conversion_edit","externalEdit":"refused_without_adoption","recovery":recovery,"metadataPlacement":if name=="sidecar"{"vault-local immutable record sidecars plus atomic manifest"}else{"separate sibling SQLite metadata database"}}),
            snapshot,
            initial_pages,
        )
    }
    #[test]
    #[ignore = "Explicit disposable fixture/report paths required; real 1k/5k disk workload"]
    fn write_report() {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fixture {
            format: u8,
            count: usize,
            scenario: String,
        }
        let fixture = PathBuf::from(
            std::env::var_os("CEREBRO_M99_FIXTURE").expect("explicit fixture required"),
        );
        check_temp(&fixture).unwrap();
        let fixture = fs::canonicalize(fixture).unwrap();
        let marker: Fixture = decode_metadata(
            &read_file(&safe_path(&fixture, "fixture.json").unwrap(), 4096).unwrap(),
        )
        .unwrap();
        assert_eq!(marker.format, 1);
        assert!(matches!(
            (marker.scenario.as_str(), marker.count),
            ("ordinary", 1000 | 5000) | ("adversarial", 128)
        ));
        let output = PathBuf::from(
            std::env::var_os("CEREBRO_M99_REPORT").expect("explicit output required"),
        );
        assert!(!output.exists());
        check_temp(output.parent().unwrap()).unwrap();
        let context: serde_json::Value =
            decode_metadata(std::env::var("CEREBRO_M99_CONTEXT").unwrap().as_bytes()).unwrap();
        let source = new_root(&fixture.join("source")).unwrap();
        let mut requested = Vec::new();
        for index in 1..=marker.count {
            let path = format!("pages/{index}.md");
            let text=format!("---\nrank: {}\ntext: '007'\nnullable: null\nunknown: {{exact: 9007199254740993.125, array: [true, null, '2024-02-29']}}\n---\n# Page {index}\nBody {index}.\n",index%7);
            atomic_write(&safe_path(&source, &path).unwrap(), text.as_bytes()).unwrap();
            requested.push(path);
        }
        if marker.scenario == "adversarial" {
            let mut wide = String::from("---\n");
            for index in 0..200 {
                wide.push_str(&format!(
                    "unknown{index}: {{number: 1.2300e+4, text: '007'}}\n"
                ));
            }
            wide.push_str("---\n# Wide\n");
            wide.push_str(&"Large body text.\n".repeat(16384));
            let extras=[("wide.md",wide),("duplicate.md","---\nx: 1\n'x': 2\n---\n# Duplicate\n".into()),("anchor.md","---\nx: &x {value: 1}\ny: *x\n---\n# Alias\n".into()),("missing-link.md","---\nproject: '[[Uninventoried target]]'\n---\n# Missing\n".into()),("knowledge/concept.md","---\ntitle: Retained concept\nstatus: draft\n---\nEvidence.\n".into()),(".claude/agents/researcher.md","---\nname: researcher\n---\nCLI-owned instructions.\n".into()),("sheet.md","# Sheet\n```cerebro-sheet\n---\nname: Costs\n---\nAmount\n007\n```\n".into()),("moved/agent.md","---\ntype: Agent\nname: Helper\nreach: '[[Uninventoried target]]'\n---\n# Standing instructions\n".into()),("imported.md","---\nsource_system: notion\nsource_record_id: abc\nimport_hash: original-stamp\n---\n# Imported\n".into()),(".cerebro/ledger/store.json",r#"{"store_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","format":1,"created_at":"2026-10-23T00:00:00.000Z"}"#.into())];
            for (path, bytes) in extras {
                atomic_write(&safe_path(&source, path).unwrap(), bytes.as_bytes()).unwrap();
                requested.push(path.into());
            }
        }
        let start = std::time::Instant::now();
        let inventory = inventory_workspace(&source, &InventoryScope { paths: requested }).unwrap();
        let inventory_us = elapsed(start);
        let start = std::time::Instant::now();
        let input = convert(&inventory).unwrap();
        let conversion_us = elapsed(start);
        let scratch = new_root(&fixture.join("stores")).unwrap();
        let new_id = identity::mint_uuid_v4();
        let (sidecar, left, left_rows) =
            exercise_store(Backend::Sidecar, &scratch, &input, &new_id);
        let (sqlite, right, right_rows) =
            exercise_store(Backend::Sqlite, &scratch, &input, &new_id);
        let mut differences = Vec::new();
        if left != right {
            differences.push("canonical state differs");
        }
        if left_rows != right_rows {
            differences.push("query record values/order differ");
        }
        for row in &inventory.rows {
            assert_eq!(
                fs::read(source.join(&row.path)).unwrap(),
                row.original.as_ref().unwrap().bytes
            );
        }
        let digests = BTreeMap::from([
            (
                "src-tauri/src/workspace_migration/comparison.rs",
                hash(include_bytes!("comparison.rs")),
            ),
            (
                "src-tauri/src/workspace_migration/sidecar.rs",
                hash(include_bytes!("sidecar.rs")),
            ),
            (
                "src-tauri/src/workspace_migration/sqlite.rs",
                hash(include_bytes!("sqlite.rs")),
            ),
            (
                "src-tauri/src/workspace_migration/inventory.rs",
                hash(include_bytes!("inventory.rs")),
            ),
            (
                "src-tauri/src/workspace_migration/identity.rs",
                hash(include_bytes!("identity.rs")),
            ),
            (
                "src-tauri/src/workspace_migration/syntax.rs",
                hash(include_bytes!("syntax.rs")),
            ),
            (
                "src-tauri/src/workspace_service/types.rs",
                hash(include_bytes!("../workspace_service/types.rs")),
            ),
            (
                "src-tauri/src/workspace_service/query.rs",
                hash(include_bytes!("../workspace_service/query.rs")),
            ),
            (
                "src-tauri/src/workspace_service/value.rs",
                hash(include_bytes!("../workspace_service/value.rs")),
            ),
            (
                "src-tauri/src/vault/link.rs",
                hash(include_bytes!("../vault/link.rs")),
            ),
            (
                "shared/workspace/values.v1.json",
                hash(include_bytes!("../../../shared/workspace/values.v1.json")),
            ),
        ]);
        let report = serde_json::json!({"format":1,"measurementQuality":"contended_samples_only","performanceDecision":"unavailable_pending_quiet_repeats","scenario":marker.scenario,"requestedRecords":inventory.rows.len(),"convertedRecords":input.records.len(),"retainedRecords":input.retained.len(),"conversionDispositions":input.dispositions,"inventoryCoverage":inventory.coverage,"ledgerEvidence":inventory.ledger,"archiveHashes":input.archive.iter().map(|(path,bytes)|(path.clone(),hash(bytes))).collect::<BTreeMap<_,_>>(),"originalBytesUnchanged":true,"commonTimingsMicros":{"inventory":inventory_us,"conversion":conversion_us},"stores":[sidecar,sqlite],"semanticDifferences":differences,"context":context,"toolchainPin":include_str!("../../../rust-toolchain.toml"),"compileRustupToolchain":option_env!("RUSTUP_TOOLCHAIN"),"sourceDigests":digests,"limitations":["Debug test binary and contended machine; no speed or winner inference.","Visible body external edits refuse automatic adoption; no watcher/reconciliation UI.","Prototype backup omits unscoped attachments/comments/complete ledger and app-global runtime history; not a production backup.","Tested interruption points only; no power-loss, hostile same-user race or filesystem-portability guarantee.","Legacy query projection refuses exact values it cannot represent; unsupported rows remain explicit."]});
        atomic_write(&output, &serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}
