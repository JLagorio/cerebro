use super::{limits, types::*};
use serde_json::{json, Value};

fn value() -> Value {
    json!({
        "parentRunId":"real-parent-run", "parentAttemptId":"request-correlation-only",
        "objective":"Read the cited page and return bounded evidence.",
        "instructionSourceVersion":"a".repeat(64),
        "inputEvidenceRefs":[{"path":"public/note.md","sha256":"b".repeat(64)}],
        "resultSchemaId":"read_evidence_summary.v1",
        "requestedGrant":{"readScope":["public"]},
        "budget":{"elapsedSeconds":600,"resultBytes":262144},
        "deadlineAt":1600
    })
}
fn decode(v: &Value, now: u64) -> Result<ChildJobSpec, SpecRefusal> {
    ChildJobSpec::decode(&serde_json::to_vec(v).unwrap(), now)
}
fn refusal(v: &Value, expected: SpecRefusal) {
    assert_eq!(decode(v, 1000).err(), Some(expected));
}
#[test]
fn supervised_jobs_spec_accepts_only_bounded_transient_read_request() {
    let spec = decode(&value(), 1000).expect("new bounded spec API remains closed");
    assert_eq!(spec.parent_run_id, "real-parent-run");
    assert_eq!(spec.parent_attempt_id, "request-correlation-only");
    assert_eq!(spec.instruction_source_version, "a".repeat(64));
    assert_eq!(spec.input_evidence_refs[0].path, "public/note.md");
    assert_eq!(spec.input_evidence_refs[0].sha256, "b".repeat(64));
    assert_eq!(spec.requested_grant.read_scope, vec!["public"]);
    assert_eq!(spec.result_schema_id, "read_evidence_summary.v1");
    assert_eq!(spec.budget.elapsed_seconds, 600);
    assert_eq!(spec.budget.result_bytes, 262144);
    assert_eq!(spec.deadline_at, 1600);
    assert!(spec.objective.starts_with("Read "));
    let policy: Value = serde_json::from_str(include_str!(
        "../../../../shared/policy/supervised-jobs.v1.json"
    ))
    .unwrap();
    assert_eq!(policy["execution"]["read_only"], true);
    assert_eq!(policy["execution"]["desktop_awake_only"], true);
}
#[test]
fn supervised_jobs_spec_rejects_unknown_effect_and_account_axes() {
    for patch in ["connectorAccount", "writeScope", "tools", "parentToken"] {
        let mut v = value();
        v["requestedGrant"][patch] = json!("not-permitted");
        refusal(&v, SpecRefusal::Malformed);
    }
    let mut v = value();
    v["execution"] = json!("background");
    refusal(&v, SpecRefusal::Malformed);
    let mut v = value();
    v["budget"]["usd"] = json!(1);
    refusal(&v, SpecRefusal::Malformed);
}
#[test]
fn supervised_jobs_spec_rejects_oversize_before_echoing_inputs() {
    let mut v = value();
    v["objective"] = json!("private-canary".repeat(2000));
    refusal(&v, SpecRefusal::InvalidObjective);
    let mut empty = value();
    empty["objective"] = json!("");
    refusal(&empty, SpecRefusal::InvalidObjective);
    let mut v = value();
    v["extra"] = json!("x".repeat(65536));
    refusal(&v, SpecRefusal::TooLarge);
    assert_eq!(
        ChildJobSpec::decode(b"not-json", 1000).err(),
        Some(SpecRefusal::Malformed)
    );
}
#[test]
fn supervised_jobs_spec_rejects_invalid_identity_evidence_and_scope() {
    for field in ["parentRunId", "parentAttemptId", "instructionSourceVersion"] {
        let mut v = value();
        v[field] = json!("");
        refusal(&v, SpecRefusal::InvalidIdentity);
    }
    for identity in ["x".repeat(129), "invalid\nidentity".into()] {
        let mut v = value();
        v["parentAttemptId"] = json!(identity);
        refusal(&v, SpecRefusal::InvalidIdentity);
    }
    for path in [
        "../private.md",
        "/outside.md",
        "public/../private.md",
        "public\\note.md",
        "",
        "public//note.md",
    ] {
        let mut v = value();
        v["inputEvidenceRefs"][0]["path"] = json!(path);
        refusal(&v, SpecRefusal::InvalidEvidence);
        let mut v = value();
        v["requestedGrant"]["readScope"] = json!([path]);
        refusal(&v, SpecRefusal::InvalidScope);
    }
    let mut v = value();
    v["inputEvidenceRefs"][0]["sha256"] = json!("not-a-digest");
    refusal(&v, SpecRefusal::InvalidEvidence);
    let mut v = value();
    v["inputEvidenceRefs"] = Value::Array(
        (0..65)
            .map(|_| json!({"path":"public/note.md","sha256":"b".repeat(64)}))
            .collect(),
    );
    refusal(&v, SpecRefusal::InvalidEvidence);
    let mut v = value();
    v["requestedGrant"]["readScope"] = json!([]);
    refusal(&v, SpecRefusal::InvalidScope);
}
#[test]
fn supervised_jobs_spec_allowlists_schema_and_checks_budget_deadline_without_overflow() {
    let mut v = value();
    v["resultSchemaId"] = json!("javascript:private-canary");
    refusal(&v, SpecRefusal::InvalidSchema);
    for seconds in [0, 601] {
        let mut v = value();
        v["budget"]["elapsedSeconds"] = json!(seconds);
        refusal(&v, SpecRefusal::InvalidBudget);
    }
    for bytes in [0, 262145] {
        let mut v = value();
        v["budget"]["resultBytes"] = json!(bytes);
        refusal(&v, SpecRefusal::InvalidBudget);
    }
    for deadline in [0, 1000, 1601, u64::MAX] {
        let mut v = value();
        v["deadlineAt"] = json!(deadline);
        refusal(&v, SpecRefusal::InvalidDeadline);
    }
    let mut v = value();
    v["budget"]["elapsedSeconds"] = json!(60);
    refusal(&v, SpecRefusal::InvalidDeadline);
    assert_eq!(
        decode(&value(), u64::MAX).err(),
        Some(SpecRefusal::InvalidDeadline)
    );
}
#[test]
fn supervised_jobs_limits_reuse_actual_subagent_policy_and_owner_limits() {
    let limits = limits::load().expect("new limits loader remains closed");
    let current = crate::policy::subagents::table();
    assert_eq!(
        limits.max_depth.to_string(),
        current.env["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]
    );
    assert_eq!(
        limits.max_concurrent.to_string(),
        current.env["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"]
    );
    assert_eq!(
        limits.max_admissions.to_string(),
        current.env["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"]
    );
    assert_eq!(
        (
            limits.max_depth,
            limits.max_concurrent,
            limits.max_admissions
        ),
        (1, 2, 8)
    );
    assert_eq!(
        (limits.max_elapsed_seconds, limits.max_result_bytes),
        (600, 262144)
    );
    assert_eq!(
        (
            limits.max_spec_bytes,
            limits.max_objective_bytes,
            limits.max_evidence_refs,
            limits.max_path_bytes,
            limits.max_identity_bytes
        ),
        (65536, 16384, 64, 512, 128)
    );
}
#[test]
fn supervised_jobs_limit_evaluator_refuses_depth_two_third_active_and_ninth_admission() {
    let limits = limits::load().expect("new limits loader remains closed");
    assert_eq!(limits::evaluate_new_admission(&limits, 0, 1, 7), Ok(()));
    assert_eq!(
        limits::evaluate_new_admission(&limits, 1, 0, 0),
        Err(limits::LimitRefusal::Depth)
    );
    assert_eq!(
        limits::evaluate_new_admission(&limits, u32::MAX, 0, 0),
        Err(limits::LimitRefusal::Depth)
    );
    assert_eq!(
        limits::evaluate_new_admission(&limits, 0, 2, 7),
        Err(limits::LimitRefusal::Concurrency)
    );
    assert_eq!(
        limits::evaluate_new_admission(&limits, 0, 0, 8),
        Err(limits::LimitRefusal::SessionAdmissions)
    );
    // Declining active count after finish does not reset the observed session total.
    assert_eq!(
        limits::evaluate_new_admission(&limits, 0, 0, u32::MAX),
        Err(limits::LimitRefusal::SessionAdmissions)
    );
}
#[test]
fn supervised_jobs_deadline_evaluator_expires_at_boundary_and_result_bound_is_inclusive() {
    assert_eq!(limits::check_deadline(1600, 1599), Ok(()));
    assert_eq!(
        limits::check_deadline(1600, 1600),
        Err(limits::LimitRefusal::Deadline)
    );
    assert_eq!(
        limits::check_deadline(1600, 1700),
        Err(limits::LimitRefusal::Deadline)
    );
    assert_eq!(limits::check_result_length(262144, 262144), Ok(()));
    assert_eq!(
        limits::check_result_length(262144, 262145),
        Err(limits::LimitRefusal::ResultTooLarge)
    );
    assert_eq!(
        limits::check_result_length(262144, usize::MAX),
        Err(limits::LimitRefusal::ResultTooLarge)
    );
    assert_eq!(
        limits::check_result_length(16, 17),
        Err(limits::LimitRefusal::ResultTooLarge)
    );
    assert_eq!(limits::check_result_length(16, 0), Ok(()));
}
