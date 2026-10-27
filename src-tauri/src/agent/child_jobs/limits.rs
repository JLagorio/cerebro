// Pure candidate rule evaluation only. Observations do not establish a native
// parent/session or reserve a slot. No counter/book/scheduler is created here.
use serde::Deserialize;
use std::sync::OnceLock;

pub(super) const POLICY_JSON: &str =
    include_str!("../../../../shared/policy/supervised-jobs.v1.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Limits {
    pub max_depth: u32,
    pub max_concurrent: u32,
    pub max_admissions: u32,
    pub max_elapsed_seconds: u64,
    pub max_result_bytes: usize,
    pub max_spec_bytes: usize,
    pub max_objective_bytes: usize,
    pub max_evidence_refs: usize,
    pub max_path_bytes: usize,
    pub max_identity_bytes: usize,
    pub max_evidence_file_bytes: u64,
    pub max_evidence_total_bytes: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LimitRefusal {
    PolicyUnavailable,
    #[cfg(any(test, feature = "native-read-smoke"))]
    Depth,
    #[cfg(any(test, feature = "native-read-smoke"))]
    Concurrency,
    #[cfg(any(test, feature = "native-read-smoke"))]
    SessionAdmissions,
    #[cfg(test)]
    Deadline,
    #[cfg(test)]
    ResultTooLarge,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    format: u32,
    limit_source: LimitSource,
    execution: Execution,
    input_bounds: InputBounds,
    result_schema_ids: Vec<String>,
    refusal_destiny: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LimitSource {
    artifact: String,
    depth_env: String,
    concurrent_env: String,
    admissions_env: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Execution {
    read_only: bool,
    desktop_awake_only: bool,
    max_elapsed_seconds: u64,
    max_result_bytes: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputBounds {
    max_spec_bytes: usize,
    max_objective_bytes: usize,
    max_evidence_refs: usize,
    max_path_bytes: usize,
    max_identity_bytes: usize,
    max_evidence_file_bytes: u64,
    max_evidence_total_bytes: u64,
}
struct Loaded {
    limits: Limits,
    #[cfg(any(test, feature = "native-read-smoke"))]
    schema_ids: Vec<String>,
}
fn positive_env(name: &str) -> Result<u32, LimitRefusal> {
    crate::policy::subagents::table()
        .env
        .get(name)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .ok_or(LimitRefusal::PolicyUnavailable)
}
fn read_policy() -> Result<Loaded, LimitRefusal> {
    parse_policy(POLICY_JSON)
}
fn parse_policy(raw: &str) -> Result<Loaded, LimitRefusal> {
    let policy: Policy = serde_json::from_str(raw).map_err(|_| LimitRefusal::PolicyUnavailable)?;
    let source = &policy.limit_source;
    let bounds = &policy.input_bounds;
    let execution = &policy.execution;
    // These names bind semantic axes, not a second numeric policy table.
    if policy.format != 1
        || source.artifact != crate::policy::subagents::SUBAGENTS_PATH
        || source.depth_env != "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"
        || source.concurrent_env != "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"
        || source.admissions_env != "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"
        || !execution.read_only
        || !execution.desktop_awake_only
        || execution.max_elapsed_seconds == 0
        || execution.max_result_bytes == 0
        || bounds.max_spec_bytes == 0
        || bounds.max_objective_bytes == 0
        || bounds.max_objective_bytes > bounds.max_spec_bytes
        || bounds.max_evidence_refs == 0
        || bounds.max_evidence_refs > bounds.max_spec_bytes
        || bounds.max_path_bytes == 0
        || bounds.max_path_bytes > bounds.max_spec_bytes
        || bounds.max_identity_bytes == 0
        || bounds.max_identity_bytes > bounds.max_spec_bytes
        || bounds.max_evidence_file_bytes == 0
        || bounds.max_evidence_file_bytes > crate::files::bytes::rules().limits.body_bytes
        || bounds.max_evidence_total_bytes < bounds.max_evidence_file_bytes
        || bounds.max_evidence_total_bytes
            > bounds
                .max_evidence_file_bytes
                .saturating_mul(bounds.max_evidence_refs as u64)
        || policy.refusal_destiny != "operational"
        || policy.result_schema_ids.is_empty()
        || policy.result_schema_ids.len() > bounds.max_evidence_refs
        || policy.result_schema_ids.iter().any(|id| {
            id.is_empty()
                || id.len() > bounds.max_identity_bytes
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        })
        || policy
            .result_schema_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != policy.result_schema_ids.len()
    {
        return Err(LimitRefusal::PolicyUnavailable);
    }
    Ok(Loaded {
        limits: Limits {
            max_depth: positive_env(&source.depth_env)?,
            max_concurrent: positive_env(&source.concurrent_env)?,
            max_admissions: positive_env(&source.admissions_env)?,
            max_elapsed_seconds: execution.max_elapsed_seconds,
            max_result_bytes: execution.max_result_bytes,
            max_spec_bytes: bounds.max_spec_bytes,
            max_objective_bytes: bounds.max_objective_bytes,
            max_evidence_refs: bounds.max_evidence_refs,
            max_path_bytes: bounds.max_path_bytes,
            max_identity_bytes: bounds.max_identity_bytes,
            max_evidence_file_bytes: bounds.max_evidence_file_bytes,
            max_evidence_total_bytes: bounds.max_evidence_total_bytes,
        },
        #[cfg(any(test, feature = "native-read-smoke"))]
        schema_ids: policy.result_schema_ids,
    })
}
fn policy() -> Result<&'static Loaded, LimitRefusal> {
    static POLICY: OnceLock<Result<Loaded, LimitRefusal>> = OnceLock::new();
    POLICY
        .get_or_init(read_policy)
        .as_ref()
        .map_err(|error| *error)
}
pub(crate) fn load() -> Result<Limits, LimitRefusal> {
    policy().map(|policy| policy.limits)
}
#[cfg(any(test, feature = "native-read-smoke"))]
pub(super) fn schema_allowed(schema_id: &str) -> Result<bool, LimitRefusal> {
    policy().map(|policy| policy.schema_ids.iter().any(|id| id == schema_id))
}
#[cfg(any(test, feature = "native-read-smoke"))]
pub(crate) fn evaluate_new_admission(
    limits: &Limits,
    parent_depth: u32,
    active_children: u32,
    accepted_children: u32,
) -> Result<(), LimitRefusal> {
    // Compare before adding a child: u32::MAX can never wrap to depth zero.
    if parent_depth >= limits.max_depth {
        return Err(LimitRefusal::Depth);
    }
    if active_children >= limits.max_concurrent {
        return Err(LimitRefusal::Concurrency);
    }
    if accepted_children >= limits.max_admissions {
        return Err(LimitRefusal::SessionAdmissions);
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn check_deadline(deadline: u64, now: u64) -> Result<(), LimitRefusal> {
    if now >= deadline {
        Err(LimitRefusal::Deadline)
    } else {
        Ok(())
    }
}
#[cfg(test)]
pub(crate) fn check_result_length(budget: usize, bytes: usize) -> Result<(), LimitRefusal> {
    if budget == 0 || budget > load()?.max_result_bytes || bytes > budget {
        Err(LimitRefusal::ResultTooLarge)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod freeze_policy_tests {
    use super::*;
    #[test]
    fn m95_freeze_policy_compiled_bytes_match_digest_and_disk() {
        let expected = include_str!("../../../../shared/policy/supervised-jobs.v1.sha256").trim();
        assert_eq!(crate::ledger::sha256_hex(POLICY_JSON.as_bytes()), expected);
        let disk = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../shared/policy/supervised-jobs.v1.json"),
        )
        .unwrap();
        assert_eq!(disk, POLICY_JSON.as_bytes());
    }
    #[test]
    fn m95_freeze_policy_missing_zero_and_inconsistent_evidence_limits_refuse() {
        let original: serde_json::Value = serde_json::from_str(POLICY_JSON).unwrap();
        for field in ["max_evidence_file_bytes", "max_evidence_total_bytes"] {
            let mut value = original.clone();
            value["input_bounds"].as_object_mut().unwrap().remove(field);
            assert_eq!(
                parse_policy(&value.to_string()).err(),
                Some(LimitRefusal::PolicyUnavailable)
            );
            let mut value = original.clone();
            value["input_bounds"][field] = serde_json::json!(0);
            assert_eq!(
                parse_policy(&value.to_string()).err(),
                Some(LimitRefusal::PolicyUnavailable)
            );
        }
        let mut value = original.clone();
        value["input_bounds"]["max_evidence_total_bytes"] = serde_json::json!(1);
        assert_eq!(
            parse_policy(&value.to_string()).err(),
            Some(LimitRefusal::PolicyUnavailable)
        );
        let mut value = original;
        value["input_bounds"]["max_evidence_file_bytes"] =
            serde_json::json!(crate::files::bytes::rules().limits.body_bytes + 1);
        assert_eq!(
            parse_policy(&value.to_string()).err(),
            Some(LimitRefusal::PolicyUnavailable)
        );
    }
    #[test]
    #[ignore = "deliberate shared policy digest regeneration only"]
    fn write_supervised_jobs_digest() {
        std::fs::write(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../shared/policy/supervised-jobs.v1.sha256"),
            format!("{}\n", crate::ledger::sha256_hex(POLICY_JSON.as_bytes())),
        )
        .unwrap();
    }
}
