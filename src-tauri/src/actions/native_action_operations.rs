//! Original attended native origin -> shared ACT kernel. No command/IPC door.
//! Synchronous entry points are owned blocking-worker APIs, never main-thread callbacks.
use super::super::{
    authenticate, NativeActionReadOrigin, NativeOwnerError, NativeOwnerState, RetainedRead,
    RuntimeOwner,
};
use super::{action_transaction, cancellation, semantics};
use crate::actions::{
    effect_kernel::{self as kernel, MutationContext},
    effect_record::{ActionInvocation, AdapterTarget, Binding, PrepareAction},
    effect_types::*,
    native_db::AuthorityDb,
    native_lineage, native_rules,
    schema::{self, ValidatedInput},
};
use crate::runtime::action_invocations::SubmissionOwner;
use rusqlite::{Connection, OptionalExtension};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager, WebviewWindow};
fn unavailable<T>() -> Result<T, ActionError> {
    Err(kernel::unavailable())
}
fn same_db(a: AuthorityDb<'_>, b: AuthorityDb<'_>) -> bool {
    match (a, b) {
        (AuthorityDb::Writer(a), AuthorityDb::Writer(b)) => std::ptr::eq(a, b),
        (AuthorityDb::Retained(a), AuthorityDb::Retained(b)) => std::ptr::eq(a, b),
        _ => false,
    }
}
struct GithubContext<'a> {
    db: AuthorityDb<'a>,
    scope: &'a ActionSubjectView,
    owner: &'a str,
}
impl MutationContext for GithubContext<'_> {
    fn definition(
        &self,
        id: &ActionId,
        digest: &DefinitionDigest,
    ) -> Result<ActionDefinition, ActionError> {
        semantics::definition(id, digest)
    }
    fn check(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        request: &PrepareAction,
        definition: &ActionDefinition,
    ) -> Result<Binding, ActionError> {
        if !same_db(self.db, db) || scope != self.scope {
            return Err(kernel::denied());
        }
        semantics::checked_binding(db, scope, self.owner, request, definition)
    }
    fn read_access(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        _account: &AccountId,
    ) -> Result<(), ActionError> {
        if !same_db(self.db, db) || scope != self.scope {
            return Err(kernel::denied());
        }
        Ok(())
    }
    fn target(
        &self,
        definition: &ActionDefinition,
        input: &ValidatedInput,
    ) -> Result<AdapterTarget, ActionError> {
        semantics::target(definition, input)
    }
    fn preview(
        &self,
        definition: &ActionDefinition,
        input: &ValidatedInput,
        _target: &AdapterTarget,
    ) -> Result<SafeEffectPreview, ActionError> {
        semantics::preview(definition, input)
    }
}
fn read_snapshot<T>(
    owner: &mut RuntimeOwner,
    operation: impl FnOnce(&RetainedRead<'_>) -> Result<T, ActionError>,
) -> Result<T, ActionError> {
    let mut domain = None;
    let value = owner.read_snapshot(|read| {
        operation(read).map_err(|error| {
            domain = Some(error);
            NativeOwnerError::Unavailable
        })
    });
    value.map_err(|_| {
        if owner.retired {
            kernel::unavailable()
        } else {
            domain.unwrap_or_else(kernel::unavailable)
        }
    })
}
#[derive(Clone)]
struct AttendedOrigin {
    origin: Arc<NativeActionReadOrigin>,
    model_grant: Option<crate::mcp::RunGrant>,
}
fn current_slot(app: &AppHandle, origin: &NativeActionReadOrigin) -> Result<(), ActionError> {
    let state = app
        .try_state::<Arc<NativeOwnerState>>()
        .ok_or_else(kernel::unavailable)?;
    let mcp = app
        .try_state::<crate::mcp::McpState>()
        .ok_or_else(kernel::unavailable)?;
    let current = mcp
        .current_native_publication(&origin.slot)
        .ok_or_else(kernel::unavailable)?;
    if !Arc::ptr_eq(state.inner(), &origin.owner)
        || !Arc::ptr_eq(&current, &origin.receipt)
        || !origin.owner.registration.live.load(Ordering::SeqCst)
    {
        return unavailable();
    }
    Ok(())
}
impl AttendedOrigin {
    fn capture_model(
        app: &AppHandle,
        call: &crate::mcp::NativeManagedCall,
    ) -> Result<Self, ActionError> {
        // Model-call authority is the actual matched bearer/publication, never
        // a synthesized native window gesture or renderer-supplied run number.
        let agents = app
            .try_state::<crate::agent::AgentState>()
            .ok_or_else(kernel::unavailable)?;
        let origin = call.origin().clone();
        let actual = agents
            .native_action_read_for_publication(call.receipt())
            .ok_or_else(kernel::unavailable)?;
        if !Arc::ptr_eq(&origin, &actual) {
            return unavailable();
        }
        if !Arc::ptr_eq(&origin.receipt, call.receipt()) {
            return unavailable();
        }
        let captured = Self {
            origin,
            model_grant: Some(call.grant().clone()),
        };
        captured.current(app)?;
        Ok(captured)
    }
    fn current(&self, app: &AppHandle) -> Result<(), ActionError> {
        current_slot(app, &self.origin)?;
        if let Some(expected) = &self.model_grant {
            let mcp = app
                .try_state::<crate::mcp::McpState>()
                .ok_or_else(kernel::unavailable)?;
            let observed = mcp
                .current_native_observation(&self.origin.slot)
                .ok_or_else(kernel::unavailable)?;
            if !Arc::ptr_eq(observed.receipt(), &self.origin.receipt)
                || observed.grant() != expected
            {
                return unavailable();
            }
        }
        Ok(())
    }

    fn capture(app: &AppHandle, window: &WebviewWindow, run: u64) -> Result<Self, ActionError> {
        // Native main-thread authentication finishes before any authority lock.
        let proof = authenticate(app, window).map_err(|_| kernel::unavailable())?;
        let agents = app
            .try_state::<crate::agent::AgentState>()
            .ok_or_else(kernel::unavailable)?;
        let origin = agents
            .native_action_read(run)
            .ok_or_else(kernel::unavailable)?;
        if !Arc::ptr_eq(&proof.owner, &origin.owner) {
            return unavailable();
        }
        current_slot(app, &origin)?;
        origin.store.recheck().map_err(|_| kernel::unavailable())?;
        Ok(Self {
            origin,
            model_grant: None,
        })
    }
    fn guarded_rows<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(
            &mut RuntimeOwner,
            &dyn Fn() -> Result<(), ActionError>,
        ) -> Result<T, ActionError>,
    ) -> Result<(Result<T, ActionError>, bool), ActionError> {
        self.current(app)?;
        self.origin
            .store
            .recheck()
            .map_err(|_| kernel::unavailable())?;
        let agents = app
            .try_state::<crate::agent::AgentState>()
            .ok_or_else(kernel::unavailable)?;
        let result = self
            .origin
            .context
            .with_legacy_opening(&self.origin.opening, || {
                let publication = agents
                    .guard_retained_publication(&self.origin.entry, &self.origin.receipt)
                    .map_err(|_| kernel::unavailable())?;
                let mut storage = self
                    .origin
                    .owner
                    .storage
                    .lock()
                    .map_err(|_| kernel::unavailable())?;
                if storage.failed || !self.origin.owner.registration.live.load(Ordering::SeqCst) {
                    return unavailable();
                }
                let owner = storage.owner.as_mut().ok_or_else(kernel::unavailable)?;
                owner.action_cancellations =
                    Arc::downgrade(&self.origin.owner.action_cancellations);
                if !Arc::ptr_eq(&owner.runtime_seal, &self.origin.runtime_seal) {
                    return unavailable();
                }
                let recheck = || {
                    self.origin
                        .store
                        .recheck()
                        .map_err(|_| kernel::unavailable())?;
                    if !publication.recheck()
                        || !self.origin.owner.registration.live.load(Ordering::SeqCst)
                    {
                        return unavailable();
                    }
                    Ok(())
                };
                recheck()?;
                let value = work(owner, &recheck);
                let retired = owner.retired;
                if retired {
                    storage.failed = true;
                    self.origin.owner.action_cancellations.cancel_all();
                    self.origin.owner.credential_cancellations.cancel_all();
                }
                value
            })
            .map_err(|_| kernel::unavailable())?;
        // Never wait for an MCP listener while authority/storage guards are held.
        Ok((result, self.current(app).is_ok()))
    }
    fn admitted(
        &self,
        db: AuthorityDb<'_>,
    ) -> Result<(ActionSubjectView, crate::runtime::native_runs::NativeRun), ActionError> {
        let rules = native_rules::admission_rules();
        let binding = native_lineage::NativeBinding {
            run_id: self.origin.receipt.run_id(),
            vault_id: &self.origin.scope.vault_id,
            store_uuid: self
                .origin
                .scope
                .store_uuid
                .as_deref()
                .ok_or_else(kernel::unavailable)?,
            canonical_vault: &self.origin.root,
            owner_person: &rules.owner_storage_key,
            actor_id: self.origin.receipt.actor_id(),
            source_kind: "run",
            app_session_id: crate::runtime::sessions::session_id(),
            cli_session_id: self.origin.receipt.cli_session_id(),
            parent_run_id: None,
            client_id: None,
            child_job_id: None,
        };
        let joined = native_lineage::resolve_lineage(db, &binding, false)
            .map_err(|_| kernel::unavailable())?;
        if !joined.can_call
            || joined.row.authority_id != self.origin.authority_id
            || joined.row.revision != self.origin.revision
            || self.origin.store.info.store_id != binding.store_uuid
        {
            return unavailable();
        }
        let scope = ActionSubjectView {
            vault_id: joined.row.vault_id.clone(),
            run_id: joined.row.run_id.clone(),
            actor_id: joined.row.actor_id.clone(),
            child_job_id: joined.row.child_job_id.clone(),
            client_id: joined.row.client_id.clone(),
        };
        Ok((scope, joined.row))
    }
}
// Closed owning alternatives. Neither scope views nor row data construct one.
#[derive(Clone)]
enum Origin {
    Attended(AttendedOrigin),
    Workflow(super::super::native_workflows::CurrentWorkflowOrigin),
}
impl Origin {
    fn capture(app: &AppHandle, window: &WebviewWindow, run: u64) -> Result<Self, ActionError> {
        Ok(Self::Attended(AttendedOrigin::capture(app, window, run)?))
    }
    fn owner(&self) -> &Arc<NativeOwnerState> {
        match self {
            Self::Attended(call) => &call.origin.owner,
            Self::Workflow(call) => call.owner(),
        }
    }
    fn store(&self) -> &super::super::NativeStoreObservation {
        match self {
            Self::Attended(call) => &call.origin.store,
            Self::Workflow(call) => call.store(),
        }
    }
    fn native_run(&self) -> &str {
        match self {
            Self::Attended(call) => call.origin.receipt.run_id(),
            Self::Workflow(call) => call.native_run(),
        }
    }
    fn guarded_rows<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(
            &mut RuntimeOwner,
            &dyn Fn() -> Result<(), ActionError>,
        ) -> Result<T, ActionError>,
    ) -> Result<(Result<T, ActionError>, bool), ActionError> {
        match self {
            Self::Attended(call) => call.guarded_rows(app, work),
            Self::Workflow(call) => call.guarded_rows(app, work),
        }
    }
    fn guarded<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(
            &mut RuntimeOwner,
            &dyn Fn() -> Result<(), ActionError>,
        ) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        let (result, current) = self.guarded_rows(app, work)?;
        if !current {
            return unavailable();
        }
        result
    }
    fn with_current_context<T>(
        &self,
        db: AuthorityDb<'_>,
        work: impl FnOnce(
            &dyn MutationContext,
            &ActionSubjectView,
            &crate::runtime::native_runs::NativeRun,
        ) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        match self {
            Self::Attended(call) => {
                let (scope, native) = call.admitted(db)?;
                let context = GithubContext {
                    db,
                    scope: &scope,
                    owner: &native_rules::admission_rules().owner_storage_key,
                };
                work(&context, &scope, &native)
            }
            Self::Workflow(call) => call.with_current_context(db, work),
        }
    }
    fn mutate<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(
            &Connection,
            &dyn MutationContext,
            &ActionSubjectView,
        ) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        self.guarded(app, |owner, recheck| {
            action_transaction(owner, |conn| {
                self.with_current_context(AuthorityDb::Writer(conn), |context, scope, _| {
                    let value = operation(conn, context, scope)?;
                    recheck()?;
                    Ok(value)
                })
            })
        })
    }
    fn inspect<T>(
        &self,
        app: &AppHandle,
        operation: impl FnOnce(
            &RetainedRead<'_>,
            &dyn MutationContext,
            &ActionSubjectView,
        ) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        self.guarded(app, |owner, recheck| {
            read_snapshot(owner, |read| {
                self.with_current_context(AuthorityDb::Retained(read), |context, scope, _| {
                    let value = operation(read, context, scope)?;
                    recheck()?;
                    Ok(value)
                })
            })
        })
    }
}
fn checkpoint(name: &str) {
    crate::crash::crash_point(name);
    crate::crash::stop_point(name);
}
/// Named crash boundary only, called after the owning prepare transaction commits.
pub(in crate::actions::native_owner) fn checkpoint_prepared(inserted: bool) {
    if inserted {
        checkpoint("action-prepared");
    }
}
/// Internal Rust interface only. No IPC or MCP route is registered by this module.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn prepare(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    request: PrepareAction,
) -> Result<PreparedAction, ActionError> {
    let call = Origin::capture(app, window, run)?;
    let rows = call.mutate(app, |conn, context, scope| {
        kernel::prepare_rows(conn, context, scope, request)
    })?;
    checkpoint_prepared(rows.inserted);
    Ok(rows.prepared)
}
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
#[expect(
    clippy::too_many_arguments,
    reason = "native person decision supplies finite selectors and expected revisions, never a person/subject proof"
)]
pub(in crate::actions::native_owner) fn answer(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    approval_id: ApprovalId,
    allow: bool,
    edited_input: Option<String>,
    invocation_revision: u64,
    approval_revision: u64,
) -> Result<ActionEffectRef, ActionError> {
    let call = Origin::capture(app, window, run)?;
    let effect = call.mutate(app, |conn, context, scope| {
        kernel::answer_rows(
            conn,
            context,
            kernel::AnswerInput {
                person_id: native_rules::admission_rules().owner_storage_key.clone(),
                scope: scope.clone(),
                approval_id,
                allow,
                edited_input,
                expected_invocation_revision: invocation_revision,
                expected_approval_revision: approval_revision,
            },
        )
    })?;
    checkpoint_approved();
    Ok(effect)
}
pub(in crate::actions::native_owner) fn effect_details(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    id: InvocationId,
) -> Result<ActionEffectDetails, ActionError> {
    let call = Origin::capture(app, window, run)?;
    call.inspect(app, |read, context, scope| {
        let record = kernel::load(read.conn, &id)?;
        Ok(kernel::readable(context, AuthorityDb::Retained(read), scope, record)?.details)
    })
}
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn effect(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    id: InvocationId,
) -> Result<ActionEffectRef, ActionError> {
    Ok(effect_details(app, window, run, id)?.effect)
}
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn cancel(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    id: InvocationId,
    revision: u64,
) -> Result<ActionEffectRef, ActionError> {
    cancel_origin(app, &Origin::capture(app, window, run)?, id, revision)
}
fn cancel_origin(
    app: &AppHandle,
    call: &Origin,
    id: InvocationId,
    revision: u64,
) -> Result<ActionEffectRef, ActionError> {
    let result = call.guarded(app, |owner, recheck| {
        read_snapshot(owner, |read| {
            call.with_current_context(AuthorityDb::Retained(read), |context, scope, _| {
                let record = kernel::readable(
                    context,
                    AuthorityDb::Retained(read),
                    scope,
                    kernel::load(read.conn, &id)?,
                )?;
                kernel::check_revision(&record, revision)?;
                recheck()?;
                Ok(())
            })
        })?;
        let physical = owner
            .action_submission_owner(&id)
            .map_err(|_| kernel::unavailable())?;
        let changed = action_transaction(owner, |conn| {
            call.with_current_context(AuthorityDb::Writer(conn), |context, scope, _| {
                let result = kernel::cancel_rows(
                    conn,
                    context,
                    scope,
                    &id,
                    revision,
                    if physical.is_some() {
                        kernel::SubmissionAccess::Held
                    } else {
                        kernel::SubmissionAccess::Busy
                    },
                )?;
                recheck()?;
                Ok(result)
            })
        })?;
        // Atomic notification only, after known commit under retained storage.
        call.owner().action_cancellations.cancel_invocation(&id);
        drop(physical);
        Ok(changed)
    })?;
    if result.request_provider_cancel {
        return Err(kernel::unavailable());
    }
    Ok(result.record.details.effect)
}

