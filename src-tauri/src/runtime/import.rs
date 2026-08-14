//! The one-shot upgrade baseline (M25.1).
//!
//! **What the pre-M25 state actually was**, which is less than a durable
//! scheduler and the importer must not pretend otherwise: the scan snapshot
//! and the pending work set lived in React hook memory and did not survive a
//! reload at all; only three ledgers were durable, in localStorage —
//! `cerebro.learnAttempts` (path → mtime), `cerebro.skillRuns` (vault →
//! identity → fire key), and `cerebro.triggerRuns` (vault → identity →
//! ISO). So this importer migrates three maps, computes a fresh normalized
//! snapshot for every current item, and **holds** everything it cannot prove.
//!
//! **Why holding is the whole design.** The alternative to holding is
//! guessing, and both guesses are bad: assume consumed and the first
//! post-upgrade launch silently skips real work forever; assume pending and
//! the first launch queues the entire vault at once — the stampede the
//! milestone exists to prevent. `baseline_held` is a third answer that costs
//! one decision and lies about nothing.
//!
//! **The last place mtime is consulted, deliberately.** The legacy attempts
//! ledger is keyed on mtime; that is why it is being deleted. But the
//! recorded pairs are real evidence about the past — "this exact path was
//! distilled when it looked like this" — and throwing them away to avoid
//! touching a timestamp would hold items we can actually account for. An
//! attempt whose mtime still matches the file is proof of processing at this
//! state; anything else is held. No mtime comparison survives this function.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;

use super::normalize::{self, Snapshot};
use super::scheduler::{self, Row, SchedulerState};
use super::settings;

/// The three durable pre-M25 ledgers, as the renderer holds them.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LegacyState {
    /// `cerebro.learnAttempts` — vault-relative path → the `modifiedAt` the
    /// distiller saw. Flat and NOT vault-scoped in localStorage; the caller
    /// hands over the whole map and cross-vault path collisions resolve here,
    /// where the item list is this vault's.
    pub attempts: BTreeMap<String, String>,
    /// `cerebro.skillRuns[vault]` — record identity → last consumed fire key.
    pub skill_runs: BTreeMap<String, String>,
    /// `cerebro.triggerRuns[vault]` — record identity → last trigger time.
    pub trigger_runs: BTreeMap<String, String>,
}

/// One current item, as scanned.
///
/// `identity` comes from the renderer's `recordIdentity` because it depends
/// on `slugify`, and a second slug implementation in Rust would be a rule
/// two languages could disagree about. Everything else is computed here.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub item_key: String,
    pub identity: String,
    pub modified_at: String,
    pub artifact_hash: String,
    pub snapshot: Snapshot,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Outcome {
    /// Rows written.
    pub items: usize,
    /// Items a legacy record accounts for exactly.
    pub consumed: usize,
    /// Items waiting for an owner decision.
    pub held: usize,
    /// The import had already run for this vault; nothing was written.
    pub already_complete: bool,
}

/// What the owner may do with the held pile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// "Use current state as baseline" — accept today's content as already
    /// accounted for. Cheap, and forgets whatever was genuinely pending.
    Baseline,
    /// "Process these items" — queue them. Costs a run each, and the budget
    /// gate still governs when they go.
    Process,
}

/// Scan a vault into the item list this importer consumes.
///
/// Reads each file's bytes for the artifact hash; a file that cannot be read
/// is skipped rather than hashed as empty — an item with a fabricated hash
/// would be a permanent false 'unchanged'.
pub fn current_items(
    vault: &Path,
    identities: &BTreeMap<String, String>,
) -> Result<Vec<Item>, String> {
    let entries = crate::vault::scan::scan_vault(vault)?;
    let mut items = Vec::with_capacity(entries.len());
    for entry in entries {
        let Ok(bytes) = std::fs::read(vault.join(&entry.path)) else {
            continue;
        };
        items.push(Item {
            identity: identities
                .get(&entry.path)
                .cloned()
                .unwrap_or_else(|| entry.path.clone()),
            item_key: entry.path.clone(),
            modified_at: entry.modified_at.clone(),
            artifact_hash: normalize::artifact_hash(&bytes),
            snapshot: normalize::snapshot(&entry),
        });
    }
    items.sort_by(|a, b| a.item_key.cmp(&b.item_key));
    Ok(items)
}

