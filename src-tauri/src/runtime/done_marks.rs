//! Revision-aware Done marks; shared behavior cases: reminder-state-cases.json.
use super::reminders::bounded;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub lane: String,
    pub subject: String,
    pub until: String,
    pub revision: Option<String>,
    pub marked_at: String,
}
#[derive(Debug, Serialize)]
pub struct MarkResult {
    pub set: Mark,
    pub replaced: Option<Mark>,
}
fn parse(v: &Value, now: &str) -> Result<Mark, String> {
    let lane = v["lane"].as_str().unwrap_or_default();
    if !matches!(lane, "insight" | "run" | "reminder" | "change") {
        return Err("A Done lane must be insight, run, reminder or change.".into());
    }
    if !bounded(&v["subject"], 1024) {
        return Err("A Done subject must have 1 to 1024 characters.".into());
    }
    let until = v["until"].as_str().unwrap_or_default();
    if !matches!(until, "revision" | "forever") {
        return Err("A Done mark must last for a revision or forever.".into());
    }
    if if until == "revision" {
        !bounded(&v["revision"], 256)
    } else {
        !v["revision"].is_null() || v.get("revision").is_none()
    } {
        return Err("A revision Done mark needs a revision; a forever mark must have none.".into());
    }
    Ok(Mark {
        lane: lane.into(),
        subject: v["subject"].as_str().unwrap_or_default().into(),
        until: until.into(),
        revision: v["revision"].as_str().map(str::to_owned),
        marked_at: now.into(),
    })
}
fn exact(v: &Value) -> Result<Mark, String> {
    let mut mark = parse(v, "")?;
    let at = v["markedAt"].as_str().unwrap_or_default();
    if !at.ends_with('Z') || chrono::DateTime::parse_from_rfc3339(at).is_err() {
        return Err("A Done mark must name its recorded UTC time.".into());
    }
    mark.marked_at = at.into();
    Ok(mark)
}
fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Mark> {
    Ok(Mark {
        lane: r.get(0)?,
        subject: r.get(1)?,
        until: r.get(2)?,
        revision: r.get(3)?,
        marked_at: r.get(4)?,
    })
}
fn read(conn: &Connection, vault: &str, lane: &str, subject: &str) -> Result<Option<Mark>, String> {
    conn.query_row(
        "SELECT lane,subject,until,revision,marked_at FROM done_marks \
        WHERE vault_id=?1 AND lane=?2 AND subject=?3",
        params![vault, lane, subject],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}
fn insert(conn: &Connection, vault: &str, mark: &Mark, replace: bool) -> Result<usize, String> {
    let conflict = if replace {
        "DO UPDATE SET until=excluded.until,revision=excluded.revision,marked_at=excluded.marked_at"
    } else {
        "DO NOTHING"
    };
    conn.execute(
        &format!(
            "INSERT INTO done_marks (vault_id,lane,subject,until,revision,marked_at) \
        VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT (vault_id,lane,subject) {conflict}"
        ),
        params![
            vault,
            mark.lane,
            mark.subject,
            mark.until,
            mark.revision,
            mark.marked_at
        ],
    )
    .map_err(|e| e.to_string())
}
pub fn read_all(conn: &Connection, vault: &str) -> Result<Vec<Mark>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT lane,subject,until,revision,marked_at FROM done_marks \
        WHERE vault_id=?1 ORDER BY lane,subject",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([vault], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string());
    rows
}
pub fn mark(
    conn: &Connection,
    vault: &str,
    value: &Value,
    now: &str,
) -> Result<MarkResult, String> {
    let mut set = parse(value, now)?;
    // IMMEDIATE obtains the write seat before reading the replaced mark.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let replaced = read(conn, vault, &set.lane, &set.subject)?;
        // Keep the mint clock after Undo too. A clock that repeats or moves
        // backwards must not make an old toast name a newly created mark.
        let last = super::settings::get(conn, "done.last_marked_at", Some(vault))?;
        let previous = last
            .as_deref()
            .into_iter()
            .chain(replaced.as_ref().map(|m| m.marked_at.as_str()))
            .filter_map(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .max();
        if let (Some(old), Ok(new)) = (previous, chrono::DateTime::parse_from_rfc3339(now)) {
            if new <= old {
                set.marked_at = (old + chrono::Duration::nanoseconds(1))
                    .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
            }
        }
        super::settings::set(conn, "done.last_marked_at", Some(vault), &set.marked_at)?;
        insert(conn, vault, &set, true)?;
        Ok(MarkResult { set, replaced })
    })();
    match result {
        Ok(result) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(result)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
/// Compare and restore in one transaction: Undo never overwrites a newer Done.
pub fn unmark(
    conn: &Connection,
    vault: &str,
    value: &Value,
    restore: Option<&Value>,
) -> Result<bool, String> {
    let set = exact(value)?;
    let previous = restore.map(exact).transpose()?;
    if previous
        .as_ref()
        .is_some_and(|p| p.lane != set.lane || p.subject != set.subject)
    {
        return Err("Undo must restore the same Done subject and lane.".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "DELETE FROM done_marks WHERE vault_id=?1 AND lane=?2 AND subject=?3 \
        AND until=?4 AND revision IS ?5 AND marked_at=?6",
            params![
                vault,
                set.lane,
                set.subject,
                set.until,
                set.revision,
                set.marked_at
            ],
        )
        .map_err(|e| e.to_string())?
        != 0;
    if changed {
        if let Some(previous) = previous {
            insert(&tx, vault, &previous, false)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}
pub fn import(
    conn: &Connection,
    vault: &str,
    values: &[Value],
    now: &str,
) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The marker and imported rows commit together. Undoing the last old
    // dismissal must never make the next launch import it again.
    let fresh=tx.execute("INSERT INTO settings (key,vault_id,value) VALUES (?1,?2,'true') ON CONFLICT DO NOTHING",
        params!["upgrade.done_marks_imported",vault]).map_err(|e|e.to_string())?;
    if fresh == 0 {
        return Ok(0);
    }
    let mut count = 0;
    for value in values {
        let mut value = value.clone();
        if let Some(object) = value.as_object_mut() {
            object.insert("until".into(), Value::from("forever"));
            object.insert("revision".into(), Value::Null);
        }
        if let Ok(mark) = parse(&value, now) {
            count += insert(&tx, vault, &mark, false)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/reminder-state-cases.json")).unwrap()
    }
    fn setup(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = crate::vault::testutil::temp_vault(label);
        let conn = super::super::open(&dir).unwrap();
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }
    #[test]
    fn marks_replay_the_shared_cases() {
        let f = fixture();
        let (dir, conn, vault) = setup("done-cases");
        let now = f["now"].as_str().unwrap();
        for bad in f["badMarks"].as_array().unwrap() {
            let mut value = f["mark"].clone();
            for (k, v) in bad["patch"].as_object().unwrap() {
                value[k] = v.clone();
            }
            assert_eq!(
                mark(&conn, &vault, &value, now).unwrap_err(),
                bad["error"].as_str().unwrap()
            );
            assert!(read_all(&conn, &vault).unwrap().is_empty());
        }
        for lane in f["lanes"].as_array().unwrap() {
            let mut value = f["mark"].clone();
            value["lane"] = lane.clone();
            assert!(mark(&conn, &vault, &value, now).unwrap().replaced.is_none());
        }
        let first = read(
            &conn,
            &vault,
            "insight",
            f["mark"]["subject"].as_str().unwrap(),
        )
        .unwrap()
        .unwrap();
        let second = mark(
            &conn,
            &vault,
            &f["replacement"],
            f["later"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(second.replaced, Some(first.clone()));
        assert!(!unmark(&conn, &vault, &serde_json::to_value(&first).unwrap(), None).unwrap());
        let mut bad = serde_json::to_value(&second.set).unwrap();
        bad["markedAt"] = f["badStamp"]["markedAt"].clone();
        assert_eq!(
            unmark(&conn, &vault, &bad, None).unwrap_err(),
            f["badStamp"]["error"].as_str().unwrap()
        );
        let mut other = serde_json::to_value(&first).unwrap();
        other["subject"] = f["badRestore"]["subject"].clone();
        assert_eq!(
            unmark(
                &conn,
                &vault,
                &serde_json::to_value(&second.set).unwrap(),
                Some(&other)
            )
            .unwrap_err(),
            f["badRestore"]["error"].as_str().unwrap()
        );
        assert!(unmark(
            &conn,
            &vault,
            &serde_json::to_value(&second.set).unwrap(),
            Some(&serde_json::to_value(&first).unwrap())
        )
        .unwrap());
        assert_eq!(
            read(&conn, &vault, &first.lane, &first.subject).unwrap(),
            Some(first.clone())
        );
        let imports = vec![
            f["replacement"].clone(),
            Value::Null,
            f["importedMark"].clone(),
        ];
        assert_eq!(import(&conn, &vault, &imports, now).unwrap(), 1);
        assert_eq!(import(&conn, &vault, &imports, now).unwrap(), 0);
        assert_eq!(
            read(&conn, &vault, &first.lane, &first.subject).unwrap(),
            Some(first)
        );
        let imported = read(&conn, &vault, "change", "legacy").unwrap().unwrap();
        assert_eq!(imported.until, "forever");
        assert_eq!(imported.revision, None);
        assert!(unmark(
            &conn,
            &vault,
            &serde_json::to_value(imported).unwrap(),
            None
        )
        .unwrap());
        assert_eq!(
            import(&conn, &vault, &[f["importedMark"].clone()], now).unwrap(),
            f["importCounts"]["afterUndo"].as_u64().unwrap() as usize
        );
        assert!(read(&conn, &vault, "change", "legacy").unwrap().is_none());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn two_vaults_never_share_a_mark() {
        let f = fixture();
        let (dir, conn, a) = setup("done-vaults");
        let bdir = dir.join("b");
        std::fs::create_dir_all(&bdir).unwrap();
        let b = super::super::scope::register(&conn, &bdir).unwrap();
        for vault in [a, b] {
            assert!(mark(&conn, &vault, &f["mark"], f["now"].as_str().unwrap())
                .unwrap()
                .replaced
                .is_none());
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn forever_carries_no_revision_and_revision_needs_one() {
        let (dir, conn, vault) = setup("done-schema");
        for (lane, until, revision) in [
            ("insight", "forever", Some("a")),
            ("run", "revision", None),
            ("unknown", "forever", None),
        ] {
            assert!(conn
                .execute(
                    "INSERT INTO done_marks VALUES (?1,?2,'x',?3,?4,'2026-07-28T12:00:00Z')",
                    params![vault, lane, until, revision]
                )
                .is_err());
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn even_two_identical_marks_in_one_tick_have_distinct_undo_identity() {
        let f = fixture();
        let (dir, conn, vault) = setup("done-identity");
        let now = f["now"].as_str().unwrap();
        let first = mark(&conn, &vault, &f["mark"], now).unwrap();
        let second = mark(&conn, &vault, &f["mark"], now).unwrap();
        assert_ne!(first.set.marked_at, second.set.marked_at);
        assert!(!unmark(
            &conn,
            &vault,
            &serde_json::to_value(&first.set).unwrap(),
            None
        )
        .unwrap());
        assert!(unmark(
            &conn,
            &vault,
            &serde_json::to_value(&second.set).unwrap(),
            Some(&serde_json::to_value(&first.set).unwrap())
        )
        .unwrap());
        drop(conn);
        let conn = super::super::open(&dir).unwrap();
        let third = mark(&conn, &vault, &f["mark"], now).unwrap();
        assert_ne!(second.set.marked_at, third.set.marked_at);
        assert!(!unmark(
            &conn,
            &vault,
            &serde_json::to_value(&second.set).unwrap(),
            None
        )
        .unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
}