/// Restricted in-process composition within the current attended operation.
/// Context/connection borrows cannot escape; no ActionSubject or provider resolver.
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn with_attended_mutation<T>(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    operation: impl FnOnce(
        &Connection,
        &dyn MutationContext,
        &ActionSubjectView,
    ) -> Result<T, ActionError>,
) -> Result<T, ActionError> {
    let call = Origin::capture(app, window, run)?;
    call.mutate(app, |conn, context, scope| operation(conn, context, scope))
}

/// Trusted native workflow host composition on its own actual current origin.
/// The host retains WorkflowExecution while this shared ACT worker separately
/// retains ActionSubmission; neither lease is reconstructed from a scope view.
pub(in crate::actions::native_owner) fn with_workflow_mutation<T>(
    app: &AppHandle,
    origin: &super::super::native_workflows::CurrentWorkflowOrigin,
    operation: impl FnOnce(
        &Connection,
        &dyn MutationContext,
        &ActionSubjectView,
    ) -> Result<T, ActionError>,
) -> Result<T, ActionError> {
    Origin::Workflow(origin.clone()).mutate(app, operation)
}
pub(in crate::actions::native_owner) fn with_workflow_inspection<T>(
    app: &AppHandle,
    origin: &super::super::native_workflows::CurrentWorkflowOrigin,
    operation: impl FnOnce(
        &RetainedRead<'_>,
        &dyn MutationContext,
        &ActionSubjectView,
    ) -> Result<T, ActionError>,
) -> Result<T, ActionError> {
    Origin::Workflow(origin.clone()).inspect(app, operation)
}
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no workflow host calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn cancel_workflow(
    app: &AppHandle,
    origin: &super::super::native_workflows::CurrentWorkflowOrigin,
    id: InvocationId,
    revision: u64,
) -> Result<ActionEffectRef, ActionError> {
    cancel_origin(app, &Origin::Workflow(origin.clone()), id, revision)
}

