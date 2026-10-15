//! The vault-write log, read back (M58.1b).
//!
//! `vault_writes` (M58.1) records who wrote which file, in which run, and who
//! allowed it. This module reads it back for one page or one run, and
//! `runtime::activity` (M64.2) reads it raw for History; both read through
//! [`ReadOnly`]: a handle SQLite refuses writes on, so a question about who
//! changed a page can never change a row.
//!
//! **Who last changed a page.** [`page_attribution`] takes the newest content
//! row for the path (a write, a create, or a rename into it — never a comment,
//! which changes no page byte) and holds its hash against the bytes on disk:
//!
//! - the same bytes: the row is the page's last change, `Recorded`;
//! - other bytes: something outside Cerebro changed the page after that row,
//!   `Unattributed`, and the row says who wrote it before that;
//! - no row: nobody recorded a write, `NotRecorded`;
//! - a `knowledge/` page either way: `Knowledge`. The ledger's reconcile and
//!   recovery projections write the bundle without a row, so "changed outside
//!   Cerebro" would be false there.
//!
//! A rename into the path is followed back to the old path's newest content
//! row, at most [`RENAME_HOPS`] times, so a moved page keeps its last writer.
//! A page's History tab (M64.2b) follows the same renames through
//! [`rename_chain`], so the rows recorded under its earlier names stay its.
//! A row whose actor is NULL reads as not recorded, never as "unattributed",
//! which here means changed outside Cerebro (CV-05).
//!
//! **What a run wrote.** [`run_writes`] reads `runs.writes_booked` first: 1 is
//! a run whose writes are all in the table, so an empty list is measured,
//! "wrote nothing"; 2 is booked, but the shell may have written elsewhere;
//! anything else (a run from before M58.1, or no row) is not recorded.
//!
//! **Who else wrote a path** (M58.3). [`writers_since`] is the one "who else
//! wrote it": the content rows for a path whose `[first_at, recorded_at]`
//! span overlaps the span from the path's previous commit to now, each actor
//! once. A run's changeset names them beside its own commit ("also edited by
//! you"), because `commit --only` takes the path's whole diff.

use serde::Serialize;

use super::ReadOnly;

/// The kinds that count as a change to a page: the one "who changed this
/// page" filter every reader shares. `vault.comment` never counts, and a
/// `vault.rename` counts only into its `to_path`.
pub const CONTENT_KINDS: [&str; 3] = ["vault.write", "vault.create", "vault.rename"];

/// How many renames into a path are followed back before giving up.
pub const RENAME_HOPS: usize = 8;

/// One recorded write, as a page's last change. `actor: None` is not
/// recorded; `approved_by` names the person who allowed a run's write.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastWrite {
    pub kind: String,
    pub actor: Option<String>,
    pub run_id: Option<String>,
    pub approved_by: Option<String>,
    /// When the write (or the last write of its autosave burst) landed.
    pub at: String,
}

/// Who last changed one page. See the module note for each state.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Attribution {
    Recorded(LastWrite),
    Unattributed(LastWrite),
    NotRecorded,
    Knowledge,
}

/// One row a run wrote, in the order it was recorded. `to` only for a rename.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageWrite {
    pub kind: String,
    pub path: String,
    pub to: Option<String>,
    pub at: String,
    pub approved_by: Option<String>,
}

/// What one run wrote. `Recorded(vec![])` is measured: it wrote nothing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", content = "writes", rename_all = "snake_case")]
pub enum RunWrites {
    Recorded(Vec<PageWrite>),
    Partial(Vec<PageWrite>),
    NotRecorded,
}

/// The newest content row for `path`, rename-followed: its hash and the
/// write it describes.
struct ContentRow {
    hash: Option<String>,
    last: LastWrite,
}

