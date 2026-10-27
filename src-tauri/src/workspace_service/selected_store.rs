//! Private selected-store pairing protocol, reached by the existing editor command.
//! No registration, activation, conversion or approval producer is exposed here.
use super::*;
use crate::vault::recovery::{
    Journal, Outcome as CopyOutcome, RetainedCopy, SelectedCaptureRequest, SelectedJoin,
    SelectedSettlement,
};
use crate::workspace_migration::journal::rules as pair_rules;
use rusqlite::OptionalExtension;
use std::{
    io::{Read, Write},
    path::PathBuf,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(unix)]
fn private_identity(path: &Path, directory: bool) -> Result<FileIdentity, AuthorityError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| missing("Canonical storage identity is unavailable."))?;
    // SAFETY: geteuid reads the process identity and retains no borrowed memory.
    let uid = unsafe { libc::geteuid() };
    if metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file() || metadata.nlink() != 1
        }
    {
        return Err(invalid(
            "Canonical storage must have its original private owner.",
        ));
    }
    Ok(file_identity(&metadata))
}

#[cfg(unix)]
fn sqlite_handle_unmoved(conn: &Connection) -> Result<(), AuthorityError> {
    let mut moved: std::ffi::c_int = -1;
    // SAFETY: conn is live; main is static C-string storage; moved points to a
    // live writable c_int for this opcode. SQLite retains neither pointer.
    // Explicit unix-posix is required at open; do not fall back to unix-none.
    let status = unsafe {
        rusqlite::ffi::sqlite3_file_control(
            conn.handle(),
            c"main".as_ptr(),
            rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
            (&mut moved as *mut std::ffi::c_int).cast(),
        )
    };
    if status != rusqlite::ffi::SQLITE_OK || moved != 0 {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The canonical database handle changed identity.",
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn verified_connection(
    binding: &SelectedBinding,
    writable: bool,
) -> Result<Connection, AuthorityError> {
    private_database(binding)?;
    let directory = binding
        .database
        .parent()
        .ok_or_else(|| invalid("Canonical storage has no private parent."))?;
    let parent = private_identity(directory, true)?;
    let identity = private_identity(&binding.database, false)?;
    #[cfg(test)]
    open_hook(true);
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let conn = Connection::open_with_flags_and_vfs(&binding.database, flags, "unix-posix")
        .map_err(|_| missing("Canonical metadata cannot be opened."))?;
    #[cfg(test)]
    open_hook(false);
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| missing("Canonical metadata lock policy is unavailable."))?;
    conn.pragma_update(None, "trusted_schema", false)
        .map_err(|_| invalid("Canonical metadata cannot be inspected safely."))?;
    // Force the actual VFS main handle open before the HAS_MOVED query.
    let _: i64 = conn
        .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
        .map_err(|_| invalid("Canonical metadata schema is unreadable."))?;
    sqlite_handle_unmoved(&conn)?;
    if private_identity(directory, true)? != parent
        || private_identity(&binding.database, false)? != identity
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The canonical database changed identity while opening.",
        ));
    }
    private_database(binding)?;
    verify_schema(&conn)?;
    Ok(conn)
}

pub(super) struct WorkspaceLock {
    file: fs::File,
    lock_identity: FileIdentity,
    parent_identity: FileIdentity,
    database_identity: FileIdentity,
    directory: std::path::PathBuf,
    database: std::path::PathBuf,
}

pub(super) fn no_pending(binding: &SelectedBinding) -> Result<(), AuthorityError> {
    let directory = binding
        .database
        .parent()
        .ok_or_else(|| invalid("Canonical metadata has no private parent."))?;
    match fs::symlink_metadata(directory.join(&pair_rules().names.pending)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(error(
            AuthorityErrorKind::RecoveryRequired,
            "This workspace has an unfinished paired change.",
        )),
        Err(_) => Err(error(
            AuthorityErrorKind::RecoveryRequired,
            "The workspace recovery state is unavailable.",
        )),
    }
}

#[cfg(unix)]
impl WorkspaceLock {
    fn acquire(binding: &SelectedBinding) -> Result<Self, AuthorityError> {
        Self::acquire_with_access(binding, true)
    }
    fn acquire_with_access(
        binding: &SelectedBinding,
        writable: bool,
    ) -> Result<Self, AuthorityError> {
        use std::os::unix::fs::OpenOptionsExt;
        let directory = binding
            .database
            .parent()
            .ok_or_else(|| invalid("Canonical metadata has no private parent."))?
            .to_owned();
        let parent_identity = private_identity(&directory, true)?;
        let database_identity = private_identity(&binding.database, false)?;
        let path = directory.join(&pair_rules().names.lock);
        let lock_identity = private_identity(&path, false)?;
        if lock_identity == database_identity {
            return Err(invalid(
                "The workspace lock must be separate from its database.",
            ));
        }
        // Never CREATE, chmod, truncate or write a holder label. Initialization
        // belongs to reviewed disposable v3 fixture setup, not this read door.
        let file = fs::OpenOptions::new()
            .read(true)
            .write(writable)
            .custom_flags(
                libc::O_NOFOLLOW | libc::O_CLOEXEC | if writable { 0 } else { libc::O_NONBLOCK },
            )
            .open(&path)
            .map_err(|_| missing("The existing workspace lock is unavailable."))?;
        let opened = file
            .metadata()
            .map_err(|_| missing("The workspace lock identity is unavailable."))?;
        if file_identity(&opened) != lock_identity || opened.len() != 0 {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "The workspace lock changed identity.",
            ));
        }
        file.try_lock().map_err(|failure| match failure {
            std::fs::TryLockError::WouldBlock => error(
                AuthorityErrorKind::Busy,
                "Another operation is using this workspace.",
            ),
            std::fs::TryLockError::Error(_) => missing("The workspace lock is unavailable."),
        })?;
        let guard = Self {
            file,
            lock_identity,
            parent_identity,
            database_identity,
            directory,
            database: binding.database.clone(),
        };
        guard.validate()?;
        Ok(guard)
    }

    pub(super) fn validate(&self) -> Result<(), AuthorityError> {
        let path = self.directory.join(&pair_rules().names.lock);
        let opened = self
            .file
            .metadata()
            .map_err(|_| missing("The held workspace lock is unavailable."))?;
        if private_identity(&self.directory, true)? != self.parent_identity
            || private_identity(&self.database, false)? != self.database_identity
            || private_identity(&path, false)? != self.lock_identity
            || file_identity(&opened) != self.lock_identity
            || opened.len() != 0
        {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "The held workspace storage changed identity.",
            ));
        }
        Ok(())
    }
}

// No explicit unlock/unlink Drop: closing this distinct lock inode releases its
// flock. Keep guard alive until AFTER Connection/Transaction drop. No File open,
// read/hash descriptor or native-fd cast is made for workspace.db by this owner.

pub(super) fn selected_title(path: &str, exact_body: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let display = exact_body.strip_prefix('\u{feff}').unwrap_or(exact_body);
    crate::vault::parse::extract_h1_title(display).unwrap_or_else(|| {
        crate::vault::parse::humanize_stem(filename.strip_suffix(".md").unwrap_or(filename))
    })
}

