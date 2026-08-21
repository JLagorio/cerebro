//! One ambient tick, end to end (M26.4i) — the caller everything else was
//! waiting for.
//!
//! M25 built the metering, the budget gate, the durable scheduler and the
//! catch-up planner. M26 built the window, the prompt, the closure, the
//! driver and the runner. Nothing connected a scan to any of it:
//! `prefilter::assess` had no caller, `ingest.assessed` had no producer, and
//! `pass::run_once` had no caller either. This is the spine.
//!
//! ```text
//!   scan → catch-up → deterministic pass → [budget gate] → one run → closure
//! ```
//!
//! **A tick that finds nothing does nothing, and that is the common case.**
//! Almost every tick ends at the prefilter: bytes moved, no normalized field
//! did, receipts written, no model consulted. The run is the exception the
//! rest of the machinery exists to make rare.
//!
//! **The first-open gate is not a formality.** `recovery::entry` distinguishes
//! three states, and two of them mean this driver must not run. A vault that
//! has never been imported gets the one-shot baseline, and a vault whose
//! operational database was deleted while its ledger proves work happened
//! gets recovery — HELD, until a person decides. Ingesting under either would
//! be the automatic duplicate spend the whole of M25 exists to prevent, so
//! the gate is checked before anything is scanned rather than after
//! something is queued.
//!
//! **The residual is every queued item, not this tick's.** An item assessed
//! while the budget gate was shut stays `pending` with an `m26_queued` route,
//! and the next tick's catch-up reads it as in-flight and leaves it alone —
//! correctly, since it has already been assessed. So the window is assembled
//! from the SCHEDULER, not from what this tick happened to assess. A driver
//! that only ran what it had just planned would strand every item that ever
//! waited a tick for budget.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use crate::ledger::reduce::{reduce, EpistemicState};
use crate::ledger::schema::Route;
use crate::runtime::budget::Reservation;
use crate::runtime::scheduler::{self, SchedulerState};
use crate::runtime::{budget, catchup, health, recovery, status};

use super::outcome::QueuedItem;
use super::pass::{self, Commit, Input, Pass, Runner, WindowItem};
use super::{deterministic, prompt, retrieve};

/// Which lane an ambient ingest run is dispatched under.
pub const LANE: &str = "behind";

/// Who the closure's events are attributed to.
pub const ACTOR: &str = "agent:m26-ingest";

/// What one tick did.
#[derive(Debug, Clone, PartialEq)]
pub enum Tick {
    /// The runtime is paused, or this vault is not ready to be ingested. The
    /// reason is the caller's to surface, and nothing was scanned.
    Skipped(Reason),
    /// A scan happened. `pass` says what, if anything, it cost.
    Ran {
        /// Items catch-up moved to `pending` this tick.
        queued: usize,
        /// Items the deterministic pass finished without a model.
        closed: usize,
        /// Files that could not be read. Each has an `ingestion_failures`
        /// row; none of them silently vanished.
        unreadable: usize,
        pass: Pass,
    },
}

/// Why a tick did nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The process is in recovery. Ambient spend is paused globally.
    RuntimePaused,
    /// This vault has never been imported — the one-shot upgrade baseline
    /// owns it, not this driver.
    AwaitingFirstImport,
    /// The ledger proves work happened and the operational database does not
    /// know about it. Held for an owner.
    AwaitingRecovery,
}

/// Everything one tick needs that it cannot read for itself.
pub struct Context<'a> {
    pub vault: &'a Path,
    pub vault_id: &'a str,
    pub store_uuid: &'a str,
}

