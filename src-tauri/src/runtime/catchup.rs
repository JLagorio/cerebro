//! Launch catch-up, sessions, and declared responsibilities (M25.3).
//!
//! **The mtime era ends here.** The pre-M25 scheduler decided an item was
//! `behind` by comparing a filesystem timestamp against a frontmatter stamp
//! (`src/engine/okf.ts`), which is why a `git checkout` — an operation that
//! rewrites every mtime and changes no content — floods the queue. Catch-up
//! now diffs CONTENT: the artifact hash on disk against the hash the
//! scheduler last recorded. A checkout produces zero work by construction,
//! not by a heuristic that usually gets it right.
//!
//! The `behind` lane survives, repurposed. It was never the bug; its trigger
//! was.
//!
//! **First scan is not zero events.** The old scheduler learned about changes
//! only from the watcher, so everything that happened while the app was shut
//! stayed invisible until something touched the file again. Comparing durable
//! hashes at launch is what closes that window — and it goes through the
//! budget gate like every other dispatch, so a week of accumulated edits is
//! bounded work rather than a stampede.
//!
//! **A closed-app interval is measured, never guessed.** There is no shutdown
//! callback to trust, so an open vault writes a heartbeat every 60 seconds
//! and a clean close stamps an exact time. The next session reads whichever
//! exists and records WHICH — `clean_exact` or `heartbeat_lower_bound` — so
//! an unclean exit cannot fabricate a precise shutdown time, and cannot fall
//! back to a file mtime.

use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use rusqlite::Connection;

use super::normalize::{self, Snapshot};
use super::scheduler::{self, SchedulerState};

/// How often an open vault stamps its heartbeat.
pub const HEARTBEAT_SECONDS: i64 = 60;

/// One item as catch-up found it on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Scanned {
    pub item_key: String,
    pub artifact_hash: String,
    pub snapshot: Snapshot,
}

/// What catch-up decided about one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The stored hash matches the bytes on disk. No work, no tokens.
    Unchanged,
    /// Bytes moved since the scheduler last recorded them.
    Changed,
    /// The scheduler has never seen this item.
    New,
    /// The item is held (upgrade baseline or recovery) and only the owner
    /// may move it. Catch-up does not touch it.
    Held,
    /// Claimed, queued for review, or otherwise already in flight.
    InFlight,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// Items to move to `pending` — the work the budget gate will bound.
    pub queue: Vec<String>,
    /// Items whose stored row must be created before they can be queued.
    pub unseen: Vec<Scanned>,
    pub unchanged: usize,
    pub held: usize,
    pub in_flight: usize,
    /// Rows for items no longer on disk.
    pub departed: Vec<String>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty() && self.unseen.is_empty()
    }
}

/// Read a vault into the scanned-item list catch-up consumes.
pub fn scan(vault: &Path) -> Result<Vec<Scanned>, String> {
    let entries = crate::vault::scan::scan_vault(vault)?;
    let mut items = Vec::with_capacity(entries.len());
    for entry in entries {
        // A file we cannot read is not hashed as empty: a fabricated hash
        // would make it permanently, falsely 'unchanged'.
        let Ok(bytes) = std::fs::read(vault.join(&entry.path)) else {
            continue;
        };
        items.push(Scanned {
            item_key: entry.path.clone(),
            artifact_hash: normalize::artifact_hash(&bytes),
            snapshot: normalize::snapshot(&entry),
        });
    }
    items.sort_by(|a, b| a.item_key.cmp(&b.item_key));
    Ok(items)
}

/// Compare what is on disk against what the scheduler last recorded.
///
/// Pure: it decides, and [`apply`] writes. That split is what lets the whole
/// "a checkout costs nothing" claim be tested without a vault, a database, or
/// a clock.
pub fn plan(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    scanned: &[Scanned],
) -> Result<Plan, String> {
    let mut plan = Plan {
        queue: Vec::new(),
        unseen: Vec::new(),
        unchanged: 0,
        held: 0,
        in_flight: 0,
        departed: Vec::new(),
    };
    let mut seen = std::collections::BTreeSet::new();
    for item in scanned {
        seen.insert(item.item_key.clone());
        match verdict(conn, vault_id, store_uuid, item)? {
            Verdict::Unchanged => plan.unchanged += 1,
            Verdict::Changed => plan.queue.push(item.item_key.clone()),
            Verdict::New => plan.unseen.push(item.clone()),
            Verdict::Held => plan.held += 1,
            Verdict::InFlight => plan.in_flight += 1,
        }
    }
    for (key, _) in known_items(conn, vault_id, store_uuid)? {
        if !seen.contains(&key) {
            plan.departed.push(key);
        }
    }
    Ok(plan)
}