fn fingerprint<T: serde::Serialize>(value: &T) -> Result<String, ActionError> {
    Ok(schema::digest(
        serde_json::to_string(value)
            .map_err(|_| kernel::unavailable())?
            .as_bytes(),
    ))
}
fn native_fingerprint(row: &crate::runtime::native_runs::NativeRun) -> Result<String, ActionError> {
    fingerprint(&(
        "cerebro.native-action-submission-origin",
        1,
        (
            &row.run_id,
            &row.authority_id,
            &row.vault_id,
            &row.store_uuid,
            &row.canonical_vault_path,
            &row.owner_person,
            &row.actor_id,
            &row.source_kind,
            &row.app_session_id,
        ),
        (
            &row.cli_session_id,
            &row.parent_run_id,
            &row.client_id,
            &row.child_job_id,
        ),
        (
            &row.actual_vault,
            &row.actual_store,
            crate::mcp::normalize_actor(row.actual_actor.as_deref()),
            &row.actual_cli,
            &row.actual_parent,
            &row.vault_path,
        ),
    ))
}
fn action_fingerprint(record: &ActionInvocation) -> Result<String, ActionError> {
    fingerprint(&(
        "cerebro.native-action-submission-request",
        1,
        &record.scope,
        &record.request,
        &record.request_digest,
        &record.definition,
        &record.binding,
        &record.target,
        &record.canonical_input,
        &record.details.input_digest,
    ))
}
fn secret_reference(
    conn: &Connection,
    record: &ActionInvocation,
) -> Result<crate::connections::metadata::SecretRef, ActionError> {
    use crate::connections::metadata::{ConnectionHealth, MetadataRecord, STATUS_SQL};
    let metadata = conn
        .query_row(
            STATUS_SQL,
            [
                &record.request.connection_id.0,
                &native_rules::admission_rules().owner_storage_key,
            ],
            MetadataRecord::read,
        )
        .optional()
        .map_err(|_| kernel::unavailable())?
        .ok_or_else(kernel::unavailable)?;
    let account = metadata
        .status
        .account
        .as_ref()
        .ok_or_else(kernel::denied)?;
    let reference = metadata.reference.ok_or_else(kernel::denied)?;
    let identity = fingerprint(&(&account.issuer, &account.subject))?;
    if account.issuer != crate::actions::github_issues::account_issuer()
        || metadata.status.health != ConnectionHealth::Ready
        || metadata.status.cleanup_pending
        || account.account_id != record.binding.account_id
        || account.account_revision != record.binding.account_revision
        || identity != record.binding.account_identity_digest
        || metadata.status.revocation_generation != record.binding.revocation_generation
        || reference.account_id != account.account_id
        || reference.issuer != account.issuer
        || reference.subject != account.subject
        || reference.secret_revision != metadata.status.secret_revision
    {
        return Err(kernel::denied());
    }
    Ok(reference)
}
struct ClaimedData {
    invocation: InvocationId,
    attempt: AttemptId,
    native_fingerprint: String,
    action_fingerprint: String,
    reference: crate::connections::metadata::SecretRef,
    plan: crate::actions::github_issues::IssuePlan,
}
struct Submission {
    origin: Origin,
    runtime_seal: Arc<()>,
    runtime_identity: (u64, u64),
    physical: SubmissionOwner,
    registration: cancellation::Registration,
    data: ClaimedData,
}
enum DispatchAdmission {
    Observed(ActionEffectRef),
    Claimed(Box<Submission>),
    NotSubmitted(Box<Submission>),
    Refused(ActionError),
}
static WORKER: std::sync::Mutex<()> = std::sync::Mutex::new(());
impl Origin {
    fn claim(&self, app: &AppHandle, id: InvocationId) -> Result<DispatchAdmission, ActionError> {
        let (result, current) = self.guarded_rows(app, |owner, recheck| {
            let original = read_snapshot(owner, |read| {
                self.with_current_context(AuthorityDb::Retained(read), |context, scope, _| {
                    let record = kernel::readable(
                        context,
                        AuthorityDb::Retained(read),
                        scope,
                        kernel::load(read.conn, &id)?,
                    )?;
                    recheck()?;
                    Ok(record)
                })
            })?;
            let Some(physical) = owner
                .action_submission_owner(&id)
                .map_err(|_| kernel::unavailable())?
            else {
                let effect = read_snapshot(owner, |read| {
                    self.with_current_context(AuthorityDb::Retained(read), |context, scope, _| {
                        let record = kernel::readable(
                            context,
                            AuthorityDb::Retained(read),
                            scope,
                            kernel::load(read.conn, &id)?,
                        )?;
                        recheck()?;
                        Ok(record.details.effect)
                    })
                })?;
                return Ok(DispatchAdmission::Observed(effect));
            };
            if !physical.matches_retained(&id.0, owner.identity) {
                return unavailable();
            }
            let registration = self
                .owner()
                .action_cancellations
                .register(&original.scope.run_id, &original.request.connection_id, &id)
                .map_err(|_| kernel::unavailable())?;
            enum Rows {
                Refused(ActionError),
                Claimed(Box<ClaimedData>),
            }
            let result = action_transaction(owner, |conn| {
                self.with_current_context(AuthorityDb::Writer(conn), |context, scope, native| {
                    let before = kernel::load(conn, &id)?;
                    if &before.scope != scope {
                        return Err(kernel::denied());
                    }
                    let result = kernel::claim_rows(conn, context, &id)?;
                    let rows = match result {
                        kernel::ClaimDisposition::CommitRefusal(refusal) => Rows::Refused(refusal),
                        kernel::ClaimDisposition::Claimed {
                            attempt_id,
                            canonical_input,
                        } => {
                            let record = kernel::load(conn, &id)?;
                            if record.canonical_input != canonical_input {
                                return unavailable();
                            }
                            let reference = secret_reference(conn, &record)?;
                            let plan = crate::actions::github_issues::prepare(
                                &record.definition,
                                &canonical_input,
                            )?;
                            Rows::Claimed(Box::new(ClaimedData {
                                invocation: id.clone(),
                                attempt: attempt_id,
                                native_fingerprint: native_fingerprint(native)?,
                                action_fingerprint: action_fingerprint(&record)?,
                                reference,
                                plan,
                            }))
                        }
                    };
                    recheck()?;
                    Ok(rows)
                })
            })?;
            match result {
                Rows::Refused(error) => Ok(DispatchAdmission::Refused(error)),
                Rows::Claimed(data) => {
                    checkpoint("action-claimed");
                    // Sole producer: the actual RuntimeOwner known commit owns
                    // one original ACT attempt and its physical submission lease.
                    Ok(DispatchAdmission::Claimed(Box::new(Submission {
                        origin: self.clone(),
                        runtime_seal: owner.runtime_seal.clone(),
                        runtime_identity: owner.identity,
                        physical,
                        registration,
                        data: *data,
                    })))
                }
            }
        })?;
        if current {
            return result;
        }
        match result {
            Ok(DispatchAdmission::Claimed(submission)) => {
                Ok(DispatchAdmission::NotSubmitted(submission))
            }
            _ => unavailable(),
        }
    }
}