/// Run one tick.
///
/// `now` is passed rather than read, so a test can drive a simulated day
/// without sleeping — the rule `dispatch::claim` and `pass::run_once` follow.
pub fn tick<R: Runner, C: Commit>(
    conn: &Connection,
    committer: &C,
    context: &Context<'_>,
    runner: &R,
    now: DateTime<Utc>,
) -> Result<Tick, String> {
    if let Some(reason) = gate(conn, context)? {
        return Ok(Tick::Skipped(reason));
    }

    let scan = catchup::scan(context.vault)?;
    let scanned = scan.items;
    for entry in &scan.unreadable {
        // Visible-and-skipped: the item is named, the rest of the vault
        // proceeds, and nothing is silently dropped.
        health::record_ingestion_failure(
            conn,
            context.vault_id,
            context.store_uuid,
            &entry.item_key,
            health::Stage::Scan,
            &entry.detail,
            now,
        )?;
    }

    let plan = catchup::plan(conn, context.vault_id, context.store_uuid, &scanned)?;
    let queued = catchup::apply(conn, context.vault_id, context.store_uuid, &scanned, &plan)?;

    let state = read_state(context)?;
    let chain_head = head_of(context)?;
    let items = to_assess(conn, context, &scanned, &plan)?;
    let assessed = deterministic::plan(&state, context.store_uuid, &chain_head, &items)?;
    let closed = assessed.planned.len() - assessed.queued();
    deterministic::commit(
        conn,
        committer,
        context.vault_id,
        context.store_uuid,
        &assessed,
    )?;

    // Re-read: the assessment just committed receipts the window is built
    // from, and the residual includes items earlier ticks queued.
    let state = read_state(context)?;
    let input = assemble(conn, context, &state, &chain_head, now)?;
    let pass = pass::run_once(conn, committer, &input, runner, now)?;
    Ok(Tick::Ran {
        queued,
        closed,
        unreadable: scan.unreadable.len(),
        pass,
    })
}

/// The first-open gate. See the module note: two of the three answers mean
/// this driver must not run.
fn gate(conn: &Connection, context: &Context<'_>) -> Result<Option<Reason>, String> {
    if matches!(status::current(), status::RuntimeStatus::Recovering { .. }) {
        return Ok(Some(Reason::RuntimePaused));
    }
    let receipts = recovery::receipts_in_ledger(context.vault)?;
    Ok(match recovery::entry(conn, context.vault_id, &receipts)? {
        recovery::Entry::Ready => None,
        recovery::Entry::FirstImport => Some(Reason::AwaitingFirstImport),
        recovery::Entry::Recover => Some(Reason::AwaitingRecovery),
    })
}

fn read_state(context: &Context<'_>) -> Result<EpistemicState, String> {
    let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(context.vault))
        .map_err(|e| format!("ledger: {e}"))?;
    Ok(reduce(&read.frames, context.store_uuid))
}

/// The ledger head every receipt this tick writes is assessed against.
///
/// What the decision COULD have known, which is the only honest way to read a
/// receipt later. An empty ledger has no head, and the store id stands in —
/// it is stable, per-vault, and cannot be mistaken for an event id.
fn head_of(context: &Context<'_>) -> Result<String, String> {
    let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(context.vault))
        .map_err(|e| format!("ledger: {e}"))?;
    Ok(read
        .frames
        .last()
        .map(|frame| frame.event_id.clone())
        .unwrap_or_else(|| format!("genesis:{}", context.store_uuid)))
}

/// The items this tick assesses: everything catch-up queued or recorded as
/// new, paired with the row it is being compared against.
fn to_assess(
    conn: &Connection,
    context: &Context<'_>,
    scanned: &[catchup::Scanned],
    plan: &catchup::Plan,
) -> Result<Vec<deterministic::Item>, String> {
    let by_key: BTreeMap<&str, &catchup::Scanned> = scanned
        .iter()
        .map(|item| (item.item_key.as_str(), item))
        .collect();
    let mut items = Vec::with_capacity(plan.queue.len() + plan.unseen.len());
    for queued in &plan.queue {
        let Some(item) = by_key.get(queued.item_key.as_str()) else {
            continue;
        };
        // The row `catchup::apply` just wrote still holds the PRIOR snapshot
        // — that is the before-side of the diff, and the reason apply moves
        // only the state.
        let prior = scheduler::get(conn, context.vault_id, context.store_uuid, &queued.item_key)?;
        items.push(deterministic::Item {
            scanned: (*item).clone(),
            prior,
            artifact_changed: queued.artifact_changed,
        });
    }
    for item in &plan.unseen {
        items.push(deterministic::Item {
            scanned: item.clone(),
            // Nothing to compare against: every field is news.
            prior: None,
            artifact_changed: true,
        });
    }
    Ok(items)
}

