//! Exact private persisted action codec shared with the test-only mutation service.
use super::schema::digest;
use super::{effect_types::*, schema};
use serde::{Deserialize, Serialize};
// `input` is raw JSON text, never already parsed JS numbers or caller authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PrepareAction {
    pub(super) action_id: ActionId,
    pub(super) definition_digest: DefinitionDigest,
    pub(super) connection_id: ConnectionId,
    pub(super) account_id: AccountId,
    pub(super) snapshot_digest: SnapshotDigest,
    pub(super) input: String,
    pub(super) request_key: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Binding {
    pub account_id: AccountId,
    pub account_identity_digest: String,
    pub account_revision: u64,
    pub account_label: String,
    pub grant_digest: String,
    pub policy_digest: String,
    pub revocation_generation: u64,
    pub snapshot_digest: SnapshotDigest,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct AdapterTarget {
    pub conflict_domain: String,
    pub target: EffectTarget,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ApprovalDecision {
    Allow,
    Deny,
    Edited,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RetryDecisionReceipt {
    pub(super) person_id: String,
    pub(super) acknowledged_at: String,
    pub(super) prior_revision: u64,
    pub(super) prior_attempt_id: AttemptId,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ActionApproval {
    pub(super) decided_by: Option<String>,
    pub(super) decided_at: Option<String>,
    pub(super) decision: Option<ApprovalDecision>,
    pub(super) view: EffectApproval,
    pub(super) approved_input: Option<String>,
    pub(super) consumed: bool,
    pub(super) retired: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ActionInvocation {
    // Private persistence format, independent of the transport DTO declarations.
    // Missing means the unversioned object encoding used before native activation.
    #[serde(default)]
    pub(super) lookup_version: u8,
    pub(super) scope: ActionSubjectView,
    pub(super) request: PrepareAction,
    pub(super) request_digest: String,
    pub(super) definition: ActionDefinition,
    pub(super) binding: Binding,
    pub(super) target: AdapterTarget,
    pub(super) canonical_input: String,
    pub(super) fence: Option<String>,
    pub(super) details: ActionEffectDetails,
    pub(super) approval: Option<ActionApproval>,
    pub(super) cancel_requested: bool,
    #[serde(default)]
    pub(super) retry_decisions: Vec<RetryDecisionReceipt>,
}
impl ActionInvocation {
    pub(super) fn check_lookup_version(&self) -> Result<(), ActionError> {
        match self.lookup_version {
            0..=1 => Ok(()),
            _ => Err(unavailable()),
        }
    }
    pub(super) fn authority_request(&self) -> PrepareAction {
        let mut request = self.request.clone();
        request.input = self.canonical_input.clone();
        request
    }
    pub(super) fn revision(&self) -> u64 {
        self.details.revision.get()
    }
    pub(super) fn bump(&mut self) -> Result<(), ActionError> {
        self.details.revision = self.details.revision.next()?;
        Ok(())
    }
    pub(super) fn refresh(&mut self) {
        self.details.approval = self
            .approval
            .as_ref()
            .filter(|a| !a.retired)
            .map(|a| a.view.clone());
        self.details.effect.approval_id = self
            .approval
            .as_ref()
            .filter(|a| !a.retired)
            .map(|a| a.view.approval_id.clone());
        self.details.effect.can_reconcile = self.definition.reconcile
            && matches!(
                self.details.effect.state,
                InvocationState::Dispatched | InvocationState::OutcomeUnknown
            );
        // Unknown effects cannot acquire another attempt without an adapter
        // proving safe idempotency. That adapter admission is not active yet.
        self.details.effect.can_retry = self.details.effect.state == InvocationState::Failed
            && self.definition.retry == RetryContract::Idempotent;
    }
}
// Persistence v1: domain-tagged tuple slots are frozen independently of DTO
// field order. V34 retains exactly 64 lowercase hex in its indexed columns;
// the version is in these bytes and ActionInvocation.lookup_version instead.
pub(super) fn scope_key(scope: &ActionSubjectView) -> Result<String, ActionError> {
    Ok(digest(
        encode(&(
            "cerebro.action.subject-scope",
            1,
            &scope.vault_id,
            &scope.run_id,
            &scope.actor_id,
            &scope.child_job_id,
            &scope.client_id,
        ))?
        .as_bytes(),
    ))
}
pub(super) fn request_digest(request: &PrepareAction) -> Result<String, ActionError> {
    Ok(digest(
        encode(&(
            "cerebro.action.request",
            1,
            &request.action_id,
            &request.definition_digest,
            &request.connection_id,
            &request.account_id,
            &request.snapshot_digest,
            &request.input,
            &request.request_key,
        ))?
        .as_bytes(),
    ))
}
// Compatibility-only frozen v0 objects. Never substitute the current DTO's
// Serialize implementation here: a transport field reorder must not strand
// an older request key or change its immutable original digest.
pub(super) fn legacy_scope_key(scope: &ActionSubjectView) -> Result<String, ActionError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct V0Scope<'a> {
        vault_id: &'a str,
        run_id: &'a str,
        actor_id: &'a str,
        child_job_id: &'a Option<String>,
        client_id: &'a Option<String>,
    }
    Ok(digest(
        encode(&V0Scope {
            vault_id: &scope.vault_id,
            run_id: &scope.run_id,
            actor_id: &scope.actor_id,
            child_job_id: &scope.child_job_id,
            client_id: &scope.client_id,
        })?
        .as_bytes(),
    ))
}
pub(super) fn legacy_request_digest(request: &PrepareAction) -> Result<String, ActionError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct V0Request<'a> {
        action_id: &'a ActionId,
        definition_digest: &'a DefinitionDigest,
        connection_id: &'a ConnectionId,
        account_id: &'a AccountId,
        snapshot_digest: &'a SnapshotDigest,
        input: &'a str,
        request_key: &'a str,
    }
    Ok(digest(
        encode(&V0Request {
            action_id: &request.action_id,
            definition_digest: &request.definition_digest,
            connection_id: &request.connection_id,
            account_id: &request.account_id,
            snapshot_digest: &request.snapshot_digest,
            input: &request.input,
            request_key: &request.request_key,
        })?
        .as_bytes(),
    ))
}

fn unavailable() -> ActionError {
    error(
        ActionErrorCode::Unavailable,
        "Action storage is unavailable.",
    )
}
fn encode<T: Serialize>(value: &T) -> Result<String, ActionError> {
    serde_json::to_string(value).map_err(|_| unavailable())
}

use super::recovery_read_types::HistoryReason;
use std::collections::BTreeSet;
type Checked<T> = Result<T, HistoryReason>;
fn invalid<T>() -> Checked<T> {
    Err(HistoryReason::InvalidRecord)
}
// Streaming first pass: no Value, arbitrary vector or decoded value-string is
// allocated. Only bounded object keys are retained to reject duplicate names.
#[derive(Clone, Copy)]
enum Place {
    General,
    Definition,
    Request,
    Binding,
    Preview,
    Account,
    Target,
    Attempt,
    Redaction,
}
struct Scan<'a> {
    text: &'a str,
    at: usize,
    nodes: usize,
}
impl Scan<'_> {
    fn byte(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }
    fn ws(&mut self) {
        while self
            .byte()
            .is_some_and(|v| matches!(v, b' ' | b'\n' | b'\r' | b'\t'))
        {
            self.at += 1;
        }
    }
    fn take(&mut self, b: u8) -> bool {
        self.ws();
        if self.byte() == Some(b) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn hex(&mut self) -> Checked<u16> {
        let end = self.at.checked_add(4).ok_or(HistoryReason::InvalidRecord)?;
        let bytes = self
            .text
            .as_bytes()
            .get(self.at..end)
            .ok_or(HistoryReason::InvalidRecord)?;
        let mut n = 0;
        for b in bytes {
            n = n * 16
                + match b {
                    b'0'..=b'9' => (b - b'0') as u16,
                    b'a'..=b'f' => (b - b'a' + 10) as u16,
                    b'A'..=b'F' => (b - b'A' + 10) as u16,
                    _ => return invalid(),
                };
        }
        self.at = end;
        Ok(n)
    }
    fn string(&mut self, cap: usize) -> Checked<&str> {
        self.ws();
        let start = self.at;
        if !self.take(b'"') {
            return invalid();
        }
        let mut decoded = 0usize;
        loop {
            let b = self.byte().ok_or(HistoryReason::InvalidRecord)?;
            self.at += 1;
            let width = match b {
                b'"' => return Ok(&self.text[start..self.at]),
                0..=31 => return invalid(),
                b'\\' => {
                    let escape = self.byte().ok_or(HistoryReason::InvalidRecord)?;
                    self.at += 1;
                    match escape {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => 1,
                        b'u' => {
                            let n = self.hex()?;
                            match n {
                                0xd800..=0xdbff => {
                                    if self.byte() != Some(b'\\')
                                        || self.text.as_bytes().get(self.at + 1) != Some(&b'u')
                                    {
                                        return invalid();
                                    }
                                    self.at += 2;
                                    let low = self.hex()?;
                                    if !(0xdc00..=0xdfff).contains(&low) {
                                        return invalid();
                                    }
                                    4
                                }
                                0xdc00..=0xdfff => return invalid(),
                                0..=0x7f => 1,
                                0x80..=0x7ff => 2,
                                _ => 3,
                            }
                        }
                        _ => return invalid(),
                    }
                }
                _ => 1,
            };
            decoded = decoded
                .checked_add(width)
                .ok_or(HistoryReason::InvalidRecord)?;
            if decoded > cap {
                return invalid();
            }
        }
    }
    fn node(
        &mut self,
        depth: usize,
        place: Place,
        string_cap: usize,
        array_cap: usize,
    ) -> Checked<()> {
        let l = schema::history_limits();
        if depth > l.max_depth || self.nodes >= l.max_nodes {
            return invalid();
        }
        self.nodes += 1;
        self.ws();
        match self.byte() {
            Some(b'"') => {
                self.string(string_cap)?;
            }
            Some(b'{') => {
                self.at += 1;
                let mut keys = BTreeSet::new();
                if self.take(b'}') {
                    return Ok(());
                }
                loop {
                    if keys.len() >= l.max_object_keys {
                        return invalid();
                    }
                    let raw = self.string(l.max_string_bytes)?;
                    let key: String =
                        serde_json::from_str(raw).map_err(|_| HistoryReason::InvalidRecord)?;
                    if keys.contains(&key) || !self.take(b':') {
                        return invalid();
                    }
                    let (child, sc, ac) = field(place, &key);
                    keys.insert(key);
                    self.node(depth + 1, child, sc, ac)?;
                    if self.take(b'}') {
                        break;
                    }
                    if !self.take(b',') {
                        return invalid();
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut count = 0;
                if self.take(b']') {
                    return Ok(());
                }
                loop {
                    if count >= array_cap {
                        return invalid();
                    }
                    self.node(depth + 1, place, string_cap, l.max_array_items)?;
                    count += 1;
                    if self.take(b']') {
                        break;
                    }
                    if !self.take(b',') {
                        return invalid();
                    }
                }
            }
            Some(b'n') if self.text[self.at..].starts_with("null") => self.at += 4,
            Some(b't') if self.text[self.at..].starts_with("true") => self.at += 4,
            Some(b'f') if self.text[self.at..].starts_with("false") => self.at += 5,
            Some(b'-' | b'0'..=b'9') => {
                let start = self.at;
                while self
                    .byte()
                    .is_some_and(|v| matches!(v, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
                {
                    if self.at - start >= schema::limits().number_bytes {
                        return invalid();
                    }
                    self.at += 1;
                }
                // Validate grammar without any floating-point conversion.
                let raw = &self.text[start..self.at];
                serde_json::from_str::<&serde_json::value::RawValue>(raw)
                    .map_err(|_| HistoryReason::InvalidRecord)?;
            }
            _ => return invalid(),
        }
        Ok(())
    }
}
fn field(parent: Place, key: &str) -> (Place, usize, usize) {
    let l = schema::history_limits();
    let mut place = Place::General;
    let mut cap = l.max_string_bytes;
    let mut array = l.max_array_items;
    match key {
        "definition" => place = Place::Definition,
        "request" => place = Place::Request,
        "binding" => place = Place::Binding,
        "preview" | "approvedPreview" => place = Place::Preview,
        "account" => place = Place::Account,
        "target" => place = Place::Target,
        "attempts" => {
            place = Place::Attempt;
            array = l.max_attempts;
        }
        "retry_decisions" => array = l.max_retry_decisions,
        "fields" => {
            place = Place::Preview;
            array = l.max_preview_fields;
        }
        "redactedFields" => {
            place = Place::Redaction;
            array = l.max_redacted_fields;
            cap = l.max_preview_label_bytes;
        }
        "invocationId" | "approvalId" | "attemptId" | "receiptId" | "actionId" | "connectionId"
        | "accountId" | "vaultId" | "runId" | "actorId" | "childJobId" | "clientId"
        | "account_id" | "person_id" | "decided_by" | "prior_attempt_id" => cap = l.max_id_bytes,
        "requestKey" => cap = 256,
        "requiredCapabilities" => {
            cap = schema::limits().string_bytes;
            array = schema::limits().array_items;
        }
        "adapterRevision" => cap = schema::limits().string_bytes,
        "definitionDigest"
        | "snapshotDigest"
        | "inputDigest"
        | "inputSchemaDigest"
        | "outputSchemaDigest"
        | "askedInputDigest"
        | "approvedInputDigest"
        | "account_identity_digest"
        | "grant_digest"
        | "policy_digest"
        | "snapshot_digest"
        | "request_digest"
        | "fence" => cap = 64,
        "canonical_input" | "approved_input" => cap = schema::limits().input_bytes,
        "input" if matches!(parent, Place::Request) => cap = schema::limits().input_bytes,
        "inputSchema" | "outputSchema" if matches!(parent, Place::Definition) => {
            cap = schema::limits().schema_bytes
        }
        "summary" if matches!(parent, Place::Preview) => cap = l.max_preview_summary_bytes,
        "kind" | "conflict_domain" if matches!(parent, Place::Target) => cap = 512,
        "label" => {
            cap = if matches!(parent, Place::Account | Place::Target) {
                l.max_account_label_bytes
            } else {
                l.max_preview_label_bytes
            }
        }
        "value" if matches!(parent, Place::Preview) => cap = l.max_preview_value_bytes,
        "account_label" | "accountLabel" => cap = l.max_account_label_bytes,
        "safeReference" | "remoteEffectReference" => cap = l.max_target_reference_bytes,
        "outcomeSummary" => cap = l.max_attempt_summary_bytes,
        "dispatchedAt" | "observedAt" | "expiresAt" | "decided_at" | "acknowledged_at" => {
            cap = l.max_timestamp_bytes
        }
        _ => {}
    }
    (place, cap, array)
}
pub(super) fn structural_check(raw: &str) -> Checked<()> {
    let l = schema::history_limits();
    if raw.len() > l.max_stored_payload_bytes {
        return Err(HistoryReason::StoredPayloadLimit);
    }
    let mut scan = Scan {
        text: raw,
        at: 0,
        nodes: 0,
    };
    scan.node(0, Place::General, l.max_string_bytes, l.max_array_items)?;
    scan.ws();
    if scan.at != raw.len() {
        return invalid();
    }
    Ok(())
}
pub(super) fn hex_id(value: &str, bytes: usize) -> bool {
    value.len() == bytes
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max
}
pub(super) fn timestamp(value: &str) -> Checked<chrono::DateTime<chrono::FixedOffset>> {
    if value.len() > schema::history_limits().max_timestamp_bytes {
        return invalid();
    }
    let stamp =
        chrono::DateTime::parse_from_rfc3339(value).map_err(|_| HistoryReason::InvalidRecord)?;
    if stamp.offset().local_minus_utc() != 0 {
        return invalid();
    }
    Ok(stamp)
}
fn nullable_stamp(value: &Option<String>) -> Checked<()> {
    if let Some(value) = value {
        timestamp(value)?;
    }
    Ok(())
}
fn approval(view: &EffectApproval) -> Checked<()> {
    if !hex_id(&view.approval_id.0, 32)
        || view.revision.get() == 0
        || !hex_id(&view.asked_input_digest, 64)
        || view
            .approved_input_digest
            .as_ref()
            .is_some_and(|s| !hex_id(s, 64))
    {
        return invalid();
    }
    timestamp(&view.expires_at)?;
    Ok(())
}
pub(super) fn decode_history(raw: &str) -> Checked<ActionInvocation> {
    structural_check(raw)?;
    let record: ActionInvocation =
        serde_json::from_str(raw).map_err(|_| HistoryReason::InvalidRecord)?;
    record
        .check_lookup_version()
        .map_err(|_| HistoryReason::InvalidRecord)?;
    let l = schema::history_limits();
    let d = &record.details;
    let r = &record.request;
    let b = &record.binding;
    let valid_target_text = |value: &str| !value.is_empty() && !value.chars().any(char::is_control);
    if !valid_target_text(&record.target.conflict_domain)
        || std::iter::once(&record.target.target)
            .chain(d.target.iter())
            .any(|target| {
                [&target.kind, &target.label, &target.safe_reference]
                    .into_iter()
                    .any(|value| !valid_target_text(value))
            })
    {
        return invalid();
    }
    if !hex_id(&d.effect.invocation_id.0, 32)
        || d.revision.get() == 0
        || !hex_id(&record.request_digest, 64)
        || !hex_id(&d.definition_digest.0, 64)
        || !hex_id(&d.input_digest, 64)
        || !hex_id(&r.definition_digest.0, 64)
        || !hex_id(&r.snapshot_digest.0, 64)
        || !hex_id(&b.account_identity_digest, 64)
        || !hex_id(&b.grant_digest, 64)
        || !hex_id(&b.policy_digest, 64)
        || !hex_id(&b.snapshot_digest.0, 64)
        || b.account_revision == 0
        || SafeCounter::new(b.account_revision).is_err()
        || SafeCounter::new(b.revocation_generation).is_err()
        || ![
            &r.connection_id.0,
            &r.account_id.0,
            &b.account_id.0,
            &record.scope.run_id,
            &record.scope.vault_id,
            &record.scope.actor_id,
        ]
        .iter()
        .all(|s| text(s, l.max_id_bytes))
        || !text(&r.request_key, 256)
        || !text(&b.account_label, l.max_account_label_bytes)
        || b.account_label.chars().any(char::is_control)
        || record.fence.as_ref().is_some_and(|s| !hex_id(s, 64))
        || d.effect
            .approval_id
            .as_ref()
            .is_some_and(|id| !hex_id(&id.0, 32))
        || d.account.as_ref().is_some_and(|a| {
            !text(&a.account_id.0, l.max_id_bytes) || a.account_revision.get() == 0
        })
    {
        return invalid();
    }
    let expected = if record.lookup_version == 0 {
        legacy_request_digest(r)
    } else {
        request_digest(r)
    }
    .map_err(|_| HistoryReason::InvalidRecord)?;
    if expected != record.request_digest
        || r.definition_digest != record.definition.definition_digest
        || d.definition_digest != record.definition.definition_digest
        || r.action_id != record.definition.action_id
        || r.snapshot_digest != b.snapshot_digest
    {
        return invalid();
    }
    let material = DefinitionMaterial {
        action_id: record.definition.action_id.clone(),
        input_schema: record.definition.input_schema.clone(),
        output_schema: record.definition.output_schema.clone(),
        adapter_revision: record.definition.adapter_revision.clone(),
        effect_class: record.definition.effect_class,
        required_capabilities: record.definition.required_capabilities.clone(),
        retry: record.definition.retry,
        cancel: record.definition.cancel,
        reconcile: record.definition.reconcile,
        secret_input_fields: vec![],
    };
    let definition = super::catalog::ActionCatalog::default()
        .insert(material, "{}")
        .map_err(|_| HistoryReason::InvalidRecord)?;
    if definition != record.definition {
        return invalid();
    }
    let asked = schema::validate_input(&record.definition, &r.input)
        .map_err(|_| HistoryReason::InvalidRecord)?;
    let canonical = schema::validate_input(&record.definition, &record.canonical_input)
        .map_err(|_| HistoryReason::InvalidRecord)?;
    if canonical.digest != d.input_digest {
        return invalid();
    }
    if let Some(a) = &record.approval {
        approval(&a.view)?;
        nullable_stamp(&a.decided_at)?;
        match (&a.approved_input, &a.view.approved_input_digest) {
            (Some(input), Some(digest)) => {
                if schema::validate_input(&record.definition, input)
                    .map_err(|_| HistoryReason::InvalidRecord)?
                    .digest
                    != *digest
                {
                    return invalid();
                }
            }
            (None, None) => {}
            _ => return invalid(),
        }
    } else if asked.digest != d.input_digest {
        return invalid();
    }
    if let Some(a) = &d.approval {
        approval(a)?;
    }
    let expected_approval = record
        .approval
        .as_ref()
        .filter(|a| !a.retired)
        .map(|a| &a.view);
    if d.approval.as_ref() != expected_approval
        || d.effect.approval_id.as_ref() != expected_approval.map(|a| &a.approval_id)
    {
        return invalid();
    }
    let mut ids = BTreeSet::new();
    let mut last = 0;
    for attempt in &d.attempts {
        if !hex_id(&attempt.attempt_id.0, 32)
            || !ids.insert(&attempt.attempt_id.0)
            || attempt.ordinal.get() <= last
            || attempt
                .receipt_id
                .as_ref()
                .is_some_and(|s| !text(s, l.max_id_bytes))
        {
            return invalid();
        }
        last = attempt.ordinal.get();
        nullable_stamp(&attempt.dispatched_at)?;
        nullable_stamp(&attempt.observed_at)?;
    }
    for decision in &record.retry_decisions {
        if decision.prior_revision == 0
            || SafeCounter::new(decision.prior_revision).is_err()
            || !hex_id(&decision.prior_attempt_id.0, 32)
            || !text(&decision.person_id, l.max_id_bytes)
        {
            return invalid();
        }
        timestamp(&decision.acknowledged_at)?;
    }
    Ok(record)
}
// Counts serialized UTF-8 (including escapes) before any output allocation.
pub(super) fn serialized_size<T: Serialize>(
    value: &T,
    maximum: usize,
) -> Result<usize, HistoryReason> {
    struct Count {
        used: usize,
        max: usize,
    }
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.used = self
                .used
                .checked_add(bytes.len())
                .filter(|n| *n <= self.max)
                .ok_or_else(|| std::io::Error::other("bounded history output"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count {
        used: 0,
        max: maximum,
    };
    serde_json::to_writer(&mut count, value).map_err(|_| HistoryReason::OutputLimit)?;
    Ok(count.used)
}
#[cfg(test)]
#[path = "effect_record_tests.rs"]
pub(super) mod tests;