impl Submission {
    fn stopped(&self) -> bool {
        self.registration.stopped() || !self.origin.owner().registration.live.load(Ordering::SeqCst)
    }
    fn recheck_before_http(&self, app: &AppHandle) -> Result<(), ActionError> {
        if self.stopped() {
            return Err(kernel::denied());
        }
        self.origin.guarded(app, |owner, recheck| {
            if !Arc::ptr_eq(&owner.runtime_seal, &self.runtime_seal)
                || owner.identity != self.runtime_identity
                || !self
                    .physical
                    .matches_retained(&self.data.invocation.0, owner.identity)
            {
                return unavailable();
            }
            read_snapshot(owner, |read| {
                self.origin.with_current_context(
                    AuthorityDb::Writer(read.conn),
                    |context, scope, _| {
                        let record = kernel::load(read.conn, &self.data.invocation)?;
                        if record.cancel_requested
                            || !matches!(
                                record.details.effect.state,
                                InvocationState::Dispatched | InvocationState::OutcomeUnknown
                            )
                            || &record.scope != scope
                            || action_fingerprint(&record)? != self.data.action_fingerprint
                            || record
                                .details
                                .attempts
                                .last()
                                .map(|attempt| &attempt.attempt_id)
                                != Some(&self.data.attempt)
                        {
                            return Err(kernel::denied());
                        }
                        kernel::check(read.conn, context, &record)?;
                        if secret_reference(read.conn, &record)? != self.data.reference
                            || self.stopped()
                        {
                            return Err(kernel::denied());
                        }
                        recheck()?;
                        Ok(())
                    },
                )
            })
        })
    }
    fn settle(
        self,
        observation: kernel::Observation,
    ) -> Result<kernel::CompletedObservation, ActionError> {
        // Existing native capsule only: completed facts do not need a new
        // opening, MCP slot, CLI publication, current account grant or gesture.
        let mut storage = self
            .origin
            .owner()
            .storage
            .lock()
            .map_err(|_| kernel::unavailable())?;
        if storage.failed {
            return unavailable();
        }
        let owner = storage.owner.as_mut().ok_or_else(kernel::unavailable)?;
        owner.action_cancellations = Arc::downgrade(&self.origin.owner().action_cancellations);
        let facts = SubmissionFacts {
            runtime_seal: self.runtime_seal.clone(),
            runtime_identity: self.runtime_identity,
            invocation: self.data.invocation.clone(),
            attempt: self.data.attempt.clone(),
            native_run: self.origin.native_run().to_owned(),
            native_fingerprint: self.data.native_fingerprint.clone(),
            action_fingerprint: self.data.action_fingerprint.clone(),
        };
        let result = settle_original_completed_rows(
            owner,
            self.origin.store(),
            &self.physical,
            &facts,
            observation,
        );
        if owner.retired {
            storage.failed = true;
            self.origin.owner().action_cancellations.cancel_all();
            self.origin.owner().credential_cancellations.cancel_all();
        }
        // self still owns physical lease, payload and registration until this
        // transaction finishes; provider cleanup precedes calling this method.
        result
    }
}
/// Private synchronous worker entry. Future callers must schedule it on their
/// owned blocking worker; this module registers no dispatch IPC or MCP route.
#[cfg(target_os = "macos")]
fn dispatch_completed_origin(
    app: &AppHandle,
    call: Origin,
    id: InvocationId,
    control: Option<&crate::mcp::NativeManagedCall>,
) -> Result<kernel::CompletedObservation, ActionError> {
    // Admission is bounded structurally to one fixed native provider worker.
    // Authentication above finishes before this worker/authority lock is held.
    let _worker = WORKER.try_lock().map_err(|_| kernel::unavailable())?;
    let (submission, source_current) = match call.claim(app, id)? {
        DispatchAdmission::Observed(effect) => {
            return Ok(kernel::CompletedObservation {
                effect,
                output: None,
            })
        }
        DispatchAdmission::Refused(refusal) => return Err(refusal),
        DispatchAdmission::NotSubmitted(submission) => (submission, false),
        DispatchAdmission::Claimed(submission) => (submission, true),
    };
    let stopped = || submission.stopped() || control.is_some_and(|call| call.stopped());
    if pre_submit_decision(source_current, stopped()) == PreSubmitDecision::NotSubmitted {
        return submission.settle(kernel::Observation::ConfirmedNotApplied);
    }
    #[cfg(feature = "native-action-smoke")]
    {
        // The explicit disposable executable cannot select the real secret or
        // transport path. Authority/Claim/lease/preflight/settlement stay real.
        if pre_submit_decision(submission.recheck_before_http(app).is_ok(), stopped())
            == PreSubmitDecision::NotSubmitted
        {
            return submission.settle(kernel::Observation::ConfirmedNotApplied);
        }
        let observation = smoke::execute(app, &submission);
        return submission.settle(observation);
    }
    #[cfg(not(feature = "native-action-smoke"))]
    {
        // Rust-only selected reference. No authority/storage guard crosses Keychain.
        let store = crate::connections::secrets::platform_secret_store();
        let secret = match store.resolve(&submission.data.reference) {
            Ok(secret) => secret,
            Err(_) => return submission.settle(kernel::Observation::ConfirmedNotApplied),
        };
        if pre_submit_decision(submission.recheck_before_http(app).is_ok(), stopped())
            == PreSubmitDecision::NotSubmitted
        {
            drop(secret);
            return submission.settle(kernel::Observation::ConfirmedNotApplied);
        }
        let outcome =
            crate::actions::github_issues::execute(&submission.data.plan, &secret, &stopped);
        // execute returns only after its dedicated runtime/HTTP driver/blocking DNS
        // are physically dropped/joined. Never overwrite a completed fact on cancel.
        drop(secret);
        let observation = match outcome {
            crate::actions::github_issues::TransportOutcome::NotSubmitted => {
                kernel::Observation::ConfirmedNotApplied
            }
            crate::actions::github_issues::TransportOutcome::Observed(
                crate::actions::github_issues::IssueOutcome::Succeeded {
                    output,
                    remote_reference,
                },
            ) => kernel::Observation::Succeeded {
                output,
                remote_effect_reference: Some(remote_reference),
            },
            crate::actions::github_issues::TransportOutcome::Observed(
                crate::actions::github_issues::IssueOutcome::NotApplied,
            ) => kernel::Observation::ConfirmedNotApplied,
            crate::actions::github_issues::TransportOutcome::Observed(
                crate::actions::github_issues::IssueOutcome::Unknown,
            ) => kernel::Observation::Unknown,
        };
        submission.settle(observation)
    }
}
#[cfg(not(target_os = "macos"))]
fn dispatch_completed_origin(
    _app: &AppHandle,
    _call: Origin,
    _id: InvocationId,
    _control: Option<&crate::mcp::NativeManagedCall>,
) -> Result<kernel::CompletedObservation, ActionError> {
    unavailable()
}
fn dispatch_origin(
    app: &AppHandle,
    call: Origin,
    id: InvocationId,
) -> Result<ActionEffectRef, ActionError> {
    dispatch_completed_origin(app, call, id, None).map(|completed| completed.effect)
}
#[cfg(target_os = "macos")]
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn dispatch(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
    id: InvocationId,
) -> Result<ActionEffectRef, ActionError> {
    dispatch_origin(app, Origin::capture(app, window, run)?, id)
}
#[cfg(target_os = "macos")]
pub(in crate::actions::native_owner) fn dispatch_workflow(
    app: &AppHandle,
    origin: &super::super::native_workflows::CurrentWorkflowOrigin,
    id: InvocationId,
) -> Result<ActionEffectRef, ActionError> {
    dispatch_origin(app, Origin::Workflow(origin.clone()), id)
}
#[cfg(not(target_os = "macos"))]
pub(in crate::actions::native_owner) fn dispatch_workflow(
    _app: &AppHandle,
    _origin: &super::super::native_workflows::CurrentWorkflowOrigin,
    _id: InvocationId,
) -> Result<ActionEffectRef, ActionError> {
    unavailable()
}
#[cfg(not(target_os = "macos"))]
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "no window-bound attended ACT door calls this yet, in any build; non-test builds carry native_actions.rs's module expectation"
    )
)]
pub(in crate::actions::native_owner) fn dispatch(
    _app: &AppHandle,
    _window: &WebviewWindow,
    _run: u64,
    _id: InvocationId,
) -> Result<ActionEffectRef, ActionError> {
    unavailable()
}

