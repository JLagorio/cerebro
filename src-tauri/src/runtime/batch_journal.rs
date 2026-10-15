//! The batch journal (M60.6): what a database-wide change in flight would
//! need to be put back.
//!
//! `vault::batch` writes one row before it stages a byte (`begin`), marks it
//! `applying` before its first rename (`mark_applying`) and deletes it once
//! every rename landed (`finish`): that delete is the batch's commit point.
//! A row still here at the next launch is a batch that stopped partway, and
//! `vault::batch::recover` rolls it back (`pending`).
//!
//! Every call goes through the armed sink (`sink::with_sink`). Its mutex is a
//! leaf lock: the batch takes it under the path locks (M55.1's order) and
//! never holds it while it takes another. Unarmed, every call is an error,
//! not a no-op: a batch with nowhere to write its pre-images refuses to start
//! rather than run without a way back.
//!
//! Operational, never the ledger (CV-06): the rows say how to undo a crash,
//! not what the knowledge base believes.

use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::sink;

/// What a batch call says when the runtime database is not open.
pub const UNAVAILABLE: &str = "the runtime database isn't open";

/// One page a batch writes, as recovery reads it back.
///
/// `before` is the bytes the page held before the batch, `None` when it was
/// absent; for a restore it is the Trash item's bytes, the ones the restore
/// brings back. `temp` is the vault-relative temp a write staged; `trashed`
/// the stamp a delete moves the page into; `restored` the stamp a restore
/// takes it from; `sidecar` the comment file that travels with it. Hashes are
/// SHA-256 hex; `after_hash` is `None` for a page the batch leaves absent.
/// `moved_from` is a rename's source (M60.10); its `path` is the destination.
/// Renames follow the pre-images, so recovery reverses moves before bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalFile {
    pub path: String,
    pub temp: Option<String>,
    pub before: Option<String>,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub trashed: Option<String>,
    pub restored: Option<String>,
    pub sidecar: Option<String>,
    pub moved_from: Option<String>,
}

/// One batch in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRow {
    pub batch_id: String,
    pub vault_id: String,
    pub state: String,
    pub files: Vec<JournalFile>,
    pub actor: String,
    pub started_at: String,
}

/// Run `f` against the armed runtime database, or say it is not open.
fn armed<T>(f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    sink::with_sink(f).unwrap_or_else(|| Err(UNAVAILABLE.to_string()))
}

/// Write a batch's row, `staged`, before any temp exists. Err when the sink
/// is unarmed or the insert fails, and then the batch writes nothing.
pub fn begin(
    vault: &Path,
    batch_id: &str,
    files: &[JournalFile],
    actor: &str,
) -> Result<(), String> {
    let json = serde_json::to_string(files).map_err(|e| e.to_string())?;
    armed(|conn| {
        let vault_id = super::scope::register(conn, vault)?;
        conn.execute(
            "INSERT INTO batch_journal (batch_id, vault_id, state, files, actor, started_at) \
             VALUES (?1, ?2, 'staged', ?3, ?4, ?5)",
            params![batch_id, vault_id, json, actor, super::now_utc()],
        )
        .map(drop)
        .map_err(|e| format!("batch journal: {e}"))
    })
}

/// The batch is about to rename its first file.
pub fn mark_applying(batch_id: &str) -> Result<(), String> {
    armed(|conn| {
        let changed = conn
            .execute(
                "UPDATE batch_journal SET state = 'applying' WHERE batch_id = ?1",
                [batch_id],
            )
            .map_err(|e| format!("batch journal: {e}"))?;
        if changed == 1 {
            Ok(())
        } else {
            Err(format!("batch journal: no row for {batch_id}"))
        }
    })
}

/// Delete a batch's row: the commit point, or the end of a rollback.
/// Deleting a row that is already gone is not an error.
pub fn finish(batch_id: &str) -> Result<(), String> {
    armed(|conn| {
        conn.execute("DELETE FROM batch_journal WHERE batch_id = ?1", [batch_id])
            .map(drop)
            .map_err(|e| format!("batch journal: {e}"))
    })
}

/// Read one row, `None` when it is gone.
pub fn get(batch_id: &str) -> Result<Option<JournalRow>, String> {
    armed(|conn| {
        conn.query_row(
            "SELECT batch_id, vault_id, state, files, actor, started_at FROM batch_journal \
             WHERE batch_id = ?1",
            [batch_id],
            row_of,
        )
        .optional()
        .map_err(|e| format!("batch journal: {e}"))?
        .transpose()
    })
}

