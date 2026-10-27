//! Current-origin sequential row adapter. Work data never supplies permission.
use super::workflow_rows;
use crate::{
    actions::{
        effect_kernel::MutationContext, effect_record::PrepareAction, effect_types::*,
        workflow_bridge,
    },
    runtime::workflows as flow,
    workflows::native_definition as definition,
};
use rusqlite::{params, Connection};
#[derive(Debug)]
pub(in crate::actions::native_owner) enum Step {
    Advanced(flow::Run),
    Read(definition::ReadWork),
    Action {
        run: flow::Run,
        invocation: InvocationId,
        inserted: bool,
    },
    Waiting(flow::Wait),
}
fn scope<'a>(
    facts: workflow_rows::OpeningFacts<'a>,
    origin: &'a workflow_rows::Origin,
) -> flow::Scope<'a> {
    flow::Scope {
        owner: facts.owner,
        vault: facts.vault,
        store: facts.store,
        actor: &origin.actor,
    }
}
pub(in crate::actions::native_owner) fn plan_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    epoch: u64,
    pinned: &definition::NativeDefinition,
) -> Result<definition::Plan, definition::RunnerError> {
    let origin = workflow_rows::admission_rows(conn, facts, run, epoch)?;
    pinned.plan_rows(conn, scope(facts, &origin), run)
}
#[expect(
    clippy::too_many_arguments,
    reason = "native step binds current admission, prepared work and actual ACT context"
)]
pub(in crate::actions::native_owner) fn apply_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    epoch: u64,
    prepared: definition::Prepared,
    context: &dyn MutationContext,
    subject: &ActionSubjectView,
    now: i64,
) -> Result<Step, definition::RunnerError> {
    if prepared.run_id() != run {
        return Err(flow::Error::Denied.into());
    }
    let origin = workflow_rows::admission_rows(conn, facts, run, epoch)?;
    if subject.vault_id != facts.vault
        || subject.run_id != origin.native_run
        || subject.actor_id != origin.actor
        || subject.client_id.is_some()
        || subject.child_job_id.is_some()
    {
        return Err(flow::Error::Denied.into());
    }
    let scope = scope(facts, &origin);
    let current = flow::inspect_rows(conn, scope, run)?;
    let step = current
        .cursor
        .as_deref()
        .ok_or(definition::RunnerError::Unavailable)?;
    let kind: String = conn
        .query_row(
            "SELECT kind FROM workflow_steps WHERE run_id=?1 AND step_id=?2",
            params![run, step],
            |r| r.get(0),
        )
        .map_err(|_| definition::RunnerError::Unavailable)?;
    if kind == "read" {
        workflow_rows::current_rows(
            conn,
            facts,
            run,
            epoch,
            workflow_rows::CurrentUse::QueryRecords,
        )?;
    }
    let selected = if kind == "action" {
        Some(workflow_rows::selector_rows(conn, facts, run, step)?)
    } else {
        None
    };
    let snapshot = selected
        .as_ref()
        .map(|selector| definition::ActionSnapshot {
            snapshot_digest: &selector.snapshot,
            configuration_digest: &origin.configuration,
        });
    // Existing runner CAS owns the exact pinned cursor and claim. For actions its
    // V45 freeze and the real ACT prepare/consumer registration share this tx.
    match definition::apply_rows(conn, scope, prepared, snapshot, facts.process, now)? {
        definition::Applied::Advanced(run) => Ok(Step::Advanced(run)),
        definition::Applied::Read(work) => Ok(Step::Read(work)),
        definition::Applied::Waiting(wait) => Ok(Step::Waiting(wait)),
        definition::Applied::Action(work) => {
            let selector = selected.ok_or(definition::RunnerError::Unavailable)?;
            let frozen = work.request;
            if frozen.selectors.action_id != selector.action
                || frozen.selectors.definition_digest != selector.definition
                || frozen.selectors.connection_id != selector.connection
                || frozen.selectors.account_id != selector.account
                || frozen.selectors.snapshot_digest != selector.snapshot
            {
                return Err(flow::Error::Denied.into());
            }
            workflow_rows::current_rows(
                conn,
                facts,
                run,
                epoch,
                workflow_rows::CurrentUse::Action {
                    step: &work.claim.step,
                    input_digest: &frozen.input_digest,
                },
            )?;
            let request = PrepareAction {
                action_id: ActionId(frozen.selectors.action_id),
                definition_digest: DefinitionDigest(frozen.selectors.definition_digest),
                connection_id: ConnectionId(frozen.selectors.connection_id),
                account_id: AccountId(frozen.selectors.account_id),
                snapshot_digest: SnapshotDigest(frozen.selectors.snapshot_digest),
                input: frozen.input,
                request_key: frozen.request_key,
            };
            let prepared = workflow_bridge::prepare_claim_rows(
                conn,
                scope,
                &work.claim,
                context,
                subject,
                request,
                now,
            )?;
            Ok(Step::Action {
                run: prepared.run,
                invocation: prepared.prepared.effect.invocation_id,
                inserted: prepared.inserted,
            })
        }
    }
}
pub(in crate::actions::native_owner) fn reject_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    epoch: u64,
    plan: &definition::Snapshot,
    error: definition::RunnerError,
    now: i64,
) -> Result<flow::Run, definition::RunnerError> {
    if plan.run_id() != run {
        return Err(flow::Error::Denied.into());
    }
    let origin = workflow_rows::admission_rows(conn, facts, run, epoch)?;
    definition::reject_rows(conn, scope(facts, &origin), plan, error, now)
}
#[expect(
    clippy::too_many_arguments,
    reason = "read settlement binds original claim and current narrowed read admission"
)]
pub(in crate::actions::native_owner) fn settle_read_rows(
    conn: &Connection,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    epoch: u64,
    pinned: &definition::NativeDefinition,
    work: &definition::ReadWork,
    output: Result<&str, definition::ReadError>,
    now: i64,
) -> Result<flow::Run, definition::RunnerError> {
    let origin = workflow_rows::current_rows(
        conn,
        facts,
        run,
        epoch,
        workflow_rows::CurrentUse::QueryRecords,
    )?;
    if work.claim.run != run {
        return Err(flow::Error::Denied.into());
    }
    pinned.settle_read_rows(conn, scope(facts, &origin), work, output, now)
}
