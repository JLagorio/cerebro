//! Durable reminder claims; shared behavior cases: reminder-state-cases.json.
use chrono::{Datelike, NaiveDateTime};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fire {
    pub path: String,
    pub chip: String,
    pub ordinal: i64,
    pub fire_at: String,
    pub outcome: String,
    pub claimed_at: String,
}
#[derive(Debug, Serialize)]
pub struct ReminderClaim {
    pub fire: Fire,
    pub fresh: bool,
}

pub(super) fn bounded(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| (1..=max).contains(&s.chars().count()))
}
fn parse(value: &Value, importing: bool, now: &str) -> Result<Fire, String> {
    if !bounded(&value["path"], 1024) {
        return Err("A reminder path must have 1 to 1024 characters.".into());
    }
    let chip = value["chip"].as_str().unwrap_or_default();
    if chip.len() != 16
        || !chip
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("A reminder chip must be 16 lowercase hexadecimal characters.".into());
    }
    let ordinal = value["ordinal"]
        .as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or("A reminder ordinal must be a nonnegative integer.")?;
    let fire_at = value["fireAt"].as_str().unwrap_or_default();
    if fire_at.len() != 16
        || !NaiveDateTime::parse_from_str(fire_at, "%Y-%m-%dT%H:%M").is_ok_and(|d| {
            (1..=9999).contains(&d.year()) && d.format("%Y-%m-%dT%H:%M").to_string() == fire_at
        })
    {
        return Err("A reminder time must be a floating local minute.".into());
    }
    let outcome = if importing {
        "imported"
    } else {
        value["outcome"].as_str().unwrap_or_default()
    };
    if !importing && !matches!(outcome, "fired" | "missed" | "moved") {
        return Err("A reminder claim must be fired, missed or moved.".into());
    }
    Ok(Fire {
        path: value["path"].as_str().unwrap_or_default().into(),
        chip: chip.into(),
        ordinal,
        fire_at: fire_at.into(),
        outcome: outcome.into(),
        claimed_at: now.into(),
    })
}
fn insert(conn: &Connection, vault: &str, fire: &Fire) -> Result<bool, String> {
    conn.execute(
        "INSERT INTO reminder_fires (vault_id,path,chip,ordinal,fire_at,outcome,claimed_at) \
        VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO NOTHING",
        params![
            vault,
            fire.path,
            fire.chip,
            fire.ordinal,
            fire.fire_at,
            fire.outcome,
            fire.claimed_at
        ],
    )
    .map(|n| n != 0)
    .map_err(|e| format!("Reminder history could not be written: {e}"))
}
pub fn read_all(conn: &Connection, vault: &str) -> Result<Vec<Fire>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path,chip,ordinal,fire_at,outcome,claimed_at FROM reminder_fires \
        WHERE vault_id=?1 ORDER BY path,chip,ordinal,fire_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([vault], |r| {
            Ok(Fire {
                path: r.get(0)?,
                chip: r.get(1)?,
                ordinal: r.get(2)?,
                fire_at: r.get(3)?,
                outcome: r.get(4)?,
                claimed_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string());
    rows
}
pub fn claim(
    conn: &Connection,
    vault: &str,
    rows: &[Value],
    now: &str,
) -> Result<Vec<ReminderClaim>, String> {
    if rows.len() > 500 {
        return Err("At most 500 reminders can be claimed at once.".into());
    }
    let fires = rows
        .iter()
        .map(|r| parse(r, false, now))
        .collect::<Result<Vec<_>, _>>()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for mut fire in fires {
        let fresh = insert(&tx, vault, &fire)?;
        if !fresh {
            let (outcome, claimed_at) = tx
                .query_row(
                    "SELECT outcome,claimed_at FROM reminder_fires \
                WHERE vault_id=?1 AND path=?2 AND chip=?3 AND ordinal=?4 AND fire_at=?5",
                    params![vault, fire.path, fire.chip, fire.ordinal, fire.fire_at],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| e.to_string())?;
            fire.outcome = outcome;
            fire.claimed_at = claimed_at;
        }
        out.push(ReminderClaim { fire, fresh });
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}
/// Legacy remnants are ignored, and an existing claim always wins.
pub fn import(conn: &Connection, vault: &str, rows: &[Value], now: &str) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The marker and imported rows commit together. Undoing the last old
    // dismissal must never make the next launch import it again.
    let fresh=tx.execute("INSERT INTO settings (key,vault_id,value) VALUES (?1,?2,'true') ON CONFLICT DO NOTHING",
        params!["upgrade.reminder_fires_imported",vault]).map_err(|e|e.to_string())?;
    if fresh == 0 {
        return Ok(0);
    }
    let mut count = 0;
    for fire in rows.iter().filter_map(|r| parse(r, true, now).ok()) {
        count += usize::from(insert(&tx, vault, &fire)?);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/reminder-state-cases.json")).unwrap()
    }
    fn setup(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = crate::vault::testutil::temp_vault(label);
        let conn = super::super::open(&dir).unwrap();
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }
    fn patch(base: &Value, patch: &Value) -> Value {
        let mut value = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            value[k] = v.clone();
        }
        value
    }
    #[test]
    fn claims_replay_the_shared_cases() {
        let f = fixture();
        let (dir, conn, vault) = setup("reminder-cases");
        let now = f["now"].as_str().unwrap();
        for bad in f["badFires"].as_array().unwrap() {
            let rows = vec![f["fire"].clone(), patch(&f["fire"], &bad["patch"])];
            assert_eq!(
                claim(&conn, &vault, &rows, now).unwrap_err(),
                bad["error"].as_str().unwrap()
            );
            assert!(read_all(&conn, &vault).unwrap().is_empty());
        }
        let rows = vec![f["fire"].clone(); f["cap"]["count"].as_u64().unwrap() as usize];
        assert_eq!(
            claim(&conn, &vault, &rows, now).unwrap_err(),
            f["cap"]["error"].as_str().unwrap()
        );
        assert!(read_all(&conn, &vault).unwrap().is_empty());
        for (i, outcome) in f["outcomes"].as_array().unwrap().iter().enumerate() {
            let mut row = f["fire"].clone();
            row["ordinal"] = Value::from(i);
            row["outcome"] = outcome.clone();
            for fresh in f["fresh"].as_array().unwrap() {
                let result = claim(&conn, &vault, &[row.clone()], now).unwrap();
                assert_eq!(result[0].fresh, fresh.as_bool().unwrap());
                assert_eq!(&result[0].fire.outcome, outcome.as_str().unwrap());
            }
        }
        let mut imported = f["fire"].clone();
        imported["path"] = Value::from("legacy.md");
        let rows = vec![f["fire"].clone(), Value::Null, imported];
        assert_eq!(import(&conn, &vault, &rows, now).unwrap(), 1);
        assert_eq!(import(&conn, &vault, &rows, now).unwrap(), 0);
        let fires = read_all(&conn, &vault).unwrap();
        assert_eq!(fires.len(), 4);
        assert_eq!(
            fires
                .iter()
                .find(|r| r.path == "legacy.md")
                .unwrap()
                .outcome,
            f["importOutcome"].as_str().unwrap()
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn a_claim_outlives_the_connection_that_made_it() {
        let f = fixture();
        let (dir, conn, vault) = setup("reminder-reopen");
        assert!(
            claim(
                &conn,
                &vault,
                &[f["fire"].clone()],
                f["now"].as_str().unwrap()
            )
            .unwrap()[0]
                .fresh
        );
        drop(conn);
        let conn = super::super::open(&dir).unwrap();
        assert!(
            !claim(
                &conn,
                &vault,
                &[f["fire"].clone()],
                f["later"].as_str().unwrap()
            )
            .unwrap()[0]
                .fresh
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn two_vaults_never_share_a_fire() {
        let f = fixture();
        let (dir, conn, a) = setup("reminder-vaults");
        let bdir = dir.join("b");
        std::fs::create_dir_all(&bdir).unwrap();
        let b = super::super::scope::register(&conn, &bdir).unwrap();
        for vault in [a, b] {
            assert!(
                claim(
                    &conn,
                    &vault,
                    &[f["fire"].clone()],
                    f["now"].as_str().unwrap()
                )
                .unwrap()[0]
                    .fresh
            );
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn the_schema_refuses_a_malformed_fire() {
        let f = fixture();
        let (dir, conn, vault) = setup("reminder-schema");
        for bad in f["badFires"].as_array().unwrap() {
            let r = patch(&f["fire"], &bad["patch"]);
            // imported is a valid stored outcome, but cannot be claimed.
            if r["outcome"] == "imported" {
                continue;
            }
            let result = conn.execute(
                "INSERT INTO reminder_fires VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    vault,
                    r["path"].as_str(),
                    r["chip"].as_str(),
                    r["ordinal"].as_f64(),
                    r["fireAt"].as_str(),
                    r["outcome"].as_str(),
                    f["now"].as_str()
                ],
            );
            assert!(result.is_err(), "{r}");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
}
