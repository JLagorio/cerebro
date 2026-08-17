//! Durable runtime settings — the two pauses, lane toggles, and the
//! markers a one-shot upgrade may only claim once (M25.1).
//!
//! **Scoping is the whole design.** A key with `vault_id IS NULL` is global
//! to the subscription (the global pause is a property of one CLI account,
//! not of a folder); a key with a vault is that vault's own (lane toggles are
//! per-vault by the design's explicit choice, and so is one agent's own pause
//! — see [`agent_pause_key`]). SQLite will not enforce uniqueness across a
//! nullable column, so the two shapes have two partial unique indexes and this
//! module never relies on `vault_id = NULL` matching anything.
//!
//! **This table is not an authority for a budget decision.** Current settings
//! say what the NEXT window will copy; a gate decision reads the immutable
//! `budget_days` row it pinned. That separation is what lets an edit be
//! recorded immediately and still not reinterpret this morning's refusals.

use rusqlite::Connection;

/// The subscription-wide pause. Persisted so it survives a restart — a pause
/// that forgot itself overnight would be the least trustworthy control in the
/// app.
///
/// **One of TWO pauses since M33b.5**, and the wider one. This stops every
/// background run on this subscription; [`agent_pause_key`] stops one agent
/// wherever it would have been started from. Neither overrides the other —
/// they are collected as separate reasons and either is enough to refuse, so
/// resuming one agent while this is on starts nothing.
pub const GLOBAL_PAUSE: &str = "ambient.global_pause";

/// How many ambient leases may be live at once (M33b.1/.2).
///
/// Global for the same reason the pause is: one CLI subscription is spent
/// once, however many vaults debit it, so a per-vault answer would be N
/// vaults each politely allowing one background run and four of them running.
pub const AMBIENT_CONCURRENCY: &str = "ambient.concurrency";

/// What an absent key means, and what ships. **One** — so M33b changes no
/// behaviour until a person changes this number, exactly as an Agent record
/// without a `schedule:` runs nothing until somebody writes one.
pub const AMBIENT_CONCURRENCY_DEFAULT: usize = 1;

/// The hard cap, borrowed rather than restated. [`crate::agent::MAX_CONCURRENT_RUNS`]
/// is how many CLI children this process will ever have alive; a background
/// ceiling above it would be a number the spawner refuses anyway, and a second
/// `4` written here is the twin-constant defect `shared/policy/README.md`
/// exists to prevent.
///
/// **At the cap, attended chat has no reserved headroom left**, and that is
/// said out loud rather than engineered away: the singleton used to guarantee
/// three free slots as a side effect. What remains is `agent::spawn`'s own
/// refusal, which turns the collision into a visible message rather than a
/// silent eviction. Anyone who sets this to the maximum has chosen background
/// throughput over a responsive chat box, and only they can make that call.
pub const AMBIENT_CONCURRENCY_MAX: usize = crate::agent::MAX_CONCURRENT_RUNS;

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

// --- One agent's own pause (M33b.5) -----------------------------------------

/// `agent.paused.<actor>` — one agent stopped without deleting its record.
///
/// **Operational, therefore here and not in the vault.** A pause is not
/// something the base believes; it is something the app was told to stop
/// doing. The two-records rule puts that in `<app-data>/runtime.db`, beside
/// the global pause, rather than in frontmatter beside the agent's brief —
/// which also means pausing an agent never rewrites the record a person is
/// reading, and never turns into a git commit.
///
/// **Vault-scoped, where the global pause is not, and for the opposite
/// reason.** The global pause is a property of one CLI subscription, spent
/// once however many vaults debit it. An agent is a RECORD: two vaults may
/// each hold a `digest` without them being the same colleague, and a pause
/// that crossed vaults would stop a stranger.
pub fn agent_pause_key(actor: &str) -> String {
    format!("agent.paused.{actor}")
}

