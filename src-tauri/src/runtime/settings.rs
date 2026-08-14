//! Durable runtime settings — the global pause, lane toggles, and the
//! markers a one-shot upgrade may only claim once (M25.1).
//!
//! **Scoping is the whole design.** A key with `vault_id IS NULL` is global
//! to the subscription (the pause is a property of one CLI account, not of a
//! folder); a key with a vault is that vault's own (lane toggles are
//! per-vault by the design's explicit choice). SQLite will not enforce
//! uniqueness across a nullable column, so the two shapes have two partial
//! unique indexes and this module never relies on `vault_id = NULL` matching
//! anything.
//!
//! **This table is not an authority for a budget decision.** Current settings
//! say what the NEXT window will copy; a gate decision reads the immutable
//! `budget_days` row it pinned. That separation is what lets an edit be
//! recorded immediately and still not reinterpret this morning's refusals.

use rusqlite::Connection;

/// The subscription-wide pause. Persisted so it survives a restart — a pause
/// that forgot itself overnight would be the least trustworthy control in the
/// app.
pub const GLOBAL_PAUSE: &str = "ambient.global_pause";

/// `lane.enabled.<lane>` — per-vault lane toggles.
pub fn lane_key(lane: &str) -> String {
    format!("lane.enabled.{lane}")
}

/// Set once, in the same transaction as every row the one-shot upgrade
/// writes. Its presence is the difference between "this app has never run
/// M25 here" and "the operational history was deleted".
pub const IMPORT_COMPLETE: &str = "upgrade.legacy_import_complete";

/// The vault-scoped R7 verification scope (M28.1) — the declared question
/// the R7 gate counts observations against, stored as the canonical JSON of
/// a validated `VerificationScope`. Operational configuration by the
/// two-records rule: mutable, undated, and safe to be so, because every
/// recorded evaluation carries the digest of the scope it actually ran
/// under.
pub const R7_VERIFICATION_SCOPE: &str = "trigger.r7_verification_scope";

/// Declare the R7 scope for one vault. Validated before a byte is stored;
/// returns the canonical digest recorded evaluations will carry.
pub fn declare_r7_scope(
    conn: &Connection,
    vault_id: &str,
    scope_json: &str,
) -> Result<String, String> {
    let scope: crate::trigger::observations::VerificationScope =
        serde_json::from_str(scope_json).map_err(|e| format!("the scope does not parse: {e}"))?;
    scope.validate()?;
    let digest = scope.digest()?;
    let canonical =
        serde_json::to_string(&scope).map_err(|e| format!("canonicalizing the scope: {e}"))?;
    set(conn, R7_VERIFICATION_SCOPE, Some(vault_id), &canonical)?;
    Ok(digest)
}

/// The declared R7 scope for one vault, if any. A stored scope that no
/// longer parses or validates is an ERROR, never a `None` — "we cannot tell
/// you" and "nothing is declared" are different answers.
pub fn r7_scope(
    conn: &Connection,
    vault_id: &str,
) -> Result<Option<crate::trigger::observations::VerificationScope>, String> {
    match get(conn, R7_VERIFICATION_SCOPE, Some(vault_id))? {
        None => Ok(None),
        Some(json) => {
            let scope: crate::trigger::observations::VerificationScope =
                serde_json::from_str(&json)
                    .map_err(|e| format!("the stored R7 scope no longer parses: {e}"))?;
            scope.validate()?;
            Ok(Some(scope))
        }
    }
}

pub fn get(conn: &Connection, key: &str, vault_id: Option<&str>) -> Result<Option<String>, String> {
    let result = match vault_id {
        Some(vault) => conn.query_row(
            "SELECT value FROM settings WHERE key = ?1 AND vault_id = ?2",
            rusqlite::params![key, vault],
            |row| row.get::<_, String>(0),
        ),
        None => conn.query_row(
            "SELECT value FROM settings WHERE key = ?1 AND vault_id IS NULL",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        ),
    };
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("settings {key}: {e}")),
    }
}

