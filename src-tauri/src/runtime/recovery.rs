//! Conservative recovery when the runtime DB is lost or quarantined
//! (M25.1).
//!
//! **The promise this milestone can honestly make is "no automatic duplicate
//! spend", not "no re-spend".** Deleting `runtime.db` deletes the token
//! telemetry with it; nothing can reconstruct what today cost. So recovery
//! does three things and refuses to pretend to a fourth:
//!
//! 1. ambient work pauses BEFORE any dispatcher can open;
//! 2. every item whose disposition is provable from a portable
//!    `ingest.assessed` receipt in the vault's own ledger is restored to that
//!    disposition; and
//! 3. everything else — changed bytes, no receipt, a receipt for an item that
//!    is gone — becomes `recovery_held`, which no dispatcher may leave.
//!
//! The budget is `unknown`, not zero. A day whose spend was forgotten is not
//! a day with budget left, and quietly resetting the counter to zero is
//! exactly the "silently resets spend" the acceptance matrix forbids. It
//! stays unknown until the next local-day window opens or the owner sets a
//! baseline. Attended chat is unaffected throughout and is metered again from
//! recovery onward.
//!
//! **Why the receipt reader is not here.** `ingest.assessed` is defined with
//! its producer in M25.3; a reader written a phase early would be a second
//! parser for a body that does not exist yet. [`receipts_in_ledger`] is the
//! seam, it returns nothing today, and the planner below is complete and
//! tested against injected receipts — so when M25.3 fills the reader, the
//! behaviour it drives is already proven.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;

use super::normalize::Snapshot;
use super::scheduler::{self, Row, SchedulerState};
use super::status::{self, RecoveryReason, RuntimeStatus};

/// What a portable receipt says happened to an item — the "Recovery" column
/// of the design's closed route matrix, and nothing else from it.
///
/// The route vocabulary itself belongs to `ingest.assessed` (M25.3); this is
/// the four destinies recovery can restore, so the mapping route → destiny
/// lives in exactly one place, beside the routes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriorDisposition {
    /// A terminal route: closed, applied, rejected, or an M26 completion.
    Consumed,
    /// A deterministic proposal is waiting for a human. Restored as itself —
    /// never re-dispatched, because the work is done and the decision is not.
    PendingReview,
    /// Queued for M26's semantic pass. Restored as pending; agents are off,
    /// so it waits visibly.
    PendingM26,
    /// Processing failed visibly. Restored HELD, never consumed and never
    /// automatically retried.
    FailedVisible,
}

impl PriorDisposition {
    fn restored_as(self) -> SchedulerState {
        match self {
            PriorDisposition::Consumed => SchedulerState::Consumed,
            PriorDisposition::PendingReview => SchedulerState::PendingReview,
            PriorDisposition::PendingM26 => SchedulerState::Pending,
            PriorDisposition::FailedVisible => SchedulerState::RecoveryHeld,
        }
    }
}

/// One portable receipt, reduced to what recovery needs. Deliberately carries
/// no tokens, no retries, no quota window, no duration, no model — a receipt
/// is not telemetry, and a recovery planner that could see spend would be the
/// first place telemetry leaked back in.
#[derive(Debug, Clone, PartialEq)]
pub struct Receipt {
    pub item_key: String,
    pub artifact_hash: String,
    pub disposition: PriorDisposition,
}

/// The current state of one item on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentItem {
    pub item_key: String,
    pub artifact_hash: String,
    pub snapshot: Snapshot,
}

/// What recovery decided, before it is written.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub rows: Vec<(String, SchedulerState)>,
    /// Receipts for items that are no longer on disk. Counted and reported,
    /// never resurrected: a deleted note is not work.
    pub orphaned_receipts: usize,
}

impl Plan {
    pub fn held(&self) -> usize {
        self.rows.iter().filter(|(_, s)| s.is_held()).count()
    }

    pub fn restored(&self) -> usize {
        self.rows.iter().filter(|(_, s)| !s.is_held()).count()
    }
}

