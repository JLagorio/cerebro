//! Native workflow origin producer. No IPC route or external authority factory.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "native workflow host is composed after causal admission tests"
    )
)]
use super::{workflow_rows, NativeOwnerState, NativeStoreObservation, RuntimeOwner};
use crate::actions::{
    effect_kernel::MutationContext, effect_types::ActionError, native_db::AuthorityDb,
    read_types::ActionSubjectView,
};
use std::{path::PathBuf, sync::Arc};
use tauri::AppHandle;
struct WorkflowOpening {
    owner: Arc<NativeOwnerState>,
    context: crate::workspace_service::authority::AuthorityContext,
    opening: crate::workspace_service::authority::LegacyOpeningTicket,
    root: PathBuf,
    store: NativeStoreObservation,
    scope: crate::runtime::VaultScope,
    runtime_seal: Arc<()>,
    session: String,
    process: String,
}
#[derive(Clone)]
pub(in crate::actions::native_owner) struct CurrentWorkflowOrigin {
    opening: Arc<WorkflowOpening>,
    origin: workflow_rows::Origin,
    physical: Arc<crate::runtime::workflow_submission::ExecutionOwner>,
}
impl CurrentWorkflowOrigin {
    pub(in crate::actions::native_owner) fn guarded_rows<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(
            &mut RuntimeOwner,
            &dyn Fn() -> Result<(), ActionError>,
        ) -> Result<T, ActionError>,
    ) -> Result<(Result<T, ActionError>, bool), ActionError> {
        self.opening.guarded_rows(app, |owner, recheck| {
            if !self
                .physical
                .matches_retained(&self.origin.flow_run, owner.identity)
            {
                return Err(kernel::unavailable());
            }
            work(owner, recheck)
        })
    }
    pub(in crate::actions::native_owner) fn with_current_context<T>(
        &self,
        db: AuthorityDb<'_>,
        work: impl FnOnce(
            &dyn MutationContext,
            &ActionSubjectView,
            &crate::runtime::native_runs::NativeRun,
        ) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        let conn = row_db(db)?;
        let admitted = workflow_rows::admission_rows(
            conn,
            self.opening.facts(),
            &self.origin.flow_run,
            self.origin.epoch,
        )
        .map_err(action_error)?;
        if admitted != self.origin {
            return Err(kernel::stale());
        }
        let scope = self.subject();
        let native = native_lineage::load_run(db, &self.origin.native_run)
            .map_err(|_| kernel::unavailable())?;
        let context = WorkflowContext {
            db,
            scope: &scope,
            origin: self,
        };
        work(&context, &scope, &native)
    }
    pub(in crate::actions::native_owner) fn owner(&self) -> &Arc<NativeOwnerState> {
        &self.opening.owner
    }
    pub(in crate::actions::native_owner) fn store(&self) -> &NativeStoreObservation {
        &self.opening.store
    }
    pub(in crate::actions::native_owner) fn runtime_seal(&self) -> &Arc<()> {
        &self.opening.runtime_seal
    }
    pub(in crate::actions::native_owner) fn native_run(&self) -> &str {
        &self.origin.native_run
    }
}
/// Actual RuntimeOwner commit classification; returns row data, never an origin
/// capability. The authenticated producer alone wraps a known committed result.
pub(super) fn start_owned_rows(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    start: workflow_rows::Start<'_>,
    recheck: impl Fn() -> Result<(), crate::runtime::workflows::Error>,
) -> Result<workflow_rows::Started, crate::runtime::workflows::Error> {
    row_transaction(owner, recheck, |conn| {
        workflow_rows::start_rows(conn, facts, start)
    })
}

