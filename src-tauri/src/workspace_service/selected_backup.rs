//! Read-only snapshot bridge. Portable evidence never constructs a binding.
use super::*;
#[cfg(target_os = "macos")]
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackupRecord {
    pub id: String,
    pub path: String,
    pub revision: i64,
    pub body_hash: String,
    pub metadata: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackupFacts {
    pub workspace_id: String,
    pub schema_version: i64,
    pub schema_revision: i64,
    pub epoch: i64,
    pub records: Vec<BackupRecord>,
}
#[cfg(target_os = "macos")]
fn facts(conn: &Connection, workspace: &str) -> Result<BackupFacts, AuthorityError> {
    if !authority::uuid_valid(workspace) {
        return Err(invalid(
            "Portable workspace identity is not a supported UUID.",
        ));
    }
    facts_with_snapshot(
        conn,
        workspace,
        read_snapshot_for_workspace(conn, workspace)?,
    )
}
fn facts_with_snapshot(
    conn: &Connection,
    workspace: &str,
    snapshot: Snapshot,
) -> Result<BackupFacts, AuthorityError> {
    let schema_version = store::schema_version(conn)?;
    if !metadata::paired_schema(schema_version) {
        return Err(error(
            AuthorityErrorKind::UnsupportedFormat,
            "Portable paired backup requires a supported paired schema.",
        ));
    }
    store::validate_receipts(conn, workspace, &snapshot)?;
    Ok(BackupFacts {
        workspace_id: workspace.into(),
        schema_version,
        schema_revision: snapshot.schema_revision,
        epoch: snapshot.epoch,
        records: snapshot
            .records
            .into_iter()
            .map(|record| BackupRecord {
                id: record.id,
                path: record.path,
                revision: record.revision,
                body_hash: record.body_hash,
                metadata: record.metadata_source,
            })
            .collect(),
    })
}
fn allocation(conn: &Connection, cap: u64) -> Result<u64, AuthorityError> {
    let pages: i64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .map_err(|_| invalid("SQLite page count is unavailable."))?;
    let size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|_| invalid("SQLite page size is unavailable."))?;
    let (pages, size) = (
        u64::try_from(pages).map_err(|_| invalid("Invalid page count."))?,
        u64::try_from(size).map_err(|_| invalid("Invalid page size."))?,
    );
    if !(512..=65536).contains(&size)
        || !size.is_power_of_two()
        || pages.checked_mul(size).is_none_or(|bytes| bytes > cap)
    {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "SQLite allocation exceeds the backup bound.",
        ));
    }
    Ok(size)
}
fn constrain(conn: &Connection, cap: u64) -> Result<(), AuthorityError> {
    let length = i32::try_from(cap).map_err(|_| invalid("Invalid SQLite byte limit."))?;
    // These limits affect this owned connection only. They prevent a malformed
    // portable record declaring an allocation larger than the bounded DB image.
    unsafe {
        rusqlite::ffi::sqlite3_limit(conn.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, length);
        rusqlite::ffi::sqlite3_limit(
            conn.handle(),
            rusqlite::ffi::SQLITE_LIMIT_SQL_LENGTH,
            length,
        );
    }
    conn.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| missing("SQLite lock policy is unavailable."))?;
    conn.pragma_update(None, "trusted_schema", false)
        .map_err(|_| invalid("SQLite trusted-schema policy is unavailable."))?;
    conn.pragma_update(None, "mmap_size", 0)
        .map_err(|_| invalid("SQLite mapping policy is unavailable."))?;
    allocation(conn, cap)?;
    Ok(())
}
#[cfg(target_os = "macos")]
fn data_version(conn: &Connection) -> Result<i64, AuthorityError> {
    conn.query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|_| invalid("SQLite change identity is unavailable."))
}

