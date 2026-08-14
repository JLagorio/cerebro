//! The deterministic pass (M26.4i) — every scanned item assessed, recorded,
//! and routed, in one batch and one transaction.
//!
//! [`plan`] decides and [`commit`] writes, the same split
//! `runtime::catchup` uses and for the same reason: everything worth
//! asserting about this module is a decision, and a decision that needs a
//! vault, a database and a writer to test is a decision nobody tests.
//!
//! **One batch for the whole pass.** Every item's Observation and receipt
//! commit together (M25.3's association guarantee), and so does every source
//! registration they pin. One `append_batch` means a crash exposes either the
//! prior state or the complete pass — never half a vault assessed with the
//! other half looking like new work on the next launch.
//!
//! **The operation key is a digest of the receipt-id set, never a
//! timestamp.** A pass that crashed after writing the ledger and before
//! writing the scheduler retries with the identical member list, and an
//! operation key derived from WHAT was decided replays it instead of
//! appending a second copy. A key with a clock in it would append twice, the
//! second append would be refused member by member, and the pass would be
//! permanently stuck.
//!
//! **An already-recorded receipt appends nothing and charges nothing.** M25.3
//! says identical bytes append once; the reducer refuses a second, and
//! `append_batch` refuses a WHOLE batch over one already-claimed member key.
//! So a receipt the store already holds is dropped from the batch, and its
//! item is landed where its LATEST recorded receipt says — which is how
//! reverting a file to bytes the base already assessed costs nothing instead
//! of buying a second opinion on the same content.
//!
//! **The window key stamped here names the window an item was PLANNED into,
//! not the one that closes it.** They can differ: an item queued while the
//! budget gate was shut waits for the next affordable run, which will have
//! its own residual and its own key. The reducer permits the difference on
//! purpose — `check_receipt_against_outcome` compares the SUCCESSOR's key to
//! its outcome's, and both come from the closing window. An item that waited
//! a tick for budget is not an error.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::Route;
use crate::ledger::sha256_hex;
use crate::runtime::catchup::Scanned;
use crate::runtime::normalize::Snapshot;
use crate::runtime::scheduler::{self, Row, SchedulerState};

use super::assess::{self, Assessment, Placement};
use super::pass::Commit;
use super::source::{self, Provenance};
use super::window::{self, Assessed};

/// One item to assess: what is on disk, and what the scheduler last recorded.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub scanned: Scanned,
    pub prior: Option<Row>,
    /// Catch-up already compared the stored hash against the bytes on disk;
    /// its answer is taken rather than the file read a second time.
    pub artifact_changed: bool,
}

/// One assessed item and where it lands.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub assessment: Assessment,
    /// `false` when the store already holds this receipt, so it is not in the
    /// batch. Its item is still landed.
    pub fresh: bool,
    pub landing: SchedulerState,
    /// The snapshot the item was assessed AT — the prior for the next pass.
    pub snapshot: Snapshot,
}

/// What one deterministic pass will write.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// In item-key order — the order the batch is laid out in.
    pub planned: Vec<Planned>,
    /// The batch, in commit order. Empty when every receipt already exists.
    pub members: Vec<(String, serde_json::Value)>,
    pub operation_key: String,
    /// The window the queued items were planned into, if any queued.
    pub batch_key: Option<String>,
}

impl Plan {
    /// How many items this pass sends to a model — the number the prefilter
    /// exists to keep small.
    pub fn queued(&self) -> usize {
        self.planned
            .iter()
            .filter(|p| p.assessment.route == Route::M26Queued)
            .count()
    }

    /// Every item the pass assessed, in the shape `window::plan` and
    /// `pass::Input` take.
    pub fn assessed(&self) -> Vec<Assessed> {
        self.planned.iter().map(assessed_of).collect()
    }
}

fn assessed_of(planned: &Planned) -> Assessed {
    Assessed {
        receipt_id: planned.assessment.receipt_id.clone(),
        item_id: planned.assessment.item_id.clone(),
        route: planned.assessment.route,
    }
}

