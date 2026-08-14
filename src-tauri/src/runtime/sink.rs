//! The process-wide operational sink (M24.2).
//!
//! The guards that refuse a tool call live deep in `knowledge.rs` and
//! `mcp.rs`, where threading a database handle through seventeen call sites
//! would buy nothing but churn. So the sink is armed once at startup — the
//! same shape `ledger::shadow` uses for the active writer — and the guards
//! hand it a typed refusal on their way out.
//!
//! **Unarmed is a no-op, deliberately.** The refusal has already been
//! decided and returned; whether it was also recorded is not the caller's
//! problem and must never change what the caller sees. Unit tests, headless
//! runs, and the moment before a vault is opened all sit here.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;

use super::operational::{self, LogEntry};
use super::parked::{self, Parked};
use crate::policy::rejection::OperationalRefusal;

fn sink() -> &'static Mutex<Option<Connection>> {
    static SINK: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    SINK.get_or_init(|| Mutex::new(None))
}

/// Open the runtime DB and arm the sink. Called once as the app starts.
///
/// A failure here is reported but never fatal: an app that refused to boot
/// because it could not open its *log* would be trading a working vault for
/// a diagnostic.
pub fn arm(data_dir: &Path) -> Result<(), String> {
    let conn = super::open(data_dir)?;
    let mut guard = sink().lock().map_err(|e| e.to_string())?;
    *guard = Some(conn);
    Ok(())
}

/// Close the sink. Tests use it to keep the global clean; the app uses it on
/// vault switch.
pub fn disarm() {
    if let Ok(mut guard) = sink().lock() {
        *guard = None;
    }
}

pub fn is_armed() -> bool {
    sink().lock().is_ok_and(|guard| guard.is_some())
}

/// Record a refusal if the sink is armed. Never fails, never panics, never
/// changes what the caller returns.
pub fn record(refusal: &OperationalRefusal, entry: &LogEntry) {
    let Ok(guard) = sink().lock() else {
        return;
    };
    if let Some(conn) = guard.as_ref() {
        operational::record_or_warn(conn, refusal, entry);
    }
}

/// Park a refused promotion if the sink is armed (M24.6).
///
/// Same contract as [`record`]: the gate has already refused, and whether
/// the worklist took the note must never change what the caller is told.
pub fn park(parked: &Parked) {
    let Ok(guard) = sink().lock() else {
        return;
    };
    if let Some(conn) = guard.as_ref() {
        if let Err(e) = parked::park(conn, parked) {
            eprintln!(
                "parked_promotions: could not park {}: {e}",
                parked.belief_id
            );
        }
    }
}

/// Clear an item's open parked row if the sink is armed (M24.6).
pub fn clear_park(store_id: &str, belief_id: &str) {
    let Ok(guard) = sink().lock() else {
        return;
    };
    if let Some(conn) = guard.as_ref() {
        if let Err(e) = parked::clear(conn, store_id, belief_id) {
            eprintln!("parked_promotions: could not clear {belief_id}: {e}");
        }
    }
}

/// Run `f` against the armed connection, if there is one — the read path
/// for tests and, later, M25's metering surface.
pub fn with_sink<T>(f: impl FnOnce(&Connection) -> T) -> Option<T> {
    let guard = sink().lock().ok()?;
    guard.as_ref().map(f)
}

/// The sink is process-global, so every test that arms it serialises here —
/// including the policy tests, which is why this lives beside the sink
/// rather than inside one module's test scaffolding.
#[cfg(test)]
pub fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static SINK_LOCK: Mutex<()> = Mutex::new(());
    SINK_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::table::PolicyTable;
    use crate::runtime::operational::counts_by_code;
    use crate::vault::testutil;

    use super::test_lock as lock;

    fn refusal() -> OperationalRefusal {
        let table = PolicyTable::load().unwrap();
        OperationalRefusal::new(&table, "malformed_arguments", "test", "detail").unwrap()
    }

    #[test]
    fn an_unarmed_sink_swallows_without_complaint() {
        let _guard = lock();
        disarm();
        assert!(!is_armed());
        record(&refusal(), &LogEntry::bare());
        assert!(with_sink(|_| ()).is_none());
    }

    #[test]
    fn an_armed_sink_records() {
        let _guard = lock();
        let dir = testutil::temp_vault("sink-armed");
        arm(&dir).unwrap();
        record(&refusal(), &LogEntry::bare());
        let counts = with_sink(|conn| counts_by_code(conn).unwrap()).unwrap();
        assert_eq!(counts, vec![("malformed_arguments".to_string(), 1)]);
        disarm();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_real_guard_refusal_reaches_the_table() {
        // The end-to-end seam: knowledge.rs refuses a bundle write, and the
        // refusal lands here rather than in the ledger.
        //
        // Counted as a DELTA on this surface, and asserted as "at least
        // one", because the sink is process-global: another test thread may
        // call the same guard while this one holds it armed. An exact count
        // would be a flake, and a flaky gate is worse than no gate.
        let _guard = lock();
        let dir = testutil::temp_vault("sink-guard");
        arm(&dir).unwrap();
        let before = rows_for_surface("agent_write");
        assert!(crate::knowledge::guard_agent_write("knowledge/a.md").is_err());
        assert!(rows_for_surface("agent_write") > before);
        disarm();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn rows_for_surface(surface: &str) -> i64 {
        with_sink(|conn| {
            conn.query_row(
                "SELECT count(*) FROM operational_log WHERE surface = ?1",
                [surface],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
        })
        .unwrap_or(0)
    }
}
