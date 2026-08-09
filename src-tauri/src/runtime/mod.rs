//! The runtime DB (M24.2) — `<app-data>/runtime.db`, where operational
//! noise lives so the epistemic ledger does not have to.
//!
//! **Two records, two destinies (D5).** The append-only ledger receives
//! valid proposals, applied mutations, *meaningful* policy rejections, and
//! human decisions. This database receives the rest: schema mistakes,
//! malformed tool arguments, CAS races during internal retries, timeouts,
//! quota failures. Without the split, the vault's permanent epistemic
//! record fills with "Claude forgot a required field 92,000 times" — server
//! logs, reinvented, in a file the user syncs.
//!
//! It is born here rather than in M25 because typed rejection noise needs a
//! home the moment refusals become typed, which is now. M24 owns exactly two
//! tables — `operational_log` at birth and `parked_promotions` at M24.6 —
//! and M25 owns all further schema growth and its migrations.
//!
//! Like the ledger index, it lives in app-data and never inside the vault:
//! SQLite WAL plus a cloud-sync daemon is how databases get corrupted (D2).
//! Unlike the ledger index it is NOT rebuildable from segments, so it is not
//! deleted on damage — but nothing authoritative may ever live here either.
//! Pending review state is reducer state; this DB may cache it and is never
//! asked.

pub mod operational;
pub mod parked;
pub mod sink;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// The one runtime database, beside the ledger index in app-data.
pub const RUNTIME_DB: &str = "runtime.db";

/// The schema version M24 establishes: `operational_log` at M24.2, plus
/// `parked_promotions` at M24.6. M25 owns every later migration.
pub const USER_VERSION: i64 = 2;

pub fn runtime_db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_DB)
}

/// Open (creating if needed) the runtime DB with its M24 schema.
///
/// Creation is ONE transaction that ends by stamping `user_version`: a
/// process killed midway leaves either no database or a complete one, never
/// a half-built schema that a later open would mistake for current.
pub fn open(data_dir: &Path) -> Result<Connection, String> {
    if let Some(parent) = runtime_db_path(data_dir).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(runtime_db_path(data_dir)).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    match version {
        0 => initialise(&conn)?,
        1 => upgrade_to_2(&conn)?,
        v if v == USER_VERSION => {}
        v => {
            return Err(format!(
                "{}: runtime db is at user_version {v}, this build speaks {USER_VERSION}",
                runtime_db_path(data_dir).display()
            ))
        }
    }
    Ok(conn)
}

fn initialise(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "BEGIN;
         {SCHEMA_V1}
         {SCHEMA_V2}
         PRAGMA user_version = {USER_VERSION};
         COMMIT;"
    ))
    .map_err(|e| e.to_string())?;
    crate::crash::crash_point("runtime-db-initialised");
    Ok(())
}

/// The one M24 migration: a database created by M24.2 gains M24.6's table.
///
/// It exists because this DB is NOT rebuildable — dropping and recreating it
/// would throw away the refusal history it was built to keep. Same shape as
/// creation: one transaction ending in the stamp, so a kill leaves either the
/// old schema or the new one.
fn upgrade_to_2(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(&format!(
        "BEGIN;
         {SCHEMA_V2}
         PRAGMA user_version = {USER_VERSION};
         COMMIT;"
    ))
    .map_err(|e| e.to_string())?;
    crate::crash::crash_point("runtime-db-upgraded");
    Ok(())
}

/// The M24.2 schema.
///
/// `recorded_at` is core-stamped, never caller-supplied — the same rule the
/// ledger holds for system time. Nullable columns are the ones a refusal
/// genuinely may not have: a malformed argument arrives before a vault is
/// resolved, and a transport failure has no rule and no proposal.
const SCHEMA_V1: &str = "
    CREATE TABLE operational_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        store_uuid TEXT,
        surface TEXT NOT NULL,
        code TEXT NOT NULL,
        rule TEXT,
        detail TEXT NOT NULL,
        proposal_id TEXT,
        run_id TEXT
    );
    CREATE INDEX operational_log_code ON operational_log (code, id);
";

/// The M24.6 schema — visibly parked promotions.
///
/// Operational, not ledger, by the standing when-in-doubt rule: every column
/// here is recomputable from the vault's records plus the type docs, so it is
/// a cache of a question ('what is not promotable yet, and what is missing')
/// and never an authority. Wiping app-data loses a worklist, not history.
///
/// `as_of` and `cleared_at` are core-stamped like `recorded_at`. They are
/// display and ordering only: no policy decision reads them, because a clock
/// is not evidence.
///
/// The partial unique index is the whole idempotency story. The gate runs
/// twice per commit set (decide, then again before append) and once more on
/// every retry; without it the debt lane would count attempts instead of
/// items.
const SCHEMA_V2: &str = "
    CREATE TABLE parked_promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        belief_id TEXT NOT NULL,
        record_path TEXT,
        type_id TEXT NOT NULL,
        type_schema_hash TEXT NOT NULL,
        missing_roles TEXT NOT NULL,
        as_of TEXT NOT NULL,
        cleared_at TEXT
    );
    CREATE UNIQUE INDEX parked_promotions_open
        ON parked_promotions (store_id, belief_id) WHERE cleared_at IS NULL;
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn opening_twice_is_idempotent_and_keeps_the_rows() {
        let dir = testutil::temp_vault("runtime-open");
        let conn = open(&dir).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, USER_VERSION);
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
            [],
        )
        .unwrap();
        drop(conn);

        let conn = open(&dir).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "a second open must not re-initialise");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_database_born_at_m24_2_gains_the_m24_6_table_and_keeps_its_rows() {
        // This DB is not rebuildable, so the migration is the only honest
        // move: dropping and recreating would throw away the refusal history
        // it exists to keep.
        let dir = testutil::temp_vault("runtime-upgrade");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(runtime_db_path(&dir)).unwrap();
        conn.execute_batch(&format!(
            "BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"
        ))
        .unwrap();
        conn.execute(
            "INSERT INTO operational_log (recorded_at, surface, code, detail) \
             VALUES ('2026-08-09T00:00:00Z', 'test', 'malformed_arguments', 'x')",
            [],
        )
        .unwrap();
        drop(conn);

        let conn = open(&dir).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, USER_VERSION);
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM operational_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the migration must not lose refusal history");
        let parked: i64 = conn
            .query_row("SELECT count(*) FROM parked_promotions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(parked, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_future_schema_is_refused_rather_than_used() {
        // A newer build's database opened by an older one would silently
        // read columns that mean something else now.
        let dir = testutil::temp_vault("runtime-future");
        let conn = open(&dir).unwrap();
        conn.pragma_update(None, "user_version", USER_VERSION + 7)
            .unwrap();
        drop(conn);
        let err = open(&dir).unwrap_err();
        assert!(err.contains("this build speaks"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_database_is_created_beside_its_directory_not_inside_the_vault() {
        // D2: SQLite WAL inside a cloud-synced vault is how databases get
        // corrupted. The path is app-data by construction.
        let dir = testutil::temp_vault("runtime-path");
        assert_eq!(runtime_db_path(&dir), dir.join(RUNTIME_DB));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