pub(super) fn ordinary_body_target(
    binding: &SelectedBinding,
    snapshot: &Snapshot,
    record: &Record,
) -> Result<(), AuthorityError> {
    crate::knowledge::guard_human_write(&record.path).map_err(|_| {
        error(
            AuthorityErrorKind::UnsupportedOperation,
            "This page belongs to its governed writer.",
        )
    })?;
    // Path/carrier/root containment was already checked by read_snapshot and
    // verified body reads. A different path's Human receipt cannot bypass this.
    let PropertyValue::Object { value } = &record.metadata else {
        return Err(invalid("Canonical record properties must be an object."));
    };
    let name = match value.get("type") {
        None | Some(PropertyValue::Null {}) => return Ok(()),
        Some(PropertyValue::String { value }) if !value.is_empty() => value,
        _ => {
            return Err(error(
                AuthorityErrorKind::UnsupportedOperation,
                "The canonical page type cannot be classified exactly.",
            ))
        }
    };
    // This normalizes only the DENIAL comparison, matching existing reserved
    // type admission. Declaration lookup below remains exact and case-sensitive.
    let folded = name.trim().to_lowercase();
    if pair_rules()
        .blocked_canonical_types
        .iter()
        .any(|reserved| reserved.to_lowercase() == folded)
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "This canonical page type belongs to its own writer.",
        ));
    }
    let mut declarations = 0usize;
    for candidate in &snapshot.records {
        let PropertyValue::Object { value } = &candidate.metadata else {
            return Err(invalid("Canonical record properties must be an object."));
        };
        if !matches!(value.get("type"), Some(PropertyValue::String { value }) if value == "Type") {
            continue;
        }
        let exact_body = body(binding, candidate, rules().limits.body_bytes)?;
        if selected_title(&candidate.path, &exact_body) == *name {
            declarations += 1;
            if declarations > 1 {
                return Err(error(
                    AuthorityErrorKind::UnsupportedOperation,
                    "The canonical page type has ambiguous declarations.",
                ));
            }
        }
    }
    if declarations != 1 {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "The canonical page type has no supported declaration.",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BodyPart {
    name: String,
    length: u64,
    hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IntentEnvelope {
    format: u32,
    operation_id: String,
    workspace_id: String,
    body_root: String,
    database: String,
    body_root_identity: FileIdentity,
    metadata_directory_identity: FileIdentity,
    database_identity: FileIdentity,
    lock_identity: FileIdentity,
    selected_schema: i64,
    record_id: String,
    path: String,
    schema_revision: i64,
    before_revision: i64,
    after_revision: i64,
    before_epoch: i64,
    after_epoch: i64,
    metadata_source: String,
    metadata_hash: String,
    before_body: BodyPart,
    after_body: BodyPart,
    // Plain source permissions only, no type/sticky/setuid/setgid bits.
    body_permissions: u32,
    receipt: OriginalReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retained_copy: Option<RetainedCopy>,
    // Format3 only. Skip absent fields so historical format1/2 bytes/digests
    // remain exactly the old serialization and explicit CAS rollback protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    canonical_before_body_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_disposition: Option<EditorRecoveryDisposition>,
}
const EDITOR_INTENT_FORMAT: u32 = 3;
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum EditorRecoveryDisposition {
    CompleteOriginal,
}

impl IntentEnvelope {
    fn validate_values(&self, before: &[u8], after: &[u8]) -> Result<(), AuthorityError> {
        let conflict = || {
            error(
                AuthorityErrorKind::RecoveryConflict,
                "The paired change evidence is inconsistent.",
            )
        };
        if self.format != 1
            && self.format != pair_rules().version
            && self.format != EDITOR_INTENT_FORMAT
            || !metadata::paired_schema(self.selected_schema)
            || !authority::uuid_valid(&self.operation_id)
            || !authority::uuid_valid(&self.workspace_id)
            || !authority::uuid_valid(&self.record_id)
            || self.workspace_id == self.record_id
            || self.before_revision < 1
            || self.before_epoch < 1
            || self.schema_revision < 1
            || self.before_revision.checked_add(1) != Some(self.after_revision)
            || self.before_epoch.checked_add(1) != Some(self.after_epoch)
            || self.path.len() > rules().limits.path_bytes
            || crate::files::bytes::rel_refusal("paired-change", &self.path).is_some()
            || !self.path.ends_with(".md")
            || self.path.split('/').any(crate::vault::scan::is_hidden)
            || self
                .path
                .split('/')
                .rev()
                .skip(1)
                .any(crate::vault::scan::is_skipped_dir)
            || self.before_body.name != pair_rules().names.before_body
            || self.after_body.name != pair_rules().names.after_body
            || self.body_permissions & !0o777 != 0
            || self.metadata_source.len() > value::max_source_bytes()
        {
            return Err(conflict());
        }
        if crate::knowledge::guard_human_write(&self.path).is_err() {
            return Err(conflict());
        }
        let exact = value::decode_tagged(&self.metadata_source).map_err(|_| conflict())?;
        if !matches!(exact, PropertyValue::Object { .. })
            || crate::ledger::sha256_hex(self.metadata_source.as_bytes()) != self.metadata_hash
        {
            return Err(conflict());
        }
        for (part, bytes) in [(&self.before_body, before), (&self.after_body, after)] {
            if part.length > rules().limits.body_bytes
                || part.length != bytes.len() as u64
                || !hash_valid(&part.hash)
                || crate::ledger::sha256_hex(bytes) != part.hash
                || std::str::from_utf8(bytes).is_err()
            {
                return Err(conflict());
            }
        }
        if self.format == EDITOR_INTENT_FORMAT {
            if !self
                .canonical_before_body_hash
                .as_deref()
                .is_some_and(hash_valid)
                || !self
                    .request_key
                    .as_deref()
                    .is_some_and(authority::uuid_valid)
                || self.recovery_disposition != Some(EditorRecoveryDisposition::CompleteOriginal)
                || (before == after && self.old_body_hash() == self.after_body.hash)
            {
                return Err(conflict());
            }
        } else if self.canonical_before_body_hash.is_some()
            || self.request_key.is_some()
            || self.recovery_disposition.is_some()
            || before == after
        {
            return Err(conflict());
        }
        if let Some(reference) = &self.retained_copy {
            reference.validate().map_err(|_| conflict())?;
            if (self.format != pair_rules().version && self.format != EDITOR_INTENT_FORMAT)
                || chrono::DateTime::parse_from_rfc3339(&self.receipt.at)
                    .map_err(|_| conflict())?
                    .timestamp()
                    != reference.captured_at
            {
                return Err(conflict());
            }
        }
        let receipt = &self.receipt;
        if receipt.workspace_id != self.workspace_id
            || receipt.epoch != self.after_epoch
            || receipt.record_id != self.record_id
            || receipt.previous_revision != self.before_revision
            || receipt.revision != self.after_revision
            || receipt.metadata_before_hash != self.metadata_hash
            || receipt.metadata_after_hash != self.metadata_hash
            || receipt.body_before_hash != self.before_body.hash
            || receipt.body_after_hash != self.after_body.hash
            || receipt.actor != crate::vault::receipt::HUMAN_ACTOR
            || receipt.run_id.is_some()
            || receipt.approved_by.is_some()
            || receipt.operation != pair_rules().operation
            || receipt.at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&receipt.at).is_err()
        {
            return Err(conflict());
        }
        Ok(())
    }
}

// Constructible only within this selected owner, for an admitted operation
// whose original receipt and exact before/after images are already checked.
pub(crate) struct CaptureIdentity<'a> {
    envelope: &'a mut IntentEnvelope,
}
impl CaptureIdentity<'_> {
    pub(crate) fn attach(&mut self, reference: &RetainedCopy) -> Result<SelectedJoin, String> {
        reference.validate()?;
        if self.envelope.retained_copy.is_some()
            || (self.envelope.format != pair_rules().version
                && self.envelope.format != EDITOR_INTENT_FORMAT)
        {
            return Err("recovery_selected_identity_conflict".into());
        }
        self.envelope.retained_copy = Some(reference.clone());
        self.envelope.receipt.at =
            chrono::DateTime::<chrono::Utc>::from_timestamp(reference.captured_at, 0)
                .ok_or("recovery_selected_identity_conflict")?
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        self.envelope
            .retention_join()
            .map_err(|_| "recovery_selected_identity_conflict".into())
    }
}
impl IntentEnvelope {
    fn old_body_hash(&self) -> &str {
        self.canonical_before_body_hash
            .as_deref()
            .unwrap_or(&self.before_body.hash)
    }
    fn editor_operation(&self) -> Option<EditorOperation> {
        let request_key = self.request_key.as_ref()?;
        Some(EditorOperation {
            target: SelectedEditorTarget {
                workspace_id: self.workspace_id.clone(),
                record_id: self.record_id.clone(),
            },
            path: self.path.clone(),
            request_key: request_key.clone(),
            operation_id: self.operation_id.clone(),
            version: SelectedRecordVersion {
                kind: SelectedAuthorityKind::SqliteMetadata,
                workspace_id: self.workspace_id.clone(),
                record_id: self.record_id.clone(),
                metadata_revision: self.after_revision.to_string(),
                metadata_hash: self.metadata_hash.clone(),
                body_hash: self.after_body.hash.clone(),
            },
            receipt: Box::new(EditorReceiptView::from(&self.receipt)),
        })
    }
    fn retention_join(&self) -> Result<SelectedJoin, AuthorityError> {
        if (self.format != pair_rules().version && self.format != EDITOR_INTENT_FORMAT)
            || self.retained_copy.is_none()
        {
            return Err(conflict());
        }
        let bytes = serde_json::to_vec(self).map_err(|_| conflict())?;
        if bytes.len() as u64 > pair_rules().limits.envelope_bytes {
            return Err(conflict());
        }
        let mut identity = b"cerebro-selected-retention-intent-v1\0".to_vec();
        identity.extend_from_slice(&bytes);
        Ok(SelectedJoin {
            version: 1,
            operation_id: self.operation_id.clone(),
            workspace_id: self.workspace_id.clone(),
            record_id: self.record_id.clone(),
            intent_identity_sha256: crate::ledger::sha256_hex(&identity),
        })
    }
}
fn retention_error(message: String) -> AuthorityError {
    if message == "recovery_selected_identity_conflict" {
        conflict()
    } else {
        required()
    }
}

pub(super) fn schema_version(conn: &Connection) -> Result<i64, AuthorityError> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| invalid("Canonical schema version is unreadable."))
}

/// Acquires before opening SQLite; existing v2 stores need no new lock file.
/// Normal readers never create, chmod or label the lock. Physical-reader callers
/// use the same guard even when they do not project canonical metadata.
pub(super) fn read_guard(
    binding: &SelectedBinding,
) -> Result<Option<WorkspaceLock>, AuthorityError> {
    read_guard_with_access(binding, true)
}
#[cfg(target_os = "macos")]
pub(super) fn read_guard_readonly(
    binding: &SelectedBinding,
) -> Result<Option<WorkspaceLock>, AuthorityError> {
    // The backup source checks v3 through its own pinned readonly connection.
    // Acquiring this existing lock must not reopen SQLite by pathname first.
    no_pending(binding)?;
    let guard = WorkspaceLock::acquire_with_access(binding, false)?;
    guard.validate()?;
    if authority::selected_binding(&binding.root)? != *binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The workspace binding changed.",
        ));
    }
    Ok(Some(guard))
}
fn read_guard_with_access(
    binding: &SelectedBinding,
    writable: bool,
) -> Result<Option<WorkspaceLock>, AuthorityError> {
    no_pending(binding)?;
    let directory = binding
        .database
        .parent()
        .ok_or_else(|| invalid("Missing metadata parent."))?;
    let lock = directory.join(&pair_rules().names.lock);
    let guard = match fs::symlink_metadata(&lock) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(missing("The existing workspace lock is unavailable.")),
        Ok(_) => Some(if writable {
            WorkspaceLock::acquire(binding)?
        } else {
            WorkspaceLock::acquire_with_access(binding, false)?
        }),
    };
    let conn = connection(binding, false)?;
    if metadata::paired_schema(schema_version(&conn)?) && guard.is_none() {
        return Err(missing("This paired workspace has no trusted lock."));
    }
    no_pending(binding)?;
    if authority::selected_binding(&binding.root)? != *binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The workspace binding changed.",
        ));
    }
    Ok(guard)
}

pub(super) fn handle_unmoved(conn: &Connection) -> Result<(), AuthorityError> {
    sqlite_handle_unmoved(conn)
}

pub(super) fn page_budget(
    conn: &Connection,
    binding: &SelectedBinding,
) -> Result<(), AuthorityError> {
    let pages: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|_| invalid("Canonical page allocation is unavailable."))?;
    let size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|_| invalid("Canonical page allocation is unavailable."))?;
    let pages = u64::try_from(pages).map_err(|_| invalid("Canonical page count is negative."))?;
    let size = u64::try_from(size).map_err(|_| invalid("Canonical page size is negative."))?;
    let database_limit = rules().limits.database_bytes;
    #[cfg(test)]
    let database_limit = SQLITE_BYTE_LIMIT
        .with(|limit| limit.get())
        .unwrap_or(database_limit);
    if size == 0 || pages.checked_mul(size).is_none_or(|n| n > database_limit) {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Canonical allocation exceeds its bound.",
        ));
    }
    let rollback = binding.database.with_file_name(format!(
        "{}-journal",
        binding
            .database
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| invalid("Invalid database name."))?
    ));
    match fs::symlink_metadata(&rollback) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(missing("Canonical rollback storage is unavailable.")),
        Ok(meta) => {
            private_identity(&rollback, false)?;
            if meta.len() > pair_rules().limits.sqlite_rollback_bytes {
                return Err(error(
                    AuthorityErrorKind::SourceLimit,
                    "Canonical rollback storage exceeds its bound.",
                ));
            }
        }
    }
    Ok(())
}

