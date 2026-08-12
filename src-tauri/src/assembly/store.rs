//! Where a manifest is kept, and what became of the discovery it proposed
//! (M26.5d).
//!
//! **Two things with two different natures.** A manifest is a receipt: it is
//! content-addressed by `assembly_id`, it says what one question was shown at
//! one ledger head, and it never changes. A discovery plan run is a
//! lifecycle: it opens `pending` and moves once, toward one terminal state.
//! Storing them in one table would have meant a mutable receipt, which is not
//! a receipt.
//!
//! **The same id with different bytes is refused, never overwritten.**
//! `assembly_id` is derived from the question, the intended use, the caps, the
//! slice and the chain head, and the assembler is deterministic — so two
//! manifests under one id mean something upstream is not what it claims. An
//! upsert would quietly pick a winner and destroy the evidence that anything
//! was ever wrong.
//!
//! **Operational, not ledger.** Every row here is re-derivable: replay the
//! ledger to the recorded head, re-run the assembler, get the same bytes back.
//! Losing app-data loses a cache and a worklist. What a synthesis CONCLUDED is
//! a different kind of thing and goes to the vault ledger.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};

use super::manifest::{Counterevidence, WorkingMemoryManifest};

/// Whether a write changed anything. Both variants are success — a caller
/// that re-records the same assembly has not made a mistake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Stored,
    AlreadyStored,
}

/// A manifest as it was kept, with the two facts the row adds to it.
#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub manifest: WorkingMemoryManifest,
    pub chain_head: String,
    pub assembled_at: String,
}

/// The discovery plan lifecycle. The schema holds the same list in a `CHECK`;
/// this enum is how Rust names them, not a second definition of what is
/// allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanState {
    Pending,
    Started,
    Completed,
    Dismissed,
    Failed,
}

