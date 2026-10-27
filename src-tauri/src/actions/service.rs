//! Durable broker foundation. No IPC/MCP door or provider is registered here.
use super::effect_record::{ActionInvocation, RetryDecisionReceipt};
pub(super) use super::effect_record::{AdapterTarget, Binding};
use super::{catalog::ActionCatalog, schema::*, types::*};
use super::effect_kernel::{self, db, decode, denied, encode, new_approval, now, oid, target_preview as preview, unavailable};
use crate::runtime::{action_invocations as store, ReadOnly};
use rusqlite::{params, Connection, OptionalExtension};
use std::{path::PathBuf, sync::Arc};

// Admission remains unconstructible in production until native run/token/child
// doors validate the complete stored relationship. No wire type can mint it.
#[derive(Clone)]
pub(super) struct ActionSubject {
    scope: ActionSubjectView,
}
impl ActionSubject {
    /// Read-only view of an already minted capability; never constructs one.
    #[cfg(test)]
    pub(super) fn view(&self) -> &ActionSubjectView { &self.scope }
}
pub(super) struct PersonActionDecision {
    person_id: String,
    subject: ActionSubject,
    approval_id: ApprovalId,
    allow: bool,
    edited_input: Option<String>,
    expected_invocation_revision: u64,
    expected_approval_revision: u64,
}
pub(super) struct PersonRetryDecision {
    person_id: String,
    subject: ActionSubject,
    invocation_id: InvocationId,
    expected_revision: u64,
    acknowledges_uncertainty: bool,
}

/// Private native seam; implementations must re-read authority inside the same
/// SQLite write transaction as the claim. Fixtures use actual SQLite records.
pub(super) trait AuthoritySource: Send + Sync {
    fn catalog(
        &self,
        _db: AuthorityDb<'_>,
        _scope: &ActionSubjectView,
        _cursor: Option<CatalogCursor>,
    ) -> Result<ActionCatalogPage, ActionReadError> {
        Err(read_error(unavailable()))
    }
    fn definition(
        &self,
        _db: AuthorityDb<'_>,
        _scope: &ActionSubjectView,
        _id: ActionId,
        _digest: DefinitionDigest,
    ) -> Result<ActionDefinitionView, ActionReadError> {
        Err(read_error(unavailable()))
    }
    fn read_access(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        historical_account: &AccountId,
    ) -> Result<(), ActionError>;
    fn check(
        &self,
        db: AuthorityDb<'_>,
        scope: &ActionSubjectView,
        request: &PrepareAction,
        definition: &ActionDefinition,
    ) -> Result<Binding, ActionError>;
}
pub(super) use super::native_db::AuthorityDb;
/// Adapters derive conflict identity from validated semantic inputs, never keys
/// or caller nonces. All observations are finite; opaque provider text is absent.
pub(super) trait ActionAdapter: Send + Sync {
    fn target(
        &self,
        definition: &ActionDefinition,
        input: &ValidatedInput,
    ) -> Result<AdapterTarget, ActionError>;
    fn preview(
        &self,
        _definition: &ActionDefinition,
        _input: &ValidatedInput,
        target: &AdapterTarget,
    ) -> Result<SafeEffectPreview, ActionError> {
        preview(target)
    }
    fn invoke(
        &self,
        id: &InvocationId,
        attempt: &AttemptId,
        binding: &Binding,
        definition: &ActionDefinition,
        input: &str,
    ) -> Observation;
    fn reconcile(
        &self,
        _id: &InvocationId,
        _attempt: &AttemptId,
        _binding: &Binding,
        _definition: &ActionDefinition,
    ) -> Observation {
        Observation::Unknown
    }
    fn cancel(
        &self,
        _id: &InvocationId,
        _attempt: &AttemptId,
        _binding: &Binding,
        _definition: &ActionDefinition,
    ) -> Observation {
        Observation::Unknown
    }
}
pub(super) use super::effect_kernel::Observation;
#[derive(Clone)]
pub(super) struct DurableActionService {
    dir: PathBuf,
    catalog: Arc<ActionCatalog>,
    authority: Arc<dyn AuthoritySource>,
    adapter: Arc<dyn ActionAdapter>,
}
fn read_error(error: ActionError) -> ActionReadError {
    ActionReadError {
        code: match error.code {
            ActionErrorCode::NotFound => ActionReadErrorCode::NotFound,
            ActionErrorCode::Denied => ActionReadErrorCode::Denied,
            _ => ActionReadErrorCode::Unavailable,
        },
        retry_disposition: RetryDisposition::Never,
        message: "Action details could not be read.".into(),
    }
}
fn action_read_error(read: ActionReadError) -> ActionError {
    let code = match read.code {
        ActionReadErrorCode::NotFound => ActionErrorCode::NotFound,
        ActionReadErrorCode::Denied => ActionErrorCode::Denied,
        ActionReadErrorCode::Unavailable => ActionErrorCode::Unavailable,
    };
    error(code, "Action details could not be read.")
}
fn checkpoint(name: &str) {
    crate::crash::crash_point(name);
    crate::crash::stop_point(name);
}
impl DurableActionService {
    fn writer(&self) -> Result<Connection, ActionError> {
        let conn = crate::runtime::open_existing(&self.dir).map_err(|_| unavailable())?;
        Ok(conn)
    }
    fn load(&self, conn: &Connection, id: &InvocationId) -> Result<ActionInvocation, ActionError> {
        effect_kernel::load(conn, id)
    }

    fn save(&self, conn: &Connection, record: &mut ActionInvocation, expected: u64) -> Result<(), ActionError> {
        effect_kernel::save(conn, record, expected)
    }

    fn submission_owner(
        &self,
        record: &ActionInvocation,
    ) -> Result<Option<store::SubmissionOwner>, ActionError> {
        let conn = self.writer()?;
        self.authority.read_access(
            AuthorityDb::Writer(&conn),
            &record.scope,
            &record.request.account_id,
        )?;
        store::try_submission_owner(&conn, &self.dir, &record.details.effect.invocation_id.0)
            .map_err(|_| unavailable())
    }
    fn require_owner(
        &self,
        id: &InvocationId,
        owner: &store::SubmissionOwner,
    ) -> Result<(), ActionError> {
        if !owner.matches(&self.dir, &id.0).map_err(|_| unavailable())? {
            return Err(unavailable());
        }
        Ok(())
    }
    fn check(&self, conn: &Connection, record: &ActionInvocation) -> Result<(), ActionError> {
        effect_kernel::check(conn, self, record)
    }

    fn check_revision(record: &ActionInvocation, revision: u64) -> Result<(), ActionError> {
        effect_kernel::check_revision(record, revision)
    }

    fn scoped(
        &self,
        subject: &ActionSubject,
        id: &InvocationId,
    ) -> Result<ActionInvocation, ActionReadError> {
        let reader = ReadOnly::open(&self.dir).map_err(|_| read_error(unavailable()))?;
        let raw: Option<String> = reader
            .query_row(
                "SELECT payload FROM action_invocations WHERE invocation_id=?1",
                [&id.0],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| read_error(unavailable()))?;
        let record: ActionInvocation = decode(&raw.ok_or_else(|| {
            read_error(error(ActionErrorCode::NotFound, "Action was not found."))
        })?)
        .map_err(read_error)?;
        self.readable(AuthorityDb::Reader(&reader), subject, record)
            .map_err(read_error)
    }
    fn readable(&self, db: AuthorityDb<'_>, subject: &ActionSubject, record: ActionInvocation) -> Result<ActionInvocation, ActionError> {
        effect_kernel::readable(self, db, &subject.scope, record)
    }