fn verdict(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    item: &Scanned,
) -> Result<Verdict, String> {
    let Some(row) = scheduler::get(conn, vault_id, store_uuid, &item.item_key)? else {
        return Ok(Verdict::New);
    };
    if row.state.is_held() {
        return Ok(Verdict::Held);
    }
    if matches!(
        row.state,
        SchedulerState::Claimed | SchedulerState::PendingReview | SchedulerState::Pending
    ) {
        return Ok(Verdict::InFlight);
    }
    // The whole heuristic, and all of it: same bytes, no work. A normalizer
    // change also counts as changed — an item assessed under different rules
    // has not been assessed under these.
    if row.content_hash == item.artifact_hash
        && row.snapshot.normalizer_version == item.snapshot.normalizer_version
    {
        Ok(Verdict::Unchanged)
    } else {
        Ok(Verdict::Changed)
    }
}

fn known_items(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT item_key, state FROM scheduler WHERE vault_id = ?1 AND store_uuid = ?2 \
             ORDER BY item_key",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![vault_id, store_uuid], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Write a catch-up plan: queue what changed, record what is new.
///
/// One transaction. A kill halfway would otherwise leave some items queued
/// and some unrecorded, and an unrecorded item looks exactly like a new one
/// on the next launch — which is how a stampede starts.
///
/// **Queuing is not dispatching.** Everything this writes is `pending`; the
/// budget gate decides how much of it actually runs, and when.
pub fn apply(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    scanned: &[Scanned],
    plan: &Plan,
) -> Result<usize, String> {
    let by_key: std::collections::BTreeMap<&str, &Scanned> = scanned
        .iter()
        .map(|item| (item.item_key.as_str(), item))
        .collect();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("catch-up: {e}"))?;
    crate::crash::crash_point("runtime-catchup-begun");
    let written = (|| -> Result<usize, String> {
        let mut queued = 0usize;
        for item in &plan.unseen {
            scheduler::put(
                conn,
                vault_id,
                store_uuid,
                &scheduler::Row {
                    item_key: item.item_key.clone(),
                    source_id: None,
                    content_hash: item.artifact_hash.clone(),
                    snapshot: item.snapshot.clone(),
                    event_cursor: None,
                    route: None,
                    state: SchedulerState::Pending,
                },
            )?;
            queued += 1;
        }
        for key in &plan.queue {
            let Some(item) = by_key.get(key.as_str()) else {
                continue;
            };
            // The stored snapshot is the PRIOR one and must survive: it is
            // the before-side of the diff the prefilter will run. Only the
            // state moves here.
            conn.execute(
                "UPDATE scheduler SET state = 'pending', updated_at = ?4 \
                 WHERE vault_id = ?1 AND store_uuid = ?2 AND item_key = ?3 \
                 AND state IN ('consumed', 'failed_visible')",
                rusqlite::params![vault_id, store_uuid, item.item_key, super::now_utc()],
            )
            .map_err(|e| format!("scheduler {key}: {e}"))?;
            queued += 1;
        }
        Ok(queued)
    })();
    match written {
        Ok(queued) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("catch-up: {e}"))?;
            crate::crash::crash_point("runtime-catchup-committed");
            Ok(queued)
        }
        Err(detail) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("catch-up rolled back: {detail}"))
        }
    }
}

// --- Sessions ---------------------------------------------------------------

/// How the previous session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedInterval {
    /// When the app was last known to hold this vault open.
    pub app_closed_at: String,
    /// `clean_exact` when a close was stamped; `heartbeat_lower_bound`
    /// otherwise — the last durable heartbeat, which is a LOWER BOUND and is
    /// recorded as one.
    pub precision: &'static str,
}

