//! Original run's actual matched MCP call. No renderer/metadata authority factory.
use super::*;
use crate::agent::interaction::managed_action_wait::{ManagedCall, ManagedReceive};
use crate::agent::interaction::{InteractionCard, Kind, PersonAnswer, Refusal};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    #[serde(default)]
    cursor: Option<CatalogCursor>,
    #[serde(default)]
    request_access: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefinitionInput {
    action_id: ActionId,
    definition_digest: DefinitionDigest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectInput {
    invocation_id: InvocationId,
}
#[derive(Serialize)]
struct RunCatalog {
    catalog: ActionCatalogPage,
    bindings: Vec<grants::CatalogBinding>,
}
fn arguments<T: serde::de::DeserializeOwned>(args: &Map<String, Value>) -> Result<T, ActionError> {
    serde_json::from_value(Value::Object(args.clone())).map_err(|_| {
        crate::actions::read_types::error(
            ActionErrorCode::InvalidInput,
            "These action arguments are malformed.",
        )
    })
}
fn value<T: Serialize>(value: T) -> Result<Value, ActionError> {
    let value = serde_json::to_value(value).map_err(|_| kernel::unavailable())?;
    if serde_json::to_vec(&value)
        .map_err(|_| kernel::unavailable())?
        .len()
        > schema::history_limits().max_string_bytes
    {
        return Err(crate::actions::read_types::error(
            ActionErrorCode::LimitExceeded,
            "The complete action response is too large to show safely.",
        ));
    }
    Ok(value)
}
fn catalog(
    app: &AppHandle,
    call: &Origin,
    cursor: Option<CatalogCursor>,
) -> Result<RunCatalog, ActionError> {
    call.guarded(app, |owner, recheck| {
        read_snapshot(owner, |read| {
            call.with_current_context(AuthorityDb::Retained(read), |_, scope, native| {
                let scoped = crate::actions::native_authority::ScopedCatalog {
                    catalog: crate::actions::compiled_catalog::compiled_catalog()
                        .map_err(|_| kernel::unavailable())?,
                    scope,
                    owner: &native.owner_person,
                    execution: crate::actions::native_authority::CatalogExecution::FixedGithub,
                };
                let catalog = scoped
                    .catalog(AuthorityDb::Retained(read), cursor)
                    .map_err(|_| kernel::unavailable())?;
                let bindings = grants::catalog_bindings_rows(read.conn, scope, native)?;
                recheck()?;
                Ok(RunCatalog { catalog, bindings })
            })
        })
    })
}
fn current(app: &AppHandle, call: &Origin) -> Result<(), ActionError> {
    call.guarded(app, |_, recheck| recheck())
}
#[expect(
    clippy::too_many_arguments,
    reason = "finite safe view metadata derived only from the actual original action; never authority selectors"
)]
fn card(
    call: &Origin,
    kind: Kind,
    id: String,
    tool: &str,
    title: &str,
    summary: String,
    input: String,
    target: Option<String>,
) -> Result<InteractionCard, ActionError> {
    let Origin::Attended(original) = call else {
        return Err(kernel::denied());
    };
    Ok(InteractionCard {
        id,
        kind,
        answering: Some(false),
        run: None,
        tool_name: format!("mcp__cerebro__{tool}"),
        tool_id: String::new(),
        session_id: original
            .origin
            .receipt
            .cli_session_id()
            .ok_or_else(kernel::unavailable)?
            .into(),
        summary,
        family: None,
        subject: None,
        title: Some(title.into()),
        target,
        actor: None,
        questions: None,
        input,
        asked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}
fn agents<'a>(
    app: &'a AppHandle,
) -> Result<tauri::State<'a, crate::agent::AgentState>, ActionError> {
    app.try_state().ok_or_else(kernel::unavailable)
}
fn project_card(
    app: &AppHandle,
    call: &Origin,
    card: InteractionCard,
) -> Result<InteractionCard, ActionError> {
    let Origin::Attended(original) = call else {
        return Err(kernel::denied());
    };
    agents(app)?
        .managed_card_for_publication(&original.origin.receipt, card)
        .ok_or_else(kernel::unavailable)
}
fn publish(app: &AppHandle, call: &Origin, card: InteractionCard) -> Result<(), ActionError> {
    let Origin::Attended(original) = call else {
        return Err(kernel::denied());
    };
    if agents(app)?.publish_managed_interaction(&original.origin.receipt, card) {
        Ok(())
    } else {
        Err(kernel::unavailable())
    }
}
fn closed(app: &AppHandle, call: &Origin, id: &str) {
    if let Origin::Attended(original) = call {
        if let Ok(agents) = agents(app) {
            agents.publish_managed_closed(&original.origin.receipt, id);
        }
    }
}
fn wait_for_access(
    app: &AppHandle,
    call: &Origin,
    witness: &crate::mcp::NativeManagedCall,
) -> Result<(), ActionError> {
    let agents = agents(app)?;
    let Origin::Attended(original) = call else {
        return Err(kernel::denied());
    };
    let card = project_card(
        app,
        call,
        card(
            call,
            Kind::ManagedAccess,
            crate::ledger::new_id128(),
            "list_actions",
            "Choose access for this run",
            "Choose which accounts and actions this run may use.".into(),
            String::new(),
            None,
        )?,
    )?;
    let deadline = Instant::now()
        + kernel::approval_lifetime()
            .to_std()
            .map_err(|_| kernel::unavailable())?;
    let wait = agents
        .interactions()
        .hold_managed_access(
            call.native_run(),
            &original.origin.root,
            card.clone(),
            deadline,
        )
        .map_err(|_| kernel::unavailable())?;
    if !wait.bind_rpc(witness.rpc_key().into()) {
        return Err(kernel::unavailable());
    }
    current(app, call)?;
    publish(app, call, card)?;
    loop {
        match wait.receive(Duration::from_millis(250)) {
            ManagedReceive::AccessCompleted => {
                if witness.stopped() {
                    return Err(kernel::denied());
                }
                current(app, call)?;
                return Ok(());
            }
            ManagedReceive::Closed(_) => return Err(kernel::denied()),
            ManagedReceive::Proposal(proposal) => {
                proposal.finish(Err(Refusal {
                    code: crate::agent::interaction::MALFORMED_ARGUMENTS,
                    message: "Choose access in This run.".into(),
                }));
            }
            ManagedReceive::Timeout => {
                if witness.stopped() {
                    agents
                        .interactions()
                        .cancel_managed_rpc(call.native_run(), witness.rpc_key());
                    closed(app, call, wait.id());
                    return Err(kernel::denied());
                }
                if Instant::now() >= deadline {
                    agents.interactions().expire_managed(Instant::now());
                }
                current(app, call)?;
            }
        }
    }
}

