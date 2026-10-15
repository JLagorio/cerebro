//! Durable wakes (M63.1, AUTOMATION-3).
//!
//! A change that matches an agent's trigger is ADMITTED here once, as a row
//! of `agent_wakes`, and runs once. Before this an event run came from a
//! one-slot list in the renderer: only the first match fired, a later scan
//! replaced the list, and a deferred event run was never retried.
//!
//! **Admitted once.** The renderer offers each match with a content key (the
//! change's kind, path and hashes, `src/engine/wakes.ts`), and admission is
//! an INSERT OR IGNORE on the live key: a relaunch, a second window or a
//! retried admission finds the wake already there. The key covers pending and
//! started wakes only, so a change made again after its wake finished wakes
//! again. Only an agent the runtime has not paused is admitted.
//!
//! **Claimed with its lease.** A woken run claims its wake inside
//! `dispatch::claim_woken`, in the same transaction as the gate, the run row
//! and the lease, so a wake is pending or started with a recoverable run at
//! every kill point. A gate deferral keeps it pending with a time to try
//! again; a per-agent pause cancels it; one agent runs one wake at a time.
//!
//! **Closed outcomes.** A wake finishes `succeeded`, `failed` or `interrupted`
//! with its run (`finish_for_run`, inside `dispatch::finalize`), `coalesced`
//! into another wake's run, or `cancelled` (`superseded` with a why, or
//! `expired` after [`WAKE_TTL_DAYS`]). `skipped` is reserved for later parts.
//! The table's CHECKs bound lengths and the lifecycle; the shapes, kinds,
//! reasons and whys are the closed lists below, and [`words`] says each end
//! as the Agents lobby lists it (M63.1b, `fleet::wakes`).
//!
//! `src-tauri/fixtures/wake-cases.json` holds what admission, claims,
//! finishes, cancels, pauses, expiry and the pending read answer; this module
//! and `src/lib/mockIpc.test.ts` both replay it.

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::cause::{self, CauseKind, CauseRequest};
use super::dispatch::RunOutcome;
use super::ReadOnly;

/// How long a pending wake may wait before it expires, at the next vault
/// open or claim.
pub const WAKE_TTL_DAYS: i64 = 7;
/// The most wakes one run answers: its own and nineteen more of the same
/// trigger.
pub const COALESCE_MAX: usize = 20;
/// When a wake deferred because its agent was already running, or because
/// another background run held the only slot, is tried again.
pub const BUSY_RETRY_SECS: i64 = 60;
/// When a wake the budget gate deferred for any other reason is tried again.
pub const BUDGET_RETRY_SECS: i64 = 600;

/// The deferral a woken claim answers while its agent is already running.
pub const AGENT_RUNNING: &str = "agent_running";

/// A cancelled wake's reason when something made it moot; its detail names
/// the [`CancelWhy`].
pub const SUPERSEDED: &str = "superseded";
/// A cancelled wake's reason when it waited past [`WAKE_TTL_DAYS`].
pub const EXPIRED: &str = "expired";

/// Why an offer was not admitted: its shape, or a paused agent.
pub const MALFORMED: &str = "malformed";
pub const PAUSED: &str = "paused";

/// Why a pending wake is cancelled as superseded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelWhy {
    /// Its agent was paused, on its record or on the fleet.
    Paused,
    /// The trigger that matched was edited or removed.
    TriggerChanged,
    /// No agent answers to its name any more.
    AgentGone,
    /// The page that changed is gone.
    PageGone,
}

impl CancelWhy {
    pub const ALL: [CancelWhy; 4] = [
        CancelWhy::Paused,
        CancelWhy::TriggerChanged,
        CancelWhy::AgentGone,
        CancelWhy::PageGone,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CancelWhy::Paused => "paused",
            CancelWhy::TriggerChanged => "trigger_changed",
            CancelWhy::AgentGone => "agent_gone",
            CancelWhy::PageGone => "page_gone",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|why| why.as_str() == raw)
    }

    /// What a wake cancelled for this why reads as (M63.1b).
    pub fn words(self) -> &'static str {
        match self {
            CancelWhy::Paused => "cancelled — the agent was paused",
            CancelWhy::TriggerChanged => {
                "cancelled — the trigger that matched was edited or removed"
            }
            CancelWhy::AgentGone => "cancelled — no agent answers to this name any more",
            CancelWhy::PageGone => "cancelled — the page that changed is gone",
        }
    }
}

/// What a pending wake reads as in the lobby's list; the renderer says how
/// long it has waited and why it still waits.
pub const WAITING_WORDS: &str = "waiting";

/// The words for a finished wake whose reason this build does not name, as
/// `skipped (or cancelled) for a reason this version does not name (<reason>)`.
const UNNAMED_WORDS: &str = "skipped (or cancelled) for a reason this version does not name";

/// What a wake's end says, in words (M63.1b): the one table the Agents lobby
/// and an agent's Runs tab read, and `src/lib/mockIpc.ts` mirrors. A pending
/// wake (no outcome) is [`WAITING_WORDS`]. A reason or a cancel why this
/// build cannot name reads as unnamed, with the raw value in brackets, so a
/// row a newer build wrote still says something true.
pub fn words(outcome: Option<&str>, reason: Option<&str>, detail: Option<&str>) -> String {
    match (outcome, reason) {
        (None, _) => WAITING_WORDS.into(),
        (Some("cancelled"), Some(SUPERSEDED)) => match detail.and_then(CancelWhy::parse) {
            Some(why) => why.words().into(),
            None => unnamed(reason, detail),
        },
        (Some("cancelled"), Some(EXPIRED)) => {
            format!("expired — waited more than {WAKE_TTL_DAYS} days")
        }
        _ => unnamed(reason, detail),
    }
}