/// Is this one agent paused in this vault?
///
/// **An absent row is NOT paused, and that is a measurement rather than a
/// gap** — an agent nobody has ever paused has no row, which is the state
/// every agent ships in.
///
/// **A read that FAILED is an `Err`, never a `false`.** Every caller is about
/// to decide whether to start a run, and "we could not tell" must not become
/// "go ahead" — that would make the pause a lie under exactly the conditions
/// nobody tests. So this has [`lane_enabled`]'s shape and not [`flag`]'s:
/// `flag` is for questions whose safe answer is a default, and this one's safe
/// answer is to refuse. The gate already fails closed on an unreadable lane
/// row for the same reason.
pub fn agent_paused(conn: &Connection, vault_id: &str, actor: &str) -> Result<bool, String> {
    Ok(get(conn, &agent_pause_key(actor), Some(vault_id))?.as_deref() == Some("true"))
}

/// Pause or resume one agent. Refused without an agent to be about, before a
/// byte is stored — a blank actor would mint a settings key nothing will ever
/// read and a pause nothing will ever enforce.
pub fn set_agent_paused(
    conn: &Connection,
    vault_id: &str,
    actor: &str,
    paused: bool,
) -> Result<(), String> {
    let actor = actor.trim();
    if actor.is_empty() {
        return Err("a pause needs an agent to be about, and no actor was named".to_string());
    }
    set(
        conn,
        &agent_pause_key(actor),
        Some(vault_id),
        if paused { "true" } else { "false" },
    )
}

/// Every agent paused in this vault, by actor, byte-sorted.
///
/// An EMPTY vector is measured-at-zero: the rows were read and nobody is
/// paused. A read that failed is an `Err`, so the surface can say it could not
/// tell rather than drawing a fleet that claims to be running.
///
/// Resuming stores `false` rather than deleting the row — the same shape the
/// global pause has — so the filter is on the value and not on the key's mere
/// existence.
pub fn paused_agents(conn: &Connection, vault_id: &str) -> Result<Vec<String>, String> {
    let prefix = agent_pause_key("");
    let mut statement = conn
        .prepare(
            "SELECT key FROM settings WHERE vault_id = ?1 AND value = 'true' \
             AND key LIKE ?2 || '%' ORDER BY key",
        )
        .map_err(|e| format!("settings (paused agents): {e}"))?;
    let rows = statement
        .query_map(rusqlite::params![vault_id, prefix], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("settings (paused agents): {e}"))?;
    let keys = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("settings (paused agents): {e}"))?;
    Ok(keys
        .into_iter()
        .filter_map(|key| key.strip_prefix(&prefix).map(str::to_string))
        .collect())
}

/// The refusal a run start must not get past (M33b.5, spec §6).
///
/// `None` is bare chat — a run nobody launched on any agent's behalf — and has
/// no pause to check.
///
/// The sentence NAMES the agent, because a person who paused one of several
/// and then triggered another needs to know which one just refused them. It is
/// a returned refusal rather than a silent no-op for the same reason: a pause
/// that swallows the trigger and says nothing is indistinguishable from a
/// broken button.
pub fn refuse_if_agent_paused(
    conn: &Connection,
    vault_id: &str,
    actor: Option<&str>,
) -> Result<(), String> {
    let Some(actor) = actor else {
        return Ok(());
    };
    if agent_paused(conn, vault_id, actor)? {
        return Err(format!(
            "{actor} is paused, so this run did not start. Resume it on the fleet — \
             a paused agent that still ran would make the pause a lie."
        ));
    }
    Ok(())
}

