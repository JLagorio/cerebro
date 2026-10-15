//! The operational vault-write log (M49.10, the 2026-09 owner decision Q4).
//!
//! Every vault write a door makes is recorded here (M58.1) — in app-data,
//! beside the operational log — and never in the vault ledger: a note saved,
//! patched, created, renamed or deleted, a diagram saved, a concept or a
//! source written, a file git's Discard restored, and a page's comment
//! sidecar (M70.2) as a `vault.comment`. Each row carries the stamp its
//! door's receipt holds (`vault::receipt`): the actor (`human:me` for a
//! person), the run, and who approved a run's write. The writers that record
//! nothing are listed, with their reasons, in `vault::write::UNRECORDED`.
//! The ledger is the EPISTEMIC record: what the knowledge base believes and
//! why. This one says who touched which file, and when.
//!
//! Paths are stored as the scan lists them (`write::landing_path`), so an
//! agent's `./records/x.md`, or a folder it case-folded, reads back under the
//! one spelling every reader matches.
//!
//! An autosave burst is one row (Q3): a `vault.write` to a path whose newest
//! row is a `vault.write` by the same actor, run and approver, recorded
//! within [`COALESCE_WINDOW`], moves that row's hash and `recorded_at`
//! forward instead of adding one. The window slides with each write, and
//! `first_at` keeps when the burst began.
//!
//! Best-effort by constitution, as the shadow events were: recording never
//! fails the write it describes, and without an armed runtime DB it records
//! nothing.

use std::path::Path;

use chrono::{DateTime, Utc};

/// How long after one write the next by the same hand still joins its row.
pub const COALESCE_WINDOW: chrono::Duration = chrono::Duration::minutes(5);

/// One write, as its writer describes it. `to` only for a rename;
/// `content_hash` for a write whose bytes are known; `actor`, `run_id` and
/// `approved_by` from the write's receipt.
#[derive(Debug, Clone, Copy)]
pub struct WriteRow<'a> {
    pub kind: &'a str,
    pub path: &'a str,
    pub to: Option<&'a str>,
    pub content_hash: Option<&'a str>,
    pub actor: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub approved_by: Option<&'a str>,
}

/// Record one vault write, now, under the path the scan lists it by.
pub fn record(vault: &Path, row: &WriteRow<'_>) {
    let path = crate::vault::write::landing_path(vault, row.path);
    let to = row
        .to
        .map(|to| crate::vault::write::landing_path(vault, to).unwrap_or_else(|| to.to_string()));
    let landed = WriteRow {
        path: path.as_deref().unwrap_or(row.path),
        to: to.as_deref(),
        ..*row
    };
    super::sink::with_sink(|conn| {
        let Ok(vault_id) = super::scope::register(conn, vault) else {
            return;
        };
        if let Err(e) = record_at(conn, &vault_id, &landed, Utc::now()) {
            log::warn!("vault_writes: could not record {}: {e}", landed.kind);
        }
    });
}

