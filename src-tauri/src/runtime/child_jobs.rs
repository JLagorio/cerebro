#![cfg(any(test, feature = "native-read-smoke"))]
//! Inert original-root intent/reservation row kernel. No admission or execution.
use crate::agent::child_jobs::{limits, types::ChildJobSpec};
use crate::runtime::native_runs::NativeRun;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    Unavailable,
    InvalidSpec,
    RequestKeyConflict,
    Concurrency,
    SessionAdmissions,
    Deadline,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Intent {
    pub slot_id: String,
    pub request_key: String,
    parent_run_id: String,
    attempt_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Allocation {
    pub job_id: String,
    pub run_id: String,
    pub session_id: String,
    pub request_digest: String,
    pub deadline_at: u64,
}
fn unavailable<T>(_: T) -> Refusal {
    Refusal::Unavailable
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// These arguments are comparison data, not authority. The sole caller is the
// fixed retained-owner coordinator, after actual source/lineage guards. Never
// start a transaction, construct an origin or open another connection here.
fn check_parent(conn: &Connection, native: &NativeRun, attempt: &str) -> Result<(), Refusal> {
    if conn.is_autocommit()
        || !hex(attempt, 32)
        || native.source_kind != "run"
        || native.parent_run_id.is_some()
        || native.child_job_id.is_some()
        || native.client_id.is_some()
        || native
            .cli_session_id
            .as_deref()
            .is_none_or(|s| !crate::runtime::cause::is_cli_session_id(s))
    {
        return Err(Refusal::Unavailable);
    }
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT attempt_id,authority_id FROM chat_parent_attempts WHERE parent_run_id=?1",
            [&native.run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(unavailable)?;
    if found != Some((attempt.to_owned(), native.authority_id.clone())) {
        return Err(Refusal::Unavailable);
    }
    Ok(())
}
const INTENT_COLUMNS: &str = "slot_id,request_key,parent_run_id,attempt_id,authority_id,authority_revision,owner_person,vault_id,store_uuid,parent_cli_session_id,app_session_id,actor_id,slot_ordinal";
struct IntentRow {
    receipt: Intent,
    authority: String,
    revision: u64,
    owner: String,
    vault: String,
    store: String,
    session: String,
    app_session: String,
    actor: String,
    ordinal: u32,
}
impl IntentRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        use crate::connections::metadata::bounded_text;
        let l = &crate::actions::schema::admission_rules().limits;
        Ok(Self {
            receipt: Intent {
                slot_id: bounded_text(row, "slot_id", 32)?,
                request_key: bounded_text(row, "request_key", 32)?,
                parent_run_id: bounded_text(row, "parent_run_id", l.identity_bytes)?,
                attempt_id: bounded_text(row, "attempt_id", 32)?,
            },
            authority: bounded_text(row, "authority_id", 32)?,
            revision: crate::runtime::native_runs::counter(row, "authority_revision", 1)?,
            owner: bounded_text(row, "owner_person", l.identity_bytes)?,
            vault: bounded_text(row, "vault_id", l.identity_bytes)?,
            store: bounded_text(row, "store_uuid", l.identity_bytes)?,
            session: bounded_text(row, "parent_cli_session_id", l.process_session_bytes)?,
            app_session: bounded_text(row, "app_session_id", l.process_session_bytes)?,
            actor: bounded_text(row, "actor_id", l.identity_bytes)?,
            ordinal: row.get("slot_ordinal")?,
        })
    }
    fn matches(&self, native: &NativeRun, attempt: &str) -> bool {
        hex(&self.receipt.slot_id, 32)
            && hex(&self.receipt.request_key, 32)
            && self.receipt.slot_id != self.receipt.request_key
            && self.receipt.parent_run_id == native.run_id
            && self.receipt.attempt_id == attempt
            && self.authority == native.authority_id
            && self.revision == native.revision
            && self.owner == native.owner_person
            && self.vault == native.vault_id
            && self.store == native.store_uuid
            && Some(&self.session) == native.cli_session_id.as_ref()
            && self.app_session == native.app_session_id
            && self.actor == native.actor_id
    }
}
pub(crate) fn prepare_intent_rows(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    ordinal: u32,
) -> Result<Intent, Refusal> {
    check_parent(conn, native, attempt)?;
    let policy = limits::load().map_err(unavailable)?;
    if ordinal >= policy.max_admissions {
        return Err(Refusal::SessionAdmissions);
    }
    // Load by parent/ordinal first, not authority: corrupted provenance must
    // refuse, never look absent and mint a replacement for the same slot.
    let previous = conn.query_row(
        &format!("SELECT {INTENT_COLUMNS} FROM chat_delegation_intents WHERE parent_run_id=?1 AND attempt_id=?2 AND slot_ordinal=?3"),
        params![native.run_id, attempt, ordinal], IntentRow::read,
    ).optional().map_err(unavailable)?;
    if let Some(row) = previous {
        if !row.matches(native, attempt) || row.ordinal != ordinal {
            return Err(Refusal::Unavailable);
        }
        return Ok(row.receipt);
    }
    let receipt = Intent {
        slot_id: crate::ledger::new_id128(),
        request_key: crate::ledger::new_id128(),
        parent_run_id: native.run_id.clone(),
        attempt_id: attempt.to_owned(),
    };
    if receipt.slot_id == receipt.request_key
        || receipt.slot_id == native.run_id
        || receipt.request_key == native.run_id
        || receipt.slot_id == attempt
        || receipt.request_key == attempt
    {
        return Err(Refusal::Unavailable);
    }
    conn.execute(
        "INSERT INTO chat_delegation_intents(slot_id,request_key,parent_run_id,attempt_id,authority_id,authority_revision,owner_person,vault_id,store_uuid,parent_cli_session_id,app_session_id,actor_id,slot_ordinal) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![receipt.slot_id,receipt.request_key,native.run_id,attempt,native.authority_id,i64::try_from(native.revision).map_err(unavailable)?,native.owner_person,native.vault_id,native.store_uuid,native.cli_session_id,native.app_session_id,native.actor_id,ordinal],
    ).map_err(unavailable)?;
    Ok(receipt)
}
fn checked_intent(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    selection: &Intent,
) -> Result<IntentRow, Refusal> {
    check_parent(conn, native, attempt)?;
    if selection.parent_run_id != native.run_id
        || selection.attempt_id != attempt
        || !hex(&selection.slot_id, 32)
        || !hex(&selection.request_key, 32)
    {
        return Err(Refusal::Unavailable);
    }
    let row = conn.query_row(
        &format!("SELECT {INTENT_COLUMNS} FROM chat_delegation_intents WHERE slot_id=?1 AND parent_run_id=?2 AND attempt_id=?3"),
        params![selection.slot_id,native.run_id,attempt], IntentRow::read,
    ).optional().map_err(unavailable)?.ok_or(Refusal::Unavailable)?;
    if !row.matches(native, attempt)
        || row.receipt != *selection
        || row.ordinal >= limits::load().map_err(unavailable)?.max_admissions
    {
        return Err(Refusal::Unavailable);
    }
    Ok(row)
}
// Versioned, tagged, length-delimited streaming digest. No Serialize/Debug on
// the spec and no canonical content buffer or caller-provided digest.
fn request_digest(spec: &ChildJobSpec) -> String {
    fn text(hash: &mut Sha256, tag: &[u8], value: &str) {
        hash.update(tag);
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let mut hash = Sha256::new();
    hash.update(b"CEREBRO-M95-RESERVATION\0v1\0");
    text(&mut hash, b"parent-run\0", &spec.parent_run_id);
    text(&mut hash, b"parent-attempt\0", &spec.parent_attempt_id);
    text(&mut hash, b"objective\0", &spec.objective);
    text(
        &mut hash,
        b"instruction\0",
        &spec.instruction_source_version,
    );
    hash.update(b"evidence\0");
    hash.update((spec.input_evidence_refs.len() as u64).to_be_bytes());
    for evidence in &spec.input_evidence_refs {
        text(&mut hash, b"evidence-path\0", &evidence.path);
        text(&mut hash, b"evidence-sha256\0", &evidence.sha256);
    }
    text(&mut hash, b"schema\0", &spec.result_schema_id);
    hash.update(b"read-scope\0");
    hash.update((spec.requested_grant.read_scope.len() as u64).to_be_bytes());
    for path in &spec.requested_grant.read_scope {
        text(&mut hash, b"read-path\0", path);
    }
    hash.update(b"elapsed-seconds\0");
    hash.update(spec.budget.elapsed_seconds.to_be_bytes());
    hash.update(b"result-bytes\0");
    hash.update(spec.budget.result_bytes.to_be_bytes());
    hash.update(b"deadline\0");
    hash.update(spec.deadline_at.to_be_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
const ALLOCATION_SQL: &str = "SELECT job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot FROM child_job_reservations WHERE slot_id=?1";
struct AllocationRow {
    receipt: Allocation,
    elapsed: u32,
    result_bytes: u32,
    occupied: bool,
}
impl AllocationRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        use crate::connections::metadata::bounded_text;
        Ok(Self {
            receipt: Allocation {
                job_id: bounded_text(row, "job_id", 32)?,
                run_id: bounded_text(row, "reserved_run_id", 32)?,
                session_id: bounded_text(row, "reserved_cli_session_id", 64)?,
                request_digest: bounded_text(row, "request_digest", 64)?,
                deadline_at: crate::runtime::native_runs::counter(row, "deadline_at", 1)?,
            },
            elapsed: row.get("elapsed_seconds")?,
            result_bytes: row.get("result_bytes")?,
            occupied: match row.get::<_, i64>("occupies_slot")? {
                0 => false,
                1 => true,
                _ => return Err(rusqlite::Error::InvalidQuery),
            },
        })
    }
    fn valid(&self, native: &NativeRun) -> bool {
        let a = &self.receipt;
        let Ok(policy) = limits::load() else {
            return false;
        };
        hex(&a.job_id, 32)
            && hex(&a.run_id, 32)
            && a.job_id != a.run_id
            && a.job_id != native.run_id
            && a.run_id != native.run_id
            && hex(&a.request_digest, 64)
            && crate::runtime::cause::is_cli_session_id(&a.session_id)
            && Some(&a.session_id) != native.cli_session_id.as_ref()
            && self.elapsed > 0
            && u64::from(self.elapsed) <= policy.max_elapsed_seconds
            && self.result_bytes > 0
            && usize::try_from(self.result_bytes)
                .is_ok_and(|bytes| bytes <= policy.max_result_bytes)
    }
}
fn checked_reservation_candidate(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    intent: &Intent,
    spec: &ChildJobSpec,
) -> Result<(IntentRow, Option<AllocationRow>), Refusal> {
    let selected = checked_intent(conn, native, attempt, intent)?;
    if spec.parent_run_id != native.run_id || spec.parent_attempt_id != attempt {
        return Err(Refusal::Unavailable);
    }
    spec.validate_intrinsic()
        .map_err(|_| Refusal::InvalidSpec)?;
    let digest = request_digest(spec);
    let previous = conn
        .query_row(
            ALLOCATION_SQL,
            [&selected.receipt.slot_id],
            AllocationRow::read,
        )
        .optional()
        .map_err(unavailable)?;
    if let Some(row) = previous {
        if !row.valid(native) {
            return Err(Refusal::Unavailable);
        }
        if row.receipt.request_digest != digest {
            return Err(Refusal::RequestKeyConflict);
        }
        // These immutable budget/deadline columns must agree with the candidate
        // bound by the digest, including after its original deadline elapsed.
        if row.receipt.deadline_at != spec.deadline_at
            || row.elapsed != spec.budget.elapsed_seconds
            || row.result_bytes != spec.budget.result_bytes
        {
            return Err(Refusal::Unavailable);
        }
        return Ok((selected, Some(row)));
    }
    Ok((selected, None))
}

// Historical rows below are cleanup evidence only, never a reconstructed caller.
// The live original caller has already passed checked_reservation_candidate in
// its retained-owner transaction. Closing an old authority does not reopen it.
fn recorded_parent_terminal(
    conn: &Connection,
    current: &NativeRun,
    intent: &IntentRow,
    maximum: u32,
) -> Result<(NativeRun, bool), Refusal> {
    use crate::runtime::{dispatch::RunOutcome, native_runs::RUN_SQL};
    let parent = conn
        .query_row(RUN_SQL, [&intent.receipt.parent_run_id], NativeRun::read)
        .optional()
        .map_err(unavailable)?
        .ok_or(Refusal::Unavailable)?;
    check_parent(conn, &parent, &intent.receipt.attempt_id)?;
    if !hex(&intent.receipt.slot_id, 32)
        || !hex(&intent.receipt.request_key, 32)
        || intent.receipt.slot_id == intent.receipt.request_key
        || !hex(&parent.authority_id, 32)
        || intent.authority != parent.authority_id
        // Closing a native authority may advance its revision. The immutable
        // original revision can be older, just as validate_v39 requires.
        || intent.revision > parent.revision
        || intent.owner != parent.owner_person
        || intent.vault != parent.vault_id
        || intent.store != parent.store_uuid
        || Some(&intent.session) != parent.cli_session_id.as_ref()
        || intent.app_session != parent.app_session_id
        || intent.actor != parent.actor_id
        || intent.ordinal >= maximum
        || parent.owner_person != current.owner_person
        || parent.vault_id != current.vault_id
        || parent.store_uuid != current.store_uuid
        || parent.cli_session_id != current.cli_session_id
        || parent.canonical_vault_path != current.canonical_vault_path
        || parent.actual_vault.as_ref() != Some(&parent.vault_id)
        || parent.actual_store.as_ref() != Some(&parent.store_uuid)
        || crate::mcp::normalize_actor(parent.actual_actor.as_deref()) != parent.actor_id
        || parent.actual_cli != parent.cli_session_id
        || parent.actual_parent != parent.parent_run_id
        || parent.canonical_vault_path != parent.vault_path
        || parent.close_kind.as_deref().is_some_and(|kind| {
            !matches!(kind, "completed" | "stopped" | "revoked" | "context_closed")
        })
        || !matches!(
            parent.close_precision.as_str(),
            "open" | "clean_exact" | "heartbeat_lower_bound"
        )
    {
        return Err(Refusal::Unavailable);
    }
    // A Stop request, closed authority or closed app session is not a settled
    // process. Only the existing attended meter/recovery books supply an end.
    let (mode, started): (String, String) = conn
        .query_row(
            "SELECT mode,started_at FROM runs WHERE run_id=?1",
            [&parent.run_id],
            |row| {
                use crate::connections::metadata::bounded_text;
                let limit = crate::actions::schema::admission_rules()
                    .limits
                    .process_session_bytes;
                Ok((
                    bounded_text(row, "mode", limit)?,
                    bounded_text(row, "started_at", limit)?,
                ))
            },
        )
        .map_err(unavailable)?;
    if mode != "attended" || !started.ends_with('Z') {
        return Err(Refusal::Unavailable);
    }
    let started = chrono::DateTime::parse_from_rfc3339(&started).map_err(unavailable)?;
    let terminal = if parent.outcome == "running" {
        if parent.ended_at.is_some() {
            return Err(Refusal::Unavailable);
        }
        false
    } else {
        let known = [
            RunOutcome::Succeeded,
            RunOutcome::Failed,
            RunOutcome::QuotaFailed,
            RunOutcome::ElapsedAborted,
            RunOutcome::Cancelled,
            RunOutcome::AbandonedUsageUnknown,
        ]
        .iter()
        .any(|outcome| outcome.as_str() == parent.outcome);
        let ended = parent.ended_at.as_deref().ok_or(Refusal::Unavailable)?;
        if !known || !ended.ends_with('Z') {
            return Err(Refusal::Unavailable);
        }
        let ended = chrono::DateTime::parse_from_rfc3339(ended).map_err(unavailable)?;
        if ended < started {
            return Err(Refusal::Unavailable);
        }
        true
    };
    Ok((parent, terminal))
}

fn retire_inert_occupancy(
    conn: &Connection,
    current: &NativeRun,
    selected: &IntentRow,
    maximum: u32,
    now: u64,
) -> Result<(), Refusal> {
    // Include released rows: they still count for the lifetime limit, and no
    // corrupt or unexpectedly executed reservation may silently become absent.
    let mut statement = conn.prepare(
        "SELECT i.* FROM chat_delegation_intents i JOIN child_job_reservations r ON r.slot_id=i.slot_id WHERE i.owner_person=?1 AND i.vault_id=?2 AND i.store_uuid=?3 AND i.parent_cli_session_id=?4 ORDER BY i.slot_id LIMIT ?5",
    ).map_err(unavailable)?;
    let prior = statement
        .query_map(
            params![
                selected.owner,
                selected.vault,
                selected.store,
                selected.session,
                i64::from(maximum) + 1
            ],
            IntentRow::read,
        )
        .map_err(unavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(unavailable)?;
    if prior.len() > usize::try_from(maximum).map_err(unavailable)? {
        return Err(Refusal::Unavailable);
    }
    let mut retired = Vec::new();
    for intent in prior {
        let (parent, terminal) = recorded_parent_terminal(conn, current, &intent, maximum)?;
        let allocation = conn
            .query_row(
                ALLOCATION_SQL,
                [&intent.receipt.slot_id],
                AllocationRow::read,
            )
            .map_err(unavailable)?;
        if !allocation.valid(&parent) {
            return Err(Refusal::Unavailable);
        }
        let a = &allocation.receipt;
        // Actual claims are never retired as inert. Their complete historical
        // join is checked even after release and after their parent has ended.
        if crate::runtime::child_claim_history::actual_or_inert(
            conn,
            &intent.receipt.slot_id,
            &a.job_id,
            &a.run_id,
            &a.session_id,
        )
        .map_err(unavailable)?
        {
            continue;
        }
        if allocation.occupied && (terminal || now >= a.deadline_at) {
            retired.push(intent.receipt.slot_id);
        }
    }
    // Validate the complete bounded scope before any update. Allocation, counts
    // and these monotone flips share the caller's classified commit/rollback.
    for slot in retired {
        let changed = conn.execute(
            "UPDATE child_job_reservations SET occupies_slot=0 WHERE slot_id=?1 AND occupies_slot=1",
            [&slot],
        ).map_err(unavailable)?;
        if changed != 1 {
            return Err(Refusal::Unavailable);
        }
    }
    Ok(())
}

pub(crate) fn reserve_rows(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    intent: &Intent,
    spec: &ChildJobSpec,
    now: u64,
) -> Result<Allocation, Refusal> {
    let (selected, previous) = checked_reservation_candidate(conn, native, attempt, intent, spec)?;
    if let Some(row) = previous {
        return Ok(row.receipt);
    }
    let digest = request_digest(spec);
    if now >= spec.deadline_at {
        return Err(Refusal::Deadline);
    }
    spec.validate_new_deadline(now)
        .map_err(|_| Refusal::InvalidSpec)?;
    let policy = limits::load().map_err(unavailable)?;
    retire_inert_occupancy(conn, native, &selected, policy.max_admissions, now)?;
    // Both counts are observed in this caller-owned IMMEDIATE transaction.
    // Lifetime is intentionally independent of parent run/attempt/app session.
    let (accepted, active): (i64,i64) = conn.query_row(
        "SELECT count(*),coalesce(sum(r.occupies_slot),0) FROM child_job_reservations r JOIN chat_delegation_intents i ON i.slot_id=r.slot_id WHERE i.owner_person=?1 AND i.vault_id=?2 AND i.store_uuid=?3 AND i.parent_cli_session_id=?4",
        params![selected.owner,selected.vault,selected.store,selected.session], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(unavailable)?;
    limits::evaluate_new_admission(
        &policy,
        0,
        u32::try_from(active).map_err(unavailable)?,
        u32::try_from(accepted).map_err(unavailable)?,
    )
    .map_err(|error| match error {
        limits::LimitRefusal::Concurrency => Refusal::Concurrency,
        limits::LimitRefusal::SessionAdmissions => Refusal::SessionAdmissions,
        _ => Refusal::Unavailable,
    })?;
    let session =
        crate::agent::transcript::CliSession::for_request(None, None).map_err(unavailable)?;
    let receipt = Allocation {
        job_id: crate::ledger::new_id128(),
        run_id: crate::ledger::new_run_id(),
        session_id: session.id().to_owned(),
        request_digest: digest,
        deadline_at: spec.deadline_at,
    };
    if receipt.job_id == receipt.run_id
        || receipt.job_id == native.run_id
        || receipt.run_id == native.run_id
        || Some(&receipt.session_id) == native.cli_session_id.as_ref()
    {
        return Err(Refusal::Unavailable);
    }
    let collision: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE run_id IN (?1,?2)) OR EXISTS(SELECT 1 FROM child_job_reservations WHERE job_id IN (?1,?2) OR reserved_run_id IN (?1,?2)) OR EXISTS(SELECT 1 FROM action_native_runs WHERE cli_session_id=?3)",
        params![receipt.job_id,receipt.run_id,receipt.session_id],|r|r.get(0),
    ).map_err(unavailable)?;
    if collision {
        return Err(Refusal::Unavailable);
    }
    conn.execute(
        "INSERT INTO child_job_reservations(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1)",
        params![intent.slot_id,receipt.job_id,receipt.run_id,receipt.session_id,receipt.request_digest,i64::try_from(receipt.deadline_at).map_err(unavailable)?,spec.budget.elapsed_seconds,spec.budget.result_bytes],
    ).map_err(unavailable)?;
    Ok(receipt)
}
// Test-harness-only accounting. No actual job state, claim or cancellation is
// invented here, and no record is removed/refunded. Promotion must later reuse
// these exact identities and count the reservation/admission only once.
#[cfg(test)]
pub(crate) fn release_provisional_rows(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    allocation: &Allocation,
) -> Result<(), Refusal> {
    check_parent(conn, native, attempt)?;
    let found: Option<String> = conn.query_row(
        "SELECT i.slot_id FROM chat_delegation_intents i JOIN child_job_reservations r ON r.slot_id=i.slot_id WHERE i.parent_run_id=?1 AND i.attempt_id=?2 AND r.job_id=?3",
        params![native.run_id,attempt,allocation.job_id], |r| r.get(0),
    ).optional().map_err(unavailable)?;
    let slot = found.ok_or(Refusal::Unavailable)?;
    let row = conn
        .query_row(
            &format!("SELECT {INTENT_COLUMNS} FROM chat_delegation_intents WHERE slot_id=?1"),
            [&slot],
            IntentRow::read,
        )
        .map_err(unavailable)?;
    let selected = checked_intent(conn, native, attempt, &row.receipt)?;
    let recorded = conn
        .query_row(
            ALLOCATION_SQL,
            [&selected.receipt.slot_id],
            AllocationRow::read,
        )
        .map_err(unavailable)?;
    if !recorded.valid(native) || recorded.receipt != *allocation {
        return Err(Refusal::Unavailable);
    }
    if recorded.occupied {
        let changed = conn.execute("UPDATE child_job_reservations SET occupies_slot=0 WHERE slot_id=?1 AND occupies_slot=1",[&slot]).map_err(unavailable)?;
        if changed != 1 {
            return Err(Refusal::Unavailable);
        }
    }
    Ok(())
}

// SELECT-only prerequisite. Missing/unavailable never becomes a new reservation.
pub(crate) fn existing_reservation_rows(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    intent: &Intent,
    spec: &ChildJobSpec,
    now: u64,
) -> Result<Allocation, Refusal> {
    let (_, previous) = checked_reservation_candidate(conn, native, attempt, intent, spec)?;
    let previous = previous.ok_or(Refusal::Unavailable)?;
    if now >= previous.receipt.deadline_at {
        return Err(Refusal::Deadline);
    }
    if !previous.occupied {
        return Err(Refusal::Unavailable);
    }
    Ok(previous.receipt)
}

pub(crate) struct FreezeDigests<'a> {
    pub contract: &'a str,
    pub instruction_source: &'a str,
    pub policy: &'a str,
}
// Immutable metadata only. A row may be verified only for a capsule the same
// original caller already retains. A naked row can never reconstruct one.
#[expect(
    clippy::too_many_arguments,
    reason = "The inert row kernel keeps original native lineage, reservation, digest-only metadata and replay disposition explicit."
)]
pub(crate) fn freeze_rows(
    conn: &Connection,
    native: &NativeRun,
    attempt: &str,
    intent: &Intent,
    spec: &ChildJobSpec,
    digests: &FreezeDigests<'_>,
    retained: Option<&Allocation>,
    now: u64,
) -> Result<Allocation, Refusal> {
    let allocation = existing_reservation_rows(conn, native, attempt, intent, spec, now)?;
    if !hex(digests.contract, 64)
        || !hex(digests.instruction_source, 64)
        || !hex(digests.policy, 64)
        || digests.instruction_source != spec.instruction_source_version
    {
        return Err(Refusal::Unavailable);
    }
    let recorded: Option<(String,String,String)> = conn.query_row(
        "SELECT contract_digest,instruction_source_version,policy_digest FROM child_job_grant_freezes WHERE slot_id=?1",
        [&intent.slot_id], |row| { use crate::connections::metadata::bounded_text;
            Ok((bounded_text(row,"contract_digest",64)?,bounded_text(row,"instruction_source_version",64)?,bounded_text(row,"policy_digest",64)?)) },
    ).optional().map_err(unavailable)?;
    if let Some(retained) = retained {
        if retained != &allocation
            || recorded.as_ref().is_none_or(|row| {
                row.0 != digests.contract
                    || row.1 != digests.instruction_source
                    || row.2 != digests.policy
            })
        {
            return Err(Refusal::Unavailable);
        }
    } else {
        // No upsert/recovery. A prior durable row with no retained capsule is
        // ambiguous/lost-ack/restart state and remains permanently inert.
        if recorded.is_some() {
            return Err(Refusal::Unavailable);
        }
        conn.execute("INSERT INTO child_job_grant_freezes(slot_id,contract_digest,instruction_source_version,policy_digest) VALUES(?1,?2,?3,?4)",
            params![intent.slot_id,digests.contract,digests.instruction_source,digests.policy]).map_err(unavailable)?;
    }
    Ok(allocation)
}
