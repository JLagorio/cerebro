use super::types::{ChildJobSpec, SpecRefusal};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreflightRefusal {
    InvalidSpec(SpecRefusal),
    ParentPublicationUnavailable,
    ParentRunMismatch,
    BackendIsolationUnverified,
}

// This deliberately cannot return Queued/Admitted, a subject, grant, job ID,
// run ID, child token or execution capability. Exact publication is a liveness
// prerequisite only; no native owner/attempt authority is inferred from it.
pub(crate) fn inspect_unavailable_candidate(
    mcp: &crate::mcp::McpState,
    witness: &crate::mcp::NativeSlotWitness,
    spec: &ChildJobSpec,
    now: u64,
) -> PreflightRefusal {
    if let Err(error) = spec.validate(now) {
        return PreflightRefusal::InvalidSpec(error);
    }
    // Existing exact-listener/mint/source-slot liveness logic owns this lookup.
    // No native storage/admission lock is held by this refusal-only consumer.
    let Some(parent) = mcp.current_native_publication(witness) else {
        return PreflightRefusal::ParentPublicationUnavailable;
    };
    if parent.run_id() != spec.parent_run_id {
        return PreflightRefusal::ParentRunMismatch;
    }
    // Original publication is NOT native person/store/attempt/job authority.
    // There is no successful variant or caller-supplied capability flag.
    PreflightRefusal::BackendIsolationUnverified
}