/// Row coordinator only; authenticated native caller notifies the shared worker
/// book after known commit while still retaining the same storage guard.
pub(super) fn revoke_owned_rows(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    run: &str,
    expected: u64,
    now: chrono::DateTime<chrono::Utc>,
    recheck: impl Fn() -> Result<(), crate::runtime::workflows::Error>,
) -> Result<workflow_rows::Origin, crate::runtime::workflows::Error> {
    row_transaction(owner, recheck, |conn| {
        let origin = workflow_rows::revoke_rows(conn, facts, run, expected, now)?;
        let scope = crate::runtime::workflows::Scope {
            owner: facts.owner,
            vault: facts.vault,
            store: facts.store,
            actor: &origin.actor,
        };
        let current = crate::runtime::workflows::inspect_rows(conn, scope, run)?;
        crate::runtime::workflows::cancel_rows(
            conn,
            scope,
            run,
            current.revision,
            now.timestamp_millis(),
        )?;
        Ok(origin)
    })
}

fn row_transaction<T>(
    owner: &mut RuntimeOwner,
    recheck: impl Fn() -> Result<(), crate::runtime::workflows::Error>,
    operation: impl FnOnce(&rusqlite::Connection) -> Result<T, crate::runtime::workflows::Error>,
) -> Result<T, crate::runtime::workflows::Error> {
    use super::{NativeOwnerError, RuntimeTransactionOutcome};
    use crate::runtime::workflows::Error;
    let mut domain = None;
    let outcome = owner.classified_transaction(|conn| {
        let result = (|| {
            recheck()?;
            let value = operation(conn)?;
            recheck()?;
            Ok(value)
        })();
        result.map_err(|error| {
            domain = Some(error);
            NativeOwnerError::Unavailable
        })
    });
    match outcome {
        RuntimeTransactionOutcome::Committed(value) => Ok(value),
        RuntimeTransactionOutcome::NotCommitted(_) => Err(if owner.retired {
            Error::Unavailable
        } else {
            domain.unwrap_or(Error::Unavailable)
        }),
        RuntimeTransactionOutcome::CommitUncertain => Err(Error::Unavailable),
    }
}

use super::native_actions::semantics;
use super::{authenticate, read_native_store, NativeOwnerError, RuntimeTransactionOutcome};
use crate::actions::{
    effect_kernel as kernel,
    effect_record::{AdapterTarget, Binding, PrepareAction},
    effect_types::*,
    native_lineage,
    schema::{self, ValidatedInput},
};
use crate::runtime::workflows as flow;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::{atomic::Ordering, OnceLock};
use tauri::{Manager, WebviewWindow};
fn action_error(error: flow::Error) -> ActionError {
    match error {
        flow::Error::Denied => kernel::denied(),
        flow::Error::Stale => kernel::stale(),
        flow::Error::Invalid => crate::actions::read_types::error(
            ActionErrorCode::InvalidInput,
            "Workflow input is invalid.",
        ),
        flow::Error::Conflict => crate::actions::read_types::error(
            ActionErrorCode::RequestKeyConflict,
            "Workflow start identity changed.",
        ),
        flow::Error::Capacity => crate::actions::read_types::error(
            ActionErrorCode::LimitExceeded,
            "Workflow operational capacity is unavailable.",
        ),
        _ => kernel::unavailable(),
    }
}
fn process_identity() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(crate::ledger::new_id128)
}
fn same_db(left: AuthorityDb<'_>, right: AuthorityDb<'_>) -> bool {
    match (left, right) {
        (AuthorityDb::Writer(a), AuthorityDb::Writer(b)) => std::ptr::eq(a, b),
        (AuthorityDb::Retained(a), AuthorityDb::Retained(b)) => std::ptr::eq(a, b),
        _ => false,
    }
}
fn row_db<'a>(db: AuthorityDb<'a>) -> Result<&'a Connection, ActionError> {
    match db {
        AuthorityDb::Writer(conn) => Ok(conn),
        AuthorityDb::Retained(read) => Ok(read.conn),
        #[cfg(test)]
        AuthorityDb::Reader(_) => Err(kernel::denied()),
    }
}
pub(in crate::actions::native_owner) fn workflow_configuration(
    definition: &crate::workflows::native_definition::NativeDefinition,
) -> Result<String, ActionError> {
    let selectors = definition.selectors();
    let selectors = selectors
        .iter()
        .map(|s| (&s.step, &s.action, &s.definition, &s.connection, &s.account))
        .collect::<Vec<_>>();
    let format = schema::digest(include_bytes!("../../../shared/workflows/format.v1.json"));
    let runtime = schema::digest(include_bytes!("../../../shared/workflows/runtime.v1.json"));
    let bytes = serde_json::to_string(&(
        "cerebro.native-workflow-engine",
        1,
        format,
        runtime,
        definition.workflow(),
        definition.version(),
        selectors,
    ))
    .map_err(|_| kernel::unavailable())?;
    Ok(schema::digest(bytes.as_bytes()))
}