#[cfg(all(test, target_os = "macos"))]
struct SnapshotHook {
    after_open: bool,
    action: Box<dyn FnOnce(&Path)>,
}
#[cfg(all(test, target_os = "macos"))]
thread_local! { static SNAPSHOT_HOOK: std::cell::RefCell<Option<SnapshotHook>> = const { std::cell::RefCell::new(None) }; }
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn with_snapshot_open_for_test<T>(
    after_open: bool,
    action: impl FnOnce(&Path) + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<SnapshotHook>);
    impl Drop for Reset {
        fn drop(&mut self) {
            SNAPSHOT_HOOK.with(|cell| *cell.borrow_mut() = self.0.take());
        }
    }
    let previous = SNAPSHOT_HOOK.with(|cell| {
        cell.replace(Some(SnapshotHook {
            after_open,
            action: Box::new(action),
        }))
    });
    let _reset = Reset(previous);
    run()
}
#[cfg(all(test, target_os = "macos"))]
fn snapshot_hook(after_open: bool, path: &Path) {
    let action = SNAPSHOT_HOOK.with(|cell| {
        if cell
            .borrow()
            .as_ref()
            .is_some_and(|hook| hook.after_open == after_open)
        {
            cell.borrow_mut().take()
        } else {
            None
        }
    });
    if let Some(hook) = action {
        (hook.action)(path);
    }
}

#[cfg(target_os = "macos")]
#[path = "selected_backup_sqlite.rs"]
mod sqlite_pin;

#[cfg(all(test, target_os = "macos"))]
type SourceOpenHook = Box<dyn FnOnce(&Path)>;
#[cfg(all(test, target_os = "macos"))]
thread_local! { static SOURCE_OPEN_HOOK: std::cell::RefCell<Option<SourceOpenHook>> = const { std::cell::RefCell::new(None) }; }
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn with_source_open_for_test<T>(
    action: impl FnOnce(&Path) + 'static,
    run: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<SourceOpenHook>);
    impl Drop for Reset {
        fn drop(&mut self) {
            SOURCE_OPEN_HOOK.with(|cell| *cell.borrow_mut() = self.0.take());
        }
    }
    let previous = SOURCE_OPEN_HOOK.with(|cell| cell.replace(Some(Box::new(action))));
    let _reset = Reset(previous);
    run()
}
#[cfg(all(test, target_os = "macos"))]
fn source_open_hook(path: &Path) {
    let action = SOURCE_OPEN_HOOK.with(|cell| cell.borrow_mut().take());
    if let Some(action) = action {
        action(path);
    }
}

