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

use crate::runtime::cause::RunCause;
use crate::runtime::connector_status::{self, Observation};
use crate::runtime::dispatch::{self, ItemOutcome, RunOutcome};
use crate::runtime::{self, operational::LogEntry};

use super::usage::{self, RunFacts, Usage};

/// The three internal constructs, by the actor name they already answer to.
///
/// These are NOT new strings. Each construct has minted its actor since M26
/// and stamps it on every ledger write through the MCP run token, so
/// `runs.actor` reuses the same constant rather than forking a second
/// vocabulary — a run's operational row and its epistemic writes have to
/// agree about who did the work, and two inventories of actor names would
/// drift the first time one of them was edited.
///
/// The list exists so the fleet UI's construct filter and these spawn sites
/// read from ONE place (M31's no-twin-inventory rule applied to actor names).
/// A construct added without appearing here is a construct the fleet cannot
/// offer to filter by.
///
/// **Permanently internal — the M35 decision, recorded where the names
/// live.** These three never become Agent records: their tool grants are
/// structural (`AgentRequest.internal` is unreachable from the wire), their
/// spawn sites are Rust, and a record would hand vault-authored frontmatter
/// the steering of machinery the vault must not steer. The fleet renders
/// them as the unowned rest of the roster — visible, named, and faceless BY
/// DESIGN, not as an agent nobody got around to writing.
pub const CONSTRUCT_ACTORS: [&str; 3] = [
    crate::ingest::driver::ACTOR,
    crate::maintain::pass::ACTOR,
    crate::assembly::ask::ACTOR,
];

/// Which side of the budget a run sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A person is waiting. Metered, never gated.
    Attended,
    /// The background. Metered AND budgeted; holds a reservation and the one
    /// ambient lease, both released at finalization.
    Ambient,
    /// The background, with a supervisor that claimed the lease and will
    /// finalize it itself — M26.4's ingest driver, which lands items by
    /// ROUTE rather than by success or failure.
    ///
    /// `finish` records the unknown-fields row and the run's Claude Code
    /// session (M56.7), and stops short of `dispatch::finalize`, because the
    /// run's outcome is not the item's destiny: a window that ran cleanly and concluded "nothing material"
    /// consumes its items, and one that was BLOCKED holds them visibly.
    /// Finalizing here as well would be refused outright — the second call
    /// finds no running row — after the first had already decided wrongly.
    Supervised,
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
    /// Who this run is for (M33.1). `None` is bare attended chat — a run
    /// nobody launched on a record's behalf — and it stays NULL rather than
    /// being guessed at. Only [`Mode::Attended`] writes it here, with
    /// `parent_run_id` and `cause`; the other two modes work on a row
    /// `dispatch::claim` already attributed and gave its cause.
    pub actor: Option<String>,
    /// The run whose tool call started this one (M34.3). `None` is a root —
    /// every run a person or a schedule started. Attended-mode only, like
    /// `actor`, and for the same reason.
    pub parent_run_id: Option<String>,
    /// Why the run started (M56.7). Attended-mode writes it with the row it
    /// opens, or with the fallback insert at finish; the other two modes
    /// carry the cause their claim already wrote. `None` stores NULL.
    pub cause: Option<RunCause>,
}

/// How a run ended, sent to whoever is waiting on it.
///
/// The run-completion signal `agent::stream` never had. Before this, the only
/// thing that knew a run was over was the reader thread, and the only thing it
/// did about it was emit a UI event — so a Rust caller that wanted to spend
/// one run and then act on the result had no way to wait for it.
#[derive(Debug, Clone, PartialEq)]
pub struct RunEnd {
    pub outcome: RunOutcome,
    /// `None` means the run ended without saying what it spent. It is not
    /// zero — M25 treats missing usage as an unknown day, never a free one.
    pub usage: Option<Usage>,
}

/// What the stream said, accumulated as it is read.
#[derive(Debug, Default)]
pub struct Tally {
    /// From the TERMINAL event only. An `assistant` turn's usage is that
    /// turn's alone and the cached prefix repeats on every one of them, so
    /// summing them would over-count badly.
    usage: Option<Usage>,
    /// The non-count facts (M31.5), accumulated across the whole stream:
    /// each assistant turn overwrites `model_id`/`stop_reason` (last wins —
    /// the final turn's stop reason is the run's), the terminal event fills
    /// the rest once.
    facts: RunFacts,
    failed: bool,
    quota: bool,
    unknown_fields: Vec<String>,
    saw_terminal: bool,
    /// The run was stopped at its `system/init` because cerebro's tools did
    /// not load (M54.5, `agent::InitGate`).
    init_refused: bool,
    /// The Claude Code session the stream ran as (M56.7): the first
    /// `system/init` line's `session_id`, or, when no init named one, the
    /// terminal `result`'s.
    init_session: Option<String>,
    result_session: Option<String>,
}