fn unnamed(reason: Option<&str>, detail: Option<&str>) -> String {
    let raw = match (reason, detail) {
        (Some(reason), Some(detail)) => format!("{reason}: {detail}"),
        (Some(reason), None) => reason.to_string(),
        (None, _) => "not recorded".to_string(),
    };
    format!("{UNNAMED_WORDS} ({raw})")
}

/// One match the renderer offers for admission.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WakeOffer {
    pub agent: String,
    pub wake_key: String,
    pub trigger: String,
    pub cause: CauseRequest,
}

/// One offer admission refused, and why ([`MALFORMED`] or [`PAUSED`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdmitRefusal {
    pub agent: String,
    pub reason: String,
}

/// What one admission did: new wakes, offers whose live wake was already
/// there, and the refusals in offer order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct AdmitReport {
    pub admitted: usize,
    pub live: usize,
    pub refused: Vec<AdmitRefusal>,
}

/// A wake waiting for its run, as the renderer reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWake {
    pub wake_id: String,
    pub agent: String,
    pub wake_key: String,
    pub trigger: String,
    /// The cleaned cause stored at admission.
    pub cause: serde_json::Value,
    pub admitted_at: String,
    /// When a deferred wake may be tried again; `None` is now.
    pub not_before: Option<String>,
    /// The gate's reasons, comma-separated, from its last deferral.
    pub deferred: Option<String>,
}

/// Which wake a woken run claims, and the pending wakes of the same trigger
/// it takes with it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WakeRequest {
    pub claim: String,
    #[serde(default)]
    pub coalesce: Vec<String>,
}

/// One pending wake to cancel, and why (a [`CancelWhy`] name).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WakeCancel {
    pub wake_id: String,
    pub why: String,
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The admission time at or before which a pending wake has expired.
pub(crate) fn ttl_cutoff(now: DateTime<Utc>) -> String {
    stamp(now - Duration::days(WAKE_TTL_DAYS))
}

fn is_lower_hex(raw: &str, len: usize) -> bool {
    raw.len() == len
        && raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `process:` and a handle of `[a-z0-9-]`, at most 128 characters.
fn is_agent(raw: &str) -> bool {
    raw.len() <= 128
        && raw.strip_prefix("process:").is_some_and(|handle| {
            !handle.is_empty()
                && handle
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// The cleaned cause column an offer stores, or `None` when its shape is
/// refused: an event wake's key is 64 lowercase hex, its trigger 16, and its
/// cause passes M56.7's cleaning with kind `event`.
fn admissible(offer: &WakeOffer) -> Option<String> {
    if !is_agent(&offer.agent) || !is_lower_hex(&offer.wake_key, 64) {
        return None;
    }
    if !is_lower_hex(&offer.trigger, 16) {
        return None;
    }
    match cause::admit(false, Some(&offer.cause)) {
        Ok(Some(cause)) if cause.kind() == CauseKind::Event => Some(cause.to_column()),
        _ => None,
    }
}

/// Admit `offers` in one transaction. A bad shape is refused [`MALFORMED`],
/// an agent the runtime has paused [`PAUSED`]; every other offer is admitted,
/// or counted live when its key's wake is pending or started. A settings read
/// that fails fails the whole admission, so the renderer offers it again.
pub fn admit(
    conn: &Connection,
    vault_id: &str,
    offers: &[WakeOffer],
    now: DateTime<Utc>,
) -> Result<AdmitReport, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("admitting wakes: {e}"))?;
    match admit_inner(conn, vault_id, offers, now) {
        Ok(report) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("admitting wakes: {e}"))?;
            Ok(report)
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("admitting wakes rolled back: {detail}"))
        }
    }
}

fn admit_inner(
    conn: &Connection,
    vault_id: &str,
    offers: &[WakeOffer],
    now: DateTime<Utc>,
) -> Result<AdmitReport, String> {
    let mut report = AdmitReport::default();
    for offer in offers {
        let Some(cause) = admissible(offer) else {
            report.refused.push(AdmitRefusal {
                agent: offer.agent.clone(),
                reason: MALFORMED.into(),
            });
            continue;
        };
        if super::settings::agent_paused(conn, vault_id, &offer.agent)? {
            report.refused.push(AdmitRefusal {
                agent: offer.agent.clone(),
                reason: PAUSED.into(),
            });
            continue;
        }
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO agent_wakes (wake_id, vault_id, agent, wake_key, \
                 trigger_digest, cause, admitted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    crate::ledger::new_id128(),
                    vault_id,
                    offer.agent,
                    offer.wake_key,
                    offer.trigger,
                    cause,
                    stamp(now),
                ],
            )
            .map_err(|e| format!("agent_wakes: {e}"))?;
        if inserted == 1 {
            report.admitted += 1;
        } else {
            report.live += 1;
        }
    }
    Ok(report)
}