/// How many ambient leases may be live at once. Never fails, and never
/// answers zero.
///
/// Every way of not knowing — an absent key, an unreadable row, a value that
/// does not parse, a value outside the range the setter enforces — answers
/// [`AMBIENT_CONCURRENCY_DEFAULT`]. That is the same choice [`flag`] makes for
/// the pause and for the same reason: the conservative answer is the shipped
/// one, and a gate that refused to run because a settings row was corrupt
/// would turn a cosmetic fault into a stopped background.
///
/// Zero is not reachable. A ceiling of zero is spelled `global_pause`, which
/// is a different control with a different sentence on it, and letting this
/// number reach zero would give the app two ways to say "stopped" of which
/// only one has a button.
pub fn ambient_concurrency(conn: &Connection) -> usize {
    match get(conn, AMBIENT_CONCURRENCY, None) {
        Ok(Some(value)) => value
            .parse::<usize>()
            .ok()
            .filter(|n| (AMBIENT_CONCURRENCY_DEFAULT..=AMBIENT_CONCURRENCY_MAX).contains(n))
            .unwrap_or(AMBIENT_CONCURRENCY_DEFAULT),
        _ => AMBIENT_CONCURRENCY_DEFAULT,
    }
}

/// Raise or lower the ceiling. Refused outside `1..=AMBIENT_CONCURRENCY_MAX`,
/// before a byte is stored — a stored value the reader would silently clamp is
/// a setting whose displayed number and effective number disagree.
pub fn set_ambient_concurrency(conn: &Connection, ceiling: usize) -> Result<(), String> {
    if ceiling < AMBIENT_CONCURRENCY_DEFAULT {
        return Err(format!(
            "a background concurrency of {ceiling} is not a ceiling, it is a pause — \
             use the pause, which says so"
        ));
    }
    if ceiling > AMBIENT_CONCURRENCY_MAX {
        return Err(format!(
            "{ceiling} background runs would exceed the {AMBIENT_CONCURRENCY_MAX} this process \
             will ever have alive at once"
        ));
    }
    set(conn, AMBIENT_CONCURRENCY, None, &ceiling.to_string())
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
    fn an_agent_with_no_pause_row_is_not_paused_and_a_pause_survives_a_restart() {
        // Absent is a MEASUREMENT here, not a gap: every agent ships with no
        // row, and that state is "running", not "unknown".
        let (dir, conn) = db("settings-agent-pause");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        assert!(!agent_paused(&conn, &vault, "process:digest").unwrap());
        assert_eq!(paused_agents(&conn, &vault).unwrap(), Vec::<String>::new());

        set_agent_paused(&conn, &vault, "process:digest", true).unwrap();
        assert!(agent_paused(&conn, &vault, "process:digest").unwrap());
        assert_eq!(
            paused_agents(&conn, &vault).unwrap(),
            vec!["process:digest"]
        );
        drop(conn);

        let conn = super::super::open(&dir).unwrap();
        assert!(
            agent_paused(&conn, &vault, "process:digest").unwrap(),
            "a pause that forgets itself overnight is not one"
        );

        // And resuming is a state, not a deletion: the row stays, saying so.
        set_agent_paused(&conn, &vault, "process:digest", false).unwrap();
        assert!(!agent_paused(&conn, &vault, "process:digest").unwrap());
        assert_eq!(paused_agents(&conn, &vault).unwrap(), Vec::<String>::new());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_agents_pause_says_nothing_about_another_or_about_another_vault() {
        // Two vaults may each hold an agent whose slug is the same word
        // without them being the same colleague, which is why this key is
        // vault-scoped where the global pause is not.
        let (dir, conn) = db("settings-agent-pause-scope");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        let other_dir = crate::vault::testutil::temp_vault("settings-agent-pause-scope-b");
        let other = super::super::scope::register(&conn, &other_dir).unwrap();

        set_agent_paused(&conn, &vault, "process:digest", true).unwrap();
        assert!(!agent_paused(&conn, &vault, "process:scout").unwrap());
        assert!(!agent_paused(&conn, &other, "process:digest").unwrap());
        assert_eq!(paused_agents(&conn, &other).unwrap(), Vec::<String>::new());

        set_agent_paused(&conn, &vault, "process:scout", true).unwrap();
        assert_eq!(
            paused_agents(&conn, &vault).unwrap(),
            vec!["process:digest", "process:scout"],
            "byte-sorted, so a roster does not reshuffle between reads"
        );
        // The global pause is a different key with a different scope, and
        // neither read sees the other.
        set_global_pause(&conn, true).unwrap();
        assert!(!agent_paused(&conn, &vault, "process:nobody").unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other_dir);
    }

    #[test]
    fn a_pause_with_no_agent_to_be_about_is_refused_before_it_is_stored() {
        let (dir, conn) = db("settings-agent-pause-blank");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        for blank in ["", "   "] {
            let err = set_agent_paused(&conn, &vault, blank, true).unwrap_err();
            assert!(err.contains("no actor was named"), "{err}");
        }
        assert_eq!(paused_agents(&conn, &vault).unwrap(), Vec::<String>::new());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_refusal_names_the_agent_and_bare_chat_has_nothing_to_refuse() {
        let (dir, conn) = db("settings-agent-pause-refusal");
        let vault = super::super::scope::register(&conn, &dir).unwrap();
        // No actor: a run nobody launched on an agent's behalf.
        assert_eq!(refuse_if_agent_paused(&conn, &vault, None), Ok(()));
        assert_eq!(
            refuse_if_agent_paused(&conn, &vault, Some("process:digest")),
            Ok(())
        );

        set_agent_paused(&conn, &vault, "process:digest", true).unwrap();
        let err = refuse_if_agent_paused(&conn, &vault, Some("process:digest")).unwrap_err();
        assert!(err.contains("process:digest"), "{err}");
        assert!(err.contains("paused"), "{err}");
        // A different agent is untouched by it.
        assert_eq!(
            refuse_if_agent_paused(&conn, &vault, Some("process:scout")),
            Ok(())
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_concurrency_ceiling_is_one_until_somebody_raises_it_and_then_it_persists() {
        // M33b ships INERT: an absent key is one, which is what the singleton
        // row enforced, so nothing about background behaviour changes until a
        // person types a bigger number.
        let (dir, conn) = db("settings-concurrency");
        assert_eq!(ambient_concurrency(&conn), 1);
        set_ambient_concurrency(&conn, 3).unwrap();
        assert_eq!(ambient_concurrency(&conn), 3);
        drop(conn);

        let conn = super::super::open(&dir).unwrap();
        assert_eq!(
            ambient_concurrency(&conn),
            3,
            "a ceiling that forgets itself overnight is not one"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ceiling_outside_one_through_the_process_cap_is_refused_before_it_is_stored() {
        let (dir, conn) = db("settings-concurrency-range");
        let over = set_ambient_concurrency(&conn, AMBIENT_CONCURRENCY_MAX + 1).unwrap_err();
        assert!(over.contains("will ever have alive"), "{over}");
        let under = set_ambient_concurrency(&conn, 0).unwrap_err();
        assert!(under.contains("it is a pause"), "{under}");
        assert_eq!(
            get(&conn, AMBIENT_CONCURRENCY, None).unwrap(),
            None,
            "a refused ceiling stores nothing"
        );
        assert_eq!(ambient_concurrency(&conn), 1);
        // The boundary itself is allowed — the cap is the process cap, not one
        // below it, and it is borrowed from `agent::MAX_CONCURRENT_RUNS`
        // rather than written twice.
        set_ambient_concurrency(&conn, AMBIENT_CONCURRENCY_MAX).unwrap();
        assert_eq!(ambient_concurrency(&conn), AMBIENT_CONCURRENCY_MAX);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stored_ceiling_that_makes_no_sense_reads_as_one_rather_than_as_nothing() {
        // The setter cannot write these, but a hand-edited row, an older
        // build, or a corrupt value can exist. Every one of them answers with
        // the conservative shipped default — never zero, which would be a
        // second, buttonless way to say "paused".
        let (dir, conn) = db("settings-concurrency-junk");
        for junk in ["0", "-1", "9", "many", ""] {
            set(&conn, AMBIENT_CONCURRENCY, None, junk).unwrap();
            assert_eq!(ambient_concurrency(&conn), 1, "{junk:?}");
        }
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