enum CapturedPrepare {
    New(OriginalPrepared),
    Observed(ActionInvocation),
}
struct OriginalPrepared {
    origin: Origin,
    runtime_seal: Arc<()>,
    runtime_identity: (u64, u64),
    scope: ActionSubjectView,
    native_fingerprint: String,
    action_fingerprint: String,
    record: ActionInvocation,
}
impl OriginalPrepared {
    fn capture(
        app: &AppHandle,
        origin: Origin,
        request: PrepareAction,
    ) -> Result<(CapturedPrepare, bool), ActionError> {
        let (result, current) = origin.guarded_rows(app, |owner, recheck| {
            let rows = action_transaction(owner, |conn| {
                origin.with_current_context(AuthorityDb::Writer(conn), |context, scope, native| {
                    let rows = prepare_record_rows(conn, context, scope, native, request)?;
                    recheck()?;
                    Ok(rows)
                })
            })?;
            match rows {
                PreparedRecordRows::Existing(record) => Ok(CapturedPrepare::Observed(record)),
                PreparedRecordRows::Created {
                    inserted,
                    record,
                    native_fingerprint,
                    action_fingerprint,
                } => {
                    checkpoint_prepared(inserted);
                    Ok(CapturedPrepare::New(Self {
                        origin: origin.clone(),
                        runtime_seal: owner.runtime_seal.clone(),
                        runtime_identity: owner.identity,
                        scope: record.scope.clone(),
                        native_fingerprint,
                        action_fingerprint,
                        record,
                    }))
                }
            }
        })?;
        Ok((result?, current))
    }
    fn original_cancel(&self) -> Result<ActionEffectRef, ActionError> {
        // This is cancellation of this known-committed original request only. It
        // cannot create a subject, grant, claim, attempt, provider call or new owner.
        let mut storage = self
            .origin
            .owner()
            .storage
            .lock()
            .map_err(|_| kernel::unavailable())?;
        if storage.failed {
            return Err(kernel::unavailable());
        }
        let owner = storage.owner.as_mut().ok_or_else(kernel::unavailable)?;
        owner.action_cancellations = Arc::downgrade(&self.origin.owner().action_cancellations);
        let result = (|| {
            if !Arc::ptr_eq(&owner.runtime_seal, &self.runtime_seal)
                || owner.identity != self.runtime_identity
            {
                return Err(kernel::unavailable());
            }
            self.origin
                .store()
                .recheck()
                .map_err(|_| kernel::unavailable())?;
            let physical =
                retained_cancellation_lease(owner, &self.record.details.effect.invocation_id)?;
            let changed = action_transaction(owner, |conn| {
                self.origin
                    .store()
                    .recheck()
                    .map_err(|_| kernel::unavailable())?;
                let native =
                    native_lineage::load_run(AuthorityDb::Writer(conn), &self.scope.run_id)
                        .map_err(|_| kernel::unavailable())?;
                let record = kernel::load(conn, &self.record.details.effect.invocation_id)?;
                if super::native_fingerprint(&native)? != self.native_fingerprint
                    || record.scope != self.scope
                    || super::action_fingerprint(&record)? != self.action_fingerprint
                {
                    return Err(kernel::denied());
                }
                let result = kernel::cancel_recorded_rows(
                    conn,
                    &self.scope,
                    &record.details.effect.invocation_id,
                    record.revision(),
                    if physical.is_some() {
                        kernel::SubmissionAccess::Held
                    } else {
                        kernel::SubmissionAccess::Busy
                    },
                )?;
                self.origin
                    .store()
                    .recheck()
                    .map_err(|_| kernel::unavailable())?;
                Ok(result)
            })?;
            self.origin
                .owner()
                .action_cancellations
                .cancel_invocation(&self.record.details.effect.invocation_id);
            drop(physical);
            Ok(changed.record.details.effect)
        })();
        if owner.retired {
            storage.failed = true;
            self.origin.owner().action_cancellations.cancel_all();
            self.origin.owner().credential_cancellations.cancel_all();
        }
        result
    }
    fn decide(
        &mut self,
        app: &AppHandle,
        allow: bool,
        edited: Option<String>,
    ) -> Result<bool, ActionError> {
        let approval = self.record.approval.as_ref().ok_or_else(kernel::stale)?;
        let (result, current) = self.origin.guarded_rows(app, |owner, recheck| {
            action_transaction(owner, |conn| {
                self.origin
                    .with_current_context(AuthorityDb::Writer(conn), |context, scope, _| {
                        kernel::answer_rows(
                            conn,
                            context,
                            kernel::AnswerInput {
                                person_id: native_rules::admission_rules()
                                    .owner_storage_key
                                    .clone(),
                                scope: scope.clone(),
                                approval_id: approval.view.approval_id.clone(),
                                allow,
                                edited_input: edited,
                                expected_invocation_revision: self.record.revision(),
                                expected_approval_revision: approval.view.revision.get(),
                            },
                        )?;
                        let record = kernel::load(conn, &self.record.details.effect.invocation_id)?;
                        let fingerprint = super::action_fingerprint(&record)?;
                        recheck()?;
                        Ok((record, fingerprint))
                    })
            })
        })?;
        // Retain the known-committed effective input even if the original source
        // retired just after commit, so original-only cancellation stays exact.
        let (record, fingerprint) = result?;
        self.record = record;
        self.action_fingerprint = fingerprint;
        checkpoint_approved();
        Ok(current)
    }
    fn view_card(&self, app: &AppHandle) -> Result<InteractionCard, ActionError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct View<'a> {
            version: u8,
            account_label: &'a str,
            preview: &'a SafeEffectPreview,
            input_schema: &'a str,
            input: &'a str,
        }
        // ActionDefinition omits material-only secret fields. The immutable compiled
        // catalog rejects embedded-secret material before creating any descriptor;
        // require exact compiled descriptor identity before serializing input here.
        let compiled = semantics::definition(
            &self.record.definition.action_id,
            &self.record.definition.definition_digest,
        )?;
        if compiled != self.record.definition {
            return Err(kernel::denied());
        }
        let approval = self.record.approval.as_ref().ok_or_else(kernel::stale)?;
        let input = serde_json::to_string(&View {
            version: 1,
            account_label: &self.record.binding.account_label,
            preview: &self.record.details.preview,
            input_schema: &self.record.definition.input_schema,
            input: &self.record.canonical_input,
        })
        .map_err(|_| kernel::unavailable())?;
        if input.len() > schema::history_limits().max_string_bytes {
            return Err(kernel::unavailable());
        }
        project_card(
            app,
            &self.origin,
            card(
                &self.origin,
                Kind::ManagedAction,
                approval.view.approval_id.0.clone(),
                "prepare_action",
                "Review this action",
                self.record.details.preview.summary.clone(),
                input,
                self.record
                    .details
                    .target
                    .as_ref()
                    .map(|target| target.label.clone()),
            )?,
        )
    }
    fn deadline(&self, original: Instant) -> Result<Instant, ActionError> {
        let expiry = self
            .record
            .approval
            .as_ref()
            .ok_or_else(kernel::stale)?
            .view
            .expires_at
            .parse::<chrono::DateTime<chrono::Utc>>()
            .map_err(|_| kernel::unavailable())?;
        let duration = (expiry - chrono::Utc::now())
            .to_std()
            .map_err(|_| kernel::denied())?;
        Ok(original.min(Instant::now() + duration))
    }
}