/// Decide what each current item becomes, given the receipts a ledger holds.
///
/// The hash comparison is the whole judgement. A receipt describes an exact
/// artifact; if the bytes on disk have moved since, the receipt does not
/// describe them, and the honest answer is "held", not "probably fine".
pub fn plan(items: &[CurrentItem], receipts: &[Receipt]) -> Plan {
    let mut by_item: BTreeMap<&str, &Receipt> = BTreeMap::new();
    for receipt in receipts {
        // Later receipts supersede earlier ones for the same item; the reader
        // hands them over in ledger order, so last wins.
        by_item.insert(receipt.item_key.as_str(), receipt);
    }
    let mut rows = Vec::with_capacity(items.len());
    let mut matched = 0usize;
    for item in items {
        let state = match by_item.get(item.item_key.as_str()) {
            Some(receipt) if receipt.artifact_hash == item.artifact_hash => {
                matched += 1;
                receipt.disposition.restored_as()
            }
            // Changed bytes, or nothing recorded at all. Ambiguity is held.
            _ => SchedulerState::RecoveryHeld,
        };
        rows.push((item.item_key.clone(), state));
    }
    Plan {
        rows,
        orphaned_receipts: by_item.len().saturating_sub(matched),
    }
}

/// Write a plan into the scheduler and enter recovery mode.
///
/// One transaction: a kill halfway through would otherwise leave some items
/// restored and some absent, and the absent ones would look like new work.
pub fn apply(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    items: &[CurrentItem],
    plan: &Plan,
) -> Result<(), String> {
    let states: BTreeMap<&str, SchedulerState> = plan
        .rows
        .iter()
        .map(|(key, state)| (key.as_str(), *state))
        .collect();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("recovery: {e}"))?;
    crate::crash::crash_point("runtime-recovery-begun");
    let written = (|| -> Result<(), String> {
        for item in items {
            let state = states
                .get(item.item_key.as_str())
                .copied()
                .unwrap_or(SchedulerState::RecoveryHeld);
            scheduler::put(
                conn,
                vault_id,
                store_uuid,
                &Row {
                    item_key: item.item_key.clone(),
                    source_id: None,
                    content_hash: item.artifact_hash.clone(),
                    snapshot: item.snapshot.clone(),
                    event_cursor: None,
                    route: None,
                    state,
                },
            )?;
        }
        Ok(())
    })();
    match written {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("recovery: {e}"))?;
            crate::crash::crash_point("runtime-recovery-committed");
            Ok(())
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("recovery rolled back: {detail}"))
        }
    }
}

/// Portable processing receipts in a vault's ledger, oldest first.
///
/// **Empty until M25.3.** The `ingest.assessed` body, its validation, and its
/// reducer arm land with the producer that writes them; a reader here now
/// would be a second parser for bytes nothing emits. When that phase lands,
/// this function is the only thing that changes, and every behaviour it
/// drives is already covered by the tests below.
pub fn receipts_in_ledger(_vault: &Path) -> Result<Vec<Receipt>, String> {
    Ok(Vec::new())
}

/// Has this vault ever completed the one-shot upgrade in THIS database?
///
/// The distinction the whole entry decision rests on: a database with no
/// import marker and a ledger with no receipts is a first M25 launch, and a
/// database with no import marker whose ledger DOES hold receipts is a
/// database that was deleted. Guessing wrong in the first direction would
/// hold a whole vault for no reason; guessing wrong in the second would
/// re-spend it.
pub fn entry(conn: &Connection, vault_id: &str, receipts: &[Receipt]) -> Result<Entry, String> {
    let imported =
        super::settings::get(conn, super::settings::IMPORT_COMPLETE, Some(vault_id))?.is_some();
    Ok(if imported {
        Entry::Ready
    } else if receipts.is_empty() {
        Entry::FirstImport
    } else {
        Entry::Recover
    })
}

/// How a vault opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// Nothing to do; the scheduler already knows this vault.
    Ready,
    /// Never imported and nothing was ever processed — run the one-shot
    /// upgrade baseline.
    FirstImport,
    /// Never imported here, but the ledger proves work happened: the
    /// operational history was deleted.
    Recover,
}

