//! A run may book one later run of its own agent (M63.8). The runtime row,
//! never an Agent file, owns the booking, claim and one firing. Rust and the
//! browser replay `src-tauri/fixtures/followup-cases.json` for every boundary.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use super::cause;

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub const WAITING_CAP: usize = 3;
pub const CLAIM_MINUTES: i64 = 10;
pub const CANCEL_DAYS: i64 = 7;
pub const OWN_RUN: &str = "Only an agent's own run can book a follow-up, and only for itself.";
pub const RUNTIME_NEEDED: &str = "Follow-ups need the runtime database, which is not open.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Claimed,
    Fired,
    Cancelled,
}

impl State {
    pub const ALL: [Self; 4] = [Self::Pending, Self::Claimed, Self::Fired, Self::Cancelled];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Fired => "fired",
            Self::Cancelled => "cancelled",
        }
    }

    fn read(value: &str) -> rusqlite::Result<Self> {
        Self::ALL
            .into_iter()
            .find(|s| s.as_str() == value)
            .ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    format!("unknown follow-up state {value}").into(),
                )
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    Person,
    AgentGone,
    Paused,
}

impl CancelReason {
    pub const ALL: [Self; 3] = [Self::Person, Self::AgentGone, Self::Paused];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::AgentGone => "agent_gone",
            Self::Paused => "paused",
        }
    }

    pub fn words(self) -> &'static str {
        match self {
            Self::Person => "cancelled by you",
            Self::AgentGone => "its agent is gone",
            Self::Paused => "its agent was paused when it came due",
        }
    }

    fn read(value: &str) -> rusqlite::Result<Self> {
        Self::ALL
            .into_iter()
            .find(|s| s.as_str() == value)
            .ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    10,
                    rusqlite::types::Type::Text,
                    format!("unknown follow-up cancellation {value}").into(),
                )
            })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Followup {
    pub followup_id: String,
    pub actor: String,
    pub note: String,
    pub due_at: String,
    pub requested_at: String,
    pub requested_by_run: String,
    pub state: State,
    pub claimed_at: Option<String>,
    pub run_id: Option<String>,
    pub ended_at: Option<String>,
    pub cancel_reason: Option<CancelReason>,
}