/// The rows `vault` left unfinished that started before `started_before`
/// (`now_utc`'s spelling), oldest first. A row this process started after
/// that line belongs to a batch it may still be running.
pub fn pending(vault: &Path, started_before: &str) -> Result<Vec<JournalRow>, String> {
    armed(|conn| {
        let vault_id = super::scope::register(conn, vault)?;
        let mut stmt = conn
            .prepare(
                "SELECT batch_id, vault_id, state, files, actor, started_at FROM batch_journal \
                 WHERE vault_id = ?1 AND started_at < ?2 ORDER BY started_at, batch_id",
            )
            .map_err(|e| format!("batch journal: {e}"))?;
        let rows = stmt
            .query_map(params![vault_id, started_before], row_of)
            .map_err(|e| format!("batch journal: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("batch journal: {e}"))?;
        rows.into_iter().collect()
    })
}

/// One row, with its files parsed. A files column that does not parse is
/// an error, never an empty list: an empty list would roll nothing back.
fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<JournalRow, String>> {
    let files: String = row.get(3)?;
    let batch_id: String = row.get(0)?;
    Ok(match serde_json::from_str::<Vec<JournalFile>>(&files) {
        Ok(files) => Ok(JournalRow {
            batch_id,
            vault_id: row.get(1)?,
            state: row.get(2)?,
            files,
            actor: row.get(4)?,
            started_at: row.get(5)?,
        }),
        Err(e) => Err(format!(
            "batch journal: {batch_id}'s files can't be read: {e}"
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn file(path: &str) -> JournalFile {
        JournalFile {
            path: path.to_string(),
            temp: Some(format!("records/.{path}.cerebro-batch-00000000deadbeef")),
            before: Some("---\nstatus: todo\n---\n\n# A\n".to_string()),
            before_hash: Some("a".repeat(64)),
            after_hash: Some("b".repeat(64)),
            trashed: None,
            restored: None,
            sidecar: Some(format!(".comments/{path}.json")),
            moved_from: None,
        }
    }

    /// The sink armed for one test, disarmed when it drops.
    struct Armed {
        _lock: std::sync::MutexGuard<'static, ()>,
        config: std::path::PathBuf,
    }

    impl Armed {
        fn new(label: &str) -> Self {
            let lock = sink::test_lock();
            let config = testutil::temp_vault(label);
            sink::arm(&config).unwrap();
            Self {
                _lock: lock,
                config,
            }
        }
    }

    impl Drop for Armed {
        fn drop(&mut self) {
            sink::disarm();
            let _ = std::fs::remove_dir_all(&self.config);
        }
    }

    const FAR_FUTURE: &str = "9999-12-31T00:00:00.000Z";

    #[test]
    fn a_row_round_trips() {
        let _armed = Armed::new("journal-round-trip-config");
        let vault = testutil::temp_vault("journal-round-trip");
        let id = "c".repeat(32);
        let files = vec![file("records/a.md"), file("records/b.md")];
        begin(&vault, &id, &files, "human:me").unwrap();
        let row = get(&id).unwrap().unwrap();
        assert_eq!((row.state.as_str(), &row.files), ("staged", &files));
        assert_eq!(row.actor, "human:me");
        mark_applying(&id).unwrap();
        assert_eq!(get(&id).unwrap().unwrap().state, "applying");
        assert_eq!(pending(&vault, FAR_FUTURE).unwrap().len(), 1);
        assert!(
            pending(&vault, "2000-01-01T00:00:00.000Z")
                .unwrap()
                .is_empty(),
            "a row started after the cutoff is not pending"
        );
        finish(&id).unwrap();
        assert_eq!(get(&id).unwrap(), None);
        finish(&id).unwrap();
        assert!(mark_applying(&id).is_err(), "no row to mark");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn rows_are_kept_per_vault() {
        let _armed = Armed::new("journal-per-vault-config");
        let one = testutil::temp_vault("journal-vault-one");
        let two = testutil::temp_vault("journal-vault-two");
        begin(&one, &"1".repeat(32), &[file("a.md")], "human:me").unwrap();
        begin(&two, &"2".repeat(32), &[file("b.md")], "human:me").unwrap();
        let ids = |vault: &Path| -> Vec<String> {
            pending(vault, FAR_FUTURE)
                .unwrap()
                .into_iter()
                .map(|row| row.batch_id)
                .collect()
        };
        assert_eq!(ids(&one), vec!["1".repeat(32)]);
        assert_eq!(ids(&two), vec!["2".repeat(32)]);
        for dir in [&one, &two] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn begin_refuses_when_unarmed() {
        let _lock = sink::test_lock();
        sink::disarm();
        let vault = testutil::temp_vault("journal-unarmed");
        let err = begin(&vault, &"d".repeat(32), &[file("a.md")], "human:me").unwrap_err();
        assert_eq!(err, UNAVAILABLE);
        assert_eq!(pending(&vault, FAR_FUTURE).unwrap_err(), UNAVAILABLE);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