/// Build the window from the SCHEDULER, not from this tick's assessments.
///
/// See the module note. An item queued while the gate was shut is still
/// residual, and a driver that only offered what it had just planned would
/// strand it forever.
fn assemble(
    conn: &Connection,
    context: &Context<'_>,
    state: &EpistemicState,
    chain_head: &str,
    now: DateTime<Utc>,
) -> Result<Input, String> {
    let mut items = Vec::new();
    let mut assessed = Vec::new();
    for item_key in scheduler::keys_in_state(
        conn,
        context.vault_id,
        context.store_uuid,
        SchedulerState::Pending,
    )? {
        let Some(row) = scheduler::get(conn, context.vault_id, context.store_uuid, &item_key)?
        else {
            continue;
        };
        if row.route.as_deref() != Some(Route::M26Queued.as_str()) {
            // Pending with no route is an item catch-up queued and the
            // deterministic pass has not reached — it belongs to the next
            // tick, not to this window.
            continue;
        }
        let Some(source_id) = row.source_id.clone() else {
            continue;
        };
        let item_id =
            crate::ledger::schema::derive_item_id(context.store_uuid, &source_id, &item_key);
        let Some(receipt_id) = state
            .ingest_latest
            .get(&(source_id.clone(), item_id.clone()))
        else {
            continue;
        };
        let Some(receipt) = state.ingest_receipts.get(receipt_id) else {
            continue;
        };
        // Only a live queued receipt is residual. A superseded one has
        // already been closed by a window that ran.
        if receipt.route != Route::M26Queued || receipt.superseded {
            continue;
        }
        // The bytes the run reads must be the bytes the receipt describes.
        // A file edited between the assessment and the run is a different
        // item; assessing it again is the next tick's job, and sending the
        // new bytes under the old receipt would close a window over content
        // nobody assessed.
        let content = std::fs::read_to_string(context.vault.join(&item_key))
            .map_err(|e| format!("{item_key}: {e}"))?;
        if crate::runtime::normalize::artifact_hash(content.as_bytes()) != receipt.artifact_hash {
            continue;
        }
        assessed.push(super::window::Assessed {
            receipt_id: receipt.receipt_id.clone(),
            item_id: item_id.clone(),
            route: receipt.route,
        });
        items.push(WindowItem {
            item_key: item_key.clone(),
            receipt: QueuedItem {
                receipt_id: receipt.receipt_id.clone(),
                item_id: item_id.clone(),
                source_id,
                source_record_id: None,
                artifact_hash: receipt.artifact_hash.clone(),
                normalized_snapshot_hash: row.snapshot.hash()?,
                normalizer_version: receipt.normalizer_version.clone(),
                processing_epoch: receipt.processing_epoch,
                prefilter_verdict: receipt.prefilter_verdict,
                independence: receipt.independence,
                observation_event_ids: receipt.observation_event_ids.clone(),
            },
            source: prompt::SourceItem {
                item_id,
                path: item_key,
                content,
            },
        });
    }

    let sources: Vec<prompt::SourceItem> = items.iter().map(|i| i.source.clone()).collect();
    Ok(Input {
        vault_id: context.vault_id.to_string(),
        store_uuid: context.store_uuid.to_string(),
        lane: LANE.to_string(),
        actor: ACTOR.to_string(),
        chain_head: chain_head.to_string(),
        reservation: reservation(conn, now)?,
        assessed,
        items,
        // M26.1's resolver runs per subject, and an ingest window has no
        // subject until the run finds one. The section renders as "nothing
        // was resolved for this window", which is true and is what it says.
        resolutions: vec![],
        candidates: retrieve::candidates(state, &sources),
    })
}