impl Followup {
    pub fn cause(&self) -> cause::RunCause {
        cause::RunCause::followup(&self.note, &self.due_at)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Active,
    Gone,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FollowupClaim {
    Claimed { row: Box<Followup> },
    NotWaiting,
    Cancelled { reason: CancelReason },
}

#[derive(Debug, Serialize)]
pub struct Booked {
    pub row: Followup,
    pub waiting: usize,
}

const SELECT: &str = "SELECT followup_id, actor, note, due_at, requested_at, \
    requested_by_run, state, claimed_at, run_id, ended_at, cancel_reason \
    FROM agent_followups";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Followup> {
    Ok(Followup {
        followup_id: r.get(0)?,
        actor: r.get(1)?,
        note: r.get(2)?,
        due_at: r.get(3)?,
        requested_at: r.get(4)?,
        requested_by_run: r.get(5)?,
        state: State::read(&r.get::<_, String>(6)?)?,
        claimed_at: r.get(7)?,
        run_id: r.get(8)?,
        ended_at: r.get(9)?,
        cancel_reason: r
            .get::<_, Option<String>>(10)?
            .as_deref()
            .map(CancelReason::read)
            .transpose()?,
    })
}

fn db_error(e: rusqlite::Error) -> String {
    format!("Follow-ups could not be read or written: {e}")
}

pub(crate) fn get(conn: &Connection, vault: &str, id: &str) -> Result<Option<Followup>, String> {
    conn.query_row(
        &format!("{SELECT} WHERE vault_id=?1 AND followup_id=?2"),
        params![vault, id],
        row,
    )
    .optional()
    .map_err(db_error)
}

fn checked(at: &str, note: &str, now: DateTime<Utc>) -> Result<(String, String), String> {
    const NOTE: &str = "A follow-up needs a note of 1 to 500 characters.";
    if !(1..=500).contains(&note.chars().count()) {
        return Err(NOTE.into());
    }
    let note = cause::clean(Some(note), 500).ok_or(NOTE)?;
    // The shared date reader rejects impossible dates, leap seconds and
    // unsupported precision; RFC 3339 additionally needs seconds and its T
    // separator. This is the same strict reader the browser mock uses.
    if !matches!(at.as_bytes().get(10), Some(b'T' | b't'))
        || !crate::vault::dates::is_date_text(&serde_json::Value::String(at.to_uppercase()))
    {
        return Err("Use an RFC 3339 time with an offset for the follow-up.".into());
    }
    let due = DateTime::parse_from_rfc3339(at)
        .map_err(|_| "Use an RFC 3339 time with an offset for the follow-up.")?
        .with_timezone(&Utc);
    if due < now + Duration::minutes(5) {
        return Err("A follow-up must be at least 5 minutes from now.".into());
    }
    if due > now + Duration::days(30) {
        return Err("A follow-up can be at most 30 days from now.".into());
    }
    Ok((stamp(due), note))
}

/// Cap and insert share one write transaction, including across windows.
pub fn schedule(
    conn: &Connection,
    vault: &str,
    actor: &str,
    requesting_run: &str,
    at: &str,
    note: &str,
    now: DateTime<Utc>,
) -> Result<Booked, String> {
    if actor.strip_prefix("process:").is_none_or(str::is_empty)
        || actor.chars().count() > 128
        || requesting_run.is_empty()
    {
        return Err(OWN_RUN.into());
    }
    let (due, note) = checked(at, note, now)?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db_error)?;
    let waiting = {
        let mut q = tx.prepare(&format!("{SELECT} WHERE vault_id=?1 AND actor=?2 AND state IN ('pending','claimed') ORDER BY due_at,followup_id")).map_err(db_error)?;
        let rows = q
            .query_map(params![vault, actor], row)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    if waiting.len() >= WAITING_CAP {
        let items = waiting
            .iter()
            .map(|r| {
                let start = cause::clean(Some(&r.note), 80).unwrap_or_default();
                format!(
                    "- {}: {}",
                    r.due_at,
                    serde_json::to_string(&start).expect("text serializes")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("You already have 3 follow-ups waiting:\n{items}"));
    }
    let id = crate::ledger::new_run_id();
    tx.execute("INSERT INTO agent_followups (followup_id,vault_id,actor,note,due_at,requested_at,requested_by_run,state) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')",
        params![id,vault,actor,note,due,stamp(now),requesting_run]).map_err(db_error)?;
    let row = get(&tx, vault, &id)?.ok_or("The follow-up was not recorded.")?;
    tx.commit().map_err(db_error)?;
    Ok(Booked {
        row,
        waiting: waiting.len() + 1,
    })
}

/// Waiting rows and Cerebro's recent cancellations. A failed read is Err,
/// never an empty list. Person cancellations and completed firings stay off
/// this operational queue, while their durable rows remain intact.
pub fn list(
    conn: &super::ReadOnly,
    vault: &str,
    now: DateTime<Utc>,
) -> Result<Vec<Followup>, String> {
    let mut q = conn.prepare(&format!("{SELECT} WHERE vault_id=?1 AND (state IN ('pending','claimed') OR (state='cancelled' AND cancel_reason IN ('agent_gone','paused') AND ended_at>=?2)) ORDER BY due_at,followup_id")).map_err(db_error)?;
    let rows = q
        .query_map(
            params![vault, stamp(now - Duration::days(CANCEL_DAYS))],
            row,
        )
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error);
    rows
}

/// The conditional UPDATE is the claim: only the winner gets a row. Check
/// eligibility before cancelling, so a pause never takes another window's
/// fresh claim, and a future follow-up is judged only when it is due.
pub fn claim(
    conn: &Connection,
    vault: &str,
    id: &str,
    standing: Standing,
    now: DateTime<Utc>,
) -> Result<FollowupClaim, String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db_error)?;
    let stamp_now = stamp(now);
    let stale = stamp(now - Duration::minutes(CLAIM_MINUTES));
    let predicate = "vault_id=?1 AND followup_id=?2 AND due_at<=?3 AND (state='pending' OR (state='claimed' AND claimed_at<=?4))";
    let reason = match standing {
        Standing::Active => None,
        Standing::Gone => Some(CancelReason::AgentGone),
        Standing::Paused => Some(CancelReason::Paused),
    };
    let n = if let Some(reason) = reason {
        tx.execute(&format!("UPDATE agent_followups SET state='cancelled',claimed_at=NULL,ended_at=?3,cancel_reason=?5 WHERE {predicate}"), params![vault,id,stamp_now,stale,reason.as_str()])
    } else {
        tx.execute(&format!("UPDATE agent_followups SET state='claimed',claimed_at=?3 WHERE {predicate}"), params![vault,id,stamp_now,stale])
    }.map_err(db_error)?;
    let answer = if n == 0 {
        FollowupClaim::NotWaiting
    } else if let Some(reason) = reason {
        FollowupClaim::Cancelled { reason }
    } else {
        FollowupClaim::Claimed {
            row: Box::new(get(&tx, vault, id)?.ok_or("The claimed follow-up is unavailable.")?),
        }
    };
    tx.commit().map_err(db_error)?;
    Ok(answer)
}

/// Bind a top-level run request to its claimed row, including actor and
/// vault. The cause comes from this returned row, never renderer values.
pub fn ready_to_fire(
    conn: &Connection,
    vault: &str,
    actor: &str,
    id: &str,
    now: DateTime<Utc>,
) -> Result<Option<Followup>, String> {
    conn.query_row(&format!("{SELECT} WHERE vault_id=?1 AND actor=?2 AND followup_id=?3 AND state='claimed' AND due_at<=?4"),params![vault,actor,id,stamp(now)],row).optional().map_err(db_error)
}

/// Only a claimed row can fire. A second start may have booked a lease but
/// cannot spawn: it must close that unused lease when this answers false.
pub fn fire(
    conn: &Connection,
    vault: &str,
    actor: &str,
    id: &str,
    run: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    conn.execute("UPDATE agent_followups SET state='fired',run_id=?5,ended_at=?6 WHERE vault_id=?1 AND actor=?2 AND followup_id=?3 AND state='claimed' AND due_at<=?4",
        params![vault,actor,id,stamp(now),run,stamp(now)]).map(|n|n!=0).map_err(db_error)
}

pub fn release(conn: &Connection, vault: &str, actor: &str, id: &str) -> Result<bool, String> {
    conn.execute("UPDATE agent_followups SET state='pending',claimed_at=NULL WHERE vault_id=?1 AND actor=?2 AND followup_id=?3 AND state='claimed'",params![vault,actor,id]).map(|n|n!=0).map_err(db_error)
}

/// A spawn refusal restores exactly the firing this invocation wrote.
pub fn unfire(conn: &Connection, vault: &str, id: &str, run: &str) -> Result<bool, String> {
    conn.execute("UPDATE agent_followups SET state='pending',claimed_at=NULL,run_id=NULL,ended_at=NULL WHERE vault_id=?1 AND followup_id=?2 AND run_id=?3 AND state='fired'",params![vault,id,run]).map(|n|n!=0).map_err(db_error)
}

/// A person may cancel only a row no window has begun starting.
pub fn cancel(
    conn: &Connection,
    vault: &str,
    id: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    conn.execute("UPDATE agent_followups SET state='cancelled',ended_at=?3,cancel_reason='person' WHERE vault_id=?1 AND followup_id=?2 AND state='pending'",params![vault,id,stamp(now)]).map(|n|n!=0).map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{runtime, vault::testutil};
    use serde_json::{json, Value};

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn setup(label: &str) -> (std::path::PathBuf, Connection, String) {
        let dir = testutil::temp_vault(label);
        let conn = runtime::open(&dir).unwrap();
        let vault = runtime::scope::register(&conn, &dir).unwrap();
        (dir, conn, vault)
    }

    fn book(conn: &Connection, vault: &str, now: DateTime<Utc>) -> Followup {
        schedule(
            conn,
            vault,
            "process:scout",
            "requesting-run",
            &stamp(now + Duration::minutes(5)),
            "Check the reply",
            now,
        )
        .unwrap()
        .row
    }

    #[test]
    fn replays_the_shared_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/followup-cases.json")).unwrap();
        let now = at(cases["defaults"]["now"].as_str().unwrap());
        for c in cases["schedule"].as_array().unwrap() {
            let (dir, conn, vault) = setup("followup-case");
            let result = schedule(
                &conn,
                &vault,
                cases["defaults"]["actor"].as_str().unwrap(),
                cases["defaults"]["run"].as_str().unwrap(),
                c["at"].as_str().unwrap(),
                c["note"].as_str().unwrap(),
                now,
            );
            let actual = match result {
                Ok(b) => json!({"dueAt":b.row.due_at,"note":b.row.note}),
                Err(error) => json!({"error":error}),
            };
            assert_eq!(actual, c["expect"], "{}", c["name"]);
            std::fs::remove_dir_all(dir).unwrap();
        }
        for c in cases["claims"].as_array().unwrap() {
            let (dir, conn, vault) = setup("followup-claim-case");
            let row = book(&conn, &vault, now - Duration::minutes(5));
            let state = c["state"].as_str().unwrap();
            let terminal = matches!(state, "fired" | "cancelled");
            conn.execute("UPDATE agent_followups SET due_at=?2,state=?3,claimed_at=?4,run_id=?5,ended_at=?6,cancel_reason=?7 WHERE followup_id=?1",params![row.followup_id,c["dueAt"].as_str().unwrap(),state,c["claimedAt"].as_str(),(state=="fired").then_some("firing-run"),terminal.then(||stamp(now)),(state=="cancelled").then_some("person")]).unwrap();
            let standing = match c["standing"].as_str().unwrap() {
                "active" => Standing::Active,
                "gone" => Standing::Gone,
                "paused" => Standing::Paused,
                _ => unreachable!(),
            };
            let answer = claim(&conn, &vault, &row.followup_id, standing, now).unwrap();
            let actual = match answer {
                FollowupClaim::Claimed { .. } => "claimed",
                FollowupClaim::NotWaiting => "not_waiting",
                FollowupClaim::Cancelled { reason } => reason.as_str(),
            };
            assert_eq!(actual, c["expect"], "{}", c["name"]);
            std::fs::remove_dir_all(dir).unwrap();
        }
        let (dir, conn, vault) = setup("followup-cap-case");
        let cap = &cases["cap"];
        for i in 1..=3 {
            let booked = schedule(
                &conn,
                &vault,
                "process:scout",
                "run",
                cap["at"].as_str().unwrap(),
                cap["note"].as_str().unwrap(),
                now,
            )
            .unwrap();
            assert_eq!(booked.waiting, i);
        }
        assert_eq!(
            schedule(
                &conn,
                &vault,
                "process:scout",
                "run",
                cap["at"].as_str().unwrap(),
                cap["note"].as_str().unwrap(),
                now
            )
            .unwrap_err(),
            cap["expected"]
        );
        for reason in CancelReason::ALL {
            assert_eq!(reason.words(), cases["cancelWords"][reason.as_str()]);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_cap_is_per_agent_and_vault_and_includes_claims() {
        let (dir, conn, vault) = setup("followup-cap");
        let now = at("2026-10-15T12:00:00Z");
        for _ in 0..3 {
            let row = book(&conn, &vault, now);
            claim(
                &conn,
                &vault,
                &row.followup_id,
                Standing::Active,
                now + Duration::minutes(5),
            )
            .unwrap();
        }
        assert!(schedule(
            &conn,
            &vault,
            "process:scout",
            "run",
            &stamp(now + Duration::hours(1)),
            "Fourth",
            now
        )
        .unwrap_err()
        .starts_with("You already have 3"));
        schedule(
            &conn,
            &vault,
            "process:other",
            "run",
            &stamp(now + Duration::hours(1)),
            "Other",
            now,
        )
        .unwrap();
        let other = runtime::scope::register(&conn, &dir.join("other")).unwrap();
        book(&conn, &other, now);
        assert_eq!(
            list(&runtime::ReadOnly::open(&dir).unwrap(), &vault, now)
                .unwrap()
                .len(),
            4
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn release_and_fire_are_conditional_and_spawn_refusal_unfires_only_its_run() {
        let (dir, conn, vault) = setup("followup-fire");
        let then = at("2026-10-15T12:00:00Z");
        let row = book(&conn, &vault, then);
        let now = then + Duration::minutes(5);
        assert!(
            ready_to_fire(&conn, &vault, &row.actor, &row.followup_id, now)
                .unwrap()
                .is_none()
        );
        assert!(!fire(&conn, &vault, &row.actor, &row.followup_id, "run", now).unwrap());
        assert!(matches!(
            claim(&conn, &vault, &row.followup_id, Standing::Active, now).unwrap(),
            FollowupClaim::Claimed { .. }
        ));
        assert!(release(&conn, &vault, &row.actor, &row.followup_id).unwrap());
        assert!(!release(&conn, &vault, &row.actor, &row.followup_id).unwrap());
        claim(&conn, &vault, &row.followup_id, Standing::Active, now).unwrap();
        assert!(
            ready_to_fire(&conn, &vault, "process:other", &row.followup_id, now)
                .unwrap()
                .is_none()
        );
        assert!(
            ready_to_fire(&conn, &vault, &row.actor, &row.followup_id, now)
                .unwrap()
                .is_some()
        );
        assert!(fire(&conn, &vault, &row.actor, &row.followup_id, "run", now).unwrap());
        assert!(!fire(&conn, &vault, &row.actor, &row.followup_id, "other", now).unwrap());
        assert!(!release(&conn, &vault, &row.actor, &row.followup_id).unwrap());
        assert!(!unfire(&conn, &vault, &row.followup_id, "other").unwrap());
        assert!(unfire(&conn, &vault, &row.followup_id, "run").unwrap());
        let reset = get(&conn, &vault, &row.followup_id).unwrap().unwrap();
        assert_eq!(reset.state, State::Pending);
        assert_eq!(
            (reset.claimed_at, reset.run_id, reset.ended_at),
            (None, None, None)
        );
        assert!(!unfire(&conn, &vault, &row.followup_id, "run").unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_person_cancels_only_a_waiting_followup() {
        let (dir, conn, vault) = setup("followup-cancel");
        let now = at("2026-10-15T12:00:00Z");
        let first = book(&conn, &vault, now);
        assert!(cancel(&conn, &vault, &first.followup_id, now).unwrap());
        assert!(!cancel(&conn, &vault, &first.followup_id, now).unwrap());
        let second = book(&conn, &vault, now - Duration::minutes(5));
        claim(&conn, &vault, &second.followup_id, Standing::Active, now).unwrap();
        assert!(!cancel(&conn, &vault, &second.followup_id, now).unwrap());
        assert_eq!(
            get(&conn, &vault, &first.followup_id)
                .unwrap()
                .unwrap()
                .cancel_reason,
            Some(CancelReason::Person)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_list_keeps_seven_days_of_cerebro_cancels_and_never_person_cancels() {
        let (dir, conn, vault) = setup("followup-list");
        let now = at("2026-10-15T12:00:00Z");
        for (reason, ended) in [
            (Standing::Gone, now - Duration::days(7)),
            (
                Standing::Paused,
                now - Duration::days(7) - Duration::milliseconds(1),
            ),
            (Standing::Paused, now),
        ] {
            let row = book(&conn, &vault, ended - Duration::minutes(5));
            claim(&conn, &vault, &row.followup_id, reason, ended).unwrap();
        }
        let person = book(&conn, &vault, now);
        cancel(&conn, &vault, &person.followup_id, now).unwrap();
        let fired = book(&conn, &vault, now - Duration::minutes(5));
        claim(&conn, &vault, &fired.followup_id, Standing::Active, now).unwrap();
        fire(&conn, &vault, &fired.actor, &fired.followup_id, "run", now).unwrap();
        let pending = book(&conn, &vault, now);
        let listed = list(&runtime::ReadOnly::open(&dir).unwrap(), &vault, now).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].cancel_reason, Some(CancelReason::AgentGone));
        assert_eq!(listed[1].cancel_reason, Some(CancelReason::Paused));
        assert_eq!(listed[2].followup_id, pending.followup_id);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unavailable_followup_queue_never_reads_as_empty() {
        let (dir, conn, vault) = setup("followup-unavailable");
        conn.execute_batch("DROP TABLE agent_followups").unwrap();
        let ro = runtime::ReadOnly::open(&dir).unwrap();
        assert!(list(&ro, &vault, at("2026-10-15T12:00:00Z")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_windows_claim_one_followup_once() {
        let (dir, conn, vault) = setup("followup-race");
        let now = at("2026-10-15T12:00:00Z");
        let row = book(&conn, &vault, now - Duration::minutes(5));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = runtime::runtime_db_path(&dir);
                let vault = vault.clone();
                let id = row.followup_id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    barrier.wait();
                    claim(&conn, &vault, &id, Standing::Active, now).unwrap()
                })
            })
            .collect();
        let answers: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            answers
                .iter()
                .filter(|a| matches!(a, FollowupClaim::Claimed { .. }))
                .count(),
            1
        );
        assert_eq!(
            answers
                .iter()
                .filter(|a| matches!(a, FollowupClaim::NotWaiting))
                .count(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_bookings_cannot_exceed_three_waiting_rows() {
        let (dir, conn, vault) = setup("followup-book-race");
        let now = at("2026-10-15T12:00:00Z");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let path = runtime::runtime_db_path(&dir);
                let vault = vault.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let conn = Connection::open(path).unwrap();
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    barrier.wait();
                    schedule(
                        &conn,
                        &vault,
                        "process:scout",
                        "run",
                        "2026-10-15T12:05:00Z",
                        "Check later",
                        now,
                    )
                })
            })
            .collect();
        let answers: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(answers.iter().filter(|a| a.is_ok()).count(), 3);
        assert!(answers
            .iter()
            .filter_map(|a| a.as_ref().err())
            .all(|e| e.starts_with("You already have 3 follow-ups waiting:")));
        assert_eq!(
            conn.query_row("SELECT count(*) FROM agent_followups", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_schema_check_lists_equal_the_closed_vocabulary() {
        let sql = runtime::schema::SCHEMA_V30;
        for (column, names) in [
            (
                "state",
                State::ALL.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            ),
            (
                "cancel_reason",
                CancelReason::ALL.iter().map(|s| s.as_str()).collect(),
            ),
        ] {
            let start = format!("{column} IN (");
            let rest = sql.split_once(&start).unwrap().1;
            let actual: Vec<_> = rest
                .split_once(')')
                .unwrap()
                .0
                .split(',')
                .map(|s| s.trim().trim_matches('\''))
                .collect();
            assert_eq!(actual, names);
        }
    }
}
