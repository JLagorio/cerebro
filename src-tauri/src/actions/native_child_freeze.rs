//! Native-harness-only immutable local grant freeze. No child execution.
use super::{with_original_observation, NativeDelegationCaller, NativeDelegationRequest};
pub(crate) use crate::agent::child_jobs::freeze::FreezeRefusal;
use crate::agent::child_jobs::{
    freeze::PreparedFreeze,
    types::{ChildJobSpec, EvidenceRef},
};
use crate::runtime::child_jobs::{self, Allocation, FreezeDigests};
use std::{convert::Infallible, sync::Arc};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeChildMode {
    LocalResearcher,
    AgentPage,
    ManagedAccount,
}

// No Clone/Debug/serde or reconstruction from durable rows. Only the original
// caller owns this state; dropping it or losing acknowledgment cannot restore it.
pub(super) enum CallerFreeze {
    Fresh,
    Frozen(Arc<FrozenNativeChild>),
    Closed,
}
pub(crate) struct FrozenNativeChild {
    pub(super) allocation: Allocation,
    pub(super) contract_digest: String,
    pub(super) prepared: PreparedFreeze,
    pub(super) parent: crate::mcp::NativePublicationObservation,
}
pub(crate) struct FrozenNativeChildView<'a> {
    pub allocation: &'a Allocation,
    pub contract_digest: &'a str,
    pub instruction_source_version: &'a str,
    pub instructions: &'a str,
    pub read_scope: &'a [String],
    pub tools: &'a [String],
    pub evidence: &'a [EvidenceRef],
}
impl FrozenNativeChild {
    pub(crate) fn view(&self) -> FrozenNativeChildView<'_> {
        FrozenNativeChildView {
            allocation: &self.allocation,
            contract_digest: &self.contract_digest,
            instruction_source_version: &self.prepared.instruction_source_version,
            instructions: self.prepared.instructions,
            read_scope: &self.prepared.read_scope,
            tools: &self.prepared.tools,
            evidence: &self.prepared.evidence,
        }
    }
}
enum Candidate {
    New {
        allocation: Allocation,
        contract_digest: String,
        prepared: Box<PreparedFreeze>,
    },
    Replay(Arc<FrozenNativeChild>),
}
pub(super) fn spec(
    native: &crate::runtime::native_runs::NativeRun,
    attempt: &str,
    request: &NativeDelegationRequest,
) -> ChildJobSpec {
    ChildJobSpec {
        parent_run_id: native.run_id.clone(),
        parent_attempt_id: attempt.to_owned(),
        objective: request.objective.clone(),
        instruction_source_version: request.instruction_source_version.clone(),
        input_evidence_refs: request.input_evidence_refs.clone(),
        result_schema_id: request.result_schema_id.clone(),
        requested_grant: request.requested_grant.clone(),
        budget: request.budget.clone(),
        deadline_at: request.deadline_at,
    }
}
pub(super) fn recheck_live(
    app: &AppHandle,
    caller: &NativeDelegationCaller,
    observed: &crate::mcp::NativePublicationObservation,
) -> Result<(), FreezeRefusal> {
    // This final observation is outside opening/entry/storage/SQLite guards.
    let mcp = app
        .try_state::<crate::mcp::McpState>()
        .ok_or(FreezeRefusal::Unavailable)?;
    let agents = app
        .try_state::<crate::agent::AgentState>()
        .ok_or(FreezeRefusal::Unavailable)?;
    let current = mcp
        .current_native_observation(&caller.origin.slot)
        .ok_or(FreezeRefusal::Unavailable)?;
    let installed = agents
        .native_action_read(caller.run)
        .ok_or(FreezeRefusal::Unavailable)?;
    if !current.same_as(observed)
        || !Arc::ptr_eq(&installed, &caller.origin)
        || !caller
            .origin
            .owner
            .registration
            .live
            .load(std::sync::atomic::Ordering::SeqCst)
        || caller.origin.store.recheck().is_err()
    {
        return Err(FreezeRefusal::Unavailable);
    }
    Ok(())
}
pub(crate) fn freeze_native_child(
    app: &AppHandle,
    window: &WebviewWindow,
    caller: &NativeDelegationCaller,
    request: &NativeDelegationRequest,
    mode: NativeChildMode,
) -> Result<Arc<FrozenNativeChild>, FreezeRefusal> {
    if mode != NativeChildMode::LocalResearcher {
        return Err(FreezeRefusal::UnsupportedMode);
    }
    let mut state = caller
        .freeze
        .lock()
        .map_err(|_| FreezeRefusal::Unavailable)?;
    // Mark closed before touching storage. An unwind, unknown commit, missing
    // postcommit acknowledgment or access/source drift cannot silently refreeze.
    let previous = std::mem::replace(&mut *state, CallerFreeze::Closed);
    if matches!(previous, CallerFreeze::Closed) {
        return Err(FreezeRefusal::Unavailable);
    }
    let result = with_original_observation(
        app,
        window,
        caller.run,
        Some(&caller.origin),
        |tx, native, attempt, parent| {
            let spec = spec(native, attempt, request);
            let now = crate::agent::child_jobs::freeze::now()?;
            let allocation = child_jobs::existing_reservation_rows(
                tx,
                native,
                attempt,
                &caller.intent,
                &spec,
                now,
            )?;
            match &previous {
                CallerFreeze::Frozen(frozen) => {
                    if !parent.same_as(&frozen.parent) || allocation != frozen.allocation {
                        return Err(FreezeRefusal::Unavailable);
                    }
                    frozen
                        .prepared
                        .recheck(&caller.origin.root, allocation.deadline_at)?;
                    let digests = FreezeDigests {
                        contract: &frozen.contract_digest,
                        instruction_source: &frozen.prepared.instruction_source_version,
                        policy: &frozen.prepared.policy_digest,
                    };
                    child_jobs::freeze_rows(
                        tx,
                        native,
                        attempt,
                        &caller.intent,
                        &spec,
                        &digests,
                        Some(&allocation),
                        now,
                    )?;
                    Ok(Candidate::Replay(Arc::clone(frozen)))
                }
                CallerFreeze::Fresh => {
                    let prepared =
                        PreparedFreeze::prepare(&caller.origin.root, parent.grant(), &spec)?;
                    let contract_digest = prepared.digest(&allocation, parent, native);
                    prepared.recheck(&caller.origin.root, allocation.deadline_at)?;
                    let digests = FreezeDigests {
                        contract: &contract_digest,
                        instruction_source: &prepared.instruction_source_version,
                        policy: &prepared.policy_digest,
                    };
                    child_jobs::freeze_rows(
                        tx,
                        native,
                        attempt,
                        &caller.intent,
                        &spec,
                        &digests,
                        None,
                        crate::agent::child_jobs::freeze::now()?,
                    )?;
                    Ok(Candidate::New {
                        allocation,
                        contract_digest,
                        prepared: Box::new(prepared),
                    })
                }
                CallerFreeze::Closed => Err(FreezeRefusal::Unavailable),
            }
        },
    );
    let (_, observed, candidate) = match result {
        Ok(value) => value,
        Err(error) => {
            // Malformed/changed caller content is a definite rolled-back request
            // refusal, not a source transition. Every unavailable/uncertain or
            // actual source/evidence/deadline failure leaves the caller closed.
            if matches!(
                error,
                FreezeRefusal::InvalidSpec | FreezeRefusal::RequestKeyConflict
            ) {
                *state = previous;
            }
            return Err(error);
        }
    };
    // Only a classified definite commit with the same exact live observation
    // reaches this point. Recheck source/file identities after commit as well.
    let frozen = match candidate {
        Candidate::New {
            allocation,
            contract_digest,
            prepared,
        } => {
            prepared.recheck(&caller.origin.root, allocation.deadline_at)?;
            recheck_live(app, caller, &observed)?;
            Arc::new(FrozenNativeChild {
                allocation,
                contract_digest,
                prepared: *prepared,
                parent: observed,
            })
        }
        Candidate::Replay(frozen) => {
            frozen
                .prepared
                .recheck(&caller.origin.root, frozen.allocation.deadline_at)?;
            recheck_live(app, caller, &observed)?;
            frozen
        }
    };
    *state = CallerFreeze::Frozen(Arc::clone(&frozen));
    Ok(frozen)
}
// Still a closed consumer. Successful local contract freezing does not prove
// filesystem/process/provider isolation and never starts a child.
pub(crate) fn attempt_frozen_child_start(
    _app: &AppHandle,
    _window: &WebviewWindow,
    _frozen: &FrozenNativeChild,
) -> Result<Infallible, FreezeRefusal> {
    Err(FreezeRefusal::BackendIsolationUnverified)
}
