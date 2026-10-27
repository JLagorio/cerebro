//! Fixed native-harness-only M95 metadata door. No public submit or child launch.
//! An installed original origin is required; rows/selectors never reconstruct it.
use super::*;
use crate::agent::child_jobs::{
    limits,
    types::{ChildJobSpec, EvidenceRef, JobBudget, RequestedReadGrant},
};
use crate::runtime::{
    child_jobs::{self, Allocation, Intent, Refusal},
    native_runs::NativeRun,
};

// No Clone/Deserialize/Debug and no public fields. A fresh prepare is a new
// intent, not recovery of a caller object or acknowledgment lost by its owner.
pub(crate) struct NativeDelegationCaller {
    run: u64,
    origin: Arc<NativeActionReadOrigin>,
    intent: Intent,
    freeze: std::sync::Mutex<child_freeze::CallerFreeze>,
    launch: Arc<std::sync::Mutex<child_claim::CallerLaunch>>,
}

// Transient request content; never Debug/Serialize or an authority selector.
#[derive(Clone)]
pub(crate) struct NativeDelegationRequest {
    pub objective: String,
    pub instruction_source_version: String,
    pub input_evidence_refs: Vec<EvidenceRef>,
    pub result_schema_id: String,
    pub requested_grant: RequestedReadGrant,
    pub budget: JobBudget,
    pub deadline_at: u64,
}

pub(crate) fn prepare_native_delegation(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
) -> Result<NativeDelegationCaller, Refusal> {
    let (origin, intent) = with_original_origin(app, window, run, None, |tx, native, attempt| {
        let policy = limits::load().map_err(|_| Refusal::Unavailable)?;
        // This caller supplies no ordinal or request key. Never reuse a previous
        // slot after its caller object was dropped or its return was lost.
        let previous: Option<i64> = tx
            .query_row(
                "SELECT max(slot_ordinal) FROM chat_delegation_intents WHERE parent_run_id=?1 AND attempt_id=?2",
                rusqlite::params![native.run_id, attempt],
                |row| row.get(0),
            )
            .map_err(|_| Refusal::Unavailable)?;
        let ordinal = match previous {
            None => 0,
            Some(previous) => u32::try_from(previous)
                .ok()
                .and_then(|value| value.checked_add(1))
                .ok_or(Refusal::Unavailable)?,
        };
        if ordinal >= policy.max_admissions {
            return Err(Refusal::SessionAdmissions);
        }
        child_jobs::prepare_intent_rows(tx, native, attempt, ordinal)
    })?;
    // The classified transaction and final original-source checks have finished.
    // A definite commit is required before this opaque caller can exist.
    Ok(NativeDelegationCaller {
        run,
        origin,
        intent,
        freeze: std::sync::Mutex::new(child_freeze::CallerFreeze::Fresh),
        launch: Arc::new(std::sync::Mutex::new(child_claim::CallerLaunch::Unclaimed)),
    })
}

pub(crate) fn reserve_native_delegation(
    app: &AppHandle,
    window: &WebviewWindow,
    caller: &NativeDelegationCaller,
    request: &NativeDelegationRequest,
) -> Result<Allocation, Refusal> {
    with_original_origin(
        app,
        window,
        caller.run,
        Some(&caller.origin),
        |tx, native, attempt| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| Refusal::Unavailable)?
                .as_secs();
            // Parent identity comes from the verified original origin/attempt,
            // never from request content, a session string, or a resumed lookup.
            let spec = ChildJobSpec {
                parent_run_id: native.run_id.clone(),
                parent_attempt_id: attempt.to_owned(),
                objective: request.objective.clone(),
                instruction_source_version: request.instruction_source_version.clone(),
                input_evidence_refs: request.input_evidence_refs.clone(),
                result_schema_id: request.result_schema_id.clone(),
                requested_grant: request.requested_grant.clone(),
                budget: request.budget.clone(),
                deadline_at: request.deadline_at,
            };
            child_jobs::reserve_rows(tx, native, attempt, &caller.intent, &spec, now)
        },
    )
    .map(|(_, allocation)| allocation)
}

// Private to these two fixed doors: no external connection callback, owner
// constructor, installed-origin factory, or lookup by durable intent is exposed.
fn with_original_origin<T>(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    retained: Option<&Arc<NativeActionReadOrigin>>,
    operation: impl FnOnce(&Connection, &NativeRun, &str) -> Result<T, Refusal>,
) -> Result<(Arc<NativeActionReadOrigin>, T), Refusal> {
    with_original_observation(app, window, run, retained, |tx, native, attempt, _| {
        operation(tx, native, attempt)
    })
    .map(|(origin, _, value)| (origin, value))
}

fn with_original_observation<T, E: From<Refusal> + Copy>(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    retained: Option<&Arc<NativeActionReadOrigin>>,
    operation: impl FnOnce(
        &Connection,
        &NativeRun,
        &str,
        &crate::mcp::NativePublicationObservation,
    ) -> Result<T, E>,
) -> Result<
    (
        Arc<NativeActionReadOrigin>,
        crate::mcp::NativePublicationObservation,
        T,
    ),
    E,