fn prepared_current(app: &AppHandle, prepared: &OriginalPrepared) -> Result<(), ActionError> {
    prepared.origin.guarded(app, |owner, recheck| {
        read_snapshot(owner, |read| {
            prepared.origin.with_current_context(
                AuthorityDb::Writer(read.conn),
                |context, scope, _| {
                    // This is the retained query-only snapshot. Writer denotes pointer identity
                    // for the shared mutation check; it does not open a writable connection.
                    let record = kernel::readable(
                        context,
                        AuthorityDb::Writer(read.conn),
                        scope,
                        kernel::load(read.conn, &prepared.record.details.effect.invocation_id)?,
                    )?;
                    if super::action_fingerprint(&record)? != prepared.action_fingerprint {
                        return Err(kernel::denied());
                    }
                    kernel::check(read.conn, context, &record)?;
                    recheck()
                },
            )
        })
    })
}
fn finish_original(
    app: &AppHandle,
    witness: &crate::mcp::NativeManagedCall,
    prepared: &OriginalPrepared,
    completion: kernel::CompletedObservation,
) -> Result<Value, ActionError> {
    // A committed completed fact is independent of source liveness. Disclosure
    // is separate and always checks the original caller/account again.
    if witness.stopped() {
        return Err(kernel::unavailable());
    }
    prepared_current(app, prepared)?;
    if witness.stopped() {
        return Err(kernel::unavailable());
    }
    #[derive(Serialize)]
    #[serde(tag = "state", rename_all = "snake_case")]
    enum Output {
        Available { json: String },
        Unavailable { message: &'static str },
        NotProduced,
    }
    let output=match completion.output{Some(output)=>Output::Available{json:output.value.canonical()},None if completion.effect.state==InvocationState::Succeeded=>Output::Unavailable{message:"This request has no retained output. Review the recorded effect before trying again."},None if matches!(completion.effect.state,InvocationState::Dispatched|InvocationState::OutcomeUnknown)=>Output::Unavailable{message:"The action outcome and output could not be established. Review its recorded state before trying again."},None=>Output::NotProduced};
    value(serde_json::json!({"effect":completion.effect,"output":output}))
}
fn run_prepared(
    app: &AppHandle,
    witness: &crate::mcp::NativeManagedCall,
    prepared: &mut OriginalPrepared,
    source_current: bool,
) -> Result<Value, ActionError> {
    if !source_current {
        return Err(kernel::unavailable());
    }
    let origin = prepared.origin.clone();
    let Origin::Attended(original) = &origin else {
        return Err(kernel::denied());
    };
    let agents = agents(app)?;
    let book = agents.interactions();
    let original_deadline = Instant::now()
        + kernel::approval_lifetime()
            .to_std()
            .map_err(|_| kernel::unavailable())?;
    let mut wait: Option<ManagedCall> = None;
    loop {
        if witness.stopped() {
            return Err(kernel::denied());
        }
        match prepared.record.details.effect.state {
            InvocationState::Ready => {
                let completion = dispatch_completed_origin(
                    app,
                    origin.clone(),
                    prepared.record.details.effect.invocation_id.clone(),
                    Some(witness),
                )?;
                // The wait/flag and original call remain retained through the owned HTTP
                // runtime join, original fact settlement and this disclosure boundary.
                return finish_original(app, witness, prepared, completion);
            }
            InvocationState::AwaitingApproval => {}
            _ => {
                return finish_original(
                    app,
                    witness,
                    prepared,
                    kernel::CompletedObservation {
                        effect: prepared.record.details.effect.clone(),
                        output: None,
                    },
                )
            }
        }
        let card = prepared.view_card(app)?;
        let deadline = prepared.deadline(original_deadline)?;
        if let Some(wait) = wait.as_mut() {
            if !book.replace_managed_card(wait, card.clone(), deadline) {
                return Err(kernel::unavailable());
            }
        } else {
            let held = book
                .hold_managed(
                    origin.native_run(),
                    &prepared.record.details.effect.invocation_id.0,
                    &original.origin.root,
                    card.clone(),
                    deadline,
                )
                .map_err(|_| kernel::unavailable())?;
            if !held.bind_rpc(witness.rpc_key().into()) {
                return Err(kernel::unavailable());
            }
            wait = Some(held);
        }
        prepared_current(app, prepared)?;
        publish(app, &origin, card.clone())?;
        let held = wait.as_ref().ok_or_else(kernel::unavailable)?;
        loop {
            match held.receive(Duration::from_millis(250)) {
                ManagedReceive::Closed(_) => return Err(kernel::denied()),
                ManagedReceive::AccessCompleted => return Err(kernel::denied()),
                ManagedReceive::Timeout => {
                    if witness.stopped() {
                        return Err(kernel::denied());
                    }
                    if Instant::now() >= deadline {
                        book.expire_managed(Instant::now());
                    }
                    prepared_current(app, prepared)?;
                }
                ManagedReceive::Proposal(proposal) => {
                    let Some(allow) = proposal.answer.managed_choice() else {
                        proposal.finish(Err(Refusal {
                            code: crate::agent::interaction::MALFORMED_ARGUMENTS,
                            message: "This action takes Allow once or Deny.".into(),
                        }));
                        continue;
                    };
                    let edited = proposal
                        .edited_input
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|_| kernel::unavailable())?;
                    match prepared.decide(app, allow, edited) {
                        Ok(current) => {
                            let acknowledged = proposal.finish(Ok(()));
                            closed(app, &origin, held.id());
                            if !acknowledged || !current {
                                return Err(kernel::unavailable());
                            }
                            break;
                        }
                        Err(error) => {
                            if current(app, &origin).is_err() {
                                proposal.finish(Err(Refusal {
                                    code: crate::agent::interaction::NO_LONGER_WAITING,
                                    message: crate::agent::interaction::STALE.into(),
                                }));
                                return Err(error);
                            }
                            proposal.finish(Err(Refusal {
                                code: crate::agent::interaction::MALFORMED_ARGUMENTS,
                                message: error.message,
                            }));
                            // A reattached renderer may have seen Answering while the actual answer
                            // caller vanished. Refresh the same native card as Waiting after refusal.
                            publish(app, &origin, card.clone())?;
                        }
                    }
                }
            }
        }
    }
}
fn prepare_held(
    app: &AppHandle,
    origin: Origin,
    witness: &crate::mcp::NativeManagedCall,
    request: PrepareAction,
) -> Result<Value, ActionError> {
    let (captured, current) = OriginalPrepared::capture(app, origin.clone(), request)?;
    match captured {
        CapturedPrepare::Observed(record) => {
            if !current || witness.stopped() {
                return Err(kernel::unavailable());
            }
            // A deduped row never creates an OriginalPrepared cancellation/dispatch
            // capsule, registers another wait, acknowledges an approval or claims I/O.
            origin.inspect(app,|read,context,scope|{
    let observed=kernel::readable(context,AuthorityDb::Retained(read),scope,kernel::load(read.conn,&record.details.effect.invocation_id)?)?;
    if observed.request_digest!=record.request_digest{return Err(kernel::denied());}
    value(serde_json::json!({"effect":observed.details.effect,"observation":"existing","output":{"state":"unavailable","message":"This existing request was observed without taking execution or cancellation ownership. Inspect its recorded effect before any next step."}}))
   })
        }
        CapturedPrepare::New(mut prepared) => {
            let result = run_prepared(app, witness, &mut prepared, current);
            if result.is_err() {
                if prepared.original_cancel().is_ok() {
                    if let Some(approval) = &prepared.record.approval {
                        closed(app, &prepared.origin, &approval.view.approval_id.0);
                    }
                }
            }
            result
        }
    }
}

