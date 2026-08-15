//! Scheduling the maintenance pass (M26.6c) — the lease, and the run.
//!
//! **Ambient, therefore budgeted.** Nobody is waiting for this. Unlike an
//! attended assembly, which is bounded but never refused, a maintenance pass
//! goes through M25's dispatch and is subject to every ambient gate: the daily
//! run ceiling, the token ceilings, quota, consecutive failures and elapsed
//! time. A deferral is a normal outcome and is reported as one.
//!
//! **It claims a lease with no items.** `dispatch::claim` takes the scheduler
//! item keys a run is taking responsibility for, and this pass takes none —
//! it reads the base's shape rather than a queue of files. An empty claim is
//! a supported shape (`claim_inner` only reports `NothingToClaim` when items
//! were named and none survived), and it still buys the one thing that
//! matters: the ambient lease, so a maintenance run and an ingest run cannot
//! spend the same subscription at the same moment.
//!
//! **Findings are still recorded only after a real run.** The lease is
//! claimed first, the pass writes second — so a deferral leaves every finding
//! unsaid and the next tick will offer them again.

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use crate::ledger::reduce::EpistemicState;
use crate::runtime::budget::{GateReason, Reservation};
use crate::runtime::dispatch::{self, Dispatched, ItemOutcome, RunOutcome};

use super::pass::{self, Runner, Tick};

/// What one maintenance run reserves.
///
/// Small on purpose, and small enough. The prompt is a list of ids and a
/// closed signal vocabulary — no source text, no belief prose — and the
/// proposals it can make are short, so a large reservation would push every
/// other ambient lane out of the day's budget for nothing.
///
/// **It must fit inside `max_ambient_run_tokens`.** A reservation over the
/// per-run cap is not "ambitious", it is a pass that can never run: the gate
/// refuses it every time with `reservation_exceeds_run_cap` and the findings
/// are never said. `the_reservation_fits_the_defaults_it_will_be_gated_against`
/// is the tripwire — it caught exactly that, once.
pub const RESERVATION: Reservation = Reservation {
    total_tokens: 12_000,
    output_tokens: 3_000,
};

/// What a scheduled attempt did.
#[derive(Debug, Clone, PartialEq)]
pub enum Scheduled {
    /// The gates said no. A normal outcome, reported rather than swallowed.
    Deferred(Vec<GateReason>),
    /// Nothing the base has not already been told — and no lease was taken,
    /// because a pass with nothing to say should not hold the one ambient
    /// lease while it decides that.
    NothingNew,
    /// The proposal surface is off (`agent_proposals_enabled=false`): the
    /// pass exists to propose, so spawning would be pure spend and
    /// recording would silence findings nobody could act on. Checked
    /// before the lease — a claimed lease is itself a cost — and after
    /// the nothing-new check, so a base with nothing to say stays
    /// [`Scheduled::NothingNew`] and a skip only ever describes findings
    /// that exist.
    SkippedNoProposalSurface,
    Ran {
        run_id: String,
        said: usize,
        already_said: usize,
    },
}

/// Try one maintenance pass.
///
/// The findings are computed BEFORE the lease is claimed, deliberately: the
/// one ambient lease is scarce, and taking it only to discover there was
/// nothing to say would block an ingest tick that had real work.
///
/// `proposals_enabled` is `agent_proposals_enabled`, handed IN rather than
/// read here: the switch lives in the app config, and this module
/// deliberately holds no app handle. The caller who has one (the ambient
/// supervisor) reads the file and passes the answer.
pub fn attempt<R: Runner>(
    conn: &Connection,
    context: &pass::Context<'_>,
    state: &EpistemicState,
    runner: &R,
    proposals_enabled: bool,
    now: DateTime<Utc>,
) -> Result<Scheduled, String> {
    // ONE derivation of "which beliefs are stale", shared with the lane a
    // person opens (M27.6b). A pass that computed its own could name work the
    // surface does not show.
    let stale = crate::attention::lanes::stale_beliefs(state, now)?;
    if !anything_new(conn, context, state, &stale)? {
        return Ok(Scheduled::NothingNew);
    }

    // There IS something to say — but with the proposal surface off, nobody
    // could act on it. Spawning would spend a subprocess for nothing, and
    // recording would mark findings as said that nobody ever heard. Skip
    // before the lease: a claimed lease is itself a cost.
    if !proposals_enabled {
        return Ok(Scheduled::SkippedNoProposalSurface);
    }

    let lease = match dispatch::claim(
        conn,
        context.vault_id,
        context.store_uuid,
        pass::LANE,
        RESERVATION,
        // No scheduler items: this pass reads the base's shape, not a queue.
        &[],
        now,
    )? {
        Dispatched::Started(lease) => lease,
        Dispatched::Deferred(reasons) => return Ok(Scheduled::Deferred(reasons)),
        // Unreachable with an empty claim, and mapped rather than panicked:
        // an impossible branch that crashes the supervisor is worse than one
        // that reports itself.
        Dispatched::NothingToClaim => return Ok(Scheduled::NothingNew),
    };

    let outcome = pass::tick(conn, context, state, &stale, runner, &lease.run_id, now);
    let (run_outcome, result) = match &outcome {
        Ok(_) => (RunOutcome::Succeeded, None),
        Err(detail) => (RunOutcome::Failed, Some(detail.clone())),
    };
    // Finalized whatever happened. A lease left running would hold the one
    // ambient slot until it expired, which is the failure mode M25's
    // consecutive-failure gate exists to notice rather than to cause.
    dispatch::finalize(
        conn,
        &lease.run_id,
        run_outcome,
        // The meter books real usage against this run id; there is nothing
        // honest to report from here.
        None,
        // No items were claimed, so there are none to land. `Consume` is the
        // no-op over an empty claim.
        ItemOutcome::Consume,
        now,
    )?;

    if let Some(detail) = result {
        return Err(detail);
    }
    Ok(match outcome? {
        Tick::NothingNew => Scheduled::NothingNew,
        Tick::Ran { said, already_said } => Scheduled::Ran {
            run_id: lease.run_id,
            said: said.len(),
            already_said,
        },
    })
}