impl WorkflowOpening {
    fn facts(&self) -> workflow_rows::OpeningFacts<'_> {
        workflow_rows::OpeningFacts {
            owner: &crate::actions::native_rules::admission_rules().owner_storage_key,
            vault: &self.scope.vault_id,
            store: &self.store.info.store_id,
            canonical_vault: self
                .root
                .to_str()
                .expect("native producer requires UTF-8 path"),
            session: &self.session,
            process: &self.process,
        }
    }
    fn capture(app: &AppHandle, window: &WebviewWindow) -> Result<Arc<Self>, ActionError> {
        // The actual injected main-window observation finishes before authority locks.
        let proof = authenticate(app, window).map_err(|_| kernel::unavailable())?;
        let context =
            crate::workspace_service::authority::context().map_err(|_| kernel::unavailable())?;
        let (root, opening) = context
            .capture_current_legacy_opening()
            .map_err(|_| kernel::unavailable())?;
        root.to_str().ok_or_else(kernel::unavailable)?;
        let store = context
            .with_legacy_opening(&opening, || read_native_store(&root))
            .map_err(|_| kernel::unavailable())?
            .map_err(|_| kernel::unavailable())?;
        let scope = crate::runtime::VaultScope {
            vault_id: crate::runtime::scope::derive_vault_id(&root),
            store_uuid: Some(store.info.store_id.clone()),
        };
        let runtime_seal = context
            .with_legacy_opening(&opening, || {
                let mut storage = proof
                    .owner
                    .storage
                    .lock()
                    .map_err(|_| kernel::unavailable())?;
                if storage.failed || !proof.owner.registration.live.load(Ordering::SeqCst) {
                    return Err(kernel::unavailable());
                }
                let owner = storage.owner.as_mut().ok_or_else(kernel::unavailable)?;
                owner.action_cancellations = Arc::downgrade(&proof.owner.action_cancellations);
                owner.credential_cancellations =
                    Arc::downgrade(&proof.owner.credential_cancellations);
                let seal = owner.runtime_seal.clone();
                let result = owner.read_snapshot(|read| {
                    RuntimeOwner::verify_open_session(read.conn, &root, &scope)?;
                    store.recheck()?;
                    Ok(seal)
                });
                let retired = owner.retired;
                if retired {
                    storage.failed = true;
                    proof.owner.action_cancellations.cancel_all();
                    proof.owner.credential_cancellations.cancel_all();
                }
                result.map_err(|_| kernel::unavailable())
            })
            .map_err(|_| kernel::unavailable())??;
        Ok(Arc::new(Self {
            owner: proof.owner,
            context,
            opening,
            root,
            store,
            scope,
            runtime_seal,
            session: crate::runtime::sessions::session_id().into(),
            process: process_identity().into(),
        }))
    }
    fn current(&self, app: &AppHandle) -> Result<(), ActionError> {
        let installed = app
            .try_state::<Arc<NativeOwnerState>>()
            .ok_or_else(kernel::unavailable)?;
        if !Arc::ptr_eq(installed.inner(), &self.owner)
            || !self.owner.registration.live.load(Ordering::SeqCst)
        {
            return Err(kernel::unavailable());
        }
        self.context
            .with_legacy_opening(&self.opening, || self.store.recheck())
            .map_err(|_| kernel::unavailable())?
            .map_err(|_| kernel::unavailable())
    }
    fn guarded_rows<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(
            &mut RuntimeOwner,
            &dyn Fn() -> Result<(), ActionError>,
        ) -> Result<T, ActionError>,
    ) -> Result<(Result<T, ActionError>, bool), ActionError> {
        // Do not enter current() or its opening lock under native storage.
        self.current(app)?;
        let result = self
            .context
            .with_legacy_opening(&self.opening, || {
                let mut storage = self
                    .owner
                    .storage
                    .lock()
                    .map_err(|_| kernel::unavailable())?;
                if storage.failed || !self.owner.registration.live.load(Ordering::SeqCst) {
                    return Err(kernel::unavailable());
                }
                let owner = storage.owner.as_mut().ok_or_else(kernel::unavailable)?;
                owner.action_cancellations = Arc::downgrade(&self.owner.action_cancellations);
                owner.credential_cancellations =
                    Arc::downgrade(&self.owner.credential_cancellations);
                if !Arc::ptr_eq(&owner.runtime_seal, &self.runtime_seal) {
                    return Err(kernel::unavailable());
                }
                let recheck = || {
                    self.store.recheck().map_err(|_| kernel::unavailable())?;
                    if !self.owner.registration.live.load(Ordering::SeqCst) {
                        return Err(kernel::unavailable());
                    }
                    Ok(())
                };
                recheck()?;
                let result = work(owner, &recheck);
                let retired = owner.retired;
                if retired {
                    storage.failed = true;
                    self.owner.action_cancellations.cancel_all();
                    self.owner.credential_cancellations.cancel_all();
                }
                result
            })
            .map_err(|_| kernel::unavailable())?;
        Ok((result, self.current(app).is_ok()))
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
            return Err(kernel::unavailable());
        }
        result
    }
    fn retain(
        self: &Arc<Self>,
        app: &AppHandle,
        origin: workflow_rows::Origin,
    ) -> Result<Option<CurrentWorkflowOrigin>, ActionError> {
        self.retain_checked(app, origin, None)
    }
    fn retain_checked(
        self: &Arc<Self>,
        app: &AppHandle,
        origin: workflow_rows::Origin,
        expected_revision: Option<u64>,
    ) -> Result<Option<CurrentWorkflowOrigin>, ActionError> {
        let retained = self.guarded(app, |owner, recheck| {
            retain_owned_rows(owner, self.facts(), &origin, expected_revision, || {
                recheck().map_err(|_| flow::Error::Unavailable)
            })
            .map_err(action_error)
        })?;
        // The physical owner cannot escape a not-committed/uncertain pin transaction.
        Ok(retained.map(|physical| CurrentWorkflowOrigin {
            opening: self.clone(),
            origin,
            physical: Arc::new(physical),
        }))
    }
}

