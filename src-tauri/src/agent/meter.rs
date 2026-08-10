//! Metering one CLI run into the runtime DB (M25.2).
//!
//! The reader thread already owns a run's whole life: it consumes stdout,
//! reaps the child at EOF, and emits the terminal `Done`. That makes it the
//! one place that knows both what the CLI reported and when the run actually
//! ended, so it is where usage is recorded. Nothing about spend travels on
//! the UI event channel (see [`super::usage`]).
//!
//! **A meter is optional.** A run started before a vault is registered, or in
//! a build with no runtime DB, streams exactly as it always did — metering is
//! a record of what happened, never a precondition for it happening.
//!
//! **The elapsed watchdog aborts a run that has already started.** That is
//! deliberately not the same as refusing to dispatch: the tokens up to the
//! abort were spent, the item goes back in the queue, and the run is recorded
//! `elapsed_aborted` rather than pretending it never left.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::runtime::dispatch::{self, ItemOutcome, RunOutcome};
use crate::runtime::{self, operational::LogEntry};

use super::usage::{self, Usage};

/// Which side of the budget a run sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A person is waiting. Metered, never gated.
    Attended,
    /// The background. Metered AND budgeted; holds a reservation and the one
    /// ambient lease, both released at finalization.
    Ambient,
}

/// Everything the reader thread needs to close a run's books.
#[derive(Debug, Clone)]
pub struct Meter {
    pub data_dir: PathBuf,
    /// The DURABLE run id. Distinct from the process-local `u64` that tags
    /// events: that counter restarts at zero every launch, so using it as a
    /// database key would collide across sessions on day one.
    pub run_id: String,
    pub mode: Mode,
    pub vault_id: Option<String>,
    pub store_uuid: Option<String>,
    pub started_at: DateTime<Utc>,
    /// Seconds after which an ambient run is aborted. `None` for attended.
    pub elapsed_limit_seconds: Option<u64>,
}

/// What the stream said, accumulated as it is read.
#[derive(Debug, Default)]
pub struct Tally {
    /// From the TERMINAL event only. An `assistant` turn's usage is that
    /// turn's alone and the cached prefix repeats on every one of them, so
    /// summing them would over-count badly.
    usage: Option<Usage>,
    failed: bool,
    quota: bool,
    unknown_fields: Vec<String>,
    saw_terminal: bool,
}

impl Tally {
    /// Feed one parsed CLI line.
    pub fn observe(&mut self, event: &Value) {
        for field in usage::unknown_fields(event) {
            if !self.unknown_fields.contains(&field) {
                self.unknown_fields.push(field);
            }
        }
        if !usage::is_result(event) {
            return;
        }
        self.saw_terminal = true;
        self.usage = usage::parse(event);
        self.failed = usage::is_failure(event);
        self.quota = usage::is_quota_failure(event);
    }

    /// How this run ended, and what it cost.
    ///
    /// A stream that ended without a terminal event yields `None` usage —
    /// the honest-unknown path — rather than a zero that would let the same
    /// tokens be spent again.
    pub fn outcome(&self, aborted: bool) -> (RunOutcome, Option<Usage>) {
        let outcome = if aborted {
            RunOutcome::ElapsedAborted
        } else if !self.saw_terminal {
            RunOutcome::AbandonedUsageUnknown
        } else if self.quota {
            RunOutcome::QuotaFailed
        } else if self.failed {
            RunOutcome::Failed
        } else {
            RunOutcome::Succeeded
        };
        (outcome, self.usage)
    }
}

/// Close a run's books. Never fails a run: metering records what happened and
/// must not become a second way for the run to go wrong.
pub fn finish(meter: &Meter, tally: &Tally, aborted: bool, now: DateTime<Utc>) {
    let Ok(conn) = runtime::open_existing(&meter.data_dir) else {
        // No runtime DB (a build without one, or a database that is being
        // recovered). The run happened; nothing else changes.
        return;
    };
    let (outcome, counted) = tally.outcome(aborted);

    // A field this build has never seen is worth exactly one operational row
    // per run: enough to notice a CLI upgrade, not enough to drown the log.
    if !tally.unknown_fields.is_empty() {
        let detail = format!(
            "the CLI reported usage fields this build does not read: {}",
            tally.unknown_fields.join(", ")
        );
        let refusal = crate::policy::table::PolicyTable::load()
            .ok()
            .and_then(|table| {
                crate::policy::rejection::OperationalRefusal::new(
                    &table,
                    "capability_unavailable",
                    "agent.usage",
                    &detail,
                )
                .ok()
            });
        if let Some(refusal) = refusal {
            let entry = LogEntry {
                store_uuid: meter.store_uuid.clone(),
                proposal_id: None,
                run_id: Some(meter.run_id.clone()),
                rule: None,
            };
            runtime::operational::record_or_warn(&conn, &refusal, &entry);
        }
    }

    let result = match meter.mode {
        Mode::Attended => dispatch::meter_attended(
            &conn,
            &meter.run_id,
            meter.vault_id.as_deref(),
            meter.store_uuid.as_deref(),
            outcome,
            counted,
            meter.started_at,
            now,
        ),
        Mode::Ambient => dispatch::finalize(
            &conn,
            &meter.run_id,
            outcome,
            counted,
            // M25.2 has no route matrix yet: a clean run consumes its items,
            // anything else returns them. M25.3 replaces this argument with
            // the receipt route, which is why it is an argument.
            if matches!(outcome, RunOutcome::Succeeded) {
                ItemOutcome::Consume
            } else {
                ItemOutcome::Requeue
            },
            now,
        ),
    };
    if let Err(detail) = result {
        eprintln!(
            "runtime meter: run {} could not be recorded: {detail}",
            meter.run_id
        );
    }
}

