//! Shared transaction-owned action mutations. No path opener, identity mint,
//! provider executor, transaction owner or checkpoint is defined here.
#![cfg_attr(not(test), expect(dead_code, reason = "the retained native mutation bridge is integrated after the shared row kernel"))]
use super::effect_record::{
    legacy_request_digest, legacy_scope_key, request_digest, scope_key, ActionApproval,
    ActionInvocation, ApprovalDecision, AdapterTarget, Binding, PrepareAction,
};
use super::{effect_types::*, native_db::AuthorityDb, schema::*};
use crate::runtime::action_invocations as store;
use rusqlite::Connection;
use serde::Serialize;

/// Borrowed checks and pure semantics only. Scope views do not grant authority;
/// the caller must supply its authenticated same-transaction native checks.
pub(super) trait MutationContext {
    fn definition(&self, id: &ActionId, digest: &DefinitionDigest) -> Result<ActionDefinition, ActionError>;
    fn check(&self, db: AuthorityDb<'_>, scope: &ActionSubjectView, request: &PrepareAction, definition: &ActionDefinition) -> Result<Binding, ActionError>;
    fn read_access(&self, db: AuthorityDb<'_>, scope: &ActionSubjectView, account: &AccountId) -> Result<(), ActionError>;
    fn target(&self, definition: &ActionDefinition, input: &ValidatedInput) -> Result<AdapterTarget, ActionError>;
    fn preview(&self, definition: &ActionDefinition, input: &ValidatedInput, target: &AdapterTarget) -> Result<SafeEffectPreview, ActionError>;
}

/// Checked human-decision data, not a mintable native person capability.
pub(super) struct AnswerInput {
    pub(super) person_id: String,
    pub(super) scope: ActionSubjectView,
    pub(super) approval_id: ApprovalId,
    pub(super) allow: bool,
    pub(super) edited_input: Option<String>,
    pub(super) expected_invocation_revision: u64,
    pub(super) expected_approval_revision: u64,
}

fn require_transaction(conn: &Connection) -> Result<(), ActionError> {
    if conn.is_autocommit() { Err(unavailable()) } else { Ok(()) }
}

#[derive(Debug)]
pub(super) struct PrepareRows {
    pub(super) prepared: PreparedAction,
    /// Only a new row schedules the owner's post-commit prepared checkpoint.
    pub(super) inserted: bool,
}

pub(super) fn unavailable() -> ActionError {
    error(
        ActionErrorCode::Unavailable,
        "Action storage is unavailable.",
    )
}
pub(super) fn denied() -> ActionError {
    error(
        ActionErrorCode::Denied,
        "Action authority is unavailable or changed.",
    )
}
pub(super) fn stale() -> ActionError {
    error(
        ActionErrorCode::RevisionConflict,
        "Action changed; refresh its details.",
    )
}
pub(super) fn db<T>(value: rusqlite::Result<T>) -> Result<T, ActionError> {
    value.map_err(|_| unavailable())
}
pub(super) fn encode<T: Serialize>(value: &T) -> Result<String, ActionError> {
    serde_json::to_string(value).map_err(|_| unavailable())
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, ActionError> {
    serde_json::from_str(value).map_err(|_| unavailable())
}
pub(super) fn oid() -> String {
    crate::connections::opaque_id()
}
pub(super) fn now() -> String {
    crate::runtime::now_utc()
}
pub(super) fn approval_lifetime()->chrono::Duration{chrono::Duration::minutes(15)}

pub(super) fn new_approval(input_digest: String) -> ActionApproval {
    ActionApproval {
        decided_by: None,
        decided_at: None,
        decision: None,
        view: EffectApproval {
            approval_id: ApprovalId(oid()),
            revision: SafeCounter::new(1).unwrap(),
            expires_at: (chrono::Utc::now() + approval_lifetime())
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            asked_input_digest: input_digest,
            approved_input_digest: None,
            approved_preview: None,
        },
        approved_input: None,
        consumed: false,
        retired: false,
    }
}
pub(super) fn target_preview(target: &AdapterTarget) -> Result<SafeEffectPreview, ActionError> {
    // Target is trusted adapter-derived display data. Raw input and provider
    // output never appear in generic previews; a reviewed adapter supplies only
    // fixed safe target identity. All text is bounded and control-free.
    for text in [
        &target.conflict_domain,
        &target.target.kind,
        &target.target.label,
        &target.target.safe_reference,
    ] {
        if text.is_empty() || text.len() > 512 || text.chars().any(char::is_control) {
            return Err(error(
                ActionErrorCode::InvalidInput,
                "Adapter target is unsupported.",
            ));
        }
    }
    Ok(SafeEffectPreview {
        summary: "Review connected action".into(),
        fields: vec![PreviewField {
            label: "Target".into(),
            value: target.target.label.clone(),
        }],
        redacted_fields: Vec::new(),
    })
}
pub(super) fn load(conn: &Connection, id: &InvocationId) -> Result<ActionInvocation, ActionError> {
    let raw = store::load(conn, &id.0)
        .map_err(|_| unavailable())?
        .ok_or_else(|| error(ActionErrorCode::NotFound, "Action was not found."))?;
    let record: ActionInvocation = decode(&raw)?;
    record.check_lookup_version()?;
    Ok(record)
}
pub(super) fn save(
    conn: &Connection,
    record: &mut ActionInvocation,
    expected: u64,
) -> Result<(), ActionError> {
    require_transaction(conn)?;
    record.refresh();
    if !store::save(
        conn,
        &record.details.effect.invocation_id.0,
        expected,
        record.revision(),
        &encode(&record.details.effect.state)?,
        &encode(record)?,
        record.fence.as_deref(),
    )
    .map_err(|_| unavailable())?
    {
        return Err(stale());
    }
    if let Some(a) = &record.approval {
        store::save_approval(
            conn,
            &a.view.approval_id.0,
            &record.details.effect.invocation_id.0,
            &encode(a)?,
        )
        .map_err(|_| unavailable())?;
    }
    Ok(())
}
pub(super) fn check(conn: &Connection, context: &dyn MutationContext, record: &ActionInvocation) -> Result<(), ActionError> {
    let current = context.check(
        AuthorityDb::Writer(conn),
        &record.scope,
        &record.authority_request(),
        &record.definition,
    )?;
    if current != record.binding {
        return Err(denied());
    }
    let validated = validate_input(&record.definition, &record.canonical_input)?;
    if context.target(&record.definition, &validated)? != record.target {
        return Err(denied());
    }
    Ok(())
}
pub(super) fn check_revision(record: &ActionInvocation, revision: u64) -> Result<(), ActionError> {
    SafeCounter::new(revision)?;
    if record.revision() != revision {
        Err(stale())
    } else {
        Ok(())
    }
}
pub(super) fn readable(
    context: &dyn MutationContext,
    db: AuthorityDb<'_>,
    scope: &ActionSubjectView,
    mut record: ActionInvocation,
) -> Result<ActionInvocation, ActionError> {
    record.check_lookup_version()?;
    if &record.scope != scope {
        return Err(denied());
    }
    context
        .read_access(db, scope, &record.request.account_id)?;
    let current = context.check(
        db,
        scope,
        &record.authority_request(),
        &record.definition,
    );
    let usable = match current {
        Ok(binding) => binding == record.binding,
        Err(ref e)
            if matches!(
                e.code,
                ActionErrorCode::Denied | ActionErrorCode::DefinitionMismatch
            ) =>
        {
            false
        }
        Err(e) => return Err(e),
    };
    if !usable {
        record.details.effect.can_retry = false;
        record.details.effect.can_reconcile = false;
    }
    let expired = record
        .approval
        .as_ref()
        .is_some_and(|approval| approval.view.expires_at <= now());
    if (!usable || expired)
        && matches!(
            record.details.effect.state,
            InvocationState::Ready | InvocationState::AwaitingApproval
        )
    {
        // This is a SELECT-only capability projection. Preserve the durable
        // revision and historical approval; only explicit refresh may renew.
        record.details.effect.state = InvocationState::AwaitingApproval;
        record.details.effect.approval_id = None;
        record.details.approval = None;
    }
    Ok(record)
}
pub(super) fn preview(
    context: &dyn MutationContext,
    definition: &ActionDefinition,
    input: &ValidatedInput,
    target: &AdapterTarget,
) -> Result<SafeEffectPreview, ActionError> {
    let _ = target_preview(target)?;
    let safe = context.preview(definition, input, target)?;
    if safe.summary.len() > 512
        || safe.fields.len() > 32
        || safe.redacted_fields.len() > 32
        || safe.fields.iter().any(|f| {
            f.label.len() > 128 || f.value.len() > 8192 || f.label.chars().any(char::is_control)
        })
        || safe.redacted_fields.iter().any(|f| f.len() > 128)
    {
        return Err(error(
            ActionErrorCode::LimitExceeded,
            "Action preview exceeds its limits.",
        ));
    }
    Ok(safe)
}
pub(super) fn approve(record: &mut ActionInvocation) -> Result<(), ActionError> {
    let a = record.approval.as_mut().ok_or_else(stale)?;
    a.view.approved_input_digest = Some(record.details.input_digest.clone());
    a.view.approved_preview = Some(record.details.preview.clone());
    a.view.revision = a.view.revision.next()?;
    a.approved_input = Some(record.canonical_input.clone());
    record.details.effect.state = InvocationState::Ready;
    Ok(())
}
pub(super) fn prepare_rows(
    conn: &Connection,
    context: &dyn MutationContext,
    scope: &ActionSubjectView,
    mut request: PrepareAction,
) -> Result<PrepareRows, ActionError> {
    require_transaction(conn)?;
    #[cfg(test)]
    test_probe::record_prepare();
    if [
        &request.action_id.0,
        &request.definition_digest.0,
        &request.connection_id.0,
        &request.account_id.0,
        &request.snapshot_digest.0,
    ]
    .iter()
    .any(|s| s.is_empty() || s.len() > limits().string_bytes)
    {
        return Err(error(
            ActionErrorCode::LimitExceeded,
            "Action selectors exceed their limits.",
        ));
    }
    if request.request_key.is_empty() || request.request_key.len() > 256 {
        return Err(error(
            ActionErrorCode::InvalidInput,
            "A bounded durable request key is required.",
        ));
    }
    let canonical = canonicalize(&request.input, false)?;
    request.input = canonical.value.canonical();
    let request_digest = request_digest(&request)?;
    let lookup_scope = scope_key(scope)?;
    let current =
        store::by_request(conn, &lookup_scope, &request.request_key).map_err(|_| unavailable())?;
    let legacy = store::by_request(
        conn,
        &legacy_scope_key(scope)?,
        &request.request_key,
    )
    .map_err(|_| unavailable())?;
    // One immediate transaction arbitrates both formats. Never choose one
    // of two historical rows, silently migrate, or allocate around ambiguity.
    // Coexisting v0 writers are unsupported: they cannot see v1 keys. This
    // service has not shipped/activated; rollout must keep that gate explicit.
    let found = match (current, legacy) {
        (Some(_), Some(_)) => return Err(unavailable()),
        (Some(raw), None) => Some((raw, 1)),
        (None, Some(raw)) => Some((raw, 0)),
        (None, None) => None,
    };
    if let Some((raw, expected_version)) = found {
        let original: ActionInvocation = decode(&raw)?;
        if original.lookup_version != expected_version {
            return Err(unavailable());
        }
        let original = readable(context, AuthorityDb::Writer(conn), scope, original)?;
        let candidate_digest = match expected_version {
            0 => legacy_request_digest(&request)?,
            1 => request_digest,
            _ => return Err(unavailable()),
        };
        if original.request_digest != candidate_digest {
            return Err(error(
                ActionErrorCode::RequestKeyConflict,
                "Request key already belongs to another action request.",
            ));
        }
        return Ok(PrepareRows {
            prepared: PreparedAction {
                approval_id: original.details.effect.approval_id.clone(),
                effect: original.details.effect,
                preview: original.details.preview,
            },
            inserted: false,
        });
    }
    let definition = context.definition(&request.action_id, &request.definition_digest)?;
    if matches!(
        definition.effect_class,
        EffectClass::ExternalSend | EffectClass::ExternalPublish | EffectClass::ExternalDelete
    ) {
        return Err(denied());
    }
    let input = validate_input(&definition, &request.input)?;
    let binding = context.check(
        AuthorityDb::Writer(conn),
        scope,
        &request,
        &definition,
    )?;
    if binding.account_label.is_empty()
        || binding.account_label.len() > 512
        || binding.account_label.chars().any(char::is_control)
    {
        return Err(denied());
    }
    if binding.account_identity_digest.len() != 64
        || !binding
            .account_identity_digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(denied());
    }
    SafeCounter::new(binding.account_revision)?;
    SafeCounter::new(binding.revocation_generation)?;
    let target = context.target(&definition, &input)?;
    let safe_preview = preview(context, &definition, &input, &target)?;
    let fence = if definition.effect_class == EffectClass::Read {
        None
    } else {
        Some(digest(
            encode(&(
                &binding.account_identity_digest,
                &target.conflict_domain,
                &target.target.safe_reference,
            ))?
            .as_bytes(),
        ))
    };
    if let Some(key) = &fence {
        if store::fence_busy(conn, key, None).map_err(|_| unavailable())? {
            return Err(error(
                ActionErrorCode::Denied,
                "An earlier action for this target has an unresolved outcome.",
            ));
        }
    }
    let approval = if definition.effect_class == EffectClass::Read {
        None
    } else {
        Some(new_approval(input.digest.clone()))
    };
    let id = InvocationId(oid());
    let details = ActionEffectDetails {
        effect: ActionEffectRef {
            invocation_id: id.clone(),
            state: if approval.is_some() {
                InvocationState::AwaitingApproval
            } else {
                InvocationState::Ready
            },
            approval_id: approval.as_ref().map(|a| a.view.approval_id.clone()),
            account_label: Some(binding.account_label.clone()),
            can_reconcile: false,
            can_retry: false,
        },
        revision: SafeCounter::new(1)?,
        account: Some(EffectAccount {
            account_id: binding.account_id.clone(),
            label: binding.account_label.clone(),
            account_revision: SafeCounter::new(binding.account_revision)?,
        }),
        target: Some(target.target.clone()),
        definition_digest: definition.definition_digest.clone(),
        input_digest: input.digest,
        preview: safe_preview,
        approval: approval.as_ref().map(|a| a.view.clone()),
        attempts: vec![],
    };
    let record = ActionInvocation {
        lookup_version: 1,
        scope: scope.clone(),
        request,
        request_digest,
        definition,
        binding,
        target,
        canonical_input: input.value.canonical(),
        fence,
        details,
        approval,
        cancel_requested: false,
        retry_decisions: Vec::new(),
    };
    store::insert(
        conn,
        &id.0,
        &lookup_scope,
        &record.request.request_key,
        &record.request_digest,
        record.revision(),
        &encode(&record.details.effect.state)?,
        record.fence.as_deref(),
        &encode(&record)?,
    )
    .map_err(|_| unavailable())?;
    if let Some(a) = &record.approval {
        store::save_approval(conn, &a.view.approval_id.0, &id.0, &encode(a)?)
            .map_err(|_| unavailable())?;
    }
    Ok(PrepareRows {
        prepared: PreparedAction {
            effect: record.details.effect,
            preview: record.details.preview,
            approval_id: record.approval.map(|a| a.view.approval_id),
        },
        inserted: true,
    })
}
pub(super) fn answer_rows(
    conn: &Connection,
    context: &dyn MutationContext,
    person: AnswerInput,
) -> Result<ActionEffectRef, ActionError> {
    require_transaction(conn)?;
    #[cfg(test)]
    test_probe::record_answer();
    if !person.person_id.starts_with("human:")
        || person.person_id.len() <= 6
        || person.person_id.len() > 128
    {
        return Err(denied());
    }
    SafeCounter::new(person.expected_approval_revision)?;
    let id = store::approval_invocation(conn, &person.approval_id.0)
        .map_err(|_| unavailable())?
        .ok_or_else(stale)?;
    let mut record = load(conn, &InvocationId(id))?;
    if record.scope != person.scope {
        return Err(denied());
    }
    check_revision(&record, person.expected_invocation_revision)?;
    let approval = record.approval.as_ref().ok_or_else(stale)?;
    if approval.view.approval_id != person.approval_id
        || approval.view.revision.get() != person.expected_approval_revision
        || approval.consumed
        || approval.retired
        || record.details.effect.state != InvocationState::AwaitingApproval
    {
        return Err(stale());
    }
    check(conn, context, &record)?;
    if approval.view.expires_at <= now() {
        return Err(denied());
    }
    let revision = record.revision();
    let audited = record.approval.as_mut().unwrap();
    audited.decided_by = Some(person.person_id);
    audited.decided_at = Some(now());
    audited.decision = Some(if person.allow {
        ApprovalDecision::Allow
    } else {
        ApprovalDecision::Deny
    });
    if !person.allow {
        record.details.effect.state = InvocationState::Cancelled;
        record.approval.as_mut().unwrap().retired = true;
    } else if let Some(edited) = person.edited_input {
        let input = validate_input(&record.definition, &edited)?;
        if input.digest != record.details.input_digest {
            let mut retired = record.approval.take().unwrap();
            retired.retired = true;
            retired.decision = Some(ApprovalDecision::Edited);
            store::save_approval(
                conn,
                &retired.view.approval_id.0,
                &record.details.effect.invocation_id.0,
                &encode(&retired)?,
            )
            .map_err(|_| unavailable())?;
            let target = context.target(&record.definition, &input)?;
            let safe = preview(context, &record.definition, &input, &target)?;
            record.target = target;
            record.fence = if record.definition.effect_class == EffectClass::Read {
                None
            } else {
                Some(digest(
                    encode(&(
                        &record.binding.account_identity_digest,
                        &record.target.conflict_domain,
                        &record.target.target.safe_reference,
                    ))?
                    .as_bytes(),
                ))
            };
            record.details.target = Some(record.target.target.clone());
            record.details.preview = safe;
            record.details.input_digest = input.digest.clone();
            record.canonical_input = input.value.canonical();
            record.approval = Some(new_approval(input.digest));
            record.details.effect.state = InvocationState::AwaitingApproval;
            check(conn, context, &record)?;
        } else {
            approve(&mut record)?;
        }
    } else {
        approve(&mut record)?;
    }
    record.bump()?;
    save(conn, &mut record, revision)?;
    Ok(record.details.effect)
}
/// Supplemental shared-path observation only; rollback/row tests are primary.
/// No production process, identity, authority or mutation behavior is added.
#[cfg(test)]
pub(in crate::actions) mod test_probe {
    use std::cell::Cell;
    std::thread_local! {
        static COUNTS: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
    }
    pub(in crate::actions) fn reset() { COUNTS.with(|counts| counts.set((0, 0))); }
    pub(in crate::actions) fn counts() -> (usize, usize) { COUNTS.with(Cell::get) }
    pub(super) fn record_prepare() { COUNTS.with(|counts| { let (prepare, answer) = counts.get(); counts.set((prepare + 1, answer)); }); }
    pub(super) fn record_answer() { COUNTS.with(|counts| { let (prepare, answer) = counts.get(); counts.set((prepare, answer + 1)); }); }
}

/// An Ok refusal must commit its changed rows before becoming a domain error.
#[derive(Debug)]
pub(super) enum ClaimDisposition {
    Claimed { attempt_id: AttemptId, canonical_input: String },
    CommitRefusal(ActionError),
}

pub(super) fn claim_rows(
    conn: &Connection,
    context: &dyn MutationContext,
    id: &InvocationId,
) -> Result<ClaimDisposition, ActionError> {
    require_transaction(conn)?;
    #[cfg(test)]
    claim_probe::record();
    let mut record = load(conn, id)?;
    if record.details.effect.state != InvocationState::Ready {
        return Err(stale());
    }
    let revision = record.revision();
    if record.cancel_requested {
        record.details.effect.state = InvocationState::Cancelled;
        if let Some(approval) = &mut record.approval {
            approval.retired = true;
        }
        record.bump()?;
        save(conn, &mut record, revision)?;
        return Ok(ClaimDisposition::CommitRefusal(error(
            ActionErrorCode::Denied,
            "Action was cancelled before submission.",
        )));
    }
    if let Err(mut refusal) = check(conn, context, &record) {
        if let Some(a) = &mut record.approval {
            a.retired = true;
        }
        record.details.effect.state = InvocationState::AwaitingApproval;
        record.bump()?;
        save(conn, &mut record, revision)?;
        refusal.retry_disposition = RetryDisposition::Refresh;
        return Ok(ClaimDisposition::CommitRefusal(refusal));
    }
    let unusable = record.approval.as_ref().is_some_and(|approval| {
        approval.consumed
            || approval.retired
            || approval.view.expires_at <= now()
            || approval.view.approved_input_digest.as_deref()
                != Some(&record.details.input_digest)
            || approval.approved_input.as_deref() != Some(&record.canonical_input)
    });
    if unusable {
        record.approval.as_mut().unwrap().retired = true;
        record.details.effect.state = InvocationState::AwaitingApproval;
        record.bump()?;
        save(conn, &mut record, revision)?;
        let mut refusal = denied();
        refusal.retry_disposition = RetryDisposition::Refresh;
        return Ok(ClaimDisposition::CommitRefusal(refusal));
    }
    if let Some(approval) = &mut record.approval {
        approval.consumed = true;
    } else if record.definition.effect_class != EffectClass::Read {
        return Err(denied());
    }
    if let Some(fence) = &record.fence {
        if store::fence_busy(conn, fence, Some(&id.0)).map_err(|_| unavailable())? {
            return Err(denied());
        }
    }
    let attempt = AttemptId(oid());
    let summary = ActionAttemptSummary {
        attempt_id: attempt.clone(),
        ordinal: SafeCounter::new(record.details.attempts.len() as u64 + 1)?,
        state: InvocationState::Dispatched,
        dispatched_at: Some(now()),
        observed_at: None,
        receipt_id: None,
        remote_effect_reference: None,
        outcome_summary: None,
    };
    if record.details.attempts.len() >= 32 {
        return Err(error(
            ActionErrorCode::LimitExceeded,
            "Action attempt history is full.",
        ));
    }
    store::insert_attempt(
        conn,
        &attempt.0,
        &id.0,
        summary.ordinal.get(),
        &encode(&summary)?,
    )
    .map_err(|_| unavailable())?;
    record.details.attempts.push(summary);
    record.details.effect.state = InvocationState::Dispatched;
    record.bump()?;
    super::output_handoff::pin_claim_rows(conn, &record, &attempt)?;
    save(conn, &mut record, revision)?;
    Ok(ClaimDisposition::Claimed { attempt_id: attempt, canonical_input: record.canonical_input })
}

#[cfg(test)]
pub(in crate::actions) mod claim_probe {
    use std::cell::Cell;
    std::thread_local! { static CLAIMS: Cell<usize> = const { Cell::new(0) }; }
    pub(in crate::actions) fn reset() { CLAIMS.with(|value| value.set(0)); }
    pub(in crate::actions) fn count() -> usize { CLAIMS.with(Cell::get) }
    pub(super) fn record() { CLAIMS.with(|value| value.set(value.get() + 1)); }
}

pub(super) enum Observation {
    Succeeded {
        output: String,
        remote_effect_reference: Option<String>,
    },
    ConfirmedNotApplied,
    ConfirmedCancelled,
    Unknown,
}

pub(super) fn observe_rows(conn:&Connection,id:&InvocationId,attempt:&AttemptId,expected:Option<u64>,observation:Observation)->Result<ActionEffectRef,ActionError>{
 observe_completed_rows(conn,id,attempt,expected,observation).map(|completed|completed.effect)
}

pub(super) fn observe_completed_rows(
    conn: &Connection,
    id: &InvocationId,
    attempt: &AttemptId,
    expected: Option<u64>,
    observation: Observation,
) -> Result<CompletedObservation, ActionError> {
    require_transaction(conn)?;
    let mut record = load(conn, id)?;
    if let Some(revision) = expected {
        check_revision(&record, revision)?;
    }
    if !matches!(
        record.details.effect.state,
        InvocationState::Dispatched | InvocationState::OutcomeUnknown
    ) || record.details.attempts.last().map(|a| &a.attempt_id) != Some(attempt)
    {
        return Err(stale());
    }
    let revision = record.revision();
    let mut remote_reference = None;
    let mut successful_output = None;
    let (state, summary) = match observation {
        Observation::Succeeded {
            output,
            remote_effect_reference,
        } => {
            let invalid_reference = remote_effect_reference.as_ref().is_some_and(|r| {
                r.is_empty()
                    || r.len() > 512
                    || !r
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_:/.".contains(&b))
            });
            if !invalid_reference {
                remote_reference = remote_effect_reference;
            }

            let validated = if invalid_reference { None } else { validate_output(&record.definition, &output).ok() };
            if let Some(validated) = validated {
                successful_output = Some(validated);
                (InvocationState::Succeeded, "Action completed.")
            } else {
                (InvocationState::OutcomeUnknown, "Response could not establish the outcome.")
            }
        }
        Observation::ConfirmedNotApplied => (
            InvocationState::Failed,
            "No effect was applied.",
        ),
        Observation::ConfirmedCancelled => (
            InvocationState::Cancelled,
            "Provider confirmed cancellation without an effect.",
        ),
        Observation::Unknown => (InvocationState::OutcomeUnknown, "Outcome unknown."),
    };
    record.details.effect.state = state;
    let last = record.details.attempts.last_mut().unwrap();
    if let Some(reference) = remote_reference {
        last.remote_effect_reference = Some(reference);
    }
    last.state = state;
    last.observed_at = Some(now());
    last.outcome_summary = Some(summary.into());
    if state != InvocationState::OutcomeUnknown {
        last.receipt_id = Some(oid());
    }
    store::update_attempt(conn, &attempt.0, &encode(last)?).map_err(|_| unavailable())?;
    record.bump()?;
    save(conn, &mut record, revision)?;
    if let Some(output) = &successful_output {
        super::output_handoff::retain_rows(conn, &record, output)?;
    }
    Ok(CompletedObservation{effect:record.details.effect,output:successful_output})
}

/// Private control data from the caller's real physical lease acquisition.
/// It is never deserialized and is not a native authority capability.
#[derive(Clone, Copy)]
pub(super) enum SubmissionAccess { Held, Busy }
pub(super) struct CancelRows {
    pub(super) record: ActionInvocation,
    pub(super) request_provider_cancel: bool,
}
pub(super) fn cancel_rows(
    conn: &Connection, context: &dyn MutationContext, scope: &ActionSubjectView,
    id: &InvocationId, revision: u64, submission: SubmissionAccess,
) -> Result<CancelRows, ActionError> {
    require_transaction(conn)?;
    #[cfg(test)]
    cancel_probe::record();
    let record = load(conn, id)?;
    if &record.scope != scope {
        return Err(denied());
    }
    check_revision(&record, revision)?;
    context.check(
        AuthorityDb::Writer(conn),
        &record.scope,
        &record.authority_request(),
        &record.definition,
    )?;
    cancel_recorded_rows(conn,scope,id,revision,submission)
}
#[cfg(test)]
pub(in crate::actions) mod cancel_probe {
    use std::cell::Cell;
    std::thread_local! { static CALLS: Cell<usize> = const { Cell::new(0) }; }
    pub(in crate::actions) fn reset() { CALLS.with(|value| value.set(0)); }
    pub(in crate::actions) fn count() -> usize { CALLS.with(Cell::get) }
    pub(super) fn record() { CALLS.with(|value| value.set(value.get()+1)); }
}

/// Same transaction observation result. Canonical output is transient and is
/// disclosed only by an original native caller after known commit + read checks.
pub(super) struct CompletedObservation{pub(super) effect:ActionEffectRef,pub(super) output:Option<ValidatedInput>}


/// Recorded cancellation only. Native coordinator must prove original retained
/// owner/store/native and immutable invocation binding in the same transaction;
/// these scope/id/revision values are selectors, never execution authority.
pub(super) fn cancel_recorded_rows(conn:&Connection,scope:&ActionSubjectView,id:&InvocationId,revision:u64,submission:SubmissionAccess)->Result<CancelRows,ActionError>{
    require_transaction(conn)?;
    let mut record=load(conn,id)?;
    if &record.scope!=scope{return Err(denied());}
    check_revision(&record,revision)?;
    record.cancel_requested = true;
    match record.details.effect.state {
        InvocationState::Prepared
        | InvocationState::AwaitingApproval
        | InvocationState::Ready => {
            if matches!(submission, SubmissionAccess::Held) {
                record.details.effect.state = InvocationState::Cancelled;
                if let Some(a) = &mut record.approval {
                    a.retired = true;
                }
            }
        }
        InvocationState::Dispatched | InvocationState::OutcomeUnknown => {}
        _ => return Err(stale()),
    }
    record.bump()?;
    save(conn, &mut record, revision)?;
    let request_provider_cancel = matches!(submission, SubmissionAccess::Held)
        && record.definition.cancel
        && matches!(record.details.effect.state, InvocationState::Dispatched | InvocationState::OutcomeUnknown);
    Ok(CancelRows { record, request_provider_cancel })
}