/// Open a session for a vault, returning the previous session's closure.
pub fn open_session(
    conn: &Connection,
    session_id: &str,
    vault_id: &str,
    store_uuid: &str,
    now: DateTime<Utc>,
) -> Result<Option<ClosedInterval>, String> {
    let previous = last_closure(conn, vault_id, store_uuid)?;
    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    // Any session still marked open belongs to a process that is gone. Its
    // last heartbeat becomes the honest lower bound.
    conn.execute(
        "UPDATE app_sessions SET close_precision = 'heartbeat_lower_bound' \
         WHERE vault_id = ?1 AND store_uuid = ?2 AND close_precision = 'open'",
        rusqlite::params![vault_id, store_uuid],
    )
    .map_err(|e| format!("app_sessions: {e}"))?;
    conn.execute(
        "INSERT INTO app_sessions \
         (session_id, vault_id, store_uuid, opened_at, last_heartbeat_at, clean_closed_at, \
          close_precision) VALUES (?1, ?2, ?3, ?4, ?4, NULL, 'open') \
         ON CONFLICT (session_id, vault_id, store_uuid) DO UPDATE SET \
           last_heartbeat_at = excluded.last_heartbeat_at",
        rusqlite::params![session_id, vault_id, store_uuid, stamp],
    )
    .map_err(|e| format!("app_sessions: {e}"))?;
    Ok(previous)
}

/// Stamp the heartbeat. Called every [`HEARTBEAT_SECONDS`] while a vault is
/// open; each one narrows the lower bound an unclean exit will leave behind.
pub fn heartbeat(
    conn: &Connection,
    session_id: &str,
    vault_id: &str,
    store_uuid: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE app_sessions SET last_heartbeat_at = ?4 \
         WHERE session_id = ?1 AND vault_id = ?2 AND store_uuid = ?3 \
         AND close_precision = 'open'",
        rusqlite::params![
            session_id,
            vault_id,
            store_uuid,
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        ],
    )
    .map_err(|e| format!("app_sessions: {e}"))?;
    Ok(())
}

/// A clean close: the one case where the shutdown time is exact.
pub fn close_session(
    conn: &Connection,
    session_id: &str,
    vault_id: &str,
    store_uuid: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "UPDATE app_sessions SET clean_closed_at = ?4, last_heartbeat_at = ?4, \
         close_precision = 'clean_exact' \
         WHERE session_id = ?1 AND vault_id = ?2 AND store_uuid = ?3",
        rusqlite::params![session_id, vault_id, store_uuid, stamp],
    )
    .map_err(|e| format!("app_sessions: {e}"))?;
    Ok(())
}

fn last_closure(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
) -> Result<Option<ClosedInterval>, String> {
    let result = conn.query_row(
        "SELECT clean_closed_at, last_heartbeat_at, close_precision FROM app_sessions \
         WHERE vault_id = ?1 AND store_uuid = ?2 ORDER BY last_heartbeat_at DESC LIMIT 1",
        rusqlite::params![vault_id, store_uuid],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    );
    match result {
        Ok((Some(clean), _, _)) => Ok(Some(ClosedInterval {
            app_closed_at: clean,
            precision: "clean_exact",
        })),
        Ok((None, heartbeat, _)) => Ok(Some(ClosedInterval {
            app_closed_at: heartbeat,
            precision: "heartbeat_lower_bound",
        })),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("app_sessions: {e}")),
    }
}

// --- Declared responsibilities ---------------------------------------------

/// One owner-declared responsibility, as a new immutable version.
#[derive(Debug, Clone, PartialEq)]
pub struct Contract {
    pub responsibility_id: String,
    pub source_id: String,
    pub subject_id: Option<String>,
    pub predicate_class: Option<String>,
    pub scope_digest: String,
    pub retention_seconds: u64,
    pub deadline_seconds: u64,
}

impl Contract {
    /// SHA-256 over the declared fields. Pinned by every catch-up outcome, so
    /// "the contract active during that episode" survives later edits.
    pub fn digest(&self) -> String {
        let canonical = serde_json::json!({
            "responsibility_id": self.responsibility_id,
            "source_id": self.source_id,
            "subject_id": self.subject_id,
            "predicate_class": self.predicate_class,
            "scope_digest": self.scope_digest,
            "retention_seconds": self.retention_seconds,
            "deadline_seconds": self.deadline_seconds,
        })
        .to_string();
        crate::ledger::sha256_hex(canonical.as_bytes())
    }
}