/// Who last changed `path` in `vault_id`, given the sha-256 of its bytes now.
/// `path` is spelled as the scan lists it (`write::landing_path`), as every
/// row is stored.
pub fn page_attribution(
    ro: &ReadOnly,
    vault_id: &str,
    path: &str,
    current_hash: &str,
) -> Result<Attribution, String> {
    let bundle = crate::knowledge::is_knowledge_path(path);
    let Some(row) = newest_content(ro, vault_id, path)? else {
        return Ok(if bundle {
            Attribution::Knowledge
        } else {
            Attribution::NotRecorded
        });
    };
    // A row with no hash (an import, M58.1) cannot be held against the
    // bytes; it is still the last write recorded.
    let changed = row.hash.as_deref().is_some_and(|h| h != current_hash);
    Ok(match (changed, bundle) {
        (false, _) => Attribution::Recorded(row.last),
        (true, true) => Attribution::Knowledge,
        (true, false) => Attribution::Unattributed(row.last),
    })
}

/// The newest write or create of `path`, following each newer rename into
/// it back to the path it came from.
fn newest_content(ro: &ReadOnly, vault_id: &str, path: &str) -> Result<Option<ContentRow>, String> {
    let mut path = path.to_string();
    let mut before = i64::MAX;
    for _ in 0..=RENAME_HOPS {
        let written = ro
            .query_row(
                "SELECT rowid, kind, content_hash, actor, run_id, approved_by, recorded_at \
                 FROM vault_writes WHERE vault_id = ?1 AND path = ?2 AND rowid < ?3 \
                 AND kind IN ('vault.write', 'vault.create') ORDER BY rowid DESC LIMIT 1",
                rusqlite::params![vault_id, path, before],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        ContentRow {
                            hash: r.get(2)?,
                            last: LastWrite {
                                kind: r.get(1)?,
                                actor: r.get(3)?,
                                run_id: r.get(4)?,
                                approved_by: r.get(5)?,
                                at: r.get(6)?,
                            },
                        },
                    ))
                },
            )
            .map(Some)
            .or_else(none_when_empty)?;
        let renamed = ro
            .query_row(
                "SELECT rowid, path FROM vault_writes WHERE vault_id = ?1 AND to_path = ?2 \
                 AND rowid < ?3 AND kind = 'vault.rename' ORDER BY rowid DESC LIMIT 1",
                rusqlite::params![vault_id, path, before],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .map(Some)
            .or_else(none_when_empty)?;
        match (written, renamed) {
            (Some((at, row)), Some((moved, _))) if at > moved => return Ok(Some(row)),
            (Some((_, row)), None) => return Ok(Some(row)),
            (_, Some((moved, from))) => {
                path = from;
                before = moved;
            }
            (None, None) => return Ok(None),
        }
    }
    Ok(None)
}

