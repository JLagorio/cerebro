//! Metering one CLI run into the runtime DB (M25.2).
//!
//! The reader thread already owns a run's whole life: it consumes stdout,
//! reaps the child at EOF, and emits the terminal `Done`. That makes it the
//! one place that knows both what the CLI reported and when the run actually
//! ended, so it is where usage is recorded. Nothing about spend travels on
//! the UI event channel (see [`super::usage`]). A panel sees two of a run's
//! numbers: how full a conversation's context is, which the reader files in
//! a memory-only [`ContextBook`] for the panel to pull (M91.5), and how long
//! each turn worked, the result's `duration_ms`, which the fold carries on
//! the turn's own event (M92.2) as the meter books it on the run's row.
//!
//! **A meter is optional.** A run started before a vault is registered, or in
//! a build with no runtime DB, streams exactly as it always did — metering is
//! a record of what happened, never a precondition for it happening.
//!
//! **The elapsed watchdog aborts a run that has already started.** That is
//! deliberately not the same as refusing to dispatch: the tokens up to the
//! abort were spent, the item goes back in the queue, and the run is recorded
//! `elapsed_aborted` rather than pretending it never left.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use serde::Serialize;
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
    /// `finish` records the unknown-fields and unclassified-kinds rows and
    /// the run's Claude Code session (M56.7), and stops short of `dispatch::finalize`, because the
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
    /// The recorded run whose tool call or write started this one. None is a
    /// root. Attended-mode writes it here; a wake claim already wrote its
    /// ancestry atomically with the lease.
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
/// one run and then act on the result had no way to wait for it. It also
/// carries what the run said last (M70.4), so a waiter can post the reply: a
/// thread turn's answer is its run's Result text.
#[derive(Debug, Clone, PartialEq)]
pub struct RunEnd {
    pub outcome: RunOutcome,
    /// `None` means the run ended without saying what it spent, or all of
    /// it: since M91.2c, a run whose subagents' share went unreported. It is
    /// not zero — M25 treats missing usage as an unknown day, never a free
    /// one.
    pub usage: Option<Usage>,
    /// Terminal model and other measured facts, passed to a supervisor's finalize.
    pub facts: Option<RunFacts>,
    /// The run's final reply: its terminal Result's text, when not empty
    /// (`agent::ReplyCollector`).
    pub answer: Option<String>,
    /// What went wrong, in a sentence, when the run said: a failure notice's
    /// title, else its error's message, cut.
    pub failure: Option<String>,
}

/// What the stream said, accumulated as it is read.
#[derive(Debug, Default)]
pub struct Tally {
    /// From the TERMINAL event only: its `modelUsage` summed over models
    /// when that is a measurement of this run alone, the whole tree's
    /// (M91.2c), else its `usage`. An `assistant` turn's usage is that turn's alone and the
    /// cached prefix repeats on every one of them, so summing them would
    /// over-count badly.
    usage: Option<Usage>,
    /// `usage` is the whole tree's, subagents included (M91.2c).
    whole_tree: bool,
    /// The run's own thread called the subagent tool (M91.2c), so some of
    /// what it spent was its subagents', which only `modelUsage` counts.
    delegated: bool,
    /// The first `system/init` line's `claude_code_version`, which says
    /// whether the result's `modelUsage` is this run's alone (M91.2c).
    cli_version: Option<String>,
    /// The non-count facts (M31.5), accumulated across the whole stream:
    /// each of the run's own assistant turns overwrites
    /// `model_id`/`stop_reason` (last wins; a subagent's never does,
    /// M91.3b), the terminal event fills the rest once, and a deferred
    /// result's stop reason wins over the last turn's (M57.1).
    facts: RunFacts,
    /// The call a hook deferred, by tool name, when the terminal result
    /// carried `deferred_tool_use` (M57.1): the run is suspended on it, not
    /// finished.
    deferred: Option<String>,
    failed: bool,
    /// The run died for want of quota, as the fold typed it (M56.4,
    /// `super::failure`): set by the reader, never from the result's words.
    quota: bool,
    /// The run's typed failure fields, read by the same classifier the fold
    /// uses, for the one fact the fold's verdict does not carry: when the
    /// limit resets (M56.14, `quota_resets_at`). Like the fold's, from the
    /// run's own lines: a subagent's API error is its own (M91.3b).
    failures: super::failure::Failures,
    unknown_fields: Vec<String>,
    /// The stream kinds this build has no row for (M56.2, `super::kinds`),
    /// once each, in the order they first came.
    unclassified: Vec<String>,
    saw_terminal: bool,
    /// The run was stopped at its `system/init` because cerebro's tools did
    /// not load (M54.5, `agent::InitGate`).
    init_refused: bool,
    /// The Claude Code session the stream ran as (M56.7): the first
    /// `system/init` line's `session_id`, or, when no init named one, the
    /// terminal `result`'s.
    init_session: Option<String>,
    result_session: Option<String>,
    /// The CLI tools the run's plan would have asked for and nobody could
    /// answer, so it ran without them (M57.2), in the manifest's order.
    withheld: Vec<String>,
    /// How much of its context window the run's own thread used, as its
    /// latest turn said, with the window the result reported for that
    /// turn's model (M91.5). Read off the turn's own line, so unlike `usage`
    /// it needs no `cli_version`: the totals Claude Code 2.1.277 restores
    /// into a resumed session's result never reach a line. Never booked:
    /// the reader files it in the [`ContextBook`] once the stream ends.
    context: Option<ContextUse>,
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
        if is_init && self.cli_version.is_none() {
            self.cli_version = event
                .get("claude_code_version")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if usage::is_result(event) && self.result_session.is_none() {
            self.result_session = session();
        }
        for field in usage::unknown_fields(event) {
            if !self.unknown_fields.contains(&field) {
                self.unknown_fields.push(field);
            }
        }
        for kind in super::kinds::unclassified(event) {
            if !self.unclassified.contains(&kind) {
                self.unclassified.push(kind);
            }
        }
        if !usage::from_a_subagent(event) {
            self.failures.observe(event);
        }
        if usage::calls_subagent_tool(event) {
            self.delegated = true;
        }
        let turn = RunFacts::from_assistant(event);
        if let Some(used) = usage::context_used(event) {
            self.context = Some(ContextUse {
                used,
                window: None,
                model: turn.as_ref().and_then(|turn| turn.model_id.clone()),
                at: reading_time(event),
            });
        }
        if let Some(turn) = turn {
            self.facts.merge(turn);
        }
        if !usage::is_result(event) {
            return;
        }
        self.saw_terminal = true;
        self.deferred = event
            .get("deferred_tool_use")
            .filter(|call| call.is_object())
            .map(|call| {
                call.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("a tool")
                    .to_string()
            });
        let whole_tree = usage::whole_tree(event)
            .filter(|_| usage::model_usage_is_the_runs(self.cli_version.as_deref()));
        self.whole_tree = whole_tree.is_some();
        self.usage = whole_tree.or_else(|| usage::parse(event));
        if let Some(terminal) = RunFacts::parse(event) {
            self.facts.merge(terminal);
        }
        self.failed = usage::is_failure(event);
        // The window belongs to the reading's model; a result that names
        // none for it leaves what an earlier one said.
        if let Some(reading) = self.context.as_mut() {
            let window = reading
                .model
                .as_deref()
                .and_then(|model| usage::context_window(event, model));
            if window.is_some() {
                reading.window = window;
            }
        }
    }