/// Declare or edit a responsibility. Append-only: an edit CLOSES the previous
/// version's half-open interval and inserts the next, in one transaction, so
/// history is never overwritten.
pub fn declare(
    conn: &Connection,
    store_uuid: &str,
    contract: &Contract,
    now: DateTime<Utc>,
) -> Result<u64, String> {
    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let next: i64 = conn
        .query_row(
            "SELECT coalesce(max(contract_version), -1) + 1 FROM responsibility_contracts \
             WHERE store_uuid = ?1 AND responsibility_id = ?2",
            rusqlite::params![store_uuid, contract.responsibility_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("responsibility_contracts: {e}"))?;
    conn.execute(
        "UPDATE responsibility_contracts SET active_to = ?3 \
         WHERE store_uuid = ?1 AND responsibility_id = ?2 AND active_to IS NULL",
        rusqlite::params![store_uuid, contract.responsibility_id, stamp],
    )
    .map_err(|e| format!("responsibility_contracts: {e}"))?;
    conn.execute(
        "INSERT INTO responsibility_contracts \
         (store_uuid, responsibility_id, contract_version, contract_digest, source_id, \
          subject_id, predicate_class, scope_digest, retention_seconds, deadline_seconds, \
          active_from, active_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
        rusqlite::params![
            store_uuid,
            contract.responsibility_id,
            next,
            contract.digest(),
            contract.source_id,
            contract.subject_id,
            contract.predicate_class,
            contract.scope_digest,
            contract.retention_seconds as i64,
            contract.deadline_seconds as i64,
            stamp,
        ],
    )
    .map_err(|e| format!("responsibility_contracts: {e}"))?;
    Ok(next as u64)
}

/// The version whose half-open `[active_from, active_to)` interval contains
/// `at`. This is what makes an M28 R10 sample reproducible after later edits:
/// the outcome pins a version, not "whatever the contract says now".
pub fn version_active_at(
    conn: &Connection,
    store_uuid: &str,
    responsibility_id: &str,
    at: &str,
) -> Result<Option<(u64, String)>, String> {
    let result = conn.query_row(
        "SELECT contract_version, contract_digest FROM responsibility_contracts \
         WHERE store_uuid = ?1 AND responsibility_id = ?2 AND active_from <= ?3 \
         AND (active_to IS NULL OR active_to > ?3) ORDER BY contract_version DESC LIMIT 1",
        rusqlite::params![store_uuid, responsibility_id, at],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
    );
    match result {
        Ok(found) => Ok(Some(found)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("responsibility_contracts: {e}")),
    }
}

/// What a launch catch-up concluded about one declared responsibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    CaughtUp,
    RetentionLost,
    DeclaredDeadlineMissed,
    NotApplicable,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::CaughtUp => "caught_up",
            Outcome::RetentionLost => "retention_lost",
            Outcome::DeclaredDeadlineMissed => "declared_deadline_missed",
            Outcome::NotApplicable => "not_applicable",
        }
    }

    /// Does this outcome describe a MATERIAL miss — one that changes what the
    /// base can claim to have observed, and therefore needs a linked coverage
    /// gap?
    ///
    /// Ordinary delay is not one. Neither is quota backoff or a source
    /// outage: those are operational, and promoting them would fill the
    /// epistemic record with retry noise.
    pub fn is_material_miss(self) -> bool {
        matches!(
            self,
            Outcome::RetentionLost | Outcome::DeclaredDeadlineMissed
        )
    }
}

/// Decide one contract's outcome from the closed interval alone.
///
/// Retention loss outranks a missed deadline: if the source no longer holds
/// what happened, the deadline is moot and saying "late" would understate it.
pub fn outcome_for(contract: &Contract, closed_for: Duration) -> Outcome {
    let seconds = closed_for.num_seconds().max(0) as u64;
    if contract.retention_seconds > 0 && seconds > contract.retention_seconds {
        return Outcome::RetentionLost;
    }
    if contract.deadline_seconds > 0 && seconds > contract.deadline_seconds {
        return Outcome::DeclaredDeadlineMissed;
    }
    Outcome::CaughtUp
}

