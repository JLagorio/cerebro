//! Versioned selected metadata access, presentation action and paired body writer.
//! Ordinary opens never create a database or upgrade a staging store.
use super::{
    authority::{self, error, rules, SelectedBinding},
    types::{selected::*, values::PropertyValue},
    value,
};
use crate::vault::{
    entry::Entry,
    receipt::{Human, WriteReceipt},
};
use rusqlite::{types::ValueRef, Connection, OpenFlags, Row};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[path = "selected_pair_types.rs"]
mod pair_types;
#[cfg(unix)]
use pair_types::OriginalReceipt;
pub(crate) use pair_types::{
    ProtectedBodyAck, ProtectedBodyError, RecoveryReport, SelectedBodyAck,
};
#[cfg(unix)]
#[path = "selected_store.rs"]
mod store;
#[cfg(not(unix))]
#[path = "selected_store_unsupported.rs"]
mod store;
#[cfg(unix)]
pub(crate) use store::CaptureIdentity;
pub(crate) use store::{
    recover_workspace, recover_workspace_with_retention, replace_body, replace_body_with_recovery,
};
#[cfg(all(test, unix))]
pub(crate) use store::{
    with_after_commit_for_test, with_before_install_for_test, with_journal_path_hook,
    with_open_hooks, with_published_sync_failure_for_test, with_sqlite_limit_for_test,
};

#[path = "selected_editor_types.rs"]
mod editor_types;
pub(crate) use editor_types::*;
#[path = "selected_metadata_types.rs"]
mod metadata_types;
pub(crate) use metadata_types::*;
#[cfg(unix)]
#[path = "selected_metadata.rs"]
mod metadata;
#[cfg(not(unix))]
#[path = "selected_metadata_unsupported.rs"]
mod metadata;
pub(crate) use metadata::{patch_metadata, read_property};
#[cfg(all(test, unix))]
pub(crate) use metadata::{with_metadata_request_bounds_for_test, with_operation_stamp_for_test};
#[path = "selected_view_types.rs"]
mod view_types;
pub(crate) use view_types::*;
#[path = "selected_view.rs"]
mod saved_view;
#[cfg_attr(
    not(test),
    expect(
        unused_imports,
        reason = "Native saved-view command integration follows causal service RED."
    )
)]
pub(crate) use saved_view::read_saved_view;
#[cfg(test)]
pub(crate) use saved_view::{
    with_saved_view_before_publish_for_test, with_saved_view_response_limit_for_test,
};
#[path = "selected_editor.rs"]
mod editor;
pub(crate) use editor::{read_editor_snapshot, save_editor_body};

#[cfg(unix)]
#[path = "selected_backup.rs"]
pub(crate) mod backup;

