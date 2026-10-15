//! One ambient dispatch, start to finish (M25.2; N leases at M33b.1).
//!
//! **The claim is one transaction or it is nothing.** Gate, token
//! reservation, scheduler claim, run row, and the ambient lease all commit
//! together, and the subprocess spawns only afterwards. Split across two
//! transactions — or worse, across the IPC boundary — every crash boundary
//! becomes a way to lose the accounting: a run that spent tokens with no row,
//! a reservation nothing will release, an item claimed by a run that never
//! started.
//!
//! **Finalization is the other transaction.** Exact usage lands, the
//! reservation and the lease are released, and each claimed item is consumed
//! or returned to `pending` — in one atom, so a kill cannot leave a
//! reservation held against a run that has already ended.
//!
//! **Missing usage never becomes zero.** A lease that expired, a CLI that
//! ended without a terminal event, a process killed mid-run: all of them
//! record `abandoned_usage_unknown`, requeue the work, mark the day's
//! accounting `unknown`, and pause ambient dispatch. A day whose spend was
//! lost is not a day with budget left.
//!
//! # Background concurrency is a number, not a row (M33b.1)
//!
//! Until v14 the ceiling was `ambient_dispatch.singleton_key`, a primary key
//! that could hold exactly one value. It is now `settings::ambient_concurrency`
//! — one global number, defaulting to 1, counted against live leases by
//! [`budget::gate`]. Four properties fell out of that one column. Each is
//! named here with what carries it now, because three survive and one is
//! genuinely weaker, and pretending otherwise is how an invariant gets lost.
//!
//! **1. Mutual exclusion at claim time — carried by the transaction, which
//! was always the real mechanism.** [`claim`] opens `BEGIN IMMEDIATE`, and
//! `ambient_leases_held` is counted inside it. Two dispatchers cannot
//! interleave a count and an insert: SQLite serialises the writers, so the
//! second one's count already includes the first one's committed lease and it
//! defers with `ambient_busy`. Under the singleton this was true as well —
//! the gate refused first and the primary key never fired — with one
//! exception, documented at `budget::ambient_leases_held`: a stale expired
//! lease used to roll a claim back with an error and now does not. That case
//! traded an accidental error for a clean decision; it never protected any
//! accounting.
//!
//! **2. Crash recovery — unchanged in mechanism, and WIRED for the first time
//! here.** [`recover_expired_leases`] sweeps `runs` by `lease_expires_at`. It
//! has never read `ambient_dispatch`, and N rows change nothing about it:
//! each abandoned run is finalized on its own row, `abandoned_usage_unknown`,
//! its items requeued, its day marked unknown.
//!
//! The honest part: **that sweep had no production caller until M33b.1**, and
//! the singleton primary key had been standing in for it by accident — after
//! a crash the stale row made every later claim fail its key and roll back,
//! which stopped ambient dispatch loudly and forever. Retiring the singleton
//! without wiring the sweep would have converted that loud wedge into a
//! silent loss of work. So `ingest::ambient`'s tick now calls it, ahead of
//! the pause, and `ambient::sweep_abandoned` carries the argument for that
//! position. The invariant below is therefore a claim about code that runs,
//! not about a function nobody calls.
//!
//! **3. Accounting — unchanged, and it never lived here either.** Spend is a
//! `runs` row plus a `budget_days` reservation, one pair per run. N
//! concurrent runs make N pairs; the gate sums them through
//! `Day::committed_total`, so the second lease is checked against a day that
//! already owes the first one's reservation. There is no shared counter for a
//! second run to trample and no per-lease field for it to overwrite.
//!
//! **4. Headroom for attended chat inside `agent::MAX_CONCURRENT_RUNS` —
//! WEAKER, and deliberately so.** The singleton guaranteed three free process
//! slots as a side effect of allowing one. The ceiling guarantees
//! `MAX_CONCURRENT_RUNS - ceiling`, which is the same three at the shipped
//! default of 1 and zero at the maximum of 4. What remains at the maximum is
//! `agent::spawn`'s own refusal — a visible message, not a silent eviction.
//! This is a choice the owner makes by typing a number, not one the schema
//! makes for them.
//!
//! ## Every crash boundary, walked
//!
//! - **Between the gate and the insert.** Same transaction. Nothing commits,
//!   no run row, no reservation, no claimed item, and the decision row goes
//!   with it. Identical at any N.
//! - **Between the insert and the spawn.** The claim is committed and the
//!   subprocess never existed. The run row is `running` with a lease, so the
//!   sweep finalizes it `abandoned_usage_unknown`: the reservation is
//!   released, the items requeue, the day goes unknown. At N > 1 the sibling
//!   leases are untouched — the sweep is per run row.
//! - **Mid-run.** As above; the difference is only that tokens were really
//!   spent, which is exactly why the outcome is `unknown` rather than zero.
//! - **During finalization.** One transaction: the run row, the reservation
//!   release, the lease `DELETE` and the scheduler update roll back together.
//!   The run stays `running` holding its lease, and is swept later. The
//!   `DELETE` matches one row by primary key, as it did when `run_id` was
//!   merely `UNIQUE`.
//! - **A woken claim (M63.1).** The wake moves `pending → started` with its
//!   run id in the same transaction as the run row and the lease, so a kill
//!   before the commit leaves it pending and one after leaves it started
//!   with a recoverable run. Finalization finishes it in its own
//!   transaction (`wakes::finish_for_run`), so the lease sweep closes it as
//!   `interrupted` with everything else.
//! - **Two dispatchers at the same instant.** `BEGIN IMMEDIATE` admits one.
//!   The loser blocks up to the 5s busy timeout and then either counts the
//!   winner's lease and defers, or takes the next slot if the ceiling has one.
//!   It cannot observe a half-written claim, because there is no point in the
//!   sequence where one exists.
//!
//! In none of these does a run reach a terminal state without its usage being
//! either counted exactly or recorded as unknown. That is the invariant N
//! leases had to preserve, and the reason it survives is that it was never a
//! property of the singleton.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension};

use crate::agent::usage::{RunFacts, Usage};

use super::budget::{self, Day, Decision, GateReason, Reservation};
use super::cause::{is_cli_session_id, RunCause};
use super::scheduler::SchedulerState;
use super::status;
use super::wakes::{self, WakeRequest};

/// A lease is deliberately longer than the elapsed watchdog's deadline.
///
/// The watchdog aborts a run at `max_run_elapsed_seconds`; the lease is what
/// a DIFFERENT process uses to decide the run is gone. If they expired
/// together, a slow finalization would race a recovery sweep and two writers
/// would finalize the same run. Twice the deadline gives the watchdog room to
/// win, and recovery still frees the item if the whole process died.
const LEASE_MULTIPLE: i64 = 2;

/// What a dispatch attempt produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatched {
    /// Claimed. The caller may spawn — and must, or the lease recovery path
    /// is what cleans up.
    Started(Lease),
    /// The gate said no. Every applicable reason, sorted.
    Deferred(Vec<GateReason>),
    /// The gate said yes, but every named item had already moved out of
    /// `pending`. Not a refusal: nothing was wrong, there was just nothing
    /// left to do, and spending a run on it would have been the bug.
    NothingToClaim,
}

/// What a woken claim produced (M63.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Woken {
    /// Claimed: the wake is started with this lease's run. `cause` is the
    /// wake's stored cause, the one the run row now carries; `also` the
    /// causes of the wakes of the same trigger it took with it.
    Started {
        lease: Box<Lease>,
        cause: Option<RunCause>,
        also: Vec<RunCause>,
        parent_run_id: Option<String>,
    },
    /// Not now: the wake stays pending with a time to try again. The gate's
    /// reasons, or `agent_running`.
    Deferred(Vec<String>),
    /// Nothing to run: the wake is no longer pending, is another vault's, or
    /// was just cancelled (expired, or its agent is paused).
    Gone,
    /// Its parent chain spent its allowance before this wake could claim.
    Skipped,
}

/// What the claim transaction answered, before `claim` or `claim_woken`
/// gives it its public shape.
enum Answer {
    Dispatched(Dispatched),
    Woken(Woken),
    Check(CheckClaim),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub run_id: String,
    pub lease_expires_at: String,
    pub window_start_utc: String,
    /// Seconds after which the elapsed watchdog aborts this run.
    pub elapsed_limit_seconds: u64,
    pub claimed: Vec<String>,
}

/// What happens to a claimed item when its run ends.
///
/// M25.2 has two answers; M25.3's closed route matrix supplies the rest
/// (`pending_review`, `failed_visible`) by naming a state here rather than by
/// growing a second finalization path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemOutcome {
    Consume,
    Requeue,
    Land(SchedulerState),
}

impl ItemOutcome {
    fn state(self) -> SchedulerState {
        match self {
            ItemOutcome::Consume => SchedulerState::Consumed,
            ItemOutcome::Requeue => SchedulerState::Pending,
            ItemOutcome::Land(state) => state,
        }
    }
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Attempt one ambient dispatch.
///
/// `now` is passed rather than read so a test can drive a whole simulated day
/// without sleeping, and so every row written inside the transaction carries
/// the same instant.
///
/// `actor` (M33.1) names the construct taking the lease, and is an argument
/// rather than something derived from `lane` because the two are not the same
/// axis: ingest claims under five of the seven lanes, and a lane→construct
/// guess would attribute work to whoever happened to share a queue. `cause`
/// (M56.7) is why the run started, written with the row it opens: a
/// construct's kind, or what `run_agent` admitted; `None` stores NULL, read
/// as "why not recorded".
#[expect(
    clippy::too_many_arguments,
    reason = "one argument per column of the gate decision, run, lease and item rows it writes"
)]
pub fn claim(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    items: &[String],
    actor: Option<&str>,
    cause: Option<&RunCause>,
    now: DateTime<Utc>,
) -> Result<Dispatched, String> {
    // The process-level status is checked before the transaction: a failed
    // migration or an unresolved recovery is not a budget question, and
    // opening a write transaction to discover it would be noise.
    if !status::ambient_allowed() {
        return Ok(Dispatched::Deferred(vec![GateReason::AccountingUnknown]));
    }
    match claim_with(
        conn,
        vault_id,
        store_uuid,
        lane,
        reservation,
        items,
        actor,
        cause,
        None,
        None,
        now,
    )? {
        Answer::Dispatched(dispatched) => Ok(dispatched),
        Answer::Woken(_) | Answer::Check(_) => {
            Err("dispatch: a claim without a wake answered for one".into())
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum CheckClaim {
    Started(Lease),
    Deferred(Vec<String>),
    Gone,
    ChainSpent,
}

#[derive(Clone, Copy)]
struct CheckContext<'a> {
    parent: Option<&'a str>,
    wakes: &'a [String],
}

/// A check keeps its wakes pending, but bills its own run to their parent chain.
#[expect(
    clippy::too_many_arguments,
    reason = "the check books the existing claim columns plus the wake's recorded parent"
)]
pub(crate) fn claim_check(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    reservation: Reservation,
    actor: &str,
    cause: &RunCause,
    parent: Option<&str>,
    wakes: &[String],
    now: DateTime<Utc>,
) -> Result<CheckClaim, String> {
    if !status::ambient_allowed() {
        return Ok(CheckClaim::Deferred(vec![GateReason::AccountingUnknown
            .as_str()
            .into()]));
    }
    match claim_with(
        conn,
        vault_id,
        store_uuid,
        "agent",
        reservation,
        &[],
        Some(actor),
        Some(cause),
        None,
        Some(CheckContext { parent, wakes }),
        now,
    )? {
        Answer::Dispatched(Dispatched::Started(lease)) => Ok(CheckClaim::Started(lease)),
        Answer::Dispatched(Dispatched::Deferred(reasons)) => Ok(CheckClaim::Deferred(
            reasons.iter().map(|r| r.as_str().into()).collect(),
        )),
        Answer::Dispatched(Dispatched::NothingToClaim) => Ok(CheckClaim::Gone),
        Answer::Check(answer) => Ok(answer),
        Answer::Woken(_) => Err("dispatch: a check answered for a woken claim".into()),
    }
}

/// Claim the run a pending wake asks for (M63.1), inside the same transaction
/// as the gate, the run row and the lease, taking the pending wakes of the
/// same trigger in `wake.coalesce` with it.
///
/// It takes every argument [`claim`] takes but the items, which a woken run
/// has none of, and the cause, which is the wake's own, stored at admission.
/// Before the gate: a wake that is not pending here is [`Woken::Gone`];
/// another agent's is an error; one past the TTL expires and is gone; and
/// one whose agent is running or holds a started wake waits
/// [`wakes::BUSY_RETRY_SECS`]. After the gate: a per-agent pause cancels the
/// wake, and any other deferral keeps it pending, tried again in
/// [`wakes::BUSY_RETRY_SECS`] when every reason is `ambient_busy` and in
/// [`wakes::BUDGET_RETRY_SECS`] otherwise.
#[expect(
    clippy::too_many_arguments,
    reason = "claim's arguments less items and cause, plus the wake"
)]
pub fn claim_woken(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    actor: &str,
    wake: &WakeRequest,
    now: DateTime<Utc>,
) -> Result<Woken, String> {
    if !status::ambient_allowed() {
        // Not a budget question, as for `claim`; but the wake still learns
        // when to ask again, or the runner would ask at every settle.
        let reasons = vec![GateReason::AccountingUnknown.as_str().to_string()];
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("dispatch: {e}"))?;
        return match defer_wake(conn, &wake.claim, &reasons, now) {
            Ok(()) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("dispatch: {e}"))?;
                Ok(Woken::Deferred(reasons))
            }
            Err(detail) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("dispatch rolled back: {detail}"))
            }
        };
    }
    match claim_with(
        conn,
        vault_id,
        store_uuid,
        lane,
        reservation,
        &[],
        Some(actor),
        None,
        Some(wake),
        None,
        now,
    )? {
        Answer::Woken(woken) => Ok(woken),
        Answer::Dispatched(_) | Answer::Check(_) => {
            Err("dispatch: a woken claim answered without its wake".into())
        }
    }
}

/// The claim transaction, its three crash points and its commit or rollback,
/// shared by [`claim`] and [`claim_woken`].
#[expect(
    clippy::too_many_arguments,
    reason = "claim's arguments plus the wake, passed through whole"
)]
fn claim_with(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    items: &[String],
    actor: Option<&str>,
    cause: Option<&RunCause>,
    wake: Option<&WakeRequest>,
    check: Option<CheckContext<'_>>,
    now: DateTime<Utc>,
) -> Result<Answer, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("dispatch: {e}"))?;
    crate::crash::crash_point("runtime-dispatch-begun");
    let outcome = claim_inner(
        conn,
        vault_id,
        store_uuid,
        lane,
        reservation,
        items,
        actor,
        cause,
        wake,
        check,
        now,
    );
    match outcome {
        Ok(answer) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("dispatch: {e}"))?;
            crate::crash::crash_point("runtime-dispatch-committed");
            Ok(answer)
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("dispatch rolled back: {detail}"))
        }
    }
}

/// Keep a pending wake pending with the reasons it waits on and a time to try
/// again: [`wakes::BUSY_RETRY_SECS`] when every reason is about a busy slot,
/// [`wakes::BUDGET_RETRY_SECS`] otherwise.
pub(crate) fn defer_wake(
    conn: &Connection,
    wake_id: &str,
    reasons: &[String],
    now: DateTime<Utc>,
) -> Result<(), String> {
    let busy = reasons
        .iter()
        .all(|r| r == GateReason::AmbientBusy.as_str() || r == wakes::AGENT_RUNNING);
    let wait = if busy {
        wakes::BUSY_RETRY_SECS
    } else {
        wakes::BUDGET_RETRY_SECS
    };
    conn.execute(
        "UPDATE agent_wakes SET not_before = ?2, deferred = ?3 \
         WHERE wake_id = ?1 AND state = 'pending'",
        rusqlite::params![
            wake_id,
            stamp(now + Duration::seconds(wait)),
            reasons.join(",")
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("agent_wakes: {e}"))
}

/// A woken claim's wake as the transaction reads it.
struct WakeRow {
    trigger_digest: String,
    cause: String,
    parent_run_id: Option<String>,
}

/// The woken half of the claim before the gate: `Ok(Err(answer))` when the
/// claim ends here, `Ok(Ok(row))` when it goes on to the gate.
fn wake_before_gate(
    conn: &Connection,
    vault_id: &str,
    actor: Option<&str>,
    wake: &WakeRequest,
    now: DateTime<Utc>,
) -> Result<Result<WakeRow, Woken>, String> {
    type StoredWake = (
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
    );
    let found: Option<StoredWake> = conn
        .query_row(
            "SELECT vault_id, agent, state, admitted_at, trigger_digest, cause, parent_run_id \
             FROM agent_wakes WHERE wake_id = ?1",
            [&wake.claim],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("agent_wakes: {other}")),
        })?;
    let Some((wake_vault, agent, state, admitted_at, trigger_digest, cause, parent_run_id)) = found
    else {
        return Ok(Err(Woken::Gone));
    };
    if wake_vault != vault_id || state != "pending" {
        return Ok(Err(Woken::Gone));
    }
    if Some(agent.as_str()) != actor {
        return Err(format!(
            "wake {} belongs to {agent}, not {}",
            wake.claim,
            actor.unwrap_or("an unnamed run")
        ));
    }
    if admitted_at <= wakes::ttl_cutoff(now) {
        wakes::cancel_one(conn, &wake.claim, wakes::EXPIRED, None, now)?;
        return Ok(Err(Woken::Gone));
    }
    if let Some(parent) = parent_run_id.as_deref() {
        if let Err(detail) = refuse_if_chain_spent(conn, parent, now) {
            if !detail.starts_with("refused:") {
                return Err(detail);
            }
            wakes::skip_pending(conn, &wake.claim, wakes::CHAIN_SPENT, now)?;
            return Ok(Err(Woken::Skipped));
        }
    }
    // Single flight: one run of an agent at a time, whatever started the one
    // that is going, and one started wake per agent, which the index holds.
    let busy: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM agent_wakes WHERE vault_id = ?1 AND agent = ?2 \
             AND state = 'started') + (SELECT count(*) FROM runs WHERE actor = ?2 \
             AND outcome = 'running' AND (vault_id IS NULL OR vault_id = ?1))",
            rusqlite::params![vault_id, agent],
            |row| row.get(0),
        )
        .map_err(|e| format!("agent_wakes: {e}"))?;
    if busy > 0 {
        let reasons = vec![wakes::AGENT_RUNNING.to_string()];
        defer_wake(conn, &wake.claim, &reasons, now)?;
        return Ok(Err(Woken::Deferred(reasons)));
    }
    Ok(Ok(WakeRow {
        trigger_digest,
        cause,
        parent_run_id,
    }))
}

