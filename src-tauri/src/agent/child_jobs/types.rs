use serde::Deserialize;

// Intentionally no Serialize or Debug: objective/evidence are transient inputs,
// not a durable job record or safe log/IPC projection.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildJobSpec {
    pub parent_run_id: String,
    pub parent_attempt_id: String,
    pub objective: String,
    pub instruction_source_version: String,
    pub input_evidence_refs: Vec<EvidenceRef>,
    pub result_schema_id: String,
    pub requested_grant: RequestedReadGrant,
    pub budget: JobBudget,
    pub deadline_at: u64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvidenceRef {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestedReadGrant {
    pub read_scope: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobBudget {
    pub elapsed_seconds: u32,
    pub result_bytes: u32,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SpecRefusal {
    PolicyUnavailable,
    #[cfg(test)]
    Malformed,
    TooLarge,
    InvalidIdentity,
    InvalidObjective,
    InvalidEvidence,
    InvalidScope,
    InvalidSchema,
    InvalidBudget,
    InvalidDeadline,
}
impl ChildJobSpec {
    #[cfg(test)]
    pub(crate) fn decode(input: &[u8], now: u64) -> Result<Self, SpecRefusal> {
        let limits = super::limits::load().map_err(|_| SpecRefusal::PolicyUnavailable)?;
        if input.len() > limits.max_spec_bytes {
            return Err(SpecRefusal::TooLarge);
        }
        let spec: Self = serde_json::from_slice(input).map_err(|_| SpecRefusal::Malformed)?;
        spec.validate_with(&limits, now)?;
        Ok(spec)
    }
    #[cfg(test)]
    pub(super) fn validate(&self, now: u64) -> Result<(), SpecRefusal> {
        let limits = super::limits::load().map_err(|_| SpecRefusal::PolicyUnavailable)?;
        self.validate_with(&limits, now)
    }
    #[cfg(test)]
    fn validate_with(&self, limits: &super::limits::Limits, now: u64) -> Result<(), SpecRefusal> {
        self.validate_shape_with(limits)?;
        self.validate_new_deadline(now)
    }
    // The private typed reservation kernel validates bounds before hashing,
    // then looks up an existing mapping before applying fresh-deadline rules.
    // Existing public decode/validate retain their fresh-candidate behavior.
    pub(crate) fn validate_intrinsic(&self) -> Result<(), SpecRefusal> {
        let limits = super::limits::load().map_err(|_| SpecRefusal::PolicyUnavailable)?;
        self.validate_shape_with(&limits)
    }
    pub(crate) fn validate_new_deadline(&self, now: u64) -> Result<(), SpecRefusal> {
        if self.deadline_at.checked_sub(now).is_none_or(|remaining| {
            remaining == 0 || remaining > u64::from(self.budget.elapsed_seconds)
        }) {
            return Err(SpecRefusal::InvalidDeadline);
        }
        Ok(())
    }
    fn validate_shape_with(&self, limits: &super::limits::Limits) -> Result<(), SpecRefusal> {
        if !identity(&self.parent_run_id, limits.max_identity_bytes)
            || !identity(&self.parent_attempt_id, limits.max_identity_bytes)
            || !digest(&self.instruction_source_version)
        {
            return Err(SpecRefusal::InvalidIdentity);
        }
        if self.objective.trim().is_empty()
            || self.objective.len() > limits.max_objective_bytes
            || self
                .objective
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        {
            return Err(SpecRefusal::InvalidObjective);
        }
        if self.input_evidence_refs.len() > limits.max_evidence_refs
            || self.input_evidence_refs.iter().any(|reference| {
                !relative_path(&reference.path, limits.max_path_bytes) || !digest(&reference.sha256)
            })
        {
            return Err(SpecRefusal::InvalidEvidence);
        }
        // The encoded input has a total byte cap. In-memory fixtures use the
        // same lexical checks and a bounded total too, without serialization of
        // prompt/evidence content or a second permission evaluator.
        if self.requested_grant.read_scope.is_empty()
            || self.requested_grant.read_scope.len() > limits.max_spec_bytes
            || self
                .requested_grant
                .read_scope
                .iter()
                .any(|path| !relative_path(path, limits.max_path_bytes))
        {
            return Err(SpecRefusal::InvalidScope);
        }
        if !super::limits::schema_allowed(&self.result_schema_id)
            .map_err(|_| SpecRefusal::PolicyUnavailable)?
        {
            return Err(SpecRefusal::InvalidSchema);
        }
        if self.budget.elapsed_seconds == 0
            || u64::from(self.budget.elapsed_seconds) > limits.max_elapsed_seconds
            || self.budget.result_bytes == 0
            || usize::try_from(self.budget.result_bytes)
                .map_or(true, |bytes| bytes > limits.max_result_bytes)
        {
            return Err(SpecRefusal::InvalidBudget);
        }
        if self.deadline_at == 0 || self.deadline_at > 9_007_199_254_740_991 {
            return Err(SpecRefusal::InvalidDeadline);
        }
        let mut total = 0_usize;
        for text in [
            self.parent_run_id.as_str(),
            self.parent_attempt_id.as_str(),
            self.objective.as_str(),
            self.instruction_source_version.as_str(),
            self.result_schema_id.as_str(),
        ]
        .into_iter()
        .chain(
            self.input_evidence_refs
                .iter()
                .flat_map(|reference| [reference.path.as_str(), reference.sha256.as_str()]),
        )
        .chain(self.requested_grant.read_scope.iter().map(String::as_str))
        {
            total = total.checked_add(text.len()).ok_or(SpecRefusal::TooLarge)?;
            if total > limits.max_spec_bytes {
                return Err(SpecRefusal::TooLarge);
            }
        }
        Ok(())
    }
}
fn identity(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
fn relative_path(path: &str, max: usize) -> bool {
    !path.is_empty()
        && path.len() <= max
        && path.trim() == path
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