struct Record {
    id: String,
    path: String,
    revision: i64,
    body_hash: String,
    metadata_source: String,
    metadata: PropertyValue,
}
struct Snapshot {
    schema_revision: i64,
    epoch: i64,
    records: Vec<Record>,
}
fn invalid(message: &str) -> AuthorityError {
    error(AuthorityErrorKind::InvalidMetadata, message)
}
fn missing(message: &str) -> AuthorityError {
    error(AuthorityErrorKind::MetadataUnavailable, message)
}
fn hash_valid(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text(row: &Row<'_>, column: usize, cap: usize) -> Result<String, AuthorityError> {
    match row
        .get_ref(column)
        .map_err(|_| invalid("Canonical metadata has an invalid column."))?
    {
        ValueRef::Text(bytes) if bytes.len() <= cap => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| invalid("Canonical metadata text is not UTF-8.")),
        ValueRef::Text(_) => Err(error(
            AuthorityErrorKind::SourceLimit,
            "Canonical metadata text exceeds its bound.",
        )),
        _ => Err(invalid("Canonical metadata has an invalid column type.")),
    }
}
fn private_database(binding: &SelectedBinding) -> Result<(), AuthorityError> {
    let relative = binding
        .database
        .strip_prefix(&binding.origin)
        .map_err(|_| invalid("Canonical metadata escaped its installed origin."))?;
    let mut path = binding.origin.clone();
    for component in relative.components() {
        path.push(component);
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| missing("Canonical metadata is unavailable."))?;
        if meta.file_type().is_symlink() {
            return Err(invalid("Canonical metadata may not follow symlinks."));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(invalid("Canonical metadata must be private."));
            }
        }
    }
    let meta = fs::metadata(&binding.database)
        .map_err(|_| missing("Canonical metadata is unavailable."))?;
    if !meta.is_file() || meta.len() > rules().limits.database_bytes {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Canonical metadata database exceeds its bound.",
        ));
    }
    Ok(())
}
fn connection(binding: &SelectedBinding, writable: bool) -> Result<Connection, AuthorityError> {
    store::verified_connection(binding, writable)
}
fn verify_schema(conn: &Connection) -> Result<(), AuthorityError> {
    verify_schema_with_journal(conn, "delete")
}
fn verify_schema_with_journal(
    conn: &Connection,
    expected_journal: &str,
) -> Result<(), AuthorityError> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| invalid("Canonical store version is unreadable."))?;
    if version != rules().schema_version
        && version != crate::workspace_migration::journal::rules().selected_schema_version
        && version != metadata::schema_version()
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Canonical store schema version is unsupported.",
        ));
    }
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(|_| invalid("Canonical store journal mode is unreadable."))?;
    if mode != expected_journal {
        return Err(invalid("Canonical store journal mode is unsupported."));
    }
    let schema = if version == rules().schema_version {
        include_str!("selected_schema.sql")
    } else if version == metadata::schema_version() {
        include_str!("selected_schema_v4.sql")
    } else {
        include_str!("selected_schema_v3.sql")
    };
    let expected: BTreeMap<&str, &str> = schema
        .split(';')
        .map(str::trim)
        .filter(|sql| sql.starts_with("CREATE TABLE "))
        .map(|sql| {
            let name = sql
                .trim_start_matches("CREATE TABLE ")
                .split_whitespace()
                .next()
                .expect("table name");
            (name, sql)
        })
        .collect();
    let mut seen = BTreeSet::new();
    let mut automatic = BTreeSet::new();
    let mut stmt = conn
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 16")
        .map_err(|_| invalid("Canonical schema is unreadable."))?;
    let mut rows = stmt
        .query([])
        .map_err(|_| invalid("Canonical schema is unreadable."))?;
    while let Some(row) = rows
        .next()
        .map_err(|_| invalid("Canonical schema is unreadable."))?
    {
        let kind = text(row, 0, 32)?;
        let name = text(row, 1, 128)?;
        let table = text(row, 2, 128)?;
        match kind.as_str() {
            "table" => {
                let sql = text(row, 3, 8192)?;
                if table != name
                    || expected.get(name.as_str()).copied() != Some(sql.as_str())
                    || !seen.insert(name)
                {
                    return Err(invalid("Canonical table definitions are unsupported."));
                }
            }
            "index" if row.get_ref(3).ok() == Some(ValueRef::Null) => {
                if !(matches!(
                    (name.as_str(), table.as_str()),
                    ("sqlite_autoindex_workspace_1", "workspace")
                        | ("sqlite_autoindex_records_1", "records")
                        | ("sqlite_autoindex_records_2", "records")
                ) || (version == metadata::schema_version()
                    && matches!(
                        (name.as_str(), table.as_str()),
                        ("sqlite_autoindex_metadata_requests_1", "metadata_requests")
                            | ("sqlite_autoindex_metadata_requests_2", "metadata_requests")
                            | ("sqlite_autoindex_metadata_requests_3", "metadata_requests")
                    )))
                    || !automatic.insert(name)
                {
                    return Err(invalid("Canonical indexes are unsupported."));
                }
            }
            _ => {
                return Err(invalid(
                    "Canonical metadata contains unsupported schema objects.",
                ))
            }
        }
    }
    if seen.len() != expected.len()
        || automatic.len()
            != if version == metadata::schema_version() {
                6
            } else {
                3
            }
    {
        return Err(invalid("Canonical schema is incomplete."));
    }
    let integrity: String = conn
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|_| invalid("Canonical metadata integrity is unavailable."))?;
    if integrity != "ok" {
        return Err(invalid("Canonical metadata integrity check failed."));
    }
    Ok(())
}
fn record_path_valid(path: &str) -> bool {
    crate::files::bytes::rel_refusal("selected-authority", path).is_none()
        && path.ends_with(".md")
        && !path.split('/').any(crate::vault::scan::is_hidden)
        && !path
            .split('/')
            .rev()
            .skip(1)
            .any(crate::vault::scan::is_skipped_dir)
}
fn read_snapshot(conn: &Connection, binding: &SelectedBinding) -> Result<Snapshot, AuthorityError> {
    read_snapshot_for_workspace(conn, &binding.workspace_id)
}
fn read_snapshot_for_workspace(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Snapshot, AuthorityError> {
    read_snapshot_with_journal(conn, workspace_id, "delete")
}
fn read_snapshot_with_journal(
    conn: &Connection,
    workspace_id: &str,
    expected_journal: &str,
) -> Result<Snapshot, AuthorityError> {
    verify_schema_with_journal(conn, expected_journal)?;
    let mut workspace=conn.prepare("SELECT singleton,format,workspace_id,schema_revision,metadata_epoch FROM workspace LIMIT 2").map_err(|_|invalid("Workspace metadata is unavailable."))?;
    let mut rows = workspace
        .query([])
        .map_err(|_| invalid("Workspace metadata is unavailable."))?;
    let row = rows
        .next()
        .map_err(|_| invalid("Workspace metadata is unavailable."))?
        .ok_or_else(|| missing("Workspace metadata is missing."))?;
    let singleton: i64 = row
        .get(0)
        .map_err(|_| invalid("Workspace singleton is invalid."))?;
    let format: i64 = row
        .get(1)
        .map_err(|_| invalid("Workspace format is invalid."))?;
    let id = text(row, 2, 36)?;
    let schema_revision: i64 = row
        .get(3)
        .map_err(|_| invalid("Workspace schema revision is invalid."))?;
    let epoch: i64 = row
        .get(4)
        .map_err(|_| invalid("Workspace metadata epoch is invalid."))?;
    if singleton != 1 || format != i64::from(rules().format) || id != workspace_id {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "Canonical store disagrees with the trusted workspace binding.",
        ));
    }
    if schema_revision < 1 || epoch < 1 {
        return Err(invalid("Workspace counters are invalid."));
    }
    if rows
        .next()
        .map_err(|_| invalid("Workspace metadata is unavailable."))?
        .is_some()
    {
        return Err(invalid("Canonical metadata has duplicate workspace rows."));
    }
    let mut stmt = conn
        .prepare("SELECT id,path,revision,body_hash,metadata FROM records ORDER BY path LIMIT ?1")
        .map_err(|_| invalid("Canonical records are unreadable."))?;
    let mut rows = stmt
        .query([(rules().limits.records + 1) as i64])
        .map_err(|_| invalid("Canonical records are unreadable."))?;
    let mut records = Vec::new();
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut total = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|_| invalid("Canonical records are unreadable."))?
    {
        if records.len() >= rules().limits.records {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Canonical record count exceeds its bound.",
            ));
        }
        let id = text(row, 0, 36)?;
        let path = text(row, 1, rules().limits.path_bytes)?;
        let revision: i64 = row
            .get(2)
            .map_err(|_| invalid("Record revision is invalid."))?;
        let body_hash = text(row, 3, 64)?;
        let metadata_source = text(row, 4, value::max_source_bytes())?;
        total = total.checked_add(metadata_source.len()).ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Canonical metadata exceeds its aggregate bound.",
            )
        })?;
        if total > rules().limits.aggregate_metadata_bytes {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Canonical metadata exceeds its aggregate bound.",
            ));
        }
        if !authority::uuid_valid(&id)
            || id == workspace_id
            || !ids.insert(id.clone())
            || !paths.insert(path.clone())
            || revision < 1
            || !hash_valid(&body_hash)
            || !record_path_valid(&path)
        {
            return Err(invalid(
                "Canonical record identity, path or version is invalid.",
            ));
        }
        let metadata = value::decode_tagged(&metadata_source)
            .map_err(|e| error(AuthorityErrorKind::InvalidMetadata, e.message))?;
        if !matches!(metadata, PropertyValue::Object { .. }) {
            return Err(invalid("Canonical record properties must be an object."));
        }
        records.push(Record {
            id,
            path,
            revision,
            body_hash,
            metadata_source,
            metadata,
        });
    }
    fn relations(value: &PropertyValue, ids: &BTreeSet<String>) -> Result<(), AuthorityError> {
        use super::types::values::RelationResolution;
        match value {
            PropertyValue::Relation {
                resolution: RelationResolution::Resolved { target_id },
                ..
            } if !ids.contains(target_id) => Err(invalid(
                "A canonical relation has no matching record identity.",
            )),
            PropertyValue::Object { value } => {
                for child in value.values() {
                    relations(child, ids)?;
                }
                Ok(())
            }
            PropertyValue::Array { value } => {
                for child in value {
                    relations(child, ids)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    for record in &records {
        relations(&record.metadata, &ids)?;
    }
    let snapshot = Snapshot {
        schema_revision,
        epoch,
        records,
    };
    metadata::validate_requests(conn, workspace_id, &snapshot)?;
    Ok(snapshot)
}
fn record_version(binding: &SelectedBinding, record: &Record) -> SelectedRecordVersion {
    SelectedRecordVersion {
        kind: SelectedAuthorityKind::SqliteMetadata,
        workspace_id: binding.workspace_id.clone(),
        record_id: record.id.clone(),
        metadata_revision: record.revision.to_string(),
        metadata_hash: crate::ledger::sha256_hex(record.metadata_source.as_bytes()),
        body_hash: record.body_hash.clone(),
    }
}
fn body(binding: &SelectedBinding, record: &Record, cap: u64) -> Result<String, AuthorityError> {
    let bytes = authority::read_bounded(&binding.root, &record.path, cap)?;
    if crate::ledger::sha256_hex(&bytes) != record.body_hash {
        return Err(error(
            AuthorityErrorKind::SourceChanged,
            "The visible body disagrees with its canonical pairing.",
        ));
    }
    String::from_utf8(bytes).map_err(|_| invalid("The paired page body is not UTF-8."))
}
fn check_pairing(binding: &SelectedBinding, snapshot: &Snapshot) -> Result<(), AuthorityError> {
    let paths: BTreeSet<_> = snapshot.records.iter().map(|r| r.path.as_str()).collect();
    let mut found = BTreeSet::new();
    let mut count = 0usize;
    for item in walkdir::WalkDir::new(&binding.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|item| {
            item.depth() == 0
                || if item.file_type().is_dir() {
                    !crate::vault::scan::is_skipped_dir(&item.file_name().to_string_lossy())
                } else {
                    !crate::vault::scan::is_hidden(&item.file_name().to_string_lossy())
                }
        })
    {
        let item = item.map_err(|_| missing("The complete visible body set is unavailable."))?;
        count += 1;
        if count
            > rules()
                .limits
                .records
                .saturating_mul(8)
                .saturating_add(1024)
        {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Visible body discovery exceeds its bound.",
            ));
        }
        if item.depth() == 0 || item.file_type().is_dir() {
            continue;
        }
        if item.file_type().is_symlink() {
            return Err(invalid("Visible body discovery cannot follow symlinks."));
        }
        let relative = item
            .path()
            .strip_prefix(&binding.root)
            .map_err(|_| invalid("Visible body discovery escaped its root."))?
            .to_str()
            .ok_or_else(|| invalid("A visible body path is not UTF-8."))?;
        if relative.ends_with(".mmd") || crate::files::kinds::is_whiteboard(relative) {
            return Err(error(
                AuthorityErrorKind::UnsupportedOperation,
                "This selected workspace carrier has no read adapter.",
            ));
        }
        if relative.ends_with(".md") {
            if !paths.contains(relative) {
                return Err(missing(
                    "A visible page has no canonical metadata identity.",
                ));
            }
            found.insert(relative.to_owned());
        }
    }
    if found.len() != paths.len() {
        return Err(missing("A canonical record has no paired visible page."));
    }
    Ok(())
}
struct EntryMetadata {
    properties: serde_json::Map<String, serde_json::Value>,
    entry_type: Option<String>,
    canonical_properties: SelectedEntryProperties,
}
fn canonical_entry_type(record: &Record) -> Result<Option<String>, AuthorityError> {
    let PropertyValue::Object { value: fields } = &record.metadata else {
        return Err(invalid("Canonical properties are not an object."));
    };
    match fields.get("type") {
        None | Some(PropertyValue::Null {}) => Ok(None),
        Some(PropertyValue::String { value }) => Ok(Some(value.clone())),
        _ => Err(error(
            AuthorityErrorKind::UnsupportedProjection,
            "The canonical page type cannot be projected exactly.",
        )),
    }
}
fn entry_metadata(record: &Record) -> Result<EntryMetadata, AuthorityError> {
    let entry_type = canonical_entry_type(record)?;
    let PropertyValue::Object { value: fields } = &record.metadata else {
        return Err(invalid("Canonical properties are not an object."));
    };
    let mut properties = serde_json::Map::new();
    let mut unavailable_legacy_keys = Vec::new();
    // One incompatible member must not erase the record or its other fields.
    // The exact complete Object is retained below; this is compatibility only.
    for (key, stored) in fields {
        match value::legacy_value(stored) {
            Ok(projected) => {
                properties.insert(key.clone(), projected);
            }
            Err(_) => unavailable_legacy_keys.push(key.clone()),
        }
    }
    unavailable_legacy_keys.sort();
    Ok(EntryMetadata {
        properties,
        entry_type,
        canonical_properties: SelectedEntryProperties {
            value: record.metadata.clone(),
            unavailable_legacy_keys,
        },
    })
}
fn entry(binding: &SelectedBinding, record: &Record, body: &str) -> Result<Entry, AuthorityError> {
    entry_with_metadata(binding, record, body, entry_metadata(record)?)
}
fn entry_with_metadata(
    binding: &SelectedBinding,
    record: &Record,
    body: &str,
    metadata: EntryMetadata,
) -> Result<Entry, AuthorityError> {
    let EntryMetadata {
        properties,
        entry_type,
        canonical_properties,
    } = metadata;
    let filename = record
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&record.path)
        .to_owned();
    let folder = record
        .path
        .rsplit_once('/')
        .map(|(folder, _)| folder)
        .unwrap_or("")
        .to_owned();
    let display = body.strip_prefix('\u{feff}').unwrap_or(body);
    let meta = fs::metadata(binding.root.join(&record.path))
        .map_err(|_| missing("Paired page metadata is unavailable."))?;
    let (created_at, modified_at) = crate::vault::scan::timestamps(Some(&meta));
    Ok(Entry {
        path: record.path.clone(),
        filename: filename.clone(),
        folder,
        project: None,
        title: store::selected_title(&record.path, body),
        entry_type,
        properties,
        relationships: BTreeMap::new(),
        outgoing_links: crate::vault::parse::extract_outgoing_links(display),
        snippet: crate::vault::parse::extract_snippet(display),
        created_at,
        modified_at,
        parse_error: None,
        hash: Some(record.body_hash.clone()),
        authority: Some(record_version(binding, record)),
        canonical_properties: Some(canonical_properties),
        body_observation: None,
    })
}
#[cfg(test)]
pub(crate) fn scan(root: &Path) -> Result<Vec<Entry>, AuthorityError> {
    scan_filtered(root, |_| true)
}
/// Human presentation may observe ordinary schema-3 bodies outside their
/// canonical pairing. Service scans and corpus reads remain strictly paired.
pub(crate) fn scan_presentation(root: &Path) -> Result<Vec<Entry>, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    store::scan_presentation(&binding)
}
pub(crate) fn scan_filtered(
    root: &Path,
    include: impl Fn(&str) -> bool,
) -> Result<Vec<Entry>, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    scan_filtered_bound(&binding, include)
}
fn scan_filtered_bound(
    binding: &SelectedBinding,
    include: impl Fn(&str) -> bool,
) -> Result<Vec<Entry>, AuthorityError> {
    let snapshot = read_snapshot(&connection(binding, false)?, binding)?;
    check_pairing(binding, &snapshot)?;
    let mut out = Vec::new();
    let mut bytes = 0usize;
    for record in &snapshot.records {
        if include(&record.path) {
            let remaining = rules().limits.aggregate_body_bytes.saturating_sub(bytes) as u64;
            let body = body(binding, record, rules().limits.body_bytes.min(remaining))?;
            bytes = bytes.checked_add(body.len()).ok_or_else(|| {
                error(
                    AuthorityErrorKind::SourceLimit,
                    "Page bodies exceed their aggregate bound.",
                )
            })?;
            out.push(entry(binding, record, &body)?);
        }
    }
    crate::vault::scan::assign_projects(&mut out);
    Ok(out)
}
pub(crate) fn read_body(root: &Path, path: &str) -> Result<String, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    let snapshot = read_snapshot(&connection(&binding, false)?, &binding)?;
    let record = snapshot
        .records
        .iter()
        .find(|record| record.path == path)
        .ok_or_else(|| missing("The canonical record is unavailable."))?;
    body(&binding, record, rules().limits.body_bytes)
}
pub(crate) fn set_full_width(
    root: &Path,
    path: &str,
    expected: &SelectedRecordVersion,
    mode: SelectedMode,
    by: &WriteReceipt<Human>,
) -> Result<SelectedMetadataAck, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    let _held = crate::vault::write::lock_selected_path(root, path)
        .map_err(|message| error(AuthorityErrorKind::UnsupportedOperation, message))?;
    if authority::selected_binding(root)? != binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The trusted workspace binding changed.",
        ));
    }
    // Check an existing readonly store before opening a mutable connection.
    read_snapshot(&connection(&binding, false)?, &binding)?;
    let mut conn = connection(&binding, true)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| missing("Canonical metadata is busy or unavailable."))?;
    let snapshot = read_snapshot(&tx, &binding)?;
    let record = snapshot
        .records
        .iter()
        .find(|record| record.path == path)
        .ok_or_else(|| missing("The canonical record is unavailable."))?;
    let observed = record_version(&binding, record);
    if expected.kind != SelectedAuthorityKind::SqliteMetadata
        || expected.workspace_id != observed.workspace_id
        || expected.record_id != observed.record_id
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The canonical record identity changed.",
        ));
    }
    body(&binding, record, rules().limits.body_bytes)?;
    if expected.body_hash != observed.body_hash {
        return Err(error(
            AuthorityErrorKind::SourceChanged,
            "The expected paired body changed.",
        ));
    }
    if expected.metadata_revision != observed.metadata_revision
        || expected.metadata_hash != observed.metadata_hash
    {
        return Err(error(
            AuthorityErrorKind::StaleMetadata,
            "The canonical metadata changed.",
        ));
    }
    let PropertyValue::Object { mut value } = record.metadata.clone() else {
        return Err(invalid("Canonical properties are not an object."));
    };
    let full_width = mode == SelectedMode::Wide;
    let unchanged = if full_width {
        matches!(
            value.get("full_width"),
            Some(PropertyValue::Boolean { value: true })
        )
    } else {
        !value.contains_key("full_width")
    };
    if unchanged {
        return Ok(SelectedMetadataAck::Unchanged {
            version: observed,
            full_width,
        });
    }
    if full_width {
        value.insert("full_width".into(), PropertyValue::Boolean { value: true });
    } else {
        value.remove("full_width");
    }
    let metadata = serde_json::to_string(&PropertyValue::Object { value })
        .map_err(|_| invalid("Canonical metadata cannot be encoded."))?;
    value::decode_tagged(&metadata)
        .map_err(|e| error(AuthorityErrorKind::SourceLimit, e.message))?;
    // The replacement must remain readable by the same aggregate budget as
    // read_snapshot. Refuse inside the transaction before changing any record,
    // workspace counter or receipt.
    snapshot
        .records
        .iter()
        .try_fold(0usize, |total, other| {
            total.checked_add(if other.id == record.id {
                metadata.len()
            } else {
                other.metadata_source.len()
            })
        })
        .filter(|total| *total <= rules().limits.aggregate_metadata_bytes)
        .ok_or_else(|| {
            error(
                AuthorityErrorKind::SourceLimit,
                "Canonical metadata exceeds its aggregate bound.",
            )
        })?;
    let revision = record.revision.checked_add(1).ok_or_else(|| {
        error(
            AuthorityErrorKind::SourceLimit,
            "Canonical revision is exhausted.",
        )
    })?;
    let epoch = snapshot.epoch.checked_add(1).ok_or_else(|| {
        error(
            AuthorityErrorKind::SourceLimit,
            "Canonical metadata epoch is exhausted.",
        )
    })?;
    let updated=tx.execute("UPDATE records SET revision=?1,metadata=?2 WHERE id=?3 AND path=?4 AND revision=?5 AND metadata=?6 AND body_hash=?7",rusqlite::params![revision,metadata,record.id,path,record.revision,record.metadata_source,record.body_hash]).map_err(|_|invalid("Canonical metadata update failed."))?;
    if updated != 1 {
        return Err(error(
            AuthorityErrorKind::StaleMetadata,
            "Canonical metadata changed before its transaction.",
        ));
    }
    if tx
        .execute(
            "UPDATE workspace SET metadata_epoch=?1 WHERE singleton=1 AND metadata_epoch=?2",
            [epoch, snapshot.epoch],
        )
        .map_err(|_| invalid("Canonical epoch update failed."))?
        != 1
    {
        return Err(error(
            AuthorityErrorKind::StaleMetadata,
            "Workspace metadata changed before its transaction.",
        ));
    }
    let after_hash = crate::ledger::sha256_hex(metadata.as_bytes());
    if store::schema_version(&tx)? == rules().schema_version {
        tx.execute("INSERT INTO metadata_receipts(epoch,record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at) VALUES (?1,?2,?3,?4,?5,?6,?7,'page.full_width',?8)",rusqlite::params![epoch,record.id,record.revision,revision,observed.metadata_hash,after_hash,by.actor(),chrono::Utc::now().to_rfc3339()]).map_err(|_|invalid("Canonical metadata receipt could not be recorded."))?;
    } else {
        tx.execute("INSERT INTO metadata_receipts(epoch,record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by) VALUES (?1,?2,?3,?4,?5,?6,?7,'page.full_width',?8,?9,?9,?10,?11)", rusqlite::params![epoch,record.id,record.revision,revision,observed.metadata_hash,after_hash,by.actor(),chrono::Utc::now().to_rfc3339(),record.body_hash,by.run_id(),by.approved_by()]).map_err(|_| invalid("Canonical metadata receipt could not be recorded."))?;
    }

    #[cfg(test)]
    before_commit();
    body(&binding, record, rules().limits.body_bytes)?;
    if authority::selected_binding(root)? != binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The trusted workspace binding changed before commit.",
        ));
    }
    private_database(&binding)?;
    store::handle_unmoved(&tx)?;
    store::page_budget(&tx, &binding)?;
    if let Some(guard) = &_guard {
        guard.validate()?;
    }
    tx.commit()
        .map_err(|_| invalid("Canonical metadata transaction could not commit."))?;
    store::handle_unmoved(&conn)?;
    Ok(SelectedMetadataAck::Applied {
        version: SelectedRecordVersion {
            metadata_revision: revision.to_string(),
            metadata_hash: after_hash,
            ..observed
        },
        full_width,
    })
}
#[cfg(test)]
thread_local! {static BEFORE_COMMIT:std::cell::RefCell<Option<Box<dyn FnOnce()>>>=const{std::cell::RefCell::new(None)};}
#[cfg(test)]
fn before_commit() {
    if let Some(action) = BEFORE_COMMIT.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}