/// The pending wakes of one vault still inside the TTL, oldest first.
pub fn pending(
    ro: &ReadOnly,
    vault_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<PendingWake>, String> {
    let mut statement = ro
        .prepare(
            "SELECT wake_id, agent, wake_key, trigger_digest, cause, admitted_at, not_before, \
             deferred FROM agent_wakes WHERE vault_id = ?1 AND state = 'pending' \
             AND admitted_at > ?2 ORDER BY admitted_at, rowid",
        )
        .map_err(|e| format!("agent_wakes: {e}"))?;
    let rows = statement
        .query_map(rusqlite::params![vault_id, ttl_cutoff(now)], |row| {
            let cause: String = row.get(4)?;
            Ok(PendingWake {
                wake_id: row.get(0)?,
                agent: row.get(1)?,
                wake_key: row.get(2)?,
                trigger: row.get(3)?,
                cause: serde_json::from_str(&cause).unwrap_or(serde_json::Value::Null),
                admitted_at: row.get(5)?,
                not_before: row.get(6)?,
                deferred: row.get(7)?,
            })
        })
        .map_err(|e| format!("agent_wakes: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("agent_wakes: {e}"))
}

/// Finish one pending wake `cancelled`, with `reason` and an optional
/// detail. Pending only: a started or finished wake is never touched.
/// Answers whether it moved.
pub(crate) fn cancel_one(
    conn: &Connection,
    wake_id: &str,
    reason: &str,
    detail: Option<&str>,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let moved = conn
        .execute(
            "UPDATE agent_wakes SET state = 'finished', outcome = 'cancelled', reason = ?2, \
             detail = ?3, finished_at = ?4, not_before = NULL, deferred = NULL \
             WHERE wake_id = ?1 AND state = 'pending'",
            rusqlite::params![wake_id, reason, detail, stamp(now)],
        )
        .map_err(|e| format!("agent_wakes: {e}"))?;
    Ok(moved == 1)
}

/// Cancel pending wakes of this vault as superseded, each with its why.
/// An unknown why is refused before anything is written; a wake that is no
/// longer pending, or in another vault, is left alone. Answers how many it
/// cancelled.
pub fn cancel(
    conn: &Connection,
    vault_id: &str,
    cancels: &[WakeCancel],
    now: DateTime<Utc>,
) -> Result<usize, String> {
    let mut parsed = Vec::with_capacity(cancels.len());
    for cancel in cancels {
        let Some(why) = CancelWhy::parse(&cancel.why) else {
            return Err(format!(
                "{:?} is not a reason to cancel a wake — the reasons live in \
                 src-tauri/src/runtime/wakes.rs. Nothing was cancelled.",
                cancel.why
            ));
        };
        parsed.push((cancel.wake_id.as_str(), why));
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("cancelling wakes: {e}"))?;
    let mut cancelled = 0;
    for (wake_id, why) in parsed {
        let moved = conn.execute(
            "UPDATE agent_wakes SET state = 'finished', outcome = 'cancelled', reason = ?3, \
             detail = ?4, finished_at = ?5, not_before = NULL, deferred = NULL \
             WHERE wake_id = ?1 AND vault_id = ?2 AND state = 'pending'",
            rusqlite::params![wake_id, vault_id, SUPERSEDED, why.as_str(), stamp(now)],
        );
        match moved {
            Ok(n) => cancelled += n,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(format!("cancelling wakes rolled back: agent_wakes: {e}"));
            }
        }
    }
    conn.execute_batch("COMMIT")
        .map_err(|e| format!("cancelling wakes: {e}"))?;
    Ok(cancelled)
}

/// Cancel this vault's pending wakes past the TTL, `expired`. One statement,
/// so it is atomic without a transaction of its own. Answers how many.
pub fn expire(conn: &Connection, vault_id: &str, now: DateTime<Utc>) -> Result<usize, String> {
    conn.execute(
        "UPDATE agent_wakes SET state = 'finished', outcome = 'cancelled', reason = ?2, \
         detail = NULL, finished_at = ?3, not_before = NULL, deferred = NULL \
         WHERE vault_id = ?1 AND state = 'pending' AND admitted_at <= ?4",
        rusqlite::params![vault_id, EXPIRED, stamp(now), ttl_cutoff(now)],
    )
    .map_err(|e| format!("agent_wakes: {e}"))
}

/// Pause or resume one agent on the fleet. Pausing cancels its pending wakes
/// (superseded, paused) in the same transaction as the pause, so no wake of
/// a paused agent is left to run when it resumes. Resuming cancels nothing.
pub fn pause_agent(
    conn: &Connection,
    vault_id: &str,
    actor: &str,
    paused: bool,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("pausing {actor}: {e}"))?;
    let result = super::settings::set_agent_paused(conn, vault_id, actor, paused).and_then(|()| {
        if !paused {
            return Ok(());
        }
        conn.execute(
            "UPDATE agent_wakes SET state = 'finished', outcome = 'cancelled', reason = ?3, \
             detail = ?4, finished_at = ?5, not_before = NULL, deferred = NULL \
             WHERE vault_id = ?1 AND agent = ?2 AND state = 'pending'",
            rusqlite::params![
                vault_id,
                actor.trim(),
                SUPERSEDED,
                CancelWhy::Paused.as_str(),
                stamp(now)
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("agent_wakes: {e}"))
    });
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("pausing {actor}: {e}")),
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(detail)
        }
    }
}