fn stale_answer() -> Refusal {
    Refusal {
        code: crate::agent::interaction::NO_LONGER_WAITING,
        message: crate::agent::interaction::STALE.into(),
    }
}

pub(in crate::actions::native_owner) fn invoke(
    app: &AppHandle,
    witness: &crate::mcp::NativeManagedCall,
    name: &str,
    args: &Map<String, Value>,
) -> Result<Value, ActionError> {
    let call = Origin::Attended(AttendedOrigin::capture_model(app, witness)?);
    if witness.stopped() {
        return Err(kernel::denied());
    }
    match name {
        "list_actions" => {
            let input: ListInput = arguments(args)?;
            let first = catalog(app, &call, input.cursor.clone())?;
            if input.request_access
                || input.cursor.is_none() && first.catalog.descriptors.is_empty()
            {
                wait_for_access(app, &call, witness)?;
                value(catalog(app, &call, None)?)
            } else {
                value(first)
            }
        }
        "get_action_definition" => {
            let input: DefinitionInput = arguments(args)?;
            call.guarded(app, |owner, recheck| {
                read_snapshot(owner, |read| {
                    call.with_current_context(AuthorityDb::Retained(read), |_, scope, native| {
                        let scoped = crate::actions::native_authority::ScopedCatalog {
                            catalog: crate::actions::compiled_catalog::compiled_catalog()
                                .map_err(|_| kernel::unavailable())?,
                            scope,
                            owner: &native.owner_person,
                            execution:
                                crate::actions::native_authority::CatalogExecution::FixedGithub,
                        };
                        let definition = scoped
                            .definition(
                                AuthorityDb::Retained(read),
                                input.action_id,
                                input.definition_digest,
                            )
                            .map_err(|_| kernel::unavailable())?;
                        recheck()?;
                        value(definition)
                    })
                })
            })
        }
        "prepare_action" => prepare_held(app, call, witness, arguments(args)?),
        "get_action_effect" | "get_action_effect_details" => {
            let input: EffectInput = arguments(args)?;
            call.inspect(app, |read, context, scope| {
                let record = kernel::readable(
                    context,
                    AuthorityDb::Retained(read),
                    scope,
                    kernel::load(read.conn, &input.invocation_id)?,
                )?;
                if name == "get_action_effect" {
                    value(record.details.effect)
                } else {
                    value(record.details)
                }
            })
        }
        _ => Err(crate::actions::read_types::error(
            ActionErrorCode::NotFound,
            "This managed action tool is unavailable.",
        )),
    }
}

