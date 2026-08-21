//! The job runner's ledgers, durably (M34.2.2).
//!
//! Three renderer-side maps kept scheduled work from spinning — `attempts`
//! (note version last learned), `skillRuns` (fire key last answered),
//! `triggerRuns` (when a trigger last fired) — and all three lived in
//! localStorage, which is per-webview state: a data wipe or reinstall forgot
//! every answer and re-fired every schedule, which is duplicate spend of the
//! user's subscription.
//!
//! `claim` is the write, and its verdict is the point. The runner asks
//! "record this run_key" and gets back whether the record was FRESH: a second
//! window that derived the same due job loses the claim and spawns nothing.
//! That is the whole two-window story — arbitration in the database, not a
//! renderer promise to be quick.
//!
//! `stamp` exists because `triggerRuns` is not a claim: it is a cooldown
//! clock, overwritten at every trigger fire, and a conditional write would
//! refuse the one update the cooldown needs.

use rusqlite::Connection;

/// The three ledger names the schema admits. A fourth is a schema migration,
/// not a string.
pub const LEDGERS: [&str; 3] = ["attempts", "skillRuns", "triggerRuns"];

/// Every row for one vault, as (ledger, key, run_key) — the hydration read.
pub fn read_all(
    conn: &Connection,
    vault_id: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT ledger, key, run_key FROM job_ledger \
             WHERE vault_id = ?1 ORDER BY ledger, key",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([vault_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Record `run_key` for `(ledger, key)` unless it is ALREADY the recorded
/// answer. Returns whether the record was fresh — true means "this caller
/// runs the job", false means "that exact fire was already answered", by
/// another window or an earlier session. An older stored key is updated and
/// counts as fresh: a new fire is a new job.
pub fn claim(
    conn: &Connection,
    vault_id: &str,
    ledger: &str,
    key: &str,
    run_key: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "INSERT INTO job_ledger (vault_id, ledger, key, run_key, recorded_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT (vault_id, ledger, key) DO UPDATE SET \
               run_key = excluded.run_key, recorded_at = excluded.recorded_at \
             WHERE job_ledger.run_key <> excluded.run_key",
            rusqlite::params![vault_id, ledger, key, run_key, super::now_utc()],
        )
        .map_err(|e| format!("job_ledger claim {ledger}/{key}: {e}"))?;
    Ok(changed > 0)
}

/// Surrender a claim this caller holds (M34.2.4): delete the row ONLY if it
/// still records exactly `run_key`. The one caller is the runner whose
/// freshly claimed run was DEFERRED by the budget gate — the fire was never
/// answered, and a consumed key would make the deferral eat the whole
/// period. Conditional on the value, so a claim another window has since
/// re-won is never destroyed. Returns whether anything was surrendered.
pub fn unclaim(
    conn: &Connection,
    vault_id: &str,
    ledger: &str,
    key: &str,
    run_key: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM job_ledger \
             WHERE vault_id = ?1 AND ledger = ?2 AND key = ?3 AND run_key = ?4",
            rusqlite::params![vault_id, ledger, key, run_key],
        )
        .map_err(|e| format!("job_ledger unclaim {ledger}/{key}: {e}"))?;
    Ok(changed > 0)
}

/// Overwrite `(ledger, key)` unconditionally — the cooldown clock's write.
pub fn stamp(
    conn: &Connection,
    vault_id: &str,
    ledger: &str,
    key: &str,
    run_key: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO job_ledger (vault_id, ledger, key, run_key, recorded_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT (vault_id, ledger, key) DO UPDATE SET \
           run_key = excluded.run_key, recorded_at = excluded.recorded_at",
        rusqlite::params![vault_id, ledger, key, run_key, super::now_utc()],
    )
    .map_err(|e| format!("job_ledger stamp {ledger}/{key}: {e}"))?;
    Ok(())
}

