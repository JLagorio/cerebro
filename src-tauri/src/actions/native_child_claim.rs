//! One actual claim and one consuming owner. The sole backend remains closed.
use super::{
    child_freeze, with_original_observation, FreezeRefusal, FrozenNativeChild,
    NativeActionReadOrigin, NativeDelegationCaller, NativeDelegationRequest, NativeOwnerError,
    RuntimeTransactionOutcome,
};
use crate::runtime::{
    child_claim_history as history,
    child_jobs::{self, FreezeDigests, Refusal},
};
use rusqlite::Connection;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disposition {
    BackendUnavailable,
    Cancelled,
    Expired,
    Interrupted,
}
impl Disposition {
    fn state(self) -> &'static str {
        match self {
            Self::BackendUnavailable => "backend_unavailable",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::Interrupted => "interrupted",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaimRefusal {
    Freeze(FreezeRefusal),
    AlreadyClaimed,
    Terminal(Disposition),
}
impl From<Refusal> for ClaimRefusal {
    fn from(e: Refusal) -> Self {
        Self::Freeze(e.into())
    }
}
impl From<FreezeRefusal> for ClaimRefusal {
    fn from(e: FreezeRefusal) -> Self {
        Self::Freeze(e)
    }
}
pub(super) enum CallerLaunch {
    Unclaimed,
    Closed,
    Owned,
    Terminal(Disposition),
}
// Private non-Clone/non-Debug/non-serde proof. Never returned from a row lookup.
// Its constructor is below inside the original-owner classified transaction.
struct ClaimProof {
    slot: String,
    claim: String,
    run: String,
    authority: String,
    contract: String,
}
// No borrowed connection or arbitrary executable/backend can leave this module.
pub(crate) struct OwnedChildRun {
    origin: Arc<NativeActionReadOrigin>,
    run: u64,
    launch: Arc<Mutex<CallerLaunch>>,
    frozen: Arc<FrozenNativeChild>,
    proof: ClaimProof,
}
// The owned handle retains the exact original origin and serialized launch state.
// IDs, row snapshots and frozen views cannot construct one. No publication or
// SQLite guard outlives its phase.
pub(crate) fn claim_native_child_run(
    app: &AppHandle,
    window: &WebviewWindow,
    caller: &NativeDelegationCaller,
    request: &NativeDelegationRequest,
    frozen: &Arc<FrozenNativeChild>,
) -> Result<OwnedChildRun, ClaimRefusal> {
    // Order: launch -> freeze -> main-thread auth/observations -> opening ->
    // retained publication -> storage -> SQLite. Never acquire launch from DB.
    let mut launch = caller.launch.lock().map_err(|_| Refusal::Unavailable)?;
    match *launch {
        CallerLaunch::Owned => return Err(ClaimRefusal::AlreadyClaimed),
        CallerLaunch::Terminal(state) => return Err(ClaimRefusal::Terminal(state)),
        CallerLaunch::Closed => return Err(Refusal::Unavailable.into()),
        CallerLaunch::Unclaimed => {}
    }
    *launch = CallerLaunch::Closed;
    let freeze = caller.freeze.lock().map_err(|_| Refusal::Unavailable)?;
    if !matches!(&*freeze,child_freeze::CallerFreeze::Frozen(held) if Arc::ptr_eq(held,frozen)) {
        return Err(Refusal::Unavailable.into());
    }
    let result = with_original_observation(
        app,
        window,
        caller.run,
        Some(&caller.origin),
        |tx, parent, attempt, observed| {
            let spec = child_freeze::spec(parent, attempt, request);
            let now = crate::agent::child_jobs::freeze::now()?;
            if !observed.same_as(&frozen.parent) {
                return Err(ClaimRefusal::from(Refusal::Unavailable));
            }
            frozen
                .prepared
                .recheck(&caller.origin.root, frozen.allocation.deadline_at)?;
            let digests = FreezeDigests {
                contract: &frozen.contract_digest,
                instruction_source: &frozen.prepared.instruction_source_version,
                policy: &frozen.prepared.policy_digest,
            };
            child_jobs::freeze_rows(
                tx,
                parent,
                attempt,
                &caller.intent,
                &spec,
                &digests,
                Some(&frozen.allocation),
                now,
            )?;
            if history::actual_or_inert(
                tx,
                &caller.intent.slot_id,
                &frozen.allocation.job_id,
                &frozen.allocation.run_id,
                &frozen.allocation.session_id,
            )
            .map_err(|_| Refusal::Unavailable)?
            {
                return Err(Refusal::Unavailable.into());
            }
            let proof = ClaimProof {
                slot: caller.intent.slot_id.clone(),
                claim: crate::ledger::new_id128(),
                run: frozen.allocation.run_id.clone(),
                authority: crate::ledger::new_id128(),
                contract: frozen.contract_digest.clone(),
            };
            let now = chrono::Utc::now();
            crate::runtime::dispatch::begin_unstarted_child(tx, parent, &frozen.allocation, now)
                .map_err(|_| Refusal::Unavailable)?;
            let actor = format!("job:{}", frozen.allocation.job_id);
            let binding = crate::actions::native_lineage::NativeBinding {
                run_id: &proof.run,
                vault_id: &parent.vault_id,
                store_uuid: &parent.store_uuid,
                canonical_vault: &caller.origin.root,
                owner_person: &parent.owner_person,
                actor_id: &actor,
                source_kind: "job",
                app_session_id: &parent.app_session_id,
                cli_session_id: Some(&frozen.allocation.session_id),
                parent_run_id: Some(&parent.run_id),
                client_id: None,
                child_job_id: Some(&frozen.allocation.job_id),
            };
            let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            crate::actions::native_lineage::insert_if_absent(
                tx,
                &binding,
                &proof.authority,
                &stamp,
            )
            .map_err(|_| Refusal::Unavailable)?;
            tx.execute("INSERT INTO child_job_claims(slot_id,claim_id,run_id,authority_id,contract_digest,app_session_id,claimed_at,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'claimed')",
            rusqlite::params![proof.slot,proof.claim,proof.run,proof.authority,proof.contract,parent.app_session_id,stamp])
            .map_err(|_|Refusal::Unavailable)?;
            resolve_claimed_child_lineage(tx, &proof, &caller.origin, frozen)?;
            Ok(proof)
        },
    );
    let (_, observed, proof) = match result {
        Ok(value) => value,
        Err(error) => {
            if matches!(
                error,
                ClaimRefusal::Freeze(
                    FreezeRefusal::InvalidSpec | FreezeRefusal::RequestKeyConflict
                )
            ) {
                *launch = CallerLaunch::Unclaimed;
            }
            return Err(error);
        }
    };
    // Definite committed rows now exist. Every failure leaves recovery work,
    // never a reconstructed/retryable owner or erased successful claim.
    frozen
        .prepared
        .recheck(&caller.origin.root, frozen.allocation.deadline_at)?;
    phase_c_probe::checkpoint()?;
    child_freeze::recheck_live(app, caller, &observed)?;
    // Live-source lookups can block. Their wait counts against the original
    // deadline; keep Closed and the committed rows recoverable on any failure.
    frozen
        .prepared
        .recheck(&caller.origin.root, frozen.allocation.deadline_at)?;
    *launch = CallerLaunch::Owned;
    Ok(OwnedChildRun {
        origin: Arc::clone(&caller.origin),
        run: caller.run,
        launch: Arc::clone(&caller.launch),
        frozen: Arc::clone(frozen),
        proof,
    })
}

// Borrow-only private proof authorizes only this effect-free backend ownership,
// never generic ACT lineage or account grants. Generic resolve_lineage stays closed.
fn resolve_claimed_child_lineage(
    tx: &Connection,
    proof: &ClaimProof,
    origin: &NativeActionReadOrigin,
    frozen: &FrozenNativeChild,
) -> Result<(), Refusal> {
    let h = history::load(tx, &proof.slot).map_err(|_| Refusal::Unavailable)?;
    if crate::agent::child_jobs::freeze::now().map_err(|_| Refusal::Unavailable)? >= h.deadline {
        return Err(Refusal::Deadline);
    }
    if h.claim != proof.claim
        || h.run != proof.run
        || h.authority != proof.authority
        || h.contract != proof.contract
        || h.state != "claimed"
        || h.run != frozen.allocation.run_id
        || h.contract != frozen.contract_digest
        || h.parent.run_id != origin.receipt.run_id()
        || h.parent.authority_id != origin.authority_id
        || h.parent.revision != origin.revision
        || h.parent.outcome != "running"
        || h.parent.ended_at.is_some()
        || h.parent.close_kind.is_some()
        || h.parent.close_precision != "open"
        || h.child.close_precision != "open"
        || h.child.vault_id != origin.scope.vault_id
        || Some(&h.child.store_uuid) != origin.scope.store_uuid.as_ref()
    {
        return Err(Refusal::Unavailable);
    }
    Ok(())
}

fn settle_unstarted_child(
    owner: &OwnedChildRun,
    disposition: Disposition,
) -> Result<Disposition, FreezeRefusal> {
    // Historical terminal-only operation: no current opening/live publication,
    // parent liveness, recreated Arc, or open historical app session is required.
    let mut storage = owner
        .origin
        .owner
        .storage
        .lock()
        .map_err(|_| FreezeRefusal::Unavailable)?;
    if storage.failed {
        return Err(FreezeRefusal::Unavailable);
    }
    let retained = storage.owner.as_mut().ok_or(FreezeRefusal::Unavailable)?;
    let result = retained.classified_transaction(|tx| {
        let h = history::load(tx, &owner.proof.slot).map_err(|_| NativeOwnerError::Unavailable)?;
        if h.claim != owner.proof.claim
            || h.run != owner.proof.run
            || h.authority != owner.proof.authority
            || h.contract != owner.proof.contract
            || h.parent.run_id != owner.origin.receipt.run_id()
            || h.child.vault_id != owner.origin.scope.vault_id
            || Some(&h.child.store_uuid) != owner.origin.scope.store_uuid.as_ref()
        {
            return Err(NativeOwnerError::Unavailable);
        }
        let disposition = if disposition == Disposition::Interrupted
            && h.parent.close_kind.as_deref() == Some("stopped")
        {
            Disposition::Cancelled
        } else {
            disposition
        };
        history::settle(tx, &h, disposition.state(), chrono::Utc::now())
            .map_err(|_| NativeOwnerError::Unavailable)?;
        Ok(disposition)
    });
    match result {
        RuntimeTransactionOutcome::Committed(disposition) => Ok(disposition),
        _ => Err(FreezeRefusal::Unavailable),
    }
}

pub(crate) struct ClosedChildBackendReceipt {
    frozen: Arc<FrozenNativeChild>,
}
impl ClosedChildBackendReceipt {
    pub(crate) fn holds(&self, frozen: &Arc<FrozenNativeChild>) -> bool {
        Arc::ptr_eq(&self.frozen, frozen)
    }
    pub(crate) fn refusal(&self) -> FreezeRefusal {
        FreezeRefusal::BackendIsolationUnverified
    }
}
struct ClosedChildBackend;
impl ClosedChildBackend {
    fn consume(_owner: &OwnedChildRun) {
        CLOSED_CONSUMPTIONS.fetch_add(1, Ordering::SeqCst);
    }
}
static CLOSED_CONSUMPTIONS: AtomicU64 = AtomicU64::new(0);
pub(crate) fn child_backend_consumptions() -> u64 {
    CLOSED_CONSUMPTIONS.load(Ordering::SeqCst)
}
pub(crate) fn consume_native_child_backend(
    app: &AppHandle,
    window: &WebviewWindow,
    owner: OwnedChildRun,
) -> Result<ClosedChildBackendReceipt, FreezeRefusal> {
    let mut launch = owner
        .launch
        .lock()
        .map_err(|_| FreezeRefusal::Unavailable)?;
    if !matches!(*launch, CallerLaunch::Owned) {
        return Err(FreezeRefusal::Unavailable);
    }
    *launch = CallerLaunch::Closed;
    let validation: Result<_, FreezeRefusal> = with_original_observation(
        app,
        window,
        owner.run,
        Some(&owner.origin),
        |tx, _, _, observed| {
            if !observed.same_as(&owner.frozen.parent) {
                return Err(FreezeRefusal::Unavailable);
            }
            owner
                .frozen
                .prepared
                .recheck(&owner.origin.root, owner.frozen.allocation.deadline_at)?;
            resolve_claimed_child_lineage(tx, &owner.proof, &owner.origin, &owner.frozen)?;
            Ok(())
        },
    );
    let disposition = match validation {
        Ok(_) => {
            // All storage guards have gone; recheck evidence/deadline immediately
            // before the fixed no-effect handoff. This is NOT a process barrier.
            match owner
                .frozen
                .prepared
                .recheck(&owner.origin.root, owner.frozen.allocation.deadline_at)
            {
                Ok(()) => {
                    ClosedChildBackend::consume(&owner);
                    Disposition::BackendUnavailable
                }
                Err(FreezeRefusal::Deadline) => Disposition::Expired,
                Err(_) => Disposition::Interrupted,
            }
        }
        Err(FreezeRefusal::Deadline) => Disposition::Expired,
        Err(_) => {
            // No publication is revived to classify Stop. Historical close data
            // is inspected only inside the terminal writer below.
            Disposition::Interrupted
        }
    };
    let disposition = settle_unstarted_child(&owner, disposition)?;
    *launch = CallerLaunch::Terminal(disposition);
    if disposition != Disposition::BackendUnavailable {
        return Err(FreezeRefusal::Unavailable);
    }
    Ok(ClosedChildBackendReceipt {
        frozen: Arc::clone(&owner.frozen),
    })
}

// This entire claim module is native-read-smoke-only. The one-shot probe can
// only signal/wait at phase C; it has no owner/grant/storage/backend interface.
#[path = "native_child_claim_phase_c_probe.rs"]
mod phase_c_probe;
pub(crate) use phase_c_probe::arm_child_claim_phase_c_probe;