fn conflict() -> AuthorityError {
    error(
        AuthorityErrorKind::RecoveryConflict,
        "The paired change needs explicit reconciliation; its evidence was retained.",
    )
}
fn required() -> AuthorityError {
    error(
        AuthorityErrorKind::RecoveryRequired,
        "The paired change must be recovered before this workspace can be used.",
    )
}
fn pressure() -> AuthorityError {
    error(
        AuthorityErrorKind::ArtifactPressure,
        "Retained paired-change evidence exceeds the available journal budget.",
    )
}
fn sync_directory(path: &Path) -> Result<(), AuthorityError> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| required())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<FileIdentity, AuthorityError> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| required())?;
    let identity = file_identity(&file.metadata().map_err(|_| required())?);
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        // Only this process's exact newly created inode may be removed on an
        // ordinary pre-publication error. A process stop runs no such cleanup.
        if private_identity(path, false).ok() == Some(identity) {
            let _ = fs::remove_file(path);
        }
        return Err(required());
    }
    if private_identity(path, false)? != identity {
        return Err(conflict());
    }
    Ok(identity)
}
fn read_private_owned(path: &Path, cap: u64) -> Result<(Vec<u8>, FileIdentity), AuthorityError> {
    use std::os::unix::fs::OpenOptionsExt;
    let identity = private_identity(path, false).map_err(|_| conflict())?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| conflict())?;
    let before = file.metadata().map_err(|_| conflict())?;
    if file_identity(&before) != identity || before.len() > cap {
        return Err(conflict());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| conflict())?;
    let after = file.metadata().map_err(|_| conflict())?;
    if bytes.len() as u64 > cap
        || before.len() != bytes.len() as u64
        || before.modified().ok() != after.modified().ok()
        || private_identity(path, false).map_err(|_| conflict())? != identity
    {
        return Err(conflict());
    }
    Ok((bytes, identity))
}
fn read_private(path: &Path, cap: u64) -> Result<Vec<u8>, AuthorityError> {
    read_private_owned(path, cap).map(|(bytes, _)| bytes)
}
fn exact_private(
    path: &Path,
    identity: FileIdentity,
    expected: &[u8],
) -> Result<(), AuthorityError> {
    if private_identity(path, false).map_err(|_| conflict())? != identity {
        return Err(conflict());
    }
    let (bytes, observed) = read_private_owned(path, expected.len() as u64)?;
    if observed != identity || bytes != expected {
        return Err(conflict());
    }
    Ok(())
}
fn create_private_directory(path: &Path) -> Result<(), AuthorityError> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(|_| required())
}
fn absent(path: &Path) -> Result<bool, AuthorityError> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(conflict()),
        Ok(_) => Ok(false),
    }
}

/// Shallow bounded inventory. Unknown/incomplete evidence is preserved and
/// refuses a new operation; this function never deletes to obtain capacity.
fn admit_artifacts(directory: &Path, incoming: u64) -> Result<(), AuthorityError> {
    let limits = &pair_rules().limits;
    let body = rules().limits.body_bytes;
    let declared = (limits.artifact_directories as u64)
        .checked_mul(
            body.checked_mul(2)
                .and_then(|n| n.checked_add(limits.envelope_bytes))
                .ok_or_else(pressure)?,
        )
        .and_then(|n| n.checked_add(limits.target_temps.checked_mul(body)?))
        .ok_or_else(pressure)?;
    if declared != limits.logical_artifact_bytes {
        return Err(pressure());
    }
    let names = &pair_rules().names;
    let mut count = 0usize;
    let mut bytes = incoming;
    for (index, item) in fs::read_dir(directory).map_err(|_| pressure())?.enumerate() {
        if index >= limits.artifact_directories + 3 {
            return Err(pressure());
        }
        let item = item.map_err(|_| pressure())?;
        let name = item.file_name().into_string().map_err(|_| pressure())?;
        if name == "workspace.db" || name == "workspace.db-journal" || name == names.lock {
            continue;
        }
        let uuid = name
            .strip_prefix(&names.prepare_prefix)
            .or_else(|| name.strip_prefix(&names.retired_prefix))
            .ok_or_else(pressure)?;
        if !authority::uuid_valid(uuid) {
            return Err(pressure());
        }
        private_identity(&item.path(), true).map_err(|_| pressure())?;
        count += 1;
        if count >= limits.artifact_directories {
            return Err(pressure());
        }
        let mut files = BTreeSet::new();
        for (part_index, part) in fs::read_dir(item.path())
            .map_err(|_| pressure())?
            .enumerate()
        {
            if part_index >= limits.files_per_artifact {
                return Err(pressure());
            }
            let part = part.map_err(|_| pressure())?;
            let part_name = part.file_name().into_string().map_err(|_| pressure())?;
            let cap = if part_name == names.envelope {
                limits.envelope_bytes
            } else if part_name == names.before_body || part_name == names.after_body {
                body
            } else {
                return Err(pressure());
            };
            private_identity(&part.path(), false).map_err(|_| pressure())?;
            let length = part.metadata().map_err(|_| pressure())?.len();
            if length > cap || !files.insert(part_name) {
                return Err(pressure());
            }
            bytes = bytes.checked_add(length).ok_or_else(pressure)?;
        }
        if files.len() != limits.files_per_artifact {
            return Err(pressure());
        }
    }
    if bytes > limits.logical_artifact_bytes {
        return Err(pressure());
    }
    Ok(())
}

struct CheckedIntent {
    envelope: IntentEnvelope,
    before: Vec<u8>,
    after: Vec<u8>,
    directory: PathBuf,
    identity: FileIdentity,
}
impl CheckedIntent {
    fn validate_binding(
        &self,
        binding: &SelectedBinding,
        guard: &WorkspaceLock,
    ) -> Result<(), AuthorityError> {
        guard.validate().map_err(|_| conflict())?;
        let e = &self.envelope;
        if authority::selected_binding(&binding.root).map_err(|_| conflict())? != *binding
            || e.workspace_id != binding.workspace_id
            || Path::new(&e.body_root) != binding.root
            || Path::new(&e.database) != binding.database
            || e.database_identity != guard.database_identity
            || e.metadata_directory_identity != guard.parent_identity
            || e.lock_identity != guard.lock_identity
            || e.body_root_identity != root_identity(&binding.root)?
            || private_identity(&self.directory, true).map_err(|_| conflict())? != self.identity
        {
            return Err(conflict());
        }
        e.validate_values(&self.before, &self.after)
    }
    fn target_temp(&self, binding: &SelectedBinding) -> Result<PathBuf, AuthorityError> {
        let target = binding.root.join(&self.envelope.path);
        let parent = target.parent().ok_or_else(conflict)?;
        if parent.canonicalize().map_err(|_| conflict())? != parent {
            return Err(conflict());
        }
        Ok(parent.join(format!(
            "{}{}{}",
            pair_rules().names.target_temp_prefix,
            self.envelope.operation_id,
            pair_rules().names.target_temp_suffix
        )))
    }
}
fn root_identity(path: &Path) -> Result<FileIdentity, AuthorityError> {
    let meta = fs::symlink_metadata(path).map_err(|_| conflict())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(conflict());
    }
    Ok(file_identity(&meta))
}
fn load_intent(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
) -> Result<CheckedIntent, AuthorityError> {
    let directory = guard.directory.join(&pair_rules().names.pending);
    let identity = private_identity(&directory, true).map_err(|_| conflict())?;
    let mut names = BTreeSet::new();
    for (index, item) in fs::read_dir(&directory)
        .map_err(|_| conflict())?
        .enumerate()
    {
        if index >= pair_rules().limits.files_per_artifact {
            return Err(conflict());
        }
        names.insert(
            item.map_err(|_| conflict())?
                .file_name()
                .into_string()
                .map_err(|_| conflict())?,
        );
    }
    if names
        != BTreeSet::from([
            pair_rules().names.envelope.clone(),
            pair_rules().names.before_body.clone(),
            pair_rules().names.after_body.clone(),
        ])
    {
        return Err(conflict());
    }
    let source = read_private(
        &directory.join(&pair_rules().names.envelope),
        pair_rules().limits.envelope_bytes,
    )?;
    let shape: serde_json::Value = serde_json::from_slice(&source).map_err(|_| conflict())?;
    let fields = shape.as_object().ok_or_else(conflict)?;
    if fields.get("format").and_then(serde_json::Value::as_u64)
        != Some(u64::from(EDITOR_INTENT_FORMAT))
        && [
            "canonical_before_body_hash",
            "request_key",
            "recovery_disposition",
        ]
        .iter()
        .any(|key| fields.contains_key(*key))
    {
        return Err(conflict());
    }
    // Deserialize the original bytes, so duplicate fields remain an error.
    let envelope: IntentEnvelope = serde_json::from_slice(&source).map_err(|_| conflict())?;
    let before = read_private(
        &directory.join(&pair_rules().names.before_body),
        rules().limits.body_bytes,
    )?;
    let after = read_private(
        &directory.join(&pair_rules().names.after_body),
        rules().limits.body_bytes,
    )?;
    let intent = CheckedIntent {
        envelope,
        before,
        after,
        directory,
        identity,
    };
    intent.validate_binding(binding, guard)?;
    Ok(intent)
}