#[cfg(test)]
pub(super) fn with_before_commit_for_test<T>(
    before: impl FnOnce() + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            BEFORE_COMMIT.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }
    BEFORE_COMMIT.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(before));
    });
    let _reset = Reset;
    run()
}

pub(crate) struct SelectedCorpus {
    pub identity: String,
    pub corpus: crate::vault::corpus::Corpus,
}
/// Fresh validation precedes any optional reuse of the resulting canonical view.
pub(crate) fn corpus_snapshot(root: &Path) -> Result<SelectedCorpus, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    let snapshot = read_snapshot(&connection(&binding, false)?, &binding)?;
    check_pairing(&binding, &snapshot)?;
    let mut entries = Vec::new();
    let mut texts = Vec::new();
    let mut facts = Vec::new();
    let mut bytes = 0usize;
    for record in &snapshot.records {
        let remaining = rules().limits.aggregate_body_bytes.saturating_sub(bytes) as u64;
        let text = body(&binding, record, rules().limits.body_bytes.min(remaining))?;
        bytes += text.len();
        let entry = entry(&binding, record, &text)?;
        facts.push(serde_json::json!([
            record.id,
            record.path,
            record.revision.to_string(),
            crate::ledger::sha256_hex(record.metadata_source.as_bytes()),
            record.body_hash,
            entry.created_at,
            entry.modified_at
        ]));
        let mut end = text.len().min(crate::vault::corpus::SEARCH_BODY_CAP);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        texts.push(crate::vault::corpus::CorpusText {
            search_fields: None,
            source: None,
            body: text[..end].to_owned(),
            capped: end < text.len(),
        });
        entries.push(entry);
    }
    crate::vault::scan::assign_projects(&mut entries);
    let identity=serde_json::to_vec(&serde_json::json!({
        "workspaceId":binding.workspace_id,
        "root":binding.root.to_str().ok_or_else(||invalid("Workspace root is not UTF-8."))?,
        "origin":binding.origin.to_str().ok_or_else(||invalid("Workspace metadata origin is not UTF-8."))?,
        "schemaRevision":snapshot.schema_revision.to_string(),"metadataEpoch":snapshot.epoch.to_string(),"records":facts,
    })).map_err(|_|invalid("Canonical cache identity cannot be encoded."))?;
    Ok(SelectedCorpus {
        identity: crate::ledger::sha256_hex(&identity),
        corpus: crate::vault::corpus::Corpus { entries, texts },
    })
}