/// The legacy cursor for one item, as canonical JSON, or `None` when neither
/// ledger knew it. Both facts are preserved side by side rather than merged:
/// a fire key and a cooldown stamp answer different questions, and a merge
/// would have to pick a winner for no reason.
fn cursor(legacy: &LegacyState, identity: &str) -> Option<String> {
    let skill = legacy.skill_runs.get(identity);
    let trigger = legacy.trigger_runs.get(identity);
    if skill.is_none() && trigger.is_none() {
        return None;
    }
    Some(serde_json::json!({ "skill_run": skill, "trigger_run": trigger }).to_string())
}

/// Run the one-shot import for one vault. Idempotent by its completion
/// marker, which is set in the SAME transaction as every row — a kill in the
/// middle leaves an unmarked, un-imported database that the next launch
/// imports cleanly, never a half-imported one that claims it is done.
pub fn run(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    legacy: &LegacyState,
    items: &[Item],
) -> Result<Outcome, String> {
    if settings::get(conn, settings::IMPORT_COMPLETE, Some(vault_id))?.is_some() {
        return Ok(Outcome {
            items: 0,
            consumed: 0,
            held: 0,
            already_complete: true,
        });
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("legacy import: {e}"))?;
    crate::crash::crash_point("runtime-import-begun");
    let outcome = (|| -> Result<Outcome, String> {
        let mut consumed = 0usize;
        let mut held = 0usize;
        for item in items {
            // The one mtime comparison in the milestone, and it dies with
            // this function: an attempt recorded against the file's CURRENT
            // mtime proves the legacy distiller processed this exact state.
            let accounted = legacy
                .attempts
                .get(&item.item_key)
                .is_some_and(|seen| seen == &item.modified_at);
            let state = if accounted {
                consumed += 1;
                SchedulerState::Consumed
            } else {
                held += 1;
                SchedulerState::BaselineHeld
            };
            scheduler::put(
                conn,
                vault_id,
                store_uuid,
                &Row {
                    item_key: item.item_key.clone(),
                    source_id: None,
                    content_hash: item.artifact_hash.clone(),
                    snapshot: item.snapshot.clone(),
                    event_cursor: cursor(legacy, &item.identity),
                    route: None,
                    state,
                },
            )?;
        }
        crate::crash::crash_point("runtime-import-rows-written");
        settings::set(
            conn,
            settings::IMPORT_COMPLETE,
            Some(vault_id),
            &super::now_utc(),
        )?;
        Ok(Outcome {
            items: items.len(),
            consumed,
            held,
            already_complete: false,
        })
    })();
    match outcome {
        Ok(outcome) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("legacy import: {e}"))?;
            crate::crash::crash_point("runtime-import-committed");
            Ok(outcome)
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("legacy import rolled back: {detail}"))
        }
    }
}

/// How many items are waiting for the owner's baseline decision.
pub fn held_count(conn: &Connection, vault_id: &str, store_uuid: &str) -> Result<i64, String> {
    Ok(scheduler::counts_by_state(conn, vault_id, store_uuid)?
        .into_iter()
        .find(|(state, _)| state == SchedulerState::BaselineHeld.as_str())
        .map(|(_, count)| count)
        .unwrap_or(0))
}