/// Start the claimed wake with `run_id`, and finish each wake in `coalesce`
/// that is still pending, in this vault, for this agent, of the same
/// trigger, with both causes of kind event, `coalesced` into the same run.
/// Answers the causes of the wakes it took.
fn start_wake(
    conn: &Connection,
    vault_id: &str,
    agent: &str,
    wake: &WakeRequest,
    row: &WakeRow,
    run_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<RunCause>, String> {
    let moved = conn
        .execute(
            "UPDATE agent_wakes SET state = 'started', run_id = ?2, started_at = ?3, \
             not_before = NULL, deferred = NULL WHERE wake_id = ?1 AND state = 'pending'",
            rusqlite::params![wake.claim, run_id, stamp(now)],
        )
        .map_err(|e| format!("agent_wakes: {e}"))?;
    if moved != 1 {
        return Err(format!(
            "wake {} moved while it was being claimed",
            wake.claim
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for id in &wake.coalesce {
        if id == &wake.claim || !seen.insert(id.as_str()) {
            return Err(format!(
                "wake {id} is named twice: a claim takes each wake once"
            ));
        }
    }
    if wake.coalesce.len() > wakes::COALESCE_MAX - 1 {
        return Err(format!(
            "a run takes at most {} wakes, its own and {} more; this claim named {} more",
            wakes::COALESCE_MAX,
            wakes::COALESCE_MAX - 1,
            wake.coalesce.len()
        ));
    }
    let head_is_event = super::cause::RunCause::from_column(&row.cause)
        .is_some_and(|cause| cause.kind() == super::cause::CauseKind::Event);
    let mut also = Vec::new();
    if !head_is_event {
        return Ok(also);
    }
    for id in &wake.coalesce {
        let taken: Option<String> = conn
            .query_row(
                "UPDATE agent_wakes SET state = 'finished', outcome = 'coalesced', run_id = ?2, \
                 finished_at = ?3, not_before = NULL, deferred = NULL \
                 WHERE wake_id = ?1 AND state = 'pending' AND vault_id = ?4 AND agent = ?5 \
                 AND trigger_digest = ?6 AND parent_run_id IS ?7 AND json_extract(cause, '$.kind') = 'event' \
                 RETURNING cause",
                rusqlite::params![id, run_id, stamp(now), vault_id, agent, row.trigger_digest, row.parent_run_id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("agent_wakes: {other}")),
            })?;
        if let Some(cause) = taken.as_deref().and_then(RunCause::from_column) {
            also.push(cause);
        }
    }
    Ok(also)
}

#[expect(
    clippy::too_many_arguments,
    reason = "the transaction body of claim_with, taking exactly its arguments"
)]
fn claim_inner(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    items: &[String],
    actor: Option<&str>,
    cause: Option<&RunCause>,
    wake: Option<&WakeRequest>,
    check: Option<CheckContext<'_>>,
    now: DateTime<Utc>,
) -> Result<Answer, String> {
    // This runs under the same BEGIN IMMEDIATE that inserts the run. Two
    // windows cannot both see an idle actor, or book after its chain spent.
    if let Some(check) = check {
        let pending: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_wakes WHERE vault_id=?1 AND agent=?2 AND state='pending' AND wake_id IN (SELECT value FROM json_each(?3)))",
            rusqlite::params![vault_id,actor,serde_json::to_string(check.wakes).map_err(|e|e.to_string())?],|row|row.get(0))
            .map_err(|error|format!("pre-run check: {error}"))?;
        if !pending {
            return Ok(Answer::Check(CheckClaim::Gone));
        }
        if let Some(parent) = check.parent {
            if chain_spent(conn, parent, now)? {
                return Ok(Answer::Check(CheckClaim::ChainSpent));
            }
        }
        let active: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE vault_id=?1 AND actor=?2 AND outcome='running')",rusqlite::params![vault_id,actor],|row|row.get(0))
            .map_err(|error|format!("pre-run check: {error}"))?;
        if active {
            return Ok(Answer::Check(CheckClaim::Deferred(vec![
                wakes::AGENT_RUNNING.into(),
            ])));
        }
    }
    // A woken claim reads its wake first (M63.1): one that cannot run ends
    // the claim before a gate decision is recorded, as an empty item list
    // does.
    let wake_row = match wake {
        Some(wake) => match wake_before_gate(conn, vault_id, actor, wake, now)? {
            Ok(row) => Some(row),
            Err(answer) => return Ok(Answer::Woken(answer)),
        },
        None => None,
    };

    // What is actually still claimable, BEFORE anything is written.
    //
    // Asking first is not an optimization. A dispatcher whose queue was built
    // a moment ago may name items a human has since edited or a review has
    // since consumed, and burning a gate decision — let alone a run — on an
    // empty claim would make "we tried and were refused" and "there was
    // nothing to do" look identical in the record.
    let pending = pending_subset(conn, vault_id, store_uuid, items)?;
    if pending.is_empty() && !items.is_empty() {
        return Ok(Answer::Dispatched(Dispatched::NothingToClaim));
    }

    // The gate takes the ACTOR as well as the lane (M33b.5): whether this one
    // agent is paused is a gate decision like every other refusal, decided in
    // the same transaction and recorded in the same deferral row, rather than
    // a second check bolted on beside it.
    let (decision, day) = budget::gate(conn, vault_id, store_uuid, lane, actor, reservation, now)?;
    let decision_id = crate::ledger::new_id128();
    budget::record_decision(
        conn,
        &decision_id,
        vault_id,
        store_uuid,
        lane,
        reservation,
        &day,
        &decision,
        now,
    )?;
    if let Decision::Deferred(reasons) = decision {
        // The decision row is kept: a deferral nobody can look up afterwards
        // is indistinguishable from a dispatcher that never tried.
        let Some(wake) = wake else {
            return Ok(Answer::Dispatched(Dispatched::Deferred(reasons)));
        };
        // A per-agent pause cancels the wake: a paused agent owes nothing,
        // so nothing waits for it to resume. Every other reason only defers.
        if reasons.contains(&GateReason::AgentPaused) {
            wakes::cancel_one(
                conn,
                &wake.claim,
                wakes::SUPERSEDED,
                Some(wakes::CancelWhy::Paused.as_str()),
                now,
            )?;
            return Ok(Answer::Woken(Woken::Gone));
        }
        let names: Vec<String> = reasons.iter().map(|r| r.as_str().to_string()).collect();
        defer_wake(conn, &wake.claim, &names, now)?;
        return Ok(Answer::Woken(Woken::Deferred(names)));
    }

    let run_id = crate::ledger::new_id128();
    let lease_seconds = (day.ceilings.max_run_elapsed_seconds as i64) * LEASE_MULTIPLE;
    let lease_expires_at = stamp(now + Duration::seconds(lease_seconds));

    // The run row comes FIRST: a claim points at its owner with a foreign
    // key, so an item can never be owned by a run that does not exist.
    // `counters_booked = 1`: its three zeros are measured-at-zero, because
    // `CommitOutcome::book`/`book_decision` count against this row (M49.9).
    // A woken run's cause is its wake's, stored at admission (M63.1).
    let cause_column = match &wake_row {
        Some(row) => Some(row.cause.clone()),
        None => cause.map(RunCause::to_column),
    };
    conn.execute(
        "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
         usage_state, input_tokens, output_tokens, cache_read, cache_write, \
         reserved_total_tokens, reserved_output_tokens, lease_expires_at, proposals_submitted, \
         applied, rejected, actor, counters_booked, cause, parent_run_id) \
         VALUES (?1, ?2, ?3, 'ambient', ?4, ?5, 'running', 'pending', 0, 0, 0, 0, ?6, ?7, ?8, \
                 0, 0, 0, ?9, 1, ?10, ?11)",
        rusqlite::params![
            run_id,
            vault_id,
            store_uuid,
            lane,
            stamp(now),
            reservation.total_tokens as i64,
            reservation.output_tokens as i64,
            lease_expires_at,
            actor,
            cause_column,
            wake_row
                .as_ref()
                .and_then(|row| row.parent_run_id.as_deref())
                .or(check.and_then(|c| c.parent)),
        ],
    )
    .map_err(|e| format!("runs: {e}"))?;

    let also = match (wake, &wake_row, actor) {
        (Some(wake), Some(row), Some(agent)) => {
            start_wake(conn, vault_id, agent, wake, row, &run_id, now)?
        }
        _ => Vec::new(),
    };

    let claimed = claim_items(
        conn,
        vault_id,
        store_uuid,
        &pending,
        &run_id,
        &lease_expires_at,
    )?;

    conn.execute(
        "UPDATE budget_days SET reserved_total_tokens = reserved_total_tokens + ?2, \
         reserved_output_tokens = reserved_output_tokens + ?3, \
         ambient_runs_started = ambient_runs_started + 1 WHERE window_start_utc = ?1",
        rusqlite::params![
            day.window_start_utc,
            reservation.total_tokens as i64,
            reservation.output_tokens as i64,
        ],
    )
    .map_err(|e| format!("budget_days: {e}"))?;

    // The lease. What enforces the ceiling is the transaction this statement
    // is inside: `budget::gate` counted the live leases a few lines up, under
    // the same `BEGIN IMMEDIATE`, so no other dispatcher can have inserted one
    // in between. The primary key is `run_id` now and stops nothing but a run
    // leasing twice — the ceiling is a counted number, not a column.
    conn.execute(
        "INSERT INTO ambient_dispatch \
         (run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            run_id,
            vault_id,
            store_uuid,
            lane,
            stamp(now),
            lease_expires_at
        ],
    )
    .map_err(|e| format!("ambient_dispatch (this run's lease): {e}"))?;

    conn.execute(
        "INSERT INTO ambient_gate_state (vault_id, store_uuid, lane, consecutive_failures, \
         active_run_started_at) VALUES (?1, ?2, ?3, 0, ?4) \
         ON CONFLICT (vault_id, store_uuid, lane) DO UPDATE SET \
         active_run_started_at = excluded.active_run_started_at",
        rusqlite::params![vault_id, store_uuid, lane, stamp(now)],
    )
    .map_err(|e| format!("ambient_gate_state: {e}"))?;

    budget::refresh_ceiling_state(conn, &day.window_start_utc)?;
    crate::crash::crash_point("runtime-dispatch-claimed");
    let lease = Lease {
        run_id,
        lease_expires_at,
        window_start_utc: day.window_start_utc,
        elapsed_limit_seconds: day.ceilings.max_run_elapsed_seconds,
        claimed,
    };
    Ok(match wake_row {
        Some(row) => Answer::Woken(Woken::Started {
            lease: Box::new(lease),
            cause: RunCause::from_column(&row.cause),
            also,
            parent_run_id: row.parent_run_id,
        }),
        None => Answer::Dispatched(Dispatched::Started(lease)),
    })
}

/// Which of the named items are still `pending`, in the caller's order.
fn pending_subset(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    items: &[String],
) -> Result<Vec<String>, String> {
    let mut pending = Vec::new();
    for item in items {
        let is_pending: i64 = conn
            .query_row(
                "SELECT count(*) FROM scheduler WHERE vault_id = ?1 AND store_uuid = ?2 \
                 AND item_key = ?3 AND state = 'pending'",
                rusqlite::params![vault_id, store_uuid, item],
                |row| row.get(0),
            )
            .map_err(|e| format!("scheduler {item}: {e}"))?;
        if is_pending == 1 {
            pending.push(item.clone());
        }
    }
    Ok(pending)
}

/// Move named items `pending → claimed`, returning the ones that actually
/// moved. Conditional on `pending` by construction, so two dispatchers racing
/// for the same item cannot both win it.
fn claim_items(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    items: &[String],
    run_id: &str,
    lease_expires_at: &str,
) -> Result<Vec<String>, String> {
    let mut claimed = Vec::new();
    for item in items {
        let moved = conn
            .execute(
                "UPDATE scheduler SET state = 'claimed', claimed_by_run_id = ?4, \
                 claim_expires_at = ?5, updated_at = ?5 \
                 WHERE vault_id = ?1 AND store_uuid = ?2 AND item_key = ?3 AND state = 'pending'",
                rusqlite::params![vault_id, store_uuid, item, run_id, lease_expires_at],
            )
            .map_err(|e| format!("scheduler {item}: {e}"))?;
        if moved == 1 {
            claimed.push(item.clone());
        }
    }
    Ok(claimed)
}

/// How a run ended, in the schema's vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    Succeeded,
    Failed,
    QuotaFailed,
    ElapsedAborted,
    Cancelled,
    AbandonedUsageUnknown,
}

impl RunOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            RunOutcome::Succeeded => "succeeded",
            RunOutcome::Failed => "failed",
            RunOutcome::QuotaFailed => "quota_failed",
            RunOutcome::ElapsedAborted => "elapsed_aborted",
            RunOutcome::Cancelled => "cancelled",
            RunOutcome::AbandonedUsageUnknown => "abandoned_usage_unknown",
        }
    }

    fn is_success(self) -> bool {
        matches!(self, RunOutcome::Succeeded)
    }
}

/// Close out one ambient run: exact usage, released reservation and lease,
/// and every claimed item consumed or requeued — one transaction.
///
/// `usage: None` is the honest-unknown path and is NOT the same as
/// `Some(Usage::default())`. Zero says "this run cost nothing"; none says
/// "nobody knows what this run cost", which pauses ambient work.
///
/// A quota death here backs off for one quota window: a caller that knows
/// when Claude Code said the limit resets uses [`finalize_until_reset`].
pub fn finalize(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    items: ItemOutcome,
    now: DateTime<Utc>,
) -> Result<(), String> {
    finalize_until_reset(conn, run_id, outcome, usage, facts, items, None, now)
}

/// [`finalize`], with the reset Claude Code reported for the limit that
/// killed a `QuotaFailed` run (M56.14), so the backoff ends there rather than
/// after one window (`health::quota_backoff_end`). Ignored for any other
/// outcome.
#[expect(
    clippy::too_many_arguments,
    reason = "finalize's seven, plus the reported reset; a struct would rename every caller's arguments for one optional field"
)]
pub fn finalize_until_reset(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    items: ItemOutcome,
    quota_resets_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    finalize_with(
        conn,
        run_id,
        outcome,
        usage,
        facts,
        items,
        quota_resets_at,
        false,
        now,
    )
}

