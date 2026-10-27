//! Opt-in exact displaced bytes, outside the vault and epistemic history.
//!
//! The human save wrappers supply this service explicitly. No unavailable
//! service is interpreted as disabled. Only `prepare`, holding the existing
//! note path lock, can insert a copy. SQLite commits its BLOB and intent in
//! one FULL-synchronous transaction before the existing atomic file writer.
use super::write::{self, PathLock};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[cfg(unix)]
mod selected_capture;
#[cfg(unix)]
pub(crate) use selected_capture::{
    RetainedCopy, SelectedCaptureRequest, SelectedJoin, SelectedSettlement,
};

const DATABASE: &str = "recovery.sqlite";
const MARKER: &str = "initialized-v1";
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Limits {
    pub schema_version: i64,
    pub retention_seconds: i64,
    pub global_bytes: i64,
    pub entry_bytes: i64,
    pub max_entries: i64,
    pub selected_join_bytes: usize,
    pub max_vaults: i64,
    pub max_path_bytes: usize,
    pub max_bypasses: usize,
    pub bypass_seconds: i64,
}
pub fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/policy/recovery.v1.json"))
            .expect("compiled recovery limits")
    })
}
fn now() -> i64 {
    let value = chrono::Utc::now().timestamp();
    #[cfg(test)]
    let value = value + TEST_CLOCK_OFFSET.with(std::cell::Cell::get);
    value
}
#[cfg(test)]
thread_local! { static TEST_CLOCK_OFFSET: std::cell::Cell<i64> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) fn with_clock_offset_for_test<T>(offset: i64, run: impl FnOnce() -> T) -> T {
    struct Reset(i64);
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_CLOCK_OFFSET.with(|clock| clock.set(self.0));
        }
    }
    let _reset = Reset(TEST_CLOCK_OFFSET.with(|clock| clock.replace(offset)));
    run()
}
fn hash(bytes: &[u8]) -> String {
    crate::ledger::sha256_hex(bytes)
}
fn unavailable(error: impl std::fmt::Display) -> String {
    format!("recovery_unavailable: {error}")
}

