//! Storing a scheduled convergence run (M26.8b).
//!
//! **Disposable by construction.** Nothing here is authoritative: a row is a
//! reading of the ledger between two sequence numbers, and deleting one
//! causes recomputation. There is no ledger event, no identity across runs,
//! and no user-editable projection — so `record` never has to answer "what
//! happens to the old one", only "which one is current".
//!
//! **The repeat check is the content hash, not the window.** A scheduled run
//! that swept the same window and found the same answer is the ordinary case
//! on a quiet base, and storing a new row for it would grow the table with
//! copies of one sentence.

use rusqlite::{params, Connection};

use super::diff::Output;

/// How many runs one store keeps. Small on purpose: these are readings of a
/// ledger that still has every event, so the only question a superseded row
/// answers is "what did it say last time".
pub const KEEP: usize = 20;

/// Why a run happened. On-demand runs are attended and returned rather than
/// stored; the variant exists because a caller may still want to keep one,
/// and a stored row that could not say which kind it was would be unreadable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Scheduled,
    OnDemand,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Scheduled => "scheduled",
            Trigger::OnDemand => "on_demand",
        }
    }
}

/// What one write did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    Stored,
    /// The latest run already says exactly this. Nothing was written, and the
    /// existing run id is returned so a caller can point at it.
    SameAnswer {
        run_id: String,
    },
}

/// One stored run, as a reader gets it back.
#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub run_id: String,
    pub from_seq: u64,
    pub to_seq: u64,
    pub trigger: String,
    pub output_content_hash: String,
    pub output: serde_json::Value,
    pub generated_at: String,
}