/// Decide what one pass writes. Pure: no connection, no writer, no clock.
pub fn plan(
    state: &EpistemicState,
    store_uuid: &str,
    chain_head: &str,
    items: &[Item],
) -> Result<Plan, String> {
    // Sorted, so the batch layout is a function of the item set rather than
    // of whatever order the scanner walked the disk in. The operation key
    // covers the receipts, but the member ORDINALS are what same-batch refs
    // resolve through, and two runs that laid them out differently would be
    // two logical plans for one piece of work.
    let mut ordered: Vec<&Item> = items.iter().collect();
    ordered.sort_by(|a, b| a.scanned.item_key.cmp(&b.scanned.item_key));
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for item in &ordered {
        if !seen.insert(item.scanned.item_key.as_str()) {
            return Err(format!(
                "item {} appears twice in one pass — two assessments of one file would mint two \
                 receipts for the same bytes",
                item.scanned.item_key
            ));
        }
    }

    // Resolve the sources this pass needs, in a fixed order, so the ordinal a
    // staged registration takes does not depend on which file happened to be
    // scanned first.
    let mut needed: BTreeSet<Provenance> = BTreeSet::new();
    for item in &ordered {
        needed.insert(source::provenance_of(&item.scanned.item_key));
    }
    let mut registrations: Vec<(String, serde_json::Value)> = Vec::new();
    let mut resolved: BTreeMap<Provenance, (String, String)> = BTreeMap::new();
    for provenance in needed {
        let (source_id, event, staged) =
            source::resolve(state, store_uuid, provenance, registrations.len());
        if let Some(member) = staged {
            registrations.push(member);
        }
        resolved.insert(provenance, (source_id, event));
    }

    // Assess. The Observation ordinal and the window key are stamped after,
    // because both depend on which assessments turn out to be fresh, and that
    // depends on the receipt ids the assessment itself produces.
    let mut planned: Vec<Planned> = Vec::with_capacity(ordered.len());
    for item in &ordered {
        let provenance = source::provenance_of(&item.scanned.item_key);
        let (source_id, registration_event) = &resolved[&provenance];
        let assessment = assess::assess_item(
            store_uuid,
            chain_head,
            &item.scanned,
            item.prior.as_ref(),
            item.artifact_changed,
            &Placement {
                source_id,
                registration_event,
                observation_ordinal: 0,
            },
        )?;
        let fresh = !state.ingest_receipts.contains_key(&assessment.receipt_id);
        let landing = if fresh {
            landing_for(assessment.route)?
        } else {
            landing_for(latest_route(state, &assessment)?)?
        };
        planned.push(Planned {
            snapshot: item.scanned.snapshot.clone(),
            assessment,
            fresh,
            landing,
        });
    }

    // The window every queued receipt is stamped with, derived through the
    // same planner the run will use so there is one definition of what a
    // window is. Stamped BEFORE the batch is serialized: a receipt that got
    // its key afterwards would be committed without it.
    let fresh: Vec<Assessed> = planned
        .iter()
        .filter(|p| p.fresh)
        .map(assessed_of)
        .collect();
    let batch_key = window::plan(store_uuid, &fresh)?
        .window
        .map(|w| w.batch_key);
    if let Some(key) = &batch_key {
        for entry in planned
            .iter_mut()
            .filter(|p| p.fresh && p.assessment.route == Route::M26Queued)
        {
            entry.assessment.set_batch_key(key);
        }
    }

    // Lay the batch out: registrations first, then Observation-then-receipt
    // per fresh item.
    let mut members = registrations;
    let mut receipt_ids: Vec<String> = Vec::new();
    for entry in planned.iter_mut().filter(|p| p.fresh) {
        entry.assessment.place(members.len());
        members.extend(entry.assessment.members());
        receipt_ids.push(entry.assessment.receipt_id.clone());
    }

    Ok(Plan {
        operation_key: operation_key(store_uuid, &receipt_ids),
        members,
        batch_key,
        planned,
    })
}

/// The route of the most recent receipt for an already-assessed item.
///
/// A queued one is still waiting for a run; one a window superseded is
/// finished. Reading the latest rather than the one we just re-derived is
/// what stops a reverted file being queued a second time.
fn latest_route(state: &EpistemicState, assessment: &Assessment) -> Result<Route, String> {
    let key = (
        assessment.receipt.source_id.clone(),
        assessment.item_id.clone(),
    );
    state
        .ingest_latest
        .get(&key)
        .and_then(|id| state.ingest_receipts.get(id))
        .map(|receipt| receipt.route)
        .ok_or_else(|| {
            format!(
                "receipt {} is recorded and its item has no latest receipt — the reducer writes \
                 both indexes together, so one without the other is a corrupt read",
                assessment.receipt_id
            )
        })
}