/// Apply the owner's choice to the whole held pile. Durable either way: the
/// question is asked once, not on every launch.
pub fn resolve(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    choice: Choice,
) -> Result<usize, String> {
    let to = match choice {
        Choice::Baseline => SchedulerState::Consumed,
        Choice::Process => SchedulerState::Pending,
    };
    scheduler::move_state(conn, vault_id, store_uuid, SchedulerState::BaselineHeld, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::entry::Entry;
    use crate::vault::testutil;

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn item(key: &str, modified: &str) -> Item {
        let mut entry = Entry::empty_for_test(key);
        entry.modified_at = modified.to_string();
        Item {
            item_key: key.to_string(),
            identity: key.to_string(),
            modified_at: modified.to_string(),
            artifact_hash: "c".repeat(64),
            snapshot: normalize::snapshot(&entry),
        }
    }

    #[test]
    fn a_legacy_attempt_at_the_current_state_is_the_only_thing_that_counts_as_done() {
        let (dir, conn, vault) = fixture("import-accounted");
        let legacy = LegacyState {
            attempts: BTreeMap::from([
                ("a.md".to_string(), "2026-08-01T00:00:00Z".to_string()),
                // Recorded against an OLDER state: the file moved since, and
                // nothing durable says whether that mattered.
                ("b.md".to_string(), "2026-07-01T00:00:00Z".to_string()),
            ]),
            ..LegacyState::default()
        };
        let items = [
            item("a.md", "2026-08-01T00:00:00Z"),
            item("b.md", "2026-08-01T00:00:00Z"),
            item("c.md", "2026-08-01T00:00:00Z"),
        ];
        let outcome = run(&conn, &vault, "store", &legacy, &items).unwrap();
        assert_eq!(outcome.consumed, 1);
        assert_eq!(outcome.held, 2, "unproven is held, never guessed");
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault, "store", SchedulerState::BaselineHeld).unwrap(),
            vec!["b.md".to_string(), "c.md".to_string()]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_first_launch_never_queues_the_whole_vault() {
        // The acceptance row: "first upgrade from legacy state → no automatic
        // stampede". Nothing is `pending` until a person says so.
        let (dir, conn, vault) = fixture("import-no-stampede");
        let items: Vec<Item> = (0..50)
            .map(|n| item(&format!("n{n:02}.md"), "2026-08-01T00:00:00Z"))
            .collect();
        run(&conn, &vault, "store", &LegacyState::default(), &items).unwrap();
        let pending = scheduler::counts_by_state(&conn, &vault, "store")
            .unwrap()
            .into_iter()
            .find(|(state, _)| state == "pending");
        assert_eq!(pending, None, "no item may be queued by the upgrade itself");
        assert_eq!(held_count(&conn, &vault, "store").unwrap(), 50);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn both_owner_choices_are_durable_and_only_one_of_them_spends() {
        let (dir, conn, vault) = fixture("import-choice");
        let items = [item("a.md", "t"), item("b.md", "t")];
        run(&conn, &vault, "store", &LegacyState::default(), &items).unwrap();

        assert_eq!(
            resolve(&conn, &vault, "store", Choice::Baseline).unwrap(),
            2
        );
        assert_eq!(held_count(&conn, &vault, "store").unwrap(), 0);
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault, "store", SchedulerState::Consumed).unwrap(),
            vec!["a.md".to_string(), "b.md".to_string()]
        );

        let other = testutil::temp_vault("import-choice-2");
        let vault_b = crate::runtime::scope::register(&conn, &other).unwrap();
        run(&conn, &vault_b, "store-b", &LegacyState::default(), &items).unwrap();
        assert_eq!(
            resolve(&conn, &vault_b, "store-b", Choice::Process).unwrap(),
            2
        );
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault_b, "store-b", SchedulerState::Pending).unwrap(),
            vec!["a.md".to_string(), "b.md".to_string()]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn the_import_runs_once_and_a_second_call_changes_nothing() {
        let (dir, conn, vault) = fixture("import-once");
        let items = [item("a.md", "t")];
        assert!(
            !run(&conn, &vault, "store", &LegacyState::default(), &items)
                .unwrap()
                .already_complete
        );
        resolve(&conn, &vault, "store", Choice::Baseline).unwrap();

        let second = run(&conn, &vault, "store", &LegacyState::default(), &items).unwrap();
        assert!(second.already_complete);
        assert_eq!(
            second.items, 0,
            "a re-import would undo the owner's decision"
        );
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault, "store", SchedulerState::Consumed).unwrap(),
            vec!["a.md".to_string()]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skill_and_trigger_cursors_survive_side_by_side() {
        let (dir, conn, vault) = fixture("import-cursor");
        let legacy = LegacyState {
            skill_runs: BTreeMap::from([("slug:sweep".to_string(), "2026-08-01".to_string())]),
            trigger_runs: BTreeMap::from([(
                "slug:sweep".to_string(),
                "2026-08-01T09:00:00Z".to_string(),
            )]),
            ..LegacyState::default()
        };
        let mut sweep = item("skills/sweep.md", "t");
        sweep.identity = "slug:sweep".into();
        run(&conn, &vault, "store", &legacy, &[sweep]).unwrap();
        let row = scheduler::get(&conn, &vault, "store", "skills/sweep.md")
            .unwrap()
            .unwrap();
        let cursor: serde_json::Value =
            serde_json::from_str(row.event_cursor.as_deref().unwrap()).unwrap();
        assert_eq!(cursor["skill_run"], "2026-08-01");
        assert_eq!(cursor["trigger_run"], "2026-08-01T09:00:00Z");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_item_with_no_legacy_cursor_stores_none_rather_than_an_empty_object() {
        let (dir, conn, vault) = fixture("import-no-cursor");
        run(
            &conn,
            &vault,
            "store",
            &LegacyState::default(),
            &[item("a.md", "t")],
        )
        .unwrap();
        let row = scheduler::get(&conn, &vault, "store", "a.md")
            .unwrap()
            .unwrap();
        assert_eq!(row.event_cursor, None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Child body for the import kill-point test.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the import kill-point test"]
    fn crash_scenario_import() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let _ = run(
            &conn,
            &vault,
            "store",
            &LegacyState::default(),
            &[item("a.md", "t"), item("b.md", "t")],
        );
    }

    /// Killed anywhere in the one-shot import, the next launch sees either an
    /// un-imported database or a completely imported one.
    ///
    /// The completion marker is written in the SAME transaction as the rows
    /// precisely so there is no third possibility — a half-imported database
    /// that claims it is done would silently skip real work forever, and it
    /// is the exact failure a separate "mark complete" statement produces.
    #[test]
    fn a_kill_during_the_import_never_leaves_it_half_done() {
        for (point, imported) in [
            ("runtime-import-begun", false),
            ("runtime-import-rows-written", false),
            ("runtime-import-committed", true),
        ] {
            let dir = testutil::temp_vault(&format!("import-kill-{point}"));
            let status = testutil::run_crash_scenario(
                "runtime::import::tests::crash_scenario_import",
                point,
                &dir,
            );
            assert!(!status.success(), "{point}: the child must have aborted");

            let conn = crate::runtime::open(&dir).unwrap();
            let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
            let marked = settings::get(&conn, settings::IMPORT_COMPLETE, Some(&vault))
                .unwrap()
                .is_some();
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM scheduler", [], |r| r.get(0))
                .unwrap();
            assert_eq!(marked, imported, "{point}: completion marker");
            assert_eq!(
                rows,
                if imported { 2 } else { 0 },
                "{point}: rows and marker agree — that is what one transaction buys"
            );

            // Either way, a later launch reaches the same complete state.
            run(
                &conn,
                &vault,
                "store",
                &LegacyState::default(),
                &[item("a.md", "t"), item("b.md", "t")],
            )
            .unwrap();
            assert_eq!(held_count(&conn, &vault, "store").unwrap(), 2, "{point}");
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn scanning_a_real_vault_hashes_bytes_and_skips_what_it_cannot_read() {
        let dir = testutil::temp_vault("import-scan");
        testutil::write(&dir, "a.md", "---\ntitle: A\n---\nbody\n");
        testutil::write(&dir, "b.md", "---\ntitle: B\n---\nbody\n");
        let items = current_items(&dir, &BTreeMap::new()).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i.item_key.as_str())
                .collect::<Vec<_>>(),
            vec!["a.md", "b.md"]
        );
        assert_ne!(
            items[0].artifact_hash, items[1].artifact_hash,
            "different bytes, different artifact"
        );
        assert!(items.iter().all(|i| i.artifact_hash.len() == 64));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