/// The wake outcome a run's outcome gives it.
pub fn outcome_of(outcome: RunOutcome) -> &'static str {
    match outcome {
        RunOutcome::Succeeded => "succeeded",
        RunOutcome::Failed | RunOutcome::QuotaFailed | RunOutcome::ElapsedAborted => "failed",
        RunOutcome::Cancelled | RunOutcome::AbandonedUsageUnknown => "interrupted",
    }
}

fn run_outcome_named(raw: &str) -> Option<RunOutcome> {
    [
        RunOutcome::Succeeded,
        RunOutcome::Failed,
        RunOutcome::QuotaFailed,
        RunOutcome::ElapsedAborted,
        RunOutcome::Cancelled,
        RunOutcome::AbandonedUsageUnknown,
    ]
    .into_iter()
    .find(|outcome| outcome.as_str() == raw)
}

/// Finish the wake `run_id` started, from the run's outcome. Runs inside
/// `dispatch::finalize`'s transaction, so the run and its wake end together;
/// a run that started no wake changes nothing.
pub(crate) fn finish_for_run(
    conn: &Connection,
    run_id: &str,
    outcome: RunOutcome,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE agent_wakes SET state = 'finished', outcome = ?2, finished_at = ?3 \
         WHERE run_id = ?1 AND state = 'started'",
        rusqlite::params![run_id, outcome_of(outcome), stamp(now)],
    )
    .map(|_| ())
    .map_err(|e| format!("agent_wakes: {e}"))
}

/// Finish every started wake whose run has already ended, from that run's
/// outcome: a finalize that ran before this table existed, or one a newer
/// path forgot. Answers how many it closed.
pub fn reconcile_started(conn: &Connection, now: DateTime<Utc>) -> Result<usize, String> {
    let ended: Vec<(String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT w.wake_id, r.outcome FROM agent_wakes w JOIN runs r \
                 ON r.run_id = w.run_id WHERE w.state = 'started' AND r.outcome != 'running'",
            )
            .map_err(|e| format!("agent_wakes: {e}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("agent_wakes: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("agent_wakes: {e}"))?
    };
    let mut closed = 0;
    for (wake_id, raw) in ended {
        // A run outcome this build cannot name has still ended: interrupted
        // is the honest word for a run nobody can say finished well.
        let outcome = run_outcome_named(&raw).unwrap_or(RunOutcome::AbandonedUsageUnknown);
        closed += conn
            .execute(
                "UPDATE agent_wakes SET state = 'finished', outcome = ?2, finished_at = ?3 \
                 WHERE wake_id = ?1 AND state = 'started'",
                rusqlite::params![wake_id, outcome_of(outcome), stamp(now)],
            )
            .map_err(|e| format!("agent_wakes: {e}"))?;
    }
    Ok(closed)
}

/// At a vault's open: expire its wakes past the TTL and close started wakes
/// whose run has ended. Logs what it did and never fails the open.
pub fn sweep_at_open(data_dir: &Path, vault: &Path, now: DateTime<Utc>) {
    let conn = match super::open_existing(data_dir) {
        Ok(conn) => conn,
        Err(detail) => {
            log::warn!("wakes: the open sweep could not reach the runtime db: {detail}");
            return;
        }
    };
    let vault_id = super::scope::derive_vault_id(vault);
    match expire(&conn, &vault_id, now) {
        Ok(0) => {}
        Ok(n) => {
            log::warn!("wakes: {n} pending wakes waited past {WAKE_TTL_DAYS} days and expired")
        }
        Err(detail) => log::warn!("wakes: expiry failed: {detail}"),
    }
    match reconcile_started(&conn, now) {
        Ok(0) => {}
        Ok(n) => log::warn!("wakes: {n} started wakes whose run had ended were closed"),
        Err(detail) => log::warn!("wakes: closing ended wakes failed: {detail}"),
    }
}