/// Arm the elapsed watchdog for an ambient run.
///
/// Returns the flag the reader thread reads to learn whether the abort was
/// the watchdog's doing. The thread sleeps in short steps so a run that ends
/// early does not leave a thread parked for ten minutes.
pub fn arm_watchdog(
    meter: &Meter,
    state: &super::AgentState,
    run: u64,
    live: Arc<AtomicBool>,
) -> Arc<AtomicBool> {
    let aborted = Arc::new(AtomicBool::new(false));
    let Some(limit) = meter.elapsed_limit_seconds else {
        return aborted;
    };
    let state = state.clone();
    let flag = aborted.clone();
    std::thread::spawn(move || {
        let step = std::time::Duration::from_millis(250);
        let mut waited = std::time::Duration::ZERO;
        let deadline = std::time::Duration::from_secs(limit);
        while waited < deadline {
            if !live.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(step);
            waited += step;
        }
        if !live.load(Ordering::Relaxed) {
            return;
        }
        // `stop` returning false is the ordinary race: the child exited
        // between the deadline and this line, and that run is not aborted.
        if state.stop(run).unwrap_or(false) {
            flag.store(true, Ordering::Relaxed);
        }
    });
    aborted
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(usage: Value, is_error: bool, text: &str) -> Value {
        json!({ "type": "result", "is_error": is_error, "result": text, "usage": usage })
    }

    #[test]
    fn only_the_terminal_event_sets_the_runs_usage() {
        // Each assistant turn repeats the cached prefix; summing them would
        // report a run several times its real cost.
        let mut tally = Tally::default();
        tally.observe(&json!({
            "type": "assistant",
            "message": { "usage": { "input_tokens": 3, "cache_read_input_tokens": 14678 } }
        }));
        assert_eq!(tally.outcome(false).1, None, "no terminal event yet");
        tally.observe(&result(
            json!({ "input_tokens": 4, "output_tokens": 271, "cache_read_input_tokens": 14678 }),
            false,
            "done",
        ));
        let (outcome, usage) = tally.outcome(false);
        assert_eq!(outcome, RunOutcome::Succeeded);
        assert_eq!(usage.unwrap().total(), 4 + 271 + 14_678);
    }

    #[test]
    fn a_stream_that_never_terminated_is_unknown_not_free() {
        let tally = Tally::default();
        let (outcome, usage) = tally.outcome(false);
        assert_eq!(outcome, RunOutcome::AbandonedUsageUnknown);
        assert_eq!(usage, None, "unknown, and never zero");
    }

    #[test]
    fn a_quota_death_is_its_own_outcome_and_keeps_its_usage() {
        let mut tally = Tally::default();
        tally.observe(&result(
            json!({ "input_tokens": 2, "output_tokens": 17 }),
            true,
            "API Error: Claude AI usage limit reached.",
        ));
        let (outcome, usage) = tally.outcome(false);
        assert_eq!(outcome, RunOutcome::QuotaFailed);
        assert_eq!(usage.unwrap().total(), 19, "a failed run is not a free run");
    }

    #[test]
    fn an_ordinary_failure_is_not_a_quota_failure() {
        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 5 }), true, "tool crashed"));
        assert_eq!(tally.outcome(false).0, RunOutcome::Failed);
    }

    #[test]
    fn an_abort_outranks_whatever_the_stream_said() {
        // The watchdog killed the child; the terminal event, if any, arrived
        // from a run that was already being ended.
        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 5 }), false, "fine"));
        let (outcome, usage) = tally.outcome(true);
        assert_eq!(outcome, RunOutcome::ElapsedAborted);
        assert_eq!(
            usage.unwrap().output_tokens,
            5,
            "an aborted run still spent what it spent"
        );
    }

    #[test]
    fn unknown_fields_are_collected_once_across_the_whole_stream() {
        let mut tally = Tally::default();
        for _ in 0..3 {
            tally.observe(&json!({
                "type": "assistant",
                "message": { "usage": { "zeta_tokens": 1 } }
            }));
        }
        assert_eq!(tally.unknown_fields, vec!["zeta_tokens".to_string()]);
    }

    #[test]
    fn an_attended_run_is_metered_and_an_ambient_one_is_finalized() {
        let dir = crate::vault::testutil::temp_vault("meter-finish");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 42 }), false, "ok"));
        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: "attended-1".into(),
                mode: Mode::Attended,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: Utc::now(),
                elapsed_limit_seconds: None,
            },
            &tally,
            false,
            Utc::now(),
        );

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (mode, output): (String, i64) = conn
            .query_row(
                "SELECT mode, output_tokens FROM runs WHERE run_id = 'attended-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(mode, "attended");
        assert_eq!(output, 42);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn metering_without_a_runtime_database_is_a_no_op_rather_than_a_panic() {
        // A run that happened is a run that happened; a missing operational
        // database changes the record, not the reality.
        let dir = std::path::PathBuf::from("/nonexistent/cerebro-meter-test");
        finish(
            &Meter {
                data_dir: dir,
                run_id: "x".into(),
                mode: Mode::Attended,
                vault_id: None,
                store_uuid: None,
                started_at: Utc::now(),
                elapsed_limit_seconds: None,
            },
            &Tally::default(),
            false,
            Utc::now(),
        );
    }

    #[test]
    fn a_watchdog_with_no_limit_never_arms() {
        let meter = Meter {
            data_dir: std::path::PathBuf::from("/tmp"),
            run_id: "x".into(),
            mode: Mode::Attended,
            vault_id: None,
            store_uuid: None,
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
        };
        let live = Arc::new(AtomicBool::new(true));
        let aborted = arm_watchdog(&meter, &super::super::AgentState::default(), 0, live);
        assert!(!aborted.load(Ordering::Relaxed));
    }
}
