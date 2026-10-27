//! FLOW's same-transaction ACT prepare and output-consumer handoff.
//! Caller supplies actual admitted context; this module creates no authority.
use super::{
    effect_kernel::MutationContext,
    effect_record::PrepareAction,
    effect_types::{ActionSubjectView, PreparedAction},
};
use crate::runtime::workflows::{self as flow, Scope, StepClaim};
use rusqlite::Connection;
#[derive(Debug)]
pub(super) struct PreparedWorkflowAction {
    pub(super) prepared: PreparedAction,
    pub(super) run: flow::Run,
    pub(super) inserted: bool,
}
pub(super) fn prepare_claim_rows(
    conn: &Connection,
    scope: Scope<'_>,
    claim: &StepClaim,
    context: &dyn MutationContext,
    subject: &ActionSubjectView,
    request: PrepareAction,
    now: i64,
) -> Result<PreparedWorkflowAction, flow::Error> {
    use super::{effect_kernel as kernel, effect_record, output_handoff, schema, workflow_linkage};
    fn action(error: super::effect_types::ActionError) -> flow::Error {
        match error.code {
            super::effect_types::ActionErrorCode::Denied
            | super::effect_types::ActionErrorCode::NotFound
            | super::effect_types::ActionErrorCode::DefinitionMismatch => flow::Error::Denied,
            super::effect_types::ActionErrorCode::RevisionConflict => flow::Error::Stale,
            super::effect_types::ActionErrorCode::RequestKeyConflict => flow::Error::Conflict,
            _ => flow::Error::Unavailable,
        }
    }
    flow::check_claim_rows(conn, scope, claim)?;
    if request.request_key != claim.request_key
        || subject.vault_id != scope.vault
        || subject.actor_id != scope.actor
    {
        return Err(flow::Error::Denied);
    }
    let (act_scope,act_run,kind):(Option<String>,Option<String>,String)=conn.query_row("SELECT r.act_scope_digest,r.act_run_id,s.kind FROM workflow_runs r JOIN workflow_steps s ON s.run_id=r.run_id WHERE r.run_id=?1 AND s.step_id=?2",rusqlite::params![claim.run,claim.step],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_|flow::Error::Unavailable)?;
    let digest = effect_record::scope_key(subject).map_err(action)?;
    if kind != "action"
        || act_scope.as_deref() != Some(digest.as_str())
        || act_run.as_deref() != Some(subject.run_id.as_str())
    {
        return Err(flow::Error::Denied);
    }
    let definition = context
        .definition(&request.action_id, &request.definition_digest)
        .map_err(action)?;
    let input = schema::validate_input(&definition, &request.input).map_err(action)?;
    if input.digest != claim.input_digest {
        return Err(flow::Error::Denied);
    }
    let result = kernel::prepare_rows(conn, context, subject, request).map_err(action)?;
    let id = &result.prepared.effect.invocation_id;
    output_handoff::register_rows(conn, scope, claim, context, subject, id)?;
    let run = workflow_linkage::observe_with_context(
        conn,
        scope,
        &claim.run,
        claim.run_revision,
        context,
        subject,
        id,
        now,
    )?;
    Ok(PreparedWorkflowAction {
        prepared: result.prepared,
        run,
        inserted: result.inserted,
    })
}
#[cfg(test)]
#[path = "workflow_bridge_tests.rs"]
mod tests;