/// Complete preparation is the only object renamed into the active namespace.
/// On ordinary I/O failure delete only files whose exact created identities are
/// held in memory; stopped processes retain unpublished evidence for inspection.
fn publish_intent(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    envelope: IntentEnvelope,
    before: Vec<u8>,
    after: Vec<u8>,
    published: &mut bool,
) -> Result<CheckedIntent, AuthorityError> {
    envelope.validate_values(&before, &after)?;
    let bytes =
        serde_json::to_vec(&envelope).map_err(|_| invalid("Paired intent cannot be encoded."))?;
    if bytes.len() as u64 > pair_rules().limits.envelope_bytes {
        return Err(pressure());
    }
    let incoming = (bytes.len() as u64)
        .checked_add(before.len() as u64)
        .and_then(|n| n.checked_add(after.len() as u64))
        .and_then(|n| n.checked_add(before.len().max(after.len()) as u64))
        .ok_or_else(pressure)?;
    admit_artifacts(&guard.directory, incoming)?;
    no_pending(binding)?;
    let prepare = guard.directory.join(format!(
        "{}{}",
        pair_rules().names.prepare_prefix,
        envelope.operation_id
    ));
    create_private_directory(&prepare)?;
    let prepared_identity = private_identity(&prepare, true)?;
    let mut owned = Vec::new();
    let result = (|| {
        for (name, bytes) in [
            (&pair_rules().names.before_body, before.as_slice()),
            (&pair_rules().names.after_body, after.as_slice()),
            (&pair_rules().names.envelope, bytes.as_slice()),
        ] {
            let path = prepare.join(name);
            let identity = write_new(&path, bytes)?;
            owned.push((path, identity));
        }
        sync_directory(&prepare)?;
        guard.validate()?;
        no_pending(binding)?;
        let pending = guard.directory.join(&pair_rules().names.pending);
        // A failed namespace syscall is not proof that no publication happened.
        // The editor keeps the attempt unresolved from the rename attempt onward.
        *published = true;
        fs::rename(&prepare, &pending).map_err(|_| required())?;
        crate::crash::stop_point("selected-journal-renamed");
        #[cfg(test)]
        journal_path_hook("intent-published-before-sync", &pending);
        #[cfg(test)]
        if PUBLISHED_SYNC_FAILURE.with(|failure| failure.replace(false)) {
            return Err(required());
        }
        sync_directory(&guard.directory)?;
        crate::crash::stop_point("selected-journal-durable");
        load_intent(binding, guard)
    })();
    if result.is_err() && private_identity(&prepare, true).ok() == Some(prepared_identity) {
        for (path, identity) in owned {
            if private_identity(&path, false).ok() == Some(identity) {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_dir(&prepare);
        let _ = sync_directory(&guard.directory);
    }
    result
}

fn visible_image(
    binding: &SelectedBinding,
    intent: &CheckedIntent,
) -> Result<Vec<u8>, AuthorityError> {
    let bytes = authority::read_bounded(
        &binding.root,
        &intent.envelope.path,
        rules().limits.body_bytes,
    )
    .map_err(|_| conflict())?;
    if bytes != intent.before && bytes != intent.after {
        return Err(conflict());
    }
    Ok(bytes)
}
/// A complete exact temp is reusable; partial/unproven bytes are never deleted
/// based on the predictable UUID name. They produce an explicit conflict.
fn install_image(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    intent: &CheckedIntent,
    desired: &[u8],
    recovering: bool,
) -> Result<(), AuthorityError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    intent.validate_binding(binding, guard)?;
    let visible = visible_image(binding, intent)?;
    // Only recovery may reconcile either recorded image. A new human write
    // must still own the exact preimage even if an external writer happened to
    // install byte-identical intended output after admission.
    if !recovering && visible != intent.before {
        return Err(conflict());
    }
    let temp = intent.target_temp(binding)?;
    if !absent(&temp)? {
        let (existing, identity) = read_private_owned(&temp, rules().limits.body_bytes)?;
        #[cfg(test)]
        journal_path_hook("temp_read", &temp);
        if existing != intent.before && existing != intent.after {
            return Err(conflict());
        }
        // A complete temp is exact recorded evidence. Remove only that checked
        // inode before reusing the single reserved slot for the desired image.
        exact_private(&temp, identity, &existing)?;
        fs::remove_file(&temp).map_err(|_| required())?;
    }
    if visible == desired {
        return Ok(());
    }
    let identity = write_new(&temp, desired)?;
    #[cfg(test)]
    journal_path_hook("temp_written", &temp);
    exact_private(&temp, identity, desired)?;
    crate::crash::stop_point("selected-body-temp-durable");
    intent.validate_binding(binding, guard)?;
    if visible_image(binding, intent)? != visible {
        return Err(conflict());
    }
    exact_private(&temp, identity, desired)?;
    // Change permissions through the verified temp handle, not a name which
    // could now designate another file. This is never a second SQLite fd.
    let temp_file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)
        .map_err(|_| conflict())?;
    if file_identity(&temp_file.metadata().map_err(|_| conflict())?) != identity {
        return Err(conflict());
    }
    temp_file
        .set_permissions(fs::Permissions::from_mode(intent.envelope.body_permissions))
        .and_then(|_| temp_file.sync_all())
        .map_err(|_| required())?;
    // chmod restores the target's original plain mode, so the temp need not
    // remain private after it. Its validated inode must still be the same one.
    let named = fs::symlink_metadata(&temp).map_err(|_| conflict())?;
    if !named.is_file() || named.file_type().is_symlink() || file_identity(&named) != identity {
        return Err(conflict());
    }
    // Only an existing contained target may be replaced. Its parent must remain
    // canonical. No mkdir or missing-target adoption is performed here.
    let target = binding.root.join(&intent.envelope.path);
    let parent = target.parent().ok_or_else(conflict)?;
    if parent.canonicalize().map_err(|_| conflict())? != parent {
        return Err(conflict());
    }
    fs::rename(&temp, &target).map_err(|_| required())?;
    if recovering {
        crate::crash::stop_point(if desired == intent.before {
            "selected-recovery-old-renamed"
        } else {
            "selected-recovery-new-renamed"
        });
    } else {
        crate::crash::stop_point("selected-body-renamed");
    }
    sync_directory(parent)?;
    crate::crash::stop_point("selected-body-directory-synced");
    if visible_image(binding, intent)? != desired {
        return Err(conflict());
    }
    Ok(())
}
fn retire(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    intent: &CheckedIntent,
    desired: &[u8],
) -> Result<PathBuf, AuthorityError> {
    intent.validate_binding(binding, guard)?;
    // Publication follows both the durable metadata decision and an exact
    // fresh visible-image check, for normal commits and recovery alike.
    if visible_image(binding, intent)? != desired {
        return Err(conflict());
    }
    let retired = guard.directory.join(format!(
        "{}{}",
        pair_rules().names.retired_prefix,
        intent.envelope.operation_id
    ));
    if !absent(&retired)? {
        return Err(conflict());
    }
    fs::rename(&intent.directory, &retired).map_err(|_| required())?;
    sync_directory(&guard.directory)?;
    crate::crash::stop_point("selected-workspace-published");
    Ok(retired)
}
fn cleanup_retired(path: &Path, intent: &CheckedIntent) -> Result<(), AuthorityError> {
    if private_identity(path, true)? != intent.identity {
        return Err(conflict());
    }
    let expected = [
        (
            &pair_rules().names.envelope,
            serde_json::to_vec(&intent.envelope).map_err(|_| conflict())?,
        ),
        (&pair_rules().names.before_body, intent.before.clone()),
        (&pair_rules().names.after_body, intent.after.clone()),
    ];
    let mut owned = Vec::new();
    for (name, bytes) in expected {
        let part = path.join(name);
        let (observed, identity) = read_private_owned(&part, bytes.len() as u64)?;
        if observed != bytes {
            return Err(conflict());
        }
        #[cfg(test)]
        journal_path_hook("retired_read", &part);
        exact_private(&part, identity, &bytes)?;
        owned.push((part, identity, bytes));
    }
    for (part, identity, bytes) in owned {
        exact_private(&part, identity, &bytes)?;
        fs::remove_file(part).map_err(|_| required())?;
    }
    fs::remove_dir(path).map_err(|_| required())?;
    sync_directory(path.parent().ok_or_else(conflict)?)
}
fn apply_rows(conn: &Connection, e: &IntentEnvelope) -> Result<(), AuthorityError> {
    if schema_version(conn)? != e.selected_schema {
        return Err(conflict());
    }
    let changed = conn.execute("UPDATE records SET revision=?1,body_hash=?2 WHERE id=?3 AND path=?4 AND revision=?5 AND body_hash=?6 AND metadata=?7",
        rusqlite::params![e.after_revision,e.after_body.hash,e.record_id,e.path,e.before_revision,e.old_body_hash(),e.metadata_source])
        .map_err(|_| invalid("The paired record could not be staged."))?;
    if changed != 1 {
        return Err(error(
            AuthorityErrorKind::StaleMetadata,
            "The paired record changed.",
        ));
    }
    let changed = conn.execute("UPDATE workspace SET metadata_epoch=?1 WHERE singleton=1 AND workspace_id=?2 AND metadata_epoch=?3 AND schema_revision=?4",
        rusqlite::params![e.after_epoch,e.workspace_id,e.before_epoch,e.schema_revision])
        .map_err(|_| invalid("The paired epoch could not be staged."))?;
    if changed != 1 {
        return Err(error(
            AuthorityErrorKind::StaleMetadata,
            "The paired workspace changed.",
        ));
    }
    let r = &e.receipt;
    conn.execute("INSERT INTO metadata_receipts(epoch,record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![r.epoch,r.record_id,r.previous_revision,r.revision,r.metadata_before_hash,r.metadata_after_hash,r.actor,r.operation,r.at,r.body_before_hash,r.body_after_hash,r.run_id,r.approved_by])
        .map_err(|_| invalid("The original paired receipt could not be staged."))?;
    Ok(())
}
pub(super) fn expected_record(
    binding: &SelectedBinding,
    record: &Record,
    expected: &SelectedRecordVersion,
) -> Result<SelectedRecordVersion, AuthorityError> {
    let observed = record_version(binding, record);
    if expected.kind != observed.kind
        || expected.workspace_id != observed.workspace_id
        || expected.record_id != observed.record_id
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The canonical record identity changed.",
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
    if expected.body_hash != observed.body_hash {
        return Err(error(
            AuthorityErrorKind::SourceChanged,
            "The expected paired body changed.",
        ));
    }
    Ok(observed)
}
pub(super) fn binding_still(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    conn: &Connection,
) -> Result<(), AuthorityError> {
    guard.validate()?;
    sqlite_handle_unmoved(conn)?;
    private_database(binding)?;
    if authority::selected_binding(&binding.root)? != *binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The trusted workspace binding changed.",
        ));
    }
    Ok(())
}

