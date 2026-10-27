//! Original workflow receipt projection. No prepare, approval or dispatch permit.
//! The owning native host retains its original runtime/store guard around this
//! transaction; OpeningFacts and this row helper are not authority factories.
use super::super::native_actions::semantics;
use super::workflow_rows;
use crate::actions::{
    effect_kernel::{self as kernel, MutationContext},
    effect_record::{AdapterTarget, Binding, PrepareAction},
    effect_types::*,
    native_db::AuthorityDb,
    output_handoff,
    schema::{self, ValidatedInput},
    workflow_linkage,
};
use crate::runtime::{workflow_action_inputs, workflows as flow};
use rusqlite::{params, Connection};
fn action(error: ActionError) -> flow::Error {
    match error.code {
        ActionErrorCode::Denied
        | ActionErrorCode::DefinitionMismatch
        | ActionErrorCode::NotFound => flow::Error::Denied,
        ActionErrorCode::RevisionConflict => flow::Error::Stale,
        _ => flow::Error::Unavailable,
    }
}
/// Same-db original-record read only. All mutation admission and adapter
/// operations fail closed, even when original finite facts remain readable.
struct OriginalRead<'a> {
    conn: &'a Connection,
    subject: &'a ActionSubjectView,
    account: &'a AccountId,
}
impl MutationContext for OriginalRead<'_> {
    fn definition(
        &self,
        _: &ActionId,
        _: &DefinitionDigest,
    ) -> Result<ActionDefinition, ActionError> {
        Err(kernel::denied())
    }
    fn check(
        &self,
        _: AuthorityDb<'_>,
        _: &ActionSubjectView,
        _: &PrepareAction,
        _: &ActionDefinition,
    ) -> Result<Binding, ActionError> {
        Err(kernel::denied())
    }
    fn read_access(
        &self,
        db: AuthorityDb<'_>,
        subject: &ActionSubjectView,
        account: &AccountId,
    ) -> Result<(), ActionError> {
        if !matches!(db,AuthorityDb::Writer(conn) if std::ptr::eq(conn,self.conn))
            || subject != self.subject
            || account != self.account
        {
            return Err(kernel::denied());
        }
        Ok(())
    }
    fn target(
        &self,
        _: &ActionDefinition,
        _: &ValidatedInput,
    ) -> Result<AdapterTarget, ActionError> {
        Err(kernel::denied())
    }
    fn preview(
        &self,
        _: &ActionDefinition,
        _: &ValidatedInput,
        _: &AdapterTarget,
    ) -> Result<SafeEffectPreview, ActionError> {
        Err(kernel::denied())
    }
}
/// Original native/FLOW/V45/V44 identity validation only; never admission.
pub(super) fn recorded_action_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    id: &InvocationId,
) -> Result<
    (
        workflow_rows::Origin,
        flow::Run,
        crate::actions::effect_record::ActionInvocation,
        output_handoff::RecordedConsumer,
    ),
    flow::Error,