/// Record one typed catch-up outcome, pinning the contract version and digest
/// that were active when the app closed.
#[allow(clippy::too_many_arguments)]
pub fn record_outcome(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    episode_id: &str,
    responsibility_id: &str,
    interval: &ClosedInterval,
    reopened_at: DateTime<Utc>,
    outcome: Outcome,
    coverage_gap_id: Option<&str>,
    detail: Option<&str>,
) -> Result<(), String> {
    let Some((version, digest)) =
        version_active_at(conn, store_uuid, responsibility_id, &interval.app_closed_at)?
    else {
        return Err(format!(
            "no version of responsibility {responsibility_id} was active at {}",
            interval.app_closed_at
        ));
    };
    let stamp = reopened_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    conn.execute(
        "INSERT INTO catchup_outcomes \
         (vault_id, store_uuid, episode_id, responsibility_id, contract_version, \
          contract_digest, app_closed_at, close_precision, reopened_at, resolved_at, \
          coverage_gap_id, outcome, detail) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            vault_id,
            store_uuid,
            episode_id,
            responsibility_id,
            version as i64,
            digest,
            interval.app_closed_at,
            interval.precision,
            stamp,
            coverage_gap_id,
            outcome.as_str(),
            detail,
        ],
    )
    .map_err(|e| format!("catchup_outcomes: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        (dir, conn, vault)
    }

    fn scanned(key: &str, hash: &str, title: &str) -> Scanned {
        let mut entry = Entry::empty_for_test(key);
        entry.title = title.into();
        Scanned {
            item_key: key.to_string(),
            artifact_hash: hash.repeat(64 / hash.len()),
            snapshot: normalize::snapshot(&entry),
        }
    }

    fn store(conn: &Connection, vault: &str, item: &Scanned, state: SchedulerState) {
        scheduler::put(
            conn,
            vault,
            "store",
            &scheduler::Row {
                item_key: item.item_key.clone(),
                source_id: None,
                content_hash: item.artifact_hash.clone(),
                snapshot: item.snapshot.clone(),
                event_cursor: None,
                route: None,
                state,
            },
        )
        .unwrap();
    }

    #[test]
    fn a_git_checkout_costs_nothing_because_content_did_not_move() {
        // THE acceptance row. Every mtime in the vault changed; not one byte
        // did. The queue must be empty.
        let (dir, conn, vault) = fixture("catchup-checkout");
        let items: Vec<Scanned> = (0..20)
            .map(|n| scanned(&format!("n{n:02}.md"), "a", "same"))
            .collect();
        for item in &items {
            store(&conn, &vault, item, SchedulerState::Consumed);
        }
        let plan = plan(&conn, &vault, "store", &items).unwrap();
        assert!(plan.is_empty(), "{plan:?}");
        assert_eq!(plan.unchanged, 20);
        assert_eq!(apply(&conn, &vault, "store", &items, &plan).unwrap(), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_bytes_queue_and_new_items_get_a_row() {
        let (dir, conn, vault) = fixture("catchup-changed");
        let before = scanned("a.md", "a", "Alpha");
        store(&conn, &vault, &before, SchedulerState::Consumed);
        let after = scanned("a.md", "b", "Beta");
        let fresh = scanned("b.md", "c", "New");
        let items = vec![after, fresh];
        let plan = plan(&conn, &vault, "store", &items).unwrap();
        assert_eq!(plan.queue, vec!["a.md".to_string()]);
        assert_eq!(plan.unseen.len(), 1);
        assert_eq!(apply(&conn, &vault, "store", &items, &plan).unwrap(), 2);
        assert_eq!(
            scheduler::keys_in_state(&conn, &vault, "store", SchedulerState::Pending).unwrap(),
            vec!["a.md".to_string(), "b.md".to_string()]
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_prior_snapshot_survives_being_queued() {
        // It is the BEFORE side of the diff the prefilter will run; losing it
        // would force every restart to escalate everything it cannot explain.
        let (dir, conn, vault) = fixture("catchup-snapshot");
        let before = scanned("a.md", "a", "Alpha");
        store(&conn, &vault, &before, SchedulerState::Consumed);
        let after = scanned("a.md", "b", "Beta");
        let items = vec![after];
        let plan = plan(&conn, &vault, "store", &items).unwrap();
        apply(&conn, &vault, "store", &items, &plan).unwrap();
        let row = scheduler::get(&conn, &vault, "store", "a.md")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, SchedulerState::Pending);
        assert_eq!(
            row.snapshot, before.snapshot,
            "the stored snapshot is the prior one, not the new one"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_normalizer_makes_everything_changed() {
        // An item assessed under different rules has not been assessed under
        // these — silently treating it as current would freeze old verdicts.
        let (dir, conn, vault) = fixture("catchup-normalizer");
        let mut stored = scanned("a.md", "a", "Alpha");
        stored.snapshot.normalizer_version = "vault-entry-v0".into();
        store(&conn, &vault, &stored, SchedulerState::Consumed);
        let current = scanned("a.md", "a", "Alpha");
        let plan = plan(&conn, &vault, "store", &[current]).unwrap();
        assert_eq!(plan.queue, vec!["a.md".to_string()]);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn held_and_in_flight_items_are_never_touched_by_catch_up() {
        // Held is the owner's to release; in-flight belongs to a run or a
        // review. Catch-up re-queuing either would be the duplicate spend the
        // whole milestone exists to prevent.
        let (dir, conn, vault) = fixture("catchup-held");
        for (key, state) in [
            ("held.md", SchedulerState::BaselineHeld),
            ("recover.md", SchedulerState::RecoveryHeld),
            ("claimed.md", SchedulerState::Claimed),
            ("review.md", SchedulerState::PendingReview),
        ] {
            let stored = scanned(key, "a", "Alpha");
            if state == SchedulerState::Claimed {
                // A claim needs an owner; store it pending and move it.
                store(&conn, &vault, &stored, SchedulerState::Pending);
                continue;
            }
            store(&conn, &vault, &stored, state);
        }
        let items: Vec<Scanned> = ["held.md", "recover.md", "claimed.md", "review.md"]
            .iter()
            .map(|key| scanned(key, "b", "Changed"))
            .collect();
        let plan = plan(&conn, &vault, "store", &items).unwrap();
        assert!(plan.queue.is_empty(), "{plan:?}");
        assert_eq!(plan.held, 2);
        assert_eq!(plan.in_flight, 2);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_deleted_note_is_reported_rather_than_queued() {
        let (dir, conn, vault) = fixture("catchup-departed");
        store(
            &conn,
            &vault,
            &scanned("gone.md", "a", "Gone"),
            SchedulerState::Consumed,
        );
        let plan = plan(&conn, &vault, "store", &[]).unwrap();
        assert_eq!(plan.departed, vec!["gone.md".to_string()]);
        assert!(plan.queue.is_empty());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scanning_a_real_vault_reads_bytes_not_timestamps() {
        let dir = testutil::temp_vault("catchup-scan");
        testutil::write(&dir, "a.md", "---\ntitle: A\n---\nbody\n");
        let first = scan(&dir).unwrap();
        // Touch it: same bytes, new mtime.
        let path = dir.join("a.md");
        let content = std::fs::read(&path).unwrap();
        std::fs::write(&path, content).unwrap();
        let second = scan(&dir).unwrap();
        assert_eq!(first, second, "a touch is not a change");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_close_is_exact_and_a_crash_leaves_an_honest_lower_bound() {
        let (dir, conn, vault) = fixture("catchup-session");
        assert_eq!(
            open_session(&conn, "s1", &vault, "store", at("2026-08-01T09:00:00Z")).unwrap(),
            None,
            "the first session has no predecessor"
        );
        heartbeat(&conn, "s1", &vault, "store", at("2026-08-01T09:01:00Z")).unwrap();
        close_session(&conn, "s1", &vault, "store", at("2026-08-01T17:00:00Z")).unwrap();

        let previous = open_session(&conn, "s2", &vault, "store", at("2026-08-02T09:00:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(previous.precision, "clean_exact");
        assert_eq!(previous.app_closed_at, "2026-08-01T17:00:00.000Z");

        // s2 never closes cleanly — the process was killed.
        heartbeat(&conn, "s2", &vault, "store", at("2026-08-02T09:30:00Z")).unwrap();
        let previous = open_session(&conn, "s3", &vault, "store", at("2026-08-09T09:00:00Z"))
            .unwrap()
            .unwrap();
        assert_eq!(previous.precision, "heartbeat_lower_bound");
        assert_eq!(
            previous.app_closed_at, "2026-08-02T09:30:00.000Z",
            "the last durable heartbeat, and it is recorded as a LOWER BOUND"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_contract_edit_closes_the_old_interval_and_opens_the_next() {
        let (dir, conn, _) = fixture("catchup-contract");
        let mut contract = Contract {
            responsibility_id: "watch-inbox".into(),
            source_id: "src".into(),
            subject_id: None,
            predicate_class: None,
            scope_digest: "a".repeat(64),
            retention_seconds: 3_600,
            deadline_seconds: 1_800,
        };
        assert_eq!(
            declare(&conn, "store", &contract, at("2026-08-01T00:00:00Z")).unwrap(),
            0
        );
        let first_digest = contract.digest();
        contract.deadline_seconds = 900;
        assert_eq!(
            declare(&conn, "store", &contract, at("2026-08-05T00:00:00Z")).unwrap(),
            1
        );

        // An episode that closed BEFORE the edit still selects version 0.
        let (version, digest) =
            version_active_at(&conn, "store", "watch-inbox", "2026-08-02T00:00:00.000Z")
                .unwrap()
                .unwrap();
        assert_eq!(version, 0);
        assert_eq!(digest, first_digest, "the version the episode lived under");

        let (version, _) =
            version_active_at(&conn, "store", "watch-inbox", "2026-08-06T00:00:00.000Z")
                .unwrap()
                .unwrap();
        assert_eq!(version, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_loss_outranks_a_missed_deadline() {
        let contract = Contract {
            responsibility_id: "r".into(),
            source_id: "s".into(),
            subject_id: None,
            predicate_class: None,
            scope_digest: "a".repeat(64),
            retention_seconds: 3_600,
            deadline_seconds: 1_800,
        };
        assert_eq!(
            outcome_for(&contract, Duration::minutes(10)),
            Outcome::CaughtUp
        );
        assert_eq!(
            outcome_for(&contract, Duration::minutes(45)),
            Outcome::DeclaredDeadlineMissed
        );
        assert_eq!(
            outcome_for(&contract, Duration::hours(5)),
            Outcome::RetentionLost,
            "if the source no longer holds it, 'late' understates the problem"
        );
        assert!(Outcome::RetentionLost.is_material_miss());
        assert!(Outcome::DeclaredDeadlineMissed.is_material_miss());
        assert!(
            !Outcome::CaughtUp.is_material_miss(),
            "ordinary delay never becomes an epistemic coverage event"
        );
        assert!(!Outcome::NotApplicable.is_material_miss());
    }

    #[test]
    fn an_outcome_pins_the_version_and_precision_it_was_decided_under() {
        let (dir, conn, vault) = fixture("catchup-outcome");
        let contract = Contract {
            responsibility_id: "watch-inbox".into(),
            source_id: "src".into(),
            subject_id: None,
            predicate_class: None,
            scope_digest: "a".repeat(64),
            retention_seconds: 3_600,
            deadline_seconds: 1_800,
        };
        declare(&conn, "store", &contract, at("2026-08-01T00:00:00Z")).unwrap();
        let interval = ClosedInterval {
            app_closed_at: "2026-08-02T09:30:00.000Z".into(),
            precision: "heartbeat_lower_bound",
        };
        record_outcome(
            &conn,
            &vault,
            "store",
            "episode-1",
            "watch-inbox",
            &interval,
            at("2026-08-09T09:00:00Z"),
            Outcome::RetentionLost,
            None,
            Some("closed for a week"),
        )
        .unwrap();

        // Edit the contract afterwards; the recorded outcome must not move.
        let mut edited = contract.clone();
        edited.retention_seconds = 999_999;
        declare(&conn, "store", &edited, at("2026-08-10T00:00:00Z")).unwrap();

        let (version, digest, precision, outcome): (i64, String, String, String) = conn
            .query_row(
                "SELECT contract_version, contract_digest, close_precision, outcome \
                 FROM catchup_outcomes WHERE episode_id = 'episode-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(version, 0);
        assert_eq!(digest, contract.digest());
        assert_eq!(precision, "heartbeat_lower_bound");
        assert_eq!(outcome, "retention_lost");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_outcome_for_a_responsibility_nobody_declared_is_refused() {
        let (dir, conn, vault) = fixture("catchup-undeclared");
        let err = record_outcome(
            &conn,
            &vault,
            "store",
            "episode-1",
            "never-declared",
            &ClosedInterval {
                app_closed_at: "2026-08-02T09:30:00.000Z".into(),
                precision: "clean_exact",
            },
            at("2026-08-09T09:00:00Z"),
            Outcome::CaughtUp,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("was active at"), "{err}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