#[derive(Debug)]
pub struct Journal {
    root: PathBuf,
    // The stable lockfile is never removed; descriptor ownership spans every
    // operation and is released by the OS on drop or process death.
    _ownership: fs::File,
    failures: Mutex<HashMap<String, FailureBinding>>,
}
#[derive(Debug)]
struct FailureBinding {
    vault: String,
    path: String,
    before: String,
    after: String,
    selected: Option<String>,
    expires_at: i64,
    reason: &'static str,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub reason: &'static str,
    pub expires_at: i64,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Off,
    NotRetained { reason: String },
    Retained { id: String, evicted: usize },
    Pending { id: String, evicted: usize },
    WithoutCopy,
}
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryWrite {
    pub hash: String,
    pub recovery: Outcome,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub path: String,
    pub before_hash: String,
    pub after_hash: String,
    pub captured_at: i64,
    pub bytes: i64,
    /// Pending/ambiguous never assert that the intended write completed.
    pub state: String,
    pub attribution: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub retained_bytes: i64,
    pub entries: i64,
    pub pending: i64,
    pub ambiguous: i64,
    pub limits: Limits,
}
pub(super) struct Prepared {
    outcome: Outcome,
}
impl Journal {
    /// `root` is the app's private recovery directory, never a vault path.
    /// A marker detects disappearance of an initialized DB rather than
    /// recreating an empty policy store and silently disabling protection.
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(unavailable)?;
        let root = fs::canonicalize(root).map_err(unavailable)?;
        // PathLock serializes this process only. Acquire service ownership
        // before looking at schema or reconciling any pending write, so another
        // Cerebro instance cannot mistake a live intent for an abandoned one.
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let ownership = options.open(root.join("owner.lock")).map_err(unavailable)?;
        if !ownership.metadata().map_err(unavailable)?.is_file() {
            return Err(unavailable("ownership lock is not a regular file"));
        }
        ownership.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => {
                unavailable("another Cerebro instance owns the recovery journal")
            }
            fs::TryLockError::Error(error) => unavailable(error),
        })?;
        let journal = Self {
            root,
            _ownership: ownership,
            failures: Mutex::new(HashMap::new()),
        };
        let database = journal.root.join(DATABASE);
        let fresh = match fs::symlink_metadata(&database) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(unavailable(error)),
        };
        if fresh {
            if journal.root.join(MARKER).exists() {
                return Err(unavailable("initialized database is missing"));
            }
            journal.install()?;
        }
        let mut conn = journal.connection()?;
        journal.migrate_selected_join(&mut conn)?;
        journal.validate_schema(&conn)?;
        if !journal.root.join(MARKER).exists() {
            let mut marker = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(journal.root.join(MARKER))
                .map_err(unavailable)?;
            marker
                .write_all(b"recovery schema 1\n")
                .map_err(unavailable)?;
            marker.sync_all().map_err(unavailable)?;
            write::sync_dir(&journal.root).map_err(unavailable)?;
        }
        journal.sweep_all()?;
        Ok(journal)
    }
    /// Only this unpublished file may be discarded after interrupted setup.
    /// A final database, even unmarked or invalid, is never reset by Retry.
    fn install(&self) -> Result<(), String> {
        let staged = self.root.join("recovery.install.sqlite");
        match fs::symlink_metadata(&staged) {
            Ok(_) => {
                let rollback = self.root.join("recovery.install.sqlite-journal");
                match fs::remove_file(rollback) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(unavailable(error)),
                }
                fs::remove_file(&staged).map_err(unavailable)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(unavailable(error)),
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&staged).map_err(unavailable)?;
        crate::crash::stop_point("recovery-install-created");
        let conn = Self::connection_at(&staged)?;
        conn.execute_batch(&format!("BEGIN IMMEDIATE;
                CREATE TABLE settings(vault TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), vault_path TEXT NOT NULL CHECK(length(CAST(vault_path AS BLOB))<={max_path}));
                CREATE TABLE copies(
                    id TEXT PRIMARY KEY CHECK(length(id)=32),
                    vault TEXT NOT NULL CHECK(length(vault)=32),
                    path TEXT NOT NULL CHECK(length(CAST(path AS BLOB))<={max_path}),
                    lock_key TEXT NOT NULL CHECK(length(CAST(lock_key AS BLOB)) BETWEEN 1 AND {max_key}),
                    before_hash TEXT NOT NULL CHECK(length(before_hash)=64),
                    after_hash TEXT NOT NULL CHECK(length(after_hash)=64),
                    captured_at INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK(state IN('pending','committed','ambiguous')),
                    bytes BLOB NOT NULL CHECK(length(bytes)<={entry_bytes}),
                    selected_join TEXT CHECK(selected_join IS NULL OR length(CAST(selected_join AS BLOB))<={join_bytes}));
                CREATE INDEX copies_target ON copies(vault,path,captured_at,id);
                PRAGMA user_version={schema};
                COMMIT;",max_path=limits().max_path_bytes,max_key=limits().max_path_bytes*4,entry_bytes=limits().entry_bytes,join_bytes=limits().selected_join_bytes,schema=limits().schema_version)).map_err(unavailable)?;
        self.validate_schema(&conn)?;
        drop(conn);
        fs::File::open(&staged)
            .map_err(unavailable)?
            .sync_all()
            .map_err(unavailable)?;
        crate::crash::stop_point("recovery-install-validated");
        fs::rename(&staged, self.root.join(DATABASE)).map_err(unavailable)?;
        write::sync_dir(&self.root).map_err(unavailable)?;
        crate::crash::stop_point("recovery-install-published");
        Ok(())
    }
    fn connection(&self) -> Result<Connection, String> {
        Self::connection_at(&self.root.join(DATABASE))
    }
    fn connection_at(file: &Path) -> Result<Connection, String> {
        let metadata = fs::symlink_metadata(file).map_err(unavailable)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(unavailable("database is not a regular file"));
        }
        let conn = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(unavailable)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(unavailable)?;
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
        )
        .map_err(unavailable)?;
        Ok(conn)
    }
    fn migrate_selected_join(&self, conn: &mut Connection) -> Result<(), String> {
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(unavailable)?;
        if version == limits().schema_version {
            return Ok(());
        }
        if version != 1 || limits().schema_version != 2 {
            return Err(unavailable("unsupported recovery schema"));
        }
        // The previous schema's exact columns remain intact; refuse a partial or
        // foreign alteration instead of guessing that migration already ran.
        let mut statement = conn
            .prepare("SELECT name FROM pragma_table_info('copies') ORDER BY cid")
            .map_err(unavailable)?;
        let names = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(unavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(unavailable)?;
        if names
            != [
                "id",
                "vault",
                "path",
                "lock_key",
                "before_hash",
                "after_hash",
                "captured_at",
                "state",
                "bytes",
            ]
        {
            return Err(unavailable("unsupported previous recovery schema"));
        }
        drop(statement);
        conn.prepare("SELECT vault,enabled,vault_path FROM settings LIMIT 0")
            .map_err(unavailable)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        tx.execute_batch(&format!("ALTER TABLE copies ADD COLUMN selected_join TEXT CHECK(selected_join IS NULL OR length(CAST(selected_join AS BLOB))<={}); PRAGMA user_version=2;",limits().selected_join_bytes)).map_err(unavailable)?;
        crate::crash::stop_point("recovery-selected-schema-staged");
        tx.commit().map_err(unavailable)?;
        crate::crash::stop_point("recovery-selected-schema-committed");
        Ok(())
    }
    fn validate_schema(&self, conn: &Connection) -> Result<(), String> {
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(unavailable)?;
        if version != limits().schema_version {
            return Err(unavailable("unsupported recovery schema"));
        }
        conn.prepare("SELECT vault,enabled,vault_path FROM settings LIMIT 0")
            .map_err(unavailable)?;
        conn.prepare("SELECT id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes,selected_join FROM copies LIMIT 0").map_err(unavailable)?;
        Ok(())
    }
    fn connect(&self) -> Result<Connection, String> {
        let conn = self.connection()?;
        self.validate_schema(&conn)?;
        Ok(conn)
    }
    fn vault(&self, vault: &Path) -> Result<String, String> {
        let vault = fs::canonicalize(vault).map_err(unavailable)?;
        if self.root.starts_with(&vault) {
            return Err(unavailable("recovery storage must be outside the vault"));
        }
        if vault.as_os_str().len() > limits().max_path_bytes {
            return Err(unavailable("vault path exceeds recovery metadata bound"));
        }
        Ok(crate::runtime::scope::derive_vault_id(&vault))
    }
    pub fn enabled(&self, vault: &Path) -> Result<bool, String> {
        let vault = self.vault(vault)?;
        let conn = self.connect()?;
        Ok(conn
            .query_row(
                "SELECT enabled FROM settings WHERE vault=?1",
                [&vault],
                |r| r.get::<_, bool>(0),
            )
            .optional()
            .map_err(unavailable)?
            .unwrap_or(false))
    }
    pub fn set_enabled(&self, vault: &Path, enabled: bool) -> Result<(), String> {
        let vault_path = fs::canonicalize(vault).map_err(unavailable)?;
        let vault_path = vault_path
            .to_str()
            .ok_or_else(|| unavailable("vault path is not UTF-8"))?;
        let vault = self.vault(vault)?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM settings WHERE vault=?1)",
                [&vault],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        let count: i64 = tx
            .query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
            .map_err(unavailable)?;
        if !exists && count >= limits().max_vaults {
            return Err(unavailable("vault settings limit reached"));
        }
        tx.execute("INSERT INTO settings(vault,enabled,vault_path) VALUES(?1,?2,?3) ON CONFLICT(vault) DO UPDATE SET enabled=excluded.enabled,vault_path=excluded.vault_path", params![vault,enabled,vault_path]).map_err(unavailable)?;
        tx.commit().map_err(unavailable)
    }
    fn expire(conn: &Connection) -> Result<(), String> {
        // Pending rows are reconciled under their target locks by sweep;
        // never delete a capture while its file writer still owns the lock.
        conn.execute(
            "DELETE FROM copies WHERE state!='pending' AND captured_at<=?1",
            [now() - limits().retention_seconds],
        )
        .map_err(unavailable)?;
        Ok(())
    }
    /// All-vault cleanup is also performed by every recovery read/control.
    /// The supplied vault still must be a valid selected vault for that API.
    pub fn sweep(&self, vault: &Path) -> Result<(), String> {
        self.vault(vault)?;
        self.sweep_all()
    }

    /// Call at initialization (open already does), once a minute while the
    /// app runs, and after resume. Metadata work is capped at max_entries;
    /// target reads are capped globally at global_bytes for each sweep.
    /// Expired pending bytes need no target read: the stored capture lock
    /// identity still excludes an active writer if its vault was removed.
    pub fn sweep_all(&self) -> Result<(), String> {
        let rows = {
            let conn = self.connect()?;
            let mut stmt = conn.prepare("SELECT c.id,c.vault,c.path,c.lock_key,c.before_hash,c.after_hash,c.captured_at,s.vault_path,c.selected_join IS NOT NULL FROM copies c LEFT JOIN settings s ON s.vault=c.vault WHERE c.state='pending' ORDER BY c.captured_at,c.id LIMIT ?1").map_err(unavailable)?;
            let rows = stmt
                .query_map([limits().max_entries], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, bool>(8)?,
                    ))
                })
                .map_err(unavailable)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(unavailable)?
        };
        let mut budget = limits().global_bytes as u64;
        for (id, vault_id, path, key, before, after, captured, vault_path, selected_join) in rows {
            if key.is_empty() || key.len() > limits().max_path_bytes * 4 {
                return Err(unavailable("invalid recorded capture lock"));
            }
            if captured <= now() - limits().retention_seconds {
                // Expiry needs only the original capture key, even when the
                // vault or its authority is unavailable. No body is observed.
                let _lock = write::lock_recovery(&key)?;
                self.connect()?
                    .execute(
                        "DELETE FROM copies WHERE id=?1 AND captured_at<=?2",
                        params![id, now() - limits().retention_seconds],
                    )
                    .map_err(unavailable)?;
                continue;
            }
            // A durable selected join outlives the current root classifier.
            // Only paired recovery can settle it; even a later positive Legacy
            // classification cannot turn body equality into that decision.
            // Expiry above still owns the original path lock and seven-day TTL.
            if selected_join {
                continue;
            }
            // Schema1 copies have no durable selected operation/record join.
            // Current path/hash cannot decide those rows, even after paired
            // recovery. Unknown authority must never select the legacy path.
            let known_legacy = || {
                vault_path.as_deref().is_some_and(|vault_path| {
                    let vault = Path::new(vault_path);
                    self.vault(vault).is_ok_and(|current| current == vault_id)
                        && matches!(
                            crate::workspace_service::authority::resolve(vault),
                            Ok(crate::workspace_service::authority::Authority::Legacy)
                        )
                })
            };
            if !known_legacy() {
                continue;
            }
            // No SQLite transaction is held while waiting. Recheck after the
            // recorded path lock; never acquire a workspace lock in reverse.
            let _lock = write::lock_recovery(&key)?;
            if !known_legacy() {
                continue;
            }
            if budget <= 1 {
                continue;
            }
            let cap = (limits().entry_bytes as u64).min(budget - 1);
            let mut deferred = false;
            let observed = vault_path
                .ok_or_else(|| unavailable("vault mapping is missing"))
                .and_then(|vault_path| {
                    let vault = Path::new(&vault_path);
                    if self.vault(vault)? != vault_id {
                        return Err(unavailable("vault identity changed"));
                    }
                    let target = eligible_target(vault, &path)?;
                    use std::io::Read;
                    let mut options = fs::OpenOptions::new();
                    options.read(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.custom_flags(libc::O_NONBLOCK);
                    }
                    let file = options.open(target).map_err(unavailable)?;
                    if !file.metadata().map_err(unavailable)?.is_file() {
                        return Err(unavailable("target is not a regular file"));
                    }
                    let mut bytes = Vec::new();
                    let read = file.take(cap + 1).read_to_end(&mut bytes);
                    budget = budget.saturating_sub(bytes.len() as u64);
                    read.map_err(unavailable)?;
                    if bytes.len() as u64 > cap {
                        deferred = cap < limits().entry_bytes as u64;
                        return Err(unavailable("target exceeds bounded whole-file observation"));
                    }
                    Ok(hash(&bytes))
                });
            if deferred {
                continue;
            }
            let conn = self.connect()?;
            if observed.as_deref() == Ok(before.as_str()) {
                conn.execute("DELETE FROM copies WHERE id=?1 AND state='pending'", [&id])
                    .map_err(unavailable)?;
            } else {
                let state = if observed.as_deref() == Ok(after.as_str()) {
                    "committed"
                } else {
                    "ambiguous"
                };
                conn.execute(
                    "UPDATE copies SET state=?2 WHERE id=?1 AND state='pending'",
                    params![id, state],
                )
                .map_err(unavailable)?;
            }
        }
        Self::expire(&self.connect()?)
    }
    pub fn status(&self, vault: &Path) -> Result<Status, String> {
        self.sweep(vault)?;
        let conn = self.connect()?;
        let (retained_bytes,entries,pending,ambiguous) = conn.query_row("SELECT coalesce(sum(length(bytes)),0),count(*),coalesce(sum(state='pending'),0),coalesce(sum(state='ambiguous'),0) FROM copies", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(unavailable)?;
        Ok(Status {
            enabled: self.enabled(vault)?,
            retained_bytes,
            entries,
            pending,
            ambiguous,
            limits: limits().clone(),
        })
    }
    pub fn list(&self, vault: &Path, path: &str) -> Result<Vec<Version>, String> {
        bounded_path(path)?;
        self.sweep(vault)?;
        if excluded(path) {
            return Ok(vec![]);
        }
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT id,path,before_hash,after_hash,captured_at,length(bytes),state FROM copies WHERE vault=?1 AND path=?2 ORDER BY captured_at DESC,id DESC LIMIT ?3").map_err(unavailable)?;
        let rows = stmt
            .query_map(
                params![self.vault(vault)?, path, limits().max_entries],
                |r| {
                    Ok(Version {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        before_hash: r.get(2)?,
                        after_hash: r.get(3)?,
                        captured_at: r.get(4)?,
                        bytes: r.get(5)?,
                        state: r.get(6)?,
                        attribution: "outside, unattributed".into(),
                    })
                },
            )
            .map_err(unavailable)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(unavailable)
    }
    /// Exact-ID bounded bytes for the human native-dialog export door and
    /// guarded restore. This function accepts no destination filesystem path.
    pub fn read(&self, vault: &Path, path: &str, id: &str) -> Result<Vec<u8>, String> {
        bounded_path(path)?;
        checked_id(id)?;
        if excluded(path) {
            return Err("recovery_privacy_excluded".into());
        }
        // A renamed alias into a protected folder is also excluded.
        if vault.join(path).exists() {
            eligible_target(vault, path)?;
        }
        self.sweep(vault)?;
        let conn = self.connect()?;
        let (bytes,before): (Vec<u8>,String) = conn.query_row("SELECT bytes,before_hash FROM copies WHERE id=?1 AND vault=?2 AND path=?3 AND state!='pending' AND length(bytes)<=?4 AND captured_at>?5",params![id,self.vault(vault)?,path,limits().entry_bytes,now()-limits().retention_seconds],|r| Ok((r.get(0)?,r.get(1)?))).map_err(|_| "recovery_copy_unavailable".to_string())?;
        if hash(&bytes) != before {
            return Err("recovery_copy_corrupt".into());
        }
        Ok(bytes)
    }
    pub fn delete(&self, vault: &Path, path: &str, id: &str) -> Result<bool, String> {
        bounded_path(path)?;
        checked_id(id)?;
        self.sweep(vault)?;
        let conn = self.connect()?;
        let removed = conn
            .execute(
                "DELETE FROM copies WHERE id=?1 AND vault=?2 AND path=?3 AND state!='pending'",
                params![id, self.vault(vault)?, path],
            )
            .map_err(unavailable)?;
        Ok(removed > 0)
    }
    pub fn clear(&self, vault: &Path) -> Result<usize, String> {
        self.sweep(vault)?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let vault_id = self.vault(vault)?;
        let pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM copies WHERE vault=?1 AND state='pending')",
                [&vault_id],
                |r| r.get(0),
            )
            .map_err(unavailable)?;
        if pending {
            return Err("recovery_pending".into());
        }
        let count = tx
            .execute("DELETE FROM copies WHERE vault=?1", [&vault_id])
            .map_err(unavailable)?;
        tx.commit().map_err(unavailable)?;
        Ok(count)
    }
    pub fn failure(&self, vault: &Path, path: &str, nonce: &str) -> Result<Failure, String> {
        let vault = self.vault(vault)?;
        let book = self
            .failures
            .lock()
            .map_err(|_| unavailable("failure choices unavailable"))?;
        let binding = book
            .get(nonce)
            .filter(|b| b.vault == vault && b.path == path && b.expires_at > now())
            .ok_or("recovery_bypass_invalid")?;
        Ok(Failure {
            reason: binding.reason,
            expires_at: binding.expires_at,
        })
    }
    fn refuse(
        &self,
        vault: &str,
        path: &str,
        before: &str,
        after: &str,
        reason: &'static str,
    ) -> String {
        self.refuse_bound(vault, path, before, after, None, reason)
    }
    fn refuse_bound(
        &self,
        vault: &str,
        path: &str,
        before: &str,
        after: &str,
        selected: Option<&str>,
        reason: &'static str,
    ) -> String {
        let Ok(mut book) = self.failures.lock() else {
            return unavailable("failure choices unavailable");
        };
        book.retain(|_, b| b.expires_at > now());
        if book.len() >= limits().max_bypasses {
            if let Some(oldest) = book
                .iter()
                .min_by_key(|(_, b)| b.expires_at)
                .map(|(id, _)| id.clone())
            {
                book.remove(&oldest);
            }
        }
        let nonce = format!("{:032x}", rand::random::<u128>());
        book.insert(
            nonce.clone(),
            FailureBinding {
                vault: vault.into(),
                path: path.into(),
                before: before.into(),
                after: after.into(),
                selected: selected.map(str::to_owned),
                expires_at: now() + limits().bypass_seconds,
                reason,
            },
        );
        format!("recovery_required:{nonce}")
    }
    pub(super) fn prepare(
        &self,
        lock: &PathLock,
        vault: &Path,
        path: &str,
        current: &str,
        content: &str,
        bypass: Option<&str>,
    ) -> Result<Prepared, String> {
        debug_assert!(lock.covers(&vault.join(path)));
        bounded_path(path)?;
        let vault_id = self.vault(vault)?;
        let before = hash(current.as_bytes());
        let after = hash(content.as_bytes());
        if let Some(nonce) = bypass {
            let binding = self
                .failures
                .lock()
                .map_err(|_| unavailable("failure choices unavailable"))?
                .remove(nonce)
                .ok_or("recovery_bypass_invalid")?;
            if binding.vault != vault_id
                || binding.path != path
                || binding.before != before
                || binding.after != after
                || binding.selected.is_some()
                || binding.expires_at <= now()
            {
                return Err("recovery_bypass_invalid".into());
            }
            return Ok(Prepared {
                outcome: Outcome::WithoutCopy,
            });
        }
        match eligible_target(vault, path) {
            Err(error) if error == "recovery_privacy_excluded" => {
                return Ok(Prepared {
                    outcome: Outcome::NotRetained {
                        reason: "privacy".into(),
                    },
                })
            }
            Err(_) => {
                return Err(self.refuse(&vault_id, path, &before, &after, "journal_storage_failed"))
            }
            Ok(_) => {}
        }
        let capture = || -> Result<Prepared, String> {
            if !self.enabled(vault)? {
                return Ok(Prepared {
                    outcome: Outcome::Off,
                });
            }
            if current == content {
                return Ok(Prepared {
                    outcome: Outcome::NotRetained {
                        reason: "unchanged".into(),
                    },
                });
            }
            if current.len() as i64 > limits().entry_bytes {
                return Ok(Prepared {
                    outcome: Outcome::NotRetained {
                        reason: "entry_limit".into(),
                    },
                });
            }
            let mut conn = self.connect()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(unavailable)?;
            Self::expire(&tx)?;
            let evicted = Self::make_room(&tx, current.len() as i64)?;
            let id = format!("{:032x}", rand::random::<u128>());
            let key = lock.recovery_key(&vault.join(path))?;
            tx.execute("INSERT INTO copies(id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8)",params![id,vault_id,path,key,before,after,now(),current.as_bytes()]).map_err(unavailable)?;
            tx.commit().map_err(unavailable)?;
            Ok(Prepared {
                outcome: Outcome::Retained { id, evicted },
            })
        };
        capture().map_err(|error| {
            self.refuse(
                &vault_id,
                path,
                &before,
                &after,
                if error == "recovery_capacity_pending" {
                    "pending_capacity"
                } else {
                    "journal_storage_failed"
                },
            )
        })
    }
    fn make_room(conn: &Connection, size: i64) -> Result<usize, String> {
        let mut evicted = 0;
        loop {
            let (bytes, count): (i64, i64) = conn
                .query_row(
                    "SELECT coalesce(sum(length(bytes)),0),count(*) FROM copies",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(unavailable)?;
            if bytes + size <= limits().global_bytes && count < limits().max_entries {
                break;
            }
            let oldest: Option<String> = conn
                .query_row(
                    "SELECT id FROM copies WHERE state!='pending' ORDER BY captured_at,id LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(unavailable)?;
            let Some(oldest) = oldest else {
                return Err("recovery_capacity_pending".into());
            };
            conn.execute("DELETE FROM copies WHERE id=?1", [oldest])
                .map_err(unavailable)?;
            evicted += 1;
        }
        Ok(evicted)
    }
    pub(super) fn finish(&self, prepared: Prepared) -> Outcome {
        match prepared.outcome {
            Outcome::Retained { id, evicted } => {
                let finalized = self.connect().and_then(|conn| {
                    conn.execute(
                        "UPDATE copies SET state='committed' WHERE id=?1 AND state='pending'",
                        [&id],
                    )
                    .map_err(unavailable)
                });
                if finalized == Ok(1) {
                    Outcome::Retained { id, evicted }
                } else {
                    Outcome::Pending { id, evicted }
                }
            }
            outcome => outcome,
        }
    }
}
fn checked_id(id: &str) -> Result<(), String> {
    if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("recovery_copy_unavailable".into())
    }
}
fn bounded_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > limits().max_path_bytes
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        Err("recovery_invalid_path".into())
    } else {
        Ok(())
    }
}
fn excluded(path: &str) -> bool {
    crate::knowledge::is_knowledge_path(path) || crate::policy::mail::is_kept_out_of_git(path)
}
fn eligible_target(vault: &Path, path: &str) -> Result<PathBuf, String> {
    bounded_path(path)?;
    if excluded(path) {
        return Err("recovery_privacy_excluded".into());
    }
    let target = write::note_join(vault, path, &["md", "mmd"])?;
    let canonical = fs::canonicalize(&target).map_err(unavailable)?;
    let root = fs::canonicalize(vault).map_err(unavailable)?;
    let landing = canonical
        .strip_prefix(root)
        .map_err(unavailable)?
        .to_string_lossy();
    if excluded(&landing) {
        return Err("recovery_privacy_excluded".into());
    }
    Ok(target)
}
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn prepare_selected_sweep_fixture(
    journal: &Journal,
    lock: &PathLock,
    vault: &Path,
    path: &str,
    before: &str,
    after: &str,
) -> Result<String, String> {
    match journal
        .prepare(lock, vault, path, before, after, None)?
        .outcome
    {
        Outcome::Retained { id, .. } => Ok(id),
        _ => Err("fixture did not create a real pending retained copy".into()),
    }
}