> {
    // Main-thread native observation always precedes authority/storage locks.
    let proof = authenticate(app, window).map_err(|_| Refusal::Unavailable)?;
    let agents = app
        .try_state::<crate::agent::AgentState>()
        .ok_or(Refusal::Unavailable)?;
    let mcp = app
        .try_state::<crate::mcp::McpState>()
        .ok_or(Refusal::Unavailable)?;
    let origin = agents.native_action_read(run).ok_or(Refusal::Unavailable)?;
    if !Arc::ptr_eq(&proof.owner, &origin.owner)
        || retained.is_some_and(|held| !Arc::ptr_eq(held, &origin))
    {
        return Err(Refusal::Unavailable.into());
    }
    // This MCP observation drops its lock before the original opening is held.
    let observed = mcp
        .current_native_observation(&origin.slot)
        .ok_or(Refusal::Unavailable)?;
    if !Arc::ptr_eq(observed.receipt(), &origin.receipt) {
        return Err(Refusal::Unavailable.into());
    }
    origin.store.recheck().map_err(|_| Refusal::Unavailable)?;
    let mut domain_error = None;
    let value = origin
        .context
        .with_legacy_opening(&origin.opening, || {
            let publication = agents
                .guard_retained_publication(&origin.entry, &origin.receipt)
                .map_err(unavailable)?;
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let mut storage = proof.owner.storage.lock().map_err(unavailable)?;
            if storage.failed {
                return Err(NativeOwnerError::Unavailable);
            }
            let owner = storage
                .owner
                .as_mut()
                .ok_or(NativeOwnerError::Unavailable)?;
            let outcome = owner.classified_transaction(|tx| {
                RuntimeOwner::verify_open_session(tx, &origin.root, &origin.scope)?;
                origin.store.recheck()?;
                let rules = crate::actions::native_rules::admission_rules();
                let binding = crate::actions::native_lineage::NativeBinding {
                    run_id: origin.receipt.run_id(),
                    vault_id: &origin.scope.vault_id,
                    store_uuid: origin
                        .scope
                        .store_uuid
                        .as_deref()
                        .ok_or(NativeOwnerError::Unavailable)?,
                    canonical_vault: &origin.root,
                    owner_person: &rules.owner_storage_key,
                    actor_id: origin.receipt.actor_id(),
                    source_kind: "run",
                    app_session_id: crate::runtime::sessions::session_id(),
                    cli_session_id: origin.receipt.cli_session_id(),
                    parent_run_id: None,
                    client_id: None,
                    child_job_id: None,
                };
                let joined = crate::actions::native_lineage::resolve_lineage(
                    crate::actions::native_db::AuthorityDb::Writer(tx),
                    &binding,
                    false,
                )
                .map_err(unavailable)?;
                let attempt: Option<(String, String)> = tx
                    .query_row(
                        "SELECT attempt_id,authority_id FROM chat_parent_attempts WHERE parent_run_id=?1",
                        [origin.receipt.run_id()],
                        |row| {
                            use crate::connections::metadata::bounded_text;
                            Ok((
                                bounded_text(row, "attempt_id", 32)?,
                                bounded_text(row, "authority_id", 32)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(unavailable)?;
                let (attempt, authority) = attempt.ok_or(NativeOwnerError::Unavailable)?;
                if !joined.can_call
                    || joined.row.authority_id != origin.authority_id
                    || joined.row.revision != origin.revision
                    || authority != origin.authority_id
                    || attempt.len() != 32
                    || !attempt.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    || origin.store.info.store_id != binding.store_uuid
                    || !publication.recheck()
                {
                    return Err(NativeOwnerError::Unavailable);
                }
                let result = operation(tx, &joined.row, &attempt, &observed);
                origin.store.recheck()?;
                if !publication.recheck()
                    || !proof.owner.registration.live.load(Ordering::SeqCst)
                {
                    return Err(NativeOwnerError::Unavailable);
                }
                result.map_err(|error| {
                    domain_error = Some(error);
                    NativeOwnerError::Unavailable
                })
            });
            // Typed kernel refusals escape only a definite non-retired rollback.
            // A commit/acknowledgment uncertainty never returns a caller/receipt.
            Ok(match outcome {
                RuntimeTransactionOutcome::Committed(value) => Ok(value),
                RuntimeTransactionOutcome::NotCommitted(_) if !owner.retired => {
                    Err(domain_error.unwrap_or_else(|| Refusal::Unavailable.into()))
                }
                RuntimeTransactionOutcome::NotCommitted(_)
                | RuntimeTransactionOutcome::CommitUncertain => Err(Refusal::Unavailable.into()),
            })
        })
        .map_err(|_| Refusal::Unavailable)?
        .map_err(|_| Refusal::Unavailable)?;
    // All opening/admission/storage/SQLite guards are gone before source lookups.
    let current = mcp
        .current_native_observation(&origin.slot)
        .ok_or(Refusal::Unavailable)?;
    let installed = agents.native_action_read(run).ok_or(Refusal::Unavailable)?;
    if !current.same_as(&observed)
        || !Arc::ptr_eq(&installed, &origin)
        || !proof.owner.registration.live.load(Ordering::SeqCst)
        || origin.store.recheck().is_err()
    {
        return Err(Refusal::Unavailable.into());
    }
    value.map(|value| (origin, observed, value))
}

// Internal immutable grant freeze, consumed only by the separate native profile.
#[path = "native_child_freeze.rs"]
mod child_freeze;
pub(crate) use child_freeze::{
    attempt_frozen_child_start, freeze_native_child, FreezeRefusal, FrozenNativeChild,
    NativeChildMode,
};

// Fixed actual-claim RED door and closed consuming boundary; no default build.
#[path = "native_child_claim.rs"]
mod child_claim;
pub(crate) use child_claim::{
    arm_child_claim_phase_c_probe, child_backend_consumptions, claim_native_child_run,
    consume_native_child_backend, ClaimRefusal, OwnedChildRun,
};
