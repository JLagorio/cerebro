//! Process-level runtime status — why ambient work is not running (M25.1).
//!
//! **Why this is not a database row.** The two states that matter most here
//! are "the migration to version N failed" and "the database was corrupt and
//! has been quarantined". Both are conditions in which the runtime DB is
//! either at an older schema or brand new, so a durable `settings` row is
//! exactly the thing that cannot be trusted to exist. The owner's own global
//! pause IS durable (`settings`, [`super::settings::global_pause`]) because
//! it must survive a restart; these do not survive a restart, they are
//! re-derived by the next `open`.
//!
//! **Ambient pauses; attended chat does not.** Every state here stops the
//! dispatcher and none of them touches the chat panel. A person who opens the
//! app to ask a question after a failed migration gets an answer and a
//! banner, not a dead app.

use std::sync::{Mutex, OnceLock};

/// Why the app is in conservative recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryReason {
    /// `quick_check`/`integrity_check` refused the file; the original is
    /// preserved at this path and a fresh database took its place.
    DatabaseCorrupt { quarantined: String },
    /// The database is new but the vault's ledger shows this app has
    /// processed items before — the operational history was deleted.
    DatabaseLost,
}

impl RecoveryReason {
    pub fn code(&self) -> &'static str {
        match self {
            RecoveryReason::DatabaseCorrupt { .. } => "database_corrupt",
            RecoveryReason::DatabaseLost => "database_lost",
        }
    }
}

/// What the runtime layer is currently able to promise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeStatus {
    /// Schema current, database readable, spend accounted.
    Ready,
    /// A numbered migration rolled back. The prior schema is intact and
    /// readable; the failing version is named rather than swallowed.
    MigrationFailed {
        attempted_version: i64,
        detail: String,
    },
    /// The database is readable but its history is not trustworthy, so no
    /// ambient run may start until the owner rebaselines or reprocesses.
    Recovering { reason: RecoveryReason },
}

impl RuntimeStatus {
    /// Ambient dispatch is allowed only from `Ready`. This is the one
    /// question the dispatcher asks, so it cannot be answered differently at
    /// two call sites.
    pub fn ambient_allowed(&self) -> bool {
        matches!(self, RuntimeStatus::Ready)
    }

    pub fn code(&self) -> &'static str {
        match self {
            RuntimeStatus::Ready => "ready",
            RuntimeStatus::MigrationFailed { .. } => "migration_failed",
            RuntimeStatus::Recovering { reason } => reason.code(),
        }
    }
}

fn cell() -> &'static Mutex<RuntimeStatus> {
    static STATUS: OnceLock<Mutex<RuntimeStatus>> = OnceLock::new();
    STATUS.get_or_init(|| Mutex::new(RuntimeStatus::Ready))
}

pub fn current() -> RuntimeStatus {
    cell()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or(RuntimeStatus::Ready)
}

pub fn set(status: RuntimeStatus) {
    if let Ok(mut guard) = cell().lock() {
        *guard = status;
    }
}

/// Back to `Ready`. Called when a fresh open succeeds and, later, when the
/// owner resolves a recovery by rebaselining or reprocessing.
pub fn clear() {
    set(RuntimeStatus::Ready);
}

/// Ambient work is allowed only when the process status allows it. The
/// durable owner pause is a separate, additional gate — this function
/// deliberately does not read the database, so it stays answerable while the
/// database is the thing that is broken.
pub fn ambient_allowed() -> bool {
    current().ambient_allowed()
}

/// This status is process-global, so every test that asserts on it
/// serialises here — the same shape [`super::sink::test_lock`] uses, and for
/// the same reason: two tests in two threads that both set and then read one
/// global will pass alone and fail together, which is the least useful
/// failure a suite can produce.
#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static STATUS_LOCK: Mutex<()> = Mutex::new(());
    STATUS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ready_lets_ambient_work_start() {
        assert!(RuntimeStatus::Ready.ambient_allowed());
        assert!(!RuntimeStatus::MigrationFailed {
            attempted_version: 3,
            detail: "boom".into()
        }
        .ambient_allowed());
        assert!(!RuntimeStatus::Recovering {
            reason: RecoveryReason::DatabaseLost
        }
        .ambient_allowed());
    }

    #[test]
    fn every_state_names_itself_for_a_banner() {
        assert_eq!(RuntimeStatus::Ready.code(), "ready");
        assert_eq!(
            RuntimeStatus::MigrationFailed {
                attempted_version: 3,
                detail: String::new()
            }
            .code(),
            "migration_failed"
        );
        assert_eq!(
            RuntimeStatus::Recovering {
                reason: RecoveryReason::DatabaseCorrupt {
                    quarantined: "/tmp/runtime.db.corrupt-x".into()
                }
            }
            .code(),
            "database_corrupt"
        );
        assert_eq!(
            RuntimeStatus::Recovering {
                reason: RecoveryReason::DatabaseLost
            }
            .code(),
            "database_lost"
        );
    }
}