/// One-time import from the localStorage era (M34.2.3). Inserts only keys the
/// database does not hold — a stored answer always outranks an imported one,
/// because the database has been the arbiter since it existed — and returns
/// how many landed.
pub fn import(
    conn: &Connection,
    vault_id: &str,
    entries: &[(String, String, String)],
) -> Result<usize, String> {
    let now = super::now_utc();
    let mut landed = 0;
    for (ledger, key, run_key) in entries {
        if key.is_empty() || run_key.is_empty() {
            // The schema would refuse these; a half-imported batch that died
            // on one malformed localStorage remnant would re-import forever.
            continue;
        }
        let changed = conn
            .execute(
                "INSERT INTO job_ledger (vault_id, ledger, key, run_key, recorded_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT (vault_id, ledger, key) DO NOTHING",
                rusqlite::params![vault_id, ledger, key, run_key, now],
            )
            .map_err(|e| format!("job_ledger import {ledger}/{key}: {e}"))?;
        landed += changed;
    }
    Ok(landed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    #[test]
    fn the_first_claim_is_fresh_and_the_second_identical_one_is_not() {
        let (dir, conn, vault) = fixture("ledger-claim");
        assert!(claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap());
        assert!(
            !claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap(),
            "the same fire answered twice is the two-window double-run"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_fire_key_reclaims_the_same_job() {
        let (dir, conn, vault) = fixture("ledger-refire");
        assert!(claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap());
        assert!(
            claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-21").unwrap(),
            "a new fire is a new job"
        );
        assert_eq!(
            read_all(&conn, &vault).unwrap(),
            vec![(
                "skillRuns".to_string(),
                "agent:risks".to_string(),
                "2026-08-21".to_string()
            )],
            "one key holds one answer — the latest"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unclaim_surrenders_only_the_exact_claim_still_held() {
        let (dir, conn, vault) = fixture("ledger-unclaim");
        assert!(claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap());
        // The deferred runner surrenders its own claim: the fire is open again.
        assert!(unclaim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap());
        assert!(
            claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap(),
            "a surrendered fire can be claimed again"
        );
        // A claim someone else has since re-won is never destroyed.
        assert!(claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-21").unwrap());
        assert!(
            !unclaim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap(),
            "an old run_key surrenders nothing"
        );
        assert_eq!(read_all(&conn, &vault).unwrap()[0].2, "2026-08-21");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stamp_always_overwrites_because_a_cooldown_clock_must_move() {
        let (dir, conn, vault) = fixture("ledger-stamp");
        stamp(
            &conn,
            &vault,
            "triggerRuns",
            "agent:risks",
            "2026-08-20T10:00:00Z",
        )
        .unwrap();
        stamp(
            &conn,
            &vault,
            "triggerRuns",
            "agent:risks",
            "2026-08-20T10:00:00Z",
        )
        .unwrap();
        stamp(
            &conn,
            &vault,
            "triggerRuns",
            "agent:risks",
            "2026-08-20T11:00:00Z",
        )
        .unwrap();
        let rows = read_all(&conn, &vault).unwrap();
        assert_eq!(rows[0].2, "2026-08-20T11:00:00Z");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_vaults_never_share_a_ledger_row() {
        // Fire keys are calendar values: the same relative path in another
        // vault reading as already-run is the exact bug PR #5 fixed in the
        // localStorage era, and the durable table must not reintroduce it.
        let (dir, conn, vault_a) = fixture("ledger-vaults-a");
        let other = testutil::temp_vault("ledger-vaults-b");
        let vault_b = crate::runtime::scope::register(&conn, &other).unwrap();
        assert!(claim(
            &conn,
            &vault_a,
            "skillRuns",
            "skills/daily.md",
            "2026-08-20"
        )
        .unwrap());
        assert!(
            claim(
                &conn,
                &vault_b,
                "skillRuns",
                "skills/daily.md",
                "2026-08-20"
            )
            .unwrap(),
            "vault B never heard of vault A's fire"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn an_unknown_ledger_name_is_refused_by_the_schema() {
        let (dir, conn, vault) = fixture("ledger-vocab");
        let err = claim(&conn, &vault, "regrets", "k", "v").unwrap_err();
        assert!(err.contains("CHECK"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_lands_only_what_the_database_does_not_hold() {
        let (dir, conn, vault) = fixture("ledger-import");
        assert!(claim(&conn, &vault, "skillRuns", "agent:risks", "2026-08-20").unwrap());
        let landed = import(
            &conn,
            &vault,
            &[
                // The DB already answered this key — the stale localStorage
                // copy must not win.
                (
                    "skillRuns".to_string(),
                    "agent:risks".to_string(),
                    "2026-08-01".to_string(),
                ),
                (
                    "attempts".to_string(),
                    "records/a.md".to_string(),
                    "2026-08-19T00:00:00.000Z".to_string(),
                ),
                // Malformed remnants are skipped, not fatal: dying on one
                // would re-run the whole import forever.
                ("attempts".to_string(), String::new(), "x".to_string()),
            ],
        )
        .unwrap();
        assert_eq!(landed, 1, "one new key, one landed");
        assert_eq!(
            read_all(&conn, &vault).unwrap(),
            vec![
                (
                    "attempts".to_string(),
                    "records/a.md".to_string(),
                    "2026-08-19T00:00:00.000Z".to_string()
                ),
                (
                    "skillRuns".to_string(),
                    "agent:risks".to_string(),
                    "2026-08-20".to_string()
                ),
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