pub(crate) fn replace_body(
    root: &Path,
    path: &str,
    expected: &SelectedRecordVersion,
    after: &[u8],
    by: &WriteReceipt<Human>,
) -> Result<SelectedBodyAck, AuthorityError> {
    replace_body_core(root, path, expected, after, by, None)
        .map(|ack| ack.pair)
        .map_err(|error| match error {
            ProtectedBodyError::Authority(error) => error,
            ProtectedBodyError::Retention(_) => required(),
        })
}
pub(crate) fn replace_body_with_recovery(
    root: &Path,
    path: &str,
    expected: &SelectedRecordVersion,
    after: &[u8],
    journal: &Journal,
    bypass: Option<&str>,
    by: &WriteReceipt<Human>,
) -> Result<ProtectedBodyAck, ProtectedBodyError> {
    replace_body_core(root, path, expected, after, by, Some((journal, bypass)))
}
fn replace_body_core(
    root: &Path,
    path: &str,
    expected: &SelectedRecordVersion,
    after: &[u8],
    by: &WriteReceipt<Human>,
    protection: Option<(&Journal, Option<&str>)>,
) -> Result<ProtectedBodyAck, ProtectedBodyError> {
    let binding = authority::selected_binding(root)?;
    let guard = read_guard(&binding)?;
    // Unsupported v2 refuses before opening mutable SQLite or touching a file.
    let read = connection(&binding, false)?;
    if !metadata::paired_schema(schema_version(&read)?) {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Paired body changes require selected schema 3.",
        )
        .into());
    }
    drop(read);
    let guard = guard.ok_or_else(|| missing("This paired workspace has no trusted lock."))?;
    replace_body_locked(
        root,
        &binding,
        &guard,
        LockedBodyRequest {
            path,
            admission: BodyAdmission::Checked(expected),
            after,
            by,
            protection,
        },
    )
    .map_err(BodyCoreError::protected)
}
#[derive(Clone, Copy)]
enum BodyAdmission<'a> {
    Checked(&'a SelectedRecordVersion),
    Editor(&'a EditorSaveRequest),
}
struct LockedBodyRequest<'a> {
    path: &'a str,
    admission: BodyAdmission<'a>,
    after: &'a [u8],
    by: &'a WriteReceipt<Human>,
    protection: Option<(&'a Journal, Option<&'a str>)>,
}
#[derive(Debug)]
enum BodyCoreError {
    Refused(ProtectedBodyError),
    Pending {
        operation: Box<EditorOperation>,
        error: AuthorityError,
    },
}
impl From<AuthorityError> for BodyCoreError {
    fn from(error: AuthorityError) -> Self {
        Self::Refused(error.into())
    }
}
impl From<ProtectedBodyError> for BodyCoreError {
    fn from(error: ProtectedBodyError) -> Self {
        Self::Refused(error)
    }
}
impl BodyCoreError {
    fn protected(self) -> ProtectedBodyError {
        match self {
            Self::Refused(e) => e,
            Self::Pending { error, .. } => error.into(),
        }
    }
    fn after_publication(operation: Option<&EditorOperation>, error: AuthorityError) -> Self {
        match operation {
            Some(operation) => Self::Pending {
                operation: Box::new(operation.clone()),
                error,
            },
            None => error.into(),
        }
    }
}
fn replace_body_locked(
    root: &Path,
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    request: LockedBodyRequest<'_>,
) -> Result<ProtectedBodyAck, BodyCoreError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let LockedBodyRequest {
        path,
        admission,
        after,
        by,
        protection,
    } = request;
    let path_guard = crate::vault::write::lock_selected_path(root, path).map_err(|_| {
        error(
            AuthorityErrorKind::UnsupportedOperation,
            "The selected path is unavailable.",
        )
    })?;
    if after.len() as u64 > rules().limits.body_bytes || std::str::from_utf8(after).is_err() {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "The replacement body exceeds the supported UTF-8 bound.",
        )
        .into());
    }
    let mut conn = connection(binding, true)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| invalid("Full synchronization is unavailable."))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|_| invalid("Foreign key validation is unavailable."))?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| error(AuthorityErrorKind::Busy, "Canonical metadata is busy."))?;
    binding_still(binding, guard, &tx)?;
    let snapshot = read_snapshot(&tx, binding)?;
    let record = snapshot
        .records
        .iter()
        .find(|r| r.path == path)
        .ok_or_else(|| missing("The canonical record is unavailable."))?;
    let observed = match admission {
        BodyAdmission::Checked(expected) => expected_record(binding, record, expected)?,
        BodyAdmission::Editor(request) => {
            // General editor saves retain their current locked-version winner
            // rule. Dependent body transforms additionally pin the complete
            // canonical version under these same workspace/path/SQL locks.
            editor_target(binding, record, &request.target)?;
            if let Some(expected) = &request.expected_version {
                expected_record(binding, record, expected)?
            } else {
                record_version(binding, record)
            }
        }
    };
    ordinary_body_target(binding, &snapshot, record)?;
    let before = match admission {
        BodyAdmission::Checked(_) => body(binding, record, rules().limits.body_bytes)?.into_bytes(),
        BodyAdmission::Editor(_) => observed_body(binding, path)?,
    };
    let before_hash = crate::ledger::sha256_hex(&before);
    if matches!(admission, BodyAdmission::Editor(request) if request.expected_version.as_ref().is_some_and(|expected| expected.body_hash != before_hash))
    {
        return Err(error(
            AuthorityErrorKind::SourceChanged,
            "The visible task body changed since its checked snapshot.",
        )
        .into());
    }
    if before == after && before_hash == record.body_hash {
        if protection
            .as_ref()
            .is_some_and(|(_, bypass)| bypass.is_some())
        {
            return Err(ProtectedBodyError::Retention("recovery_bypass_invalid".into()).into());
        }
        return Ok(ProtectedBodyAck {
            pair: SelectedBodyAck::Unchanged { version: observed },
            recovery: CopyOutcome::NotRetained {
                reason: "unchanged".into(),
            },
        });
    }
    check_pairing(binding, &snapshot)?;
    let mut aggregate = 0usize;
    for candidate in &snapshot.records {
        let length = if candidate.id == record.id {
            after.len()
        } else {
            match admission {
                BodyAdmission::Checked(_) => {
                    body(binding, candidate, rules().limits.body_bytes)?.len()
                }
                BodyAdmission::Editor(_) => {
                    let (bytes, _) = observed_record_body(binding, &snapshot, candidate)?;
                    bytes.len()
                }
            }
        };
        aggregate = aggregate
            .checked_add(length)
            .filter(|n| *n <= rules().limits.aggregate_body_bytes)
            .ok_or_else(|| {
                error(
                    AuthorityErrorKind::SourceLimit,
                    "Page bodies exceed their aggregate bound.",
                )
            })?;
    }
    let revision = record.revision.checked_add(1).ok_or_else(|| {
        error(
            AuthorityErrorKind::SourceLimit,
            "The record revision is exhausted.",
        )
    })?;
    let epoch = snapshot.epoch.checked_add(1).ok_or_else(|| {
        error(
            AuthorityErrorKind::SourceLimit,
            "The workspace epoch is exhausted.",
        )
    })?;
    let target_meta = fs::symlink_metadata(binding.root.join(path))
        .map_err(|_| missing("The target body is unavailable."))?;
    if !target_meta.is_file() || target_meta.nlink() != 1 || target_meta.file_type().is_symlink() {
        return Err(conflict().into());
    }
    let after_hash = crate::ledger::sha256_hex(after);
    let receipt = OriginalReceipt {
        workspace_id: binding.workspace_id.clone(),
        epoch,
        record_id: record.id.clone(),
        previous_revision: record.revision,
        revision,
        metadata_before_hash: observed.metadata_hash.clone(),
        metadata_after_hash: observed.metadata_hash.clone(),
        body_before_hash: before_hash.clone(),
        body_after_hash: after_hash.clone(),
        actor: by.actor().into(),
        run_id: by.run_id().map(str::to_owned),
        approved_by: by.approved_by().map(str::to_owned),
        operation: pair_rules().operation.clone(),
        at: chrono::Utc::now().to_rfc3339(),
    };
    let mut envelope = IntentEnvelope {
        format: if matches!(admission, BodyAdmission::Editor(_)) {
            EDITOR_INTENT_FORMAT
        } else if protection.is_some() {
            pair_rules().version
        } else {
            1
        },
        operation_id: crate::workspace_migration::identity::mint_uuid_v4(),
        workspace_id: binding.workspace_id.clone(),
        body_root: binding
            .root
            .to_str()
            .ok_or_else(|| invalid("Body root is not UTF-8."))?
            .into(),
        database: binding
            .database
            .to_str()
            .ok_or_else(|| invalid("Metadata path is not UTF-8."))?
            .into(),
        body_root_identity: root_identity(&binding.root)?,
        metadata_directory_identity: guard.parent_identity,
        database_identity: guard.database_identity,
        lock_identity: guard.lock_identity,
        selected_schema: schema_version(&tx)?,
        record_id: record.id.clone(),
        path: path.into(),
        schema_revision: snapshot.schema_revision,
        before_revision: record.revision,
        after_revision: revision,
        before_epoch: snapshot.epoch,
        after_epoch: epoch,
        metadata_source: record.metadata_source.clone(),
        metadata_hash: observed.metadata_hash.clone(),
        before_body: BodyPart {
            name: pair_rules().names.before_body.clone(),
            length: before.len() as u64,
            hash: before_hash,
        },
        after_body: BodyPart {
            name: pair_rules().names.after_body.clone(),
            length: after.len() as u64,
            hash: after_hash.clone(),
        },
        body_permissions: target_meta.permissions().mode() & 0o777,
        receipt,
        retained_copy: None,
        canonical_before_body_hash: matches!(admission, BodyAdmission::Editor(_))
            .then(|| record.body_hash.clone()),
        request_key: match admission {
            BodyAdmission::Editor(r) => Some(r.request_key.clone()),
            BodyAdmission::Checked(_) => None,
        },
        recovery_disposition: matches!(admission, BodyAdmission::Editor(_))
            .then_some(EditorRecoveryDisposition::CompleteOriginal),
    };
    envelope.validate_values(&before, after)?;
    tx.execute_batch("SAVEPOINT paired_capacity")
        .map_err(|_| invalid("Capacity trial could not start."))?;
    let trial = apply_rows(&tx, &envelope).and_then(|_| page_budget(&tx, binding));
    tx.execute_batch("ROLLBACK TO paired_capacity; RELEASE paired_capacity")
        .map_err(|_| invalid("Capacity trial could not roll back."))?;
    trial?;
    binding_still(binding, guard, &tx)?;
    let captured = if let Some((journal, bypass)) = protection {
        let mut identity = CaptureIdentity {
            envelope: &mut envelope,
        };
        journal
            .prepare_selected(
                SelectedCaptureRequest {
                    lock: &path_guard,
                    vault: root,
                    path,
                    current: std::str::from_utf8(&before).map_err(|_| conflict())?,
                    content: std::str::from_utf8(after).map_err(|_| conflict())?,
                    bypass,
                    expected: &observed,
                },
                &mut identity,
            )
            .map_err(ProtectedBodyError::Retention)?
    } else {
        CopyOutcome::Off
    };
    envelope.validate_values(&before, after)?;
    binding_still(binding, guard, &tx)?;
    // From durable intent publication onward ordinary errors cannot claim that
    // no visible work occurred. The entire evidence remains available to reopen.
    let operation = envelope.editor_operation();
    let mut published = false;
    let intent = publish_intent(
        binding,
        guard,
        envelope,
        before,
        after.to_vec(),
        &mut published,
    )
    .map_err(|error| {
        if published {
            BodyCoreError::after_publication(operation.as_ref(), error)
        } else {
            error.into()
        }
    })?;
    #[cfg(test)]
    before_install();
    let staged: Result<(), AuthorityError> = (|| {
        install_image(binding, guard, &intent, &intent.after, false)?;
        apply_rows(&tx, &intent.envelope)?;
        page_budget(&tx, binding)?;
        crate::crash::stop_point("selected-receipt-staged");
        binding_still(binding, guard, &tx)?;
        if visible_image(binding, &intent)? != intent.after {
            return Err(conflict());
        }
        Ok(())
    })();
    staged.map_err(|e| {
        BodyCoreError::after_publication(
            operation.as_ref(),
            if e.kind == AuthorityErrorKind::RecoveryConflict {
                e
            } else {
                required()
            },
        )
    })?;
    tx.commit()
        .map_err(|_| BodyCoreError::after_publication(operation.as_ref(), required()))?;
    #[cfg(test)]
    after_commit();
    crate::crash::stop_point("selected-metadata-committed");
    let work: Result<ProtectedBodyAck, AuthorityError> = (|| {
        binding_still(binding, guard, &conn)?;
        if database_state(&conn, binding, &intent.envelope)? != PairState::New {
            return Err(conflict());
        }
        let retired = retire(binding, guard, &intent, &intent.after)?;
        crate::crash::stop_point("selected-retention-new-retired");
        let recovery = if let (Some((journal, _)), Some(reference)) =
            (protection, &intent.envelope.retained_copy)
        {
            let join = intent.envelope.retention_join()?;
            let settlement = SelectedSettlement {
                lock: &path_guard,
                vault: root,
                path,
                reference,
                join: &join,
                before: &intent.before,
                after_hash: &intent.envelope.after_body.hash,
            };
            if journal.commit_selected(&settlement).is_err() {
                match captured {
                    CopyOutcome::Retained { id, evicted } => CopyOutcome::Pending { id, evicted },
                    other => other,
                }
            } else {
                captured
            }
        } else {
            captured
        };
        let _ = cleanup_retired(&retired, &intent);
        Ok(ProtectedBodyAck {
            pair: SelectedBodyAck::Applied {
                version: SelectedRecordVersion {
                    metadata_revision: revision.to_string(),
                    body_hash: after_hash,
                    ..observed
                },
                epoch: epoch.to_string(),
                operation_id: intent.envelope.operation_id.clone(),
                receipt: Box::new(intent.envelope.receipt.clone()),
            },
            recovery,
        })
    })();
    work.map_err(|e| {
        BodyCoreError::after_publication(
            operation.as_ref(),
            if e.kind == AuthorityErrorKind::RecoveryConflict {
                e
            } else {
                required()
            },
        )
    })
}