/// A pre-run check is metered normally, but never changes the agent lane's
/// consecutive-failure counter. A crashed check is still swept normally.
pub fn finalize_check(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    finalize_with(
        conn,
        run_id,
        outcome,
        usage,
        facts,
        ItemOutcome::Consume,
        None,
        true,
        now,
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "the common finalizer keeps the public call contracts, with one supervisor flag"
)]
fn finalize_with(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    items: ItemOutcome,
    quota_resets_at: Option<DateTime<Utc>>,
    check: bool,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("finalize: {e}"))?;
    crate::crash::crash_point("runtime-finalize-begun");
    let result = finalize_inner(
        conn,
        run_id,
        outcome,
        usage,
        facts,
        items,
        quota_resets_at,
        check,
        now,
    );
    match result {
        Ok(pause) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("finalize: {e}"))?;
            crate::crash::crash_point("runtime-finalize-committed");
            if pause {
                // Outside the transaction on purpose: the process status is
                // not a database row, and setting it before the commit would
                // pause on a finalization that then rolled back.
                status::set(status::RuntimeStatus::Recovering {
                    reason: status::RecoveryReason::DatabaseLost,
                });
            }
            Ok(())
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("finalize rolled back: {detail}"))
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "finalize_until_reset's arguments, passed through whole"
)]
fn finalize_inner(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    items: ItemOutcome,
    quota_resets_at: Option<DateTime<Utc>>,
    check: bool,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let (vault_id, store_uuid, lane, mode, reserved_total, reserved_output, started_at): (
        Option<String>,
        Option<String>,
        String,
        String,
        i64,
        i64,
        String,
    ) = conn
        .query_row(
            "SELECT vault_id, store_uuid, lane, mode, reserved_total_tokens, \
             reserved_output_tokens, started_at FROM runs WHERE run_id = ?1 \
             AND outcome = 'running'",
            [run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!(
                "run {run_id} is not running — already finalized, or never started. \
                 Finalizing twice would double-count its tokens."
            ),
            other => format!("runs: {other}"),
        })?;

    let counted = usage.unwrap_or_default();
    conn.execute(
        "UPDATE runs SET ended_at = ?2, outcome = ?3, usage_state = ?4, input_tokens = ?5, \
         output_tokens = ?6, cache_read = ?7, cache_write = ?8, lease_expires_at = NULL \
         WHERE run_id = ?1",
        rusqlite::params![
            run_id,
            stamp(now),
            outcome.as_str(),
            if usage.is_some() { "exact" } else { "unknown" },
            counted.input_tokens as i64,
            counted.output_tokens as i64,
            counted.cache_read as i64,
            counted.cache_write as i64,
        ],
    )
    .map_err(|e| format!("runs: {e}"))?;

    if let Some(facts) = facts {
        write_facts(conn, run_id, facts)?;
        route_denials(conn, run_id, store_uuid.as_deref(), facts);
    }

    // The run's wake ends with it (M63.1), before the attended return, so
    // the lease sweep and the orphan recovery close wakes too.
    wakes::finish_for_run(conn, run_id, outcome, now)?;

    if mode == "attended" {
        // Metered, never budgeted: an attended run debits no ceiling and
        // holds no lease, so there is nothing else to release.
        return Ok(false);
    }

    let started = DateTime::parse_from_rfc3339(&started_at)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|e| format!("run {run_id} has an unreadable start time: {e}"))?;
    let day = budget::ensure_day(conn, started)?;
    conn.execute(
        "UPDATE budget_days SET reserved_total_tokens = max(0, reserved_total_tokens - ?2), \
         reserved_output_tokens = max(0, reserved_output_tokens - ?3) WHERE window_start_utc = ?1",
        rusqlite::params![day.window_start_utc, reserved_total, reserved_output],
    )
    .map_err(|e| format!("budget_days: {e}"))?;

    let mut pause = false;
    match usage {
        Some(counted) => {
            conn.execute(
                "UPDATE budget_days SET ambient_tokens_used = ambient_tokens_used + ?2, \
                 ambient_output_tokens = ambient_output_tokens + ?3 WHERE window_start_utc = ?1",
                rusqlite::params![
                    day.window_start_utc,
                    counted.total() as i64,
                    counted.output_tokens as i64,
                ],
            )
            .map_err(|e| format!("budget_days: {e}"))?;
        }
        None => {
            // The conservative arm. Spend that cannot be counted is not
            // spend that did not happen.
            budget::mark_accounting_unknown(conn, &day.window_start_utc)?;
            pause = true;
        }
    }
    budget::refresh_ceiling_state(conn, &day.window_start_utc)?;

    conn.execute("DELETE FROM ambient_dispatch WHERE run_id = ?1", [run_id])
        .map_err(|e| format!("ambient_dispatch: {e}"))?;

    conn.execute(
        "UPDATE scheduler SET state = ?2, claimed_by_run_id = NULL, claim_expires_at = NULL, \
         updated_at = ?3 WHERE claimed_by_run_id = ?1",
        rusqlite::params![run_id, items.state().as_str(), stamp(now)],
    )
    .map_err(|e| format!("scheduler: {e}"))?;

    // The quota path, INSIDE the same transaction that requeued the work: a
    // backoff written afterwards could be lost by a kill between the two, and
    // the next dispatcher would walk straight back into the wall. It ends at
    // the reset Claude Code reported, when it reported one (M56.14).
    if outcome == RunOutcome::QuotaFailed {
        if let Some(store) = &store_uuid {
            super::health::record_quota_failure_until_reset(
                conn,
                store,
                "the CLI reported a usage or rate limit",
                now,
                quota_resets_at,
            )?;
        }
    } else if outcome.is_success() {
        super::health::record_runtime_recovery(conn, now)?;
    }

    if let (Some(vault_id), Some(store_uuid)) = (vault_id, store_uuid) {
        // Checks release their active marker without changing the agent's
        // failure streak; ordinary success resets it and ordinary failure adds.
        let sql = if check {
            "UPDATE ambient_gate_state SET active_run_started_at = NULL, last_outcome = ?4 \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND lane = ?3"
        } else if outcome.is_success() {
            "INSERT INTO ambient_gate_state (vault_id, store_uuid, lane, consecutive_failures, \
             active_run_started_at, last_outcome) VALUES (?1, ?2, ?3, 0, NULL, ?4) \
             ON CONFLICT (vault_id, store_uuid, lane) DO UPDATE SET consecutive_failures = 0, \
             active_run_started_at = NULL, last_outcome = excluded.last_outcome"
        } else {
            "INSERT INTO ambient_gate_state (vault_id, store_uuid, lane, consecutive_failures, \
             active_run_started_at, last_outcome) VALUES (?1, ?2, ?3, 1, NULL, ?4) \
             ON CONFLICT (vault_id, store_uuid, lane) DO UPDATE SET \
             consecutive_failures = ambient_gate_state.consecutive_failures + 1, \
             active_run_started_at = NULL, last_outcome = excluded.last_outcome"
        };
        conn.execute(
            sql,
            rusqlite::params![vault_id, store_uuid, lane, outcome.as_str()],
        )
        .map_err(|e| format!("ambient_gate_state: {e}"))?;
    }
    Ok(pause)
}

/// Finalize every run whose lease has expired.
///
/// This is what makes every crash boundary retry-safe: after a kill, the item
/// is either still `pending` (the claim never committed) or owned by exactly
/// one run whose lease will expire and free it. It never assumes the run cost
/// nothing.
///
/// **One production caller, and it is load-bearing**: `ingest::ambient`'s
/// supervisor tick, ahead of the pause (see `sweep_abandoned` for why it sits
/// there). Until M33b.1 this function had NO caller at all and the
/// `ambient_dispatch` singleton primary key was accidentally covering for it,
/// by turning every claim after a crash into a rolled-back error. Retiring
/// the singleton without wiring this would have replaced a loud wedge with a
/// silent loss: runs `running` forever, their items `claimed` and never
/// re-offered, their reservations debited against a day that never learns its
/// spend was unknown.
///
/// It reads `runs`, never `ambient_dispatch` — a lease row is a claim-time
/// mutex, and the run row is the thing with accounting on it.
pub fn recover_expired_leases(conn: &Connection, now: DateTime<Utc>) -> Result<usize, String> {
    let expired: Vec<String> = {
        let mut statement = conn
            .prepare(
                "SELECT run_id FROM runs WHERE outcome = 'running' AND mode = 'ambient' \
                 AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1 ORDER BY run_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([stamp(now)], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for run_id in &expired {
        finalize(
            conn,
            run_id,
            RunOutcome::AbandonedUsageUnknown,
            None,
            // A recovered lease has no stream to read facts from.
            None,
            ItemOutcome::Requeue,
            now,
        )?;
    }
    Ok(expired.len())
}

/// The actors above a run, root first, bounded even if an old database has
/// corrupt ancestry. A missing run is no chain; a recorded NULL actor is the
/// assistant's default actor, never a fabricated person.
pub fn chain_actors(conn: &Connection, run_id: &str) -> Result<Option<Vec<String>>, String> {
    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE up(run_id, parent, actor, depth) AS ( \
         SELECT run_id, parent_run_id, actor, 0 FROM runs WHERE run_id = ?1 \
         UNION ALL SELECT r.run_id, r.parent_run_id, r.actor, up.depth + 1 \
         FROM runs r JOIN up ON r.run_id = up.parent WHERE up.depth < 15) \
         SELECT actor FROM up ORDER BY depth DESC",
        )
        .map_err(|e| format!("run chain: {e}"))?;
    let rows = stmt
        .query_map([run_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|e| format!("run chain: {e}"))?;
    let actors = rows
        .map(|row| row.map(|actor| crate::mcp::normalize_actor(actor.as_deref()).to_string()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("run chain: {e}"))?;
    Ok((!actors.is_empty()).then_some(actors))
}

/// The root's ceiling stops the chain (M36.6, settled design decision 5).
///
/// Hops bill to the root — `parent_run_id` is the migration that made both
/// true — so the chain's recorded spend is summed over the ROOT's whole tree
/// and a hop that would extend a spent chain is refused before any child
/// exists, like every other hop rule. The allowance is the day's per-run
/// ambient ceiling: a chain is one job fanned out, and what one background
/// run may spend is what its whole chain may spend.
///
/// Enforcement grows as TOKENS land, and that is stated rather than hidden:
/// an attended row is opened before its child spawns ([`begin_attended`],
/// M49.9), so the chain is walkable to its real root mid-run, but its
/// tokens are only written when it FINISHES — a chain of still-running
/// attended turns sums what its finished members spent. The two-hop budget
/// bounds what that window can cost.
pub fn refuse_if_chain_spent(
    conn: &Connection,
    caller_run_id: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let (root, spent, ceiling) = chain_totals(conn, caller_run_id, now)?;
    if (spent as u64) >= ceiling {
        return Err(format!(
            "refused: this chain has already spent {spent} tokens, at or past the \
             {ceiling}-token ceiling its root ({root}) runs under — a spent chain stops, \
             however many hops it has left"
        ));
    }
    Ok(())
}

/// A spent allowance is distinct from an unreadable account: only the former
/// ends a wake as chain_spent; a failed read must remain retryable.
pub(crate) fn chain_spent(
    conn: &Connection,
    caller_run_id: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let (_, spent, ceiling) = chain_totals(conn, caller_run_id, now)?;
    Ok(spent as u64 >= ceiling)
}

fn chain_totals(
    conn: &Connection,
    caller_run_id: &str,
    now: DateTime<Utc>,
) -> Result<(String, i64, u64), String> {
    let root: String = conn
        .query_row(
            "WITH RECURSIVE up(run_id, parent) AS ( \
               SELECT run_id, parent_run_id FROM runs WHERE run_id = ?1 \
               UNION ALL \
               SELECT r.run_id, r.parent_run_id FROM runs r JOIN up ON up.parent = r.run_id \
             ) SELECT run_id FROM up WHERE parent IS NULL",
            [caller_run_id],
            |row| row.get(0),
        )
        // No row: a caller whose meter could not open one (no runtime DB at
        // its spawn). The caller IS the root as far as the table can see.
        .optional()
        .map_err(|error| format!("chain root: {error}"))?
        .unwrap_or_else(|| caller_run_id.to_string());
    let spent: i64 = conn
        .query_row(
            "WITH RECURSIVE chain(run_id) AS ( \
               SELECT run_id FROM runs WHERE run_id = ?1 \
               UNION ALL \
               SELECT r.run_id FROM runs r JOIN chain c ON r.parent_run_id = c.run_id \
             ) SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM runs \
             WHERE run_id IN (SELECT run_id FROM chain)",
            [&root],
            |row| row.get(0),
        )
        .map_err(|e| format!("chain spend: {e}"))?;
    let ceiling = super::budget::ensure_day(conn, now)?
        .ceilings
        .max_ambient_run_tokens;
    Ok((root, spent, ceiling))
}

/// Open one attended run's row, BEFORE its child exists (M49.9, K25).
///
/// An attended run used to have no row until [`meter_attended`] wrote one
/// at the end — so every `CommitOutcome::book` made DURING it matched no
/// row, and the finish then stamped `counters_booked = 1` over three zeros
/// nobody measured: "0 applied" for a run that applied. The row now stands
/// while the run does, `running` and `pending` exactly like the ambient
/// claim's, and booked because in-run booking reaches it.
///
/// A run that dies with its process stays `running` until
/// [`recover_orphaned_attended`] closes it `abandoned_usage_unknown` — the
/// ambient lease sweep's outcome, without a lease: an attended run holds no
/// reservation and has no deadline, so what marks it orphaned is only that
/// the process that could finish it is gone.
///
/// `cause` (M56.7) is written with the row: `attended` for a panel turn,
/// `handoff` for a run another run started, `assembly` for the synthesis
/// construct.
#[expect(
    clippy::too_many_arguments,
    reason = "one argument per column of the attended run row it opens"
)]
pub fn begin_attended(
    conn: &Connection,
    run_id: &str,
    vault_id: Option<&str>,
    store_uuid: Option<&str>,
    actor: Option<&str>,
    parent_run_id: Option<&str>,
    cause: Option<&RunCause>,
    started_at: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
         usage_state, input_tokens, output_tokens, cache_read, cache_write, \
         reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, rejected, \
         actor, parent_run_id, counters_booked, cause) \
         VALUES (?1, ?2, ?3, 'attended', 'agent', ?4, 'running', 'pending', 0, 0, 0, 0, 0, 0, \
                 0, 0, 0, ?5, ?6, 1, ?7)",
        rusqlite::params![
            run_id,
            vault_id,
            store_uuid,
            stamp(started_at),
            actor,
            parent_run_id,
            cause.map(RunCause::to_column),
        ],
    )
    .map_err(|e| format!("runs (attended, open): {e}"))?;
    Ok(())
}

/// A personal-token session is an attributed run, not a model invocation.
/// Usage stays pending until it ends unknown; recorded counters and writes
/// are available immediately while the session dispatches calls.
pub struct ClientSession<'a> {
    pub run_id: &'a str,
    pub vault_id: &'a str,
    pub store_uuid: &'a str,
    pub actor: &'a str,
    pub token_name: &'a str,
    pub client_info: Option<&'a str>,
    pub started_at: DateTime<Utc>,
}

/// The caller opens its BEGIN IMMEDIATE before this insert and stamps the
/// token in that same transaction, so no unrecorded session can answer.
pub fn begin_client_session(conn: &Connection, session: &ClientSession<'_>) -> Result<(), String> {
    if !session
        .actor
        .starts_with(crate::client_access::CLIENT_ACTOR_PREFIX)
    {
        return Err("a client session needs a client actor".into());
    }
    let cause = RunCause::new(
        super::cause::CauseKind::Client,
        Some(session.token_name),
        session.client_info,
        None,
    );
    conn.execute("INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, rejected, actor, counters_booked, writes_booked, cause) VALUES (?1,?2,?3,'attended','agent',?4,'running','pending',0,0,0,0,0,0,0,0,0,?5,1,1,?6)",
        rusqlite::params![session.run_id,session.vault_id,session.store_uuid,stamp(session.started_at),session.actor,cause.to_column()])
        .map_err(|e| format!("runs (client, open): {e}"))?;
    Ok(())
}

/// Only running client rows can finish here. A repeated close is inert and
/// nobody invents usage for a request processed by another app's model.
pub fn finish_client_session(
    conn: &Connection,
    run_id: &str,
    succeeded: bool,
    ended_at: DateTime<Utc>,
) -> Result<bool, String> {
    conn.execute("UPDATE runs SET ended_at=?2, outcome=?3, usage_state='unknown' WHERE run_id=?1 AND outcome='running' AND actor LIKE 'client:%' AND json_extract(cause, '$.kind')='client'",
        rusqlite::params![run_id,stamp(ended_at),if succeeded {"succeeded"} else {"cancelled"}])
        .map(|changed| changed != 0).map_err(|e| format!("runs (client, finish): {e}"))
}

/// Does `approval` let the CLI's own writers or its shell run, asked or not
/// (M58.1)? Those tools write past every door, so `vault_writes` cannot hold
/// all a run of them wrote. Read from the data: a CLI tool in a family the
/// Settings shell ceiling decides, that is no reader (it folds no reads),
/// with a decision that lets it run.
pub fn shell_may_write(approval: &crate::policy::tool_approval::RunApproval) -> bool {
    use crate::policy::tool_approval::Decision as Planned;
    let table = crate::policy::tool_approval::table();
    approval.decisions.iter().any(|row| {
        let past_the_doors = table
            .family(&row.family)
            .is_some_and(|family| family.ceiling == "shell")
            && crate::policy::tools::cli_tool(&row.tool).is_some_and(|tool| tool.fold.is_none());
        past_the_doors && matches!(row.decision, Planned::Allow | Planned::Cli | Planned::Ask)
    })
}

/// Book a run's writes as partial (M58.1): `runs.writes_booked = 2`, when its
/// plan lets the CLI's own writers or the shell run (`shell_may_write`). Its
/// `vault_writes` rows are still every door's write, but the shell may have
/// written elsewhere. Only a row booked whole moves; a row from before M58.1
/// stays not recorded. Called once the row stands (the claim, or
/// `begin_attended`); never fails a run.
pub fn book_partial_writes(
    conn: &Connection,
    run_id: &str,
    approval: &crate::policy::tool_approval::RunApproval,
) -> Result<(), String> {
    if !shell_may_write(approval) {
        return Ok(());
    }
    conn.execute(
        "UPDATE runs SET writes_booked = 2 WHERE run_id = ?1 AND writes_booked = 1",
        [run_id],
    )
    .map_err(|e| format!("runs (writes booked): {e}"))?;
    Ok(())
}

/// Take back an attended row whose child never spawned.
///
/// Nothing ran, nothing could present the run's token, and nothing was
/// booked — so the run did not happen and leaves no row, exactly as before
/// rows were opened at spawn. Matches only an attended row still `running`:
/// never a finished run, never an ambient claim.
pub fn discard_unstarted_attended(conn: &Connection, run_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM runs WHERE run_id = ?1 AND mode = 'attended' AND outcome = 'running'",
        [run_id],
    )
    .map_err(|e| format!("runs (attended, discard): {e}"))?;
    Ok(())
}

