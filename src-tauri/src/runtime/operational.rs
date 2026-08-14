//! `operational_log` — the runtime DB's record of refusals that are NOT
//! epistemic history (M24.2).
//!
//! What lands here: malformed tool arguments, schema mistakes, capability
//! gaps, CAS races during internal retries. What never lands here: a
//! meaningful policy rejection. The routing decision is not made at the call
//! site — [`OperationalRefusal`] can only be constructed with a code whose
//! declared destiny in `policy.v1.json` is `operational`, so a
//! ledger-destined refusal cannot reach this table by mistake.
//!
//! Writing here MUST NOT be able to fail a user action. A refusal that could
//! not be recorded is still a refusal; the caller gets its answer either
//! way, and the failure to log is itself only worth a line on stderr.

use rusqlite::Connection;

use crate::policy::rejection::OperationalRefusal;
use crate::policy::table::PolicyTable;

/// One row as it is written. `recorded_at` is core-stamped at insert.
#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
    pub store_uuid: Option<String>,
    pub proposal_id: Option<String>,
    pub run_id: Option<String>,
    pub rule: Option<String>,
}

impl LogEntry {
    /// The common case: a tool-surface refusal with no proposal behind it.
    pub fn bare() -> LogEntry {
        LogEntry {
            store_uuid: None,
            proposal_id: None,
            run_id: None,
            rule: None,
        }
    }

    pub fn in_store(store_uuid: &str) -> LogEntry {
        LogEntry {
            store_uuid: Some(store_uuid.to_string()),
            ..LogEntry::bare()
        }
    }
}

/// Record an operational refusal. Returns the row id.
pub fn record(
    conn: &Connection,
    refusal: &OperationalRefusal,
    entry: &LogEntry,
) -> Result<i64, String> {
    let recorded_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "INSERT INTO operational_log \
         (recorded_at, store_uuid, surface, code, rule, detail, proposal_id, run_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            recorded_at,
            entry.store_uuid,
            refusal.surface,
            refusal.code.as_str(),
            entry.rule,
            refusal.detail,
            entry.proposal_id,
            entry.run_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Record and swallow. The refusal has already been decided; failing to
/// write a log line must never turn into a second failure for the user.
pub fn record_or_warn(conn: &Connection, refusal: &OperationalRefusal, entry: &LogEntry) {
    if let Err(e) = record(conn, refusal, entry) {
        eprintln!(
            "operational_log: could not record {} from {}: {e}",
            refusal.code.as_str(),
            refusal.surface
        );
    }
}

/// How many refusals of each code have been recorded — the shape M25's
/// metering reads, and enough for a test to prove routing.
pub fn counts_by_code(conn: &Connection) -> Result<Vec<(String, i64)>, String> {
    let mut statement = conn
        .prepare("SELECT code, count(*) FROM operational_log GROUP BY code ORDER BY code")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Every code this table holds must still be operational-destined under the
/// CURRENT table. A code promoted to `ledger` in a later policy version
/// leaves rows behind that are now misfiled, and the app should say so
/// rather than quietly serving them as operational forever.
pub fn misfiled_codes(conn: &Connection, table: &PolicyTable) -> Result<Vec<String>, String> {
    Ok(counts_by_code(conn)?
        .into_iter()
        .map(|(code, _)| code)
        .filter(|code| table.destiny(code) != Some(crate::policy::table::Destiny::Operational))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::rejection::OperationalRefusal;
    use crate::runtime;
    use crate::vault::testutil;

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    #[test]
    fn a_refusal_lands_with_its_code_and_surface() {
        let dir = testutil::temp_vault("oplog-record");
        let conn = runtime::open(&dir).unwrap();
        let t = table();
        let refusal =
            OperationalRefusal::new(&t, "malformed_arguments", "update_frontmatter", "no").unwrap();
        record(&conn, &refusal, &LogEntry::in_store("store-a")).unwrap();
        record(&conn, &refusal, &LogEntry::bare()).unwrap();

        assert_eq!(
            counts_by_code(&conn).unwrap(),
            vec![("malformed_arguments".to_string(), 2)]
        );
        let (surface, store): (String, Option<String>) = conn
            .query_row(
                "SELECT surface, store_uuid FROM operational_log ORDER BY id LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(surface, "update_frontmatter");
        assert_eq!(store.as_deref(), Some("store-a"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_table_never_holds_a_ledger_destined_code() {
        // Not enforced by the SQL, but by the type: an OperationalRefusal
        // cannot be built with a ledger code, so nothing can insert one.
        let dir = testutil::temp_vault("oplog-destiny");
        let conn = runtime::open(&dir).unwrap();
        let t = table();
        for code in t.rejection_destinies.keys() {
            let built = OperationalRefusal::new(&t, code, "test", "d");
            if let Ok(refusal) = built {
                record(&conn, &refusal, &LogEntry::bare()).unwrap();
            }
        }
        assert!(
            misfiled_codes(&conn, &t).unwrap().is_empty(),
            "an operational refusal carried a ledger code"
        );
        // And it did record the operational ones, so the loop proved
        // something rather than being vacuous.
        assert!(!counts_by_code(&conn).unwrap().is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_never_becomes_a_second_failure_for_the_user() {
        let dir = testutil::temp_vault("oplog-swallow");
        let conn = runtime::open(&dir).unwrap();
        conn.execute("DROP TABLE operational_log", []).unwrap();
        let t = table();
        let refusal = OperationalRefusal::new(&t, "malformed_arguments", "test", "d").unwrap();
        // No panic, no Err — the refusal was already decided.
        record_or_warn(&conn, &refusal, &LogEntry::bare());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
