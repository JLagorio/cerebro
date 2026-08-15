//! One ambient dispatch, start to finish (M25.2).
//!
//! **The claim is one transaction or it is nothing.** Gate, token
//! reservation, scheduler claim, run row, and the singleton ambient lease all
//! commit together, and the subprocess spawns only afterwards. Split across
//! two transactions — or worse, across the IPC boundary — every crash
//! boundary becomes a way to lose the accounting: a run that spent tokens
//! with no row, a reservation nothing will release, an item claimed by a run
//! that never started.
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
//! **Background concurrency is one.** The singleton `ambient_dispatch` row is
//! the enforcement, not a comment: chat keeps its headroom inside the
//! process-wide cap of four because the database will not hand out a second
//! ambient lease.

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;

use crate::agent::usage::{RunFacts, Usage};

use super::budget::{self, Day, Decision, GateReason, Reservation};
use super::scheduler::SchedulerState;
use super::status;

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
pub fn claim(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    items: &[String],
    now: DateTime<Utc>,
) -> Result<Dispatched, String> {
    // The process-level status is checked before the transaction: a failed
    // migration or an unresolved recovery is not a budget question, and
    // opening a write transaction to discover it would be noise.
    if !status::ambient_allowed() {
        return Ok(Dispatched::Deferred(vec![GateReason::AccountingUnknown]));
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("dispatch: {e}"))?;
    crate::crash::crash_point("runtime-dispatch-begun");
    let outcome = claim_inner(conn, vault_id, store_uuid, lane, reservation, items, now);
    match outcome {
        Ok(dispatched) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("dispatch: {e}"))?;
            crate::crash::crash_point("runtime-dispatch-committed");
            Ok(dispatched)
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("dispatch rolled back: {detail}"))
        }
    }
}

fn claim_inner(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    lane: &str,
    reservation: Reservation,
    items: &[String],
    now: DateTime<Utc>,
) -> Result<Dispatched, String> {
    // What is actually still claimable, BEFORE anything is written.
    //
    // Asking first is not an optimization. A dispatcher whose queue was built
    // a moment ago may name items a human has since edited or a review has
    // since consumed, and burning a gate decision — let alone a run — on an
    // empty claim would make "we tried and were refused" and "there was
    // nothing to do" look identical in the record.
    let pending = pending_subset(conn, vault_id, store_uuid, items)?;
    if pending.is_empty() && !items.is_empty() {
        return Ok(Dispatched::NothingToClaim);
    }

    let (decision, day) = budget::gate(conn, vault_id, store_uuid, lane, reservation, now)?;
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
        return Ok(Dispatched::Deferred(reasons));
    }

    let run_id = crate::ledger::new_id128();
    let lease_seconds = (day.ceilings.max_run_elapsed_seconds as i64) * LEASE_MULTIPLE;
    let lease_expires_at = stamp(now + Duration::seconds(lease_seconds));

    // The run row comes FIRST: a claim points at its owner with a foreign
    // key, so an item can never be owned by a run that does not exist.
    conn.execute(
        "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, outcome, \
         usage_state, input_tokens, output_tokens, cache_read, cache_write, \
         reserved_total_tokens, reserved_output_tokens, lease_expires_at, proposals_submitted, \
         applied, rejected) \
         VALUES (?1, ?2, ?3, 'ambient', ?4, ?5, 'running', 'pending', 0, 0, 0, 0, ?6, ?7, ?8, \
                 0, 0, 0)",
        rusqlite::params![
            run_id,
            vault_id,
            store_uuid,
            lane,
            stamp(now),
            reservation.total_tokens as i64,
            reservation.output_tokens as i64,
            lease_expires_at,
        ],
    )
    .map_err(|e| format!("runs: {e}"))?;

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

    // The singleton. A second concurrent dispatcher fails the primary key
    // here rather than discovering the conflict after spawning a subprocess.
    conn.execute(
        "INSERT INTO ambient_dispatch \
         (singleton_key, run_id, vault_id, store_uuid, lane, acquired_at, lease_expires_at) \
         VALUES ('ambient', ?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            run_id,
            vault_id,
            store_uuid,
            lane,
            stamp(now),
            lease_expires_at
        ],
    )
    .map_err(|e| format!("ambient_dispatch (the one ambient lease): {e}"))?;

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
    Ok(Dispatched::Started(Lease {
        run_id,
        lease_expires_at,
        window_start_utc: day.window_start_utc,
        elapsed_limit_seconds: day.ceilings.max_run_elapsed_seconds,
        claimed,
    }))
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
pub fn finalize(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    items: ItemOutcome,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("finalize: {e}"))?;
    crate::crash::crash_point("runtime-finalize-begun");
    let result = finalize_inner(conn, run_id, outcome, usage, facts, items, now);
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