#[derive(Debug, PartialEq, Eq)]
enum PairState {
    Old,
    New,
}
fn database_state(
    conn: &Connection,
    binding: &SelectedBinding,
    e: &IntentEnvelope,
) -> Result<PairState, AuthorityError> {
    if schema_version(conn)? != e.selected_schema {
        return Err(conflict());
    }
    let snapshot = read_snapshot(conn, binding).map_err(|_| conflict())?;
    let row = snapshot
        .records
        .iter()
        .find(|r| r.id == e.record_id)
        .ok_or_else(conflict)?;
    if snapshot.schema_revision != e.schema_revision
        || row.path != e.path
        || row.metadata_source != e.metadata_source
    {
        return Err(conflict());
    }
    let receipt = conn.query_row("SELECT record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by FROM metadata_receipts WHERE epoch=?1",
        [e.after_epoch], |r| Ok(OriginalReceipt {
            workspace_id: binding.workspace_id.clone(), epoch: e.after_epoch, record_id: r.get(0)?, previous_revision: r.get(1)?, revision: r.get(2)?,
            metadata_before_hash: r.get(3)?, metadata_after_hash: r.get(4)?, actor: r.get(5)?, operation: r.get(6)?, at: r.get(7)?,
            body_before_hash: r.get(8)?, body_after_hash: r.get(9)?, run_id: r.get(10)?, approved_by: r.get(11)?,
        })).optional().map_err(|_| conflict())?;
    if snapshot.epoch == e.before_epoch
        && row.revision == e.before_revision
        && row.body_hash == e.old_body_hash()
        && receipt.is_none()
    {
        Ok(PairState::Old)
    } else if snapshot.epoch == e.after_epoch
        && row.revision == e.after_revision
        && row.body_hash == e.after_body.hash
        && receipt.as_ref() == Some(&e.receipt)
    {
        Ok(PairState::New)
    } else {
        Err(conflict())
    }
}

/// Startup and explicit recovery share exact version dispatch. A supported v2
/// store without pending evidence is a no-op; this never initializes or upgrades.
pub(crate) fn recover_workspace(root: &Path) -> Result<RecoveryReport, AuthorityError> {
    recover_workspace_core(root, None)
}
pub(crate) fn recover_workspace_with_retention(
    root: &Path,
    journal: &Journal,
) -> Result<RecoveryReport, AuthorityError> {
    recover_workspace_core(root, Some(journal))
}
fn recover_workspace_core(
    root: &Path,
    journal: Option<&Journal>,
) -> Result<RecoveryReport, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    let directory = binding
        .database
        .parent()
        .ok_or_else(|| invalid("Canonical metadata has no private parent."))?;
    let lock = directory.join(&pair_rules().names.lock);
    match fs::symlink_metadata(&lock) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // v2 historically has no selected.lock. Inspect without creating,
            // chmodding, upgrading, or opening a writable SQLite connection.
            no_pending(&binding)?;
            let conn = connection(&binding, false)?;
            if schema_version(&conn)? != rules().schema_version {
                return Err(missing("This paired workspace has no trusted lock."));
            }
            sqlite_handle_unmoved(&conn)?;
            private_database(&binding)?;
            no_pending(&binding)?;
            if authority::selected_binding(&binding.root)? != binding {
                return Err(error(
                    AuthorityErrorKind::WrongIdentity,
                    "The trusted workspace binding changed.",
                ));
            }
            return Ok(RecoveryReport::Clean);
        }
        Err(_) => return Err(missing("The existing workspace lock is unavailable.")),
        Ok(_) => {}
    }
    let guard = WorkspaceLock::acquire(&binding)?;
    // SQLite may roll back its own hot journal here. This is existing-only
    // engine recovery, not new application rows, receipt, schema or publication.
    let conn = connection(&binding, true)?;
    binding_still(&binding, &guard, &conn)?;
    match schema_version(&conn)? {
        version if version == rules().schema_version => {
            no_pending(&binding)?;
            Ok(RecoveryReport::Clean)
        }
        version if metadata::paired_schema(version) => {
            recover_bound(&binding, &guard, &conn, journal)
        }
        _ => Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Canonical store schema version is unsupported.",
        )),
    }
}

// The same original lock and actual SQLite handle remain alive throughout.
// Never call public recovery recursively or take a second lock-file descriptor.
fn recover_bound(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    conn: &Connection,
    journal: Option<&Journal>,
) -> Result<RecoveryReport, AuthorityError> {
    recover_bound_with_outcome(binding, guard, conn, journal).map(|(report, _)| report)
}
fn recover_bound_with_outcome(
    binding: &SelectedBinding,
    guard: &WorkspaceLock,
    conn: &Connection,
    journal: Option<&Journal>,
) -> Result<(RecoveryReport, Option<EditorRecoveryView>), AuthorityError> {
    binding_still(binding, guard, conn)?;
    if absent(&guard.directory.join(&pair_rules().names.pending))? {
        return Ok((RecoveryReport::Clean, None));
    }
    let intent = load_intent(binding, guard)?;
    let path_guard = crate::vault::write::lock_selected_path(&binding.root, &intent.envelope.path)
        .map_err(|_| conflict())?;
    let mut state = database_state(conn, binding, &intent.envelope)?;
    let joined = intent
        .envelope
        .retained_copy
        .as_ref()
        .map(|reference| {
            let journal = journal.ok_or_else(required)?;
            let join = intent.envelope.retention_join()?;
            let settlement = SelectedSettlement {
                lock: &path_guard,
                vault: &binding.root,
                path: &intent.envelope.path,
                reference,
                join: &join,
                before: &intent.before,
                after_hash: &intent.envelope.after_body.hash,
            };
            // Both supported unsettled states require the exact pending row. No
            // committed-row eviction or expiry inference can substitute for it.
            if state == PairState::Old {
                journal.verify_selected_rollback(&settlement)
            } else {
                journal.verify_selected_commit(&settlement)
            }
            .map_err(retention_error)?;
            Ok::<_, AuthorityError>((journal, join))
        })
        .transpose()?;
    visible_image(binding, &intent)?;
    if intent.envelope.format == EDITOR_INTENT_FORMAT {
        let snapshot = read_snapshot(conn, binding)?;
        let record = snapshot
            .records
            .iter()
            .find(|r| r.id == intent.envelope.record_id)
            .ok_or_else(conflict)?;
        ordinary_body_target(binding, &snapshot, record)?;
        if state == PairState::Old {
            conn.pragma_update(None, "synchronous", "FULL")
                .map_err(|_| required())?;
            conn.pragma_update(None, "foreign_keys", true)
                .map_err(|_| required())?;
            // The actual verified handle stays alive. This recovery function
            // owns no SQL transaction on entry; the checked constructor refuses
            // nesting and RAII rolls every refused trial/final transaction back.
            let tx = rusqlite::Transaction::new_unchecked(
                conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(|_| error(AuthorityErrorKind::Busy, "Canonical metadata is busy."))?;
            binding_still(binding, guard, &tx)?;
            if database_state(&tx, binding, &intent.envelope)? != PairState::Old {
                return Err(conflict());
            }
            tx.execute_batch("SAVEPOINT paired_capacity")
                .map_err(|_| required())?;
            let trial = apply_rows(&tx, &intent.envelope).and_then(|_| page_budget(&tx, binding));
            tx.execute_batch("ROLLBACK TO paired_capacity; RELEASE paired_capacity")
                .map_err(|_| required())?;
            trial?;
            visible_image(binding, &intent)?;
            install_image(binding, guard, &intent, &intent.after, true)?;
            apply_rows(&tx, &intent.envelope)?;
            page_budget(&tx, binding)?;
            crate::crash::stop_point("selected-editor-redo-receipt-staged");
            binding_still(binding, guard, &tx)?;
            if visible_image(binding, &intent)? != intent.after {
                return Err(conflict());
            }
            tx.commit().map_err(|_| required())?;
            crate::crash::stop_point("selected-editor-redo-metadata-committed");
            if database_state(conn, binding, &intent.envelope)? != PairState::New {
                return Err(conflict());
            }
            state = PairState::New;
        }
    }
    let desired = if state == PairState::Old {
        &intent.before
    } else {
        &intent.after
    };
    install_image(binding, guard, &intent, desired, true)?;
    binding_still(binding, guard, conn)?;
    if database_state(conn, binding, &intent.envelope)? != state {
        return Err(conflict());
    }
    let retired = retire(binding, guard, &intent, desired)?;
    crate::crash::stop_point(if state == PairState::Old {
        "selected-retention-old-retired"
    } else {
        "selected-retention-new-retired"
    });
    let mut outcome = None;
    if let (Some((journal, join)), Some(reference)) = (&joined, &intent.envelope.retained_copy) {
        let settlement = SelectedSettlement {
            lock: &path_guard,
            vault: &binding.root,
            path: &intent.envelope.path,
            reference,
            join,
            before: &intent.before,
            after_hash: &intent.envelope.after_body.hash,
        };
        // Retirement first preserves a coherent reopen even if the optional
        // retained-copy service becomes unavailable. No false committed claim.
        // The original capture count was not persisted; recovery cannot report zero.
        if state == PairState::Old {
            let _ = journal.discard_selected_rollback(&settlement);
        } else {
            outcome = Some(if journal.commit_selected(&settlement).is_ok() {
                EditorRecoveryView::Retained {
                    id: reference.id.clone(),
                    evicted: None,
                }
            } else {
                EditorRecoveryView::Pending {
                    id: reference.id.clone(),
                    evicted: None,
                }
            });
        }
    }
    let _ = cleanup_retired(&retired, &intent);
    let operation_id = intent.envelope.operation_id.clone();
    let receipt = intent.envelope.receipt.clone();
    Ok((
        if state == PairState::Old {
            RecoveryReport::RolledBack {
                operation_id,
                receipt,
            }
        } else {
            RecoveryReport::Completed {
                operation_id,
                receipt,
            }
        },
        outcome,
    ))
}

// The editor target is stable identity, not a stale metadata/body expectation.
pub(super) fn editor_target(
    binding: &SelectedBinding,
    record: &Record,
    target: &SelectedEditorTarget,
) -> Result<SelectedRecordVersion, AuthorityError> {
    if !authority::uuid_valid(&target.workspace_id)
        || !authority::uuid_valid(&target.record_id)
        || target.workspace_id != binding.workspace_id
        || target.record_id != record.id
    {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The retained editor target changed identity.",
        ));
    }
    Ok(record_version(binding, record))
}
/// Retain the identity of the actual opened body handle through the bounded
/// read. This opens no additional SQLite fd and requires no private file mode.
pub(super) fn observed_body(
    binding: &SelectedBinding,
    path: &str,
) -> Result<Vec<u8>, AuthorityError> {
    use std::os::unix::fs::MetadataExt;
    let opened = crate::files::bytes::open_in(&binding.root, "selected-editor", path)
        .map_err(|_| conflict())?;
    if opened.path != binding.root.join(path) {
        return Err(conflict());
    }
    let mut file = opened.file;
    let before = file.metadata().map_err(|_| conflict())?;
    if !before.is_file() || before.nlink() != 1 || before.len() > rules().limits.body_bytes {
        return Err(conflict());
    }
    let identity = file_identity(&before);
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(rules().limits.body_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| conflict())?;
    let after = file.metadata().map_err(|_| conflict())?;
    let named = fs::symlink_metadata(&opened.path).map_err(|_| conflict())?;
    if named.file_type().is_symlink()
        || named.nlink() != 1
        || file_identity(&named) != identity
        || file_identity(&after) != identity
        || before.len() != bytes.len() as u64
        || after.len() != before.len()
        || before.modified().ok() != after.modified().ok()
        || bytes.len() as u64 > rules().limits.body_bytes
        || std::str::from_utf8(&bytes).is_err()
    {
        return Err(conflict());
    }
    Ok(bytes)
}
/// Only ordinary, independently classified records may be observed outside
/// their canonical pairing. Protected records and Type dependencies keep their
/// existing strict body checks. This helper never writes or returns authority.
fn observed_record_body(
    binding: &SelectedBinding,
    snapshot: &Snapshot,
    record: &Record,
) -> Result<(Vec<u8>, SelectedBodyObservation), AuthorityError> {
    let bytes = observed_body(binding, &record.path)?;
    let observed_body_hash = crate::ledger::sha256_hex(&bytes);
    let coherence = if observed_body_hash == record.body_hash {
        EditorBodyCoherence::Paired
    } else {
        ordinary_body_target(binding, snapshot, record)?;
        EditorBodyCoherence::ExternalChange
    };
    Ok((
        bytes,
        SelectedBodyObservation {
            coherence,
            observed_body_hash,
        },
    ))
}