/// Close every attended row a dead process left `running` (M49.9).
///
/// `started_before` is THIS process's start: an attended row is finished
/// only by the reader thread of the process that spawned it, so a row still
/// `running` from before this process began has no finisher left. It closes
/// `abandoned_usage_unknown` with `unknown` usage — tokens were spent and
/// nobody counted them — through [`finalize`], whose attended arm touches no
/// budget, lease or item. Its booked counters stand: they were counted as
/// the run wrote. A row this process opened is never touched.
///
/// If another process sharing this app-data dir is in fact still running
/// such a run, its finish re-closes the row with the real numbers (see
/// [`meter_attended`]); an attended row carries no debit that closing it
/// twice could double.
pub fn recover_orphaned_attended(
    conn: &Connection,
    started_before: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<usize, String> {
    let orphaned: Vec<String> = {
        let mut statement = conn
            .prepare(
                "SELECT run_id FROM runs WHERE mode = 'attended' AND outcome = 'running' \
                 AND started_at < ?1 ORDER BY run_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([stamp(started_before)], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for run_id in &orphaned {
        finalize(
            conn,
            run_id,
            RunOutcome::AbandonedUsageUnknown,
            None,
            // No stream survived to read facts from.
            None,
            // An attended run claims no items; the argument is inert.
            ItemOutcome::Requeue,
            now,
        )?;
    }
    Ok(orphaned.len())
}

/// Close one attended run's books. Metered, never gated: no reservation, no
/// lease, no budget debit, and no way for a full day to stop it.
///
/// Finalizes the row [`begin_attended`] opened: outcome, end, and usage, and
/// NOTHING else — the proposal counters are what `CommitOutcome::book`
/// counted while the run wrote, and `counters_booked` stays the 1 the open
/// stamped. A row still `abandoned_usage_unknown` is re-closed too: that is
/// [`recover_orphaned_attended`] having given up on a run whose process
/// turned out to be alive, and the finisher knows better. Any other closed
/// row, or an ambient one, is refused rather than overwritten.
///
/// With no row to finalize — the open failed, or a caller that never opened
/// one — the row is inserted whole, its `cause` included, with
/// `counters_booked = 0`: no row stood while the run wrote, so no booking
/// reached it, and its zeros read as NOT RECORDED rather than as a
/// measurement. The conflict update never touches `cause`: why a run
/// started is written once, with its row (M56.7).
#[expect(
    clippy::too_many_arguments,
    reason = "one argument per column of the attended run row it writes"
)]
pub fn meter_attended(
    conn: &Connection,
    run_id: &str,
    vault_id: Option<&str>,
    store_uuid: Option<&str>,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    actor: Option<&str>,
    parent_run_id: Option<&str>,
    cause: Option<&RunCause>,
    started_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let counted = usage.unwrap_or_default();
    // The DO UPDATE names only what a finish learns; see the doc above for
    // why the counters and `counters_booked` are absent from it (M49.9).
    let written = conn
        .execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, ended_at, \
         outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, \
         reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, rejected, \
         actor, parent_run_id, counters_booked, cause) \
         VALUES (?1, ?2, ?3, 'attended', 'agent', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, 0, 0, \
                 0, ?12, ?13, 0, ?14) \
         ON CONFLICT (run_id) DO UPDATE SET ended_at = excluded.ended_at, \
         outcome = excluded.outcome, usage_state = excluded.usage_state, \
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, \
         cache_read = excluded.cache_read, cache_write = excluded.cache_write \
         WHERE runs.mode = 'attended' \
         AND runs.outcome IN ('running', 'abandoned_usage_unknown')",
            rusqlite::params![
                run_id,
                vault_id,
                store_uuid,
                stamp(started_at),
                stamp(now),
                outcome.as_str(),
                if usage.is_some() { "exact" } else { "unknown" },
                counted.input_tokens as i64,
                counted.output_tokens as i64,
                counted.cache_read as i64,
                counted.cache_write as i64,
                actor,
                parent_run_id,
                cause.map(RunCause::to_column),
            ],
        )
        .map_err(|e| format!("runs (attended): {e}"))?;
    if written == 0 {
        // The conflict's WHERE declined: finished already, or not attended.
        return Err(format!(
            "run {run_id} is not an open attended run — already finalized, or ambient. \
             Closing it again would overwrite a finished record."
        ));
    }
    if let Some(facts) = facts {
        write_facts(conn, run_id, facts)?;
        route_denials(conn, run_id, store_uuid, facts);
    }
    Ok(())
}

/// Record the Claude Code session a run ran as (M56.7): the id it was spawned
/// with (M56.3, `meter::record_spawned_session`), then its stream's.
///
/// An id that is not session-shaped (`cause::is_cli_session_id`) is refused
/// before it reaches the column's CHECK. Otherwise the row takes it, whatever
/// it held: the stream's own id, written last, is the one a transcript is
/// filed under.
pub fn record_cli_session(conn: &Connection, run_id: &str, id: &str) -> Result<(), String> {
    if !is_cli_session_id(id) {
        return Err(format!(
            "run {run_id}: {id:?} is not a Claude Code session id — 8 to 64 letters, digits \
             and dashes, never starting with a dash"
        ));
    }
    conn.execute(
        "UPDATE runs SET cli_session_id = ?2 WHERE run_id = ?1",
        rusqlite::params![run_id, id],
    )
    .map_err(|e| format!("runs (cli session): {e}"))?;
    Ok(())
}

/// Write one run's best-effort facts (M31.5) onto its already-written row.
///
/// Absent facts never reach here — the caller skips the UPDATE entirely —
/// and an absent FIELD writes NULL, which is the honest answer and never
/// zero. A value too large for the column degrades to NULL the same way
/// (`i64::try_from`, never `as`): a wrapped cast would go negative, trip the
/// CHECK, and roll back the WHOLE finalize — measurement becoming a second
/// way for the run to fail, over a number the wire got wrong. The fact
/// columns say what the stream said; the count columns beside them keep
/// saying what the budget counted.
fn write_facts(conn: &Connection, run_id: &str, facts: &RunFacts) -> Result<(), String> {
    let column = |value: Option<u64>| value.and_then(|v| i64::try_from(v).ok());
    conn.execute(
        "UPDATE runs SET model_id = ?2, stop_reason = ?3, service_tier = ?4, \
         total_cost_micros = ?5, num_turns = ?6, duration_ms = ?7, duration_api_ms = ?8, \
         cache_write_5m = ?9, cache_write_1h = ?10, server_tool_use = ?11 WHERE run_id = ?1",
        rusqlite::params![
            run_id,
            facts.model_id,
            facts.stop_reason,
            facts.service_tier,
            column(facts.total_cost_micros),
            column(facts.num_turns),
            column(facts.duration_ms),
            column(facts.duration_api_ms),
            column(facts.cache_write_5m),
            column(facts.cache_write_1h),
            column(facts.server_tool_use),
        ],
    )
    .map_err(|e| format!("runs (facts): {e}"))?;
    Ok(())
}

/// Route a run's permission denials to the operational log (M31.5).
///
/// One row per run with a NON-EMPTY denial array, reusing the registered
/// `capability_unavailable` code — operational by the two-destinies rule: a
/// denied tool call is a capability gap of this run, not epistemic history.
/// The detail says how many calls were denied and names the tools (M54.9,
/// `denial_detail`), so a connector tool a record narrowed out reads by name
/// under its run. An empty array records nothing; `Some(0)` lives in
/// RunFacts, and a zero row per run would train everyone to stop reading the
/// log. Best-effort by construction (`record_or_warn`): telemetry must never
/// become a second way for the run to fail.
fn route_denials(conn: &Connection, run_id: &str, store_uuid: Option<&str>, facts: &RunFacts) {
    let Some(denied) = facts.permission_denials.filter(|count| *count > 0) else {
        return;
    };
    let detail = denial_detail(denied, facts.denied_tools.as_deref().unwrap_or(&[]));
    let refusal = crate::policy::table::PolicyTable::load()
        .ok()
        .and_then(|table| {
            crate::policy::rejection::OperationalRefusal::new(
                &table,
                "capability_unavailable",
                "agent.permission",
                &detail,
            )
            .ok()
        });
    if let Some(refusal) = refusal {
        let entry = super::operational::LogEntry {
            store_uuid: store_uuid.map(str::to_string),
            proposal_id: None,
            run_id: Some(run_id.to_string()),
            rule: None,
        };
        super::operational::record_or_warn(conn, &refusal, &entry);
    }
}

/// What a run's `agent.permission` row says (M54.9): `the CLI denied N
/// call(s) this run: a, b`, the tools sorted as RunFacts holds them. Twenty
/// names at most, then how many more; each name loses control characters and
/// stops at 120 characters, since a server picks its own tool names.
fn denial_detail(calls: u64, tools: &[String]) -> String {
    const NAMED: usize = 20;
    const LONGEST: usize = 120;
    let mut detail = format!("the CLI denied {calls} call(s) this run");
    if tools.is_empty() {
        return detail;
    }
    let named: Vec<String> = tools
        .iter()
        .take(NAMED)
        .map(|tool| {
            tool.chars()
                .filter(|c| !c.is_control())
                .take(LONGEST)
                .collect()
        })
        .collect();
    detail.push_str(": ");
    detail.push_str(&named.join(", "));
    if tools.len() > NAMED {
        detail.push_str(&format!(" and {} more", tools.len() - NAMED));
    }
    detail
}

/// Today's ambient spend across every vault — what the meter reads.
pub fn day_totals(conn: &Connection, now: DateTime<Utc>) -> Result<Day, String> {
    budget::ensure_day(conn, now)
}