// Selector metadata only. Actual native admission still follows this check.
fn held_run_selector(run: Option<SafeCounter>) -> Option<u64> {
    run.map(SafeCounter::get)
}

/// Only the actual injected-window answer command calls this. A bearer can
/// wait and cancel its own request, never supply a native person decision.
pub(in crate::actions::native_owner) fn person_answer(
    app: &AppHandle,
    window: &WebviewWindow,
    vault: &std::path::Path,
    id: &str,
    answer: &PersonAnswer,
    edited: Option<&Value>,
) -> Option<Result<(), Refusal>> {
    let agents = match agents(app) {
        Ok(agents) => agents,
        Err(_) => return None,
    };
    let key = crate::agent::vault_key(vault);
    let book = agents.interactions();
    if !book.has_managed(&key, id) {
        return None;
    }
    let decision = (|| {
        let (run, invocation) = book.managed_invocation(&key, id).ok_or_else(|| Refusal {
            code: crate::agent::interaction::MALFORMED_ARGUMENTS,
            message: "Choose access in This run.".into(),
        })?;
        let selected = book
            .managed_pending(&key)
            .into_iter()
            .find(|card| card.id == id)
            .and_then(|card| held_run_selector(card.run))
            .ok_or_else(stale_answer)?;
        let call = Origin::capture(app, window, selected).map_err(|_| stale_answer())?;
        if call.native_run() != run {
            return Err(stale_answer());
        }
        call.inspect(app, |read, context, scope| {
            kernel::readable(
                context,
                AuthorityDb::Retained(read),
                scope,
                kernel::load(read.conn, &InvocationId(invocation))?,
            )
            .map(|_| ())
        })
        .map_err(|_| stale_answer())?;
        let pending = book.propose_managed(&key, id, answer.clone(), edited.cloned())?;
        pending.receive(Duration::from_secs(crate::agent::interaction::HOOK_TIMEOUT_SECS)).unwrap_or_else(||Err(Refusal{code:crate::agent::interaction::MALFORMED_ARGUMENTS,message:"Cerebro could not confirm this answer. Review the original request before trying again.".into()}))
    })();
    Some(decision)
}