/// Complete human presentation only. One existing workspace lock and the actual
/// checked SQLite handle remain held through classification and final binding
/// validation. A read never repairs a canonical hash or creates an operation.
pub(super) fn scan_presentation(binding: &SelectedBinding) -> Result<Vec<Entry>, AuthorityError> {
    let guard = read_guard(binding)?;
    let conn = connection(binding, false)?;
    if schema_version(&conn)? == rules().schema_version {
        // v2 is unchanged; close this handle before the existing strict reader.
        drop(conn);
        return scan_filtered_bound(binding, |_| true);
    }
    let guard = guard.ok_or_else(|| missing("This paired workspace has no trusted lock."))?;
    binding_still(binding, &guard, &conn)?;
    let snapshot = read_snapshot(&conn, binding)?;
    check_pairing(binding, &snapshot)?;
    let mut entries = Vec::new();
    let mut aggregate = 0usize;
    for record in &snapshot.records {
        let (bytes, observation) = observed_record_body(binding, &snapshot, record)?;
        aggregate = aggregate
            .checked_add(bytes.len())
            .filter(|length| *length <= rules().limits.aggregate_body_bytes)
            .ok_or_else(|| {
                error(
                    AuthorityErrorKind::SourceLimit,
                    "Page bodies exceed their aggregate bound.",
                )
            })?;
        let body = std::str::from_utf8(&bytes).map_err(|_| conflict())?;
        let mut row = entry(binding, record, body)?;
        row.hash = Some(observation.observed_body_hash.clone());
        row.body_observation = Some(observation);
        entries.push(row);
    }
    crate::vault::scan::assign_projects(&mut entries);
    binding_still(binding, &guard, &conn)?;
    no_pending(binding)?;
    Ok(entries)
}

pub(super) fn read_editor_snapshot(
    root: &Path,
    path: &str,
    target: &SelectedEditorTarget,
) -> Result<SelectedEditorSnapshot, AuthorityError> {
    if path.len() > rules().limits.path_bytes
        || crate::files::bytes::rel_refusal("selected-editor", path).is_some()
        || !authority::uuid_valid(&target.workspace_id)
        || !authority::uuid_valid(&target.record_id)
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "The selected editor locator is invalid.",
        ));
    }
    let binding = authority::selected_binding(root)?;
    let guard = read_guard(&binding)?;
    let conn = connection(&binding, false)?;
    if !metadata::paired_schema(schema_version(&conn)?) {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "The editor body snapshot requires selected schema 3.",
        ));
    }
    let guard = guard.ok_or_else(|| missing("This paired workspace has no trusted lock."))?;
    let _path_guard =
        crate::vault::write::lock_selected_path(&binding.root, path).map_err(|_| conflict())?;
    binding_still(&binding, &guard, &conn)?;
    let snapshot = read_snapshot(&conn, &binding)?;
    let record = snapshot
        .records
        .iter()
        .find(|r| r.path == path)
        .ok_or_else(|| missing("The canonical record is unavailable."))?;
    let version = editor_target(&binding, record, target)?;
    let read_only_reason = match ordinary_body_target(&binding, &snapshot, record) {
        Ok(()) => None,
        Err(e) if e.kind == AuthorityErrorKind::UnsupportedOperation => Some(e.message),
        Err(e) => return Err(e),
    };
    let bytes = observed_body(&binding, path)?;
    let observed_body_hash = crate::ledger::sha256_hex(&bytes);
    binding_still(&binding, &guard, &conn)?;
    no_pending(&binding)?;
    Ok(SelectedEditorSnapshot {
        target: target.clone(),
        path: path.into(),
        coherence: if observed_body_hash == record.body_hash {
            EditorBodyCoherence::Paired
        } else {
            EditorBodyCoherence::ExternalChange
        },
        version,
        body: String::from_utf8(bytes).map_err(|_| conflict())?,
        observed_body_hash,
        editable: read_only_reason.is_none(),
        read_only_reason,
    })
}
fn request_valid(
    path: &str,
    after: &[u8],
    request: &EditorSaveRequest,
) -> Result<(), AuthorityError> {
    if !authority::uuid_valid(&request.request_key)
        || !authority::uuid_valid(&request.target.workspace_id)
        || !authority::uuid_valid(&request.target.record_id)
        || request.target.workspace_id == request.target.record_id
        || path.len() > rules().limits.path_bytes
        || crate::files::bytes::rel_refusal("selected-editor", path).is_some()
        || after.len() as u64 > rules().limits.body_bytes
        || std::str::from_utf8(after).is_err()
        || (request.phase == EditorSavePhase::Start && request.original.is_some())
    {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "The selected editor attempt is invalid.",
        ));
    }
    if let Some(original) = &request.original {
        let r = &original.receipt;
        if original.target != request.target
            || original.request_key != request.request_key
            || original.path != path
            || !authority::uuid_valid(&original.operation_id)
            || original.version.workspace_id != request.target.workspace_id
            || original.version.record_id != request.target.record_id
            || !hash_valid(&original.version.metadata_hash)
            || !hash_valid(&original.version.body_hash)
            || original.version.body_hash != crate::ledger::sha256_hex(after)
            || r.workspace_id != request.target.workspace_id
            || r.record_id != request.target.record_id
            || r.actor != crate::vault::receipt::HUMAN_ACTOR
            || r.run_id.is_some()
            || r.approved_by.is_some()
            || r.operation != pair_rules().operation
            || r.at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&r.at).is_err()
            || !hash_valid(&r.metadata_before_hash)
            || !hash_valid(&r.metadata_after_hash)
            || !hash_valid(&r.body_before_hash)
            || !hash_valid(&r.body_after_hash)
            || r.metadata_before_hash != r.metadata_after_hash
            || r.metadata_after_hash != original.version.metadata_hash
            || r.body_after_hash != original.version.body_hash
            || r.revision != original.version.metadata_revision
        {
            return Err(conflict());
        }
        let previous = editor_counter(&r.previous_revision)?;
        let revision = editor_counter(&r.revision)?;
        editor_counter(&r.epoch)?;
        if previous.checked_add(1) != Some(revision) {
            return Err(conflict());
        }
    }
    Ok(())
}
fn editor_counter(value: &str) -> Result<i64, AuthorityError> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(conflict());
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(conflict)
}
fn recorded_receipt(
    conn: &Connection,
    binding: &SelectedBinding,
    epoch: i64,
) -> Result<Option<OriginalReceipt>, AuthorityError> {
    let mut query=conn.prepare("SELECT record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by FROM metadata_receipts WHERE epoch=?1").map_err(|_|conflict())?;
    let mut rows = query.query([epoch]).map_err(|_| conflict())?;
    let Some(row) = rows.next().map_err(|_| conflict())? else {
        return Ok(None);
    };
    decode_receipt_row(row, &binding.workspace_id, epoch).map(Some)
}

// The replay reader and passive portable reader share this bounded row codec.
pub(super) fn decode_receipt_row(
    row: &Row<'_>,
    workspace: &str,
    epoch: i64,
) -> Result<OriginalReceipt, AuthorityError> {
    if !matches!(row.get_ref(10).map_err(|_| conflict())?, ValueRef::Null)
        || !matches!(row.get_ref(11).map_err(|_| conflict())?, ValueRef::Null)
    {
        return Err(conflict());
    }
    let run_id = None;
    let approved_by = None;
    Ok(OriginalReceipt {
        workspace_id: workspace.to_owned(),
        epoch,
        record_id: text(row, 0, 36)?,
        previous_revision: row.get(1).map_err(|_| conflict())?,
        revision: row.get(2).map_err(|_| conflict())?,
        metadata_before_hash: text(row, 3, 64)?,
        metadata_after_hash: text(row, 4, 64)?,
        actor: text(row, 5, 128)?,
        operation: text(row, 6, 64)?,
        at: text(row, 7, 64)?,
        body_before_hash: text(row, 8, 64)?,
        body_after_hash: text(row, 9, 64)?,
        run_id,
        approved_by,
    })
}
/// Checks persisted canonical receipt shapes without constructing an intent,
/// replaying a write or requiring unavailable historical before-images.
pub(super) fn validate_receipts(
    conn: &Connection,
    workspace: &str,
    snapshot: &Snapshot,
) -> Result<(), AuthorityError> {
    let records: BTreeMap<_, _> = snapshot
        .records
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect();
    // Stream rows from the already bounded database. No receipt history vector
    // is materialized and every text field uses the replay decoder's limits.
    let mut query = conn.prepare("SELECT record_id,previous_revision,revision,metadata_before_hash,metadata_after_hash,actor,operation,at,body_before_hash,body_after_hash,run_id,approved_by,epoch FROM metadata_receipts ORDER BY epoch")
        .map_err(|_| invalid("Canonical receipts are unreadable."))?;
    let mut rows = query
        .query([])
        .map_err(|_| invalid("Canonical receipts are unreadable."))?;
    while let Some(row) = rows
        .next()
        .map_err(|_| invalid("Canonical receipts are unreadable."))?
    {
        let epoch: i64 = row
            .get(12)
            .map_err(|_| invalid("Canonical receipt epoch is invalid."))?;
        let receipt = decode_receipt_row(row, workspace, epoch)
            .map_err(|_| invalid("Canonical receipt shape is unsupported."))?;
        let record = records
            .get(receipt.record_id.as_str())
            .ok_or_else(|| invalid("Canonical receipt names no current record."))?;
        if !authority::uuid_valid(&receipt.record_id)
            || receipt.epoch < 1
            || receipt.epoch > snapshot.epoch
            || receipt.previous_revision < 1
            || receipt.previous_revision.checked_add(1) != Some(receipt.revision)
            || receipt.revision > record.revision
            || !hash_valid(&receipt.metadata_before_hash)
            || !hash_valid(&receipt.metadata_after_hash)
            || !hash_valid(&receipt.body_before_hash)
            || !hash_valid(&receipt.body_after_hash)
            || receipt.actor != crate::vault::receipt::HUMAN_ACTOR
            || receipt.run_id.is_some()
            || receipt.approved_by.is_some()
            || chrono::DateTime::parse_from_rfc3339(&receipt.at).is_err()
        {
            return Err(invalid("Canonical receipt values are unsupported."));
        }
        // These are the two existing selected producers' unchanged-value rules.
        let supported = match receipt.operation.as_str() {
            operation if operation == pair_rules().operation => {
                receipt.metadata_before_hash == receipt.metadata_after_hash
            }
            "page.full_width" => receipt.body_before_hash == receipt.body_after_hash,
            operation
                if operation == metadata::policy_operation()
                    && schema_version(conn)? == metadata::schema_version() =>
            {
                receipt.body_before_hash == receipt.body_after_hash
            }
            _ => false,
        };
        if !supported {
            return Err(invalid(
                "Canonical receipt operation or stable hashes are unsupported.",
            ));
        }
    }
    Ok(())
}