// Comparison-only captured facts. No constructor here authenticates a native
// caller or grants provider execution; the sole production producer is Claim.
struct SubmissionFacts {
    runtime_seal: Arc<()>,
    runtime_identity: (u64, u64),
    invocation: InvocationId,
    attempt: AttemptId,
    native_run: String,
    native_fingerprint: String,
    action_fingerprint: String,
}
#[derive(Debug, PartialEq, Eq)]
enum PreSubmitDecision {
    Poll,
    NotSubmitted,
}
fn pre_submit_decision(source_current: bool, cancelled: bool) -> PreSubmitDecision {
    if source_current && !cancelled {
        PreSubmitDecision::Poll
    } else {
        PreSubmitDecision::NotSubmitted
    }
}
fn settle_original_rows(
    owner: &mut RuntimeOwner,
    store: &super::super::NativeStoreObservation,
    physical: &SubmissionOwner,
    facts: &SubmissionFacts,
    observation: kernel::Observation,
) -> Result<ActionEffectRef, ActionError> {
    settle_original_completed_rows(owner, store, physical, facts, observation)
        .map(|completed| completed.effect)
}
fn settle_original_completed_rows(
    owner: &mut RuntimeOwner,
    store: &super::super::NativeStoreObservation,
    physical: &SubmissionOwner,
    facts: &SubmissionFacts,
    observation: kernel::Observation,
) -> Result<kernel::CompletedObservation, ActionError> {
    if !Arc::ptr_eq(&owner.runtime_seal, &facts.runtime_seal)
        || owner.identity != facts.runtime_identity
        || !physical.matches_retained(&facts.invocation.0, owner.identity)
    {
        return unavailable();
    }
    action_transaction(owner, |conn| {
        store.recheck().map_err(|_| kernel::unavailable())?;
        let native = native_lineage::load_run(AuthorityDb::Writer(conn), &facts.native_run)
            .map_err(|_| kernel::unavailable())?;
        if native_fingerprint(&native)? != facts.native_fingerprint {
            return unavailable();
        }
        let record = kernel::load(conn, &facts.invocation)?;
        if action_fingerprint(&record)? != facts.action_fingerprint
            || record
                .details
                .attempts
                .last()
                .map(|attempt| &attempt.attempt_id)
                != Some(&facts.attempt)
        {
            return unavailable();
        }
        let effect = kernel::observe_completed_rows(
            conn,
            &facts.invocation,
            &facts.attempt,
            None,
            observation,
        )?;
        store.recheck().map_err(|_| kernel::unavailable())?;
        Ok(effect)
    })
}
#[cfg(all(test, target_os = "macos"))]
#[path = "native_action_settlement_tests.rs"]
mod settlement_tests;

#[path = "native_action_grants.rs"]
pub(in crate::actions::native_owner) mod grants;

/// Cancellation-only composition under the caller's genuine retained original
/// control guard. The owner validates its original DB and durable namespace;
/// it refuses active transactions and never opens another DB/path authority.
/// This physical lease alone permits no claim, dispatch or secret resolution.
pub(in crate::actions::native_owner) fn retained_cancellation_lease(
    owner: &mut RuntimeOwner,
    id: &InvocationId,
) -> Result<Option<SubmissionOwner>, ActionError> {
    owner
        .action_submission_owner(id)
        .map_err(|_| kernel::unavailable())
}

#[path = "native_action_call.rs"]
pub(in crate::actions::native_owner) mod managed_call;

pub(in crate::actions::native_owner) fn checkpoint_approved() {
    checkpoint("action-approved");
}

#[cfg(feature = "native-action-smoke")]
#[path = "native_action_smoke.rs"]
pub(in crate::actions::native_owner) mod smoke;