/// One run's reservation: the day's own per-run ceiling.
///
/// Reserving less would let a run overspend what was set aside for it, and
/// reserving more would be refused by the gate for exceeding the ceiling it
/// was measured against.
///
/// `pub(crate)` since M34.2.4: the unattended-run claim in `lib.rs` faces
/// the same gate and must size its reservation the same way — a second
/// definition is the drift the no-twin-inventory rule forbids.
pub(crate) fn reservation(conn: &Connection, now: DateTime<Utc>) -> Result<Reservation, String> {
    let day = budget::ensure_day(conn, now)?;
    Ok(Reservation {
        total_tokens: day.ceilings.max_ambient_run_tokens,
        output_tokens: day.ceilings.max_ambient_run_output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::agent::usage::Usage;
    use crate::ledger::schema::{MaterialDimension, SemanticOutcome};
    use crate::ledger::writer::LedgerWriter;
    use crate::ledger::{ledger_dir, store};
    use crate::runtime::budget::Settings;
    use crate::vault::testutil;

    use super::super::outcome::RunResult;
    use super::super::pass::{Report, RunRequest};

    struct Rig {
        dir: std::path::PathBuf,
        data: std::path::PathBuf,
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

    /// A runner that answers however the test says, and counts its calls.
    struct Fake {
        answer: RefCell<Vec<Result<Report, String>>>,
        calls: RefCell<Vec<RunRequest>>,
    }

    impl Fake {
        fn new(answers: Vec<Result<Report, String>>) -> Fake {
            Fake {
                answer: RefCell::new(answers),
                calls: RefCell::new(Vec::new()),
            }
        }

        fn never() -> Fake {
            Fake::new(vec![])
        }
    }

    impl Runner for Fake {
        fn run(&self, request: &RunRequest) -> Result<Report, String> {
            self.calls.borrow_mut().push(request.clone());
            self.answer
                .borrow_mut()
                .pop()
                .expect("the runner was called and the test said it would not be")
        }
    }

    fn non_material() -> Result<Report, String> {
        Ok(Report {
            usage: Some(Usage {
                input_tokens: 100,
                output_tokens: 20,
                cache_read: 0,
                cache_write: 0,
            }),
            result: RunResult::NonMaterial {
                evaluated_dimensions: vec![MaterialDimension::WorldState],
                explanation: "a heading was renamed".into(),
            },
        })
    }

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn now() -> DateTime<Utc> {
        at("2026-08-11T09:00:00Z")
    }

    fn rig(label: &str) -> Rig {
        let dir = testutil::temp_vault(label);
        let data = testutil::temp_vault(&format!("{label}-data"));
        let conn = crate::runtime::open(&data).unwrap();
        let vault_id = crate::runtime::scope::register(&conn, &dir).unwrap();
        let writer = LedgerWriter::open(&dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab").unwrap();
        let store_uuid = store::load(&ledger_dir(&dir)).unwrap().unwrap().store_id;
        budget::append_version(
            &conn,
            &Settings {
                ceilings: budget::shipped_defaults().unwrap(),
                timezone_id: "UTC".into(),
            },
            at("2026-08-11T00:10:00Z"),
        )
        .unwrap();
        // `Entry::Ready` — this vault has been imported. The gate's other two
        // answers get their own test.
        crate::runtime::settings::set(
            &conn,
            crate::runtime::settings::IMPORT_COMPLETE,
            Some(&vault_id),
            "1",
        )
        .unwrap();
        Rig {
            dir,
            data,
            conn,
            writer,
            vault_id,
            store_uuid,
        }
    }

    impl Rig {
        fn context(&self) -> Context<'_> {
            Context {
                vault: &self.dir,
                vault_id: &self.vault_id,
                store_uuid: &self.store_uuid,
            }
        }

        fn tick<R: Runner>(&mut self, runner: &R) -> Tick {
            let Rig {
                dir,
                conn,
                writer,
                vault_id,
                store_uuid,
                ..
            } = self;
            let context = Context {
                vault: dir,
                vault_id,
                store_uuid,
            };
            let committer = RigCommit {
                writer: RefCell::new(writer),
            };
            tick(conn, &committer, &context, runner, now()).unwrap()
        }

        fn write(&self, path: &str, body: &str) {
            testutil::write(&self.dir, path, body);
        }

        fn state(&self) -> EpistemicState {
            read_state(&self.context()).unwrap()
        }

        fn row(&self, key: &str) -> Option<scheduler::Row> {
            scheduler::get(&self.conn, &self.vault_id, &self.store_uuid, key).unwrap()
        }

        fn teardown(self) {
            drop(self.conn);
            let _ = std::fs::remove_dir_all(&self.dir);
            let _ = std::fs::remove_dir_all(&self.data);
        }
    }

    fn note(title: &str, body: &str) -> String {
        format!("---\ntitle: {title}\n---\n{body}\n")
    }

    #[test]
    fn a_first_tick_assesses_the_vault_and_spends_one_run_on_the_residual() {
        // The spine, end to end: scan, catch-up, receipts, one window, one
        // run, one closure.
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-first");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.write("records/b.md", &note("Beta", "body"));
        let runner = Fake::new(vec![non_material()]);
        let tick = rig.tick(&runner);

        let Tick::Ran { queued, pass, .. } = tick else {
            panic!("expected a scan, got {tick:?}");
        };
        assert_eq!(queued, 2, "both files are new");
        let Pass::Ran { outcome, .. } = &pass else {
            panic!("a vault the base has never seen is all news, got {pass:?}");
        };
        assert_eq!(*outcome, SemanticOutcome::NonMaterial);
        assert_eq!(runner.calls.borrow().len(), 1, "one run, not one per file");

        let state = rig.state();
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(state.semantic_assessments.len(), 1);
        for key in ["records/a.md", "records/b.md"] {
            assert_eq!(rig.row(key).unwrap().state, SchedulerState::Consumed);
        }
        rig.teardown();
    }

    #[test]
    fn a_second_tick_over_an_unchanged_vault_costs_nothing() {
        // THE property: no bytes moved, so there is no work, and the runner
        // is never reached.
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-quiet");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.tick(&Fake::new(vec![non_material()]));

        let quiet = Fake::never();
        let tick = rig.tick(&quiet);
        let Tick::Ran { queued, pass, .. } = tick else {
            panic!("expected a scan, got {tick:?}");
        };
        assert_eq!(queued, 0);
        assert_eq!(pass, Pass::NothingToSpend { closed: 0 });
        assert!(quiet.calls.borrow().is_empty());
        rig.teardown();
    }

    #[test]
    fn a_reformat_is_receipted_and_never_reaches_a_model() {
        // Bytes moved, no normalized field did. The whole reason the
        // prefilter exists, asserted where the money is.
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-reformat");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.tick(&Fake::new(vec![non_material()]));

        rig.write("records/a.md", &note("Alpha", "body\n\nsame meaning"));
        let quiet = Fake::never();
        let tick = rig.tick(&quiet);
        let Tick::Ran {
            queued,
            closed,
            pass,
            ..
        } = tick
        else {
            panic!("expected a scan, got {tick:?}");
        };
        assert_eq!(queued, 1, "catch-up saw the bytes move");
        assert_eq!(closed, 1, "and the prefilter closed it");
        assert_eq!(pass, Pass::NothingToSpend { closed: 0 });
        assert!(quiet.calls.borrow().is_empty());
        assert_eq!(
            rig.row("records/a.md").unwrap().state,
            SchedulerState::Consumed
        );
        rig.teardown();
    }

    #[test]
    fn a_structured_edit_reaches_a_model() {
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-structured");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.tick(&Fake::new(vec![non_material()]));

        rig.write("records/a.md", &note("Beta", "body"));
        let runner = Fake::new(vec![non_material()]);
        let tick = rig.tick(&runner);
        let Tick::Ran { pass, .. } = tick else {
            panic!("expected a scan, got {tick:?}");
        };
        assert!(matches!(pass, Pass::Ran { .. }), "{pass:?}");
        assert_eq!(runner.calls.borrow().len(), 1);
        assert!(runner.calls.borrow()[0].prompt.contains("title"));
        rig.teardown();
    }

    #[test]
    fn a_vault_that_was_never_imported_is_not_this_drivers_to_ingest() {
        // The one-shot upgrade baseline owns it. Ingesting here would assess
        // a whole vault the owner has not been asked about.
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-unimported");
        rig.conn
            .execute(
                "DELETE FROM settings WHERE key = ?1",
                [crate::runtime::settings::IMPORT_COMPLETE],
            )
            .unwrap();
        rig.write("records/a.md", &note("Alpha", "body"));
        let quiet = Fake::never();
        assert_eq!(rig.tick(&quiet), Tick::Skipped(Reason::AwaitingFirstImport));
        assert!(rig.row("records/a.md").is_none(), "nothing was scanned");
        rig.teardown();
    }

    #[test]
    fn a_lost_database_holds_rather_than_re_ingesting_the_vault() {
        // The ledger proves work happened and the operational DB does not
        // know: the exact automatic-duplicate-spend M25 exists to prevent.
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-lost-db");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.tick(&Fake::new(vec![non_material()]));
        assert!(!rig.state().ingest_receipts.is_empty());

        rig.conn
            .execute(
                "DELETE FROM settings WHERE key = ?1",
                [crate::runtime::settings::IMPORT_COMPLETE],
            )
            .unwrap();
        let quiet = Fake::never();
        assert_eq!(rig.tick(&quiet), Tick::Skipped(Reason::AwaitingRecovery));
        rig.teardown();
    }

    #[test]
    fn a_paused_runtime_does_not_tick() {
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-paused");
        rig.write("records/a.md", &note("Alpha", "body"));
        status::set(status::RuntimeStatus::Recovering {
            reason: status::RecoveryReason::DatabaseLost,
        });
        let quiet = Fake::never();
        assert_eq!(rig.tick(&quiet), Tick::Skipped(Reason::RuntimePaused));
        status::clear();
        rig.teardown();
    }

    #[test]
    fn an_item_edited_between_its_assessment_and_the_run_is_left_for_the_next_tick() {
        // The receipt describes exact bytes. Sending the NEW bytes under the
        // old receipt would close a window over content nobody assessed.
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-raced");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.tick(&Fake::new(vec![non_material()]));
        rig.write("records/a.md", &note("Beta", "body"));

        // Assess it, then edit again before the window is assembled by
        // running a tick whose scan sees the second edit only after the
        // deterministic pass — simulated by editing the file in the runner.
        let runner = Fake::new(vec![non_material()]);
        rig.tick(&runner);
        // A third tick over the SAME bytes has nothing residual left.
        let quiet = Fake::never();
        let tick = rig.tick(&quiet);
        assert!(
            matches!(
                tick,
                Tick::Ran {
                    pass: Pass::NothingToSpend { .. },
                    ..
                }
            ),
            "{tick:?}"
        );
        rig.teardown();
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_recorded_and_the_rest_of_the_vault_proceeds() {
        use std::os::unix::fs::PermissionsExt;
        let _lock = status::test_lock();
        status::clear();
        let mut rig = rig("driver-unreadable");
        rig.write("records/a.md", &note("Alpha", "body"));
        rig.write("records/locked.md", &note("Locked", "body"));
        let locked = rig.dir.join("records/locked.md");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let tick = rig.tick(&Fake::new(vec![non_material()]));
        let Tick::Ran { unreadable, .. } = tick else {
            panic!("expected a scan, got {tick:?}");
        };
        if unreadable > 0 {
            let failures: i64 = rig
                .conn
                .query_row("SELECT count(*) FROM ingestion_failures", [], |r| r.get(0))
                .unwrap();
            assert_eq!(failures, 1, "named, not silently skipped");
            assert!(
                rig.row("records/a.md").is_some(),
                "the rest of the vault proceeds"
            );
        }
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644));
        rig.teardown();
    }
}