#[cfg(target_os = "macos")]
pub(crate) struct Source {
    // The pinned connection owns the existing workspace lock until all its
    // SQLite and independent source descriptors have closed.
    conn: sqlite_pin::PinnedConnection,
    binding: SelectedBinding,
    expected: Option<authority::AdmittedBackupRead>,
    version: i64,
    pub facts: BackupFacts,
}
#[cfg(target_os = "macos")]
impl Source {
    pub(crate) fn open(root: &Path) -> Result<Self, AuthorityError> {
        Self::open_inner(root, None)
    }
    pub(crate) fn open_expected(expected: authority::AdmittedBackupRead) -> Result<Self, AuthorityError> {
        let root = expected.root().to_path_buf();
        Self::open_inner(&root, Some(expected))
    }
    fn open_inner(root: &Path, expected: Option<authority::AdmittedBackupRead>) -> Result<Self, AuthorityError> {
        let binding = authority::selected_binding(root)?;
        if let Some(expected) = expected.as_ref() { expected.validate_binding(&binding)?; }
        let guard = store::read_guard_readonly(&binding)?
            .ok_or_else(|| missing("Portable backup requires an existing paired lock."))?;
        let conn = sqlite_pin::PinnedConnection::open(
            &binding.database,
            rules().limits.database_bytes,
            guard,
        )?;
        if let Some(expected) = expected.as_ref() {
            expected.validate_binding(&binding)?;
            expected.validate_database(conn.identity())?;
        }
        constrain(&conn, rules().limits.database_bytes)?;
        let version = data_version(&conn)?;
        let facts = facts(&conn, &binding.workspace_id)?;
        let source = Self {
            conn,
            binding,
            expected,
            version,
            facts,
        };
        source.validate()?;
        Ok(source)
    }
    pub(crate) fn root(&self) -> &Path {
        &self.binding.root
    }
    pub(crate) fn metadata(&self) -> &Path {
        self.binding
            .database
            .parent()
            .expect("checked metadata parent")
    }
    pub(crate) fn validate(&self) -> Result<(), AuthorityError> {
        store::no_pending(&self.binding)?;
        self.conn.validate()?;
        if let Some(expected) = self.expected.as_ref() {
            expected.validate_binding(&self.binding)?;
            expected.validate_database(self.conn.identity())?;
        }
        if authority::selected_binding(&self.binding.root)? != self.binding
            || data_version(&self.conn)? != self.version
            || facts(&self.conn, &self.binding.workspace_id)? != self.facts
        {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "Selected source changed during backup.",
            ));
        }
        Ok(())
    }
    /// The destination is a private create-new reserved file, never the live DB.
    pub(crate) fn snapshot_to(
        &self,
        destination: &Path,
        cap: u64,
        identity: (u64, u64),
    ) -> Result<(), AuthorityError> {
        use std::os::unix::fs::MetadataExt;
        self.validate()?;
        use std::os::unix::fs::OpenOptionsExt;
        // Keep the reservation inode alive until AFTER the SQLite connection closes.
        // Closing this descriptor while SQLite holds POSIX locks would release them.
        let reserved = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(destination)
            .map_err(|_| missing("Reserved snapshot is unavailable."))?;
        let before = reserved
            .metadata()
            .map_err(|_| missing("Reserved snapshot identity is unavailable."))?;
        let parent = destination
            .parent()
            .ok_or_else(|| invalid("Snapshot parent is missing."))?;
        let parent_before = std::fs::symlink_metadata(parent)
            .map_err(|_| missing("Snapshot parent is unavailable."))?;
        if !parent_before.is_dir() || parent_before.file_type().is_symlink() {
            return Err(invalid("Snapshot parent is not an owned directory."));
        }
        if !before.is_file()
            || before.file_type().is_symlink()
            || before.nlink() != 1
            || before.len() != 0
            || (before.dev(), before.ino()) != identity
        {
            return Err(invalid(
                "Snapshot destination is not a private reserved file.",
            ));
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        #[cfg(all(test, target_os = "macos"))]
        snapshot_hook(false, destination);
        let mut destination_conn =
            Connection::open_with_flags_and_vfs(destination, flags, "unix-posix")
                .map_err(|_| missing("Snapshot destination cannot be opened."))?;
        #[cfg(all(test, target_os = "macos"))]
        snapshot_hook(true, destination);
        let opened = std::fs::symlink_metadata(destination)
            .map_err(|_| missing("Snapshot reservation disappeared."))?;
        let parent_opened = std::fs::symlink_metadata(parent)
            .map_err(|_| missing("Snapshot parent disappeared."))?;
        if !opened.is_file()
            || opened.file_type().is_symlink()
            || opened.nlink() != 1
            || opened.len() != 0
            || (opened.dev(), opened.ino()) != identity
            || !parent_opened.is_dir()
            || parent_opened.file_type().is_symlink()
            || (parent_opened.dev(), parent_opened.ino())
                != (parent_before.dev(), parent_before.ino())
        {
            return Err(error(
                AuthorityErrorKind::WrongIdentity,
                "Snapshot reservation changed while opening.",
            ));
        }
        // Validate the actual VFS handle before any destination write is possible.
        store::handle_unmoved(&destination_conn)?;
        destination_conn
            .busy_timeout(std::time::Duration::ZERO)
            .map_err(|_| missing("Snapshot lock policy is unavailable."))?;
        destination_conn
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| invalid("Snapshot durability policy is unavailable."))?;
        let page_size = allocation(&self.conn, cap)?;
        let mut complete = false;
        {
            let copy = rusqlite::backup::Backup::new(&self.conn, &mut destination_conn)
                .map_err(|_| missing("SQLite snapshot cannot begin."))?;
            let maximum_steps = cap / 512 / 128 + 2;
            for _ in 0..maximum_steps {
                let step = copy
                    .step(128)
                    .map_err(|_| missing("SQLite snapshot failed."))?;
                let progress = copy.progress();
                if progress.pagecount < 0
                    || (progress.pagecount as u64)
                        .checked_mul(page_size)
                        .is_none_or(|bytes| bytes > cap)
                {
                    return Err(error(
                        AuthorityErrorKind::SourceLimit,
                        "SQLite snapshot exceeds its bound.",
                    ));
                }
                match step {
                    rusqlite::backup::StepResult::Done => {
                        complete = true;
                        break;
                    }
                    rusqlite::backup::StepResult::More => {}
                    _ => return Err(error(AuthorityErrorKind::Busy, "SQLite snapshot is busy.")),
                }
            }
        }
        if !complete {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "SQLite snapshot did not settle within its bound.",
            ));
        }
        store::handle_unmoved(&destination_conn)?;
        if facts(&destination_conn, &self.binding.workspace_id)? != self.facts {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "SQLite snapshot does not match its source.",
            ));
        }
        destination_conn
            .close()
            .map_err(|_| missing("SQLite snapshot cannot close."))?;
        let after = std::fs::symlink_metadata(destination)
            .map_err(|_| missing("Snapshot destination disappeared."))?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || after.nlink() != 1
            || !after.is_file()
            || after.len() > cap
        {
            return Err(error(
                AuthorityErrorKind::SourceChanged,
                "Snapshot destination identity changed.",
            ));
        }
        reserved
            .sync_all()
            .map_err(|_| missing("Snapshot bytes could not be flushed."))?;
        self.validate()
    }
}
/// Validates an immutable bounded capture in a readonly in-memory database.
/// No SQLite call reopens the source path or discovers any journal/WAL sidecar.
pub(crate) fn read_offline(bytes:&[u8],workspace:&str,cap:u64)->Result<BackupFacts,AuthorityError> {
    read_offline_profile(bytes,workspace,cap,false)
}
/// Descriptive initial-stage validation on the same bounded SQLite image.
/// Ordinary backups retain their supported original request/receipt history.
pub(crate) fn read_fresh_stage_offline(bytes:&[u8],workspace:&str,cap:u64)->Result<BackupFacts,AuthorityError> {
    read_offline_profile(bytes,workspace,cap,true)
}
fn read_offline_profile(bytes:&[u8],workspace:&str,cap:u64,initial_stage:bool)->Result<BackupFacts,AuthorityError> {
    if !authority::uuid_valid(workspace) {
        return Err(invalid(
            "Portable workspace identity is not a supported UUID.",
        ));
    }
    if bytes.len() < 100
        || bytes.len() as u64 > cap
        || !bytes.starts_with(b"SQLite format 3\0")
        || bytes[18] != 1
        || bytes[19] != 1
    {
        return Err(invalid("Portable metadata requires a bounded rollback-mode SQLite image; WAL and unknown formats are unsupported."));
    }
    let mut conn = Connection::open_in_memory()
        .map_err(|_| invalid("Snapshot validation memory is unavailable."))?;
    constrain(&conn, cap)?;
    // This exact immutable slice always supplies its declared length. Never pass
    // a fallible file reader: rusqlite 0.40.1's helper retains its allocation on
    // a read_exact error. The READONLY deserialize flag also disables resizing.
    conn.deserialize_read_exact(rusqlite::MAIN_DB, bytes, bytes.len(), true)
        .map_err(|_| invalid("Captured snapshot cannot be decoded."))?;
    allocation(&conn, cap)?;
    conn.pragma_update(None, "query_only", true)
        .map_err(|_| invalid("Readonly snapshot policy is unavailable."))?;
    let snapshot = read_snapshot_with_journal(&conn, workspace, "memory")?;
    if initial_stage {
        if store::schema_version(&conn)?!=metadata::schema_version() {
            return Err(error(AuthorityErrorKind::UnsupportedFormat,"Initial selected staging requires its explicit supported schema."));
        }
        let history:(i64,i64)=conn.query_row("SELECT (SELECT count(*) FROM metadata_receipts),(SELECT count(*) FROM metadata_requests)",[],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|invalid("Initial-stage history is unreadable."))?;
        if history!=(0,0) {return Err(invalid("An initial inactive stage cannot contain mutation or original-request history."));}
    }
    facts_with_snapshot(&conn, workspace, snapshot)
}
pub(crate) fn source_limits() -> (u64, u64, usize, usize, usize, u64) {
    let limits = &rules().limits;
    (
        limits.body_bytes,
        limits.aggregate_body_bytes as u64,
        limits.records,
        limits.path_bytes,
        limits.path_components,
        limits.database_bytes,
    )
}