    fn preview(&self, definition: &ActionDefinition, input: &ValidatedInput, target: &AdapterTarget) -> Result<SafeEffectPreview, ActionError> {
        effect_kernel::preview(self, definition, input, target)
    }

    pub(super) fn claim_dispatch(
        &self,
        id: &InvocationId,
        owner: &store::SubmissionOwner,
    ) -> Result<(AttemptId, String), ActionError> {
        self.require_owner(id, owner)?;
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let disposition = effect_kernel::claim_rows(&tx, self, id)?;
        db(tx.commit())?;
        match disposition {
            effect_kernel::ClaimDisposition::CommitRefusal(refusal) => Err(refusal),
            effect_kernel::ClaimDisposition::Claimed { attempt_id, canonical_input } => {
                checkpoint("action-claimed");
                Ok((attempt_id, canonical_input))
            }
        }
    }
    fn observe(
        &self,
        id: &InvocationId,
        attempt: &AttemptId,
        expected: Option<u64>,
        observation: Observation,
        owner: &store::SubmissionOwner,
    ) -> Result<ActionEffectRef, ActionError> {
        self.require_owner(id, owner)?;
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let effect = effect_kernel::observe_rows(&tx, id, attempt, expected, observation)?;
        db(tx.commit())?;
        Ok(effect)
    }
    // Internal, test-gated renewal only; absent from ActionService and IPC/MCP.
    // No rebind, Allow, new invocation, attempt or provider call occurs here.
    pub(super) fn refresh_approval(
        &self,
        subject: ActionSubject,
        id: InvocationId,
        expected_revision: u64,
    ) -> Result<ActionEffectRef, ActionError> {
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let mut record = self.load(&tx, &id)?;
        if record.scope != subject.scope {
            return Err(denied());
        }
        self.authority.read_access(
            AuthorityDb::Writer(&tx),
            &subject.scope,
            &record.request.account_id,
        )?;
        Self::check_revision(&record, expected_revision)?;
        if record.cancel_requested
            || !matches!(
                record.details.effect.state,
                InvocationState::Ready | InvocationState::AwaitingApproval
            )
        {
            return Err(denied());
        }
        let approval = record.approval.as_ref().ok_or_else(denied)?;
        if approval.consumed || approval.view.expires_at > now() {
            return Err(denied());
        }
        // These checks compare against the pinned binding and exact current
        // input/target. Refresh never installs a newly observed authority.
        self.check(&tx, &record)?;
        let input = validate_input(&record.definition, &record.canonical_input)?;
        if input.digest != record.details.input_digest {
            return Err(denied());
        }
        if let Some(fence) = &record.fence {
            if store::fence_busy(&tx, fence, Some(&id.0)).map_err(|_| unavailable())? {
                return Err(denied());
            }
        }
        let preview = self.preview(&record.definition, &input, &record.target)?;
        let revision = record.revision();
        let mut old = record.approval.take().ok_or_else(denied)?;
        old.retired = true;
        store::save_approval(&tx, &old.view.approval_id.0, &id.0, &encode(&old)?)
            .map_err(|_| unavailable())?;
        record.approval = Some(new_approval(input.digest));
        record.details.preview = preview;
        record.details.effect.state = InvocationState::AwaitingApproval;
        record.bump()?;
        self.save(&tx, &mut record, revision)?;
        db(tx.commit())?;
        Ok(record.details.effect)
    }
    pub(super) fn recover(&self) -> Result<(), ActionError> {
        let mut conn = self.writer()?;
        let ids = store::dispatched(&conn).map_err(|_| unavailable())?;
        for id in ids {
            let id = InvocationId(id);
            let initial = self.load(&conn, &id)?;
            let Some(owner) = self.submission_owner(&initial)? else {
                continue;
            };
            self.require_owner(&id, &owner)?;
            let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
            let mut record = self.load(&tx, &id)?;
            if record.details.effect.state != InvocationState::Dispatched {
                continue;
            }
            let revision = record.revision();
            record.details.effect.state = InvocationState::OutcomeUnknown;
            let last = record.details.attempts.last_mut().ok_or_else(unavailable)?;
            last.state = InvocationState::OutcomeUnknown;
            last.outcome_summary = Some("Outcome unknown after restart.".into());
            store::update_attempt(&tx, &last.attempt_id.0, &encode(last)?)
                .map_err(|_| unavailable())?;
            record.bump()?;
            self.save(&tx, &mut record, revision)?;
            db(tx.commit())?;
        }
        Ok(())
    }
}
impl ActionService for DurableActionService {
    fn catalog(
        &self,
        subject: ActionSubject,
        cursor: Option<CatalogCursor>,
    ) -> Result<ActionCatalogPage, ActionReadError> {
        let conn = ReadOnly::open(&self.dir).map_err(|_| read_error(unavailable()))?;
        self.authority
            .catalog(AuthorityDb::Reader(&conn), &subject.scope, cursor)
    }
    fn definition(
        &self,
        subject: ActionSubject,
        id: ActionId,
        digest: DefinitionDigest,
    ) -> Result<ActionDefinitionView, ActionReadError> {
        let conn = ReadOnly::open(&self.dir).map_err(|_| read_error(unavailable()))?;
        self.authority
            .definition(AuthorityDb::Reader(&conn), &subject.scope, id, digest)
    }
    fn prepare(&self, subject: ActionSubject, request: PrepareAction) -> Result<PreparedAction, ActionError> {
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let rows = effect_kernel::prepare_rows(&tx, self, &subject.scope, request)?;
        if !rows.inserted {
            return Ok(rows.prepared);
        }
        db(tx.commit())?;
        checkpoint("action-prepared");
        Ok(rows.prepared)
    }
    fn answer(&self, person: PersonActionDecision) -> Result<ActionEffectRef, ActionError> {
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let effect = effect_kernel::answer_rows(&tx, self, effect_kernel::AnswerInput {
            person_id: person.person_id,
            scope: person.subject.scope,
            approval_id: person.approval_id,
            allow: person.allow,
            edited_input: person.edited_input,
            expected_invocation_revision: person.expected_invocation_revision,
            expected_approval_revision: person.expected_approval_revision,
        })?;
        db(tx.commit())?;
        checkpoint("action-approved");
        Ok(effect)
    }
    fn dispatch(&self, id: InvocationId) -> Result<ActionEffectRef, ActionError> {
        let initial = self.load(&self.writer()?, &id)?;
        let Some(owner) = self.submission_owner(&initial)? else {
            return Ok(self.load(&self.writer()?, &id)?.details.effect);
        };
        let (attempt, input) = match self.claim_dispatch(&id, &owner) {
            Ok(claim) => claim,
            Err(e) => {
                let conn = self.writer()?;
                let record = self.load(&conn, &id)?;
                if matches!(
                    record.details.effect.state,
                    InvocationState::Dispatched
                        | InvocationState::OutcomeUnknown
                        | InvocationState::Succeeded
                        | InvocationState::Failed
                ) {
                    return Ok(record.details.effect);
                }
                return Err(e);
            }
        };
        let record = self.load(&self.writer()?, &id)?;
        let observation =
            self.adapter
                .invoke(&id, &attempt, &record.binding, &record.definition, &input);
        checkpoint("action-response-before-receipt");
        self.observe(&id, &attempt, None, observation, &owner)
    }
    fn reconcile(
        &self,
        subject: ActionSubject,
        id: InvocationId,
        revision: u64,
    ) -> Result<ActionEffectRef, ActionError> {
        let initial = self.scoped(&subject, &id).map_err(action_read_error)?;
        Self::check_revision(&initial, revision)?;
        if !initial.details.effect.can_reconcile {
            return Err(denied());
        }
        let Some(owner) = self.submission_owner(&initial)? else {
            let mut busy = error(
                ActionErrorCode::Unavailable,
                "Submission is still owned; check again after it settles.",
            );
            busy.retry_disposition = RetryDisposition::Refresh;
            return Err(busy);
        };
        let record = self.scoped(&subject, &id).map_err(action_read_error)?;
        Self::check_revision(&record, revision)?;
        if !record.details.effect.can_reconcile {
            return Err(denied());
        }
        let attempt = record
            .details
            .attempts
            .last()
            .ok_or_else(denied)?
            .attempt_id
            .clone();
        self.check(&self.writer()?, &record)?;
        let observation =
            self.adapter
                .reconcile(&id, &attempt, &record.binding, &record.definition);
        self.observe(&id, &attempt, Some(revision), observation, &owner)
    }
    fn retry(
        &self,
        subject: ActionSubject,
        id: InvocationId,
        revision: u64,
        decision: PersonRetryDecision,
    ) -> Result<ActionEffectRef, ActionError> {
        if !decision.person_id.starts_with("human:")
            || decision.person_id.len() <= 6
            || decision.person_id.len() > 128
        {
            return Err(denied());
        }
        if subject.scope != decision.subject.scope
            || id != decision.invocation_id
            || revision != decision.expected_revision
            || !decision.acknowledges_uncertainty
        {
            return Err(denied());
        }
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let mut record = self.load(&tx, &id)?;
        if record.scope != subject.scope {
            return Err(denied());
        }
        Self::check_revision(&record, revision)?;
        self.check(&tx, &record)?;
        // The bounded foundation permits reviewed retry only after positive
        // non-application proof. Unknown effects remain fenced even for a new key.
        if !record.details.effect.can_retry {
            return Err(denied());
        }
        record.retry_decisions.push(RetryDecisionReceipt {
            person_id: decision.person_id,
            acknowledged_at: now(),
            prior_revision: revision,
            prior_attempt_id: record
                .details
                .attempts
                .last()
                .ok_or_else(denied)?
                .attempt_id
                .clone(),
        });
        record.approval = Some(new_approval(record.details.input_digest.clone()));
        record.details.effect.state = InvocationState::AwaitingApproval;
        record.bump()?;
        self.save(&tx, &mut record, revision)?;
        db(tx.commit())?;
        Ok(record.details.effect)
    }
    fn effect_ref(
        &self,
        subject: ActionSubject,
        id: InvocationId,
    ) -> Result<ActionEffectRef, ActionReadError> {
        Ok(self.scoped(&subject, &id)?.details.effect)
    }
    fn effect_details(
        &self,
        subject: ActionSubject,
        id: InvocationId,
    ) -> Result<ActionEffectDetails, ActionReadError> {
        Ok(self.scoped(&subject, &id)?.details)
    }
    fn request_cancel(
        &self,
        subject: ActionSubject,
        id: InvocationId,
        revision: u64,
    ) -> Result<ActionEffectRef, ActionError> {
        let initial = self.scoped(&subject, &id).map_err(action_read_error)?;
        Self::check_revision(&initial, revision)?;
        let owner = self.submission_owner(&initial)?;
        let mut conn = self.writer()?;
        let tx = db(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let rows = effect_kernel::cancel_rows(
            &tx, self, &subject.scope, &id, revision,
            if owner.is_some() { effect_kernel::SubmissionAccess::Held } else { effect_kernel::SubmissionAccess::Busy },
        )?;
        db(tx.commit())?;
        let record = rows.record;
        if rows.request_provider_cancel {
            if let Some(owner) = owner.as_ref() {
                self.check(&self.writer()?, &record)?;
                let attempt = record.details.attempts.last().ok_or_else(denied)?.attempt_id.clone();
                let observation = self.adapter.cancel(&id, &attempt, &record.binding, &record.definition);
                if !matches!(observation, Observation::Unknown) {
                    return self.observe(&id, &attempt, Some(record.revision()), observation, owner);
                }
            }
        }
        Ok(record.details.effect)
    }
}

// Borrowed mutation facade. Provider execution remains in this test-only
// service; the shared mutation context can only check authority/derive previews.
impl super::effect_kernel::MutationContext for DurableActionService {
    fn definition(&self, id: &ActionId, digest: &DefinitionDigest) -> Result<ActionDefinition, ActionError> {
        self.catalog.resolve(id, digest)
    }
    fn check(&self, db: AuthorityDb<'_>, scope: &ActionSubjectView, request: &PrepareAction, definition: &ActionDefinition) -> Result<Binding, ActionError> {
        self.authority.check(db, scope, request, definition)
    }
    fn read_access(&self, db: AuthorityDb<'_>, scope: &ActionSubjectView, account: &AccountId) -> Result<(), ActionError> {
        self.authority.read_access(db, scope, account)
    }
    fn target(&self, definition: &ActionDefinition, input: &ValidatedInput) -> Result<AdapterTarget, ActionError> {
        self.adapter.target(definition, input)
    }
    fn preview(&self, definition: &ActionDefinition, input: &ValidatedInput, target: &AdapterTarget) -> Result<SafeEffectPreview, ActionError> {
        self.adapter.preview(definition, input, target)
    }
}

#[cfg(test)]
pub(in crate::actions) mod test_support {
    use super::*;
    use std::sync::Mutex;
    const VAULT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    struct StoredAuthority;
    impl AuthoritySource for StoredAuthority {
        fn read_access(
            &self,
            conn: AuthorityDb<'_>,
            scope: &ActionSubjectView,
            _historical_account: &AccountId,
        ) -> Result<(), ActionError> {
            let raw: String = conn
                .query(
                    "SELECT value FROM fixture_native_authority WHERE run_id=?1",
                    &[&scope.run_id],
                    |r| r.get(0),
                )
                .map_err(|_| denied())?;
            let value: serde_json::Value = decode(&raw)?;
            let stored: ActionSubjectView = serde_json::from_value(value["scope"].clone()).unwrap();
            if stored != *scope {
                return Err(denied());
            }
            Ok(())
        }
        fn check(
            &self,
            conn: AuthorityDb<'_>,
            scope: &ActionSubjectView,
            request: &PrepareAction,
            definition: &ActionDefinition,
        ) -> Result<Binding, ActionError> {
            let raw: String = conn
                .query(
                    "SELECT value FROM fixture_native_authority WHERE run_id=?1",
                    &[&scope.run_id],
                    |r| r.get(0),
                )
                .map_err(|_| denied())?;
            let value: serde_json::Value = decode(&raw)?;
            let stored: ActionSubjectView = serde_json::from_value(value["scope"].clone()).unwrap();
            let mut binding: Binding = serde_json::from_value(value["binding"].clone()).unwrap();
            binding.account_identity_digest = digest(
                encode(&(
                    value["issuer"].as_str().ok_or_else(denied)?,
                    value["providerSubject"].as_str().ok_or_else(denied)?,
                ))?
                .as_bytes(),
            );
            if stored != *scope
                || request.account_id != binding.account_id
                || value["connectionId"] != request.connection_id.0
                || request.snapshot_digest != binding.snapshot_digest
                || value["definition"] != definition.definition_digest.0
            {
                return Err(denied());
            }
            Ok(binding)
        }
    }
    struct InputRestrictedAuthority {
        inner: Arc<dyn AuthoritySource>,
    }
    impl AuthoritySource for InputRestrictedAuthority {
        fn read_access(
            &self,
            db: AuthorityDb<'_>,
            scope: &ActionSubjectView,
            account: &AccountId,
        ) -> Result<(), ActionError> {
            self.inner.read_access(db, scope, account)
        }
        fn check(
            &self,
            db: AuthorityDb<'_>,
            scope: &ActionSubjectView,
            request: &PrepareAction,
            definition: &ActionDefinition,
        ) -> Result<Binding, ActionError> {
            let input = canonicalize(&request.input, false)?;
            let Node::Object(fields) = input.value else {
                return Err(denied());
            };
            if fields.get("title") != Some(&Node::String("first".into())) {
                return Err(denied());
            }
            self.inner.check(db, scope, request, definition)
        }
    }
    struct PausedSubmissionAdapter {
        inner: Arc<dyn ActionAdapter>,
        entered: std::sync::mpsc::SyncSender<()>,
        resume: Arc<std::sync::Barrier>,
    }
    impl ActionAdapter for PausedSubmissionAdapter {
        fn target(
            &self,
            definition: &ActionDefinition,
            input: &ValidatedInput,
        ) -> Result<AdapterTarget, ActionError> {
            self.inner.target(definition, input)
        }
        fn preview(
            &self,
            definition: &ActionDefinition,
            input: &ValidatedInput,
            target: &AdapterTarget,
        ) -> Result<SafeEffectPreview, ActionError> {
            self.inner.preview(definition, input, target)
        }
        fn invoke(
            &self,
            id: &InvocationId,
            attempt: &AttemptId,
            binding: &Binding,
            definition: &ActionDefinition,
            input: &str,
        ) -> Observation {
            // The claim is already durable. Pause before the independent fixture
            // adapter records any outside effect. A last-moment check immediately
            // before this method would still lose the race exercised here.
            self.entered.send(()).unwrap();
            self.resume.wait();
            self.inner.invoke(id, attempt, binding, definition, input)
        }
        fn reconcile(
            &self,
            id: &InvocationId,
            attempt: &AttemptId,
            binding: &Binding,
            definition: &ActionDefinition,
        ) -> Observation {
            self.inner.reconcile(id, attempt, binding, definition)
        }
        fn cancel(
            &self,
            id: &InvocationId,
            attempt: &AttemptId,
            binding: &Binding,
            definition: &ActionDefinition,
        ) -> Observation {
            self.inner.cancel(id, attempt, binding, definition)
        }
    }
    struct FixtureAdapter {
        dir: PathBuf,
        observation: Arc<Mutex<String>>,
    }
    impl ActionAdapter for FixtureAdapter {
        fn target(
            &self,
            _: &ActionDefinition,
            _: &ValidatedInput,
        ) -> Result<AdapterTarget, ActionError> {
            Ok(AdapterTarget {
                conflict_domain: "issue-create".into(),
                target: EffectTarget {
                    kind: "repository".into(),
                    label: "fixture/repo".into(),
                    safe_reference: "repo:42".into(),
                },
            })
        }
        fn preview(
            &self,
            _: &ActionDefinition,
            input: &ValidatedInput,
            target: &AdapterTarget,
        ) -> Result<SafeEffectPreview, ActionError> {
            let mut safe = preview(target)?;
            if let Node::Object(fields) = &input.value {
                if let Some(Node::String(title)) = fields.get("title") {
                    safe.fields.push(PreviewField {
                        label: "Title".into(),
                        value: title.clone(),
                    });
                }
            }
            Ok(safe)
        }
        fn reconcile(
            &self,
            _id: &InvocationId,
            _attempt: &AttemptId,
            _binding: &Binding,
            _definition: &ActionDefinition,
        ) -> Observation {
            if self.observation.lock().unwrap().as_str() == "not-applied" {
                return Observation::ConfirmedNotApplied;
            }
            if self.observation.lock().unwrap().as_str() == "reconciled" {
                Observation::Succeeded {
                    output: "null".into(),
                    remote_effect_reference: Some("fixture-effect:42".into()),
                }
            } else {
                Observation::Unknown
            }
        }
        fn cancel(
            &self,
            _id: &InvocationId,
            _attempt: &AttemptId,
            _binding: &Binding,
            _definition: &ActionDefinition,
        ) -> Observation {
            if self.observation.lock().unwrap().as_str() == "cancel-confirmed" {
                Observation::ConfirmedCancelled
            } else {
                Observation::Unknown
            }
        }
        fn invoke(
            &self,
            _: &InvocationId,
            _: &AttemptId,
            _: &Binding,
            _: &ActionDefinition,
            _: &str,
        ) -> Observation {
            if let Some(gate) = std::env::var_os("CEREBRO_ACTION_PROCESS_GATE") {
                let gate = PathBuf::from(gate);
                std::fs::write(gate.join("entered"), b"claimed before outside submission").unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                while !gate.join("release").exists() {
                    if std::time::Instant::now() >= deadline {
                        return Observation::Unknown;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            let conn = Connection::open(crate::runtime::runtime_db_path(&self.dir)).unwrap();
            conn.execute(
                "INSERT INTO fixture_provider_submissions DEFAULT VALUES",
                [],
            )
            .unwrap();
            match self.observation.lock().unwrap().as_str() {
                "invalid-with-reference" => Observation::Succeeded {output:"not-json".into(),remote_effect_reference:Some("fixture-effect:42".into())},
                "sentinel" => Observation::Succeeded {output:r#"{"token":"TOKEN_SENTINEL","headers":"HEADER_SENTINEL","env":"ENV_SENTINEL"}"#.into(),remote_effect_reference:None},
                "invalid" => Observation::Succeeded {
                    output: "not-json".into(),
                    remote_effect_reference:None,
                },
                "unknown" => Observation::Unknown,
                "failed" => Observation::ConfirmedNotApplied,
                _ => Observation::Succeeded {
                    output: "null".into(),
                    remote_effect_reference:None,
                },
            }
        }
    }
    pub(in crate::actions) struct Harness {
        dir: PathBuf,
        catalog: Arc<ActionCatalog>,
        definition: ActionDefinition,
        observation: Arc<Mutex<String>>,
    }
    impl Harness {
        pub(in crate::actions) fn new(label: &str) -> Self {
            let dir = std::env::var_os("CEREBRO_ACTION_TEST_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    crate::vault::testutil::temp_vault(&format!("m96-action-{label}"))
                });
            let conn = crate::runtime::open(&dir).unwrap();
            conn.execute_batch("CREATE TABLE IF NOT EXISTS fixture_native_authority(run_id TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value))); CREATE TABLE IF NOT EXISTS fixture_chat(thread TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS fixture_provider_submissions(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO fixture_chat VALUES('parent');").unwrap();
            let mut catalog = ActionCatalog::default();
            let definition=catalog.insert(DefinitionMaterial { action_id:ActionId("fixture:issue-create".into()), input_schema:r#"{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}"#.into(), output_schema:r#"{"type":"null"}"#.into(), adapter_revision:"fixture-1".into(),effect_class:EffectClass::ExternalMutation,required_capabilities:vec!["fixture:issue-create".into()],retry:RetryContract::Never,cancel:true,reconcile:true,secret_input_fields:vec![] },"{}").unwrap();
            let binding = Binding {
                account_id: AccountId("account".into()),
                account_identity_digest: digest(
                    encode(&("https://fixture.invalid", "fixture-account-42"))
                        .unwrap()
                        .as_bytes(),
                ),
                account_revision: 1,
                account_label: "Fixture account".into(),
                grant_digest: "grant-1".into(),
                policy_digest: "policy-1".into(),
                revocation_generation: 0,
                snapshot_digest: SnapshotDigest("snapshot-1".into()),
            };
            for run in ["run", "other-run"] {
                let value = serde_json::json!({"scope": Self::scope(run),"connectionId":"connection","binding":binding,"secretRevision":1,"issuer":"https://fixture.invalid","providerSubject":"fixture-account-42","definition":definition.definition_digest.0});
                conn.execute(
                    "INSERT OR IGNORE INTO fixture_native_authority VALUES(?1,?2)",
                    params![run, value.to_string()],
                )
                .unwrap();
            }
            Self {
                dir,
                catalog: Arc::new(catalog),
                definition,
                observation: Arc::new(Mutex::new("success".into())),
            }
        }
        fn scope(run: &str) -> ActionSubjectView {
            ActionSubjectView {
                vault_id: VAULT.into(),
                run_id: run.into(),
                actor_id: "human:fixture".into(),
                child_job_id: None,
                client_id: None,
            }
        }
        pub(in crate::actions) fn subject(&self) -> ActionSubject {
            ActionSubject {
                scope: Self::scope("run"),
            }
        }
        pub(in crate::actions) fn other_subject(&self) -> ActionSubject {
            ActionSubject {
                scope: Self::scope("other-run"),
            }
        }
        pub(in crate::actions) fn service(&self) -> DurableActionService {
            DurableActionService {
                dir: self.dir.clone(),
                catalog: self.catalog.clone(),
                authority: Arc::new(StoredAuthority),
                adapter: Arc::new(FixtureAdapter {
                    dir: self.dir.clone(),
                    observation: self.observation.clone(),
                }),
            }
        }
        fn request(&self, key: &str, title: &str) -> PrepareAction {
            PrepareAction {
                action_id: self.definition.action_id.clone(),
                definition_digest: self.definition.definition_digest.clone(),
                connection_id: ConnectionId("connection".into()),
                account_id: AccountId("account".into()),
                snapshot_digest: SnapshotDigest("snapshot-1".into()),
                input: serde_json::json!({"title":title}).to_string(),
                request_key: key.into(),
            }
        }
        pub(in crate::actions) fn prepare(
            &self,
            key: &str,
            title: &str,
        ) -> Result<PreparedAction, ActionError> {
            self.service()
                .prepare(self.subject(), self.request(key, title))
        }
        pub(in crate::actions) fn prepare_other_run(
            &self,
            key: &str,
            title: &str,
        ) -> Result<PreparedAction, ActionError> {
            self.service()
                .prepare(self.other_subject(), self.request(key, title))
        }
        pub(in crate::actions) fn spoofed_prepare(
            &self,
            field: &str,
        ) -> Result<PreparedAction, ActionError> {
            let mut s = self.subject();
            match field {
                "vault" => s.scope.vault_id = "forged".into(),
                "run" => s.scope.run_id = "forged".into(),
                "actor" => s.scope.actor_id = "forged".into(),
                "child" => s.scope.child_job_id = Some("forged".into()),
                "client" => s.scope.client_id = Some("forged".into()),
                _ => unreachable!(),
            };
            self.service().prepare(s, self.request("forged", "first"))
        }
        pub(in crate::actions) fn details(&self, id: &InvocationId) -> ActionEffectDetails {
            self.service()
                .effect_details(self.subject(), id.clone())
                .unwrap()
        }
        pub(in crate::actions) fn decision(
            &self,
            id: &InvocationId,
            allow: bool,
            edit: Option<&str>,
        ) -> PersonActionDecision {
            let d = self.details(id);
            PersonActionDecision {
                person_id: "human:fixture".into(),
                subject: self.subject(),
                approval_id: d.approval.unwrap().approval_id,
                allow,
                edited_input: edit.map(|v| serde_json::json!({"title":v}).to_string()),
                expected_invocation_revision: d.revision.get(),
                expected_approval_revision: 1,
            }
        }
        pub(in crate::actions) fn stale_decision(
            &self,
            _id: &InvocationId,
            approval_id: ApprovalId,
        ) -> PersonActionDecision {
            PersonActionDecision {
                person_id: "human:fixture".into(),
                subject: self.subject(),
                approval_id,
                allow: true,
                edited_input: None,
                expected_invocation_revision: 1,
                expected_approval_revision: 1,
            }
        }
        pub(in crate::actions) fn allow(
            &self,
            id: &InvocationId,
        ) -> Result<ActionEffectRef, ActionError> {
            self.service().answer(self.decision(id, true, None))
        }
        pub(in crate::actions) fn change_authority(&self, kind: &str) {
            let conn = self.service().writer().unwrap();
            let (path, value) = match kind {
                "revocation" => ("$.binding.revocation_generation", serde_json::json!(1)),
                "account" => ("$.binding.account_revision", serde_json::json!(2)),
                "secret" => ("$.secretRevision", serde_json::json!(2)),
                "grant" => ("$.binding.grant_digest", serde_json::json!("grant-2")),
                "schema" => ("$.definition", serde_json::json!("different")),
                "policy" => ("$.binding.policy_digest", serde_json::json!("policy-2")),
                _ => unreachable!(),
            };
            conn.execute(
                "UPDATE fixture_native_authority SET value=json_set(value,?1,json(?2))",
                params![path, value.to_string()],
            )
            .unwrap();
        }
        fn count(&self, table: &str) -> usize {
            self.service()
                .writer()
                .unwrap()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap() as usize
        }
        pub(in crate::actions) fn attempts(&self) -> usize {
            self.count("action_attempts")
        }
        pub(in crate::actions) fn invocations(&self) -> usize {
            self.count("action_invocations")
        }
        pub(in crate::actions) fn submissions(&self) -> usize {
            self.count("fixture_provider_submissions")
        }
        pub(in crate::actions) fn expire(&self) {
            let service = self.service();
            let mut conn = service.writer().unwrap();
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            let id: String = tx
                .query_row("SELECT invocation_id FROM action_invocations", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let mut record = service.load(&tx, &InvocationId(id)).unwrap();
            record.approval.as_mut().unwrap().view.expires_at = "2000-01-01T00:00:00.000Z".into();
            let revision = record.revision();
            service.save(&tx, &mut record, revision).unwrap();
            tx.commit().unwrap();
        }
        pub(in crate::actions) fn claim_without_receipt(&self, id: &InvocationId) {
            let service = self.service();
            let record = service.load(&service.writer().unwrap(), id).unwrap();
            let owner = service.submission_owner(&record).unwrap().unwrap();
            service.claim_dispatch(id, &owner).unwrap();
        }
        pub(in crate::actions) fn recover(&self) {
            self.service().recover().unwrap();
        }
        pub(in crate::actions) fn cancel(
            &self,
            id: &InvocationId,
        ) -> Result<ActionEffectRef, ActionError> {
            self.service().request_cancel(
                self.subject(),
                id.clone(),
                self.details(id).revision.get(),
            )
        }
        pub(in crate::actions) fn delete_parent(&self) {
            self.service()
                .writer()
                .unwrap()
                .execute("DELETE FROM fixture_chat", [])
                .unwrap();
        }
        pub(in crate::actions) fn retry(
            &self,
            id: &InvocationId,
            acknowledges_uncertainty: bool,
        ) -> Result<ActionEffectRef, ActionError> {
            let revision = self.details(id).revision.get();
            self.service().retry(
                self.subject(),
                id.clone(),
                revision,
                PersonRetryDecision {
                    person_id: "human:fixture".into(),
                    subject: self.subject(),
                    invocation_id: id.clone(),
                    expected_revision: revision,
                    acknowledges_uncertainty,
                },
            )
        }
        pub(in crate::actions) fn idempotent(label: &str) -> Self {
            let mut h = Self::new(label);
            let bytes = h
                .catalog
                .export(&h.definition.action_id, &h.definition.definition_digest)
                .unwrap();
            let envelope: serde_json::Value = serde_json::from_str(&bytes).unwrap();
            let mut material: DefinitionMaterial =
                serde_json::from_value(envelope["material"].clone()).unwrap();
            material.retry = RetryContract::Idempotent;
            h.definition = Arc::get_mut(&mut h.catalog)
                .unwrap()
                .insert(material, "{}")
                .unwrap();
            h.service()
                .writer()
                .unwrap()
                .execute(
                    "UPDATE fixture_native_authority SET value=json_set(value,'$.definition',?1)",
                    [&h.definition.definition_digest.0],
                )
                .unwrap();
            h
        }
        pub(in crate::actions) fn replay_without_catalog(
            &self,
            key: &str,
            title: &str,
        ) -> Result<PreparedAction, ActionError> {
            let mut service = self.service();
            service.catalog = Arc::new(ActionCatalog::default());
            service.prepare(self.subject(), self.request(key, title))
        }
        pub(in crate::actions) fn approval_audit(&self, id: &InvocationId) -> serde_json::Value {
            let raw: String = self
                .service()
                .writer()
                .unwrap()
                .query_row(
                    "SELECT payload FROM action_approvals WHERE invocation_id=?1",
                    [&id.0],
                    |r| r.get(0),
                )
                .unwrap();
            serde_json::from_str(&raw).unwrap()
        }
        pub(in crate::actions) fn input_restricted_service(&self) -> DurableActionService {
            let mut service = self.service();
            service.authority = Arc::new(InputRestrictedAuthority {
                inner: service.authority.clone(),
            });
            service
        }
        pub(in crate::actions) fn paused_submission_service(
            &self,
        ) -> (
            DurableActionService,
            std::sync::mpsc::Receiver<()>,
            Arc<std::sync::Barrier>,
        ) {
            let mut service = self.service();
            let (entered, receive) = std::sync::mpsc::sync_channel(1);
            let resume = Arc::new(std::sync::Barrier::new(2));
            service.adapter = Arc::new(PausedSubmissionAdapter {
                inner: service.adapter.clone(),
                entered,
                resume: resume.clone(),
            });
            (service, receive, resume)
        }
        pub(in crate::actions) fn dir(&self) -> &std::path::Path {
            &self.dir
        }
        pub(in crate::actions) fn prepare_alias_account(
            &self,
        ) -> Result<PreparedAction, ActionError> {
            self.service().writer().unwrap().execute("UPDATE fixture_native_authority SET value=json_set(value,'$.binding.account_id','alias-account','$.connectionId','alias-connection') WHERE run_id='other-run'",[]).unwrap();
            let mut request = self.request("alias-request", "second");
            request.account_id = AccountId("alias-account".into());
            request.connection_id = ConnectionId("alias-connection".into());
            self.service().prepare(self.other_subject(), request)
        }
        pub(in crate::actions) fn lookup_columns(&self, id: &InvocationId) -> (String, String) {
            self.service().writer().unwrap().query_row(
                "SELECT subject_scope,request_digest FROM action_invocations WHERE invocation_id=?1",
                [&id.0], |row| Ok((row.get(0)?,row.get(1)?)),
            ).unwrap()
        }
        pub(in crate::actions) fn fixture_lookup(
            &self,
            id: &InvocationId,
            scope: &str,
            request_digest: &str,
        ) {
            let service = self.service();
            let conn = service.writer().unwrap();
            let mut record = service.load(&conn, id).unwrap();
            record.request_digest = request_digest.into();
            let mut payload = serde_json::to_value(&record).unwrap();
            payload.as_object_mut().unwrap().remove("lookup_version");
            conn.execute(
                "UPDATE action_invocations SET subject_scope=?1,request_digest=?2,payload=?3 WHERE invocation_id=?4",
                params![scope,request_digest,payload.to_string(),id.0],
            ).unwrap();
        }
        pub(in crate::actions) fn duplicate_fixture_lookup(
            &self,
            id: &InvocationId,
            scope: &str,
            request_digest: &str,
        ) {
            let service = self.service();
            let conn = service.writer().unwrap();
            let mut record = service.load(&conn, id).unwrap();
            record.details.effect.invocation_id = InvocationId(oid());
            record.request_digest = request_digest.into();
            let mut payload = serde_json::to_value(&record).unwrap();
            payload["lookup_version"] = serde_json::json!(1);
            store::insert(
                &conn,
                &record.details.effect.invocation_id.0,
                scope,
                &record.request.request_key,
                request_digest,
                record.revision(),
                &encode(&record.details.effect.state).unwrap(),
                record.fence.as_deref(),
                &payload.to_string(),
            )
            .unwrap();
        }
        pub(in crate::actions) fn fixture_lookup_version(&self, id: &InvocationId, version: u8) {
            self.service().writer().unwrap().execute(
                "UPDATE action_invocations SET payload=json_set(payload,'$.lookup_version',?1) WHERE invocation_id=?2",
                params![version,id.0],
            ).unwrap();
        }
        pub(in crate::actions) fn raw_action_rows(&self) -> Vec<String> {
            let conn = self.service().writer().unwrap();
            let mut rows = Vec::new();
            for sql in [
                "SELECT json_array(invocation_id,subject_scope,request_key,request_digest,revision,state,fence,payload) FROM action_invocations ORDER BY invocation_id",
                "SELECT json_array(approval_id,invocation_id,payload) FROM action_approvals ORDER BY approval_id",
                "SELECT json_array(attempt_id,invocation_id,ordinal,payload) FROM action_attempts ORDER BY attempt_id",
            ] {
                let mut statement = conn.prepare(sql).unwrap();
                rows.extend(statement.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap());
            }
            rows
        }
        pub(in crate::actions) fn expire_id(&self, id: &InvocationId) {
            let service = self.service();
            let mut conn = service.writer().unwrap();
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            let mut record = service.load(&tx, id).unwrap();
            record.approval.as_mut().unwrap().view.expires_at = "2000-01-01T00:00:00.000Z".into();
            let revision = record.revision();
            service.save(&tx, &mut record, revision).unwrap();
            tx.commit().unwrap();
        }
        pub(in crate::actions) fn approval_by_id(&self, id: &ApprovalId) -> serde_json::Value {
            let raw: String = self
                .service()
                .writer()
                .unwrap()
                .query_row(
                    "SELECT payload FROM action_approvals WHERE approval_id=?1",
                    [&id.0],
                    |r| r.get(0),
                )
                .unwrap();
            serde_json::from_str(&raw).unwrap()
        }
        pub(in crate::actions) fn set_observation(&self, value: &str) {
            *self.observation.lock().unwrap() = value.into();
        }
    }
    fn kernel_decision(harness: &Harness, id: &InvocationId) -> super::super::effect_kernel::AnswerInput {
        let person = harness.decision(id, true, None);
        super::super::effect_kernel::AnswerInput {
            person_id: person.person_id,
            scope: person.subject.scope,
            approval_id: person.approval_id,
            allow: person.allow,
            edited_input: person.edited_input,
            expected_invocation_revision: person.expected_invocation_revision,
            expected_approval_revision: person.expected_approval_revision,
        }
    }

    #[test]
    fn shared_kernel_refuses_autocommit_for_prepare_and_answer_without_row_changes() {
        let harness = Harness::new("kernel-autocommit");
        let service = harness.service();
        let conn = service.writer().unwrap();
        assert!(conn.is_autocommit());
        let refusal = super::super::effect_kernel::prepare_rows(
            &conn, &service, &harness.subject().scope, harness.request("outside-tx", "outside"),
        ).unwrap_err();
        assert_eq!(refusal.code, ActionErrorCode::Unavailable);
        assert!(harness.raw_action_rows().is_empty());
        let prepared = harness.prepare("seed-approved", "seed").unwrap();
        let before = harness.raw_action_rows();
        let refusal = super::super::effect_kernel::answer_rows(
            &conn, &service, kernel_decision(&harness, &prepared.effect.invocation_id),
        ).unwrap_err();
        assert_eq!(refusal.code, ActionErrorCode::Unavailable);
        assert_eq!(harness.raw_action_rows(), before);
    }

    #[test]
    fn shared_kernel_prepare_uses_the_callers_transaction_and_outer_rollback_removes_all_rows() {
        let harness = Harness::new("kernel-prepare-rollback");
        let service = harness.service();
        let mut conn = service.writer().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        let prepared = super::super::effect_kernel::prepare_rows(
            &tx, &service, &harness.subject().scope, harness.request("held-prepare", "held"),
        ).expect("prepare rows inside the caller transaction");
        assert!(prepared.inserted);
        assert_eq!(prepared.prepared.effect.state, InvocationState::AwaitingApproval);
        assert!(!tx.is_autocommit(), "kernel cannot commit the caller's transaction");
        assert_eq!(tx.query_row("SELECT count(*) FROM action_invocations", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(tx.query_row("SELECT count(*) FROM action_approvals", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(tx.query_row("SELECT count(*) FROM action_attempts", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert!(harness.raw_action_rows().is_empty(), "another connection sees no uncommitted prepare");
        tx.rollback().unwrap();
        assert!(harness.raw_action_rows().is_empty());
    }

    #[test]
    fn shared_kernel_answer_is_visible_only_inside_the_outer_transaction_until_commit() {
        let harness = Harness::new("kernel-answer-rollback");
        let service = harness.service();
        let prepared = harness.prepare("answer-original", "original").unwrap();
        let id = prepared.effect.invocation_id;
        let person = kernel_decision(&harness, &id);
        let before = harness.raw_action_rows();
        let mut conn = service.writer().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        let effect = super::super::effect_kernel::answer_rows(&tx, &service, person)
            .expect("answer rows inside the caller transaction");
        assert_eq!(effect.state, InvocationState::Ready);
        assert!(!tx.is_autocommit(), "kernel cannot commit the caller's transaction");
        let inside = service.load(&tx, &id).unwrap();
        assert_eq!(inside.details.effect.state, InvocationState::Ready);
        assert!(inside.approval.as_ref().unwrap().view.approved_input_digest.is_some());
        assert_eq!(harness.raw_action_rows(), before, "another connection still sees the original waiting approval");
        tx.rollback().unwrap();
        assert_eq!(harness.raw_action_rows(), before);
    }

    #[test]
    fn existing_prepare_wrapper_dispatches_through_the_shared_kernel() {
        let harness = Harness::new("kernel-wrapper-prepare");
        super::super::effect_kernel::test_probe::reset();
        let prepared = harness.prepare("wrapper-prepare", "prepared once").unwrap();
        assert_eq!(super::super::effect_kernel::test_probe::counts(), (1, 0));
        assert_eq!(prepared.effect.state, InvocationState::AwaitingApproval);
        assert!(!harness.raw_action_rows().is_empty());
    }

    #[test]
    fn existing_answer_wrapper_dispatches_through_the_shared_kernel() {
        let harness = Harness::new("kernel-wrapper-answer");
        let prepared = harness.prepare("wrapper-answer", "original").unwrap();
        let person = harness.decision(&prepared.effect.invocation_id, true, None);
        super::super::effect_kernel::test_probe::reset();
        let effect = harness.service().answer(person).unwrap();
        assert_eq!(super::super::effect_kernel::test_probe::counts(), (0, 1));
        assert_eq!(effect.state, InvocationState::Ready);
        assert_eq!(harness.details(&effect.invocation_id).effect.state, InvocationState::Ready);
    }


    fn check_claim_commit_refusal(case: &str) {
        use super::super::effect_kernel::{claim_rows, ClaimDisposition};
        for commit in [false, true] {
            let h = Harness::new(&format!("kernel-claim-{case}-{commit}"));
            let p = h.prepare("request", "first").unwrap();
            let id = p.effect.invocation_id;
            h.allow(&id).unwrap();
            let service = h.service();
            let ready = service.load(&service.writer().unwrap(), &id).unwrap();
            let owner = service.submission_owner(&ready).unwrap().unwrap();
            service.require_owner(&id, &owner).unwrap();
            match case {
                "cancel" => { h.cancel(&id).unwrap(); }
                "authority" => h.change_authority("revocation"),
                "approval" => h.expire_id(&id),
                _ => unreachable!(),
            }
            let before = h.raw_action_rows();
            let original = service.load(&service.writer().unwrap(), &id).unwrap();
            assert_eq!(original.details.effect.state, InvocationState::Ready);
            let mut conn = service.writer().unwrap();
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            let outcome = claim_rows(&tx, &service, &id).expect("changed refusal is a transaction value");
            let ClaimDisposition::CommitRefusal(refusal) = outcome else { panic!("refused claim cannot submit") };
            assert_eq!(refusal.code, ActionErrorCode::Denied);
            assert_eq!(refusal.retry_disposition, if case == "cancel" { RetryDisposition::Never } else { RetryDisposition::Refresh });
            let changed = service.load(&tx, &id).unwrap();
            assert_eq!(changed.details.effect.state, if case == "cancel" { InvocationState::Cancelled } else { InvocationState::AwaitingApproval });
            assert_eq!(changed.revision(), original.revision() + 1);
            assert!(changed.approval.as_ref().unwrap().retired);
            assert!(changed.details.effect.approval_id.is_none());
            assert_eq!(tx.query_row("SELECT count(*) FROM action_attempts", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            assert!(!tx.is_autocommit());
            assert_eq!(h.raw_action_rows(), before, "kernel cannot publish its own refusal");
            if commit {
                tx.commit().unwrap();
                let persisted = service.load(&service.writer().unwrap(), &id).unwrap();
                assert_eq!(persisted.details.effect.state, changed.details.effect.state);
                assert_eq!(persisted.revision(), changed.revision());
                assert!(persisted.approval.unwrap().retired);
            } else {
                tx.rollback().unwrap();
                assert_eq!(h.raw_action_rows(), before, "caller rollback restores every refusal row");
            }
            assert_eq!(h.attempts(), 0);
            assert_eq!(h.submissions(), 0);
        }
    }

    #[test]
    fn shared_claim_kernel_cancellation_refusal_commits_only_when_outer_owner_commits() {
        check_claim_commit_refusal("cancel");
    }
    #[test]
    fn shared_claim_kernel_authority_refusal_commits_only_when_outer_owner_commits() {
        check_claim_commit_refusal("authority");
    }
    #[test]
    fn shared_claim_kernel_unusable_approval_refusal_commits_only_when_outer_owner_commits() {
        check_claim_commit_refusal("approval");
    }
    #[test]
    fn shared_claim_kernel_refuses_autocommit_without_consuming_approval_or_attempt() {
        let h = Harness::new("kernel-claim-autocommit");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        let before = h.raw_action_rows();
        let service = h.service();
        let conn = service.writer().unwrap();
        let refusal = super::super::effect_kernel::claim_rows(&conn, &service, &p.effect.invocation_id).unwrap_err();
        assert_eq!(refusal.code, ActionErrorCode::Unavailable);
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn shared_claim_kernel_success_is_rolled_back_with_its_attempt_and_consumed_approval() {
        let h = Harness::new("kernel-claim-rollback");
        let p = h.prepare("request", "first").unwrap();
        let id = p.effect.invocation_id;
        h.allow(&id).unwrap();
        let before = h.raw_action_rows();
        let service = h.service();
        let record = service.load(&service.writer().unwrap(), &id).unwrap();
        let owner = service.submission_owner(&record).unwrap().unwrap();
        service.require_owner(&id, &owner).unwrap();
        let mut conn = service.writer().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        let outcome = super::super::effect_kernel::claim_rows(&tx, &service, &id).expect("claim rows in caller transaction");
        let super::super::effect_kernel::ClaimDisposition::Claimed { attempt_id, canonical_input } = outcome else { panic!("ready approved action must claim") };
        let changed = service.load(&tx, &id).unwrap();
        assert_eq!(canonical_input, record.canonical_input);
        assert_eq!(changed.details.effect.state, InvocationState::Dispatched);
        assert_eq!(changed.details.attempts.last().unwrap().attempt_id, attempt_id);
        assert!(changed.approval.as_ref().unwrap().consumed);
        assert_eq!(tx.query_row("SELECT count(*) FROM action_attempts", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(h.raw_action_rows(), before);
        tx.rollback().unwrap();
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.attempts(), 0);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn shared_claim_kernel_is_used_by_existing_service_claim_wrapper() {
        let h = Harness::new("kernel-original-claim-wrapper");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        let service = h.service();
        let record = service.load(&service.writer().unwrap(), &p.effect.invocation_id).unwrap();
        let owner = service.submission_owner(&record).unwrap().unwrap();
        super::super::effect_kernel::claim_probe::reset();
        service.claim_dispatch(&p.effect.invocation_id, &owner).unwrap();
        assert_eq!(super::super::effect_kernel::claim_probe::count(), 1, "original wrapper must run the shared algorithm");
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 0);
    }

    fn check_cancel_rows_before_dispatch(held: bool) {
        use super::super::effect_kernel::{cancel_rows, SubmissionAccess};
        for commit in [false, true] {
            let h=Harness::new(&format!("kernel-cancel-{held}-{commit}"));
            let p=h.prepare("request","first").unwrap(); let id=p.effect.invocation_id;
            h.allow(&id).unwrap(); let service=h.service();
            let original=service.load(&service.writer().unwrap(),&id).unwrap();
            let owner=service.submission_owner(&original).unwrap().unwrap();
            if held { service.require_owner(&id,&owner).unwrap(); }
            else { assert!(service.submission_owner(&original).unwrap().is_none(),"a separate caller cannot acquire the held lease"); }
            let before=h.raw_action_rows();let mut conn=service.writer().unwrap();
            let outer=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            let result=cancel_rows(&outer,&service,&h.subject().scope,&id,original.revision(),if held{SubmissionAccess::Held}else{SubmissionAccess::Busy}).expect("cancellation rows inside caller transaction");
            assert!(result.record.cancel_requested);assert!(!result.request_provider_cancel);
            assert_eq!(result.record.details.effect.state,if held{InvocationState::Cancelled}else{InvocationState::Ready});
            assert_eq!(result.record.approval.as_ref().unwrap().retired,held);
            assert_eq!(result.record.revision(),original.revision()+1);
            assert_eq!(h.raw_action_rows(),before,"row kernel cannot commit its own cancellation");
            assert_eq!(h.attempts(),0);assert_eq!(h.submissions(),0);
            if commit { outer.commit().unwrap();let stored=service.load(&service.writer().unwrap(),&id).unwrap();assert!(stored.cancel_requested);assert_eq!(stored.details.effect.state,result.record.details.effect.state); }
            else { outer.rollback().unwrap();assert_eq!(h.raw_action_rows(),before); }
        }
    }
    #[test]
    fn shared_cancel_kernel_held_predispatch_cancellation_has_outer_commit_and_rollback_ownership() { check_cancel_rows_before_dispatch(true); }
    #[test]
    fn shared_cancel_kernel_busy_predispatch_records_intent_without_fake_cancellation() { check_cancel_rows_before_dispatch(false); }
    #[test]
    fn shared_cancel_kernel_dispatched_intent_returns_only_postcommit_provider_work() {
        use super::super::effect_kernel::{cancel_rows,SubmissionAccess};
        let h=Harness::new("kernel-cancel-dispatched");let p=h.prepare("request","first").unwrap();let id=p.effect.invocation_id;
        h.allow(&id).unwrap();h.claim_without_receipt(&id);let service=h.service();
        let original=service.load(&service.writer().unwrap(),&id).unwrap();let owner=service.submission_owner(&original).unwrap().unwrap();service.require_owner(&id,&owner).unwrap();
        let before=h.raw_action_rows();let mut conn=service.writer().unwrap();let outer=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        let result=cancel_rows(&outer,&service,&h.subject().scope,&id,original.revision(),SubmissionAccess::Held).expect("persist intent only");
        assert!(result.request_provider_cancel);assert!(result.record.cancel_requested);assert_eq!(result.record.details.effect.state,InvocationState::Dispatched);
        assert_eq!(result.record.details.attempts.len(),1);assert!(result.record.details.attempts.last().unwrap().receipt_id.is_none());assert_eq!(h.submissions(),0);
        assert_eq!(h.raw_action_rows(),before);outer.rollback().unwrap();assert_eq!(h.raw_action_rows(),before);
    }
    #[test]
    fn shared_cancel_kernel_refuses_autocommit_without_mutating_intent_or_lease() {
        let h=Harness::new("kernel-cancel-no-tx");let p=h.prepare("request","first").unwrap();let service=h.service();let before=h.raw_action_rows();let conn=service.writer().unwrap();
        let error=super::super::effect_kernel::cancel_rows(&conn,&service,&h.subject().scope,&p.effect.invocation_id,1,super::super::effect_kernel::SubmissionAccess::Held).err().expect("autocommit refused");
        assert_eq!(error.code,ActionErrorCode::Unavailable);assert_eq!(h.raw_action_rows(),before);assert_eq!(h.submissions(),0);
    }
    #[test]
    fn shared_cancel_kernel_is_used_by_existing_service_wrapper() {
        let h=Harness::new("kernel-cancel-wrapper");let p=h.prepare("request","first").unwrap();
        super::super::effect_kernel::cancel_probe::reset();assert_eq!(h.cancel(&p.effect.invocation_id).unwrap().state,InvocationState::Cancelled);
        assert_eq!(super::super::effect_kernel::cancel_probe::count(),1,"existing wrapper must delegate durable mutations");assert_eq!(h.submissions(),0);
    }
}