> {
    let origin = workflow_rows::inspect_rows(conn, facts, run)?;
    let scope = flow::Scope {
        owner: facts.owner,
        vault: facts.vault,
        store: facts.store,
        actor: &origin.actor,
    };
    let subject = ActionSubjectView {
        vault_id: facts.vault.into(),
        run_id: origin.native_run.clone(),
        actor_id: origin.actor.clone(),
        client_id: None,
        child_job_id: None,
    };
    let record = kernel::load(conn, id).map_err(action)?;
    if record.scope != subject {
        return Err(flow::Error::Denied);
    }
    let context = OriginalRead {
        conn,
        subject: &subject,
        account: &record.request.account_id,
    };
    let consumer =
        output_handoff::recorded_consumer_rows(conn, scope, run, &context, &subject, id)?;
    let current = flow::inspect_rows(conn, scope, run)?;
    if !consumer.acknowledged {
        let frozen = workflow_action_inputs::recover_rows(conn, scope, run, &consumer.step)?;
        let ordinal: i64 = conn
            .query_row(
                "SELECT attempt_ordinal FROM workflow_steps WHERE run_id=?1 AND step_id=?2",
                params![run, consumer.step],
                |r| r.get(0),
            )
            .map_err(|_| flow::Error::Unavailable)?;
        if u64::try_from(ordinal).map_err(|_| flow::Error::Unavailable)? != consumer.ordinal
            || frozen.request_key != consumer.request_key
            || frozen.request_digest != record.request_digest
            || frozen.input != record.request.input
            || frozen.selectors.action_id != record.request.action_id.0
            || frozen.selectors.definition_digest != record.request.definition_digest.0
            || frozen.selectors.connection_id != record.request.connection_id.0
            || frozen.selectors.account_id != record.request.account_id.0
            || frozen.selectors.snapshot_digest != record.request.snapshot_digest.0
        {
            return Err(flow::Error::Denied);
        }
        let selected = workflow_rows::selector_rows(conn, facts, run, &consumer.step)?;
        if selected.action != frozen.selectors.action_id
            || selected.definition != frozen.selectors.definition_digest
            || selected.connection != frozen.selectors.connection_id
            || selected.account != frozen.selectors.account_id
            || selected.snapshot != frozen.selectors.snapshot_digest
        {
            return Err(flow::Error::Denied);
        }
    }
    Ok((origin, current, record, consumer))
}
fn reconcile_original(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    expected_epoch: u64,
    id: &InvocationId,
    now: i64,
    opening: OpeningUse,
) -> Result<flow::Run, flow::Error> {
    let (origin, mut current, record, consumer) = recorded_action_rows(conn, facts, run, id)?;
    let scope = flow::Scope {
        owner: facts.owner,
        vault: facts.vault,
        store: facts.store,
        actor: &origin.actor,
    };
    let subject = record.scope.clone();
    let context = OriginalRead {
        conn,
        subject: &subject,
        account: &record.request.account_id,
    };
    if consumer.acknowledged {
        // Terminal bodies are gone; exact finite receipt acknowledgement is idempotent.
        return output_handoff::consume_rows(
            conn,
            scope,
            run,
            current.revision,
            &context,
            &subject,
            id,
            now,
        );
    }
    let effective =
        schema::validate_input(&record.definition, &record.canonical_input).map_err(action)?;
    if effective.digest != record.details.input_digest {
        return Err(flow::Error::Unavailable);
    }
    let mut usable = !current.cancel_requested
        && workflow_rows::receipt_use_rows(conn, facts, run, &consumer.step, &effective.digest)?;
    if usable {
        // Opening loss alone cannot transfer a fresh provider body. Definite
        // cancellation/revocation/narrowing above still takes the discard path.
        if matches!(opening, OpeningUse::Deferred) {
            return Ok(current);
        }
        // Session/process/epoch loss alone defers. It neither authorizes fresh output
        // disclosure nor invents a terminal state for a recoverable active workflow.
        match workflow_rows::admission_rows(conn, facts, run, expected_epoch) {
            Ok(_) => {}
            Err(flow::Error::Denied | flow::Error::Stale) => return Ok(current),
            Err(error) => return Err(error),
        }
        let binding = semantics::checked_binding(
            AuthorityDb::Writer(conn),
            &subject,
            facts.owner,
            &record.authority_request(),
            &record.definition,
        );
        usable = match binding {
            Ok(binding) => {
                binding == record.binding
                    && semantics::target(&record.definition, &effective).map_err(action)?
                        == record.target
            }
            Err(error)
                if matches!(
                    error.code,
                    ActionErrorCode::Denied | ActionErrorCode::DefinitionMismatch
                ) =>
            {
                false
            }
            Err(error) => return Err(action(error)),
        };
    }
    if !usable && !current.cancel_requested {
        current = flow::cancel_rows(conn, scope, run, current.revision, now)?;
    }
    if record.details.effect.state == InvocationState::Succeeded {
        // consume_rows observes cancel_requested and discards+acks in this same tx;
        // successful admitted values alone may enter the next runnable FLOW step.
        return output_handoff::consume_rows(
            conn,
            scope,
            run,
            current.revision,
            &context,
            &subject,
            id,
            now,
        );
    }
    if usable
        && matches!(
            record.details.effect.state,
            InvocationState::Ready | InvocationState::AwaitingApproval
        )
    {
        // Current approval/dispatch orchestration owns these states. OriginalRead
        // must never manufacture a usable mutation context to project them.
        return Ok(current);
    }
    workflow_linkage::observe_with_context(
        conn,
        scope,
        run,
        current.revision,
        &context,
        &subject,
        id,
        now,
    )
}

/// Native-only observed opening disposition; never accepted from IPC/config.
#[derive(Clone, Copy)]
pub(in crate::actions::native_owner) enum OpeningUse {
    Current,
    Deferred,
}
pub(in crate::actions::native_owner) fn reconcile_with_opening(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    expected_epoch: u64,
    id: &InvocationId,
    now: i64,
    opening: OpeningUse,
) -> Result<flow::Run, flow::Error> {
    reconcile_original(conn, facts, run, expected_epoch, id, now, opening)
}

#[cfg(test)]
pub(in crate::actions::native_owner) fn reconcile_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    expected_epoch: u64,
    id: &InvocationId,
    now: i64,
) -> Result<flow::Run, flow::Error> {
    reconcile_original(
        conn,
        facts,
        run,
        expected_epoch,
        id,
        now,
        OpeningUse::Current,
    )
}