pub fn set(
    conn: &Connection,
    key: &str,
    vault_id: Option<&str>,
    value: &str,
) -> Result<(), String> {
    // Two statements rather than one upsert: the partial unique indexes mean
    // there is no single conflict target that covers both shapes, and
    // pretending otherwise is how a global key quietly grows a duplicate.
    let updated = match vault_id {
        Some(vault) => conn.execute(
            "UPDATE settings SET value = ?3 WHERE key = ?1 AND vault_id = ?2",
            rusqlite::params![key, vault, value],
        ),
        None => conn.execute(
            "UPDATE settings SET value = ?2 WHERE key = ?1 AND vault_id IS NULL",
            rusqlite::params![key, value],
        ),
    }
    .map_err(|e| format!("settings {key}: {e}"))?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO settings (key, vault_id, value) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, vault_id, value],
        )
        .map_err(|e| format!("settings {key}: {e}"))?;
    }
    Ok(())
}

fn flag(conn: &Connection, key: &str, vault_id: Option<&str>, default: bool) -> bool {
    match get(conn, key, vault_id) {
        Ok(Some(value)) => value == "true",
        // An unreadable settings row is not permission to run ambient work:
        // every caller of this helper is asking a question whose safe answer
        // is the conservative one, so the default is the caller's to choose
        // and a read failure takes it.
        _ => default,
    }
}

/// Is ambient work paused subscription-wide? Defaults to NOT paused; the
/// pause is an owner decision, not a fallback.
pub fn global_pause(conn: &Connection) -> bool {
    flag(conn, GLOBAL_PAUSE, None, false)
}

pub fn set_global_pause(conn: &Connection, paused: bool) -> Result<(), String> {
    set(
        conn,
        GLOBAL_PAUSE,
        None,
        if paused { "true" } else { "false" },
    )
}

/// Is this lane enabled for this vault? Falls back to the lane registry's
/// `enabled_by_default`, so a lane added by a later migration arrives in the
/// state its migration declared rather than in whatever `false` implies.
pub fn lane_enabled(conn: &Connection, vault_id: &str, lane: &str) -> Result<bool, String> {
    let default: i64 = conn
        .query_row(
            "SELECT enabled_by_default FROM lane_registry WHERE lane = ?1",
            [lane],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("lane {lane:?} is not in the registry — no dispatcher may name it")
            }
            other => format!("lane_registry: {other}"),
        })?;
    Ok(flag(conn, &lane_key(lane), Some(vault_id), default == 1))
}

pub fn set_lane_enabled(
    conn: &Connection,
    vault_id: &str,
    lane: &str,
    enabled: bool,
) -> Result<(), String> {
    // Registry membership is checked first so a typo becomes an error instead
    // of a settings row nothing will ever read.
    lane_enabled(conn, vault_id, lane)?;
    set(
        conn,
        &lane_key(lane),
        Some(vault_id),
        if enabled { "true" } else { "false" },
    )
}