    /// How much of its context window the run's own thread used, as its
    /// latest turn said (M91.5). `None` when no turn of its own reported a
    /// whole reading ([`usage::context_used`]).
    pub(crate) fn context(&self) -> Option<&ContextUse> {
        self.context.as_ref()
    }

    /// Record whether the run's failure was a quota one: the usage limit, a
    /// throttle after the CLI's own retries, or no usage left (M56.4). The
    /// reader passes the fold's verdict once the stream has ended.
    pub(crate) fn record_quota(&mut self, quota: bool) {
        self.quota = quota;
    }

    /// When the limit that killed a quota run resets, as Claude Code
    /// reported it (M56.14): the usage-limit notice's `resets_at`. `None` for
    /// a run that did not die of quota, and for a throttle or an empty
    /// balance, which name no reset (Q10), so their backoff keeps the window.
    pub(crate) fn quota_resets_at(&self) -> Option<DateTime<Utc>> {
        if !self.quota {
            return None;
        }
        let notice = self.failures.notice(None)?;
        let at = DateTime::parse_from_rfc3339(notice.resets_at.as_deref()?).ok()?;
        Some(at.with_timezone(&Utc))
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

    /// Record the tools the run went without because nobody could answer
    /// its asks (M57.2, `RunApproval::withheld`).
    pub fn withhold(&mut self, tools: &[String]) {
        for tool in tools {
            if !self.withheld.contains(tool) {
                self.withheld.push(tool.clone());
            }
        }
    }

    /// The tool of the call a hook deferred, when the run ended suspended on
    /// one (M57.1).
    pub fn deferred(&self) -> Option<&str> {
        self.deferred.as_deref()
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

    /// The non-count facts the stream has said so far (M31.5).
    pub fn facts(&self) -> &RunFacts {
        &self.facts
    }

    /// How this run ended, and what it cost.
    ///
    /// A stream that ended without a terminal event yields `None` usage —
    /// the honest-unknown path — rather than a zero that would let the same
    /// tokens be spent again. So does a run that called the subagent tool
    /// when its result did not count its whole tree alone (M91.2c): its own
    /// thread's `usage` leaves its subagents out, so booking it would read
    /// as a smaller bill than the one paid.
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
        let usage = if self.delegated && !self.whole_tree {
            None
        } else {
            self.usage
        };
        (outcome, usage)
    }
}

// ---------------------------------------------------------------------------
// How full a session's context is (M91.5)
// ---------------------------------------------------------------------------

/// How much of its model's context window one Claude Code session had used
/// (M91.5), as the latest turn of a run's own thread reported it: a reading,
/// never a total, which the next turn's replaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUse {
    /// The tokens that turn's request sent (`usage::context_used`).
    pub used: u64,
    /// The model's context window, when the run's result reported one for
    /// the turn's model (`usage::context_window`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
    /// The model that answered the turn, when its line named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// When the reading was taken (`reading_time`), RFC 3339 UTC.
    pub at: String,
}

/// What `agent_context_usage` answers for a session (M91.5): its latest
/// reading, or not recorded when the book holds none for it. Never a zero
/// (CV-05).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ContextUsage {
    Recorded(ContextUse),
    NotRecorded,
}

/// The most sessions the [`ContextBook`] holds; past it, the one recorded
/// longest ago goes.
pub const CONTEXT_SESSIONS: usize = 64;

/// The latest [`ContextUse`] of each recent session a panel shows (M91.5),
/// by its Claude Code session id: filed by a run's reader once its stream
/// ends, and read by `agent_context_usage` when the panel asks.
///
/// Memory only, by the owner's call (Q7): never written to disk, journaled,
/// logged or emitted, and gone with the process. Bounded at
/// [`CONTEXT_SESSIONS`], the session recorded longest ago going first. The
/// lock is taken poisoned or not, as the journal's is, because the reader
/// files from its run's afterlife, where a panic would leave the run
/// unreaped.
#[derive(Debug, Default)]
pub struct ContextBook {
    sessions: Mutex<VecDeque<(String, ContextUse)>>,
}

impl ContextBook {
    fn sessions(&self) -> MutexGuard<'_, VecDeque<(String, ContextUse)>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// File `reading` as `session`'s latest, the newest in the book.
    pub fn record(&self, session: &str, reading: ContextUse) {
        let mut sessions = self.sessions();
        sessions.retain(|(id, _)| id != session);
        sessions.push_back((session.to_string(), reading));
        while sessions.len() > CONTEXT_SESSIONS {
            sessions.pop_front();
        }
    }

    /// `session`'s latest reading, or not recorded when the book holds none.
    pub fn usage(&self, session: &str) -> ContextUsage {
        self.sessions()
            .iter()
            .find(|(id, _)| id == session)
            .map_or(ContextUsage::NotRecorded, |(_, reading)| {
                ContextUsage::Recorded(reading.clone())
            })
    }
}

