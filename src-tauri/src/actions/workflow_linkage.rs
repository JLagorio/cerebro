//! ACT-owned workflow observation seam over the caller-owned retained transaction.
//! Uses one caller-owned transaction; never prepares, approves or dispatches.
use super::{effect_kernel as kernel, effect_record::{scope_key, ApprovalDecision}, effect_types::{ActionError, ActionErrorCode, InvocationId, InvocationState}, native_db::AuthorityDb, schema};
use super::effect_kernel::MutationContext;
#[cfg(test)]
use super::service::{ActionSubject,DurableActionService};
use crate::runtime::workflows::{self, Scope, EffectState};
use rusqlite::{Connection, params};
fn action_error(error: ActionError) -> workflows::Error {
    match error.code {
        ActionErrorCode::Denied | ActionErrorCode::NotFound | ActionErrorCode::DefinitionMismatch => workflows::Error::Denied,
        ActionErrorCode::RevisionConflict => workflows::Error::Stale,
        _ => workflows::Error::Unavailable,
    }
}
#[expect(clippy::too_many_arguments, reason = "same-transaction ACT observation binds original subject, invocation and workflow revision")]
pub(super) fn observe_with_context(
    conn: &Connection, scope: Scope<'_>, run_id: &str, expected: u64,
    context: &dyn MutationContext, subject: &super::effect_types::ActionSubjectView,
    invocation: &InvocationId, now: i64,
) -> Result<workflows::Run, workflows::Error> {
    let run = workflows::inspect_rows(conn, scope, run_id)?;
    if run.revision != expected { return Err(workflows::Error::Stale); }
    let step = run.cursor.as_deref().ok_or(workflows::Error::Stale)?;
    let record = kernel::load(conn, invocation).map_err(action_error)?;
    // The caller supplies the actual admitted context bound to this connection.
    // A scope view alone cannot satisfy the context's authority checks.
    kernel::readable(context, AuthorityDb::Writer(conn), subject, record.clone()).map_err(action_error)?;
    if record.details.effect.invocation_id != *invocation || record.scope.vault_id != scope.vault || record.scope.actor_id != scope.actor {
        return Err(workflows::Error::Denied);
    }
    let (act_scope, act_run): (Option<String>, Option<String>) = conn.query_row(
        "SELECT act_scope_digest,act_run_id FROM workflow_runs WHERE run_id=?1", [run_id],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).map_err(|_|workflows::Error::Unavailable)?;
    let original_scope = scope_key(&record.scope).map_err(action_error)?;
    if act_scope.as_deref() != Some(original_scope.as_str()) || act_run.as_deref() != Some(record.scope.run_id.as_str()) {
        return Err(workflows::Error::Denied);
    }
    let (ordinal,key,input_digest): (i64,String,String) = conn.query_row(
        "SELECT a.ordinal,a.request_key,a.input_digest FROM workflow_attempts a JOIN workflow_steps s ON s.run_id=a.run_id AND s.step_id=a.step_id AND s.attempt_ordinal=a.ordinal WHERE a.run_id=?1 AND a.step_id=?2",
        params![run_id,step], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).map_err(|_|workflows::Error::Unavailable)?;
    // Compare the original prepared request, never the edited approved input.
    let original = schema::validate_input(&record.definition, &record.request.input).map_err(action_error)?;
    if record.request.request_key != key || original.digest != input_digest { return Err(workflows::Error::Denied); }
    let ordinal = u64::try_from(ordinal).map_err(|_|workflows::Error::Unavailable)?;
    let state = match record.details.effect.state {
        InvocationState::Prepared => return Err(workflows::Error::Unavailable),
        InvocationState::AwaitingApproval | InvocationState::Ready => {
            match kernel::check(conn,context,&record) {
                Err(error) if matches!(error.code,ActionErrorCode::Denied|ActionErrorCode::DefinitionMismatch) => EffectState::Revoked,
                Err(error) => return Err(action_error(error)),
                Ok(()) if record.approval.as_ref().is_some_and(|approval|approval.view.expires_at<=kernel::now()) => EffectState::Expired,
                Ok(()) if record.approval.as_ref().is_some_and(|approval|approval.retired) => EffectState::Revoked,
                Ok(()) if record.details.effect.state == InvocationState::Ready => EffectState::Ready,
                Ok(()) => EffectState::AwaitingApproval,
            }
        },
        InvocationState::Dispatched => EffectState::Dispatched,
        // ACT presently stores success/receipt identity but no normalized output.
        // Preserve its known success and FLOW's operational values/reservation.
        InvocationState::Succeeded => EffectState::OutputUnavailable,
        InvocationState::Failed | InvocationState::Cancelled if record.approval.as_ref().is_some_and(|approval|matches!(approval.decision.as_ref(),Some(ApprovalDecision::Deny))) => EffectState::Denied,
        InvocationState::Failed => EffectState::Failed,
        InvocationState::OutcomeUnknown => EffectState::Unknown,
        InvocationState::Cancelled => EffectState::Cancelled,
    };
    workflows::effect_rows(conn,scope,run_id,expected,workflows::Effect {
        step,ordinal,request_key:&key,invocation:&invocation.0,
        approval:record.approval.as_ref().map(|approval|approval.view.approval_id.0.as_str()),
        revision:record.revision(),state,output:None,
    },now)
}

#[cfg(test)]
#[expect(clippy::too_many_arguments, reason="test service wrapper preserves the existing real subject capability boundary")]
fn observe_rows(conn:&Connection,scope:Scope<'_>,run_id:&str,expected:u64,service:&DurableActionService,subject:ActionSubject,invocation:&InvocationId,now:i64)->Result<workflows::Run,workflows::Error>{
    observe_with_context(conn,scope,run_id,expected,service,subject.view(),invocation,now)
}

#[cfg(test)]
#[path = "workflow_linkage_tests.rs"]
mod tests;