fn finalize_inner(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    items: ItemOutcome,
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
    // the next dispatcher would walk straight back into the wall.
    if outcome == RunOutcome::QuotaFailed {
        if let Some(store) = &store_uuid {
            super::health::record_quota_failure(
                conn,
                store,
                "the CLI reported a usage or rate limit",
                now,
            )?;
        }
    } else if outcome.is_success() {
        super::health::record_runtime_recovery(conn, now)?;
    }

    if let (Some(vault_id), Some(store_uuid)) = (vault_id, store_uuid) {
        // A success resets the lane's failure counter; anything else adds to
        // it. Three in a row and the lane stops asking.
        let sql = if outcome.is_success() {
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

/// Record one attended run. Metered, never gated: no reservation, no lease,
/// no budget debit, and no way for a full day to stop it.
#[allow(clippy::too_many_arguments)]
pub fn meter_attended(
    conn: &Connection,
    run_id: &str,
    vault_id: Option<&str>,
    store_uuid: Option<&str>,
    outcome: RunOutcome,
    usage: Option<Usage>,
    facts: Option<&RunFacts>,
    started_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let counted = usage.unwrap_or_default();
    conn.execute(
        "INSERT INTO runs (run_id, vault_id, store_uuid, mode, lane, started_at, ended_at, \
         outcome, usage_state, input_tokens, output_tokens, cache_read, cache_write, \
         reserved_total_tokens, reserved_output_tokens, proposals_submitted, applied, rejected) \
         VALUES (?1, ?2, ?3, 'attended', 'agent', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0, 0, 0, 0)",
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
        ],
    )
    .map_err(|e| format!("runs (attended): {e}"))?;
    if let Some(facts) = facts {
        write_facts(conn, run_id, facts)?;
        route_denials(conn, run_id, store_uuid, facts);
    }
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
/// An empty array records nothing; `Some(0)` lives in RunFacts, and a zero
/// row per run would train everyone to stop reading the log. Best-effort by
/// construction (`record_or_warn`): telemetry must never become a second way
/// for the run to fail.
fn route_denials(conn: &Connection, run_id: &str, store_uuid: Option<&str>, facts: &RunFacts) {
    let Some(denied) = facts.permission_denials.filter(|count| *count > 0) else {
        return;
    };
    let detail = format!("the CLI reported {denied} permission denial(s) during this run");
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
    fn global_ambient_concurrency_never_exceeds_one() {
        // Two vaults, one subscription, one background slot. The second
        // dispatch is refused by the gate rather than by luck.
        let (dir, conn, vault_a) = fixture("dispatch-singleton");
        let other = testutil::temp_vault("dispatch-singleton-b");
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
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
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
        let routed: i64 = conn
            .query_row(
                "SELECT count(*) FROM operational_log \
                 WHERE surface = 'agent.permission' AND run_id = ?1",
                [&lease.run_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(routed, 1, "a non-empty denial array is one operational row");

        // No facts at all: every fact column stays NULL and nothing routes.
        let Dispatched::Started(second) = claim(
            &conn,
            &vault,
            "store",
            "filed",
            small(),
            &["b.md".into()],
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
            at("2026-08-09T10:05:00Z"),
        )
        .unwrap();
        assert_eq!(next, Dispatched::Deferred(vec![GateReason::QuotaBackoff]));
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
            at("2026-08-09T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(outcome, Dispatched::NothingToClaim);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
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
    /// exceeds one.
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
}