/// Registered lanes in dispatch priority order — lowest number first.
/// Degradation walks this list backwards.
pub fn lanes_by_priority(conn: &Connection) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT lane FROM lane_registry ORDER BY priority")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn db(label: &str) -> (std::path::PathBuf, Connection) {
        let dir = testutil::temp_vault(label);
        let conn = super::super::open(&dir).unwrap();
        (dir, conn)
    }

    #[test]
    fn a_global_key_and_a_vault_key_of_the_same_name_do_not_collide() {
        let (dir, conn) = db("settings-scope");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        set(&conn, "k", None, "global").unwrap();
        set(&conn, "k", Some(&vault), "scoped").unwrap();
        assert_eq!(get(&conn, "k", None).unwrap().as_deref(), Some("global"));
        assert_eq!(
            get(&conn, "k", Some(&vault)).unwrap().as_deref(),
            Some("scoped")
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setting_a_global_key_twice_updates_it_rather_than_duplicating_it() {
        // SQLite would happily store two rows with NULL vault_id under one
        // key; the partial unique index plus update-then-insert is what stops
        // the pause from having two answers.
        let (dir, conn) = db("settings-once");
        set(&conn, "k", None, "a").unwrap();
        set(&conn, "k", None, "b").unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM settings WHERE key = 'k'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(get(&conn, "k", None).unwrap().as_deref(), Some("b"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pause_is_off_until_somebody_asks_for_it_and_then_it_persists() {
        let (dir, conn) = db("settings-pause");
        assert!(!global_pause(&conn));
        set_global_pause(&conn, true).unwrap();
        assert!(global_pause(&conn));
        drop(conn);

        let conn = super::super::open(&dir).unwrap();
        assert!(
            global_pause(&conn),
            "a pause that forgets itself is not one"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lane_toggles_fall_back_to_the_registrys_default() {
        let (dir, conn) = db("settings-lane");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        assert!(lane_enabled(&conn, &vault, "behind").unwrap());
        set_lane_enabled(&conn, &vault, "behind", false).unwrap();
        assert!(!lane_enabled(&conn, &vault, "behind").unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lane_outside_the_registry_is_refused_rather_than_stored() {
        let (dir, conn) = db("settings-lane-unknown");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        let err = set_lane_enabled(&conn, &vault, "telepathy", true).unwrap_err();
        assert!(err.contains("not in the registry"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_seeded_lanes_are_the_renderers_rank_order() {
        // The dispatcher degrades by reverse priority, so this order is
        // behaviour, not decoration.
        let (dir, conn) = db("settings-lane-order");
        assert_eq!(
            lanes_by_priority(&conn).unwrap(),
            vec![
                "filed",
                "scheduled",
                "agent",
                "behind",
                "refresh",
                "stale",
                "schema"
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_declared_r7_scope_round_trips_and_its_digest_is_the_scopes_own() {
        let (dir, conn) = db("settings-r7-scope");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        assert_eq!(r7_scope(&conn, &vault), Ok(None));

        let json = r#"{
            "subjects": ["e0000000000000000000000000000001"],
            "predicate_classes": ["operational_status"],
            "stage": null, "environment": null, "geography": null
        }"#;
        let digest = declare_r7_scope(&conn, &vault, json).unwrap();
        let stored = r7_scope(&conn, &vault).unwrap().expect("declared");
        assert_eq!(stored.digest().unwrap(), digest);
        assert_eq!(stored.subjects, ["e0000000000000000000000000000001"]);
        // Pinned vector, shared with the browser mock's parity test
        // (mockIpc.test.ts) — the one digest rule, observed from both
        // languages rather than mirrored in prose.
        assert_eq!(
            digest,
            "093da74e0fbf1a510061af1bdfe0ff9626681f67e689d75b5cef47ecb06f2cb2"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_invalid_scope_is_refused_before_a_byte_is_stored() {
        let (dir, conn) = db("settings-r7-invalid");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        // Empty subjects: the validator's own refusal, verbatim.
        let err = declare_r7_scope(
            &conn,
            &vault,
            r#"{"subjects": [], "predicate_classes": ["operational_status"],
                "stage": null, "environment": null, "geography": null}"#,
        )
        .unwrap_err();
        assert!(err.contains("verifies nothing"), "{err}");
        // A field the shape does not know is a typo'd constraint, refused.
        let err = declare_r7_scope(
            &conn,
            &vault,
            r#"{"subjects": ["e0000000000000000000000000000001"],
                "predicate_classes": ["operational_status"],
                "stage": null, "environment": null, "geography": null,
                "stagee": "prod"}"#,
        )
        .unwrap_err();
        assert!(err.contains("does not parse"), "{err}");
        // Nothing landed.
        assert_eq!(r7_scope(&conn, &vault), Ok(None));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