/// What is wrong with a `run_agent` request that carries a wake, in words, or
/// `None`. A woken run is unattended, bills to lane `agent`, runs as a
/// `process:` agent, and names no cause of its own: its cause is the wake's,
/// stored when the change was admitted.
pub fn refuse_request(
    attended: bool,
    lane: Option<&str>,
    actor: Option<&str>,
    has_cause: bool,
) -> Option<String> {
    if attended {
        return Some(
            "a woken run is unattended: a change woke it, and nobody is watching. Nothing was \
             started."
                .into(),
        );
    }
    if lane != Some("agent") {
        return Some(format!(
            "a woken run bills to lane \"agent\", not {lane:?}. Nothing was started."
        ));
    }
    if !actor.is_some_and(|actor| actor.starts_with("process:")) {
        return Some(
            "a woken run is an agent's run, so it needs a process: actor. Nothing was started."
                .into(),
        );
    }
    if has_cause {
        return Some(
            "a woken run's cause is its wake's, stored when the change was admitted, so the \
             request may not name another. Nothing was started."
                .into(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::usage::Usage;
    use crate::runtime::budget::{self, Reservation, Settings};
    use crate::runtime::dispatch::{self, ItemOutcome, Woken};
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
            at("2026-10-01T00:30:00Z"),
        )
        .unwrap();
        (dir, conn, vault)
    }

    fn small() -> Reservation {
        Reservation {
            total_tokens: 5_000,
            output_tokens: 1_000,
        }
    }

    fn offer(agent: &str, key: char, trigger: char, subject: &str) -> WakeOffer {
        WakeOffer {
            agent: agent.into(),
            wake_key: key.to_string().repeat(64),
            trigger: trigger.to_string().repeat(16),
            cause: CauseRequest {
                kind: "event".into(),
                subject: Some(subject.into()),
                detail: Some("it changes in records".into()),
                due_at: None,
            },
        }
    }

    /// (key, state, outcome, reason, detail) for every wake, in admission
    /// order.
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );

    fn rows(conn: &Connection) -> Vec<Row> {
        let mut statement = conn
            .prepare(
                "SELECT wake_key, state, outcome, reason, detail FROM agent_wakes ORDER BY rowid",
            )
            .unwrap();
        let rows = statement
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    fn id_of(conn: &Connection, key: &str) -> String {
        conn.query_row(
            "SELECT wake_id FROM agent_wakes WHERE wake_key = ?1 ORDER BY rowid DESC LIMIT 1",
            [key],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn live(rows: &[Row]) -> Vec<(&str, &str)> {
        rows.iter()
            .map(|(key, state, ..)| (&key[..1], state.as_str()))
            .collect()
    }

    #[test]
    fn admission_ignores_a_live_key_and_admits_it_again_once_finished() {
        let (dir, conn, vault) = fixture("wakes-live-key");
        let now = at("2026-10-13T09:00:00Z");
        let a = offer("process:scout", 'a', '1', "records/a.md");
        let first = admit(&conn, &vault, std::slice::from_ref(&a), now).unwrap();
        assert_eq!((first.admitted, first.live), (1, 0));
        let again = admit(&conn, &vault, std::slice::from_ref(&a), now).unwrap();
        assert_eq!(
            (again.admitted, again.live),
            (0, 1),
            "a live key is ignored"
        );
        let id = id_of(&conn, &"a".repeat(64));
        assert!(cancel_one(&conn, &id, EXPIRED, None, now).unwrap());
        let later = admit(&conn, &vault, &[a], now).unwrap();
        assert_eq!(
            (later.admitted, later.live),
            (1, 0),
            "a finished key wakes again"
        );
        assert_eq!(
            live(&rows(&conn)),
            vec![("a", "finished"), ("a", "pending")]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_runtime_paused_agent_admits_nothing() {
        let (dir, conn, vault) = fixture("wakes-paused-admit");
        crate::runtime::settings::set_agent_paused(&conn, &vault, "process:scout", true).unwrap();
        let report = admit(
            &conn,
            &vault,
            &[
                offer("process:scout", 'a', '1', "records/a.md"),
                offer("process:other", 'b', '1', "records/b.md"),
            ],
            at("2026-10-13T09:00:00Z"),
        )
        .unwrap();
        assert_eq!(report.admitted, 1);
        assert_eq!(
            report.refused,
            vec![AdmitRefusal {
                agent: "process:scout".into(),
                reason: PAUSED.into()
            }]
        );
        assert_eq!(live(&rows(&conn)), vec![("b", "pending")]);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_offers_are_refused_one_by_one() {
        let (dir, conn, vault) = fixture("wakes-malformed");
        let good = offer("process:scout", 'a', '1', "records/a.md");
        let mut bad_agent = good.clone();
        bad_agent.agent = "process:Scout".into();
        let mut no_handle = good.clone();
        no_handle.agent = "process:".into();
        let mut short_key = good.clone();
        short_key.wake_key = "a".repeat(63);
        let mut upper_key = good.clone();
        upper_key.wake_key = "A".repeat(64);
        let mut bad_trigger = good.clone();
        bad_trigger.trigger = "g".repeat(16);
        let mut schedule = good.clone();
        schedule.cause.kind = "schedule".into();
        let mut handoff = good.clone();
        handoff.cause.kind = "handoff".into();
        let report = admit(
            &conn,
            &vault,
            &[
                bad_agent,
                no_handle,
                short_key,
                good,
                upper_key,
                bad_trigger,
                schedule,
                handoff,
            ],
            at("2026-10-13T09:00:00Z"),
        )
        .unwrap();
        assert_eq!(report.admitted, 1, "the good one still lands");
        assert_eq!(report.refused.len(), 7);
        assert!(report.refused.iter().all(|r| r.reason == MALFORMED));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_lists_oldest_first_and_leaves_out_the_expired() {
        let (dir, conn, vault) = fixture("wakes-pending");
        admit(
            &conn,
            &vault,
            &[offer("process:scout", 'c', '1', "c")],
            at("2026-10-05T09:00:00Z"),
        )
        .unwrap();
        admit(
            &conn,
            &vault,
            &[offer("process:scout", 'b', '1', "b")],
            at("2026-10-12T09:00:00Z"),
        )
        .unwrap();
        admit(
            &conn,
            &vault,
            &[offer("process:scout", 'a', '1', "a")],
            at("2026-10-12T09:00:00Z"),
        )
        .unwrap();
        let ro = ReadOnly::open(&dir).unwrap();
        let listed = pending(&ro, &vault, at("2026-10-13T09:00:00Z")).unwrap();
        let keys: Vec<&str> = listed.iter().map(|w| &w.wake_key[..1]).collect();
        assert_eq!(
            keys,
            vec!["b", "a"],
            "oldest first, ties by admission; c expired"
        );
        assert_eq!(listed[0].cause["subject"], "b");
        assert_eq!(listed[0].not_before, None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expire_cancels_pending_past_the_ttl() {
        let (dir, conn, vault) = fixture("wakes-expire");
        admit(
            &conn,
            &vault,
            &[offer("process:scout", 'a', '1', "a")],
            at("2026-10-01T09:00:00Z"),
        )
        .unwrap();
        admit(
            &conn,
            &vault,
            &[offer("process:scout", 'b', '1', "b")],
            at("2026-10-07T09:00:00Z"),
        )
        .unwrap();
        assert_eq!(
            expire(&conn, &vault, at("2026-10-08T09:00:00Z")).unwrap(),
            1
        );
        let rows = rows(&conn);
        assert_eq!(rows[0].2.as_deref(), Some("cancelled"));
        assert_eq!(rows[0].3.as_deref(), Some(EXPIRED));
        assert_eq!(rows[0].4, None);
        assert_eq!(rows[1].1, "pending");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_touches_only_pending_wakes_and_names_why() {
        let (dir, conn, vault) = fixture("wakes-cancel");
        let now = at("2026-10-13T09:00:00Z");
        admit(
            &conn,
            &vault,
            &[
                offer("process:scout", 'a', '1', "a"),
                offer("process:scout", 'b', '1', "b"),
            ],
            now,
        )
        .unwrap();
        let a = id_of(&conn, &"a".repeat(64));
        let b = id_of(&conn, &"b".repeat(64));
        assert!(cancel_one(&conn, &b, EXPIRED, None, now).unwrap());
        let cancelled = cancel(
            &conn,
            &vault,
            &[
                WakeCancel {
                    wake_id: a.clone(),
                    why: "trigger_changed".into(),
                },
                WakeCancel {
                    wake_id: b,
                    why: "page_gone".into(),
                },
            ],
            now,
        )
        .unwrap();
        assert_eq!(cancelled, 1, "the finished wake is left alone");
        let rows = rows(&conn);
        assert_eq!(rows[0].3.as_deref(), Some(SUPERSEDED));
        assert_eq!(rows[0].4.as_deref(), Some("trigger_changed"));
        assert_eq!(rows[1].3.as_deref(), Some(EXPIRED));
        // Another vault's id is not this vault's to cancel.
        admit(&conn, &vault, &[offer("process:scout", 'c', '1', "c")], now).unwrap();
        let c = id_of(&conn, &"c".repeat(64));
        let other = cancel(
            &conn,
            &"e".repeat(32),
            &[WakeCancel {
                wake_id: c,
                why: "page_gone".into(),
            }],
            now,
        )
        .unwrap();
        assert_eq!(other, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_cancel_why_writes_nothing() {
        let (dir, conn, vault) = fixture("wakes-cancel-why");
        let now = at("2026-10-13T09:00:00Z");
        admit(&conn, &vault, &[offer("process:scout", 'a', '1', "a")], now).unwrap();
        let a = id_of(&conn, &"a".repeat(64));
        let err = cancel(
            &conn,
            &vault,
            &[
                WakeCancel {
                    wake_id: a.clone(),
                    why: "paused".into(),
                },
                WakeCancel {
                    wake_id: a,
                    why: "bored".into(),
                },
            ],
            now,
        )
        .unwrap_err();
        assert!(err.contains("\"bored\""), "{err}");
        assert_eq!(live(&rows(&conn)), vec![("a", "pending")]);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pausing_an_agent_cancels_only_its_pending_wakes() {
        let (dir, conn, vault) = fixture("wakes-pause");
        let now = at("2026-10-13T09:00:00Z");
        admit(
            &conn,
            &vault,
            &[
                offer("process:scout", 'a', '1', "a"),
                offer("process:other", 'b', '1', "b"),
            ],
            now,
        )
        .unwrap();
        pause_agent(&conn, &vault, "process:scout", true, now).unwrap();
        assert!(crate::runtime::settings::agent_paused(&conn, &vault, "process:scout").unwrap());
        let rows = rows(&conn);
        assert_eq!(rows[0].1, "finished");
        assert_eq!(rows[0].4.as_deref(), Some("paused"));
        assert_eq!(rows[1].1, "pending", "another agent's wake waits on");
        pause_agent(&conn, &vault, "process:scout", false, now).unwrap();
        assert!(!crate::runtime::settings::agent_paused(&conn, &vault, "process:scout").unwrap());
        assert!(pause_agent(&conn, &vault, " ", true, now).is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finish_for_run_maps_every_run_outcome() {
        for (outcome, word) in [
            (RunOutcome::Succeeded, "succeeded"),
            (RunOutcome::Failed, "failed"),
            (RunOutcome::QuotaFailed, "failed"),
            (RunOutcome::ElapsedAborted, "failed"),
            (RunOutcome::Cancelled, "interrupted"),
            (RunOutcome::AbandonedUsageUnknown, "interrupted"),
        ] {
            assert_eq!(outcome_of(outcome), word, "{outcome:?}");
            assert_eq!(run_outcome_named(outcome.as_str()), Some(outcome));
        }
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let (dir, conn, vault) = fixture("wakes-finish");
        let now = at("2026-10-13T09:00:00Z");
        admit(&conn, &vault, &[offer("process:scout", 'a', '1', "a")], now).unwrap();
        let a = id_of(&conn, &"a".repeat(64));
        let woken = dispatch::claim_woken(
            &conn,
            &vault,
            "store",
            "agent",
            small(),
            "process:scout",
            &WakeRequest {
                claim: a,
                coalesce: vec![],
            },
            now,
        )
        .unwrap();
        let Woken::Started { lease, .. } = woken else {
            panic!("{woken:?}");
        };
        dispatch::finalize(
            &conn,
            &lease.run_id,
            RunOutcome::ElapsedAborted,
            Some(Usage::default()),
            None,
            ItemOutcome::Requeue,
            now,
        )
        .unwrap();
        assert_eq!(rows(&conn)[0].2.as_deref(), Some("failed"));
        drop(conn);
        crate::runtime::status::clear();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_closes_a_started_wake_whose_run_has_ended() {
        let _lock = crate::runtime::status::test_lock();
        crate::runtime::status::clear();
        let (dir, conn, vault) = fixture("wakes-reconcile");
        let now = at("2026-10-13T09:00:00Z");
        admit(&conn, &vault, &[offer("process:scout", 'a', '1', "a")], now).unwrap();
        let a = id_of(&conn, &"a".repeat(64));
        let Woken::Started { lease, .. } = dispatch::claim_woken(
            &conn,
            &vault,
            "store",
            "agent",
            small(),
            "process:scout",
            &WakeRequest {
                claim: a,
                coalesce: vec![],
            },
            now,
        )
        .unwrap() else {
            panic!("not started");
        };
        assert_eq!(reconcile_started(&conn, now).unwrap(), 0, "its run is live");
        // A run ended by a path that did not finish its wake.
        conn.execute(
            "UPDATE runs SET outcome = 'cancelled', ended_at = ?2 WHERE run_id = ?1",
            rusqlite::params![lease.run_id, stamp(now)],
        )
        .unwrap();
        assert_eq!(reconcile_started(&conn, now).unwrap(), 1);
        assert_eq!(rows(&conn)[0].2.as_deref(), Some("interrupted"));
        drop(conn);
        crate::runtime::status::clear();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuse_request_names_each_mistake() {
        let ok = refuse_request(false, Some("agent"), Some("process:scout"), false);
        assert_eq!(ok, None);
        let attended = refuse_request(true, Some("agent"), Some("process:scout"), false).unwrap();
        assert!(attended.contains("unattended"), "{attended}");
        let lane = refuse_request(false, Some("scheduled"), Some("process:scout"), false).unwrap();
        assert!(lane.contains("\"scheduled\""), "{lane}");
        let none = refuse_request(false, None, Some("process:scout"), false).unwrap();
        assert!(none.contains("None"), "{none}");
        let actor = refuse_request(false, Some("agent"), None, false).unwrap();
        assert!(actor.contains("process:"), "{actor}");
        let cause = refuse_request(false, Some("agent"), Some("process:scout"), true).unwrap();
        assert!(cause.contains("cause"), "{cause}");
        for words in [attended, lane, actor, cause] {
            assert!(words.ends_with("Nothing was started."), "{words}");
        }
    }

    #[test]
    fn every_reason_and_detail_has_words() {
        for why in CancelWhy::ALL {
            let said = words(Some("cancelled"), Some(SUPERSEDED), Some(why.as_str()));
            assert_eq!(said, why.words());
            assert!(said.starts_with("cancelled — "), "{said}");
            assert!(!said.contains(UNNAMED_WORDS), "{said}");
        }
        let expired = words(Some("cancelled"), Some(EXPIRED), None);
        assert_eq!(
            expired,
            format!("expired — waited more than {WAKE_TTL_DAYS} days")
        );
        assert_eq!(expired, "expired — waited more than 7 days");
        assert_eq!(words(None, None, None), WAITING_WORDS);
    }

    #[test]
    fn an_unknown_reason_reads_as_unnamed() {
        assert_eq!(
            words(Some("skipped"), Some("cycle"), None),
            "skipped (or cancelled) for a reason this version does not name (cycle)"
        );
        assert_eq!(
            words(Some("cancelled"), Some(SUPERSEDED), Some("renamed")),
            "skipped (or cancelled) for a reason this version does not name (superseded: renamed)"
        );
        assert_eq!(
            words(Some("cancelled"), None, None),
            "skipped (or cancelled) for a reason this version does not name (not recorded)"
        );
    }

    // --- the shared cases ---------------------------------------------------

    const CASES: &str = include_str!("../../fixtures/wake-cases.json");

    #[test]
    fn the_shared_wake_cases_hold_this_modules_numbers() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        assert_eq!(cases["ttl_days"], WAKE_TTL_DAYS);
        assert_eq!(cases["coalesce_max"], COALESCE_MAX);
        assert_eq!(cases["busy_retry_secs"], BUSY_RETRY_SECS);
        assert_eq!(cases["budget_retry_secs"], BUDGET_RETRY_SECS);
        let whys: Vec<&str> = cases["cancel_whys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_str().unwrap())
            .collect();
        assert_eq!(whys, CancelWhy::ALL.map(CancelWhy::as_str).to_vec());
    }

    fn finish_named(raw: &str) -> RunOutcome {
        run_outcome_named(raw).unwrap_or_else(|| panic!("no run outcome {raw}"))
    }

    #[test]
    fn the_shared_wake_cases_replay() {
        let _lock = crate::runtime::status::test_lock();
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        for scenario in cases["scenarios"].as_array().unwrap() {
            crate::runtime::status::clear();
            let why = scenario["why"].as_str().unwrap();
            let (dir, conn, vault) = fixture("wakes-cases");
            // The run each started wake's claim opened, by wake key.
            let mut runs = std::collections::HashMap::<String, String>::new();
            for (n, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                let here = format!("{why}, step {n}");
                let now = step["at"]
                    .as_str()
                    .map(at)
                    .unwrap_or_else(|| at("2026-10-13T09:00:00Z"));
                let expect = &step["expect"];
                match step["op"].as_str().unwrap() {
                    "admit" => {
                        let offers: Vec<WakeOffer> =
                            serde_json::from_value(step["offers"].clone()).unwrap();
                        let report = admit(&conn, &vault, &offers, now).unwrap();
                        assert_eq!(serde_json::to_value(&report).unwrap(), *expect, "{here}");
                    }
                    "pause" => {
                        pause_agent(
                            &conn,
                            &vault,
                            step["agent"].as_str().unwrap(),
                            step["paused"].as_bool().unwrap(),
                            now,
                        )
                        .unwrap();
                    }
                    "expire" => {
                        let n = expire(&conn, &vault, now).unwrap();
                        assert_eq!(n as u64, expect["expired"].as_u64().unwrap(), "{here}");
                    }
                    "cancel" => {
                        let cancels: Vec<WakeCancel> = step["cancels"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|c| WakeCancel {
                                wake_id: id_of(&conn, c["wake"].as_str().unwrap()),
                                why: c["why"].as_str().unwrap().into(),
                            })
                            .collect();
                        let answer = cancel(&conn, &vault, &cancels, now);
                        if expect["error"] == true {
                            assert!(answer.is_err(), "{here}");
                        } else {
                            assert_eq!(
                                answer.unwrap() as u64,
                                expect["cancelled"].as_u64().unwrap(),
                                "{here}"
                            );
                        }
                    }
                    "claim" => {
                        let key = step["wake"].as_str().unwrap();
                        let request = WakeRequest {
                            claim: id_of(&conn, key),
                            coalesce: step["coalesce"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|k| id_of(&conn, k.as_str().unwrap()))
                                .collect(),
                        };
                        let answer = dispatch::claim_woken(
                            &conn,
                            &vault,
                            "store",
                            "agent",
                            small(),
                            step["agent"].as_str().unwrap(),
                            &request,
                            now,
                        );
                        if expect["error"] == true {
                            assert!(answer.is_err(), "{here}: {answer:?}");
                            continue;
                        }
                        match answer.unwrap() {
                            Woken::Started { lease, cause, also } => {
                                let started = &expect["started"];
                                assert!(started.is_object(), "{here}: started, expected {expect}");
                                assert_eq!(
                                    cause.map(|c| serde_json::from_str::<serde_json::Value>(
                                        &c.to_column()
                                    )
                                    .unwrap()),
                                    Some(started["cause"].clone()),
                                    "{here}"
                                );
                                let subjects: Vec<serde_json::Value> = also
                                    .iter()
                                    .map(|c| {
                                        serde_json::from_str::<serde_json::Value>(&c.to_column())
                                            .unwrap()["subject"]
                                            .clone()
                                    })
                                    .collect();
                                assert_eq!(
                                    serde_json::Value::Array(subjects),
                                    started["also"],
                                    "{here}"
                                );
                                runs.insert(key.to_string(), lease.run_id);
                            }
                            Woken::Deferred(reasons) => {
                                assert_eq!(
                                    serde_json::to_value(&reasons).unwrap(),
                                    expect["deferred"],
                                    "{here}"
                                );
                            }
                            Woken::Gone => assert_eq!(expect, "gone", "{here}"),
                        }
                    }
                    "finish" => {
                        let key = step["wake"].as_str().unwrap();
                        let run = runs.get(key).unwrap_or_else(|| panic!("{here}: no run"));
                        dispatch::finalize(
                            &conn,
                            run,
                            finish_named(step["outcome"].as_str().unwrap()),
                            Some(Usage::default()),
                            None,
                            ItemOutcome::Consume,
                            now,
                        )
                        .unwrap();
                    }
                    "pending" => {
                        let ro = ReadOnly::open(&dir).unwrap();
                        let listed: Vec<serde_json::Value> = pending(&ro, &vault, now)
                            .unwrap()
                            .into_iter()
                            .map(|w| {
                                serde_json::json!({
                                    "wakeKey": w.wake_key,
                                    "notBefore": w.not_before,
                                    "deferred": w.deferred,
                                })
                            })
                            .collect();
                        assert_eq!(serde_json::Value::Array(listed), *expect, "{here}");
                    }
                    "rows" => {
                        let listed: Vec<serde_json::Value> = rows(&conn)
                            .into_iter()
                            .map(|(key, state, outcome, reason, detail)| {
                                serde_json::json!({
                                    "wakeKey": key,
                                    "state": state,
                                    "outcome": outcome,
                                    "reason": reason,
                                    "detail": detail,
                                })
                            })
                            .collect();
                        assert_eq!(serde_json::Value::Array(listed), *expect, "{here}");
                    }
                    other => panic!("{here}: unknown op {other}"),
                }
            }
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
        crate::runtime::status::clear();
    }
}