/// Bounded physical discovery for the explicitly retained, unparsed YAML carriers.
fn physical(binding: &SelectedBinding) -> Result<Vec<(String, bool)>, AuthorityError> {
    let mut out = Vec::new();
    for item in walkdir::WalkDir::new(&binding.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !crate::vault::scan::is_hidden(&e.file_name().to_string_lossy())
                    && !matches!(
                        e.file_name().to_str(),
                        Some("node_modules" | "attachments" | "target")
                    )
        })
    {
        let item = item.map_err(|_| missing("Physical workspace carriers are unavailable."))?;
        if item.depth() == 0 {
            continue;
        }
        if out.len()
            >= rules()
                .limits
                .records
                .saturating_mul(8)
                .saturating_add(1024)
        {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Physical workspace discovery exceeds its bound.",
            ));
        }
        if item.file_type().is_symlink() {
            return Err(invalid(
                "Physical workspace carriers cannot follow symlinks.",
            ));
        }
        let path = item
            .path()
            .strip_prefix(&binding.root)
            .ok()
            .and_then(Path::to_str)
            .ok_or_else(|| invalid("A workspace carrier path is invalid."))?
            .to_owned();
        out.push((path, item.file_type().is_dir()));
    }
    Ok(out)
}
pub(crate) fn folders(root: &Path) -> Result<Vec<String>, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    let mut out = physical(&binding)?
        .into_iter()
        .filter_map(|(p, dir)| {
            (dir && !p.split('/').any(crate::vault::scan::is_skipped_dir)).then_some(p)
        })
        .collect::<Vec<_>>();
    out.sort();
    Ok(out)
}
pub(crate) fn collections(
    root: &Path,
) -> Result<Vec<crate::vault::write::CollectionYaml>, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    collections_bound(&binding)
}
fn collections_bound(
    binding: &SelectedBinding,
) -> Result<Vec<crate::vault::write::CollectionYaml>, AuthorityError> {
    let root = &binding.root;
    let mut out = Vec::new();
    for (path, dir) in physical(binding)? {
        if !dir && path.rsplit('/').next() == Some("collection.yml") {
            if out.len() >= rules().limits.retained_entries {
                return Err(error(
                    AuthorityErrorKind::SourceLimit,
                    "Retained collection count exceeds its bound.",
                ));
            }
            let bytes =
                authority::read_bounded(root, &path, rules().limits.retained_carrier_bytes)?;
            out.push(crate::vault::write::CollectionYaml {
                folder: path.rsplit_once('/').map(|(p, _)| p).unwrap_or("").into(),
                yaml: String::from_utf8(bytes)
                    .map_err(|_| invalid("A retained collection is not UTF-8."))?,
            });
        }
    }
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(out)
}
pub(crate) fn views(root: &Path) -> Result<Vec<crate::vault::write::ViewYaml>, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let _guard = store::read_guard(&binding)?;
    let conn = connection(&binding, false)?;
    let schema = store::schema_version(&conn)?;
    let snapshot = read_snapshot(&conn, &binding)?;
    store::handle_unmoved(&conn)?;
    drop(conn);
    if schema == rules().schema_version {
        // v2 retains its original strict body-pairing check for retained views.
        scan_filtered_bound(&binding, |_| true)?;
    } else {
        // Retained view scope needs known visible membership and canonical
        // type/path facts, not ordinary bodies' canonical hash agreement.
        check_pairing(&binding, &snapshot)?;
    }
    let mut declared_folders = BTreeSet::new();
    for record in &snapshot.records {
        // Preserve exact projection refusals; never infer a type from body YAML.
        let entry_type = canonical_entry_type(record)?;
        let (folder, filename) = record
            .path
            .rsplit_once('/')
            .unwrap_or(("", record.path.as_str()));
        if entry_type.as_deref() == Some("Collection")
            && filename == format!("{}.md", folder.rsplit('/').next().unwrap_or(""))
        {
            declared_folders.insert(folder.to_owned());
        }
    }
    let folders = collections_bound(&binding)?
        .into_iter()
        .map(|c| c.folder)
        .chain(declared_folders)
        .collect::<BTreeSet<_>>();
    let mut out = Vec::new();
    for (path, dir) in physical(&binding)? {
        if dir {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        let parent = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let (id, project) = if let Some(id) = name.strip_suffix(".list.yml") {
            (id, None)
        } else if let Some(id) = name.strip_suffix(".yml") {
            if parent == "views" {
                (id, None)
            } else if let Some(project_dir) = parent.strip_suffix("/views") {
                let project = format!("{project_dir}/project.md");
                if snapshot.records.iter().any(|record| record.path == project) {
                    (id, Some(project))
                } else {
                    continue;
                }
            } else {
                continue;
            }
        } else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if out.len() >= rules().limits.retained_entries {
            return Err(error(
                AuthorityErrorKind::SourceLimit,
                "Retained view count exceeds its bound.",
            ));
        }
        let bytes = authority::read_bounded(root, &path, rules().limits.retained_carrier_bytes)?;
        let collection = if name.ends_with(".list.yml") {
            folders
                .iter()
                .filter(|folder| {
                    folder.is_empty()
                        || parent == folder.as_str()
                        || parent.starts_with(&format!("{folder}/"))
                })
                .max_by_key(|f| f.len())
                .cloned()
        } else {
            None
        };
        out.push(crate::vault::write::ViewYaml {
            id: id.into(),
            yaml: String::from_utf8(bytes).map_err(|_| invalid("A retained view is not UTF-8."))?,
            project,
            collection,
            path,
        });
    }
    out.sort_by(|a, b| {
        a.collection
            .cmp(&b.collection)
            .then(a.project.cmp(&b.project))
            .then(a.id.cmp(&b.id))
    });
    if let Some(guard) = &_guard {
        guard.validate()?;
    }
    if authority::selected_binding(&binding.root)? != binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The trusted workspace binding changed.",
        ));
    }
    Ok(out)
}

// Search has a distinct read projection; canonical metadata remains tagged.
#[path = "selected_search.rs"]
mod search;
pub(crate) use search::{search_snapshot, source_body};

// Actual scoped semantic read services; metadata stays in tagged canonical form.
#[path = "selected_semantics.rs"]
mod semantics;
pub(crate) use semantics::{agenda_text, describe_database, query_records, suggest_view};