struct WorkflowContext<'a> {
    db: AuthorityDb<'a>,
    scope: &'a ActionSubjectView,
    origin: &'a CurrentWorkflowOrigin,
}
impl MutationContext for WorkflowContext<'_> {
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
        let conn = row_db(db)?;
        let facts = self.origin.opening.facts();
        let origin = &self.origin.origin;
        let run = flow::inspect_rows(conn, self.origin.scope(), &origin.flow_run)
            .map_err(action_error)?;
        let step = run.cursor.as_deref().ok_or_else(kernel::denied)?;
        let input = schema::validate_input(definition, &request.input)?;
        workflow_rows::current_rows(
            conn,
            facts,
            &origin.flow_run,
            origin.epoch,
            workflow_rows::CurrentUse::Action {
                step,
                input_digest: &input.digest,
            },
        )
        .map_err(action_error)?;
        let selector = workflow_rows::selector_rows(conn, facts, &origin.flow_run, step)
            .map_err(action_error)?;
        if request.action_id.0 != selector.action
            || request.definition_digest.0 != selector.definition
            || request.connection_id.0 != selector.connection
            || request.account_id.0 != selector.account
            || request.snapshot_digest.0 != selector.snapshot
        {
            return Err(kernel::denied());
        }
        let key:Option<String>=conn.query_row("SELECT a.request_key FROM workflow_steps s JOIN workflow_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id AND a.ordinal=s.attempt_ordinal WHERE s.run_id=?1 AND s.step_id=?2 AND s.kind='action' AND s.state IN ('running','waiting','blocked')",params![origin.flow_run,step],|r|r.get(0)).optional().map_err(|_|kernel::unavailable())?;
        if key.as_deref() != Some(request.request_key.as_str()) {
            return Err(kernel::denied());
        }
        semantics::checked_binding(db, scope, facts.owner, request, definition)
    }
    fn read_access(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        account: &AccountId,
    ) -> Result<(), ActionError> {
        if !same_db(self.db, db) || scope != self.scope {
            return Err(kernel::denied());
        }
        let origin = workflow_rows::admission_rows(
            row_db(db)?,
            self.origin.opening.facts(),
            &self.origin.origin.flow_run,
            self.origin.origin.epoch,
        )
        .map_err(action_error)?;
        if !origin
            .current
            .accounts
            .iter()
            .any(|selection| selection.account == account.0)
        {
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
impl CurrentWorkflowOrigin {
    fn scope(&self) -> flow::Scope<'_> {
        let facts = self.opening.facts();
        flow::Scope {
            owner: facts.owner,
            vault: facts.vault,
            store: facts.store,
            actor: &self.origin.actor,
        }
    }
    fn subject(&self) -> ActionSubjectView {
        ActionSubjectView {
            vault_id: self.opening.scope.vault_id.clone(),
            run_id: self.origin.native_run.clone(),
            actor_id: self.origin.actor.clone(),
            client_id: None,
            child_job_id: None,
        }
    }
}

pub(in crate::actions::native_owner) struct StartedWorkflow {
    pub(in crate::actions::native_owner) row: workflow_rows::Started,
    pub(in crate::actions::native_owner) current:
        Result<Option<CurrentWorkflowOrigin>, ActionError>,
}
/// Actual injected native Start. Definition selectors are data, never grants.
pub(in crate::actions::native_owner) fn start(
    app: &AppHandle,
    window: &WebviewWindow,
    key: &str,
    workflow: &str,
    version: &str,
    input: &str,
    permissions: &workflow_rows::Permissions,
) -> Result<StartedWorkflow, ActionError> {
    let opening = WorkflowOpening::capture(app, window)?;
    start_captured(app, &opening, key, workflow, version, input, permissions)
        .map(|(started, _)| started)
}
/// The command compares its requested context against this same captured opening.
/// Finite run metadata is selected inside the start transaction, so a later
/// retain/queue/opening failure cannot erase a known-created acknowledgement.
fn start_captured(
    app: &AppHandle,
    opening: &Arc<WorkflowOpening>,
    key: &str,
    workflow: &str,
    version: &str,
    input: &str,
    permissions: &workflow_rows::Permissions,
) -> Result<(StartedWorkflow, flow::Run), ActionError> {
    let (row, source_current) = opening.guarded_rows(app, |owner, recheck| {
        let definition = crate::workflows::native_definition::NativeDefinition::load(
            &opening.root,
            workflow,
            version,
            input,
        )
        .map_err(|error| match error {
            crate::workflows::native_definition::Error::InvalidInput => {
                crate::actions::read_types::error(
                    ActionErrorCode::InvalidInput,
                    "Workflow input does not match its pinned schema.",
                )
            }
            _ => kernel::unavailable(),
        })?;
        let configuration = workflow_configuration(&definition)?;
        let graph = definition.steps();
        let selectors = definition
            .selectors()
            .into_iter()
            .map(|s| workflow_rows::SelectorRequest {
                step: s.step,
                action: s.action,
                definition: s.definition,
                connection: s.connection,
                account: s.account,
            })
            .collect::<Vec<_>>();
        row_transaction(
            owner,
            || recheck().map_err(|_| flow::Error::Unavailable),
            |conn| {
                let row = workflow_rows::start_rows(
                    conn,
                    opening.facts(),
                    workflow_rows::Start {
                        key,
                        workflow: definition.workflow(),
                        version: definition.version(),
                        schema: definition.schema(),
                        input: definition.input(),
                        configuration: &configuration,
                        permissions,
                        selectors: &selectors,
                        entry: definition.entry(),
                        steps: &graph,
                        now: chrono::Utc::now(),
                    },
                )?;
                let origin = match &row {
                    workflow_rows::Started::New(origin)
                    | workflow_rows::Started::Observed(origin) => origin,
                };
                let facts = opening.facts();
                let scope = flow::Scope {
                    owner: facts.owner,
                    vault: facts.vault,
                    store: facts.store,
                    actor: &origin.actor,
                };
                let run = flow::inspect_rows(conn, scope, &origin.flow_run)?;
                Ok((row, run))
            },
        )
        .map_err(action_error)
    })?;
    let (row, run) = row?;
    Ok((
        finish_known_start(row, source_current, |origin| {
            opening.retain(app, origin.clone())
        })?,
        run,
    ))
}
/// Actual authenticated narrowing/resume of the same immutable native origin.
/// Original selectors/catalog snapshot and ACT scope are never recaptured.
pub(in crate::actions::native_owner) fn reauthorize(
    app: &AppHandle,
    window: &WebviewWindow,
    run: &str,
    expected: u64,
    permissions: &workflow_rows::Permissions,
) -> Result<Option<CurrentWorkflowOrigin>, ActionError> {
    let opening = WorkflowOpening::capture(app, window)?;
    let origin = opening.guarded(app, |owner, recheck| {
        let origin = row_transaction(
            owner,
            || recheck().map_err(|_| flow::Error::Unavailable),
            |conn| {
                let original = workflow_rows::inspect_rows(conn, opening.facts(), run)?;
                original_definition(conn, &opening, &original)?;
                workflow_rows::reauthorize_rows(
                    conn,
                    opening.facts(),
                    run,
                    expected,
                    permissions,
                    chrono::Utc::now(),
                )
            },
        )
        .map_err(action_error)?;
        // Admission epoch changed: notify old retained workers after known commit,
        // under the same storage guard; the next lease waits for actual settlement.
        opening
            .owner
            .action_cancellations
            .cancel_run(&origin.native_run);
        Ok(origin)
    })?;
    opening.retain(app, origin)
}
pub(in crate::actions::native_owner) fn revoke(
    app: &AppHandle,
    window: &WebviewWindow,
    run: &str,
    expected: u64,
) -> Result<workflow_rows::Origin, ActionError> {
    let opening = WorkflowOpening::capture(app, window)?;
    opening.guarded(app, |owner, recheck| {
        let origin = revoke_owned_rows(
            owner,
            opening.facts(),
            run,
            expected,
            chrono::Utc::now(),
            || recheck().map_err(|_| flow::Error::Unavailable),
        )
        .map_err(action_error)?;
        opening
            .owner
            .action_cancellations
            .cancel_run(&origin.native_run);
        Ok(origin)
    })
}

fn original_definition(
    conn: &Connection,
    opening: &WorkflowOpening,
    origin: &workflow_rows::Origin,
) -> Result<crate::workflows::native_definition::NativeDefinition, flow::Error> {
    let(workflow,input,digest):(String,String,String)=conn.query_row("SELECT r.workflow_id,v.canonical_json,r.input_digest FROM workflow_runs r JOIN workflow_values v ON v.run_id=r.run_id AND v.value_ref=r.input_ref AND v.digest=r.input_digest AND v.role='run_input' AND v.step_id='' AND v.ordinal=0 WHERE r.run_id=?1 AND v.byte_count<=?2",params![origin.flow_run,i64::try_from(flow::action_output_allocation()).map_err(|_|flow::Error::Unavailable)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|flow::Error::Unavailable)?;
    if schema::digest(input.as_bytes()) != digest {
        return Err(flow::Error::Unavailable);
    }
    let definition = crate::workflows::native_definition::NativeDefinition::load(
        &opening.root,
        &workflow,
        &origin.version,
        &input,
    )
    .map_err(|_| flow::Error::Unavailable)?;
    if definition.input() != input
        || workflow_configuration(&definition).map_err(|_| flow::Error::Unavailable)?
            != origin.configuration
    {
        return Err(flow::Error::Denied);
    }
    Ok(definition)
}
/// Reacquire already-current admission after a previous physical holder settles;
/// this authenticates the real owner but never changes epoch or permissions.
pub(in crate::actions::native_owner) fn admit_current(
    app: &AppHandle,
    window: &WebviewWindow,
    run: &str,
    expected: u64,
) -> Result<Option<CurrentWorkflowOrigin>, ActionError> {
    let opening = WorkflowOpening::capture(app, window)?;
    let origin = opening.guarded(app, |owner, recheck| {
        row_transaction(
            owner,
            || recheck().map_err(|_| flow::Error::Unavailable),
            |conn| {
                let origin = workflow_rows::admission_rows(conn, opening.facts(), run, expected)?;
                original_definition(conn, &opening, &origin)?;
                Ok(origin)
            },
        )
        .map_err(action_error)
    })?;
    opening.retain(app, origin)
}

/// Projection of already-known committed/observed metadata, not a constructor
/// for native or execution authority. The native retain closure alone can mint.
pub(super) fn finish_known_start(
    row: workflow_rows::Started,
    source_current: bool,
    retain: impl FnOnce(&workflow_rows::Origin) -> Result<Option<CurrentWorkflowOrigin>, ActionError>,
) -> Result<StartedWorkflow, ActionError> {
    let current = match &row {
        workflow_rows::Started::Observed(_) => Ok(None),
        workflow_rows::Started::New(origin) => {
            if source_current {
                retain(origin)
            } else {
                Err(kernel::unavailable())
            }
        }
    };
    // The outer result is known-created/observed regardless of later admission.
    // Callers recover the same scoped key and never invent a fresh run on error.
    Ok(StartedWorkflow { row, current })
}

#[path = "native_workflow_history.rs"]
pub(super) mod history;

#[path = "native_workflow_driver.rs"]
pub(super) mod driver;

#[path = "native_workflow_pass.rs"]
pub(super) mod pass;

#[path = "native_workflow_worker.rs"]
pub(super) mod worker;

#[path = "native_workflow_control.rs"]
pub(super) mod control;

#[path = "native_workflow_commands.rs"]
pub(super) mod commands;

#[path = "native_workflow_views.rs"]
pub(super) mod views;

/// Returns a physical holder only after the original admission pin transaction commits.
/// This row seam does not construct a native workflow origin or grant.
pub(in crate::actions::native_owner) fn retain_owned_rows(
    owner: &mut RuntimeOwner,
    facts: workflow_rows::OpeningFacts<'_>,
    origin: &workflow_rows::Origin,
    expected_revision: Option<u64>,
    recheck: impl Fn() -> Result<(), flow::Error>,
) -> Result<Option<crate::runtime::workflow_submission::ExecutionOwner>, flow::Error> {
    let identity = owner.identity;
    let parent = owner.directory_identity;
    let data_dir = owner.data_dir.clone();
    row_transaction(owner, recheck, |conn| {
        let current = workflow_rows::admission_rows(conn, facts, &origin.flow_run, origin.epoch)?;
        if &current != origin {
            return Err(flow::Error::Stale);
        }
        if let Some(expected) = expected_revision {
            let scope = flow::Scope {
                owner: facts.owner,
                vault: facts.vault,
                store: facts.store,
                actor: &origin.actor,
            };
            if flow::inspect_rows(conn, scope, &origin.flow_run)?.revision != expected {
                return Err(flow::Error::Stale);
            }
        }
        crate::runtime::workflow_submission::try_execution_owner(
            conn,
            &data_dir,
            identity,
            parent,
            &origin.flow_run,
        )
        .map_err(|_| flow::Error::Unavailable)
    })
}

#[path = "native_workflow_runtime_commands.rs"]
pub(super) mod runtime_commands;

#[path = "native_workflow_occurrence.rs"]
pub(super) mod occurrence;

#[path = "native_workflow_activation.rs"]
pub(super) mod activation_service;

#[path = "native_workflow_schedule_commands.rs"]
pub(super) mod schedule_commands;

#[path = "native_workflow_publication.rs"]
pub(super) mod publication_service;