/// Row disposition only. It constructs no native origin or cancellation owner.
pub(super) enum PreparedRecordRows {
    Created {
        inserted: bool,
        record: ActionInvocation,
        native_fingerprint: String,
        action_fingerprint: String,
    },
    Existing(ActionInvocation),
}
pub(super) fn prepare_record_rows(
    conn: &Connection,
    context: &dyn MutationContext,
    scope: &ActionSubjectView,
    native: &crate::runtime::native_runs::NativeRun,
    request: PrepareAction,
) -> Result<PreparedRecordRows, ActionError> {
    let rows = kernel::prepare_rows(conn, context, scope, request)?;
    let record = kernel::load(conn, &rows.prepared.effect.invocation_id)?;
    if !rows.inserted {
        return Ok(PreparedRecordRows::Existing(record));
    }
    Ok(PreparedRecordRows::Created {
        inserted: rows.inserted,
        native_fingerprint: super::native_fingerprint(native)?,
        action_fingerprint: super::action_fingerprint(&record)?,
        record,
    })
}

#[cfg(test)]
mod held_run_selector_tests {
    use super::*;
    #[test]
    fn zero_is_a_valid_original_run_selector_without_minting_an_origin() {
        // AgentState::spawn_run starts RUN_SEQ at0 and returns fetch_add's old value.
        // This check admits only selector metadata; Origin::capture remains required.
        assert_eq!(
            held_run_selector(Some(SafeCounter::new(0).unwrap())),
            Some(0)
        );
    }
    #[test]
    fn absent_original_run_stays_absent() {
        assert_eq!(held_run_selector(None), None);
    }
}