impl PlanState {
    pub fn as_str(self) -> &'static str {
        match self {
            PlanState::Pending => "pending",
            PlanState::Started => "started",
            PlanState::Completed => "completed",
            PlanState::Dismissed => "dismissed",
            PlanState::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<PlanState, String> {
        Ok(match value {
            "pending" => PlanState::Pending,
            "started" => PlanState::Started,
            "completed" => PlanState::Completed,
            "dismissed" => PlanState::Dismissed,
            "failed" => PlanState::Failed,
            other => return Err(format!("unknown discovery plan state {other:?}")),
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            PlanState::Completed | PlanState::Dismissed | PlanState::Failed
        )
    }

    /// May a plan in `self` move to `next`?
    ///
    /// Monotonic: nothing leaves a terminal state, and nothing goes back to
    /// `pending`. `completed` and `failed` require a start, because a plan
    /// that finished without starting is a claim nobody made. `dismissed` may
    /// skip it — dismissing a plan you never ran is the ordinary case.
    fn may_move_to(self, next: PlanState) -> bool {
        match (self, next) {
            (from, to) if from == to => true,
            (_, PlanState::Pending) => false,
            (PlanState::Pending, PlanState::Started | PlanState::Dismissed) => true,
            (PlanState::Pending, _) => false,
            (PlanState::Started, next) => next.is_terminal(),
            _ => false,
        }
    }
}

/// One discovery plan's run.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanRun {
    pub plan_id: String,
    pub assembly_id: String,
    pub state: PlanState,
    pub created_at: String,
    pub started_at: Option<String>,
    pub terminal_at: Option<String>,
    pub detail: Option<String>,
}

/// Whether a transition moved anything. `Unchanged` is the idempotent
/// re-application of a state the plan already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moved {
    Advanced,
    Unchanged,
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Keep one manifest. Idempotent by `assembly_id`; a second write of the same
/// id with different bytes is refused rather than resolved.
pub fn record(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    chain_head: &str,
    manifest: &WorkingMemoryManifest,
    now: DateTime<Utc>,
) -> Result<Recorded, String> {
    // A manifest that does not pass its own validator has no business being
    // durable: every reader downstream is entitled to assume it does.
    manifest.validate()?;
    let json = serde_json::to_string(manifest).map_err(|e| format!("manifest json: {e}"))?;

    let existing: Option<String> = conn
        .query_row(
            "SELECT manifest_json FROM working_memory_manifests \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND assembly_id = ?3",
            rusqlite::params![vault_id, store_uuid, manifest.assembly_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(stored) = existing {
        if stored == json {
            return Ok(Recorded::AlreadyStored);
        }
        return Err(format!(
            "assembly {} is already stored with different bytes — the id is derived from the \
             question, the use, the caps, the slice and the chain head, so two manifests under \
             one id mean something upstream is not what it claims",
            manifest.assembly_id
        ));
    }

    let use_kind = serde_json::to_value(manifest.intended_use.kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or("intended use kind does not serialize as a string")?;
    let stakes = serde_json::to_value(manifest.intended_use.stakes)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or("stakes does not serialize as a string")?;

    conn.execute(
        "INSERT INTO working_memory_manifests (
            vault_id, store_uuid, assembly_id, question_hash, chain_head, assembler_version,
            intended_use_kind, stakes, predicate_class, counterevidence_state,
            source_count, context_bytes, evidence_item_count, manifest_json, assembled_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        rusqlite::params![
            vault_id,
            store_uuid,
            manifest.assembly_id,
            manifest.question_hash,
            chain_head,
            super::assemble::ASSEMBLER_VERSION,
            use_kind,
            stakes,
            manifest.intended_use.predicate_class,
            counterevidence_state(&manifest.counterevidence),
            manifest.actual.source_count as i64,
            manifest.actual.context_bytes as i64,
            manifest.actual.evidence_item_count as i64,
            json,
            stamp(now),
        ],
    )
    .map_err(|e| format!("recording assembly {}: {e}", manifest.assembly_id))?;
    Ok(Recorded::Stored)
}

fn counterevidence_state(counterevidence: &Counterevidence) -> &'static str {
    match counterevidence {
        Counterevidence::Included { .. } => "included",
        Counterevidence::Exhausted { .. } => "exhausted",
        Counterevidence::Blocked { .. } => "blocked",
    }
}

/// Read one manifest back.
///
/// The stored JSON is re-validated on the way out. A row that has been edited
/// underneath the app — by a repair script, by a partial restore — is a
/// refusal rather than a manifest, because everything downstream treats a
/// manifest as already checked.
pub fn get(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    assembly_id: &str,
) -> Result<Option<Kept>, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT manifest_json, chain_head, assembled_at FROM working_memory_manifests \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND assembly_id = ?3",
            rusqlite::params![vault_id, store_uuid, assembly_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((json, chain_head, assembled_at)) = row else {
        return Ok(None);
    };
    let manifest: WorkingMemoryManifest =
        serde_json::from_str(&json).map_err(|e| format!("stored manifest {assembly_id}: {e}"))?;
    manifest
        .validate()
        .map_err(|detail| format!("stored manifest {assembly_id} is not valid: {detail}"))?;
    Ok(Some(Kept {
        manifest,
        chain_head,
        assembled_at,
    }))
}

/// Open a discovery plan as `pending`. Idempotent: re-opening a plan that is
/// already known does not reset it, which is what makes an answer safe to
/// submit twice.
pub fn open(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    plan_id: &str,
    assembly_id: &str,
    now: DateTime<Utc>,
) -> Result<Moved, String> {
    if let Some(existing) = plan(conn, vault_id, store_uuid, plan_id)? {
        if existing.assembly_id != assembly_id {
            return Err(format!(
                "discovery plan {plan_id} is already open under assembly {} — a plan id is its \
                 content, so the same id under two assemblies is a collision, not a re-open",
                existing.assembly_id
            ));
        }
        return Ok(Moved::Unchanged);
    }
    conn.execute(
        "INSERT INTO discovery_plan_runs \
         (vault_id, store_uuid, plan_id, assembly_id, state, created_at) \
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
        rusqlite::params![vault_id, store_uuid, plan_id, assembly_id, stamp(now)],
    )
    .map_err(|e| format!("opening discovery plan {plan_id}: {e}"))?;
    Ok(Moved::Advanced)
}

/// Move a plan. Monotonic and idempotent — see [`PlanState::may_move_to`].
pub fn advance(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    plan_id: &str,
    to: PlanState,
    detail: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Moved, String> {
    let Some(existing) = plan(conn, vault_id, store_uuid, plan_id)? else {
        return Err(format!(
            "discovery plan {plan_id} was advanced before it was opened"
        ));
    };
    if existing.state == to {
        return Ok(Moved::Unchanged);
    }
    if !existing.state.may_move_to(to) {
        return Err(format!(
            "discovery plan {plan_id} is {} and cannot become {}",
            existing.state.as_str(),
            to.as_str()
        ));
    }

    let at = stamp(now);
    // A start time is stamped once and never restamped: `started_at` is when
    // the work began, not when the last transition happened.
    let started_at = match (existing.started_at.clone(), to) {
        (Some(already), _) => Some(already),
        (None, PlanState::Started | PlanState::Completed | PlanState::Failed) => Some(at.clone()),
        (None, _) => None,
    };
    let terminal_at = to.is_terminal().then(|| at.clone());
    let detail = detail.filter(|text| !text.trim().is_empty());

    conn.execute(
        "UPDATE discovery_plan_runs \
         SET state = ?1, started_at = ?2, terminal_at = ?3, detail = coalesce(?4, detail) \
         WHERE vault_id = ?5 AND store_uuid = ?6 AND plan_id = ?7",
        rusqlite::params![
            to.as_str(),
            started_at,
            terminal_at,
            detail,
            vault_id,
            store_uuid,
            plan_id
        ],
    )
    .map_err(|e| format!("advancing discovery plan {plan_id}: {e}"))?;
    Ok(Moved::Advanced)
}

pub fn plan(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
    plan_id: &str,
) -> Result<Option<PlanRun>, String> {
    let row = conn
        .query_row(
            "SELECT assembly_id, state, created_at, started_at, terminal_at, detail \
             FROM discovery_plan_runs \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND plan_id = ?3",
            rusqlite::params![vault_id, store_uuid, plan_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((assembly_id, state, created_at, started_at, terminal_at, detail)) = row else {
        return Ok(None);
    };
    Ok(Some(PlanRun {
        plan_id: plan_id.to_string(),
        assembly_id,
        state: PlanState::parse(&state)?,
        created_at,
        started_at,
        terminal_at,
        detail,
    }))
}

/// Every plan still waiting on somebody. What a surface lists.
pub fn open_plans(
    conn: &Connection,
    vault_id: &str,
    store_uuid: &str,
) -> Result<Vec<PlanRun>, String> {
    let mut statement = conn
        .prepare(
            "SELECT plan_id FROM discovery_plan_runs \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND state IN ('pending', 'started') \
             ORDER BY created_at, plan_id",
        )
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = statement
        .query_map(rusqlite::params![vault_id, store_uuid], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut plans = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(run) = plan(conn, vault_id, store_uuid, &id)? {
            plans.push(run);
        }
    }
    Ok(plans)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::assemble::{assemble, Expansion, Request};
    use crate::assembly::manifest::{Limits, QueryIntendedUse};
    use crate::ledger::schema::{IntendedUseKind, Risk, Scope};
    use crate::vault::testutil;

    const STORE: &str = "cafebabecafebabecafebabecafebabe";
    const HEAD: &str = "90000000000000000000000000000001";
    const PLAN: &str = "7c";

    fn plan_id(tag: u8) -> String {
        format!("{PLAN}{}", format!("{tag:02x}").repeat(31))
    }

    fn now() -> DateTime<Utc> {
        "2026-08-11T09:00:00Z".parse().unwrap()
    }

    fn later() -> DateTime<Utc> {
        "2026-08-11T10:00:00Z".parse().unwrap()
    }

    struct Fixture {
        conn: Connection,
        vault: std::path::PathBuf,
        vault_id: String,
    }

    impl Fixture {
        fn open(name: &str) -> Fixture {
            let vault = testutil::temp_vault(name);
            let conn = crate::runtime::open(&vault).unwrap();
            let vault_id = crate::runtime::scope::register(&conn, &vault).unwrap();
            Fixture {
                conn,
                vault,
                vault_id,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    /// An empty base: every intent exhausts, and the manifest is still a
    /// complete, valid receipt — which is exactly what this table has to keep.
    fn manifest(question: &str) -> WorkingMemoryManifest {
        let state = crate::ledger::reduce::EpistemicState::default();
        let corpus = crate::assembly::corpus::Corpus::default();
        let request = Request {
            store_uuid: STORE,
            chain_head: HEAD,
            question,
            aliases: &[],
            scope: Scope::empty(),
            intended_use: QueryIntendedUse {
                kind: IntendedUseKind::OperationalDecision,
                stakes: Risk::Medium,
                predicate_class: None,
                description: "whether to hold the release meeting".into(),
            },
            limits: Limits {
                max_sources_per_run: 10,
                max_context_bytes: 100_000,
                max_evidence_items: 100,
            },
        };
        assemble(&state, &corpus, &Expansion, &request)
            .expect("a manifest")
            .manifest
    }

    #[test]
    fn a_manifest_round_trips_through_the_row() {
        let fixture = Fixture::open("assembly-store-roundtrip");
        let manifest = manifest("Is the cutover on track?");
        assert_eq!(
            record(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                HEAD,
                &manifest,
                now()
            )
            .unwrap(),
            Recorded::Stored
        );
        let kept = get(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &manifest.assembly_id,
        )
        .unwrap()
        .expect("the row");
        assert_eq!(kept.manifest, manifest);
        assert_eq!(kept.chain_head, HEAD);
        assert_eq!(kept.assembled_at, "2026-08-11T09:00:00.000Z");
    }

    #[test]
    fn recording_the_same_assembly_twice_changes_nothing() {
        // What makes a submit safe to retry.
        let fixture = Fixture::open("assembly-store-idempotent");
        let manifest = manifest("Is the cutover on track?");
        let args = (&fixture.conn, fixture.vault_id.as_str(), STORE, HEAD);
        record(args.0, args.1, args.2, args.3, &manifest, now()).unwrap();
        assert_eq!(
            record(args.0, args.1, args.2, args.3, &manifest, later()).unwrap(),
            Recorded::AlreadyStored
        );
        let count: i64 = fixture
            .conn
            .query_row("SELECT count(*) FROM working_memory_manifests", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn the_same_id_with_different_bytes_is_refused_rather_than_overwritten() {
        // An upsert here would quietly pick a winner and destroy the evidence
        // that the id and its content had ever disagreed.
        let fixture = Fixture::open("assembly-store-conflict");
        let mut manifest = manifest("Is the cutover on track?");
        record(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            HEAD,
            &manifest,
            now(),
        )
        .unwrap();
        manifest.intended_use.description = "something else entirely".into();
        let refusal = record(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            HEAD,
            &manifest,
            later(),
        )
        .expect_err("a conflict");
        assert!(refusal.contains("different bytes"), "{refusal}");
    }

    #[test]
    fn a_manifest_that_fails_its_own_validator_never_becomes_durable() {
        let fixture = Fixture::open("assembly-store-invalid");
        let mut manifest = manifest("Is the cutover on track?");
        manifest.actual.evidence_item_count = 9;
        record(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            HEAD,
            &manifest,
            now(),
        )
        .expect_err("the validator runs before the insert");
        let count: i64 = fixture
            .conn
            .query_row("SELECT count(*) FROM working_memory_manifests", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn a_plan_opens_pending_and_starting_stamps_a_start() {
        let fixture = Fixture::open("assembly-plan-open");
        let id = plan_id(1);
        let manifest = manifest("What else should we look at?");
        assert_eq!(
            open(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                &id,
                &manifest.assembly_id,
                now()
            )
            .unwrap(),
            Moved::Advanced
        );
        let run = plan(&fixture.conn, &fixture.vault_id, STORE, &id)
            .unwrap()
            .unwrap();
        assert_eq!(run.state, PlanState::Pending);
        assert!(run.started_at.is_none() && run.terminal_at.is_none());

        advance(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            PlanState::Started,
            None,
            later(),
        )
        .unwrap();
        let run = plan(&fixture.conn, &fixture.vault_id, STORE, &id)
            .unwrap()
            .unwrap();
        assert_eq!(run.started_at.as_deref(), Some("2026-08-11T10:00:00.000Z"));
        assert!(run.terminal_at.is_none());
    }

    #[test]
    fn dismissal_may_skip_the_start_and_completion_may_not() {
        // Dismissing a plan nobody ran is the ordinary case. A plan that
        // finished without starting is a claim nobody made.
        let fixture = Fixture::open("assembly-plan-skip");
        let manifest = manifest("What else should we look at?");
        let dismissed = plan_id(2);
        let finished = plan_id(3);
        for id in [&dismissed, &finished] {
            open(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                id,
                &manifest.assembly_id,
                now(),
            )
            .unwrap();
        }
        advance(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &dismissed,
            PlanState::Dismissed,
            Some("not worth the reading"),
            later(),
        )
        .unwrap();
        let run = plan(&fixture.conn, &fixture.vault_id, STORE, &dismissed)
            .unwrap()
            .unwrap();
        assert_eq!(run.state, PlanState::Dismissed);
        assert!(run.started_at.is_none(), "dismissal skipped the start");
        assert!(run.terminal_at.is_some());

        let refusal = advance(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &finished,
            PlanState::Completed,
            None,
            later(),
        )
        .expect_err("pending cannot complete");
        assert!(refusal.contains("cannot become completed"), "{refusal}");
    }

    #[test]
    fn a_terminal_plan_never_moves_again() {
        let fixture = Fixture::open("assembly-plan-terminal");
        let id = plan_id(4);
        let manifest = manifest("What else should we look at?");
        open(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            &manifest.assembly_id,
            now(),
        )
        .unwrap();
        for state in [PlanState::Started, PlanState::Completed] {
            advance(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                &id,
                state,
                None,
                later(),
            )
            .unwrap();
        }
        // Idempotent in its own state...
        assert_eq!(
            advance(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                &id,
                PlanState::Completed,
                None,
                later()
            )
            .unwrap(),
            Moved::Unchanged
        );
        // ...and monotonic against every other one.
        for state in [
            PlanState::Pending,
            PlanState::Started,
            PlanState::Failed,
            PlanState::Dismissed,
        ] {
            let refusal = advance(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                &id,
                state,
                None,
                later(),
            )
            .unwrap_err();
            assert!(
                refusal.contains("is completed and cannot become"),
                "{} should have been refused, got {refusal}",
                state.as_str()
            );
        }
    }

    #[test]
    fn a_start_time_is_stamped_once_and_never_restamped() {
        // `started_at` is when the work began, not when the last transition
        // happened.
        let fixture = Fixture::open("assembly-plan-start-once");
        let id = plan_id(5);
        let manifest = manifest("What else should we look at?");
        open(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            &manifest.assembly_id,
            now(),
        )
        .unwrap();
        advance(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            PlanState::Started,
            None,
            now(),
        )
        .unwrap();
        advance(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            PlanState::Failed,
            Some("the source would not load"),
            later(),
        )
        .unwrap();
        let run = plan(&fixture.conn, &fixture.vault_id, STORE, &id)
            .unwrap()
            .unwrap();
        assert_eq!(run.started_at.as_deref(), Some("2026-08-11T09:00:00.000Z"));
        assert_eq!(run.terminal_at.as_deref(), Some("2026-08-11T10:00:00.000Z"));
        assert_eq!(run.detail.as_deref(), Some("the source would not load"));
    }

    #[test]
    fn advancing_a_plan_nobody_opened_is_refused() {
        let fixture = Fixture::open("assembly-plan-unopened");
        let refusal = advance(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &plan_id(6),
            PlanState::Started,
            None,
            now(),
        )
        .expect_err("no such plan");
        assert!(refusal.contains("before it was opened"), "{refusal}");
    }

    #[test]
    fn a_plan_id_under_two_assemblies_is_a_collision_and_not_a_reopen() {
        // A plan id is its content (§ the discovery-plan derivation), so the
        // same id arriving under a different assembly means the derivation was
        // not what it claimed.
        let fixture = Fixture::open("assembly-plan-collision");
        let id = plan_id(7);
        let first = manifest("Is the cutover on track?");
        let second = manifest("What shipped last week?");
        open(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            &first.assembly_id,
            now(),
        )
        .unwrap();
        assert_eq!(
            open(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                &id,
                &first.assembly_id,
                later()
            )
            .unwrap(),
            Moved::Unchanged
        );
        let refusal = open(
            &fixture.conn,
            &fixture.vault_id,
            STORE,
            &id,
            &second.assembly_id,
            later(),
        )
        .expect_err("a collision");
        assert!(refusal.contains("collision"), "{refusal}");
    }

    #[test]
    fn the_open_list_is_what_is_still_waiting_on_somebody() {
        let fixture = Fixture::open("assembly-plan-open-list");
        let manifest = manifest("What else should we look at?");
        let waiting = plan_id(8);
        let done = plan_id(9);
        for id in [&waiting, &done] {
            open(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                id,
                &manifest.assembly_id,
                now(),
            )
            .unwrap();
        }
        for state in [PlanState::Started, PlanState::Completed] {
            advance(
                &fixture.conn,
                &fixture.vault_id,
                STORE,
                &done,
                state,
                None,
                later(),
            )
            .unwrap();
        }
        let open_plans = open_plans(&fixture.conn, &fixture.vault_id, STORE).unwrap();
        let ids: Vec<&str> = open_plans.iter().map(|run| run.plan_id.as_str()).collect();
        assert_eq!(ids, vec![waiting.as_str()]);
    }

    #[test]
    fn the_lifecycle_is_a_check_and_not_only_a_rust_guard() {
        // Around `advance` entirely, with raw SQL — because the point of
        // putting the rule in the DDL is that a second call site cannot
        // disagree with the first about what a row may say.
        let fixture = Fixture::open("assembly-plan-checks");
        let manifest = manifest("What else should we look at?");
        let insert = "INSERT INTO discovery_plan_runs \
             (vault_id, store_uuid, plan_id, assembly_id, state, created_at, started_at, \
              terminal_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";
        let at = "2026-08-11T09:00:00.000Z";
        for (tag, state, started, terminal, why) in [
            (
                0x20,
                "completed",
                None,
                Some(at),
                "completed without a start is a claim nobody made",
            ),
            (
                0x21,
                "failed",
                None,
                Some(at),
                "failed without a start is the same claim",
            ),
            (
                0x22,
                "pending",
                None,
                Some(at),
                "a pending plan has not reached a terminal time",
            ),
            (
                0x23,
                "started",
                Some(at),
                Some(at),
                "a started plan has not reached one either",
            ),
            (
                0x24,
                "dismissed",
                None,
                None,
                "a terminal state with no terminal time disagrees with itself",
            ),
            (
                0x25,
                "abandoned",
                None,
                None,
                "the state vocabulary is closed",
            ),
        ] {
            let refused = fixture.conn.execute(
                insert,
                rusqlite::params![
                    fixture.vault_id,
                    STORE,
                    plan_id(tag),
                    manifest.assembly_id,
                    state,
                    at,
                    started,
                    terminal
                ],
            );
            assert!(refused.is_err(), "{why}");
        }
        let count: i64 = fixture
            .conn
            .query_row("SELECT count(*) FROM discovery_plan_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