/// Store one run's output, unless the current one already says it.
pub fn record(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    run_id: &str,
    trigger: Trigger,
    output: &Output,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Recorded, String> {
    let hash = output.content_hash()?;
    let json = serde_json::to_string(output).map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: Option<(String, String)> = tx
        .query_row(
            "SELECT run_id, output_content_hash FROM convergence_runs
             WHERE vault_id = ?1 AND store_uuid = ?2 AND superseded_by_run_id IS NULL
             ORDER BY generated_at DESC, run_id DESC LIMIT 1",
            params![vault_id, store_uuid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((existing, existing_hash)) = &current {
        if existing_hash == &hash {
            return Ok(Recorded::SameAnswer {
                run_id: existing.clone(),
            });
        }
        tx.execute(
            "UPDATE convergence_runs SET superseded_by_run_id = ?1
             WHERE vault_id = ?2 AND store_uuid = ?3 AND run_id = ?4",
            params![run_id, vault_id, store_uuid, existing],
        )
        .map_err(|e| format!("superseding {existing}: {e}"))?;
    }

    tx.execute(
        "INSERT INTO convergence_runs (
             vault_id, store_uuid, run_id, from_seq, to_seq, trigger, schema_version,
             output_content_hash, output_json, generated_at, superseded_by_run_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
        params![
            vault_id,
            store_uuid,
            run_id,
            output.window.from_seq as i64,
            output.window.to_seq as i64,
            trigger.as_str(),
            output.schema_version,
            hash,
            json,
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ],
    )
    .map_err(|e| format!("convergence_runs: {e}"))?;

    // Prune, in the same transaction. A superseded convergence row is the
    // history of a CACHE, and this table gains a row on every tick that moved
    // the head — on a busy base that is thousands a month, none of which
    // anybody will read. Keeping a short tail is enough to answer "what did
    // it say last time"; the ledger keeps the history that matters.
    tx.execute(
        "DELETE FROM convergence_runs
         WHERE vault_id = ?1 AND store_uuid = ?2 AND run_id NOT IN (
             SELECT run_id FROM convergence_runs
             WHERE vault_id = ?1 AND store_uuid = ?2
             ORDER BY generated_at DESC, run_id DESC LIMIT ?3
         )",
        params![vault_id, store_uuid, KEEP as i64],
    )
    .map_err(|e| format!("pruning convergence_runs: {e}"))?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(Recorded::Stored)
}

/// The run a surface should render, if there is one.
pub fn latest(conn: &Connection, vault_id: &str, store_uuid: &str) -> Result<Option<Kept>, String> {
    conn.query_row(
        "SELECT run_id, from_seq, to_seq, trigger, output_content_hash, output_json, generated_at
         FROM convergence_runs
         WHERE vault_id = ?1 AND store_uuid = ?2 AND superseded_by_run_id IS NULL
         ORDER BY generated_at DESC, run_id DESC LIMIT 1",
        params![vault_id, store_uuid],
        |row| {
            Ok(Kept {
                run_id: row.get(0)?,
                from_seq: row.get::<_, i64>(1)? as u64,
                to_seq: row.get::<_, i64>(2)? as u64,
                trigger: row.get(3)?,
                output_content_hash: row.get(4)?,
                output: serde_json::from_str(&row.get::<_, String>(5)?)
                    .unwrap_or(serde_json::Value::Null),
                generated_at: row.get(6)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convergence::diff::{compute, Window};
    use crate::ledger::reduce::EpistemicState;

    const VAULT: &str = "vault-1";
    const STORE: &str = "cafebabecafebabecafebabecafebabe";

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE vault_registry (vault_id TEXT PRIMARY KEY, path TEXT NOT NULL);",
        )
        .expect("registry");
        conn.execute(
            "INSERT INTO vault_registry (vault_id, path) VALUES (?1, '/tmp/v')",
            params![VAULT],
        )
        .expect("register");
        conn.execute_batch(crate::runtime::schema::SCHEMA_V10)
            .expect("v10");
        conn
    }

    fn quiet(to_seq: u64) -> Output {
        let state = EpistemicState::default();
        compute(
            &state,
            &state,
            Window {
                from_seq: 0,
                to_seq,
            },
        )
    }

    #[test]
    fn the_same_answer_twice_is_not_stored_twice() {
        // The ordinary case on a quiet base. A second row would grow the
        // table with copies of one sentence.
        let conn = conn();
        assert_eq!(
            record(
                &conn,
                VAULT,
                STORE,
                "run-1",
                Trigger::Scheduled,
                &quiet(10),
                at("2026-08-12T12:00:00.000Z")
            )
            .unwrap(),
            Recorded::Stored
        );
        assert_eq!(
            record(
                &conn,
                VAULT,
                STORE,
                "run-2",
                Trigger::Scheduled,
                &quiet(10),
                at("2026-08-12T13:00:00.000Z")
            )
            .unwrap(),
            Recorded::SameAnswer {
                run_id: "run-1".into()
            }
        );
        let stored: i64 = conn
            .query_row("SELECT count(*) FROM convergence_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored, 1);
    }

    #[test]
    fn a_new_answer_supersedes_the_old_one_without_deleting_it() {
        let conn = conn();
        record(
            &conn,
            VAULT,
            STORE,
            "run-1",
            Trigger::Scheduled,
            &quiet(10),
            at("2026-08-12T12:00:00.000Z"),
        )
        .unwrap();
        record(
            &conn,
            VAULT,
            STORE,
            "run-2",
            Trigger::Scheduled,
            &quiet(20),
            at("2026-08-12T13:00:00.000Z"),
        )
        .unwrap();
        let latest = latest(&conn, VAULT, STORE).unwrap().expect("a run");
        assert_eq!(latest.run_id, "run-2");
        assert_eq!(latest.to_seq, 20);
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM convergence_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, 2, "the old reading is superseded, not deleted");
    }

    #[test]
    fn a_row_cannot_supersede_itself() {
        let conn = conn();
        record(
            &conn,
            VAULT,
            STORE,
            "run-1",
            Trigger::Scheduled,
            &quiet(10),
            at("2026-08-12T12:00:00.000Z"),
        )
        .unwrap();
        let detail = conn
            .execute(
                "UPDATE convergence_runs SET superseded_by_run_id = 'run-1'",
                [],
            )
            .unwrap_err()
            .to_string();
        assert!(detail.contains("CHECK"), "{detail}");
    }

    #[test]
    fn nothing_stored_is_authoritative_and_deleting_it_costs_nothing() {
        // The §31 claim, as a test: the row is a cache. After deleting every
        // one, the store reads as "no run yet" — not as a missing fact.
        let conn = conn();
        record(
            &conn,
            VAULT,
            STORE,
            "run-1",
            Trigger::Scheduled,
            &quiet(10),
            at("2026-08-12T12:00:00.000Z"),
        )
        .unwrap();
        conn.execute("DELETE FROM convergence_runs", []).unwrap();
        assert_eq!(latest(&conn, VAULT, STORE).unwrap(), None);
        assert_eq!(
            record(
                &conn,
                VAULT,
                STORE,
                "run-2",
                Trigger::Scheduled,
                &quiet(10),
                at("2026-08-12T14:00:00.000Z")
            )
            .unwrap(),
            Recorded::Stored,
            "recomputation is the whole recovery story"
        );
    }

    #[test]
    fn the_table_keeps_a_short_tail_rather_than_growing_forever() {
        // A row lands on every tick that moved the head. On a busy base that
        // is thousands a month, and every one of them is a reading of a
        // ledger that still has the events.
        let conn = conn();
        for seq in 1..=(KEEP as u64 + 5) {
            record(
                &conn,
                VAULT,
                STORE,
                &format!("run-{seq:03}"),
                Trigger::Scheduled,
                &quiet(seq),
                at(&format!("2026-08-12T12:00:{:02}.000Z", seq % 60)),
            )
            .unwrap();
        }
        let kept: i64 = conn
            .query_row("SELECT count(*) FROM convergence_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, KEEP as i64);
        let latest = latest(&conn, VAULT, STORE).unwrap().expect("a run");
        assert_eq!(
            latest.to_seq,
            KEEP as u64 + 5,
            "pruning the tail never touches the current one"
        );
    }

    #[test]
    fn two_stores_keep_their_own_latest() {
        let conn = conn();
        record(
            &conn,
            VAULT,
            STORE,
            "run-1",
            Trigger::Scheduled,
            &quiet(10),
            at("2026-08-12T12:00:00.000Z"),
        )
        .unwrap();
        record(
            &conn,
            VAULT,
            "other",
            "run-2",
            Trigger::OnDemand,
            &quiet(99),
            at("2026-08-12T12:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(latest(&conn, VAULT, STORE).unwrap().unwrap().to_seq, 10);
        assert_eq!(latest(&conn, VAULT, "other").unwrap().unwrap().to_seq, 99);
    }

    #[test]
    fn the_stored_hash_is_over_the_stored_bytes() {
        let conn = conn();
        let output = quiet(10);
        record(
            &conn,
            VAULT,
            STORE,
            "run-1",
            Trigger::Scheduled,
            &output,
            at("2026-08-12T12:00:00.000Z"),
        )
        .unwrap();
        let kept = latest(&conn, VAULT, STORE).unwrap().unwrap();
        assert_eq!(kept.output_content_hash, output.content_hash().unwrap());
        assert_eq!(kept.output, serde_json::to_value(&output).unwrap());
    }
}