/// `record` against `conn` at `now`, the path already spelled as stored.
/// A `vault.write` first tries to join the path's newest row; anything else,
/// or a write that cannot join, inserts.
pub(crate) fn record_at(
    conn: &rusqlite::Connection,
    vault_id: &str,
    row: &WriteRow<'_>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let at = stamp(now);
    if row.kind == "vault.write" {
        let joined = conn
            .execute(
                "UPDATE vault_writes SET content_hash = ?1, recorded_at = ?2 \
                 WHERE rowid = (SELECT max(rowid) FROM vault_writes \
                                WHERE vault_id = ?3 AND path = ?4) \
                 AND kind = 'vault.write' AND actor IS ?5 AND run_id IS ?6 \
                 AND approved_by IS ?7 AND recorded_at >= ?8",
                rusqlite::params![
                    row.content_hash,
                    at,
                    vault_id,
                    row.path,
                    row.actor,
                    row.run_id,
                    row.approved_by,
                    stamp(now - COALESCE_WINDOW),
                ],
            )
            .map_err(|e| e.to_string())?;
        if joined > 0 {
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO vault_writes (vault_id, kind, path, to_path, content_hash, actor, run_id, \
         approved_by, first_at, recorded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        rusqlite::params![
            vault_id,
            row.kind,
            row.path,
            row.to,
            row.content_hash,
            row.actor,
            row.run_id,
            row.approved_by,
            at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The one spelling every stored time uses (`runtime::now_utc`), for `now`.
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    );

    fn fixture(label: &str) -> (std::path::PathBuf, rusqlite::Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn at(minute: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-14T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::Duration::minutes(minute)
    }

    fn write<'a>(
        path: &'a str,
        hash: &'a str,
        actor: &'a str,
        run: Option<&'a str>,
    ) -> WriteRow<'a> {
        WriteRow {
            kind: "vault.write",
            path,
            to: None,
            content_hash: Some(hash),
            actor: Some(actor),
            run_id: run,
            approved_by: None,
        }
    }

    fn rows(conn: &rusqlite::Connection, vault: &str) -> Vec<Row> {
        let mut stmt = conn
            .prepare(
                "SELECT kind, path, to_path, content_hash, actor, run_id, approved_by, first_at, \
                 recorded_at FROM vault_writes WHERE vault_id = ?1 ORDER BY rowid",
            )
            .unwrap();
        stmt.query_map([vault], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    fn hash(c: char) -> String {
        c.to_string().repeat(64)
    }

    #[test]
    fn autosaves_coalesce_per_path_actor_and_run() {
        let (dir, conn, vault) = fixture("vault-writes-coalesce");
        let (a, b, c) = (hash('a'), hash('b'), hash('c'));
        record_at(
            &conn,
            &vault,
            &write("notes/a.md", &a, "human:me", None),
            at(0),
        )
        .unwrap();
        record_at(
            &conn,
            &vault,
            &write("notes/a.md", &b, "human:me", None),
            at(4),
        )
        .unwrap();
        // Sliding: eight minutes after the burst began, four after its last.
        record_at(
            &conn,
            &vault,
            &write("notes/a.md", &c, "human:me", None),
            at(8),
        )
        .unwrap();
        let got = rows(&conn, &vault);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].3.as_deref(), Some(c.as_str()), "the newest hash");
        assert_eq!(
            got[0].7,
            stamp(at(0)),
            "first_at keeps the burst's first write"
        );
        assert_eq!(got[0].8, stamp(at(8)), "recorded_at slides");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_actor_or_run_breaks_the_run_of_rows() {
        let (dir, conn, vault) = fixture("vault-writes-break");
        let h = hash('a');
        let path = "notes/a.md";
        record_at(&conn, &vault, &write(path, &h, "human:me", None), at(0)).unwrap();
        record_at(
            &conn,
            &vault,
            &write(path, &h, "process:scout", Some("r1")),
            at(1),
        )
        .unwrap();
        record_at(
            &conn,
            &vault,
            &write(path, &h, "process:scout", Some("r2")),
            at(2),
        )
        .unwrap();
        let approved = WriteRow {
            approved_by: Some("human:me"),
            ..write(path, &h, "process:scout", Some("r2"))
        };
        record_at(&conn, &vault, &approved, at(3)).unwrap();
        record_at(&conn, &vault, &write(path, &h, "human:me", None), at(4)).unwrap();
        // Another path never joins this one's row.
        record_at(
            &conn,
            &vault,
            &write("notes/b.md", &h, "human:me", None),
            at(4),
        )
        .unwrap();
        assert_eq!(rows(&conn, &vault).len(), 6);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_gap_past_the_window_starts_a_new_row() {
        let (dir, conn, vault) = fixture("vault-writes-gap");
        let h = hash('a');
        record_at(
            &conn,
            &vault,
            &write("notes/a.md", &h, "human:me", None),
            at(0),
        )
        .unwrap();
        record_at(
            &conn,
            &vault,
            &write("notes/a.md", &h, "human:me", None),
            at(6),
        )
        .unwrap();
        let got = rows(&conn, &vault);
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].7, stamp(at(6)));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_renames_and_deletes_never_coalesce() {
        let (dir, conn, vault) = fixture("vault-writes-kinds");
        let h = hash('a');
        let create = WriteRow {
            kind: "vault.create",
            ..write("notes/a.md", &h, "human:me", None)
        };
        record_at(&conn, &vault, &create, at(0)).unwrap();
        record_at(&conn, &vault, &create, at(0)).unwrap();
        // A write after a create is its own row: the create is no autosave.
        record_at(
            &conn,
            &vault,
            &write("notes/a.md", &h, "human:me", None),
            at(1),
        )
        .unwrap();
        let rename = WriteRow {
            kind: "vault.rename",
            to: Some("notes/b.md"),
            content_hash: None,
            ..write("notes/a.md", &h, "human:me", None)
        };
        record_at(&conn, &vault, &rename, at(2)).unwrap();
        record_at(&conn, &vault, &rename, at(2)).unwrap();
        let delete = WriteRow {
            kind: "vault.delete",
            content_hash: None,
            ..write("notes/b.md", &h, "human:me", None)
        };
        record_at(&conn, &vault, &delete, at(3)).unwrap();
        record_at(&conn, &vault, &delete, at(3)).unwrap();
        let kinds: Vec<String> = rows(&conn, &vault).into_iter().map(|r| r.0).collect();
        assert_eq!(
            kinds,
            [
                "vault.create",
                "vault.create",
                "vault.write",
                "vault.rename",
                "vault.rename",
                "vault.delete",
                "vault.delete"
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_write_carries_its_run_and_approver() {
        let (dir, conn, vault) = fixture("vault-writes-run");
        let h = hash('a');
        let approved = WriteRow {
            approved_by: Some("human:me"),
            ..write("notes/a.md", &h, "process:scout", Some("run-1"))
        };
        record_at(&conn, &vault, &approved, at(0)).unwrap();
        let got = rows(&conn, &vault);
        assert_eq!(
            (
                got[0].4.as_deref(),
                got[0].5.as_deref(),
                got[0].6.as_deref()
            ),
            (Some("process:scout"), Some("run-1"), Some("human:me"))
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_vault_write_is_recorded_operationally_not_in_the_ledger() {
        let _sink = super::super::sink::test_lock();
        let config = testutil::temp_vault("vault-writes-config");
        let vault = testutil::temp_vault("vault-writes");
        super::super::sink::arm(&config).unwrap();
        testutil::write(&vault, "items/a.md", "# A\n");
        let by = crate::vault::receipt::WriteReceipt::for_test("human:me", None);
        crate::vault::write::save_note(&vault, "items/a.md", "\n# A\n\nEdited.\n", &by).unwrap();
        crate::vault::write::rename_note(&vault, "items/a.md", "items/b.md", &by).unwrap();
        // The sink is process-global: other tests' writes may land in it
        // while it is armed, so only this vault's rows are asked for.
        let vault_id = super::super::scope::derive_vault_id(&vault);
        let got: Vec<(String, String, Option<String>, Option<String>)> =
            super::super::sink::with_sink(|conn| {
                rows(conn, &vault_id)
                    .into_iter()
                    .map(|r| (r.0, r.1, r.2, r.4))
                    .collect()
            })
            .unwrap();
        assert_eq!(
            got,
            vec![
                (
                    "vault.write".into(),
                    "items/a.md".into(),
                    None,
                    Some("human:me".into())
                ),
                (
                    "vault.rename".into(),
                    "items/a.md".into(),
                    Some("items/b.md".into()),
                    Some("human:me".into())
                ),
            ]
        );
        assert!(
            !crate::ledger::ledger_dir(&vault).exists(),
            "the ledger saw none of it"
        );
        super::super::sink::disarm();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