/// The names `path` has had, newest first: `path` itself, then the path each
/// rename into it came from, at most `hops` renames back, as
/// [`page_attribution`] follows them. A name the page held twice is listed
/// once.
pub(crate) fn rename_chain(
    ro: &ReadOnly,
    vault_id: &str,
    path: &str,
    hops: usize,
) -> Result<Vec<String>, String> {
    let mut chain = vec![path.to_string()];
    let mut current = path.to_string();
    let mut before = i64::MAX;
    for _ in 0..hops {
        let renamed = ro
            .query_row(
                "SELECT rowid, path FROM vault_writes WHERE vault_id = ?1 AND to_path = ?2 \
                 AND rowid < ?3 AND kind = 'vault.rename' ORDER BY rowid DESC LIMIT 1",
                rusqlite::params![vault_id, current, before],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .map(Some)
            .or_else(none_when_empty)?;
        let Some((moved, from)) = renamed else {
            break;
        };
        if !chain.contains(&from) {
            chain.push(from.clone());
        }
        current = from;
        before = moved;
    }
    Ok(chain)
}

/// What `run_id` wrote, as its `runs.writes_booked` lets it be said.
pub fn run_writes(ro: &ReadOnly, run_id: &str) -> Result<RunWrites, String> {
    let booked = ro
        .query_row(
            "SELECT writes_booked FROM runs WHERE run_id = ?1",
            [run_id],
            |r| r.get::<_, i64>(0),
        )
        .map(Some)
        .or_else(none_when_empty)?;
    let complete = match booked {
        Some(1) => true,
        Some(2) => false,
        _ => return Ok(RunWrites::NotRecorded),
    };
    let mut statement = ro
        .prepare(
            "SELECT kind, path, to_path, recorded_at, approved_by FROM vault_writes \
             WHERE run_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([run_id], |r| {
            Ok(PageWrite {
                kind: r.get(0)?,
                path: r.get(1)?,
                to: r.get(2)?,
                at: r.get(3)?,
                approved_by: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(if complete {
        RunWrites::Recorded(rows)
    } else {
        RunWrites::Partial(rows)
    })
}

/// One actor that wrote a path in a span (M58.3), with the run it wrote in,
/// when it wrote in one. A caller leaves out its own run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Writer {
    pub actor: String,
    pub run_id: Option<String>,
}

/// The actors whose content rows for `path` overlap `[since, until]`, in the
/// order they first wrote, each (actor, run) once. `since` None is a path
/// with no commit yet: every row up to `until` counts. Both are the stored
/// spelling, RFC 3339 with milliseconds and a `Z`. A row whose actor is NULL
/// names nobody and is left out (CV-05).
pub fn writers_since(
    ro: &ReadOnly,
    vault_id: &str,
    path: &str,
    since: Option<&str>,
    until: &str,
) -> Result<Vec<Writer>, String> {
    let mut statement = ro
        .prepare(
            "SELECT actor, run_id FROM vault_writes WHERE vault_id = ?1 \
             AND ((path = ?2 AND kind IN ('vault.write', 'vault.create')) \
                  OR (to_path = ?2 AND kind = 'vault.rename')) \
             AND actor IS NOT NULL AND (?3 IS NULL OR recorded_at >= ?3) AND first_at <= ?4 \
             ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![vault_id, path, since, until], |r| {
            Ok(Writer {
                actor: r.get(0)?,
                run_id: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut writers: Vec<Writer> = Vec::new();
    for row in rows {
        if !writers.contains(&row) {
            writers.push(row);
        }
    }
    Ok(writers)
}

/// Who a run ran as, and why it started (M58.3): `runs.actor` and the
/// `runs.cause` column as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunIdentity {
    pub actor: Option<String>,
    pub cause: Option<String>,
}

/// `run_id`'s identity, or None when the run has no row.
pub fn run_identity(ro: &ReadOnly, run_id: &str) -> Result<Option<RunIdentity>, String> {
    ro.query_row(
        "SELECT actor, cause FROM runs WHERE run_id = ?1",
        [run_id],
        |r| {
            Ok(RunIdentity {
                actor: r.get(0)?,
                cause: r.get(1)?,
            })
        },
    )
    .map(Some)
    .or_else(none_when_empty)
}

fn none_when_empty<T>(e: rusqlite::Error) -> Result<Option<T>, String> {
    match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::vault_writes::{record_at, WriteRow};
    use crate::vault::testutil;
    use chrono::{DateTime, Utc};
    use rusqlite::Connection;

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
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

    fn hash(c: char) -> String {
        c.to_string().repeat(64)
    }

    fn row<'a>(kind: &'a str, path: &'a str, hash: Option<&'a str>) -> WriteRow<'a> {
        WriteRow {
            kind,
            path,
            to: None,
            content_hash: hash,
            actor: Some("human:me"),
            run_id: None,
            approved_by: None,
        }
    }

    fn read(dir: &std::path::Path, vault: &str, path: &str, hash: &str) -> Attribution {
        let ro = ReadOnly::open(dir).unwrap();
        page_attribution(&ro, vault, path, hash).unwrap()
    }

    fn done(dir: std::path::PathBuf, conn: Connection) {
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_editor_save_reads_human_me() {
        let (dir, conn, vault) = fixture("write-log-editor");
        let h = hash('a');
        record_at(
            &conn,
            &vault,
            &row("vault.write", "notes/a.md", Some(&h)),
            at(0),
        )
        .unwrap();
        let Attribution::Recorded(last) = read(&dir, &vault, "notes/a.md", &h) else {
            panic!("an editor save is recorded");
        };
        assert_eq!(last.actor.as_deref(), Some("human:me"));
        assert_eq!(last.run_id, None);
        assert_eq!(last.kind, "vault.write");
        assert_eq!(last.at, "2026-10-14T09:00:00.000Z");
        done(dir, conn);
    }

    #[test]
    fn a_run_write_reads_its_actor_and_run() {
        let (dir, conn, vault) = fixture("write-log-run");
        let h = hash('b');
        let mut write = row("vault.write", "records/risks/x.md", Some(&h));
        write.actor = Some("process:release-scout");
        write.run_id = Some("run-1");
        write.approved_by = Some("human:me");
        record_at(&conn, &vault, &write, at(0)).unwrap();
        let got = read(&dir, &vault, "records/risks/x.md", &h);
        assert_eq!(
            got,
            Attribution::Recorded(LastWrite {
                kind: "vault.write".into(),
                actor: Some("process:release-scout".into()),
                run_id: Some("run-1".into()),
                approved_by: Some("human:me".into()),
                at: "2026-10-14T09:00:00.000Z".into(),
            })
        );
        let wire = serde_json::to_value(&got).unwrap();
        assert_eq!(wire["state"], "recorded");
        assert_eq!(wire["run_id"], "run-1");
        done(dir, conn);
    }

    #[test]
    fn bytes_changed_after_the_last_write_read_unattributed() {
        let (dir, conn, vault) = fixture("write-log-outside");
        let (old, now) = (hash('a'), hash('c'));
        record_at(
            &conn,
            &vault,
            &row("vault.write", "notes/a.md", Some(&old)),
            at(0),
        )
        .unwrap();
        let Attribution::Unattributed(last) = read(&dir, &vault, "notes/a.md", &now) else {
            panic!("other bytes than the last write's are an outside change");
        };
        assert_eq!(
            last.actor.as_deref(),
            Some("human:me"),
            "it names who wrote before"
        );
        let wire = serde_json::to_value(read(&dir, &vault, "notes/a.md", &now)).unwrap();
        assert_eq!(wire["state"], "unattributed");
        done(dir, conn);
    }

    #[test]
    fn no_row_reads_not_recorded() {
        let (dir, conn, vault) = fixture("write-log-none");
        let h = hash('a');
        record_at(
            &conn,
            &vault,
            &row("vault.write", "notes/other.md", Some(&h)),
            at(0),
        )
        .unwrap();
        // A comment changes no page byte, so it is no last change.
        record_at(
            &conn,
            &vault,
            &row("vault.comment", "notes/a.md", None),
            at(1),
        )
        .unwrap();
        let got = read(&dir, &vault, "notes/a.md", &h);
        assert_eq!(got, Attribution::NotRecorded);
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            serde_json::json!({ "state": "not_recorded" })
        );
        done(dir, conn);
    }

    #[test]
    fn a_null_actor_reads_not_recorded() {
        let (dir, conn, vault) = fixture("write-log-null-actor");
        let h = hash('a');
        // A row from before receipts (v17) carries no actor.
        let mut write = row("vault.write", "notes/a.md", Some(&h));
        write.actor = None;
        record_at(&conn, &vault, &write, at(0)).unwrap();
        let Attribution::Recorded(last) = read(&dir, &vault, "notes/a.md", &h) else {
            panic!("the write is recorded, its writer is not");
        };
        assert_eq!(last.actor, None);
        let wire = serde_json::to_value(Attribution::Recorded(last)).unwrap();
        assert_eq!(wire["actor"], serde_json::Value::Null);
        done(dir, conn);
    }

    #[test]
    fn a_renamed_page_keeps_its_last_writer() {
        let (dir, conn, vault) = fixture("write-log-rename");
        let h = hash('d');
        let mut write = row("vault.create", "notes/a.md", Some(&h));
        write.actor = Some("claude-code");
        write.run_id = Some("run-2");
        record_at(&conn, &vault, &write, at(0)).unwrap();
        let mut first = row("vault.rename", "notes/a.md", None);
        first.to = Some("notes/b.md");
        record_at(&conn, &vault, &first, at(1)).unwrap();
        let mut second = row("vault.rename", "notes/b.md", None);
        second.to = Some("archive/c.md");
        record_at(&conn, &vault, &second, at(2)).unwrap();
        let Attribution::Recorded(last) = read(&dir, &vault, "archive/c.md", &h) else {
            panic!("two moves later, the page keeps its writer");
        };
        assert_eq!(last.actor.as_deref(), Some("claude-code"));
        assert_eq!(last.run_id.as_deref(), Some("run-2"));
        assert_eq!(last.kind, "vault.create");

        // A write after the move is the newer change.
        let h2 = hash('e');
        record_at(
            &conn,
            &vault,
            &row("vault.write", "archive/c.md", Some(&h2)),
            at(3),
        )
        .unwrap();
        let Attribution::Recorded(last) = read(&dir, &vault, "archive/c.md", &h2) else {
            panic!("recorded");
        };
        assert_eq!(last.actor.as_deref(), Some("human:me"));
        done(dir, conn);
    }

    #[test]
    fn a_rename_chain_past_the_hop_limit_reads_not_recorded() {
        let (dir, conn, vault) = fixture("write-log-hops");
        let h = hash('a');
        record_at(&conn, &vault, &row("vault.write", "p0.md", Some(&h)), at(0)).unwrap();
        let names: Vec<String> = (0..=RENAME_HOPS + 1).map(|i| format!("p{i}.md")).collect();
        for (i, pair) in names.windows(2).enumerate() {
            let mut moved = row("vault.rename", &pair[0], None);
            moved.to = Some(&pair[1]);
            record_at(&conn, &vault, &moved, at(1 + i as i64)).unwrap();
        }
        let last = names.last().unwrap();
        assert_eq!(read(&dir, &vault, last, &h), Attribution::NotRecorded);
        let within = &names[RENAME_HOPS];
        assert!(
            matches!(read(&dir, &vault, within, &h), Attribution::Recorded(_)),
            "{RENAME_HOPS} moves are followed"
        );
        done(dir, conn);
    }

    #[test]
    fn rename_chain_follows_renames_back_at_most_eight_hops() {
        let (dir, conn, vault) = fixture("write-log-chain");
        assert_eq!(RENAME_HOPS, 8);
        let names: Vec<String> = (0..=RENAME_HOPS + 1).map(|i| format!("p{i}.md")).collect();
        for (i, pair) in names.windows(2).enumerate() {
            let mut moved = row("vault.rename", &pair[0], None);
            moved.to = Some(&pair[1]);
            record_at(&conn, &vault, &moved, at(i as i64)).unwrap();
        }
        // An unrelated rename names neither end.
        let mut other = row("vault.rename", "x.md", None);
        other.to = Some("y.md");
        record_at(&conn, &vault, &other, at(20)).unwrap();
        let ro = ReadOnly::open(&dir).unwrap();
        let newest = names.last().unwrap();
        let chain = rename_chain(&ro, &vault, newest, RENAME_HOPS).unwrap();
        let expected: Vec<String> = names.iter().rev().take(RENAME_HOPS + 1).cloned().collect();
        assert_eq!(chain, expected, "the page and its eight earlier names");
        assert!(
            !chain.contains(&names[0]),
            "a ninth rename back is not followed"
        );
        assert_eq!(
            rename_chain(&ro, &vault, "never-moved.md", RENAME_HOPS).unwrap(),
            vec!["never-moved.md".to_string()]
        );
        drop(ro);

        // A page moved away and back lists each name once.
        let mut away = row("vault.rename", "a.md", None);
        away.to = Some("b.md");
        record_at(&conn, &vault, &away, at(30)).unwrap();
        let mut back = row("vault.rename", "b.md", None);
        back.to = Some("a.md");
        record_at(&conn, &vault, &back, at(31)).unwrap();
        let ro = ReadOnly::open(&dir).unwrap();
        assert_eq!(
            rename_chain(&ro, &vault, "a.md", RENAME_HOPS).unwrap(),
            vec!["a.md".to_string(), "b.md".to_string()]
        );
        drop(ro);
        done(dir, conn);
    }

    #[test]
    fn a_bundle_page_changed_outside_a_door_reads_knowledge() {
        let (dir, conn, vault) = fixture("write-log-bundle");
        let (h, other) = (hash('a'), hash('b'));
        let path = "knowledge/systems/x.md";
        assert_eq!(read(&dir, &vault, path, &h), Attribution::Knowledge);
        let mut door = row("vault.write", path, Some(&h));
        door.actor = Some("process:knowledge");
        door.run_id = Some("run-k");
        record_at(&conn, &vault, &door, at(0)).unwrap();
        assert!(
            matches!(read(&dir, &vault, path, &h), Attribution::Recorded(_)),
            "a door's write still reads as its writer"
        );
        let projected = read(&dir, &vault, path, &other);
        assert_eq!(projected, Attribution::Knowledge, "reconcile writes no row");
        assert_eq!(
            serde_json::to_value(&projected).unwrap(),
            serde_json::json!({ "state": "knowledge" })
        );
        done(dir, conn);
    }

    #[test]
    fn an_agent_write_spelled_another_way_reads_its_actor() {
        let (dir, conn, vault) = fixture("write-log-landing");
        std::fs::create_dir_all(dir.join("records/risks")).unwrap();
        let h = hash('f');
        // As vault_writes::record stores it: under the scan's spelling.
        let landed = crate::vault::write::landing_path(&dir, "./records/risks/x.md").unwrap();
        assert_eq!(landed, "records/risks/x.md");
        // Where the disk folds case, a case-folded folder lands there too.
        if dir.join("RECORDS").exists() {
            let folded = crate::vault::write::landing_path(&dir, "Records/Risks/x.md").unwrap();
            assert_eq!(folded, "records/risks/x.md");
        }
        let mut write = row("vault.write", &landed, Some(&h));
        write.actor = Some("process:release-scout");
        write.run_id = Some("run-3");
        record_at(&conn, &vault, &write, at(0)).unwrap();
        let Attribution::Recorded(last) = read(&dir, &vault, "records/risks/x.md", &h) else {
            panic!("the scan's spelling finds the agent's row");
        };
        assert_eq!(last.actor.as_deref(), Some("process:release-scout"));
        done(dir, conn);
    }

    fn seed_run(conn: &Connection, vault: &str, run_id: &str, booked: i64) {
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, ended_at, \
             outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
             rejected, writes_booked) \
             VALUES (?1, ?2, 'store', 'ambient', 'scheduled', '2026-10-14T09:00:00Z', \
             '2026-10-14T09:01:00Z', 'succeeded', 'exact', 1, 1, 0, 0, 0, 0, 0, 0, 0, ?3)",
            rusqlite::params![run_id, vault, booked],
        )
        .unwrap();
    }

    #[test]
    fn run_writes_separates_wrote_nothing_partial_and_not_recorded() {
        let (dir, conn, vault) = fixture("write-log-run-writes");
        seed_run(&conn, &vault, "complete", 1);
        seed_run(&conn, &vault, "silent", 1);
        seed_run(&conn, &vault, "shell", 2);
        seed_run(&conn, &vault, "old", 0);
        let h = hash('a');
        for (run, path) in [("complete", "records/a.md"), ("shell", "records/b.md")] {
            let mut write = row("vault.create", path, Some(&h));
            write.actor = Some("process:scout");
            write.run_id = Some(run);
            record_at(&conn, &vault, &write, at(0)).unwrap();
        }
        let ro = ReadOnly::open(&dir).unwrap();
        let RunWrites::Recorded(rows) = run_writes(&ro, "complete").unwrap() else {
            panic!("booked complete");
        };
        assert_eq!(
            rows,
            vec![PageWrite {
                kind: "vault.create".into(),
                path: "records/a.md".into(),
                to: None,
                at: "2026-10-14T09:00:00.000Z".into(),
                approved_by: None,
            }]
        );
        assert_eq!(
            run_writes(&ro, "silent").unwrap(),
            RunWrites::Recorded(vec![]),
            "booked and empty: it wrote nothing"
        );
        let RunWrites::Partial(rows) = run_writes(&ro, "shell").unwrap() else {
            panic!("booked partial");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(run_writes(&ro, "old").unwrap(), RunWrites::NotRecorded);
        assert_eq!(run_writes(&ro, "nope").unwrap(), RunWrites::NotRecorded);
        let wire = serde_json::to_value(run_writes(&ro, "silent").unwrap()).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "state": "recorded", "writes": [] })
        );
        assert_eq!(
            serde_json::to_value(RunWrites::NotRecorded).unwrap(),
            serde_json::json!({ "state": "not_recorded" })
        );
        drop(ro);
        done(dir, conn);
    }

    /// Who else wrote a run's path (M58.3): your edit after the path's last
    /// commit and before the run, the run's own row (its caller leaves it
    /// out) and a rename into it count; an edit before that commit, a write
    /// after `until`, another path and a comment do not.
    #[test]
    fn writers_since_names_other_actors_on_the_runs_paths() {
        let (dir, conn, vault) = fixture("write-log-writers-since");
        let h = hash('a');
        let path = "notes/a.md";
        // Before the path's last commit (minute 5): already in history.
        record_at(&conn, &vault, &row("vault.write", path, Some(&h)), at(0)).unwrap();
        // After it, before the run: rides along in the run's commit.
        record_at(&conn, &vault, &row("vault.write", path, Some(&h)), at(10)).unwrap();
        let mut run = row("vault.write", path, Some(&h));
        run.actor = Some("process:scout");
        run.run_id = Some("run-1");
        record_at(&conn, &vault, &run, at(12)).unwrap();
        let mut other = row("vault.write", "notes/b.md", Some(&h));
        other.actor = Some("process:other");
        record_at(&conn, &vault, &other, at(13)).unwrap();
        let mut comment = row("vault.comment", path, None);
        comment.actor = Some("process:commenter");
        record_at(&conn, &vault, &comment, at(13)).unwrap();
        let mut moved = row("vault.rename", "notes/old.md", None);
        moved.to = Some(path);
        moved.actor = Some("claude-code");
        record_at(&conn, &vault, &moved, at(14)).unwrap();
        let mut late = row("vault.write", path, Some(&h));
        late.actor = Some("process:late");
        record_at(&conn, &vault, &late, at(30)).unwrap();

        let ro = ReadOnly::open(&dir).unwrap();
        let since = "2026-10-14T09:05:00.000Z";
        let until = "2026-10-14T09:20:00.000Z";
        let writers = writers_since(&ro, &vault, path, Some(since), until).unwrap();
        let named = |actor: &str, run: Option<&str>| Writer {
            actor: actor.into(),
            run_id: run.map(str::to_string),
        };
        assert_eq!(
            writers,
            vec![
                named("human:me", None),
                named("process:scout", Some("run-1")),
                named("claude-code", None),
            ]
        );
        // A path with no commit yet: every row up to `until`, the first once.
        let all = writers_since(&ro, &vault, path, None, until).unwrap();
        assert_eq!(all[0], named("human:me", None));
        assert_eq!(all.len(), 3);
        drop(ro);
        done(dir, conn);
    }

    /// The read model cannot write: no statement runner, no pragma setter and
    /// no writable handle appear in its non-test source.
    #[test]
    fn write_log_reads_never_write() {
        let source = include_str!("write_log.rs");
        let body = &source[..source.find("#[cfg(test)]").unwrap()];
        for word in ["execute", "execute_batch", "pragma_update", "Connection"] {
            assert!(!body.contains(word), "write_log.rs names {word}");
        }
    }
}