/// Is there anything the base has not already been told?
fn anything_new(
    conn: &Connection,
    context: &pass::Context<'_>,
    state: &EpistemicState,
    stale: &std::collections::BTreeSet<String>,
) -> Result<bool, String> {
    let findings = pass::keyed(context.store_uuid, &super::candidates::find(state, stale));
    for finding in findings {
        if !pass::said_before(conn, context, &finding.key)? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture;
    use crate::vault::testutil;
    use std::cell::RefCell;

    const STORE: &str = "cafebabecafebabecafebabecafebabe";
    const HEAD: &str = "90000000000000000000000000000001";

    fn now() -> DateTime<Utc> {
        "2026-08-12T09:00:00Z".parse().unwrap()
    }

    struct Harness {
        conn: Connection,
        vault: std::path::PathBuf,
        vault_id: String,
        /// The process status is global, and `dispatch::claim` reads it. Two
        /// tests in two threads that both set and read one global pass alone
        /// and fail together, which is the least useful failure a suite can
        /// produce — so every test that reaches the gate serialises here, the
        /// same way `runtime::dispatch`'s do.
        _status: std::sync::MutexGuard<'static, ()>,
    }

    impl Harness {
        fn open(name: &str) -> Harness {
            let vault = testutil::temp_vault(name);
            let _status = crate::runtime::status::test_lock();
            // A fresh open is exactly when production clears it, so a test
            // holding the lock starts from the same place rather than
            // inheriting whatever the previous holder left behind.
            crate::runtime::status::clear();
            let conn = crate::runtime::open(&vault).unwrap();
            let vault_id = crate::runtime::scope::register(&conn, &vault).unwrap();
            Harness {
                conn,
                vault,
                vault_id,
                _status,
            }
        }

        fn context(&self) -> pass::Context<'_> {
            pass::Context {
                vault_id: &self.vault_id,
                store_uuid: STORE,
                chain_head: HEAD,
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    #[derive(Default)]
    struct Spy {
        runs: RefCell<usize>,
    }

    impl Runner for Spy {
        fn run(&self, run_id: &str, _: &str) -> Result<(), String> {
            // The lease's id reaches the runner, which is what lets the meter
            // book this run's tokens against the row the schedule finalizes.
            assert!(!run_id.is_empty(), "the runner was handed no lease");
            *self.runs.borrow_mut() += 1;
            Ok(())
        }
    }

    #[test]
    fn the_reservation_fits_the_defaults_it_will_be_gated_against() {
        // The defect this encodes: a reservation over `max_ambient_run_tokens`
        // is refused by the gate EVERY time, so the pass silently never runs
        // and every finding stays unsaid. Caught in review of this very file.
        let defaults = crate::runtime::budget::shipped_defaults().unwrap();
        assert!(
            RESERVATION.total_tokens <= defaults.max_ambient_run_tokens,
            "{} total exceeds the {} per-run cap",
            RESERVATION.total_tokens,
            defaults.max_ambient_run_tokens
        );
        assert!(
            RESERVATION.output_tokens <= defaults.max_ambient_run_output_tokens,
            "{} output exceeds the {} per-run cap",
            RESERVATION.output_tokens,
            defaults.max_ambient_run_output_tokens
        );
    }

    #[test]
    fn a_pass_with_something_to_say_takes_a_lease_and_gives_it_back() {
        let harness = Harness::open("maintain-schedule-run");
        let spy = Spy::default();
        let outcome = attempt(
            &harness.conn,
            &harness.context(),
            &fixture::state(),
            &spy,
            true,
            now(),
        )
        .unwrap();
        let Scheduled::Ran { run_id, said, .. } = outcome else {
            panic!("expected a run, got {outcome:?}");
        };
        assert!(said > 0);
        assert_eq!(*spy.runs.borrow(), 1);

        // The lease came back: a run left running would hold the one ambient
        // slot until it expired.
        let state: String = harness
            .conn
            .query_row(
                "SELECT outcome FROM runs WHERE run_id = ?1",
                [&run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "succeeded");
    }

    #[test]
    fn a_pass_with_nothing_to_say_never_takes_the_lease_at_all() {
        // The one ambient lease is scarce. Taking it to discover there was
        // nothing to say would block an ingest tick that had real work.
        let harness = Harness::open("maintain-schedule-quiet");
        let spy = Spy::default();
        let outcome = attempt(
            &harness.conn,
            &harness.context(),
            &EpistemicState::default(),
            &spy,
            true,
            now(),
        )
        .unwrap();
        assert_eq!(outcome, Scheduled::NothingNew);
        assert_eq!(*spy.runs.borrow(), 0);
        let runs: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(runs, 0, "no lease was claimed");
    }

    #[test]
    fn a_pass_that_cannot_propose_does_not_spend_and_does_not_silence() {
        // M31.4. The M26.6c ordering fix ensured we never record before the
        // run. This is the case ordering does not cover: a run that CANNOT
        // act, whose findings would still be marked said.
        let harness = Harness::open("maintain-schedule-no-proposal-surface");
        let spy = Spy::default();
        let state = fixture::state();
        let outcome = attempt(
            &harness.conn,
            &harness.context(),
            &state,
            &spy,
            false,
            now(),
        )
        .unwrap();
        assert_eq!(outcome, Scheduled::SkippedNoProposalSurface);
        assert_eq!(*spy.runs.borrow(), 0, "no CLI run was spawned");
        let runs: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(runs, 0, "no lease, no CLI, no tokens");
        // Every finding the pass would have said is still unsaid, so the
        // next tick — surface on — offers them again.
        let findings = pass::keyed(
            STORE,
            &crate::maintain::candidates::find(&state, &std::collections::BTreeSet::new()),
        );
        assert!(!findings.is_empty(), "the fixture has findings");
        for finding in &findings {
            assert!(
                !pass::said_before(&harness.conn, &harness.context(), &finding.key).unwrap(),
                "a finding nobody could act on has not been said"
            );
        }
    }

    #[test]
    fn the_second_pass_over_an_unchanged_base_takes_no_lease_either() {
        let harness = Harness::open("maintain-schedule-twice");
        let spy = Spy::default();
        let state = fixture::state();
        attempt(&harness.conn, &harness.context(), &state, &spy, true, now()).unwrap();
        let second = attempt(&harness.conn, &harness.context(), &state, &spy, true, now()).unwrap();
        assert_eq!(second, Scheduled::NothingNew);
        assert_eq!(*spy.runs.borrow(), 1);
        let runs: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            runs, 1,
            "and it did not claim a second lease to say nothing"
        );
    }

    #[test]
    fn a_run_that_fails_still_gives_the_lease_back_and_says_nothing() {
        struct Broken;
        impl Runner for Broken {
            fn run(&self, _: &str, _: &str) -> Result<(), String> {
                Err("the CLI would not start".into())
            }
        }
        let harness = Harness::open("maintain-schedule-broken");
        let detail = attempt(
            &harness.conn,
            &harness.context(),
            &fixture::state(),
            &Broken,
            true,
            now(),
        )
        .expect_err("the run failed");
        assert!(detail.contains("would not start"), "{detail}");

        let outcome: String = harness
            .conn
            .query_row("SELECT outcome FROM runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outcome, "failed", "the lease came back");
        let findings: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM maintenance_findings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(findings, 0, "and nothing was marked as said");
    }

    #[test]
    fn a_paused_runtime_defers_rather_than_running() {
        let harness = Harness::open("maintain-schedule-paused");
        crate::runtime::settings::set_global_pause(&harness.conn, true).unwrap();
        let spy = Spy::default();
        let outcome = attempt(
            &harness.conn,
            &harness.context(),
            &fixture::state(),
            &spy,
            true,
            now(),
        )
        .unwrap();
        assert!(
            matches!(outcome, Scheduled::Deferred(_)),
            "expected a deferral, got {outcome:?}"
        );
        assert_eq!(*spy.runs.borrow(), 0);
        let findings: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM maintenance_findings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(findings, 0, "a deferred pass leaves every finding unsaid");
    }
}