/// Set up a vault and one pending item, then dispatch — the shared body of
/// the dispatch kill-point tests, which run it in a child process with a
/// crash point armed. Exposed (test-only) rather than duplicated because the
/// parent has to build the identical fixture to assert against.
#[cfg(test)]
pub(crate) fn crash_fixture(dir: &std::path::Path) -> (Connection, String) {
    let conn = crate::runtime::open(dir).unwrap();
    let vault = crate::runtime::scope::register(&conn, dir).unwrap();
    budget::append_version(
        &conn,
        &budget::Settings {
            ceilings: budget::shipped_defaults().unwrap(),
            timezone_id: "UTC".into(),
        },
        DateTime::parse_from_rfc3339("2026-08-09T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .unwrap();
    crate::runtime::scheduler::put(
        &conn,
        &vault,
        "store",
        &crate::runtime::scheduler::Row {
            item_key: "a.md".to_string(),
            source_id: None,
            content_hash: "a".repeat(64),
            snapshot: crate::runtime::normalize::snapshot(
                &crate::vault::entry::Entry::empty_for_test("a.md"),
            ),
            event_cursor: None,
            route: None,
            state: SchedulerState::Pending,
        },
    )
    .unwrap();
    (conn, vault)
}

/// [`crash_fixture`], plus one pending event wake of `process:scout`, whose
/// id it answers — the shared body of the woken kill-point tests.
#[cfg(test)]
pub(crate) fn crash_wake_fixture(dir: &std::path::Path) -> (Connection, String, String) {
    let (conn, vault) = crash_fixture(dir);
    let offer = wakes::WakeOffer {
        agent: "process:scout".into(),
        path: "records/a.md".into(),
        hash: "a".repeat(64),
        event: "changed".into(),
        wake_key: "a".repeat(64),
        trigger: "1".repeat(16),
        cause: super::cause::CauseRequest {
            kind: "event".into(),
            subject: Some("records/a.md".into()),
            ..Default::default()
        },
    };
    tests::seed_run(&conn, &vault, "wake-parent", None, 0);
    wakes::admit_with_writers(
        &conn,
        &vault,
        &[offer],
        &[super::write_log::EventWriter::Run {
            actor: "claude-code".into(),
            run_id: "wake-parent".into(),
        }],
        DateTime::parse_from_rfc3339("2026-08-09T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .unwrap();
    let wake: String = conn
        .query_row("SELECT wake_id FROM agent_wakes", [], |r| r.get(0))
        .unwrap();
    (conn, vault, wake)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::budget::Settings;
    use crate::runtime::normalize;
    use crate::vault::entry::Entry;
    use crate::vault::testutil;

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn fixture(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = crate::runtime::open(&dir).unwrap();
        let vault = crate::runtime::scope::register(&conn, &dir).unwrap();
        budget::append_version(
            &conn,
            &Settings {
                ceilings: budget::shipped_defaults().unwrap(),
                timezone_id: "UTC".into(),
            },
            at("2026-08-09T00:30:00Z"),
        )
        .unwrap();
        (dir, conn, vault)
    }

    fn seed_item(conn: &Connection, vault: &str, key: &str) {
        crate::runtime::scheduler::put(
            conn,
            vault,
            "store",
            &crate::runtime::scheduler::Row {
                item_key: key.to_string(),
                source_id: None,
                content_hash: "a".repeat(64),
                snapshot: normalize::snapshot(&Entry::empty_for_test(key)),
                event_cursor: None,
                route: None,
                state: SchedulerState::Pending,
            },
        )
        .unwrap();
    }

    fn small() -> Reservation {
        Reservation {
            total_tokens: 5_000,
            output_tokens: 1_000,
        }
    }

    /// The plan a request of `shell` (and, attended or not) is planned by.
    fn plan_of(shell: &str, attended: bool) -> crate::policy::tool_approval::RunApproval {
        let req: crate::agent::AgentRequest = serde_json::from_value(serde_json::json!({
            "message": "", "shell": shell, "attended": attended
        }))
        .unwrap();
        crate::policy::tool_approval::plan_for(&req, attended)
    }

    fn writes_booked(conn: &Connection, run_id: &str) -> i64 {
        conn.query_row(
            "SELECT writes_booked FROM runs WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    // M58.1: a run whose plan lets the CLI's own writers or the shell run,
    // asked or not, books its writes as partial; one with the shell off
    // books them whole.
    #[test]
    fn a_run_whose_plan_lets_the_shell_write_books_partial() {
        let (dir, conn, vault) = fixture("dispatch-writes-booked");
        let now = at("2026-10-14T10:00:00Z");
        for (run, shell, attended, booked) in [
            ("shell-off", "off", true, 1),
            ("shell-ask", "ask", true, 2),
            ("shell-on", "on", false, 2),
        ] {
            begin_attended(
                &conn,
                run,
                Some(&vault),
                Some("store"),
                None,
                None,
                None,
                now,
            )
            .unwrap();
            assert_eq!(writes_booked(&conn, run), 1, "{run}: booked from the start");
            book_partial_writes(&conn, run, &plan_of(shell, attended)).unwrap();
            assert_eq!(writes_booked(&conn, run), booked, "{run}");
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One finished run row, raw — enough for the chain walk, which reads
    /// only identity, parentage and the two token columns.
    pub(super) fn seed_run(
        conn: &Connection,
        vault: &str,
        run_id: &str,
        parent: Option<&str>,
        tokens: i64,
    ) {
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, ended_at, \
             outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
             rejected, parent_run_id) \
             VALUES (?1, ?2, 'store', 'attended', 'agent', '2026-08-09T01:00:00Z', \
                     '2026-08-09T01:01:00Z', 'succeeded', 'exact', ?3, 0, 0, 0, 0, 0, 0, 0, 0, ?4)",
            rusqlite::params![run_id, vault, tokens, parent],
        )
        .unwrap();
    }

    #[test]
    fn a_spent_chain_refuses_its_next_hop_and_names_the_root() {
        let (dir, conn, vault) = fixture("dispatch-chain-ceiling");
        let _lock = status::test_lock();
        status::clear();
        // Root spent past the 20k per-run ambient ceiling; the caller is a
        // CHILD, so the walk has to find the root and sum the whole tree.
        seed_run(&conn, &vault, "root-1", None, 19_000);
        seed_run(&conn, &vault, "child-1", Some("root-1"), 2_000);
        let err = refuse_if_chain_spent(&conn, "child-1", at("2026-08-09T02:00:00Z")).unwrap_err();
        assert!(err.contains("root-1"), "{err}");
        assert!(err.contains("21000 tokens"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_chain_and_an_unfinished_caller_both_pass_the_chain_gate() {
        let (dir, conn, vault) = fixture("dispatch-chain-fresh");
        let _lock = status::test_lock();
        status::clear();
        // No row at all — an attended caller mid-run whose row lands only at
        // finish. The gate has nothing to sum and lets the hop through;
        // stated in the fn docs rather than hidden.
        refuse_if_chain_spent(&conn, "never-recorded", at("2026-08-09T02:00:00Z")).unwrap();
        // A chain with real rows under the ceiling passes too.
        seed_run(&conn, &vault, "root-2", None, 1_000);
        seed_run(&conn, &vault, "child-2", Some("root-2"), 1_000);
        refuse_if_chain_spent(&conn, "child-2", at("2026-08-09T02:00:00Z")).unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_claim_reserves_leases_and_claims_in_one_breath() {
        let (dir, conn, vault) = fixture("dispatch-claim");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".to_string()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("a quiet day must dispatch");
        };
        assert_eq!(lease.claimed, vec!["a.md".to_string()]);
        assert_eq!(lease.elapsed_limit_seconds, 600);
        assert_eq!(lease.lease_expires_at, "2026-08-09T10:20:00.000Z");

        let day = budget::read_day(&conn, &lease.window_start_utc).unwrap();
        assert_eq!(day.reserved_total_tokens, 5_000);
        assert_eq!(day.reserved_output_tokens, 1_000);
        assert_eq!(day.ambient_runs_started, 1);
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Claimed
        );
        let leases: i64 = conn
            .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leases, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn global_ambient_concurrency_never_exceeds_the_configured_ceiling() {
        // Two vaults, one subscription, and — at the SHIPPED default of one —
        // one background slot. The second dispatch is refused by the gate
        // rather than by luck, and this is the test that used to be called
        // `..._never_exceeds_one`: converted, not deleted, because "today's
        // behaviour is the default behaviour" is a claim that needs a test.
        let (dir, conn, vault_a) = fixture("dispatch-ceiling-default");
        let other = testutil::temp_vault("dispatch-ceiling-default-b");
        let vault_b = crate::runtime::scope::register(&conn, &other).unwrap();
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault_a, "a.md");
        seed_item(&conn, &vault_b, "b.md");
        let now = at("2026-08-09T10:00:00Z");

        assert!(matches!(
            claim(
                &conn,
                &vault_a,
                "store",
                "filed",
                small(),
                &["a.md".into()],
                None,
                None,
                now
            )
            .unwrap(),
            Dispatched::Started(_)
        ));
        let second = claim(
            &conn,
            &vault_b,
            "store",
            "filed",
            small(),
            &["b.md".into()],
            None,
            None,
            now,
        )
        .unwrap();
        assert_eq!(second, Dispatched::Deferred(vec![GateReason::AmbientBusy]));
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault_b, "store", "b.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending,
            "a deferred dispatch claims nothing"
        );

        // Raise the ceiling and the SAME refusal becomes a grant — which is
        // the whole of M33b.1: the number moved out of the primary key.
        crate::runtime::settings::set_ambient_concurrency(&conn, 2).unwrap();
        assert!(matches!(
            claim(
                &conn,
                &vault_b,
                "store",
                "filed",
                small(),
                &["b.md".into()],
                None,
                None,
                now
            )
            .unwrap(),
            Dispatched::Started(_)
        ));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn at_a_ceiling_of_two_the_second_lease_is_granted_and_the_third_is_refused() {
        // The ceiling is a number, so N is a real question and not a rewording
        // of "one". Three claims, one vault: two land, the third is deferred
        // by the gate — and the refusal is the same `ambient_busy` a single
        // run has always been refused with, because it is the same rule.
        let (dir, conn, vault) = fixture("dispatch-ceiling-two");
        let _lock = status::test_lock();
        status::clear();
        for key in ["a.md", "b.md", "c.md"] {
            seed_item(&conn, &vault, key);
        }
        crate::runtime::settings::set_ambient_concurrency(&conn, 2).unwrap();
        let now = at("2026-08-09T10:00:00Z");

        for key in ["a.md", "b.md"] {
            assert!(
                matches!(
                    claim(
                        &conn,
                        &vault,
                        "store",
                        "filed",
                        small(),
                        &[key.into()],
                        None,
                        None,
                        now
                    )
                    .unwrap(),
                    Dispatched::Started(_)
                ),
                "{key} fits under a ceiling of two"
            );
        }
        assert_eq!(
            claim(
                &conn,
                &vault,
                "store",
                "filed",
                small(),
                &["c.md".into()],
                None,
                None,
                now
            )
            .unwrap(),
            Dispatched::Deferred(vec![GateReason::AmbientBusy]),
            "the third is refused BY THE GATE — it does not start and then lose a race"
        );

        let leases: i64 = conn
            .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leases, 2, "exactly the ceiling, never the ceiling plus one");
        let day = budget::read_day(&conn, "2026-08-09T00:00:00.000Z").unwrap();
        assert_eq!(
            day.reserved_total_tokens,
            2 * 5_000,
            "each lease reserves its own tokens; the day owes both"
        );
        assert_eq!(day.ambient_runs_started, 2);
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "c.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending,
            "a deferred dispatch claims nothing, at any ceiling"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_paused_agent_is_refused_by_the_gate_and_claims_nothing() {
        // M33b.5, spec §6: if a paused agent can still be dispatched, the
        // pause is a lie. This is the AMBIENT path — every background run in
        // the app comes through `claim`, so refusing here refuses ingest,
        // maintenance and assembly at once — and the refusal is the gate's,
        // in the same transaction as every other one, so a deferred agent
        // claims no item, takes no lease and reserves no tokens.
        let (dir, conn, vault) = fixture("dispatch-agent-paused");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        seed_item(&conn, &vault, "b.md");
        crate::runtime::settings::set_agent_paused(&conn, &vault, "process:digest", true).unwrap();
        let now = at("2026-08-09T10:00:00Z");

        let refused = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            Some("process:digest"),
            None,
            now,
        )
        .unwrap();
        assert_eq!(refused, Dispatched::Deferred(vec![GateReason::AgentPaused]));
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending,
            "a deferred dispatch claims nothing"
        );
        let day = budget::read_day(&conn, "2026-08-09T00:00:00.000Z").unwrap();
        assert_eq!(day.reserved_total_tokens, 0, "and reserves nothing");
        assert_eq!(day.ambient_runs_started, 0);
        let leases: i64 = conn
            .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            leases, 0,
            "and takes no lease the ceiling would have to hold"
        );

        // Nobody ELSE is paused: the pause is about one colleague, and a
        // fleet-wide stop is a different control with a different sentence.
        assert!(matches!(
            claim(
                &conn,
                &vault,
                "store",
                "filed",
                small(),
                &["b.md".into()],
                Some("process:scout"),
                None,
                now
            )
            .unwrap(),
            Dispatched::Started(_)
        ));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resuming_one_agent_under_the_global_pause_still_starts_nothing() {
        // The two pauses are collected separately and either is enough. A
        // person who resumed one agent while everything is stopped has not
        // started it, and the deferral says which control is holding it.
        let (dir, conn, vault) = fixture("dispatch-agent-resume-under-global");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        crate::runtime::settings::set_global_pause(&conn, true).unwrap();
        crate::runtime::settings::set_agent_paused(&conn, &vault, "process:digest", true).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let call = |conn: &Connection| {
            claim(
                conn,
                &vault,
                "store",
                "filed",
                small(),
                &["a.md".into()],
                Some("process:digest"),
                None,
                now,
            )
            .unwrap()
        };

        assert_eq!(
            call(&conn),
            Dispatched::Deferred(vec![GateReason::AgentPaused, GateReason::GlobalPause]),
            "both are true and both are named"
        );

        crate::runtime::settings::set_agent_paused(&conn, &vault, "process:digest", false).unwrap();
        assert_eq!(
            call(&conn),
            Dispatched::Deferred(vec![GateReason::GlobalPause]),
            "resuming the agent did not start it — the global pause still wins"
        );

        crate::runtime::settings::set_global_pause(&conn, false).unwrap();
        assert!(
            matches!(call(&conn), Dispatched::Started(_)),
            "and only with both released does it run"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_lease_does_not_count_toward_the_ceiling() {
        // The reasoning is v3's, unchanged: an expired lease is the
        // crash-recovery path, and counting it as busy would wedge ambient
        // work forever after one kill. What changed is the OUTCOME — under
        // the singleton primary key this claim rolled back with an error,
        // because the stale row still owned the only key. Now it dispatches,
        // and the stale run is still recoverable on its own row.
        let (dir, conn, vault) = fixture("dispatch-ceiling-expired");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        seed_item(&conn, &vault, "b.md");
        let Dispatched::Started(stale) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap() else {
            panic!("the first claim must start");
        };
        assert_eq!(stale.lease_expires_at, "2026-08-09T10:20:00.000Z");

        // Nothing finalized it and nothing swept it. At the DEFAULT ceiling of
        // one, the next claim still proceeds.
        assert!(matches!(
            claim(
                &conn,
                &vault,
                "store",
                "filed",
                small(),
                &["b.md".into()],
                None,
                None,
                at("2026-08-09T10:21:00Z"),
            )
            .unwrap(),
            Dispatched::Started(_)
        ));
        let leases: i64 = conn
            .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leases, 2, "the stale row survives — it is the sweep's job");

        // And the abandoned run's accounting is still owed and still
        // recoverable: the count did not free it, the sweep does.
        assert_eq!(
            recover_expired_leases(&conn, at("2026-08-09T10:21:00Z")).unwrap(),
            1,
            "exactly the stale one — the live lease is not swept"
        );
        let day = budget::read_day(&conn, "2026-08-09T00:00:00.000Z").unwrap();
        assert!(
            !day.accounting_exact,
            "the abandoned run's spend is unknown, not zero"
        );
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending,
            "and its work came back"
        );
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_unknown_usage_path_is_unchanged_with_several_leases_held() {
        // The invariant M33b.1 had to preserve verbatim: missing usage never
        // becomes zero. One of two concurrent runs comes back with nothing to
        // report — its work requeues, the DAY is marked unknown, ambient is
        // paused — and the sibling lease is untouched, because accounting is
        // per run row and always was.
        let (dir, conn, vault) = fixture("dispatch-ceiling-unknown");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        seed_item(&conn, &vault, "b.md");
        crate::runtime::settings::set_ambient_concurrency(&conn, 2).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(first) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("the first claim must start");
        };
        let Dispatched::Started(second) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["b.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("the second claim must start");
        };

        finalize(
            &conn,
            &first.run_id,
            RunOutcome::AbandonedUsageUnknown,
            None,
            None,
            ItemOutcome::Requeue,
            at("2026-08-09T10:05:00Z"),
        )
        .unwrap();

        let day = budget::read_day(&conn, &first.window_start_utc).unwrap();
        assert!(
            !day.accounting_exact,
            "a day that lost one run's spend is not a day with budget left"
        );
        assert!(!status::ambient_allowed(), "and ambient work is paused");
        assert_eq!(
            day.reserved_total_tokens, 5_000,
            "only the abandoned run's reservation was released; the live one still owes"
        );
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending,
            "the abandoned run's work requeued"
        );
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "b.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Claimed,
            "and the sibling run still owns its own"
        );
        let held: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT run_id FROM ambient_dispatch ORDER BY run_id")
                .unwrap();
            let rows = statement
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            rows
        };
        assert_eq!(
            held,
            vec![second.run_id.clone()],
            "one lease released, one still held — the DELETE is per run"
        );
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalization_records_exact_usage_and_releases_everything() {
        let (dir, conn, vault) = fixture("dispatch-finalize");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            Some(Usage {
                input_tokens: 4,
                output_tokens: 271,
                cache_read: 1_000,
                cache_write: 100,
            }),
            None,
            ItemOutcome::Consume,
            at("2026-08-09T10:05:00Z"),
        )
        .unwrap();

        let day = budget::read_day(&conn, &lease.window_start_utc).unwrap();
        assert_eq!(day.reserved_total_tokens, 0, "the reservation is released");
        assert_eq!(day.reserved_output_tokens, 0);
        assert_eq!(day.ambient_tokens_used, 4 + 271 + 1_000 + 100);
        assert_eq!(day.ambient_output_tokens, 271);
        assert!(day.accounting_exact);
        assert_eq!(day.ambient_runs_started, 1, "the run still counts");

        let leases: i64 = conn
            .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leases, 0, "the lease is released");
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Consumed
        );
        let failures: i64 = conn
            .query_row(
                "SELECT consecutive_failures FROM ambient_gate_state",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(failures, 0, "success resets the lane counter");
        assert!(status::ambient_allowed());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_facts_land_on_the_run_and_absent_facts_write_nothing() {
        let (dir, conn, vault) = fixture("dispatch-facts");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        seed_item(&conn, &vault, "b.md");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap() else {
            panic!("dispatch");
        };
        let facts = RunFacts {
            model_id: Some("claude-opus-5".into()),
            stop_reason: Some("end_turn".into()),
            total_cost_micros: Some(41_200),
            permission_denials: Some(2),
            denied_tools: Some(vec!["Bash".into(), "mcp__gmail__trash_thread".into()]),
            ..RunFacts::default()
        };
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            Some(Usage::default()),
            Some(&facts),
            ItemOutcome::Consume,
            at("2026-08-09T10:05:00Z"),
        )
        .unwrap();
        let (model, cost, turns): (Option<String>, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT model_id, total_cost_micros, num_turns FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(model.as_deref(), Some("claude-opus-5"));
        assert_eq!(cost, Some(41_200));
        assert_eq!(turns, None, "an absent field is NULL, never zero");
        let (routed, detail): (i64, String) = conn
            .query_row(
                "SELECT count(*), coalesce(max(detail), '') FROM operational_log \
                 WHERE surface = 'agent.permission' AND run_id = ?1",
                [&lease.run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(routed, 1, "a non-empty denial array is one operational row");
        assert_eq!(
            detail, "the CLI denied 2 call(s) this run: Bash, mcp__gmail__trash_thread",
            "the row names the denied tools (M54.9)"
        );

        // No facts at all: every fact column stays NULL and nothing routes.
        let Dispatched::Started(second) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["b.md".into()],
            None,
            None,
            at("2026-08-09T11:00:00Z"),
        )
        .unwrap() else {
            panic!("second dispatch");
        };
        finalize(
            &conn,
            &second.run_id,
            RunOutcome::Succeeded,
            Some(Usage::default()),
            None,
            ItemOutcome::Consume,
            at("2026-08-09T11:01:00Z"),
        )
        .unwrap();
        let (model, routed): (Option<String>, i64) = conn
            .query_row(
                "SELECT model_id, (SELECT count(*) FROM operational_log \
                 WHERE surface = 'agent.permission' AND run_id = ?1) \
                 FROM runs WHERE run_id = ?1",
                [&second.run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(model, None, "absent facts update nothing");
        assert_eq!(routed, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_denial_detail_names_twenty_tools_then_counts_the_rest() {
        assert_eq!(denial_detail(3, &[]), "the CLI denied 3 call(s) this run");
        let tools: Vec<String> = (0..23).map(|i| format!("mcp__toy__t{i:02}")).collect();
        let detail = denial_detail(40, &tools);
        assert!(
            detail.starts_with("the CLI denied 40 call(s) this run: mcp__toy__t00, "),
            "{detail}"
        );
        assert!(detail.ends_with("mcp__toy__t19 and 3 more"), "{detail}");
        assert!(!detail.contains("t20"), "{detail}");
        // A server picks its own tool names: no control character reaches
        // the row, and no name runs past 120 characters.
        let odd = vec![format!("mcp__toy__a\u{7}b{}", "x".repeat(200))];
        let detail = denial_detail(1, &odd);
        assert!(!detail.contains('\u{7}'));
        assert_eq!(
            detail.len(),
            "the CLI denied 1 call(s) this run: ".len() + 120
        );
    }

    #[test]
    fn an_absurd_cost_degrades_to_null_and_never_fails_the_finalize() {
        // 1e300 USD is finite and non-negative, so it survives the parse
        // filter as a saturated u64 — and a wrapped `as i64` cast would go
        // negative, trip the CHECK, and roll back the WHOLE finalize, losing
        // the run's real token counts over a number the wire got wrong.
        let (dir, conn, vault) = fixture("dispatch-absurd-cost");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap() else {
            panic!("dispatch");
        };
        let facts =
            RunFacts::parse(&serde_json::json!({ "type": "result", "total_cost_usd": 1e300 }))
                .unwrap();
        assert!(facts.total_cost_micros.is_some(), "the filter passes it");
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            Some(Usage {
                output_tokens: 271,
                ..Usage::default()
            }),
            Some(&facts),
            ItemOutcome::Consume,
            at("2026-08-09T10:05:00Z"),
        )
        .expect("measurement must never fail the finalize");
        let (outcome, cost, output): (String, Option<i64>, i64) = conn
            .query_row(
                "SELECT outcome, total_cost_micros, output_tokens FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(outcome, "succeeded");
        assert_eq!(cost, None, "the overflowing field degrades to NULL alone");
        assert_eq!(output, 271, "and the real token counts are intact");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_requeues_its_work_and_counts_against_the_lane() {
        let (dir, conn, vault) = fixture("dispatch-failure");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let mut now = at("2026-08-09T10:00:00Z");
        for expected in 1..=3 {
            let Dispatched::Started(lease) = claim(
                &conn,
                &vault,
                "store",
                "filed",
                small(),
                &["a.md".into()],
                None,
                None,
                now,
            )
            .unwrap() else {
                panic!("dispatch {expected}");
            };
            now += Duration::minutes(30);
            finalize(
                &conn,
                &lease.run_id,
                RunOutcome::Failed,
                Some(Usage {
                    output_tokens: 10,
                    ..Usage::default()
                }),
                None,
                ItemOutcome::Requeue,
                now,
            )
            .unwrap();
            let failures: i64 = conn
                .query_row(
                    "SELECT consecutive_failures FROM ambient_gate_state",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(failures, expected);
            assert_eq!(
                crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                    .unwrap()
                    .unwrap()
                    .state,
                SchedulerState::Pending,
                "failed work goes back in the queue, visibly"
            );
        }
        let fourth = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap();
        assert_eq!(
            fourth,
            Dispatched::Deferred(vec![GateReason::ConsecutiveFailures]),
            "a lane that fails three times stops asking"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_usage_is_unknown_and_pauses_rather_than_costing_nothing() {
        let (dir, conn, vault) = fixture("dispatch-unknown");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::AbandonedUsageUnknown,
            None,
            None,
            ItemOutcome::Requeue,
            at("2026-08-09T10:30:00Z"),
        )
        .unwrap();

        let day = budget::read_day(&conn, &lease.window_start_utc).unwrap();
        assert!(!day.accounting_exact, "unknown is not zero");
        assert_eq!(day.ambient_tokens_used, 0);
        assert!(!status::ambient_allowed(), "unknown spend pauses ambient");
        let usage_state: String = conn
            .query_row(
                "SELECT usage_state FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(usage_state, "unknown");
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_lease_frees_its_item_and_never_charges_zero() {
        let (dir, conn, vault) = fixture("dispatch-lease");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };

        assert_eq!(recover_expired_leases(&conn, now).unwrap(), 0, "not yet");
        let recovered = recover_expired_leases(&conn, at("2026-08-09T11:00:00Z")).unwrap();
        assert_eq!(recovered, 1);
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending
        );
        let (outcome, usage_state): (String, String) = conn
            .query_row(
                "SELECT outcome, usage_state FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(outcome, "abandoned_usage_unknown");
        assert_eq!(usage_state, "unknown");
        assert!(
            !budget::read_day(&conn, &lease.window_start_utc)
                .unwrap()
                .accounting_exact
        );
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalizing_twice_is_refused_rather_than_double_counted() {
        let (dir, conn, vault) = fixture("dispatch-twice");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        let usage = Some(Usage {
            output_tokens: 100,
            ..Usage::default()
        });
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            usage,
            None,
            ItemOutcome::Consume,
            now,
        )
        .unwrap();
        let err = finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            usage,
            None,
            ItemOutcome::Consume,
            now,
        )
        .unwrap_err();
        assert!(err.contains("already finalized"), "{err}");
        assert_eq!(
            budget::read_day(&conn, &lease.window_start_utc)
                .unwrap()
                .ambient_tokens_used,
            100
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_quota_death_requeues_backs_off_and_degrades_the_runtime_in_one_breath() {
        // The acceptance row, end to end: one finalization transaction
        // returns the claim, releases the reservation, sets the window
        // backoff, and degrades runtime health — and the NEXT dispatch is
        // refused by the backoff it just wrote.
        let (dir, conn, vault) = fixture("dispatch-quota");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::QuotaFailed,
            Some(Usage {
                output_tokens: 17,
                ..Usage::default()
            }),
            None,
            ItemOutcome::Requeue,
            at("2026-08-09T10:02:00Z"),
        )
        .unwrap();

        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending,
            "a quota death does not consume the work it could not do"
        );
        let day = budget::read_day(&conn, &lease.window_start_utc).unwrap();
        assert_eq!(day.reserved_total_tokens, 0);
        assert_eq!(
            day.ambient_tokens_used, 17,
            "the tokens it DID spend before dying are counted"
        );
        let (state, _, _) =
            crate::runtime::health::runtime_health(&conn, crate::runtime::health::COMPONENT_CLI)
                .unwrap()
                .unwrap();
        assert_eq!(state, crate::runtime::health::RuntimeState::Degraded);

        let next = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at("2026-08-09T10:05:00Z"),
        )
        .unwrap();
        assert_eq!(next, Dispatched::Deferred(vec![GateReason::QuotaBackoff]));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A run that died of quota at 2026-08-09T10:00:00Z, finalized with
    /// `reset` as the reset Claude Code reported (M56.14).
    fn quota_death_reporting(
        label: &str,
        reset: Option<&str>,
    ) -> (std::path::PathBuf, Connection, String) {
        let (dir, conn, vault) = fixture(label);
        seed_item(&conn, &vault, "a.md");
        let now = at("2026-08-09T10:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        finalize_until_reset(
            &conn,
            &lease.run_id,
            RunOutcome::QuotaFailed,
            Some(Usage::default()),
            None,
            ItemOutcome::Requeue,
            reset.map(at),
            now,
        )
        .unwrap();
        (dir, conn, vault)
    }

    /// Is a dispatch at `when` refused for quota? One that starts holds the
    /// item, so a probe that may start goes last.
    fn backed_off_at(conn: &Connection, vault: &str, when: &str) -> bool {
        match claim(
            conn,
            vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at(when),
        )
        .unwrap()
        {
            Dispatched::Started(_) => false,
            Dispatched::Deferred(reasons) => reasons.contains(&GateReason::QuotaBackoff),
            other => panic!("unexpected dispatch {other:?}"),
        }
    }

    #[test]
    fn a_quota_death_with_a_reported_reset_backs_off_until_that_instant() {
        // A weekly limit that resets three days out: five hours later the
        // runtime still waits, and it waits exactly until the reset.
        let _lock = status::test_lock();
        status::clear();
        let (dir, conn, vault) =
            quota_death_reporting("dispatch-quota-reset", Some("2026-08-12T10:00:00Z"));
        assert!(backed_off_at(&conn, &vault, "2026-08-09T15:05:00Z"));
        assert!(backed_off_at(&conn, &vault, "2026-08-12T09:59:59Z"));
        assert!(!backed_off_at(&conn, &vault, "2026-08-12T10:00:01Z"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_quota_death_without_a_reset_keeps_the_five_hour_window() {
        let _lock = status::test_lock();
        status::clear();
        let (dir, conn, vault) = quota_death_reporting("dispatch-quota-window", None);
        assert!(backed_off_at(&conn, &vault, "2026-08-09T14:59:00Z"));
        assert!(!backed_off_at(&conn, &vault, "2026-08-09T15:01:00Z"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_past_or_absurd_reported_reset_is_clamped() {
        let _lock = status::test_lock();
        status::clear();
        // A reset already past would end the pause at once: it is no reset,
        // and the window holds.
        let (dir, conn, vault) =
            quota_death_reporting("dispatch-quota-past", Some("2026-08-01T00:00:00Z"));
        assert!(backed_off_at(&conn, &vault, "2026-08-09T14:59:00Z"));
        assert!(!backed_off_at(&conn, &vault, "2026-08-09T15:01:00Z"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        // A reset years out parks the runtime for the ceiling, not for good.
        let (dir, conn, vault) =
            quota_death_reporting("dispatch-quota-far", Some("2031-01-01T00:00:00Z"));
        assert!(backed_off_at(&conn, &vault, "2026-08-17T09:59:00Z"));
        assert!(!backed_off_at(&conn, &vault, "2026-08-17T10:01:00Z"));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_successful_run_says_the_runtime_is_working_again() {
        let (dir, conn, vault) = fixture("dispatch-recovered");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        crate::runtime::health::set_runtime_health(
            &conn,
            crate::runtime::health::COMPONENT_CLI,
            crate::runtime::health::RuntimeState::Degraded,
            None,
            at("2026-08-09T09:00:00Z"),
        )
        .unwrap();
        let now = at("2026-08-09T16:00:00Z");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap() else {
            panic!("dispatch");
        };
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            Some(Usage::default()),
            None,
            ItemOutcome::Consume,
            now,
        )
        .unwrap();
        let (state, _, _) =
            crate::runtime::health::runtime_health(&conn, crate::runtime::health::COMPONENT_CLI)
                .unwrap()
                .unwrap();
        assert_eq!(state, crate::runtime::health::RuntimeState::Healthy);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attended_work_is_metered_and_never_touches_the_budget() {
        let (dir, conn, vault) = fixture("dispatch-attended");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        // Fill the day completely.
        let window = budget::ensure_day(&conn, now).unwrap().window_start_utc;
        conn.execute(
            "UPDATE budget_days SET ambient_tokens_used = 200000, ambient_runs_started = 20 \
             WHERE window_start_utc = ?1",
            [&window],
        )
        .unwrap();
        budget::refresh_ceiling_state(&conn, &window).unwrap();

        meter_attended(
            &conn,
            "chat-1",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            Some(Usage {
                input_tokens: 9,
                output_tokens: 900,
                cache_read: 0,
                cache_write: 0,
            }),
            None,
            None,
            None,
            None,
            now,
            at("2026-08-09T10:01:00Z"),
        )
        .unwrap();

        let day = budget::read_day(&conn, &window).unwrap();
        assert_eq!(
            day.ambient_tokens_used, 200_000,
            "an attended run debits no ambient ceiling"
        );
        let (mode, output): (String, i64) = conn
            .query_row(
                "SELECT mode, output_tokens FROM runs WHERE run_id = 'chat-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(mode, "attended");
        assert_eq!(output, 900, "and is still metered");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_records_the_actor_its_spawn_site_named_and_absent_stays_absent() {
        // M33.1 — attribution is recorded at INSERT and never backfilled.
        // Both row-creating paths carry it: the ambient claim, where the
        // construct that took the lease owns the row, and the attended
        // meter, where the request's actor rides through. A spawn site that
        // named nobody leaves NULL, which the fleet reads as
        // "unattributed" — a guessed attribution in the one table whose
        // whole job is honesty is worse than an admitted gap.
        let (dir, conn, vault) = fixture("dispatch-actor");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");

        seed_item(&conn, &vault, "a.md");
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".to_string()],
            Some(crate::ingest::driver::ACTOR),
            None,
            now,
        )
        .unwrap() else {
            panic!("a quiet day must dispatch");
        };

        // The attended path takes its actor as an argument the caller mints:
        // `process:<slug>` for an agent record's run, absent for bare chat.
        meter_attended(
            &conn,
            "chat-1",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            Some("process:weekly-digest"),
            None,
            None,
            now,
            at("2026-08-09T10:01:00Z"),
        )
        .unwrap();
        meter_attended(
            &conn,
            "chat-2",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            None,
            None,
            None,
            now,
            at("2026-08-09T10:02:00Z"),
        )
        .unwrap();

        let actor_of = |run_id: &str| -> Option<String> {
            conn.query_row("SELECT actor FROM runs WHERE run_id = ?1", [run_id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(
            actor_of(&lease.run_id).as_deref(),
            Some(crate::ingest::driver::ACTOR),
            "the construct that claimed the lease owns the run row"
        );
        assert_eq!(
            actor_of("chat-1").as_deref(),
            Some("process:weekly-digest"),
            "an agent record's run is attributed to the record"
        );
        assert_eq!(
            actor_of("chat-2"),
            None,
            "and a run nobody named stays unattributed rather than guessed"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_run_records_the_run_that_started_it_and_a_root_stays_null() {
        // M34.3 — the chain is walkable from the table alone. NULL is a
        // root, and every run before this shipped was one; nothing backfills
        // and nothing guesses, exactly like `actor`.
        let (_dir, conn, vault) = fixture("dispatch-parent");
        let now = at("2026-08-09T10:00:00Z");
        meter_attended(
            &conn,
            "root-1",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            Some("process:librarian"),
            None,
            None,
            now,
            at("2026-08-09T10:01:00Z"),
        )
        .unwrap();
        meter_attended(
            &conn,
            "child-1",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            Some("process:contradiction-hunter"),
            Some("root-1"),
            None,
            now,
            at("2026-08-09T10:02:00Z"),
        )
        .unwrap();
        let parent_of = |run_id: &str| -> Option<String> {
            conn.query_row(
                "SELECT parent_run_id FROM runs WHERE run_id = ?1",
                [run_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(parent_of("root-1"), None, "a root run has no parent");
        assert_eq!(
            parent_of("child-1").as_deref(),
            Some("root-1"),
            "a handed-to run names the run whose tool call started it"
        );
    }

    /// A commit of `applied` applied members and `queued` queued ones.
    fn committed(applied: usize, queued: usize) -> crate::policy::commit::CommitOutcome {
        use crate::policy::submit::SubmitResult;
        let mut results = Vec::new();
        for n in 0..applied {
            results.push(SubmitResult::Applied {
                proposal_id: format!("applied-{n}"),
                resulting_versions: vec![],
            });
        }
        for n in 0..queued {
            results.push(SubmitResult::Queued {
                proposal_id: format!("queued-{n}"),
                effective_risk: crate::policy::table::Risk::High,
                escalated_by: vec![],
            });
        }
        crate::policy::commit::CommitOutcome {
            commit_set_id: "set".into(),
            transition: crate::policy::commit::TransitionCode::Apply,
            results,
            batch_id: "batch".into(),
            replayed: false,
            kept: vec![],
            projected: Vec::new(),
        }
    }

    /// (outcome, usage_state, submitted, applied, rejected, counters_booked)
    type Books = (String, String, i64, i64, i64, i64);

    fn books(conn: &Connection, run_id: &str) -> Books {
        conn.query_row(
            "SELECT outcome, usage_state, proposals_submitted, applied, rejected, \
             counters_booked FROM runs WHERE run_id = ?1",
            [run_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .unwrap()
    }

    // M49.9 (K25): the bug this pins. An attended run had no row while it
    // ran, so `book` matched nothing and the finish INSERTed 0/0/0 stamped
    // booked — "0 applied" for a run that applied. The row opens at spawn
    // now, and the finish closes it without touching what was booked.
    #[test]
    fn book_then_meter_attended_keeps_the_booked_counts() {
        let _sink = crate::runtime::sink::test_lock();
        let (dir, conn, vault) = fixture("dispatch-attended-booked");
        let now = at("2026-09-27T10:00:00Z");
        begin_attended(
            &conn,
            "chat-booked",
            Some(&vault),
            Some("store"),
            Some("process:librarian"),
            Some("root-0"),
            None,
            now,
        )
        .unwrap();
        assert_eq!(
            books(&conn, "chat-booked"),
            ("running".into(), "pending".into(), 0, 0, 0, 1),
            "open while the run is, and booked from the start"
        );

        crate::runtime::sink::arm(&dir).unwrap();
        committed(2, 1).book("chat-booked");
        crate::runtime::sink::disarm();

        meter_attended(
            &conn,
            "chat-booked",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            Some(Usage {
                input_tokens: 3,
                output_tokens: 40,
                cache_read: 0,
                cache_write: 0,
            }),
            None,
            Some("process:librarian"),
            Some("root-0"),
            None,
            now,
            at("2026-09-27T10:05:00Z"),
        )
        .unwrap();
        assert_eq!(
            books(&conn, "chat-booked"),
            ("succeeded".into(), "exact".into(), 3, 2, 0, 1),
            "the finish lands usage and outcome and leaves the counts it did not count"
        );
        let (ended, output, parent): (Option<String>, i64, Option<String>) = conn
            .query_row(
                "SELECT ended_at, output_tokens, parent_run_id FROM runs \
                 WHERE run_id = 'chat-booked'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(ended.as_deref(), Some("2026-09-27T10:05:00.000Z"));
        assert_eq!(output, 40);
        assert_eq!(parent.as_deref(), Some("root-0"));

        let twice = meter_attended(
            &conn,
            "chat-booked",
            Some(&vault),
            Some("store"),
            RunOutcome::Failed,
            None,
            None,
            None,
            None,
            None,
            now,
            now,
        );
        assert!(twice.is_err(), "a finished run is never closed again");
        assert_eq!(books(&conn, "chat-booked").0, "succeeded");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // M49.9: the ambient lease sweep's attended twin. A process that died
    // mid-run leaves its row `running`; the next process closes what began
    // before it did as unknown — never zero — keeps the bookings, and never
    // touches its own runs or the day's budget.
    #[test]
    fn an_attended_row_a_dead_process_left_running_closes_unknown_and_keeps_its_books() {
        let _sink = crate::runtime::sink::test_lock();
        let _lock = status::test_lock();
        status::clear();
        let (dir, conn, vault) = fixture("dispatch-attended-orphan");
        let before = at("2026-09-27T09:00:00Z");
        let started = at("2026-09-27T10:00:00Z");
        let now = at("2026-09-27T10:01:00Z");
        begin_attended(
            &conn,
            "orphan",
            Some(&vault),
            Some("store"),
            None,
            None,
            None,
            before,
        )
        .unwrap();
        begin_attended(
            &conn,
            "mine",
            Some(&vault),
            Some("store"),
            None,
            None,
            None,
            now,
        )
        .unwrap();
        crate::runtime::sink::arm(&dir).unwrap();
        committed(1, 0).book("orphan");
        crate::runtime::sink::disarm();

        assert_eq!(recover_orphaned_attended(&conn, started, now).unwrap(), 1);
        assert_eq!(
            books(&conn, "orphan"),
            (
                "abandoned_usage_unknown".into(),
                "unknown".into(),
                1,
                1,
                0,
                1
            ),
            "closed as unknown, with what it booked intact"
        );
        assert_eq!(
            books(&conn, "mine").0,
            "running",
            "this process's run is its own"
        );
        assert_eq!(
            status::current(),
            status::RuntimeStatus::Ready,
            "an attended run holds no budget, so its loss pauses nothing"
        );
        let window = budget::ensure_day(&conn, now).unwrap().window_start_utc;
        assert!(budget::read_day(&conn, &window).unwrap().accounting_exact);
        assert_eq!(
            recover_orphaned_attended(&conn, started, now).unwrap(),
            0,
            "and a second sweep finds nothing"
        );

        // The owner was alive after all (a second process on this app-data):
        // its finish knows better than the sweep did.
        meter_attended(
            &conn,
            "orphan",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            Some(Usage::default()),
            None,
            None,
            None,
            None,
            before,
            now,
        )
        .unwrap();
        assert_eq!(
            books(&conn, "orphan"),
            ("succeeded".into(), "exact".into(), 1, 1, 0, 1)
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_child_that_never_spawned_leaves_no_attended_row() {
        let (dir, conn, vault) = fixture("dispatch-attended-discard");
        let now = at("2026-09-27T10:00:00Z");
        begin_attended(
            &conn,
            "never",
            Some(&vault),
            Some("store"),
            None,
            None,
            None,
            now,
        )
        .unwrap();
        discard_unstarted_attended(&conn, "never").unwrap();
        let count = |run_id: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM runs WHERE run_id = ?1",
                [run_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count("never"), 0, "a run that never started is no run");

        meter_attended(
            &conn,
            "done",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            None,
            None,
            None,
            now,
            now,
        )
        .unwrap();
        discard_unstarted_attended(&conn, "done").unwrap();
        assert_eq!(count("done"), 1, "a finished run is never taken back");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cause_of(conn: &Connection, run_id: &str) -> Option<String> {
        conn.query_row("SELECT cause FROM runs WHERE run_id = ?1", [run_id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn a_claim_writes_its_cause_with_the_row() {
        use crate::runtime::cause::CauseKind;
        let (dir, conn, vault) = fixture("dispatch-cause-claim");
        let _lock = status::test_lock();
        status::clear();
        let cause = RunCause::new(
            CauseKind::Schedule,
            None,
            Some("weekdays 08:30"),
            Some("2026-08-09T08:30:00Z"),
        );
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "scheduled",
            small(),
            &[],
            Some("process:scout"),
            Some(&cause),
            at("2026-08-09T09:15:00Z"),
        )
        .unwrap() else {
            panic!("an empty claim reaches the gate and starts");
        };
        assert_eq!(
            cause_of(&conn, &lease.run_id).as_deref(),
            Some(cause.to_column().as_str())
        );
        // And with no cause, the row holds NULL: "why not recorded". The
        // first run says what it spent, so the day's accounting stays exact.
        finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            Some(Usage {
                output_tokens: 10,
                ..Usage::default()
            }),
            None,
            ItemOutcome::Consume,
            at("2026-08-09T09:20:00Z"),
        )
        .unwrap();
        let Dispatched::Started(bare) = claim(
            &conn,
            &vault,
            "store",
            "scheduled",
            small(),
            &[],
            None,
            None,
            at("2026-08-09T09:30:00Z"),
        )
        .unwrap() else {
            panic!("expected a lease");
        };
        assert_eq!(cause_of(&conn, &bare.run_id), None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_attended_open_writes_its_cause() {
        use crate::runtime::cause::CauseKind;
        let (dir, conn, vault) = fixture("dispatch-cause-open");
        let attended = RunCause::of(CauseKind::Attended);
        begin_attended(
            &conn,
            "turn",
            Some(&vault),
            Some("store"),
            None,
            None,
            Some(&attended),
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            cause_of(&conn, "turn").as_deref(),
            Some(r#"{"kind":"attended"}"#)
        );
        let handed = RunCause::handoff("process:scout");
        begin_attended(
            &conn,
            "hop",
            Some(&vault),
            Some("store"),
            Some("process:knowledge"),
            Some("turn"),
            Some(&handed),
            at("2026-08-09T10:01:00Z"),
        )
        .unwrap();
        assert_eq!(
            cause_of(&conn, "hop").as_deref(),
            Some(r#"{"kind":"handoff","subject":"process:scout"}"#),
            "a hand-off records its caller"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_meter_fallback_insert_carries_its_cause() {
        use crate::runtime::cause::CauseKind;
        let (dir, conn, vault) = fixture("dispatch-cause-fallback");
        let now = at("2026-08-09T10:00:00Z");
        meter_attended(
            &conn,
            "never-opened",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            None,
            None,
            Some(&RunCause::of(CauseKind::Assembly)),
            now,
            now,
        )
        .unwrap();
        assert_eq!(
            cause_of(&conn, "never-opened").as_deref(),
            Some(r#"{"kind":"assembly"}"#),
            "a row inserted whole at the end carries its cause too"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_finish_never_rewrites_the_cause() {
        use crate::runtime::cause::CauseKind;
        let (dir, conn, vault) = fixture("dispatch-cause-finish");
        let now = at("2026-08-09T10:00:00Z");
        begin_attended(
            &conn,
            "turn",
            Some(&vault),
            Some("store"),
            None,
            None,
            Some(&RunCause::of(CauseKind::Attended)),
            now,
        )
        .unwrap();
        // A finisher that names another cause, or none, changes nothing:
        // why a run started is written once, with its row.
        meter_attended(
            &conn,
            "turn",
            Some(&vault),
            Some("store"),
            RunOutcome::Succeeded,
            None,
            None,
            None,
            None,
            Some(&RunCause::of(CauseKind::Manual)),
            now,
            now,
        )
        .unwrap();
        assert_eq!(
            cause_of(&conn, "turn").as_deref(),
            Some(r#"{"kind":"attended"}"#)
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_cli_session_writes_a_valid_id_and_refuses_a_bad_one() {
        let (dir, conn, vault) = fixture("dispatch-cli-session");
        let now = at("2026-08-09T10:00:00Z");
        begin_attended(
            &conn,
            "turn",
            Some(&vault),
            Some("store"),
            None,
            None,
            None,
            now,
        )
        .unwrap();
        let session = |conn: &Connection| -> Option<String> {
            conn.query_row(
                "SELECT cli_session_id FROM runs WHERE run_id = 'turn'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        record_cli_session(&conn, "turn", "00000000-0000-4000-8000-000000000001").unwrap();
        assert_eq!(
            session(&conn).as_deref(),
            Some("00000000-0000-4000-8000-000000000001")
        );
        for bad in ["../x1234", "--dangerously-skip-permissions", "short"] {
            let refused = record_cli_session(&conn, "turn", bad).unwrap_err();
            assert!(
                refused.contains("not a Claude Code session id"),
                "{refused}"
            );
        }
        assert_eq!(
            session(&conn).as_deref(),
            Some("00000000-0000-4000-8000-000000000001"),
            "a refused id leaves the recorded one standing"
        );
        // The stream's own id wins over whatever the row held.
        record_cli_session(&conn, "turn", "11111111-1111-4111-8111-111111111111").unwrap();
        assert_eq!(
            session(&conn).as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every statement outside a test that inserts a run row lives in this
    /// file, and every one of them names `cause` — a writer added elsewhere,
    /// or one that forgot the column, fails here rather than writing rows
    /// that can never say why they ran (M56.7).
    #[test]
    fn every_production_runs_insert_names_its_cause() {
        fn visit(dir: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path, found);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    found.push(path);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        visit(&root, &mut files);
        assert!(files.len() > 50, "the walk found the tree");
        let mut writers = Vec::new();
        for file in &files {
            let text = std::fs::read_to_string(file).unwrap();
            // Production code is what precedes the file's test module.
            let production = text
                .find("#[cfg(test)]\nmod tests")
                .map_or(text.as_str(), |at| &text[..at]);
            let mut rest = production;
            while let Some(at) = rest.find("INTO runs (") {
                let statement = &rest[at..];
                let columns = &statement[..statement.find(')').unwrap()];
                let name = file.strip_prefix(&root).unwrap().display().to_string();
                writers.push((name, columns.contains("cause")));
                rest = &rest[at + 1..];
            }
        }
        assert_eq!(
            writers,
            [
                ("runtime/dispatch.rs".to_string(), true),
                ("runtime/dispatch.rs".to_string(), true),
                ("runtime/dispatch.rs".to_string(), true),
                ("runtime/dispatch.rs".to_string(), true),
            ],
            "the claim, attended open, client session and meter fallback, each naming cause"
        );
    }

    #[test]
    fn a_gate_refusal_leaves_no_run_no_lease_and_no_claim() {
        let (dir, conn, vault) = fixture("dispatch-deferred");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        crate::runtime::settings::set_global_pause(&conn, true).unwrap();
        let now = at("2026-08-09T10:00:00Z");
        let outcome = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            now,
        )
        .unwrap();
        assert_eq!(outcome, Dispatched::Deferred(vec![GateReason::GlobalPause]));
        for (table, expected) in [
            ("runs", 0),
            ("ambient_dispatch", 0),
            ("ambient_gate_decisions", 1),
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, expected, "{table}");
        }
        assert_eq!(
            crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap()
                .state,
            SchedulerState::Pending
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn work_that_moved_since_the_queue_was_built_is_not_a_refusal() {
        let (dir, conn, vault) = fixture("dispatch-nothing");
        let _lock = status::test_lock();
        status::clear();
        seed_item(&conn, &vault, "a.md");
        crate::runtime::scheduler::move_state(
            &conn,
            &vault,
            "store",
            SchedulerState::Pending,
            SchedulerState::Consumed,
        )
        .unwrap();
        let outcome = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(outcome, Dispatched::NothingToClaim);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- woken claims (M63.1) ------------------------------------------------

    fn event_offer(agent: &str, key: char, trigger: char, subject: &str) -> wakes::WakeOffer {
        wakes::WakeOffer {
            agent: agent.into(),
            path: subject.into(),
            hash: "a".repeat(64),
            event: "changed".into(),
            wake_key: key.to_string().repeat(64),
            trigger: trigger.to_string().repeat(16),
            cause: crate::runtime::cause::CauseRequest {
                kind: "event".into(),
                subject: Some(subject.into()),
                detail: Some("it changes in records/risks".into()),
                due_at: None,
            },
        }
    }

    /// Admit one wake and answer its id.
    fn admit_one(
        conn: &Connection,
        vault: &str,
        offer: wakes::WakeOffer,
        now: DateTime<Utc>,
    ) -> String {
        let key = offer.wake_key.clone();
        wakes::admit(conn, vault, &[offer], now).unwrap();
        conn.query_row(
            "SELECT wake_id FROM agent_wakes WHERE wake_key = ?1 ORDER BY rowid DESC LIMIT 1",
            [key],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// (state, outcome, reason, detail, run_id, not_before, deferred) of one wake.
    type WakeState = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    fn wake_state(conn: &Connection, wake: &str) -> WakeState {
        conn.query_row(
            "SELECT state, outcome, reason, detail, run_id, not_before, deferred \
             FROM agent_wakes WHERE wake_id = ?1",
            [wake],
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
        .unwrap()
    }

    fn woken(
        conn: &Connection,
        vault: &str,
        actor: &str,
        claim: &str,
        coalesce: &[&str],
        now: DateTime<Utc>,
    ) -> Result<Woken, String> {
        claim_woken(
            conn,
            vault,
            "store",
            "agent",
            small(),
            actor,
            &WakeRequest {
                claim: claim.into(),
                coalesce: coalesce.iter().map(|c| c.to_string()).collect(),
            },
            now,
        )
    }

    fn done(conn: &Connection, run_id: &str, outcome: RunOutcome, now: DateTime<Utc>) {
        finalize(
            conn,
            run_id,
            outcome,
            Some(Usage::default()),
            None,
            ItemOutcome::Consume,
            now,
        )
        .unwrap();
    }

    #[test]
    fn a_woken_claim_starts_the_wake_and_books_its_cause() {
        let (dir, conn, vault) = fixture("woken-start");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let wake = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "records/risks/r.md"),
            now,
        );
        let Woken::Started {
            lease, cause, also, ..
        } = woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap()
        else {
            panic!("not started");
        };
        assert!(lease.claimed.is_empty(), "a woken run claims no items");
        assert!(also.is_empty());
        let stored = r#"{"kind":"event","subject":"records/risks/r.md","detail":"it changes in records/risks"}"#;
        assert_eq!(cause.map(|c| c.to_column()).as_deref(), Some(stored));
        assert_eq!(
            cause_of(&conn, &lease.run_id).as_deref(),
            Some(stored),
            "the wake's cause, on the row"
        );
        let actor: Option<String> = conn
            .query_row(
                "SELECT actor FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(actor.as_deref(), Some("process:scout"));
        let state = wake_state(&conn, &wake);
        assert_eq!(state.0, "started");
        assert_eq!(state.4.as_deref(), Some(lease.run_id.as_str()));
        let leases: i64 = conn
            .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leases, 1, "the wake starts with its lease");
        // Claimed by somebody else: an error, and nothing written.
        let other = admit_one(
            &conn,
            &vault,
            event_offer("process:other", 'b', '1', "x"),
            now,
        );
        assert!(woken(&conn, &vault, "process:scout", &other, &[], now).is_err());
        assert_eq!(wake_state(&conn, &other).0, "pending");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deferred_woken_claim_keeps_the_wake_pending_until_not_before() {
        let (dir, conn, vault) = fixture("woken-deferred");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let wake = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "a"),
            now,
        );
        crate::runtime::settings::set_global_pause(&conn, true).unwrap();
        assert_eq!(
            woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap(),
            Woken::Deferred(vec!["global_pause".into()])
        );
        let state = wake_state(&conn, &wake);
        assert_eq!(state.0, "pending", "the global pause only defers");
        assert_eq!(
            state.5.as_deref(),
            Some("2026-08-09T10:10:00.000Z"),
            "+600 s"
        );
        assert_eq!(state.6.as_deref(), Some("global_pause"));
        let ro = crate::runtime::ReadOnly::open(&dir).unwrap();
        let listed = wakes::pending(&ro, &vault, now).unwrap();
        assert_eq!(
            listed[0].not_before.as_deref(),
            Some("2026-08-09T10:10:00.000Z")
        );
        crate::runtime::settings::set_global_pause(&conn, false).unwrap();
        let later = at("2026-08-09T10:10:00Z");
        assert!(matches!(
            woken(&conn, &vault, "process:scout", &wake, &[], later).unwrap(),
            Woken::Started { .. }
        ));
        let state = wake_state(&conn, &wake);
        assert_eq!(
            (state.5, state.6),
            (None, None),
            "a started wake waits on nothing"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_agent_with_a_live_run_defers_its_next_wake() {
        let (dir, conn, vault) = fixture("woken-single-flight");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let first = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "a"),
            now,
        );
        let second = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'b', '2', "b"),
            now,
        );
        let Woken::Started { lease, .. } =
            woken(&conn, &vault, "process:scout", &first, &[], now).unwrap()
        else {
            panic!("not started");
        };
        assert_eq!(
            woken(&conn, &vault, "process:scout", &second, &[], now).unwrap(),
            Woken::Deferred(vec![wakes::AGENT_RUNNING.into()])
        );
        let state = wake_state(&conn, &second);
        assert_eq!(
            state.5.as_deref(),
            Some("2026-08-09T10:01:00.000Z"),
            "+60 s"
        );
        let decisions: i64 = conn
            .query_row("SELECT count(*) FROM ambient_gate_decisions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(decisions, 1, "single flight is decided before the gate");
        done(&conn, &lease.run_id, RunOutcome::Succeeded, now);
        // An attended @agent turn of the same agent counts as running too.
        conn.execute(
            "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
             usage_state, input_tokens, output_tokens, cache_read, cache_write, \
             reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, \
             rejected, actor) VALUES ('turn', ?1, 'store', 'attended', 'agent', \
             '2026-08-09T10:00:30.000Z', 'running', 'pending', 0, 0, 0, 0, 0, 0, 0, 0, 0, \
             'process:scout')",
            [&vault],
        )
        .unwrap();
        let later = at("2026-08-09T10:02:00Z");
        assert_eq!(
            woken(&conn, &vault, "process:scout", &second, &[], later).unwrap(),
            Woken::Deferred(vec![wakes::AGENT_RUNNING.into()])
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_claim_coalesces_only_pending_event_wakes_of_its_trigger() {
        let (dir, conn, vault) = fixture("woken-coalesce");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let head = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "records/a.md"),
            now,
        );
        let same = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'b', '1', "records/b.md"),
            now,
        );
        let other_trigger = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'c', '2', "records/c.md"),
            now,
        );
        let other_agent = admit_one(
            &conn,
            &vault,
            event_offer("process:other", 'd', '1', "records/d.md"),
            now,
        );
        let finished = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'e', '1', "records/e.md"),
            now,
        );
        assert!(wakes::cancel_one(&conn, &finished, wakes::EXPIRED, None, now).unwrap());
        // Too many, or one named twice, is refused whole.
        let many: Vec<String> = (0..wakes::COALESCE_MAX)
            .map(|n| format!("{n:032x}"))
            .collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(woken(&conn, &vault, "process:scout", &head, &many, now).is_err());
        assert!(woken(&conn, &vault, "process:scout", &head, &[&same, &same], now).is_err());
        assert!(woken(&conn, &vault, "process:scout", &head, &[&head], now).is_err());
        assert_eq!(
            wake_state(&conn, &head).0,
            "pending",
            "a refused claim writes nothing"
        );

        let Woken::Started { lease, also, .. } = woken(
            &conn,
            &vault,
            "process:scout",
            &head,
            &[&same, &other_trigger, &other_agent, &finished],
            now,
        )
        .unwrap() else {
            panic!("not started");
        };
        let subjects: Vec<String> = also
            .iter()
            .map(|c| {
                serde_json::from_str::<serde_json::Value>(&c.to_column()).unwrap()["subject"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(subjects, vec!["records/b.md"]);
        let same_state = wake_state(&conn, &same);
        assert_eq!(same_state.1.as_deref(), Some("coalesced"));
        assert_eq!(same_state.4.as_deref(), Some(lease.run_id.as_str()));
        assert_eq!(wake_state(&conn, &other_trigger).0, "pending");
        assert_eq!(wake_state(&conn, &other_agent).0, "pending");
        assert_eq!(wake_state(&conn, &finished).2.as_deref(), Some("expired"));
        done(&conn, &lease.run_id, RunOutcome::Succeeded, now);
        assert_eq!(wake_state(&conn, &head).1.as_deref(), Some("succeeded"));
        assert_eq!(
            wake_state(&conn, &same).1.as_deref(),
            Some("coalesced"),
            "finished once, by the claim"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_agent_paused_at_the_gate_cancels_the_wake() {
        let (dir, conn, vault) = fixture("woken-paused");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let wake = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "a"),
            now,
        );
        // Paused behind admission's back, as a pause another window stored.
        crate::runtime::settings::set_agent_paused(&conn, &vault, "process:scout", true).unwrap();
        assert_eq!(
            woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap(),
            Woken::Gone
        );
        let state = wake_state(&conn, &wake);
        assert_eq!(
            (state.1.as_deref(), state.2.as_deref(), state.3.as_deref()),
            (Some("cancelled"), Some("superseded"), Some("paused"))
        );
        let decisions: i64 = conn
            .query_row("SELECT count(*) FROM ambient_gate_decisions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(decisions, 1, "the gate's deferral row is kept");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_or_cancelled_wake_cannot_be_claimed() {
        let (dir, conn, vault) = fixture("woken-gone");
        let _lock = status::test_lock();
        status::clear();
        let admitted = at("2026-08-01T10:00:00Z");
        let old = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "a"),
            admitted,
        );
        let now = at("2026-08-09T10:00:00Z");
        let fresh = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'b', '1', "b"),
            now,
        );
        assert_eq!(
            woken(&conn, &vault, "process:scout", &old, &[], now).unwrap(),
            Woken::Gone
        );
        assert_eq!(
            wake_state(&conn, &old).2.as_deref(),
            Some("expired"),
            "expired at the claim"
        );
        wakes::cancel(
            &conn,
            &vault,
            &[wakes::WakeCancel {
                wake_id: fresh.clone(),
                why: "page_gone".into(),
            }],
            now,
        )
        .unwrap();
        assert_eq!(
            woken(&conn, &vault, "process:scout", &fresh, &[], now).unwrap(),
            Woken::Gone
        );
        assert_eq!(
            woken(&conn, &vault, "process:scout", &"f".repeat(32), &[], now).unwrap(),
            Woken::Gone
        );
        let runs: i64 = conn
            .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runs, 0, "a gone wake opens no run");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalize_finishes_the_runs_wake() {
        let (dir, conn, vault) = fixture("woken-finalize");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let wake = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "a"),
            now,
        );
        let Woken::Started { lease, .. } =
            woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap()
        else {
            panic!("not started");
        };
        done(
            &conn,
            &lease.run_id,
            RunOutcome::Failed,
            at("2026-08-09T10:05:00Z"),
        );
        let state = wake_state(&conn, &wake);
        assert_eq!(
            (state.0.as_str(), state.1.as_deref()),
            ("finished", Some("failed"))
        );
        // The agent is free again: its next wake starts.
        let next = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'b', '1', "b"),
            now,
        );
        assert!(matches!(
            woken(
                &conn,
                &vault,
                "process:scout",
                &next,
                &[],
                at("2026-08-09T10:06:00Z")
            )
            .unwrap(),
            Woken::Started { .. }
        ));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recover_expired_leases_interrupts_a_started_wake() {
        let (dir, conn, vault) = fixture("woken-recover");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        let wake = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'a', '1', "a"),
            now,
        );
        assert!(matches!(
            woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap(),
            Woken::Started { .. }
        ));
        assert_eq!(
            recover_expired_leases(&conn, at("2026-08-09T23:00:00Z")).unwrap(),
            1
        );
        assert_eq!(wake_state(&conn, &wake).1.as_deref(), Some("interrupted"));
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Child body: claim one wake with a crash point armed.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the woken kill-point test"]
    fn crash_scenario_wake_claim() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let (conn, vault, wake) = crash_wake_fixture(&dir);
        let _ = woken(
            &conn,
            &vault,
            "process:scout",
            &wake,
            &[],
            at("2026-08-09T10:00:00Z"),
        );
    }

    /// Child body: claim one wake, then finalize its run, with a crash point
    /// armed inside the finalization.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the woken kill-point test"]
    fn crash_scenario_wake_finalize() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let (conn, vault, wake) = crash_wake_fixture(&dir);
        let Ok(Woken::Started { lease, .. }) = woken(
            &conn,
            &vault,
            "process:scout",
            &wake,
            &[],
            at("2026-08-09T10:00:00Z"),
        ) else {
            return;
        };
        done(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            at("2026-08-09T10:05:00Z"),
        );
    }

    /// At every dispatch kill point a woken claim's wake is pending, or
    /// started with exactly one recoverable run — never started without its
    /// run, and never two.
    #[test]
    fn at_every_dispatch_kill_point_the_wake_is_pending_or_started_exactly_once() {
        let _lock = crate::runtime::status::test_lock();
        for (point, started) in [
            ("runtime-dispatch-begun", false),
            ("runtime-dispatch-claimed", false),
            ("runtime-dispatch-committed", true),
        ] {
            let dir = testutil::temp_vault(&format!("wake-kill-{point}"));
            let status = testutil::run_crash_scenario(
                "runtime::dispatch::tests::crash_scenario_wake_claim",
                point,
                &dir,
            );
            assert!(!status.success(), "{point}: the child must have aborted");
            let conn = crate::runtime::open(&dir).unwrap();
            let (state, run_id): (String, Option<String>) = conn
                .query_row("SELECT state, run_id FROM agent_wakes", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            let runs: i64 = conn
                .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
                .unwrap();
            if started {
                assert_eq!(state, "started", "{point}");
                assert_eq!(runs, 2, "{point}: parent plus exactly one child");
                let parent: String = conn
                    .query_row(
                        "SELECT parent_run_id FROM runs WHERE run_id = ?1",
                        [run_id.as_ref().unwrap()],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(
                    parent, "wake-parent",
                    "{point}: lineage commits with the claim"
                );
                let running: String = conn
                    .query_row(
                        "SELECT outcome FROM runs WHERE run_id = ?1",
                        [run_id.unwrap()],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(running, "running", "{point}");
                assert_eq!(
                    recover_expired_leases(&conn, at("2026-08-09T23:00:00Z")).unwrap(),
                    1
                );
                let after: String = conn
                    .query_row("SELECT outcome FROM agent_wakes", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(after, "interrupted", "{point}: recovery closes the wake");
            } else {
                assert_eq!(
                    state, "pending",
                    "{point}: an uncommitted claim starts nothing"
                );
                assert_eq!(run_id, None, "{point}");
                assert_eq!(runs, 1, "{point}: only the preexisting parent");
            }
            drop(conn);
            crate::runtime::status::clear();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A kill inside finalization leaves the wake started with its run still
    /// running and recoverable, or finished with its run.
    #[test]
    fn a_kill_during_finalization_leaves_the_wake_started_or_finished() {
        let _lock = crate::runtime::status::test_lock();
        for (point, finished) in [
            ("runtime-finalize-begun", false),
            ("runtime-finalize-committed", true),
        ] {
            let dir = testutil::temp_vault(&format!("wake-finalize-kill-{point}"));
            let status = testutil::run_crash_scenario(
                "runtime::dispatch::tests::crash_scenario_wake_finalize",
                point,
                &dir,
            );
            assert!(!status.success(), "{point}: the child must have aborted");
            let conn = crate::runtime::open(&dir).unwrap();
            let (state, outcome): (String, Option<String>) = conn
                .query_row("SELECT state, outcome FROM agent_wakes", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            if finished {
                assert_eq!(
                    (state.as_str(), outcome.as_deref()),
                    ("finished", Some("succeeded")),
                    "{point}"
                );
            } else {
                assert_eq!(state, "started", "{point}");
                assert_eq!(
                    recover_expired_leases(&conn, at("2026-08-09T23:00:00Z")).unwrap(),
                    1
                );
                let after: String = conn
                    .query_row("SELECT outcome FROM agent_wakes", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(after, "interrupted", "{point}");
            }
            drop(conn);
            crate::runtime::status::clear();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Child body: dispatch one item with a crash point armed.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the dispatch kill-point test"]
    fn crash_scenario_dispatch() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let (conn, vault) = crash_fixture(&dir);
        let _ = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".to_string()],
            None,
            Some(&RunCause::of(crate::runtime::cause::CauseKind::Ingest)),
            at("2026-08-09T10:00:00Z"),
        );
    }

    /// Child body: dispatch, then finalize, with a crash point armed inside
    /// the finalization.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the dispatch kill-point test"]
    fn crash_scenario_finalize() {
        let Ok(dir) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let (conn, vault) = crash_fixture(&dir);
        let Dispatched::Started(lease) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".to_string()],
            None,
            Some(&RunCause::of(crate::runtime::cause::CauseKind::Ingest)),
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap() else {
            return;
        };
        let _ = finalize(
            &conn,
            &lease.run_id,
            RunOutcome::Succeeded,
            Some(Usage {
                output_tokens: 500,
                ..Usage::default()
            }),
            None,
            ItemOutcome::Consume,
            at("2026-08-09T10:05:00Z"),
        );
    }

    /// At every dispatch kill point the item is either PENDING or owned by
    /// exactly one recoverable lease, and global ambient concurrency never
    /// exceeds the ceiling — which here is the shipped default of one.
    ///
    /// This is the acceptance row that makes the whole claim transaction
    /// worth its complexity: without it, a kill between "reserve" and "claim"
    /// leaves tokens reserved against a run that never existed, or an item
    /// owned by nothing.
    #[test]
    fn at_every_dispatch_kill_point_the_item_is_pending_or_leased_exactly_once() {
        // This scenario clears the process-global status between runs, so it
        // serialises with every other test that reads it — the same lock the
        // status module hands out for exactly this reason.
        let _lock = crate::runtime::status::test_lock();
        for (point, started) in [
            ("runtime-dispatch-begun", false),
            ("runtime-dispatch-claimed", false),
            ("runtime-dispatch-committed", true),
        ] {
            let dir = testutil::temp_vault(&format!("dispatch-kill-{point}"));
            let status = testutil::run_crash_scenario(
                "runtime::dispatch::tests::crash_scenario_dispatch",
                point,
                &dir,
            );
            assert!(!status.success(), "{point}: the child must have aborted");

            // Re-OPEN, never re-seed: `crash_fixture` writes a pending row,
            // and calling it here would reset the very state under test.
            let conn = crate::runtime::open(&dir).unwrap();
            let vault = crate::runtime::scope::derive_vault_id(&dir);
            let leases: i64 = conn
                .query_row("SELECT count(*) FROM ambient_dispatch", [], |r| r.get(0))
                .unwrap();
            assert!(leases <= 1, "{point}: never two ambient leases");
            let item = crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                .unwrap()
                .unwrap();
            if started {
                assert_eq!(item.state, SchedulerState::Claimed, "{point}");
                assert_eq!(leases, 1, "{point}");
                // The cause was written with the row, in the same commit
                // (M56.7): a committed claim never stands without it.
                let cause: Option<String> = conn
                    .query_row("SELECT cause FROM runs", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(cause.as_deref(), Some(r#"{"kind":"ingest"}"#), "{point}");
                // And the lease is recoverable, which is what makes the
                // claimed state safe rather than a wedge.
                assert_eq!(
                    recover_expired_leases(&conn, at("2026-08-09T23:00:00Z")).unwrap(),
                    1,
                    "{point}"
                );
                assert_eq!(
                    crate::runtime::scheduler::get(&conn, &vault, "store", "a.md")
                        .unwrap()
                        .unwrap()
                        .state,
                    SchedulerState::Pending,
                    "{point}: recovery frees the item"
                );
            } else {
                assert_eq!(
                    item.state,
                    SchedulerState::Pending,
                    "{point}: an uncommitted claim claims nothing"
                );
                assert_eq!(leases, 0, "{point}");
                let runs: i64 = conn
                    .query_row("SELECT count(*) FROM runs", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(runs, 0, "{point}: no run row without a committed claim");
                let reserved: i64 = conn
                    .query_row(
                        "SELECT coalesce(sum(reserved_total_tokens), 0) FROM budget_days",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(reserved, 0, "{point}: nothing reserved against nothing");
            }
            drop(conn);
            crate::runtime::status::clear();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A kill inside finalization leaves the run running with its reservation
    /// intact — recoverable — or completely finalized. Never a released
    /// reservation on a run still marked running.
    #[test]
    fn a_kill_during_finalization_leaves_the_run_recoverable_or_done() {
        // This scenario clears the process-global status between runs, so it
        // serialises with every other test that reads it — the same lock the
        // status module hands out for exactly this reason.
        let _lock = crate::runtime::status::test_lock();
        for (point, finalized) in [
            ("runtime-finalize-begun", false),
            ("runtime-finalize-committed", true),
        ] {
            let dir = testutil::temp_vault(&format!("finalize-kill-{point}"));
            let status = testutil::run_crash_scenario(
                "runtime::dispatch::tests::crash_scenario_finalize",
                point,
                &dir,
            );
            assert!(!status.success(), "{point}: the child must have aborted");

            let conn = crate::runtime::open(&dir).unwrap();
            let (outcome, reserved): (String, i64) = conn
                .query_row(
                    "SELECT outcome, reserved_total_tokens FROM runs LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            let day_reserved: i64 = conn
                .query_row(
                    "SELECT coalesce(sum(reserved_total_tokens), 0) FROM budget_days",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if finalized {
                assert_eq!(outcome, "succeeded", "{point}");
                assert_eq!(day_reserved, 0, "{point}: the reservation is released");
                let spent: i64 = conn
                    .query_row(
                        "SELECT coalesce(sum(ambient_tokens_used), 0) FROM budget_days",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(spent, 500, "{point}: exact usage landed");
            } else {
                assert_eq!(outcome, "running", "{point}");
                assert_eq!(
                    day_reserved, reserved,
                    "{point}: a run still running still holds its reservation"
                );
                assert_eq!(
                    recover_expired_leases(&conn, at("2026-08-09T23:00:00Z")).unwrap(),
                    1,
                    "{point}: and recovery can still close it"
                );
            }
            drop(conn);
            crate::runtime::status::clear();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_paused_process_never_opens_the_dispatch_transaction() {
        let (dir, conn, vault) = fixture("dispatch-paused-process");
        let _lock = status::test_lock();
        seed_item(&conn, &vault, "a.md");
        status::set(status::RuntimeStatus::MigrationFailed {
            attempted_version: 4,
            detail: "injected".into(),
        });
        let outcome = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["a.md".into()],
            None,
            None,
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        assert!(matches!(outcome, Dispatched::Deferred(_)));
        let decisions: i64 = conn
            .query_row("SELECT count(*) FROM ambient_gate_decisions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(decisions, 0);
        status::clear();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn chain_actors_walks_root_first_and_reads_a_missing_row_as_none() {
        let (dir, conn, vault) = fixture("wake-chain-actors");
        seed_run(&conn, &vault, "root", None, 0);
        seed_run(&conn, &vault, "hop", Some("root"), 0);
        conn.execute(
            "UPDATE runs SET actor = 'process:scout' WHERE run_id = 'hop'",
            [],
        )
        .unwrap();
        assert_eq!(
            chain_actors(&conn, "hop").unwrap(),
            Some(vec!["claude-code".into(), "process:scout".into()])
        );
        assert_eq!(chain_actors(&conn, "missing").unwrap(), None);
        conn.execute(
            "UPDATE runs SET parent_run_id = 'hop' WHERE run_id = 'root'",
            [],
        )
        .unwrap();
        assert_eq!(
            chain_actors(&conn, "hop").unwrap().unwrap().len(),
            16,
            "corrupt cycles are bounded"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn parented_wake(
        conn: &Connection,
        vault: &str,
        key: char,
        parent: &str,
        now: DateTime<Utc>,
    ) -> String {
        let offered = event_offer("process:scout", key, '1', "records/a.md");
        let hash = offered.wake_key.clone();
        wakes::admit_with_writers(
            conn,
            vault,
            &[offered],
            &[super::super::write_log::EventWriter::Run {
                actor: "claude-code".into(),
                run_id: parent.into(),
            }],
            now,
        )
        .unwrap();
        conn.query_row(
            "SELECT wake_id FROM agent_wakes WHERE wake_key = ?1",
            [hash],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_woken_hop_claim_books_its_parent_on_the_run_row() {
        let _lock = status::test_lock();
        status::clear();
        let (dir, conn, vault) = fixture("wake-claim-parent");
        let now = at("2026-08-09T10:00:00Z");
        seed_run(&conn, &vault, "root", None, 100);
        let wake = parented_wake(&conn, &vault, 'a', "root", now);
        let Woken::Started {
            lease,
            parent_run_id,
            ..
        } = woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap()
        else {
            panic!("not started")
        };
        assert_eq!(parent_run_id.as_deref(), Some("root"));
        assert_eq!(
            conn.query_row(
                "SELECT parent_run_id FROM runs WHERE run_id = ?1",
                [&lease.run_id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "root"
        );
        drop(conn);
        status::clear();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_spent_chain_skips_the_hop_at_claim() {
        let _lock = status::test_lock();
        status::clear();
        let (dir, conn, vault) = fixture("wake-claim-spent");
        let now = at("2026-08-09T10:00:00Z");
        seed_run(&conn, &vault, "root", None, 21_000);
        let wake = parented_wake(&conn, &vault, 'a', "root", now);
        assert_eq!(
            woken(&conn, &vault, "process:scout", &wake, &[], now).unwrap(),
            Woken::Skipped
        );
        let row = wake_state(&conn, &wake);
        assert_eq!(
            (row.0.as_str(), row.1.as_deref(), row.2.as_deref()),
            ("finished", Some("skipped"), Some("chain_spent"))
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(conn);
        status::clear();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_claim_never_coalesces_wakes_of_another_parent() {
        let _lock = status::test_lock();
        status::clear();
        let (dir, conn, vault) = fixture("wake-coalesce-parent");
        let now = at("2026-08-09T10:00:00Z");
        seed_run(&conn, &vault, "root-a", None, 0);
        seed_run(&conn, &vault, "root-b", None, 0);
        let head = parented_wake(&conn, &vault, 'a', "root-a", now);
        let same = parented_wake(&conn, &vault, 'b', "root-a", now);
        let other = parented_wake(&conn, &vault, 'c', "root-b", now);
        let root = admit_one(
            &conn,
            &vault,
            event_offer("process:scout", 'd', '1', "records/a.md"),
            now,
        );
        let Woken::Started { also, .. } = woken(
            &conn,
            &vault,
            "process:scout",
            &head,
            &[&same, &other, &root],
            now,
        )
        .unwrap() else {
            panic!("not started")
        };
        assert_eq!(also.len(), 1);
        assert_eq!(wake_state(&conn, &same).1.as_deref(), Some("coalesced"));
        for id in [other, root] {
            assert_eq!(wake_state(&conn, &id).0, "pending");
        }
        drop(conn);
        status::clear();
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn a_client_session_opens_finishes_once_and_preserves_unknown_usage() {
        let (dir, conn, vault) = fixture("dispatch-client-session");
        let started = at("2026-10-15T12:00:00Z");
        let ended = started + Duration::minutes(1);
        begin_client_session(
            &conn,
            &ClientSession {
                run_id: "client-run",
                vault_id: &vault,
                store_uuid: "store",
                actor: "client:terminal",
                token_name: "Terminal",
                client_info: Some("Test 1"),
                started_at: started,
            },
        )
        .unwrap();
        assert_eq!(
            books(&conn, "client-run"),
            ("running".into(), "pending".into(), 0, 0, 0, 1)
        );
        assert!(finish_client_session(&conn, "client-run", true, ended).unwrap());
        assert!(
            !finish_client_session(&conn, "client-run", false, ended + Duration::minutes(1))
                .unwrap()
        );
        assert_eq!(books(&conn, "client-run").0, "succeeded");
        assert_eq!(books(&conn, "client-run").1, "unknown");
        let recorded: String = conn
            .query_row(
                "SELECT ended_at FROM runs WHERE run_id='client-run'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recorded, stamp(ended));
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn an_orphaned_client_session_is_recovered_as_unknown() {
        let (dir, conn, vault) = fixture("dispatch-client-orphan");
        let started = at("2026-10-15T12:00:00Z");
        begin_client_session(
            &conn,
            &ClientSession {
                run_id: "client-orphan",
                vault_id: &vault,
                store_uuid: "store",
                actor: "client:terminal",
                token_name: "Terminal",
                client_info: None,
                started_at: started,
            },
        )
        .unwrap();
        assert_eq!(
            recover_orphaned_attended(
                &conn,
                started + Duration::minutes(1),
                started + Duration::minutes(2)
            )
            .unwrap(),
            1
        );
        assert_eq!(books(&conn, "client-orphan").0, "abandoned_usage_unknown");
        assert_eq!(books(&conn, "client-orphan").1, "unknown");
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn finalize_check_neither_adds_to_nor_resets_the_failure_counter() {
        let (dir, conn, vault) = fixture("check-failure-counter");
        let _lock = status::test_lock();
        status::clear();
        let now = at("2026-08-09T10:00:00Z");
        for outcome in [RunOutcome::Failed, RunOutcome::Succeeded] {
            let Dispatched::Started(lease) = claim(
                &conn,
                &vault,
                "store",
                "agent",
                small(),
                &[],
                Some("process:scout"),
                None,
                now,
            )
            .unwrap() else {
                panic!("check may book")
            };
            conn.execute(
                "UPDATE ambient_gate_state SET consecutive_failures=2 WHERE lane='agent'",
                [],
            )
            .unwrap();
            finalize_check(
                &conn,
                &lease.run_id,
                outcome,
                Some(Usage::default()),
                None,
                now,
            )
            .unwrap();
            let failures: i64 = conn
                .query_row(
                    "SELECT consecutive_failures FROM ambient_gate_state WHERE lane='agent'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(failures, 2);
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
}