fn landing_for(route: Route) -> Result<SchedulerState, String> {
    SchedulerState::parse(route.scheduler_state()).ok_or_else(|| {
        format!(
            "route {} lands in {:?}, which is not a scheduler state",
            route.as_str(),
            route.scheduler_state()
        )
    })
}

/// `m26-assess-v1:<digest of the store and the sorted receipt ids>`.
///
/// What was decided, and nothing about when. See the module note.
fn operation_key(store_uuid: &str, receipt_ids: &[String]) -> String {
    let mut sorted: Vec<&str> = receipt_ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"m26-assess-v1");
    for part in std::iter::once(store_uuid).chain(sorted) {
        bytes.push(0);
        bytes.extend_from_slice(part.as_bytes());
    }
    format!("m26-assess-v1:{}", sha256_hex(&bytes))
}

/// What one committed pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Committed {
    /// Receipts appended.
    pub appended: usize,
    /// Assessments the store already held.
    pub replayed: usize,
    /// Scheduler rows written.
    pub landed: usize,
    /// Rows that had moved on — claimed by a run, or held for an owner — and
    /// were left alone.
    pub skipped: usize,
}

/// Append the pass's batch, then land its items.
///
/// **Ledger first, runtime second**, the order `ingest::pass` argues for: a
/// crash between them leaves receipts recovery can read, and the reverse
/// would land items in the runtime DB with nothing on disk saying why.
pub fn commit<C: Commit>(
    conn: &Connection,
    committer: &C,
    vault_id: &str,
    store_uuid: &str,
    plan: &Plan,
) -> Result<Committed, String> {
    if !plan.members.is_empty() {
        committer.append_batch(plan.members.clone(), &plan.operation_key)?;
    }
    crate::crash::crash_point("ingest-deterministic-committed");

    let mut done = Committed {
        appended: plan.planned.iter().filter(|p| p.fresh).count(),
        replayed: plan.planned.iter().filter(|p| !p.fresh).count(),
        ..Committed::default()
    };
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("deterministic pass: {e}"))?;
    let written = (|| -> Result<(), String> {
        for entry in &plan.planned {
            let key = &entry.assessment.item_key;
            // Only an item still waiting for this pass is landed by it. A row
            // a run has claimed, or one an owner is holding, belongs to
            // somebody else — and `scheduler::put` would clear its claim.
            if let Some(row) = scheduler::get(conn, vault_id, store_uuid, key)? {
                if row.state != SchedulerState::Pending {
                    done.skipped += 1;
                    continue;
                }
            }
            scheduler::put(
                conn,
                vault_id,
                store_uuid,
                &Row {
                    item_key: key.clone(),
                    source_id: Some(entry.assessment.receipt.source_id.clone()),
                    // The item has been assessed, so the bytes and the
                    // snapshot it was assessed AT become the prior for next
                    // time. Leaving the old ones would make every later scan
                    // re-assess the same change forever.
                    content_hash: entry.assessment.receipt.artifact_hash.clone(),
                    snapshot: entry.snapshot.clone(),
                    event_cursor: None,
                    route: Some(entry.assessment.route.as_str().to_string()),
                    state: entry.landing,
                },
            )?;
            done.landed += 1;
        }
        Ok(())
    })();
    match written {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("deterministic pass: {e}"))?;
            crate::crash::crash_point("ingest-deterministic-landed");
            Ok(done)
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("the deterministic pass rolled back: {detail}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::ledger::schema;
    use crate::ledger::writer::LedgerWriter;
    use crate::ledger::{ledger_dir, read_ledger, reduce::reduce, store};
    use crate::runtime::normalize;
    use crate::vault::entry::Entry;
    use crate::vault::testutil;

    const HEAD: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";

    struct Rig {
        dir: std::path::PathBuf,
        conn: Connection,
        writer: LedgerWriter,
        vault_id: String,
        store_uuid: String,
    }

    struct RigCommit<'a> {
        writer: RefCell<&'a mut LedgerWriter>,
    }

    impl Commit for RigCommit<'_> {
        fn append_batch(
            &self,
            events: Vec<(String, serde_json::Value)>,
            operation_key: &str,
        ) -> Result<(), String> {
            self.writer
                .borrow_mut()
                .append_batch(events, Some(operation_key))
                .map(|_| ())
        }
    }

    fn rig(label: &str) -> Rig {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault_id = crate::runtime::scope::register(&conn, &dir).unwrap();
        let writer = LedgerWriter::open(&dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab").unwrap();
        let store_uuid = store::load(&ledger_dir(&dir)).unwrap().unwrap().store_id;
        Rig {
            dir,
            conn,
            writer,
            vault_id,
            store_uuid,
        }
    }

    impl Rig {
        fn state(&self) -> EpistemicState {
            let read = read_ledger(&ledger_dir(&self.dir)).unwrap();
            reduce(&read.frames, &self.store_uuid)
        }

        fn plan(&self, items: &[Item]) -> Plan {
            plan(&self.state(), &self.store_uuid, HEAD, items).unwrap()
        }

        fn commit(&mut self, plan: &Plan) -> Committed {
            // Disjoint field borrows: the committer holds the writer while
            // `commit` reads the connection.
            let Rig {
                conn,
                writer,
                vault_id,
                store_uuid,
                ..
            } = self;
            let committer = RigCommit {
                writer: RefCell::new(writer),
            };
            commit(conn, &committer, vault_id, store_uuid, plan).unwrap()
        }

        fn row(&self, key: &str) -> Row {
            scheduler::get(&self.conn, &self.vault_id, &self.store_uuid, key)
                .unwrap()
                .expect("a row")
        }

        fn pending(&self, item: &Item) {
            let prior = item.prior.as_ref();
            scheduler::put(
                &self.conn,
                &self.vault_id,
                &self.store_uuid,
                &Row {
                    item_key: item.scanned.item_key.clone(),
                    source_id: None,
                    content_hash: prior
                        .map(|p| p.content_hash.clone())
                        .unwrap_or_else(|| item.scanned.artifact_hash.clone()),
                    snapshot: prior
                        .map(|p| p.snapshot.clone())
                        .unwrap_or_else(|| item.scanned.snapshot.clone()),
                    event_cursor: None,
                    route: None,
                    state: SchedulerState::Pending,
                },
            )
            .unwrap();
        }

        fn teardown(self) {
            drop(self.conn);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn entry(key: &str, title: &str) -> Entry {
        let mut entry = Entry::empty_for_test(key);
        entry.title = title.into();
        entry
    }

    fn item(key: &str, title: &str, bytes: &str, prior: Option<(&str, &str)>) -> Item {
        Item {
            scanned: Scanned {
                item_key: key.to_string(),
                artifact_hash: normalize::artifact_hash(bytes.as_bytes()),
                snapshot: normalize::snapshot(&entry(key, title)),
            },
            prior: prior.map(|(prior_title, prior_bytes)| Row {
                item_key: key.to_string(),
                source_id: None,
                content_hash: normalize::artifact_hash(prior_bytes.as_bytes()),
                snapshot: normalize::snapshot(&entry(key, prior_title)),
                event_cursor: None,
                route: None,
                state: SchedulerState::Pending,
            }),
            artifact_changed: true,
        }
    }

    #[test]
    fn a_first_pass_registers_the_source_and_records_every_item() {
        let mut rig = rig("det-first");
        let items = vec![
            item("records/a.md", "Alpha", "a", None),
            item("records/b.md", "Beta", "b", None),
        ];
        for item in &items {
            rig.pending(item);
        }
        let plan = rig.plan(&items);
        // One registration, then Observation-then-receipt per item.
        assert_eq!(plan.members.len(), 1 + 2 * 2);
        assert_eq!(plan.members[0].0, schema::KIND_SOURCE_REGISTERED);
        assert_eq!(plan.members[1].0, schema::KIND_OBSERVATION_RECORDED);
        assert_eq!(plan.members[2].0, schema::KIND_INGEST_ASSESSED);

        let done = rig.commit(&plan);
        assert_eq!(done.appended, 2);
        assert_eq!(done.landed, 2);
        let state = rig.state();
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(state.ingest_receipts.len(), 2);
        assert_eq!(state.sources.len(), 1);
        let row = rig.row("records/a.md");
        assert_eq!(row.state, SchedulerState::Pending);
        assert_eq!(
            row.route.as_deref(),
            Some("m26_queued"),
            "a file the base has never seen is all news"
        );
        rig.teardown();
    }

    #[test]
    fn the_bundle_and_the_users_notes_register_as_two_sources_in_one_batch() {
        // The provenance split, exercised where both registrations ride the
        // same batch — the case that made `source::resolve` take an ordinal.
        let mut rig = rig("det-two-sources");
        let items = vec![
            item("knowledge/metrics/revenue.md", "Revenue", "k", None),
            item("records/a.md", "Alpha", "a", None),
        ];
        for item in &items {
            rig.pending(item);
        }
        let plan = rig.plan(&items);
        assert_eq!(plan.members.len(), 2 + 2 * 2);
        rig.commit(&plan);
        let state = rig.state();
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(state.sources.len(), 2, "two sources, not one");
        let sources: BTreeSet<&str> = state
            .ingest_receipts
            .values()
            .map(|r| r.source_id.as_str())
            .collect();
        assert_eq!(sources.len(), 2, "and the two items are under both");
        rig.teardown();
    }

    #[test]
    fn a_reformat_is_recorded_consumed_and_never_queued() {
        // THE property, at the pass that owns it: bytes moved, no normalized
        // field did, so the item finishes without a model ever looking.
        let mut rig = rig("det-reformat");
        let items = vec![item(
            "records/a.md",
            "Alpha",
            "reformatted",
            Some(("Alpha", "a")),
        )];
        rig.pending(&items[0]);
        let plan = rig.plan(&items);
        assert_eq!(plan.queued(), 0);
        assert!(plan.batch_key.is_none(), "no window, no key, no run");
        rig.commit(&plan);
        let row = rig.row("records/a.md");
        assert_eq!(row.state, SchedulerState::Consumed);
        assert_eq!(row.route.as_deref(), Some("closed_non_material"));
        let state = rig.state();
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(
            state.ingest_receipts.values().next().unwrap().route,
            Route::ClosedNonMaterial
        );
        rig.teardown();
    }

    #[test]
    fn every_queued_receipt_in_a_pass_carries_the_same_window_key() {
        let mut rig = rig("det-window-key");
        let items = vec![
            item("records/a.md", "Alpha2", "a2", Some(("Alpha", "a"))),
            item("records/b.md", "Beta2", "b2", Some(("Beta", "b"))),
            item("records/c.md", "Gamma", "c-reformat", Some(("Gamma", "c"))),
        ];
        for item in &items {
            rig.pending(item);
        }
        let plan = rig.plan(&items);
        assert_eq!(plan.queued(), 2, "the reformat does not queue");
        let key = plan.batch_key.clone().expect("a window");
        for entry in &plan.planned {
            let stamped = entry.assessment.receipt.m26_batch_key.as_deref();
            if entry.assessment.route == Route::M26Queued {
                assert_eq!(stamped, Some(key.as_str()));
            } else {
                assert_eq!(stamped, None, "a closed route forbids a key");
            }
        }
        rig.commit(&plan);
        let state = rig.state();
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        rig.teardown();
    }

    #[test]
    fn re_running_an_identical_pass_replays_rather_than_appending_twice() {
        // The crash-between-stores case: the ledger is committed, the
        // scheduler is not, and the retry must not mint a second receipt for
        // work already recorded.
        let mut rig = rig("det-replay");
        let items = vec![item("records/a.md", "Beta", "b", Some(("Alpha", "a")))];
        rig.pending(&items[0]);
        let first = rig.plan(&items);
        rig.commit(&first);
        assert_eq!(rig.state().ingest_receipts.len(), 1);

        let again = rig.plan(&items);
        assert!(again.members.is_empty(), "nothing left to append");
        let done = rig.commit(&again);
        assert_eq!(done.appended, 0);
        assert_eq!(done.replayed, 1);
        assert_eq!(rig.state().ingest_receipts.len(), 1, "one receipt, still");
        rig.teardown();
    }

    #[test]
    fn a_file_reverted_to_bytes_the_base_already_assessed_costs_nothing() {
        // The receipt id covers the bytes, so a revert re-derives a receipt
        // the store already holds. Appending it again is refused by the
        // reducer; queuing it again would buy a second opinion on content the
        // base has already read.
        let mut rig = rig("det-revert");
        let first = vec![item("records/a.md", "Beta", "b", Some(("Alpha", "a")))];
        rig.pending(&first[0]);
        let plan = rig.plan(&first);
        rig.commit(&plan);
        assert_eq!(rig.row("records/a.md").state, SchedulerState::Pending);

        // Move it on, as a completed window would.
        scheduler::put(
            &rig.conn,
            &rig.vault_id,
            &rig.store_uuid,
            &Row {
                state: SchedulerState::Consumed,
                ..rig.row("records/a.md")
            },
        )
        .unwrap();
        // Now edit away and back again.
        let away = vec![item("records/a.md", "Gamma", "c", Some(("Beta", "b")))];
        rig.pending(&away[0]);
        let plan = rig.plan(&away);
        rig.commit(&plan);
        let back = vec![item("records/a.md", "Beta", "b", Some(("Gamma", "c")))];
        rig.pending(&back[0]);
        let plan = rig.plan(&back);
        assert!(plan.members.is_empty(), "the receipt is already recorded");
        rig.commit(&plan);
        assert_eq!(
            rig.state().ingest_receipts.len(),
            2,
            "two receipts, not three"
        );
        rig.teardown();
    }

    #[test]
    fn the_operation_key_is_the_decision_and_never_the_clock() {
        // Two plans over the same items, built at different moments, share a
        // key — that is what makes an uncertain commit replay.
        let rig = rig("det-op-key");
        let items = vec![item("records/a.md", "Beta", "b", Some(("Alpha", "a")))];
        let a = rig.plan(&items);
        let b = rig.plan(&items);
        assert_eq!(a.operation_key, b.operation_key);
        assert_eq!(a.members, b.members);

        let more = vec![
            items[0].clone(),
            item("records/b.md", "Delta", "d", Some(("Gamma", "c"))),
        ];
        assert_ne!(a.operation_key, rig.plan(&more).operation_key);
        rig.teardown();
    }

    #[test]
    fn the_layout_does_not_depend_on_the_order_the_disk_was_walked() {
        let rig = rig("det-order");
        let a = item("records/a.md", "Beta", "b", Some(("Alpha", "a")));
        let b = item("records/b.md", "Delta", "d", Some(("Gamma", "c")));
        let forward = rig.plan(&[a.clone(), b.clone()]);
        let reverse = rig.plan(&[b, a]);
        assert_eq!(forward.members, reverse.members);
        assert_eq!(forward.operation_key, reverse.operation_key);
        rig.teardown();
    }

    #[test]
    fn a_row_somebody_else_owns_is_left_alone() {
        // `scheduler::put` clears `claimed_by_run_id` and both held states
        // are the owner's to leave. Landing over either would be this pass
        // taking work that is not its own.
        let mut rig = rig("det-held");
        let items = vec![item("records/a.md", "Beta", "b", Some(("Alpha", "a")))];
        rig.pending(&items[0]);
        let plan = rig.plan(&items);
        scheduler::put(
            &rig.conn,
            &rig.vault_id,
            &rig.store_uuid,
            &Row {
                state: SchedulerState::RecoveryHeld,
                ..rig.row("records/a.md")
            },
        )
        .unwrap();
        let done = rig.commit(&plan);
        assert_eq!(done.skipped, 1);
        assert_eq!(done.landed, 0);
        assert_eq!(rig.row("records/a.md").state, SchedulerState::RecoveryHeld);
        // The receipt still landed: the ledger records what was decided even
        // when the runtime row is not this pass's to move.
        assert_eq!(rig.state().ingest_receipts.len(), 1);
        rig.teardown();
    }

    #[test]
    fn a_landed_row_carries_the_bytes_it_was_assessed_at() {
        // Otherwise the next scan sees the same change again, forever.
        let mut rig = rig("det-advance");
        let items = vec![item("records/a.md", "Beta", "b", Some(("Alpha", "a")))];
        rig.pending(&items[0]);
        let plan = rig.plan(&items);
        rig.commit(&plan);
        let row = rig.row("records/a.md");
        assert_eq!(row.content_hash, items[0].scanned.artifact_hash);
        assert_eq!(row.snapshot, items[0].scanned.snapshot);
        assert!(row.source_id.is_some(), "the row names its source");
        rig.teardown();
    }

    #[test]
    fn one_file_twice_in_a_pass_is_refused() {
        let rig = rig("det-dupe");
        let one = item("records/a.md", "Beta", "b", Some(("Alpha", "a")));
        let err = plan(&rig.state(), &rig.store_uuid, HEAD, &[one.clone(), one]).unwrap_err();
        assert!(err.contains("appears twice"), "{err}");
        rig.teardown();
    }

    #[test]
    fn an_empty_pass_writes_nothing() {
        let mut rig = rig("det-empty");
        let plan = rig.plan(&[]);
        assert!(plan.members.is_empty());
        assert!(plan.batch_key.is_none());
        let done = rig.commit(&plan);
        assert_eq!(done, Committed::default());
        rig.teardown();
    }
}