pub(super) fn save_editor_body(
    root: &Path,
    path: &str,
    after: &[u8],
    request: &EditorSaveRequest,
    journal: &Journal,
    bypass: Option<&str>,
    by: &WriteReceipt<Human>,
) -> Result<EditorSaveResult, ProtectedBodyError> {
    request_valid(path, after, request)?;
    let binding = authority::selected_binding(root)?;
    if binding.workspace_id != request.target.workspace_id {
        return Err(conflict().into());
    }
    let lock = binding
        .database
        .parent()
        .ok_or_else(conflict)?
        .join(&pair_rules().names.lock);
    if matches!(fs::symlink_metadata(&lock),Err(e) if e.kind()==std::io::ErrorKind::NotFound) {
        no_pending(&binding)?;
        let read = connection(&binding, false)?;
        if schema_version(&read)? == rules().schema_version {
            return Err(error(
                AuthorityErrorKind::UnsupportedFormat,
                "The editor writer requires selected schema 3.",
            )
            .into());
        }
        return Err(missing("This paired workspace has no trusted lock.").into());
    }
    let guard = WorkspaceLock::acquire(&binding)?;
    // v2 must refuse before writable SQLite even when an old lock file exists.
    // A hot-journal refusal here remains for the existing startup recovery owner.
    let read = connection(&binding, false)?;
    if !metadata::paired_schema(schema_version(&read)?) {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "The editor writer requires selected schema 3.",
        )
        .into());
    }
    drop(read);
    let conn = connection(&binding, true)?;
    binding_still(&binding, &guard, &conn)?;
    if !absent(&guard.directory.join(&pair_rules().names.pending))? {
        if bypass.is_some() {
            return Err(ProtectedBodyError::Retention(
                "recovery_bypass_invalid".into(),
            ));
        }
        let intent = load_intent(&binding, &guard)?;
        let Some(operation) = intent.envelope.editor_operation() else {
            return Err(required().into());
        };
        if operation.target != request.target
            || operation.path != path
            || operation.request_key != request.request_key
            || intent.after != after
            || request
                .original
                .as_ref()
                .is_some_and(|supplied| supplied.as_ref() != &operation)
        {
            return Err(conflict().into());
        }
        match recover_bound_with_outcome(&binding, &guard, &conn, Some(journal)) {
            Ok((RecoveryReport::Completed { .. }, recovery)) => {
                let current_version = operation.version.clone();
                Ok(EditorSaveResult::Applied {
                    operation: Box::new(operation),
                    current_version,
                    reconcile_required: false,
                    recovery,
                })
            }
            Ok(_) => Err(conflict().into()),
            Err(error) => Ok(EditorSaveResult::Pending {
                operation: Box::new(operation),
                error,
            }),
        }
    } else if request.phase == EditorSavePhase::Resolve {
        if bypass.is_some() {
            return Err(ProtectedBodyError::Retention(
                "recovery_bypass_invalid".into(),
            ));
        }
        let _path_guard =
            crate::vault::write::lock_selected_path(&binding.root, path).map_err(|_| conflict())?;
        let snapshot = read_snapshot(&conn, &binding)?;
        let record = snapshot
            .records
            .iter()
            .find(|r| r.path == path)
            .ok_or_else(conflict)?;
        let current_version = editor_target(&binding, record, &request.target)?;
        if let Some(original) = &request.original {
            let Some(stored) =
                recorded_receipt(&conn, &binding, editor_counter(&original.receipt.epoch)?)?
            else {
                return Ok(EditorSaveResult::OutcomeUnknown { error: required() });
            };
            if EditorReceiptView::from(&stored) != *original.receipt
                || snapshot.epoch < stored.epoch
                || record.revision < stored.revision
            {
                return Err(conflict().into());
            }
            let coherent = observed_body(&binding, path)
                .is_ok_and(|b| crate::ledger::sha256_hex(&b) == current_version.body_hash);
            binding_still(&binding, &guard, &conn)?;
            no_pending(&binding)?;
            return Ok(EditorSaveResult::Applied {
                operation: original.clone(),
                reconcile_required: !coherent || current_version != original.version,
                current_version,
                recovery: None,
            });
        }
        ordinary_body_target(&binding, &snapshot, record)?;
        let bytes = observed_body(&binding, path)?;
        binding_still(&binding, &guard, &conn)?;
        no_pending(&binding)?;
        if bytes == after && crate::ledger::sha256_hex(&bytes) == current_version.body_hash {
            Ok(EditorSaveResult::Unchanged {
                version: current_version,
            })
        } else {
            Ok(EditorSaveResult::OutcomeUnknown{error:error(AuthorityErrorKind::SourceChanged,
                "The original save outcome is unknown; reconcile the current page before a fresh attempt.")})
        }
    } else {
        drop(conn);
        match replace_body_locked(
            root,
            &binding,
            &guard,
            LockedBodyRequest {
                path,
                admission: BodyAdmission::Editor(request),
                after,
                by,
                protection: Some((journal, bypass)),
            },
        ) {
            Ok(ProtectedBodyAck {
                pair: SelectedBodyAck::Unchanged { version },
                ..
            }) => Ok(EditorSaveResult::Unchanged { version }),
            Ok(ProtectedBodyAck {
                pair:
                    SelectedBodyAck::Applied {
                        version,
                        operation_id,
                        receipt,
                        ..
                    },
                recovery,
            }) => {
                let operation = EditorOperation {
                    target: request.target.clone(),
                    path: path.into(),
                    request_key: request.request_key.clone(),
                    operation_id,
                    version: version.clone(),
                    receipt: Box::new(EditorReceiptView::from(receipt.as_ref())),
                };
                Ok(EditorSaveResult::Applied {
                    operation: Box::new(operation),
                    current_version: version,
                    reconcile_required: false,
                    recovery: Some(recovery.into()),
                })
            }
            Err(BodyCoreError::Pending { operation, error }) => {
                Ok(EditorSaveResult::Pending { operation, error })
            }
            Err(BodyCoreError::Refused(error)) => Err(error),
        }
    }
}

#[cfg(test)]
type OpenHook = Option<Box<dyn FnOnce()>>;
#[cfg(test)]
type JournalPathHook = Option<(&'static str, Box<dyn FnOnce(&Path)>)>;
#[cfg(test)]
thread_local! {
    static OPEN_HOOKS: std::cell::RefCell<(OpenHook, OpenHook)> = const { std::cell::RefCell::new((None,None)) };
    static AFTER_COMMIT: std::cell::RefCell<OpenHook> = const { std::cell::RefCell::new(None) };
    static BEFORE_INSTALL: std::cell::RefCell<OpenHook> = const { std::cell::RefCell::new(None) };
    static JOURNAL_PATH_HOOK: std::cell::RefCell<JournalPathHook> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
fn open_hook(before: bool) {
    let action = OPEN_HOOKS.with(|hooks| {
        let mut hooks = hooks.borrow_mut();
        if before {
            hooks.0.take()
        } else {
            hooks.1.take()
        }
    });
    if let Some(action) = action {
        action();
    }
}
#[cfg(test)]
pub(crate) fn with_open_hooks<T>(before: OpenHook, after: OpenHook, run: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            OPEN_HOOKS.with(|hooks| {
                *hooks.borrow_mut() = (None, None);
            });
        }
    }
    OPEN_HOOKS.with(|hooks| {
        *hooks.borrow_mut() = (before, after);
    });
    let _reset = Reset;
    run()
}

#[cfg(test)]
pub(super) fn after_commit() {
    if let Some(action) = AFTER_COMMIT.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}
#[cfg(test)]
pub(crate) fn with_after_commit_for_test<T>(
    action: impl FnOnce() + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            AFTER_COMMIT.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }
    AFTER_COMMIT.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(action));
    });
    let _reset = Reset;
    run()
}

#[cfg(test)]
fn before_install() {
    if let Some(action) = BEFORE_INSTALL.with(|slot| slot.borrow_mut().take()) {
        action();
    }
}
#[cfg(test)]
pub(crate) fn with_before_install_for_test<T>(
    action: impl FnOnce() + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            BEFORE_INSTALL.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }
    BEFORE_INSTALL.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(action));
    });
    let _reset = Reset;
    run()
}

#[cfg(test)]
fn journal_path_hook(phase: &str, path: &Path) {
    let action = JOURNAL_PATH_HOOK.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|(expected, _)| *expected == phase)
        {
            slot.take().map(|(_, action)| action)
        } else {
            None
        }
    });
    if let Some(action) = action {
        action(path);
    }
}
#[cfg(test)]
pub(crate) fn with_journal_path_hook<T>(
    phase: &'static str,
    action: impl FnOnce(&Path) + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            JOURNAL_PATH_HOOK.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }
    JOURNAL_PATH_HOOK.with(|slot| {
        *slot.borrow_mut() = Some((phase, Box::new(action)));
    });
    let _reset = Reset;
    run()
}

// Scoped lower-only capacity and publication-sync fault controls exercise the
// actual SQL savepoint and pending namespace; no synthetic receipt/state proof.
#[cfg(test)]
thread_local! {
    static SQLITE_BYTE_LIMIT: std::cell::Cell<Option<u64>> = const {std::cell::Cell::new(None)};
    static PUBLISHED_SYNC_FAILURE: std::cell::Cell<bool> = const {std::cell::Cell::new(false)};
}
#[cfg(test)]
pub(crate) fn with_sqlite_limit_for_test<T>(limit: u64, run: impl FnOnce() -> T) -> T {
    assert!(limit <= rules().limits.database_bytes);
    struct Reset(Option<u64>);
    impl Drop for Reset {
        fn drop(&mut self) {
            SQLITE_BYTE_LIMIT.with(|value| value.set(self.0));
        }
    }
    let _reset = Reset(SQLITE_BYTE_LIMIT.with(|value| value.replace(Some(limit))));
    run()
}
#[cfg(test)]
pub(crate) fn with_published_sync_failure_for_test<T>(run: impl FnOnce() -> T) -> T {
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            PUBLISHED_SYNC_FAILURE.with(|value| value.set(self.0));
        }
    }
    let _reset = Reset(PUBLISHED_SYNC_FAILURE.with(|value| value.replace(true)));
    run()
}