/// When a context reading was taken (M91.5): its line's own `timestamp`, or,
/// on a stream whose lines carry none (2.1.250's assistant lines), the
/// moment the reader read it. Spelled as `runtime::now_utc` spells every
/// time: RFC 3339 UTC with milliseconds.
fn reading_time(event: &Value) -> String {
    event
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map_or_else(Utc::now, |at| at.with_timezone(&Utc))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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

/// Record the Claude Code session a run's child was spawned into (M56.3),
/// every mode: the row is open by now (`begin`, or the claim), and the id is
/// the one Cerebro minted or resumed, so a run killed before its stream named
/// a session is still findable by it. [`finish`] writes the stream's own id
/// after this, and that write wins. Never fails a run.
pub fn record_spawned_session(meter: &Meter, session: &str) {
    let Ok(conn) = runtime::open_existing(&meter.data_dir) else {
        return;
    };
    if let Err(detail) = dispatch::record_cli_session(&conn, &meter.run_id, session) {
        log::warn!(
            "runtime meter: run {}'s session could not be recorded at spawn: {detail}",
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

/// The surface of a run's row for usage fields this build does not read.
pub(crate) const USAGE_SURFACE: &str = "agent.usage";
/// The surface of a run's row for stream kinds `super::kinds` has no row for
/// (M56.2).
pub(crate) const STREAM_SURFACE: &str = "agent.stream";
/// The surface of an unattended run's row for a call a hook deferred (M57.1).
pub(crate) const DEFERRED_SURFACE: &str = "agent.deferred";
/// The surface of a run's row for the tools its shell ceiling would have
/// asked for when nobody could answer (M57.2).
pub(crate) const ASK_SURFACE: &str = "agent.ask";
/// How many unclassified kinds one row names; the rest are counted.
const UNCLASSIFIED_NAMED: usize = 20;

/// One `capability_unavailable` row under `surface`, with the run's id: what
/// this build met in a run's stream and could not read, or a capability the
/// run went without (M57.2). Never fails a run.
fn record_unread(conn: &rusqlite::Connection, meter: &Meter, surface: &str, detail: &str) {
    let refusal = crate::policy::table::PolicyTable::load()
        .ok()
        .and_then(|table| {
            crate::policy::rejection::OperationalRefusal::new(
                &table,
                "capability_unavailable",
                surface,
                detail,
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
        runtime::operational::record_or_warn(conn, &refusal, &entry);
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
    let outcome = booked_outcome(meter.mode, tally, outcome);

    // A usage field or a stream kind this build has never seen is worth
    // exactly one operational row per run, each: enough to notice a CLI
    // upgrade, not enough to drown the log.
    if !tally.unknown_fields.is_empty() {
        let detail = format!(
            "the CLI reported usage fields this build does not read: {}",
            tally.unknown_fields.join(", ")
        );
        record_unread(&conn, meter, USAGE_SURFACE, &detail);
    }
    if !tally.unclassified.is_empty() {
        let named = &tally.unclassified[..tally.unclassified.len().min(UNCLASSIFIED_NAMED)];
        let mut detail = format!(
            "the CLI sent stream kinds this build does not classify: {}",
            named.join(", ")
        );
        if tally.unclassified.len() > named.len() {
            detail.push_str(&format!(
                ", and {} more",
                tally.unclassified.len() - named.len()
            ));
        }
        record_unread(&conn, meter, STREAM_SURFACE, &detail);
    }
    // M57.2 (Q7): a run under Ask that nobody watches went without the
    // tools it would have asked for, and says which, once, in every mode.
    if !tally.withheld.is_empty() {
        let detail = format!(
            "{} {}",
            crate::policy::tool_approval::messages().withheld,
            tally.withheld.join(", ")
        );
        record_unread(&conn, meter, ASK_SURFACE, &detail);
    }
    // M57.1 (Q1): nobody can answer an unattended run's deferred call, and
    // only a hook outside Cerebro defers one, so the run says so once.
    if let (Mode::Ambient, Some(tool)) = (meter.mode, tally.deferred()) {
        let detail = format!(
            "a hook outside Cerebro deferred a call to {tool}, and nobody is watching this run to answer it, so the run stopped there and its items go back in the queue"
        );
        record_unread(&conn, meter, DEFERRED_SURFACE, &detail);
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
        Mode::Ambient => dispatch::finalize_until_reset(
            &conn,
            &meter.run_id,
            outcome,
            counted,
            Some(&tally.facts),
            items_for(outcome),
            tally.quota_resets_at(),
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

/// What a run is booked as, by its mode (M57.1): an unattended run that ended
/// suspended on a deferred call did not finish, so it books Failed and the
/// gate backs off; an attended one keeps what the stream said (a deferral
/// is an outcome there, with its stop reason recorded); a supervised run's
/// supervisor decides.
fn booked_outcome(mode: Mode, tally: &Tally, outcome: RunOutcome) -> RunOutcome {
    if mode == Mode::Ambient && tally.deferred().is_some() && outcome == RunOutcome::Succeeded {
        RunOutcome::Failed
    } else {
        outcome
    }
}

/// Where an ambient run's items go: a clean run consumes them, and anything
/// else, a deferred run among them (M57.1), returns them. M25.3 replaces this
/// with the receipt route, which is why it is an argument to `finalize`.
fn items_for(outcome: RunOutcome) -> ItemOutcome {
    if matches!(outcome, RunOutcome::Succeeded) {
        ItemOutcome::Consume
    } else {
        ItemOutcome::Requeue
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

    /// A stream read as the reader reads it (M56.4): every line metered and
    /// folded, and the fold's quota verdict handed to the tally at the end.
    fn tally_of(lines: &[Value]) -> Tally {
        let mut fold = super::super::fold::TranscriptFold::default();
        let mut tally = Tally::default();
        for line in lines {
            tally.observe(line);
            fold.entry(line);
        }
        fold.finish();
        tally.record_quota(fold.is_quota());
        tally
    }

    /// The hand-built usage-limit stream (cli-stream/usage-limit-stream.json).
    fn usage_limit_stream() -> Vec<Value> {
        let wrapper: Value = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/usage-limit-stream.json"
        ))
        .unwrap();
        wrapper["events"].as_array().unwrap().clone()
    }

    fn api_error_reply(code: &str) -> Value {
        json!({ "type": "assistant", "error": code, "is_api_error_message": true,
            "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": "x" }] } })
    }

    #[test]
    fn a_quota_death_is_its_own_outcome_and_keeps_its_usage() {
        let tally = tally_of(&usage_limit_stream());
        let (outcome, usage) = tally.ended(false, false);
        assert_eq!(outcome, RunOutcome::QuotaFailed);
        // A refused first request spends nothing, and says so: reported, not
        // unknown.
        assert!(usage.is_some(), "a quota death still reports its usage");
    }

    #[test]
    fn a_quota_death_names_the_reset_its_limit_reported() {
        // M56.14: the weekly limit in the hand-built stream resets at
        // 2026-01-01T00:00:00Z, and that instant reaches finalize.
        let tally = tally_of(&usage_limit_stream());
        assert_eq!(
            tally.quota_resets_at(),
            DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .ok()
                .map(|at| at.with_timezone(&Utc))
        );
        // A throttle names no reset, so its backoff keeps the window (Q10).
        let throttled = tally_of(&[
            api_error_reply("rate_limit"),
            result(json!({ "output_tokens": 0 }), true, "x"),
        ]);
        assert_eq!(throttled.ended(false, false).0, RunOutcome::QuotaFailed);
        assert_eq!(throttled.quota_resets_at(), None);
        // A run that did not die of quota has no reset to honour, whatever
        // limit events it saw on the way.
        let fine = tally_of(&[
            json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed",
                "resetsAt": 1767225600, "rateLimitType": "five_hour" } }),
            result(json!({ "output_tokens": 5 }), false, "done"),
        ]);
        assert_eq!(fine.quota_resets_at(), None);
    }

    #[test]
    fn a_limit_phrase_without_a_typed_field_books_failed() {
        let tally = tally_of(&[result(
            json!({ "input_tokens": 2, "output_tokens": 17 }),
            true,
            "API Error: Claude AI usage limit reached. Rate limit, quota.",
        )]);
        let (outcome, usage) = tally.ended(false, false);
        assert_eq!(outcome, RunOutcome::Failed, "words are not a typed field");
        assert_eq!(usage.unwrap().total(), 19, "a failed run is not a free run");
    }

    #[test]
    fn rate_limited_and_out_of_credits_book_quota_failed() {
        for code in ["rate_limit", "billing_error"] {
            let tally = tally_of(&[
                api_error_reply(code),
                result(json!({ "output_tokens": 0 }), true, "x"),
            ]);
            assert_eq!(
                tally.ended(false, false).0,
                RunOutcome::QuotaFailed,
                "{code}"
            );
        }
        for code in ["overloaded", "authentication_failed", "unknown"] {
            let tally = tally_of(&[
                api_error_reply(code),
                result(json!({ "output_tokens": 0 }), true, "x"),
            ]);
            assert_eq!(tally.ended(false, false).0, RunOutcome::Failed, "{code}");
        }
    }

    #[test]
    fn an_allowed_limit_event_on_a_good_run_books_succeeded() {
        let tally = tally_of(&[
            json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed",
                "resetsAt": 1767225600, "rateLimitType": "five_hour" } }),
            result(json!({ "output_tokens": 5 }), false, "done"),
        ]);
        assert_eq!(tally.ended(false, false).0, RunOutcome::Succeeded);
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
    fn the_spawned_session_is_recorded_and_the_streams_wins_at_finish() {
        let dir = crate::vault::testutil::temp_vault("meter-spawned-session");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        let meter = |run_id: &str| Meter {
            data_dir: dir.clone(),
            run_id: run_id.into(),
            mode: Mode::Attended,
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
        let minted = "00000000-0000-4000-8000-000000000005";

        // Killed before its stream said a word: the minted id stays.
        let quiet = meter("quiet-run");
        begin(&quiet);
        record_spawned_session(&quiet, minted);
        assert_eq!(read("quiet-run").as_deref(), Some(minted), "named at spawn");
        finish(&quiet, &Tally::default(), false, true, Utc::now());
        assert_eq!(read("quiet-run").as_deref(), Some(minted));

        // A stream that names its session wins at finish.
        let talking = meter("talking-run");
        begin(&talking);
        record_spawned_session(&talking, minted);
        let mut tally = Tally::default();
        tally.observe(&json!({
            "type": "system", "subtype": "init",
            "session_id": "00000000-0000-4000-8000-000000000006"
        }));
        finish(&talking, &tally, false, false, Utc::now());
        assert_eq!(
            read("talking-run").as_deref(),
            Some("00000000-0000-4000-8000-000000000006")
        );
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
    fn unclassified_kinds_are_collected_once_across_the_whole_stream() {
        let mut tally = Tally::default();
        for _ in 0..3 {
            tally.observe(&json!({ "type": "teleport", "subtype": "begin" }));
            tally.observe(&json!({
                "type": "assistant",
                "message": { "content": [{ "type": "hologram" }, { "type": "tool_use" }] }
            }));
            tally.observe(&json!({ "type": "system", "subtype": "init", "session_id": "s" }));
        }
        assert_eq!(
            tally.unclassified,
            vec![
                "teleport/begin".to_string(),
                "assistant/hologram".to_string()
            ],
            "once each, in the order they came, and no classified kind"
        );
    }

    #[test]
    fn an_unclassified_kind_routes_one_operational_row_with_its_run() {
        let dir = crate::vault::testutil::temp_vault("meter-unclassified");
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
            parent_run_id: None,
            cause: None,
        };

        let mut drifted = Tally::default();
        for n in 0..25 {
            drifted.observe(&json!({ "type": format!("kind{n:02}") }));
        }
        let success = json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "ok",
            "usage": { "output_tokens": 3 }
        });
        drifted.observe(&success);
        finish(&meter("drifted"), &drifted, false, false, Utc::now());

        let mut clean = Tally::default();
        clean.observe(&json!({ "type": "system", "subtype": "init", "session_id": "s" }));
        clean.observe(&success);
        finish(&meter("clean"), &clean, false, false, Utc::now());

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let rows: Vec<(String, String, Option<String>)> = conn
            .prepare(
                "SELECT code, detail, run_id FROM operational_log WHERE surface = ?1 ORDER BY id",
            )
            .unwrap()
            .query_map([STREAM_SURFACE], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let named: Vec<String> = (0..20).map(|n| format!("kind{n:02}")).collect();
        assert_eq!(
            rows,
            [(
                "capability_unavailable".to_string(),
                format!(
                    "the CLI sent stream kinds this build does not classify: {}, and 5 more",
                    named.join(", ")
                ),
                Some("drifted".to_string())
            )],
            "one row for the run that drifted, naming twenty, and none for the clean run"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
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
    fn an_ambient_weekly_limit_backs_off_until_the_reset_it_reported() {
        // M56.14 at the meter: the stream's weekly limit resets at
        // 2026-01-01T00:00:00Z, three days after this run, and the backoff
        // finalize writes ends there rather than five hours on.
        let dir = crate::vault::testutil::temp_vault("meter-quota-reset");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        let started = DateTime::parse_from_rfc3339("2025-12-29T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
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
            started,
        )
        .unwrap() else {
            panic!("an empty item list must still reach the gate and claim");
        };
        drop(conn);

        finish(
            &Meter {
                data_dir: dir.clone(),
                run_id: lease.run_id.clone(),
                mode: Mode::Ambient,
                vault_id: Some(vault.clone()),
                store_uuid: Some("store".into()),
                started_at: started,
                elapsed_limit_seconds: Some(lease.elapsed_limit_seconds),
                actor: None,
                parent_run_id: None,
                cause: None,
            },
            &tally_of(&usage_limit_stream()),
            false,
            false,
            started + chrono::Duration::minutes(1),
        );

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let outcome: String = conn
            .query_row(
                "SELECT outcome FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(outcome, "quota_failed");
        let ends: Vec<String> = conn
            .prepare("SELECT DISTINCT until FROM backoff WHERE reason = 'quota'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(ends, ["2026-01-01T00:00:00.000Z"]);
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

    // --- A deferred run (M57.1) ----------------------------------------------

    /// The synthetic deferred stream (cli-stream/transcript-deferred.stream.json).
    fn deferred_stream() -> Vec<Value> {
        serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/transcript-deferred.stream.json"
        ))
        .unwrap()
    }

    fn rows_under(conn: &rusqlite::Connection, surface: &str) -> Vec<(String, String, String)> {
        conn.prepare(
            "SELECT code, detail, run_id FROM operational_log WHERE surface = ?1 ORDER BY id",
        )
        .unwrap()
        .query_map([surface], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    #[test]
    fn a_deferred_ambient_run_books_failed_requeues_and_says_why() {
        let dir = crate::vault::testutil::temp_vault("meter-deferred-ambient");
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
            panic!("an empty item list still claims");
        };
        drop(conn);

        let tally = tally_of(&deferred_stream());
        assert_eq!(tally.deferred(), Some("mcp__cerebro__append_to_note"));
        // The stream alone says it succeeded; unattended, it did not finish.
        let (said, _) = tally.ended(false, false);
        assert_eq!(said, RunOutcome::Succeeded);
        let booked = booked_outcome(Mode::Ambient, &tally, said);
        assert_eq!(booked, RunOutcome::Failed);
        assert_eq!(items_for(booked), ItemOutcome::Requeue, "its items go back");
        let meter = Meter {
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
        };
        finish(&meter, &tally, false, false, Utc::now());

        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (outcome, stop, output): (String, Option<String>, i64) = conn
            .query_row(
                "SELECT outcome, stop_reason, output_tokens FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(outcome, "failed");
        assert_eq!(stop.as_deref(), Some("tool_deferred"));
        assert_eq!(output, 48, "what it spent is still what it spent");
        let rows = rows_under(&conn, DEFERRED_SURFACE);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].0, "capability_unavailable");
        assert!(
            rows[0].1.contains("mcp__cerebro__append_to_note"),
            "{}",
            rows[0].1
        );
        assert_eq!(rows[0].2, lease.run_id);
        let day = crate::runtime::budget::read_day(&conn, &lease.window_start_utc).unwrap();
        assert_eq!(day.reserved_total_tokens, 0, "the reservation was released");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deferred_attended_run_keeps_its_usage_and_stop_reason() {
        let dir = crate::vault::testutil::temp_vault("meter-deferred-attended");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        let tally = tally_of(&deferred_stream());
        let meter = Meter {
            data_dir: dir.clone(),
            run_id: "attended-deferred".into(),
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
        let conn = crate::runtime::open_existing(&dir).unwrap();
        let (outcome, stop, output): (String, Option<String>, i64) = conn
            .query_row(
                "SELECT outcome, stop_reason, output_tokens FROM runs WHERE run_id = 'attended-deferred'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(outcome, "succeeded", "a person is there to answer it");
        assert_eq!(stop.as_deref(), Some("tool_deferred"));
        assert_eq!(output, 48);
        assert!(rows_under(&conn, DEFERRED_SURFACE).is_empty());
        // A supervised run's supervisor decides, deferral or not.
        assert_eq!(
            booked_outcome(Mode::Supervised, &tally, RunOutcome::Succeeded),
            RunOutcome::Succeeded
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- M57.2: the asks nobody could answer ---------------------------------

    fn attended_meter(dir: &std::path::Path, vault: &str, run_id: &str) -> Meter {
        Meter {
            data_dir: dir.to_path_buf(),
            run_id: run_id.into(),
            mode: Mode::Attended,
            vault_id: Some(vault.to_string()),
            store_uuid: Some("store".into()),
            started_at: Utc::now(),
            elapsed_limit_seconds: None,
            actor: None,
            parent_run_id: None,
            cause: None,
        }
    }

    #[test]
    fn an_unattended_ask_records_one_withheld_row() {
        let dir = crate::vault::testutil::temp_vault("meter-withheld");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        let approval =
            crate::policy::tool_approval::plan(&crate::policy::tool_approval::ApprovalInput {
                kind: crate::policy::tool_approval::RunKind::Unattended,
                shell: crate::policy::tool_approval::ShellCeiling::Ask,
                web: crate::policy::tool_approval::WebCeiling::Off,
                delegate: crate::policy::tool_approval::DelegateCeiling::Off,
                ask_first: false,
                read_scoped: false,
                narrowing: None,
            });
        let mut tally = tally_of(&[]);
        tally.withhold(&approval.withheld);
        tally.withhold(&approval.withheld);
        let meter = attended_meter(&dir, &vault, "withheld-run");
        finish(&meter, &tally, false, false, Utc::now());
        let conn = crate::runtime::open_existing(&dir).unwrap();
        let rows = rows_under(&conn, ASK_SURFACE);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].0, "capability_unavailable");
        assert_eq!(
            rows[0].1,
            format!(
                "{} Write, Edit, MultiEdit, NotebookEdit, Bash",
                crate::policy::tool_approval::messages().withheld
            )
        );
        assert_eq!(rows[0].2, "withheld-run");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_withheld_records_nothing() {
        let dir = crate::vault::testutil::temp_vault("meter-withheld-none");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        let mut tally = tally_of(&[]);
        tally.withhold(&[]);
        finish(
            &attended_meter(&dir, &vault, "nothing-withheld"),
            &tally,
            false,
            false,
            Utc::now(),
        );
        let conn = crate::runtime::open_existing(&dir).unwrap();
        assert!(rows_under(&conn, ASK_SURFACE).is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- M91.2c: what a run's subagents spent --------------------------------

    /// The synthetic subagent stream (cli-stream/transcript-subagent.stream.json,
    /// M91.3b): one Agent call, and a result whose `modelUsage` counts the
    /// subagent beside the run's own thread.
    fn subagent_stream() -> Vec<Value> {
        serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/transcript-subagent.stream.json"
        ))
        .unwrap()
    }

    const SUBAGENT_CALL: &str = "toolu_000000000000000000000001";

    /// A turn of the run's own thread that calls the subagent tool as `name`.
    fn subagent_call(name: &str) -> Value {
        json!({ "type": "assistant", "parent_tool_use_id": null, "message": {
            "id": "msg_000000000000000000000001", "model": "claude-sonnet-5",
            "stop_reason": "tool_use", "content": [{ "type": "tool_use", "id": SUBAGENT_CALL,
                "name": name, "input": { "description": "Look it up",
                    "subagent_type": "cerebro-researcher", "prompt": "Find it." } }] } })
    }

    /// The run's `system/init`, naming the Claude Code release it ran on.
    fn init_on(version: &str) -> Value {
        json!({ "type": "system", "subtype": "init", "session_id": "s",
            "claude_code_version": version })
    }

    /// What the run's own thread spent, as the result's `usage` says it.
    const OWN: Usage = Usage {
        input_tokens: 14,
        output_tokens: 150,
        cache_read: 6_200,
        cache_write: 0,
    };

    /// A `modelUsage` of two models, the run's own and its subagent's.
    fn two_models() -> Value {
        json!({
            "claude-sonnet-5": { "inputTokens": 14, "outputTokens": 150,
                "cacheReadInputTokens": 6200, "cacheCreationInputTokens": 0,
                "webSearchRequests": 0, "costUSD": 0.0123, "contextWindow": 200000,
                "maxOutputTokens": 32000, "canonicalModel": "claude-sonnet-5",
                "provider": "firstParty", "costBasis": "list" },
            "claude-haiku-4-5-20251001": { "inputTokens": 2950, "outputTokens": 170,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 1200,
                "webSearchRequests": 0, "costUSD": 0.0042, "contextWindow": 200000,
                "maxOutputTokens": 32000 }
        })
    }

    /// A clean result whose `usage` is [`OWN`], with `model_usage` when given.
    fn result_with(model_usage: Option<Value>) -> Value {
        let mut terminal = result(
            json!({ "input_tokens": 14, "output_tokens": 150,
                "cache_read_input_tokens": 6200, "cache_creation_input_tokens": 0 }),
            false,
            "done",
        );
        if let Some(model_usage) = model_usage {
            terminal["modelUsage"] = model_usage;
        }
        terminal
    }

    #[test]
    fn a_runs_usage_is_the_whole_trees_when_model_usage_counts_it() {
        // Two models, the run's own and its subagent's: `usage` holds the
        // first alone, and the books take both.
        let tally = tally_of(&[
            init_on("2.1.250"),
            subagent_call("Agent"),
            result_with(Some(two_models())),
        ]);
        assert_eq!(
            tally.ended(false, false),
            (
                RunOutcome::Succeeded,
                Some(Usage {
                    input_tokens: 2_964,
                    output_tokens: 320,
                    cache_read: 6_200,
                    cache_write: 1_200,
                })
            )
        );
        assert!(
            tally.unknown_fields.is_empty(),
            "{:?}",
            tally.unknown_fields
        );
        // The committed subagent stream, read as the reader reads it.
        let tally = tally_of(&subagent_stream());
        assert_eq!(
            tally.ended(false, false),
            (
                RunOutcome::Succeeded,
                Some(Usage {
                    input_tokens: 2_964,
                    output_tokens: 320,
                    cache_read: 6_200,
                    cache_write: 0,
                })
            )
        );
        assert!(
            tally.unknown_fields.is_empty(),
            "{:?}",
            tally.unknown_fields
        );
    }

    #[test]
    fn an_empty_or_missing_model_usage_keeps_the_runs_own_usage() {
        // The committed recordings all say `{}`, which counts nothing, so it
        // is never a zero bill. A run that called no subagent keeps its own
        // thread's `usage`, as before M91.2c.
        for model_usage in [
            None,
            Some(json!({})),
            Some(json!({ "claude-sonnet-5": { "inputTokens": 14 } })),
        ] {
            let tally = tally_of(&[init_on("2.1.250"), result_with(model_usage.clone())]);
            assert_eq!(
                tally.ended(false, false),
                (RunOutcome::Succeeded, Some(OWN)),
                "{model_usage:?}"
            );
        }
        // Nor does an empty one stand in for a `usage` the result left out.
        let tally = tally_of(&[
            init_on("2.1.250"),
            json!({ "type": "result", "is_error": false, "result": "done", "modelUsage": {} }),
        ]);
        assert_eq!(tally.ended(false, false).1, None, "unknown, never zero");
    }

    #[test]
    fn a_run_that_delegated_without_model_usage_spent_an_unknown_amount() {
        // CV-05: its own thread's `usage` leaves its subagents out, so it is
        // not what the run spent, and neither is zero.
        let zeroed = json!({ "claude-sonnet-5": { "inputTokens": 0, "outputTokens": 0,
            "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0 } });
        for name in ["Agent", "Task"] {
            for model_usage in [None, Some(json!({})), Some(zeroed.clone())] {
                let tally = tally_of(&[
                    init_on("2.1.250"),
                    subagent_call(name),
                    result_with(model_usage.clone()),
                ]);
                assert_eq!(
                    tally.ended(false, false),
                    (RunOutcome::Succeeded, None),
                    "{name}, {model_usage:?}"
                );
            }
        }
        // A hand-off is another run, with books of its own.
        let handed = json!({ "type": "assistant", "parent_tool_use_id": null, "message": {
            "id": "msg_000000000000000000000002", "content": [{ "type": "tool_use",
                "id": SUBAGENT_CALL, "name": "mcp__cerebro__hand_to", "input": {} }] } });
        assert_eq!(
            tally_of(&[handed, result_with(None)]).ended(false, false).1,
            Some(OWN)
        );
    }

    #[test]
    fn a_model_usage_that_may_carry_earlier_turns_is_never_booked() {
        // From 2.1.277 a resumed thread's `modelUsage` starts from the
        // session's saved totals: booking it would charge each turn for every
        // turn before it. A run whose init named no readable release is held
        // to the same rule.
        for init in [
            Some(init_on("2.1.277")),
            Some(init_on("2.1.308")),
            Some(json!({ "type": "system", "subtype": "init", "session_id": "s" })),
            None,
        ] {
            let lines = |calls: bool| -> Vec<Value> {
                init.iter()
                    .cloned()
                    .chain(calls.then(|| subagent_call("Agent")))
                    .chain([result_with(Some(two_models()))])
                    .collect()
            };
            assert_eq!(
                tally_of(&lines(false)).ended(false, false).1,
                Some(OWN),
                "its own thread's, as before M91.2c: {init:?}"
            );
            assert_eq!(
                tally_of(&lines(true)).ended(false, false).1,
                None,
                "a delegated run's spend is unknown: {init:?}"
            );
        }
    }

    #[test]
    fn a_subagents_lines_never_speak_for_the_run() {
        // M91.3b: Claude Code forwards a subagent's lines beside the run's.
        // Its model is not the run's, and its API error is its own: the fold
        // never hands it to the turn's failures, and nor does the tally, or a
        // subagent's rejected weekly limit would set the reset a throttled
        // run backs off until.
        let forwarded = |mut line: Value| {
            line["parent_tool_use_id"] = json!(SUBAGENT_CALL);
            line
        };
        let mut limit = api_error_reply("rate_limit");
        limit["quotaLimits"] = json!({ "status": "rejected", "rateLimitType": "seven_day",
            "resetsAt": 1767225600 });
        let tally = tally_of(&[
            subagent_call("Agent"),
            forwarded(json!({ "type": "assistant", "message": { "id": "msg_sub",
                "model": "claude-haiku-4-5-20251001", "stop_reason": "end_turn",
                "content": [{ "type": "text", "text": "Found it." }] } })),
            forwarded(limit.clone()),
            api_error_reply("rate_limit"),
            result(json!({ "output_tokens": 0 }), true, "x"),
        ]);
        assert_eq!(tally.facts().model_id.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(tally.facts().stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(
            tally.ended(false, false).0,
            RunOutcome::QuotaFailed,
            "the run's own throttle"
        );
        assert_eq!(
            tally.quota_resets_at(),
            None,
            "a throttle names no reset (Q10)"
        );
        // The same limit on the run's own thread is the run's, reset and all.
        let own = tally_of(&[limit, result(json!({ "output_tokens": 0 }), true, "x")]);
        assert_eq!(
            own.quota_resets_at(),
            DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .ok()
                .map(|at| at.with_timezone(&Utc))
        );
    }

    #[test]
    fn a_delegated_run_books_its_whole_tree_or_says_its_usage_is_unknown() {
        let dir = crate::vault::testutil::temp_vault("meter-delegated");
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        drop(conn);
        finish(
            &attended_meter(&dir, &vault, "counted"),
            &tally_of(&subagent_stream()),
            false,
            false,
            Utc::now(),
        );
        finish(
            &attended_meter(&dir, &vault, "uncounted"),
            &tally_of(&[
                init_on("2.1.250"),
                subagent_call("Agent"),
                result_with(Some(json!({}))),
            ]),
            false,
            false,
            Utc::now(),
        );
        let conn = crate::runtime::open_existing(&dir).unwrap();
        let books = |run_id: &str| -> (String, String, i64, i64, i64) {
            conn.query_row(
                "SELECT outcome, usage_state, input_tokens, output_tokens, cache_read \
                 FROM runs WHERE run_id = ?1",
                [run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap()
        };
        assert_eq!(
            books("counted"),
            ("succeeded".into(), "exact".into(), 2_964, 320, 6_200)
        );
        let (outcome, state, ..) = books("uncounted");
        assert_eq!(
            (outcome.as_str(), state.as_str()),
            ("succeeded", "unknown"),
            "its columns' zeros are not a measurement, and fleet reads the state first"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- M91.5: how full a session's context is ------------------------------

    /// A turn of the run's own thread on `model` whose request sent `input`
    /// new tokens and read `read` from the cache, its line written at `at`
    /// when given.
    fn turn_on(model: &str, input: u64, read: u64, at: Option<&str>) -> Value {
        let mut line = json!({ "type": "assistant", "parent_tool_use_id": null,
            "message": { "id": "msg_000000000000000000000501", "model": model,
                "stop_reason": "end_turn", "content": [{ "type": "text", "text": "Done." }],
                "usage": { "input_tokens": input, "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": read, "output_tokens": 12 } } });
        if let Some(at) = at {
            line["timestamp"] = json!(at);
        }
        line
    }

    /// A reading of `model`'s turn, as the tally takes it.
    fn reading_of(used: u64, window: Option<u64>, model: &str, at: &str) -> ContextUse {
        ContextUse {
            used,
            window,
            model: Some(model.into()),
            at: at.into(),
        }
    }

    /// A `modelUsage` entry with `window`, counting four calls' worth.
    fn entry_with(window: Value) -> Value {
        json!({ "inputTokens": 14, "outputTokens": 150, "cacheReadInputTokens": 6200,
            "cacheCreationInputTokens": 0, "contextWindow": window, "maxOutputTokens": 32000 })
    }

    const FIRST: &str = "2026-10-22T12:00:02.000Z";
    const LATER: &str = "2026-10-22T12:00:08.000Z";

    #[test]
    fn a_subagents_turn_never_reads_as_the_runs_context() {
        // M91.3b's rule: the forwarded line is the subagent's own request,
        // with its own context, however much larger, and its model's window
        // is not the run's.
        let mut forwarded = turn_on(
            "claude-haiku-4-5-20251001",
            2_950,
            90_000,
            Some("2026-10-22T12:00:04.000Z"),
        );
        forwarded["parent_tool_use_id"] = json!(SUBAGENT_CALL);
        let mut sidechain = forwarded.clone();
        sidechain["parent_tool_use_id"] = Value::Null;
        sidechain["isSidechain"] = json!(true);
        let tally = tally_of(&[
            init_on("2.1.250"),
            turn_on("claude-sonnet-5", 8, 6_100, Some(FIRST)),
            subagent_call("Agent"),
            forwarded,
            sidechain,
            result_with(Some(json!({
                "claude-sonnet-5": entry_with(json!(1_000_000)),
                "claude-haiku-4-5-20251001": entry_with(json!(200_000)),
            }))),
        ]);
        assert_eq!(
            tally.context(),
            Some(&reading_of(
                6_108,
                Some(1_000_000),
                "claude-sonnet-5",
                FIRST
            ))
        );
    }

    #[test]
    fn the_latest_whole_reading_is_the_one_kept() {
        let tally = tally_of(&[
            init_on("2.1.250"),
            turn_on("claude-sonnet-5", 8, 6_100, Some(FIRST)),
            turn_on("claude-sonnet-5", 12, 9_400, Some(LATER)),
            // A line that counts nothing read nothing, and a turn with no
            // usage at all says nothing about the context.
            turn_on("claude-sonnet-5", 0, 0, Some("2026-10-22T12:00:09.000Z")),
            subagent_call("Agent"),
            result_with(None),
        ]);
        assert_eq!(
            tally.context(),
            Some(&reading_of(9_412, None, "claude-sonnet-5", LATER)),
            "a result with no modelUsage names no window, and none is guessed"
        );
    }

    #[test]
    fn a_window_comes_only_from_the_readings_own_models_entry() {
        let window_after = |model_usage: Value| {
            tally_of(&[
                init_on("2.1.250"),
                turn_on("claude-sonnet-5", 8, 6_100, Some(FIRST)),
                result_with(Some(model_usage)),
            ])
            .context()
            .and_then(|reading| reading.window)
        };
        assert_eq!(
            window_after(json!({ "claude-sonnet-5": entry_with(json!(200_000)) })),
            Some(200_000)
        );
        for (case, model_usage) in [
            ("the recordings' empty object", json!({})),
            (
                "another model's entry",
                json!({ "claude-haiku-4-5-20251001": entry_with(json!(200_000)) }),
            ),
            (
                "a window as text",
                json!({ "claude-sonnet-5": entry_with(json!("200000")) }),
            ),
            (
                "a zero window",
                json!({ "claude-sonnet-5": entry_with(json!(0)) }),
            ),
        ] {
            assert_eq!(window_after(model_usage), None, "{case}");
        }
        // A continuation's later result that names no window leaves the one
        // an earlier result named for the same reading.
        let tally = tally_of(&[
            init_on("2.1.250"),
            turn_on("claude-sonnet-5", 8, 6_100, Some(FIRST)),
            result_with(Some(
                json!({ "claude-sonnet-5": entry_with(json!(200_000)) }),
            )),
            result_with(Some(json!({}))),
        ]);
        assert_eq!(
            tally.context().and_then(|reading| reading.window),
            Some(200_000)
        );
    }

    #[test]
    fn a_stream_with_no_whole_reading_has_none() {
        assert_eq!(Tally::default().context(), None);
        assert_eq!(
            tally_of(&usage_limit_stream()).context(),
            None,
            "the CLI's own reply to a refused request is no reading"
        );
        assert_eq!(
            tally_of(&subagent_stream()).context(),
            None,
            "its lines carry no usage"
        );
        assert_eq!(
            tally_of(&[result_with(Some(
                json!({ "claude-sonnet-5": entry_with(json!(200_000)) })
            ))])
            .context(),
            None,
            "a window alone is no reading"
        );
    }

    #[test]
    fn a_resumed_sessions_restored_totals_never_reach_its_reading() {
        // From 2.1.277 a resumed session's result restores the totals its
        // transcript saved, so its `modelUsage` counts every earlier turn.
        // The context is read off the turn's own line, which that change
        // does not touch, and the window is the model's limit, not a total.
        let restored = json!({ "claude-sonnet-5": { "inputTokens": 180_000,
            "outputTokens": 9_000, "cacheReadInputTokens": 2_400_000,
            "cacheCreationInputTokens": 61_000, "contextWindow": 200_000,
            "maxOutputTokens": 32_000 } });
        let mut resumed = result_with(Some(restored));
        resumed["num_turns"] = json!(7);
        let tally = tally_of(&[
            init_on("2.1.300"),
            turn_on("claude-sonnet-5", 12, 48_000, None),
            resumed,
        ]);
        let reading = tally.context().expect("the turn's own line is a reading");
        assert_eq!(
            (reading.used, reading.window),
            (48_012, Some(200_000)),
            "the turn's own request, in the model's own window"
        );
        assert_eq!(
            tally.ended(false, false).1,
            Some(OWN),
            "and the books still take only the run's own thread"
        );
    }

    #[test]
    fn a_reading_is_dated_by_its_line_else_when_it_was_read() {
        let mut tally = Tally::default();
        tally.observe(&turn_on(
            "claude-sonnet-5",
            8,
            6_100,
            Some("2026-10-22T14:00:02.5+02:00"),
        ));
        assert_eq!(
            tally.context().map(|reading| reading.at.as_str()),
            Some("2026-10-22T12:00:02.500Z"),
            "in UTC, as every stored time is spelt"
        );
        // 2.1.250's assistant lines carry no timestamp, and a timestamp
        // that does not parse is none.
        for stamp in [None, Some("yesterday")] {
            let before = Utc::now() - chrono::Duration::milliseconds(1);
            tally.observe(&turn_on("claude-sonnet-5", 8, 6_100, stamp));
            let after = Utc::now();
            let at = DateTime::parse_from_rfc3339(&tally.context().unwrap().at)
                .unwrap()
                .with_timezone(&Utc);
            assert!(before <= at && at <= after, "{stamp:?}: {at}");
        }
    }

    #[test]
    fn the_book_keeps_each_sessions_latest_and_lets_the_oldest_go() {
        let book = ContextBook::default();
        assert_eq!(
            book.usage("00000000-0000-4000-8000-000000000501"),
            ContextUsage::NotRecorded,
            "nothing seen is not recorded, never zero"
        );
        let session = |n: usize| format!("00000000-0000-4000-8000-{n:012}");
        for n in 0..CONTEXT_SESSIONS {
            book.record(
                &session(n),
                reading_of(n as u64 + 1, None, "claude-sonnet-5", FIRST),
            );
        }
        // A session's next reading replaces its last, and makes it the
        // newest.
        book.record(
            &session(0),
            reading_of(9_412, Some(200_000), "claude-sonnet-5", LATER),
        );
        book.record(
            &session(CONTEXT_SESSIONS),
            reading_of(7, None, "claude-sonnet-5", LATER),
        );
        assert_eq!(book.sessions().len(), CONTEXT_SESSIONS);
        assert_eq!(
            book.usage(&session(1)),
            ContextUsage::NotRecorded,
            "past the cap, the session recorded longest ago goes"
        );
        assert_eq!(
            book.usage(&session(0)),
            ContextUsage::Recorded(reading_of(9_412, Some(200_000), "claude-sonnet-5", LATER))
        );
        assert_eq!(
            book.usage(&session(2)),
            ContextUsage::Recorded(reading_of(3, None, "claude-sonnet-5", FIRST))
        );
        assert!(matches!(
            book.usage(&session(CONTEXT_SESSIONS)),
            ContextUsage::Recorded(_)
        ));
    }
}