/// Enter recovery mode: pause ambient work and say why. Idempotent.
pub fn begin(reason: RecoveryReason) {
    status::set(RuntimeStatus::Recovering { reason });
}

/// The owner resolved the held pile. Every held item becomes what they chose,
/// and ambient work may run again.
pub fn resolve(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    choice: super::import::Choice,
) -> Result<usize, String> {
    let to = match choice {
        super::import::Choice::Baseline => SchedulerState::Consumed,
        super::import::Choice::Process => SchedulerState::Pending,
    };
    let moved =
        scheduler::move_state(conn, vault_id, store_uuid, SchedulerState::RecoveryHeld, to)?;
    if matches!(status::current(), RuntimeStatus::Recovering { .. }) {
        status::clear();
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::normalize;
    use crate::vault::entry::Entry as VaultEntry;
    use crate::vault::testutil;

    fn current(key: &str, hash: &str) -> CurrentItem {
        CurrentItem {
            item_key: key.to_string(),
            artifact_hash: hash.repeat(64 / hash.len()),
            snapshot: normalize::snapshot(&VaultEntry::empty_for_test(key)),
        }
    }

    fn receipt(key: &str, hash: &str, disposition: PriorDisposition) -> Receipt {
        Receipt {
            item_key: key.to_string(),
            artifact_hash: hash.repeat(64 / hash.len()),
            disposition,
        }
    }

    #[test]
    fn each_disposition_restores_to_exactly_one_state() {
        // The route matrix's recovery column, in one place.
        assert_eq!(
            PriorDisposition::Consumed.restored_as(),
            SchedulerState::Consumed
        );
        assert_eq!(
            PriorDisposition::PendingReview.restored_as(),
            SchedulerState::PendingReview
        );
        assert_eq!(
            PriorDisposition::PendingM26.restored_as(),
            SchedulerState::Pending
        );
        assert_eq!(
            PriorDisposition::FailedVisible.restored_as(),
            SchedulerState::RecoveryHeld,
            "a visible failure is never restored as done"
        );
    }

    #[test]
    fn an_exact_receipt_restores_and_a_changed_artifact_is_held() {
        let items = [current("a.md", "a"), current("b.md", "b")];
        let receipts = [
            receipt("a.md", "a", PriorDisposition::Consumed),
            // Same item, different bytes than are on disk now.
            receipt("b.md", "c", PriorDisposition::Consumed),
        ];
        let plan = plan(&items, &receipts);
        assert_eq!(
            plan.rows,
            vec![
                ("a.md".to_string(), SchedulerState::Consumed),
                ("b.md".to_string(), SchedulerState::RecoveryHeld),
            ]
        );
        assert_eq!(plan.held(), 1);
        assert_eq!(plan.restored(), 1);
    }

    #[test]
    fn an_item_with_no_receipt_at_all_is_held_rather_than_queued() {
        let plan = plan(&[current("a.md", "a")], &[]);
        assert_eq!(
            plan.rows,
            vec![("a.md".to_string(), SchedulerState::RecoveryHeld)]
        );
    }

    #[test]
    fn a_receipt_for_a_deleted_note_is_counted_not_resurrected() {
        let plan = plan(
            &[current("a.md", "a")],
            &[
                receipt("a.md", "a", PriorDisposition::Consumed),
                receipt("gone.md", "d", PriorDisposition::Consumed),
            ],
        );
        assert_eq!(plan.rows.len(), 1);
        assert_eq!(plan.orphaned_receipts, 1);
    }

    #[test]
    fn the_last_receipt_for_an_item_wins() {
        // Receipts supersede; a queued receipt followed by its completion
        // must restore as consumed, not as still-queued.
        let plan = plan(
            &[current("a.md", "a")],
            &[
                receipt("a.md", "a", PriorDisposition::PendingM26),
                receipt("a.md", "a", PriorDisposition::Consumed),
            ],
        );
        assert_eq!(
            plan.rows,
            vec![("a.md".to_string(), SchedulerState::Consumed)]
        );
    }

    #[test]
    fn applying_a_plan_writes_every_item_and_holds_the_unplanned_ones() {
        let dir = testutil::temp_vault("recovery-apply");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let items = [current("a.md", "a"), current("b.md", "b")];
        let receipts = [receipt("a.md", "a", PriorDisposition::PendingReview)];
        let plan = plan(&items, &receipts);
        apply(&conn, &vault, "store", &items, &plan).unwrap();
        assert_eq!(
            scheduler::counts_by_state(&conn, &vault, "store").unwrap(),
            vec![
                ("pending_review".to_string(), 1),
                ("recovery_held".to_string(), 1)
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_pauses_ambient_and_the_owners_choice_releases_it() {
        let _lock = status::test_lock();
        let dir = testutil::temp_vault("recovery-resolve");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let items = [current("a.md", "a")];
        let plan = plan(&items, &[]);
        apply(&conn, &vault, "store", &items, &plan).unwrap();

        status::clear();
        begin(RecoveryReason::DatabaseLost);
        assert!(
            !status::ambient_allowed(),
            "recovery pauses before dispatch"
        );

        let moved = resolve(
            &conn,
            &vault,
            "store",
            crate::runtime::import::Choice::Process,
        )
        .unwrap();
        assert_eq!(moved, 1);
        assert!(status::ambient_allowed());
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault, "store", SchedulerState::Pending).unwrap(),
            vec!["a.md".to_string()]
        );
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_database_tells_a_first_launch_from_a_deleted_one() {
        let dir = testutil::temp_vault("recovery-entry");
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();

        // No marker, no receipts: nobody has ever run M25 here.
        assert_eq!(entry(&conn, &vault, &[]).unwrap(), Entry::FirstImport);
        // No marker, but the ledger proves work happened: the DB was deleted.
        assert_eq!(
            entry(
                &conn,
                &vault,
                &[receipt("a.md", "a", PriorDisposition::Consumed)]
            )
            .unwrap(),
            Entry::Recover
        );
        // Marker present: ordinary open.
        crate::runtime::import::run(
            &conn,
            &vault,
            "store",
            &crate::runtime::import::LegacyState::default(),
            &[],
        )
        .unwrap();
        assert_eq!(entry(&conn, &vault, &[]).unwrap(), Entry::Ready);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Child body for the recovery kill-point test.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the recovery kill-point test"]
    fn crash_scenario_recover() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let items = [current("a.md", "a"), current("b.md", "b")];
        let restore = plan(&items, &[receipt("a.md", "a", PriorDisposition::Consumed)]);
        let _ = apply(&conn, &vault, "store", &items, &restore);
    }

    /// Killed mid-recovery, no item is left looking like new work.
    ///
    /// A partially applied plan is the dangerous shape: the items that were
    /// written would be restored and the ones that were not would be absent,
    /// and an absent item is indistinguishable from a note the app has never
    /// seen — which is precisely the thing that gets automatically
    /// dispatched. One transaction is what makes "restored or absent as a
    /// SET" true.
    #[test]
    fn a_kill_during_recovery_restores_everything_or_nothing() {
        for (point, restored) in [
            ("runtime-recovery-begun", 0),
            ("runtime-recovery-committed", 2),
        ] {
            let dir = testutil::temp_vault(&format!("recovery-kill-{point}"));
            let status = testutil::run_crash_scenario(
                "runtime::recovery::tests::crash_scenario_recover",
                point,
                &dir,
            );
            assert!(!status.success(), "{point}: the child must have aborted");

            let conn = crate::runtime::open(&dir).unwrap();
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM scheduler", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, restored, "{point}: all of the plan, or none of it");
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_receipt_reader_is_empty_until_its_producer_ships() {
        // Named rather than silent: this is the M25.3 seam, and a test that
        // asserts today's answer is what makes tomorrow's change visible.
        let dir = testutil::temp_vault("recovery-reader");
        assert_eq!(receipts_in_ledger(&dir).unwrap(), Vec::new());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