impl Tally {
    /// Feed one parsed CLI line.
    pub fn observe(&mut self, event: &Value) {
        let session = || {
            event
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let is_init = event.get("type").and_then(Value::as_str) == Some("system")
            && event.get("subtype").and_then(Value::as_str) == Some("init");
        if is_init && self.init_session.is_none() {
            self.init_session = session();
        }
        if usage::is_result(event) && self.result_session.is_none() {
            self.result_session = session();
        }
        for field in usage::unknown_fields(event) {
            if !self.unknown_fields.contains(&field) {
                self.unknown_fields.push(field);
            }
        }
        if let Some(turn) = RunFacts::from_assistant(event) {
            self.facts.merge(turn);
        }
        if !usage::is_result(event) {
            return;
        }
        self.saw_terminal = true;
        self.usage = usage::parse(event);
        if let Some(terminal) = RunFacts::parse(event) {
            self.facts.merge(terminal);
        }
        self.failed = usage::is_failure(event);
        self.quota = usage::is_quota_failure(event);
    }

    /// The Claude Code session this run ran as, as its stream named it:
    /// init's, else the result's. `None` when neither line arrived or named
    /// one.
    pub fn cli_session_id(&self) -> Option<&str> {
        self.init_session
            .as_deref()
            .or(self.result_session.as_deref())
    }

    /// Did the stream reach its terminal event? A run that did has already
    /// said how it ended, failures included.
    pub(crate) fn saw_terminal(&self) -> bool {
        self.saw_terminal
    }

    /// Record that the run was stopped at init because cerebro's tools did
    /// not load (M54.5). The run failed: nobody asked for that stop, and the
    /// error event already told the person why.
    pub(crate) fn refuse_init(&mut self) {
        self.init_refused = true;
    }

    /// Was the run stopped at init? Its error event was its report, so the
    /// reader adds no stderr to it.
    pub(crate) fn refused_at_init(&self) -> bool {
        self.init_refused
    }

    /// The tools the run's result says the CLI denied, sorted and once each
    /// (M54.9). None when the run never reached its result.
    pub(crate) fn denied_tools(&self) -> &[String] {
        self.facts.denied_tools.as_deref().unwrap_or(&[])
    }

    /// How this run ended, and what it cost.
    ///
    /// A stream that ended without a terminal event yields `None` usage —
    /// the honest-unknown path — rather than a zero that would let the same
    /// tokens be spent again.
    ///
    /// `aborted` is the watchdog's doing and outranks everything the stream
    /// said. A run stopped at init because cerebro's tools did not load
    /// (M54.5) failed, whatever else came after: a stop that raced it, or a
    /// result the CLI wrote before the stop landed. Its usage stays what the
    /// stream said, which with no result is unknown, never zero. `cancelled`
    /// (M53.10) is a stop somebody asked for — a person's Stop, a vault
    /// switch, quit — and it names the ending only of a run that never
    /// reached its terminal event: one that already said how it ended keeps
    /// that ending, because the stop lost the race to it.
    pub fn ended(&self, aborted: bool, cancelled: bool) -> (RunOutcome, Option<Usage>) {
        let outcome = if aborted {
            RunOutcome::ElapsedAborted
        } else if self.init_refused {
            RunOutcome::Failed
        } else if cancelled && !self.saw_terminal {
            RunOutcome::Cancelled
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

/// Open an attended run's row before its child spawns (M49.9). The other
/// two modes run on a row the claim already opened, so this is a no-op for
/// them. Never fails a run: a row that could not open leaves the finish to
/// insert one, stamped not-booked (see `dispatch::meter_attended`).
pub fn begin(meter: &Meter) {
    if meter.mode != Mode::Attended {
        return;
    }
    let Ok(conn) = runtime::open_existing(&meter.data_dir) else {
        return;
    };
    if let Err(detail) = dispatch::begin_attended(
        &conn,
        &meter.run_id,
        meter.vault_id.as_deref(),
        meter.store_uuid.as_deref(),
        meter.actor.as_deref(),
        meter.parent_run_id.as_deref(),
        meter.cause.as_ref(),
        meter.started_at,
    ) {
        log::warn!(
            "runtime meter: run {} could not be opened: {detail}",
            meter.run_id
        );
    }
}

/// Take back what [`begin`] opened for a child that never spawned.
pub fn discard(meter: &Meter) {
    if meter.mode != Mode::Attended {
        return;
    }
    if let Ok(conn) = runtime::open_existing(&meter.data_dir) {
        let _ = dispatch::discard_unstarted_attended(&conn, &meter.run_id);
    }
}

/// Close the attended rows a dead process left `running` (M49.9) — the
/// attended half of what `ingest::ambient`'s lease sweep does for ambient
/// runs. `started_before` is this process's start, so nothing it opened is
/// touched. Never fatal, and never silent.
pub fn recover_orphaned(data_dir: &std::path::Path, started_before: DateTime<Utc>) {
    let Ok(conn) = runtime::open_existing(data_dir) else {
        return;
    };
    match dispatch::recover_orphaned_attended(&conn, started_before, Utc::now()) {
        Ok(0) => {}
        Ok(closed) => log::warn!(
            "runtime meter: closed {closed} attended run(s) a previous process left running — \
             their usage is recorded as unknown, which is not zero"
        ),
        Err(detail) => log::warn!("runtime meter: orphaned attended runs not swept: {detail}"),
    }
}

/// Close a run's books. Never fails a run: metering records what happened and
/// must not become a second way for the run to go wrong. `aborted` and
/// `cancelled` mean what they mean to [`Tally::ended`].
pub fn finish(meter: &Meter, tally: &Tally, aborted: bool, cancelled: bool, now: DateTime<Utc>) {
    let Ok(conn) = runtime::open_existing(&meter.data_dir) else {
        // No runtime DB (a build without one, or a database that is being
        // recovered). The run happened; nothing else changes.
        return;
    };
    let (outcome, counted) = tally.ended(aborted, cancelled);

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
        // The supervisor holds the lease and knows the route. See `Mode`.
        Mode::Supervised => Ok(()),
        Mode::Attended => dispatch::meter_attended(
            &conn,
            &meter.run_id,
            meter.vault_id.as_deref(),
            meter.store_uuid.as_deref(),
            outcome,
            counted,
            Some(&tally.facts),
            meter.actor.as_deref(),
            meter.parent_run_id.as_deref(),
            meter.cause.as_ref(),
            meter.started_at,
            now,
        ),
        Mode::Ambient => dispatch::finalize(
            &conn,
            &meter.run_id,
            outcome,
            counted,
            Some(&tally.facts),
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
        log::warn!(
            "runtime meter: run {} could not be recorded: {detail}",
            meter.run_id
        );
    }
    // After the mode's write, so an attended run's fallback insert has made
    // the row this lands on. Every mode: the session is the stream's fact,
    // and a supervised run's row is as much this run's as any other.
    if let Some(session) = tally.cli_session_id() {
        if let Err(detail) = dispatch::record_cli_session(&conn, &meter.run_id, session) {
            log::warn!(
                "runtime meter: run {}'s session could not be recorded: {detail}",
                meter.run_id
            );
        }
    }
}

/// Record what a finished run saw of its connectors (M54.11): one row per
/// connector its stream said something about, under this run's id, each kept
/// only while no newer run has seen that connector since. Never fails a run,
/// like [`finish`]: with no runtime DB nothing is recorded, and a write that
/// fails is logged. A meter with no vault records nothing, since a status
/// belongs to the vault whose connector list named the server.
pub fn record_connectors(meter: &Meter, observations: &[Observation]) {
    if observations.is_empty() {
        return;
    }
    let Some(vault_id) = meter.vault_id.as_deref() else {
        return;
    };
    let Ok(conn) = runtime::open_existing(&meter.data_dir) else {
        return;
    };
    if let Err(detail) = connector_status::record(&conn, vault_id, &meter.run_id, observations) {
        log::warn!(
            "runtime meter: run {}'s connector status could not be recorded: {detail}",
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
        // between the deadline and this line, or somebody stopped it first,
        // and that run is not aborted.
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
        assert_eq!(tally.ended(false, false).1, None, "no terminal event yet");
        tally.observe(&result(
            json!({ "input_tokens": 4, "output_tokens": 271, "cache_read_input_tokens": 14678 }),
            false,
            "done",
        ));
        let (outcome, usage) = tally.ended(false, false);
        assert_eq!(outcome, RunOutcome::Succeeded);
        assert_eq!(usage.unwrap().total(), 4 + 271 + 14_678);
    }

    #[test]
    fn a_stream_that_never_terminated_is_unknown_not_free() {
        let tally = Tally::default();
        let (outcome, usage) = tally.ended(false, false);
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
        let (outcome, usage) = tally.ended(false, false);
        assert_eq!(outcome, RunOutcome::QuotaFailed);
        assert_eq!(usage.unwrap().total(), 19, "a failed run is not a free run");
    }

    #[test]
    fn an_ordinary_failure_is_not_a_quota_failure() {
        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 5 }), true, "tool crashed"));
        assert_eq!(tally.ended(false, false).0, RunOutcome::Failed);
    }

    #[test]
    fn an_abort_outranks_whatever_the_stream_said() {
        // The watchdog killed the child; the terminal event, if any, arrived
        // from a run that was already being ended.
        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 5 }), false, "fine"));
        let (outcome, usage) = tally.ended(true, false);
        assert_eq!(outcome, RunOutcome::ElapsedAborted);
        assert_eq!(
            usage.unwrap().output_tokens,
            5,
            "an aborted run still spent what it spent"
        );
    }

    #[test]
    fn a_cancelled_run_is_its_own_outcome_and_an_abort_outranks_it() {
        // M53.10. A stopped run used to be booked abandoned, as if the app
        // had lost track of it, and `cancelled` had no producer at all.
        let tally = Tally::default();
        let (outcome, usage) = tally.ended(false, true);
        assert_eq!(outcome, RunOutcome::Cancelled);
        assert_eq!(usage, None, "a stopped run's spend is unknown, never zero");
        assert_eq!(
            tally.ended(true, true).0,
            RunOutcome::ElapsedAborted,
            "the watchdog's stop is the watchdog's"
        );
    }

    #[test]
    fn a_cancel_that_lost_the_race_to_a_result_keeps_the_result() {
        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 7 }), false, "done"));
        let (outcome, usage) = tally.ended(false, true);
        assert_eq!(outcome, RunOutcome::Succeeded, "it had already finished");
        assert_eq!(usage.unwrap().output_tokens, 7);
    }

    #[test]
    fn a_run_refused_at_init_books_failed_and_its_usage_stays_unknown() {
        // M54.5. Nobody asked for this stop, so it is not cancelled, and a run
        // that never said what it spent spent an unknown amount.
        let mut tally = Tally::default();
        tally.refuse_init();
        assert!(tally.refused_at_init());
        assert_eq!(tally.ended(false, false), (RunOutcome::Failed, None));
        assert_eq!(
            tally.ended(false, true),
            (RunOutcome::Failed, None),
            "a Stop that raced the refusal does not make it cancelled"
        );
        // A result the CLI wrote before the stop landed keeps its usage and
        // loses its ending: it was an answer given without the tools.
        tally.observe(&result(json!({ "output_tokens": 9 }), false, "fine"));
        let (outcome, usage) = tally.ended(false, false);
        assert_eq!(outcome, RunOutcome::Failed);
        assert_eq!(usage.unwrap().output_tokens, 9);
    }

    #[test]
    fn an_abort_outranks_an_init_refusal() {
        let mut tally = Tally::default();
        tally.refuse_init();
        assert_eq!(tally.ended(true, false), (RunOutcome::ElapsedAborted, None));
        assert_eq!(tally.ended(true, true).0, RunOutcome::ElapsedAborted);
    }

    #[test]
    fn an_attended_run_refused_at_init_books_failed_with_usage_unknown() {
        let dir = crate::vault::testutil::temp_vault("meter-init-refused");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        let mut tally = Tally::default();
        tally.refuse_init();
        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: "refused-1".into(),
                mode: Mode::Attended,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: Utc::now(),
                elapsed_limit_seconds: None,
                actor: None,
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
                cause: None,
            },
            &tally,
            false,
            false,
            Utc::now(),
        );

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (outcome, usage): (String, String) = conn
            .query_row(
                "SELECT outcome, usage_state FROM runs WHERE run_id = 'refused-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(outcome, "failed", "not cancelled: nobody asked for it");
        assert_eq!(usage, "unknown");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_attended_run_stopped_by_a_person_books_cancelled() {
        let dir = crate::vault::testutil::temp_vault("meter-cancelled");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: "stopped-1".into(),
                mode: Mode::Attended,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: Utc::now(),
                elapsed_limit_seconds: None,
                actor: None,
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
                cause: None,
            },
            &Tally::default(),
            false,
            true,
            Utc::now(),
        );

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (outcome, usage): (String, String) = conn
            .query_row(
                "SELECT outcome, usage_state FROM runs WHERE run_id = 'stopped-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(outcome, "cancelled", "not abandoned: somebody stopped it");
        assert_eq!(usage, "unknown");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_final_turns_stop_reason_is_the_runs() {
        let mut tally = Tally::default();
        tally.observe(&json!({
            "type": "assistant",
            "message": { "model": "claude-opus-5", "stop_reason": "tool_use" }
        }));
        tally.observe(&json!({
            "type": "assistant",
            "message": { "model": "claude-opus-5", "stop_reason": "end_turn" }
        }));
        assert_eq!(tally.facts.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(tally.facts.model_id.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn the_stream_facts_land_on_the_metered_run() {
        let dir = crate::vault::testutil::temp_vault("meter-facts");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        // The committed fixtures, end to end: one turn, then the terminal.
        let mut tally = Tally::default();
        let turn: Value = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/assistant-turn.json"
        ))
        .unwrap();
        let terminal: Value = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/result-success.json"
        ))
        .unwrap();
        tally.observe(&turn);
        tally.observe(&terminal);
        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: "facts-1".into(),
                mode: Mode::Attended,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: Utc::now(),
                elapsed_limit_seconds: None,
                actor: None,
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
                cause: None,
            },
            &tally,
            false,
            false,
            Utc::now(),
        );

        let conn = crate::runtime::open_existing(&dir).unwrap();
        type Row = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
        );
        let (model, stop, tier, cost, turns, ttl_5m, server): Row = conn
            .query_row(
                "SELECT model_id, stop_reason, service_tier, total_cost_micros, num_turns, \
                 cache_write_5m, server_tool_use FROM runs WHERE run_id = 'facts-1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(model.as_deref(), Some("claude-opus-5"));
        assert_eq!(stop.as_deref(), Some("tool_use"));
        assert_eq!(tier.as_deref(), Some("standard"));
        assert_eq!(cost, Some(41_200));
        assert_eq!(turns, Some(3));
        assert_eq!(
            ttl_5m, None,
            "the fixture carries no TTL split — NULL, not 0"
        );
        assert_eq!(
            server,
            Some(0),
            "an object that sums to zero is zero, present"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_denied_permission_routes_one_operational_row_and_an_empty_array_none() {
        let dir = crate::vault::testutil::temp_vault("meter-denials");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        let meter = |run: &str| Meter {
            data_dir: dir.clone(),
            run_id: run.into(),
            mode: Mode::Attended,
            vault_id: Some(vault.clone()),
            store_uuid: Some("store".into()),
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
            actor: None,
            // Root by construction (M34.3): no tool call started this run.
            parent_run_id: None,
            cause: None,
        };
        // No committed fixture carries a non-empty array, and none is needed:
        // the array's SHAPE is what the parser reads, so an inline event with
        // two denial objects is the honest minimum.
        let mut denied = Tally::default();
        denied.observe(&json!({
            "type": "result", "is_error": false, "result": "ok",
            "usage": { "output_tokens": 5 },
            "permission_denials": [
                { "tool_name": "Bash", "tool_use_id": "toolu_01",
                  "tool_input": { "command": "rm -rf /" } },
                { "tool_name": "Write", "tool_use_id": "toolu_02",
                  "tool_input": { "file_path": "/etc/hosts" } }
            ]
        }));
        finish(&meter("denied"), &denied, false, false, Utc::now());

        let mut clean = Tally::default();
        clean.observe(&json!({
            "type": "result", "is_error": false, "result": "ok",
            "usage": { "output_tokens": 5 }, "permission_denials": []
        }));
        finish(&meter("clean"), &clean, false, false, Utc::now());

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (rows, detail): (i64, String) = conn
            .query_row(
                "SELECT count(*), coalesce(max(detail), '') FROM operational_log \
                 WHERE surface = 'agent.permission' AND run_id = 'denied'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, 1, "one row per run with a non-empty denial array");
        assert_eq!(
            detail, "the CLI denied 2 call(s) this run: Bash, Write",
            "the detail names the count and the tools (M54.9)"
        );
        let clean_rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM operational_log \
                 WHERE surface = 'agent.permission' AND run_id = 'clean'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            clean_rows, 0,
            "an empty array is Some(0) in RunFacts and log noise here"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_narrowed_out_connector_tool_is_recorded_by_name() {
        // M54.9. Recorded on 2.1.250: a run granted a toy server's `echo`
        // alone called `other` twice and Bash once, and the CLI denied all
        // three. The run's one row names both tools, under its run_id.
        const STREAM: &str =
            include_str!("../../fixtures/cli-stream/result-connector-denials.json");
        let dir = crate::vault::testutil::temp_vault("meter-connector-denials");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        let mut tally = Tally::default();
        let stream: Vec<Value> = serde_json::from_str(STREAM).unwrap();
        for event in &stream {
            tally.observe(event);
        }
        let meter = Meter {
            data_dir: dir.clone(),
            run_id: "narrowed".into(),
            mode: Mode::Attended,
            vault_id: Some(vault),
            store_uuid: Some("store".into()),
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
            actor: Some("process:mailer".into()),
            parent_run_id: None,
            cause: None,
        };
        finish(&meter, &tally, false, false, Utc::now());

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let rows: Vec<(String, Option<String>)> = conn
            .prepare(
                "SELECT detail, run_id FROM operational_log WHERE surface = 'agent.permission'",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            [(
                "the CLI denied 3 call(s) this run: Bash, mcp__toy__other".to_string(),
                Some("narrowed".to_string())
            )]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_tally_keeps_the_session_init_named() {
        // The committed init fixture, then a result naming another id: the
        // init's is the run's (M56.7).
        let init: Value = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/init-connected.json"
        ))
        .unwrap();
        let mut tally = Tally::default();
        assert_eq!(tally.cli_session_id(), None, "nothing named yet");
        tally.observe(&init);
        tally.observe(&json!({
            "type": "system", "subtype": "init", "session_id": "ffffffff-later-init"
        }));
        tally.observe(&json!({
            "type": "result", "is_error": false, "result": "ok",
            "session_id": "eeeeeeee-the-result"
        }));
        assert_eq!(
            tally.cli_session_id(),
            Some("00000000-0000-4000-8000-000000000005"),
            "the first init's id"
        );
    }

    #[test]
    fn a_result_session_is_the_fallback() {
        let terminal: Value = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/result-success.json"
        ))
        .unwrap();
        let mut tally = Tally::default();
        tally.observe(&json!({ "type": "system", "subtype": "init" }));
        tally.observe(&terminal);
        assert_eq!(
            tally.cli_session_id(),
            Some("00000000-0000-4000-8000-000000000001")
        );
    }

    #[test]
    fn finish_records_the_cli_session_in_every_mode() {
        let dir = crate::vault::testutil::temp_vault("meter-cli-session");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        let lease = || {
            let conn = crate::runtime::open_existing(&dir).unwrap();
            let dispatch::Dispatched::Started(lease) = dispatch::claim(
                &conn,
                &vault,
                "store",
                "scheduled",
                crate::runtime::budget::Reservation {
                    total_tokens: 20_000,
                    output_tokens: 4_000,
                },
                &[],
                None,
                None,
                Utc::now(),
            )
            .unwrap() else {
                panic!("expected a lease");
            };
            lease
        };
        let session = |n: u8| format!("00000000-0000-4000-8000-00000000000{n}");
        let tally_for = |n: u8| {
            let mut tally = Tally::default();
            tally.observe(&json!({
                "type": "system", "subtype": "init", "session_id": session(n)
            }));
            tally.observe(&result(json!({ "output_tokens": 3 }), false, "ok"));
            tally
        };
        let meter = |run_id: &str, mode: Mode| Meter {
            data_dir: dir.clone(),
            run_id: run_id.into(),
            mode,
            vault_id: Some(vault.clone()),
            store_uuid: Some("store".into()),
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
            actor: None,
            parent_run_id: None,
            cause: None,
        };
        let read = |run_id: &str| -> Option<String> {
            let conn = crate::runtime::open_existing(&dir).unwrap();
            conn.query_row(
                "SELECT cli_session_id FROM runs WHERE run_id = ?1",
                [run_id],
                |r| r.get(0),
            )
            .unwrap()
        };

        let attended = meter("attended-run", Mode::Attended);
        finish(&attended, &tally_for(1), false, false, Utc::now());
        assert_eq!(read("attended-run"), Some(session(1)), "attended");

        // Supervised: the row stays the supervisor's to close, and still
        // takes the session.
        let supervised = lease();
        let meter_supervised = meter(&supervised.run_id, Mode::Supervised);
        finish(&meter_supervised, &tally_for(2), false, false, Utc::now());
        assert_eq!(read(&supervised.run_id), Some(session(2)), "supervised");
        let conn = crate::runtime::open_existing(&dir).unwrap();
        dispatch::finalize(
            &conn,
            &supervised.run_id,
            RunOutcome::Succeeded,
            // Known usage, so the day's accounting stays exact for the next.
            Some(Usage {
                output_tokens: 3,
                ..Usage::default()
            }),
            None,
            ItemOutcome::Consume,
            Utc::now(),
        )
        .unwrap();
        drop(conn);

        let ambient = lease();
        let meter_ambient = meter(&ambient.run_id, Mode::Ambient);
        finish(&meter_ambient, &tally_for(3), false, false, Utc::now());
        assert_eq!(read(&ambient.run_id), Some(session(3)), "ambient");
        let _ = std::fs::remove_dir_all(&dir);
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
                actor: None,
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
                cause: None,
            },
            &tally,
            false,
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
    fn an_unattended_schedule_run_books_ambient_on_its_own_lane_and_settles_the_budget() {
        // M34.2.4 end to end at the meter: a zero-item claim on the job's
        // lane — exactly what run_agent makes for an unattended laned
        // request — books mode='ambient' with the real lane and actor, and
        // finalization releases the reservation and commits the spend to the
        // day. This is the §8.3 answer as a test: scheduled runs face the
        // same books ingest does.
        let dir = crate::vault::testutil::temp_vault("meter-unattended");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();

        let dispatch::Dispatched::Started(lease) = dispatch::claim(
            &conn,
            &vault,
            "store",
            "scheduled",
            crate::runtime::budget::Reservation {
                total_tokens: 20_000,
                output_tokens: 4_000,
            },
            &[],
            Some("process:scout"),
            None,
            Utc::now(),
        )
        .unwrap() else {
            panic!("an empty item list must still reach the gate and claim");
        };
        drop(conn);

        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 42 }), false, "ok"));
        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: lease.run_id.clone(),
                mode: Mode::Ambient,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: Utc::now(),
                elapsed_limit_seconds: Some(lease.elapsed_limit_seconds),
                actor: None,
                parent_run_id: None,
                cause: None,
            },
            &tally,
            false,
            false,
            Utc::now(),
        );

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (mode, lane, actor, outcome, output): (String, String, String, String, i64) = conn
            .query_row(
                "SELECT mode, lane, actor, outcome, output_tokens FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(mode, "ambient", "unattended is ambient spend, not attended");
        assert_eq!(lane, "scheduled", "the job's real lane, not 'agent'");
        assert_eq!(actor, "process:scout", "the claim attributed the run");
        assert_eq!(outcome, "succeeded");
        assert_eq!(output, 42);
        let day = crate::runtime::budget::read_day(&conn, &lease.window_start_utc).unwrap();
        assert_eq!(day.reserved_total_tokens, 0, "the reservation was released");
        assert_eq!(day.ambient_output_tokens, 42, "the spend landed on the day");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_supervised_run_is_left_for_its_supervisor_to_finalize() {
        // The route decides where the items land, not whether the CLI exited
        // cleanly: a window that ran and concluded "nothing material"
        // consumes its items, and a BLOCKED one holds them visibly. If the
        // meter finalized here too, it would decide first and wrongly, and
        // the supervisor's call would then be refused for finding no running
        // row — the run's tokens recorded against the wrong destiny.
        let dir = crate::vault::testutil::temp_vault("meter-supervised");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        crate::runtime::scheduler::put(
            &conn,
            &vault,
            "store",
            &crate::runtime::scheduler::Row {
                item_key: "records/a.md".into(),
                source_id: None,
                content_hash: "a".repeat(64),
                snapshot: crate::runtime::normalize::snapshot(
                    &crate::vault::entry::Entry::empty_for_test("records/a.md"),
                ),
                event_cursor: None,
                route: None,
                state: crate::runtime::scheduler::SchedulerState::Pending,
            },
        )
        .unwrap();
        let dispatch::Dispatched::Started(lease) = dispatch::claim(
            &conn,
            &vault,
            "store",
            "behind",
            crate::runtime::budget::Reservation {
                total_tokens: 20_000,
                output_tokens: 4_000,
            },
            &["records/a.md".to_string()],
            None,
            None,
            Utc::now(),
        )
        .unwrap() else {
            panic!("expected a lease");
        };

        let mut tally = Tally::default();
        tally.observe(&result(json!({ "output_tokens": 42 }), false, "ok"));
        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: lease.run_id.clone(),
                mode: Mode::Supervised,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: Utc::now(),
                elapsed_limit_seconds: Some(lease.elapsed_limit_seconds),
                actor: None,
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
                cause: None,
            },
            &tally,
            false,
            false,
            Utc::now(),
        );

        let outcome: String = conn
            .query_row(
                "SELECT outcome FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome, "running", "still the supervisor's to close");
        // And the supervisor's call succeeds, which it could not have done
        // if the meter had already closed the books.
        dispatch::finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            tally.ended(false, false).1,
            None,
            ItemOutcome::Land(crate::runtime::scheduler::SchedulerState::Consumed),
            Utc::now(),
        )
        .unwrap();
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
                actor: None,
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
                cause: None,
            },
            &Tally::default(),
            false,
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
            actor: None,
            // Root by construction (M34.3): no tool call started this run.
            parent_run_id: None,
            cause: None,
        };
        let live = Arc::new(AtomicBool::new(true));
        let aborted = arm_watchdog(&meter, &super::super::AgentState::default(), 0, live);
        assert!(!aborted.load(Ordering::Relaxed));
    }

    #[test]
    fn a_finished_run_records_what_it_saw() {
        // M54.11. The recorded toy-server run, read the way the reader reads
        // it: every line through the tally and the observer, then the
        // observations the meter writes under the run's id.
        const STREAM: &str = include_str!("../../fixtures/cli-stream/connector-run.json");
        let dir = crate::vault::testutil::temp_vault("meter-connector-status");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);

        let connectors = crate::agent::run_connectors(
            &["ok", "auth", "down", "errs", "asked", "narrow"].map(String::from),
            Some(
                &[
                    "mcp__ok__echo",
                    "mcp__ok__broken",
                    "mcp__auth",
                    "mcp__down",
                    "mcp__errs",
                    "mcp__asked",
                    "mcp__narrow__echo",
                ]
                .map(String::from),
            ),
            None,
        );
        let mut tally = Tally::default();
        let mut observer = crate::agent::connector_signals::Observer::new(&connectors);
        let stream: Vec<Value> = serde_json::from_str(STREAM).unwrap();
        for event in &stream {
            tally.observe(event);
            observer.observe(event, Utc::now());
        }
        let meter = Meter {
            data_dir: dir.clone(),
            run_id: "saw-connectors".into(),
            mode: Mode::Attended,
            vault_id: Some(vault.clone()),
            store_uuid: Some("store".into()),
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
            actor: None,
            parent_run_id: None,
            cause: None,
        };
        finish(&meter, &tally, false, false, Utc::now());
        record_connectors(&meter, &observer.finish(tally.denied_tools()));

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let rows: Vec<(String, String, String, String)> =
            crate::runtime::connector_status::read(&conn, &vault)
                .unwrap()
                .into_iter()
                .map(|row| (row.connector, row.state, row.signal, row.run_id))
                .collect();
        let row = |connector: &str, state: &str, signal: &str| {
            (
                connector.to_string(),
                state.to_string(),
                signal.to_string(),
                "saw-connectors".to_string(),
            )
        };
        assert_eq!(
            rows,
            [
                row("asked", "not_approved", "permission_denial"),
                row("auth", "needs_sign_in", "init"),
                row("down", "failed", "init"),
                row("errs", "working", "init"),
                row("narrow", "working", "init"),
                row("ok", "working", "tool_result"),
            ]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_meter_without_a_vault_records_nothing() {
        let dir = crate::vault::testutil::temp_vault("meter-connector-status-no-vault");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        let meter = Meter {
            data_dir: dir.clone(),
            run_id: "no-vault".into(),
            mode: Mode::Attended,
            vault_id: None,
            store_uuid: None,
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
            actor: None,
            parent_run_id: None,
            cause: None,
        };
        let seen = Observation {
            connector: "gmail".into(),
            state: crate::runtime::connector_status::State::Working,
            signal: crate::runtime::connector_status::Signal::Init,
            seen_at: crate::runtime::now_utc(),
        };
        record_connectors(&meter, std::slice::from_ref(&seen));
        let conn = crate::runtime::open_existing(&dir).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM connector_status", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            rows, 0,
            "a status belongs to a vault, and this run had none"
        );
        assert!(crate::runtime::connector_status::read(&conn, &vault)
            .unwrap()
            .is_empty());
        drop(conn);
        // Nor does a missing runtime DB make it fail: it records nothing.
        let elsewhere = Meter {
            data_dir: dir.join("no-db-here"),
            vault_id: Some(vault),
            ..meter
        };
        record_connectors(&elsewhere, &[seen]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
