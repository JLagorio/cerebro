//! Pure data fixtures, not native parent authority or factual evidence proof.
use super::{
    limits,
    result::*,
    types::{ChildJobSpec, EvidenceRef, SpecRefusal},
};
use serde_json::{json, Value};

const NOW: u64 = 1000;
const SCHEMA: &str = "read_evidence_summary.v1";
const PATH: &str = "public/note.md";
fn original_spec() -> ChildJobSpec {
    let bounds = limits::load().unwrap();
    let value = json!({
        "parentRunId":"result-parent-description", "parentAttemptId":"result-attempt-description",
        "objective":"Transient request only; no authority is established by this fixture.",
        "instructionSourceVersion":"a".repeat(64),
        "inputEvidenceRefs":[{"path":PATH,"sha256":"b".repeat(64)}],
        "resultSchemaId":SCHEMA, "requestedGrant":{"readScope":["public"]},
        "budget":{"elapsedSeconds":bounds.max_elapsed_seconds,"resultBytes":bounds.max_result_bytes},
        "deadlineAt":NOW + bounds.max_elapsed_seconds
    });
    ChildJobSpec::decode(&serde_json::to_vec(&value).unwrap(), NOW).unwrap()
}
fn contract() -> FrozenResultContract {
    FrozenResultContract::from_spec(&original_spec(), NOW)
        .expect("new frozen result contract API remains closed")
}
fn carrier() -> Value {
    json!({"schemaId":SCHEMA,"completeness":"complete","summary":"Untrusted summary text.",
        "evidence":[{"path":PATH,"sha256":"b".repeat(64)}]})
}
fn encode(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn kind(value: &ResultValidation) -> &'static str {
    match value {
        ResultValidation::Valid(_) => "valid",
        ResultValidation::Partial(_) => "partial",
        ResultValidation::Invalid { .. } => "invalid",
    }
}
fn invalid(value: &ResultValidation) -> Option<ResultInvalidReason> {
    match value {
        ResultValidation::Invalid { reason } => Some(*reason),
        _ => None,
    }
}
fn payload(value: ResultValidation) -> ValidatedSummary {
    match value {
        ResultValidation::Valid(payload) | ResultValidation::Partial(payload) => payload,
        ResultValidation::Invalid { .. } => {
            panic!("expected a transient structurally validated carrier")
        }
    }
}
fn expect_invalid(contract: &FrozenResultContract, value: &Value, reason: ResultInvalidReason) {
    assert_eq!(
        invalid(&validate_transient(contract, &encode(value))),
        Some(reason)
    );
}

#[test]
fn supervised_result_complete_and_partial_remain_explicit_with_unknown_usage() {
    let frozen = contract();
    let complete = validate_transient(&frozen, &encode(&carrier()));
    assert_eq!(kind(&complete), "valid");
    let complete = payload(complete);
    assert_eq!(complete.summary, "Untrusted summary text.");
    assert_eq!(complete.evidence.len(), 1);
    assert_eq!(complete.evidence[0].path, PATH);
    assert_eq!(complete.evidence[0].sha256, "b".repeat(64));
    assert_eq!(complete.usage_availability, UsageAvailability::Unknown);
    let mut value = carrier();
    value["completeness"] = json!("partial");
    let partial = validate_transient(&frozen, &encode(&value));
    assert_eq!(kind(&partial), "partial");
    assert_eq!(
        payload(partial).usage_availability,
        UsageAvailability::Unknown
    );
    value["evidence"][0]["sha256"] = json!("c".repeat(64));
    expect_invalid(&frozen, &value, ResultInvalidReason::ChangedReference);
}
#[test]
fn supervised_result_empty_reference_list_stays_uncited_and_does_not_invent_usage() {
    let frozen = contract();
    let mut value = carrier();
    value["evidence"] = json!([]);
    let result = validate_transient(&frozen, &encode(&value));
    assert_eq!(kind(&result), "valid");
    let result = payload(result);
    assert!(result.evidence.is_empty());
    assert_eq!(result.summary, "Untrusted summary text.");
    assert_eq!(result.usage_availability, UsageAvailability::Unknown);
}
#[test]
fn supervised_result_malformed_or_unknown_fields_never_become_partial_payloads() {
    let frozen = contract();
    for bytes in [b"not-json".as_slice(), b"[]".as_slice(), b"null".as_slice()] {
        assert_eq!(
            invalid(&validate_transient(&frozen, bytes)),
            Some(ResultInvalidReason::Malformed)
        );
    }
    for key in [
        "usage",
        "cost",
        "jobId",
        "runId",
        "actor",
        "authority",
        "effects",
    ] {
        let mut value = carrier();
        value[key] = json!("untrusted-private-canary");
        expect_invalid(&frozen, &value, ResultInvalidReason::Malformed);
    }
    let mut value = carrier();
    value["evidence"][0]["extra"] = json!("private-canary");
    expect_invalid(&frozen, &value, ResultInvalidReason::Malformed);
    let mut value = carrier();
    value["completeness"] = json!("invalid");
    expect_invalid(&frozen, &value, ResultInvalidReason::Malformed);
}
#[test]
fn supervised_result_schema_and_summary_are_closed_without_input_echo() {
    let frozen = contract();
    let mut value = carrier();
    value["schemaId"] = json!("foreign.private-canary.v1");
    expect_invalid(&frozen, &value, ResultInvalidReason::SchemaMismatch);
    for summary in ["", " \n\t "] {
        let mut value = carrier();
        value["summary"] = json!(summary);
        expect_invalid(&frozen, &value, ResultInvalidReason::InvalidSummary);
    }
    // Only the fixed bounded reason is formatted, never the content-bearing result.
    let reason = invalid(&validate_transient(&frozen, &encode(&value)))
        .expect("wrong schema must be invalid");
    assert!(!format!("{reason:?}").contains("private-canary"));
}
#[test]
fn supervised_result_original_budget_and_approved_cap_are_checked_before_json_parse() {
    let frozen = contract();
    let maximum = limits::load().unwrap().max_result_bytes;
    let bytes = vec![b'{'; maximum + 1];
    assert_eq!(
        invalid(&validate_transient(&frozen, &bytes)),
        Some(ResultInvalidReason::TooLarge)
    );
    let mut small = original_spec();
    let valid = encode(&carrier());
    small.budget.result_bytes = u32::try_from(valid.len() - 1).unwrap();
    let smaller = FrozenResultContract::from_spec(&small, NOW).unwrap();
    assert_eq!(
        invalid(&validate_transient(&smaller, &valid)),
        Some(ResultInvalidReason::TooLarge)
    );
    let bytes = vec![b'{'; valid.len()];
    assert_eq!(
        invalid(&validate_transient(&smaller, &bytes)),
        Some(ResultInvalidReason::TooLarge)
    );
}
#[test]
fn supervised_result_exact_encoded_budget_is_inclusive_and_uses_utf8_bytes() {
    let maximum = limits::load().unwrap().max_result_bytes;
    let mut value = carrier();
    value["summary"] = json!("");
    let overhead = encode(&value).len();
    value["summary"] = json!("x".repeat(maximum - overhead));
    let at_maximum = encode(&value);
    assert_eq!(at_maximum.len(), maximum);
    let frozen = contract();
    assert_eq!(kind(&validate_transient(&frozen, &at_maximum)), "valid");
    let mut value = carrier();
    value["summary"] = json!("😀".repeat(8));
    let bytes = encode(&value);
    let mut original = original_spec();
    original.budget.result_bytes = u32::try_from(bytes.len()).unwrap();
    let exact = FrozenResultContract::from_spec(&original, NOW).unwrap();
    assert_eq!(kind(&validate_transient(&exact, &bytes)), "valid");
    original.budget.result_bytes -= 1;
    let shorter = FrozenResultContract::from_spec(&original, NOW).unwrap();
    assert_eq!(
        invalid(&validate_transient(&shorter, &bytes)),
        Some(ResultInvalidReason::TooLarge)
    );
}
#[test]
fn supervised_result_foreign_changed_and_duplicate_references_are_invalid_without_filtering() {
    let frozen = contract();
    for path in [
        "private/foreign.md",
        "../public/note.md",
        "",
        "/public/note.md",
    ] {
        let mut value = carrier();
        value["evidence"][0]["path"] = json!(path);
        expect_invalid(&frozen, &value, ResultInvalidReason::InvalidReference);
    }
    for digest in ["c".repeat(64), "not-a-digest".into()] {
        let mut value = carrier();
        value["evidence"][0]["sha256"] = json!(digest);
        expect_invalid(&frozen, &value, ResultInvalidReason::ChangedReference);
    }
    let mut value = carrier();
    value["evidence"] = json!([value["evidence"][0].clone(), value["evidence"][0].clone()]);
    expect_invalid(&frozen, &value, ResultInvalidReason::DuplicateReference);
}
#[test]
fn supervised_result_reference_count_reuses_existing_limit_before_tuple_processing() {
    let frozen = contract();
    let maximum = limits::load().unwrap().max_evidence_refs;
    let reference = carrier()["evidence"][0].clone();
    let mut value = carrier();
    value["evidence"] = Value::Array(vec![reference; maximum + 1]);
    let bytes = encode(&value);
    assert!(bytes.len() <= limits::load().unwrap().max_result_bytes);
    assert_eq!(
        invalid(&validate_transient(&frozen, &bytes)),
        Some(ResultInvalidReason::TooManyReferences)
    );
}
#[test]
fn supervised_result_frozen_contract_survives_original_mutation_and_refuses_changed_context() {
    let mut original = original_spec();
    let frozen = FrozenResultContract::from_spec(&original, NOW).unwrap();
    original.input_evidence_refs[0].sha256 = "c".repeat(64);
    original.result_schema_id = "foreign.v1".into();
    original.budget.result_bytes = 1;
    drop(original);
    assert_eq!(
        kind(&validate_transient(&frozen, &encode(&carrier()))),
        "valid"
    );
    let mut value = carrier();
    value["evidence"][0]["sha256"] = json!("c".repeat(64));
    expect_invalid(&frozen, &value, ResultInvalidReason::ChangedReference);
    let mut other = original_spec();
    other.input_evidence_refs[0].path = "public/other.md".into();
    let other = FrozenResultContract::from_spec(&other, NOW).unwrap();
    expect_invalid(&other, &carrier(), ResultInvalidReason::InvalidReference);
}
#[test]
fn supervised_result_contract_refuses_ambiguous_original_refs_and_keeps_exact_duplicates() {
    let mut original = original_spec();
    original.input_evidence_refs.push(EvidenceRef {
        path: PATH.into(),
        sha256: "c".repeat(64),
    });
    assert_eq!(
        FrozenResultContract::from_spec(&original, NOW).err(),
        Some(ContractError::AmbiguousEvidence)
    );
    original.input_evidence_refs[1].sha256 = "b".repeat(64);
    let exact = FrozenResultContract::from_spec(&original, NOW).unwrap();
    assert_eq!(
        kind(&validate_transient(&exact, &encode(&carrier()))),
        "valid"
    );
}
#[test]
fn supervised_result_contract_reuses_existing_original_spec_validation() {
    let mut original = original_spec();
    original.budget.result_bytes = 0;
    assert_eq!(
        FrozenResultContract::from_spec(&original, NOW).err(),
        Some(ContractError::InvalidSpec(SpecRefusal::InvalidBudget))
    );
    original = original_spec();
    original.result_schema_id = "foreign.v1".into();
    assert_eq!(
        FrozenResultContract::from_spec(&original, NOW).err(),
        Some(ContractError::InvalidSpec(SpecRefusal::InvalidSchema))
    );
    original = original_spec();
    original.deadline_at = NOW;
    assert_eq!(
        FrozenResultContract::from_spec(&original, NOW).err(),
        Some(ContractError::InvalidSpec(SpecRefusal::InvalidDeadline))
    );
}

// Literal alternate JSON shapes exercise the actual byte decoder. Serde's
// default struct/enum representations must not broaden the promised carrier.
#[test]
fn supervised_result_shape_rejects_positional_carrier_array() {
    let frozen = contract();
    let value = json!([
        SCHEMA,
        "complete",
        "Untrusted summary text.",
        [{"path": PATH, "sha256": "b".repeat(64)}]
    ]);
    expect_invalid(&frozen, &value, ResultInvalidReason::Malformed);
}

#[test]
fn supervised_result_shape_rejects_positional_evidence_array() {
    let frozen = contract();
    let mut value = carrier();
    value["evidence"] = json!([[PATH, "b".repeat(64)]]);
    expect_invalid(&frozen, &value, ResultInvalidReason::Malformed);
}

#[test]
fn supervised_result_shape_rejects_object_completeness_variants() {
    let frozen = contract();
    for completeness in [json!({"complete": null}), json!({"partial": null})] {
        let mut value = carrier();
        value["completeness"] = completeness;
        expect_invalid(&frozen, &value, ResultInvalidReason::Malformed);
    }
}

#[test]
fn supervised_result_shape_control_keeps_object_carrier_and_string_completeness() {
    let frozen = contract();
    let complete = validate_transient(&frozen, &encode(&carrier()));
    assert_eq!(kind(&complete), "valid");
    let complete = payload(complete);
    assert_eq!(complete.summary, "Untrusted summary text.");
    assert_eq!(complete.evidence.len(), 1);
    assert_eq!(complete.evidence[0].path, PATH);
    assert_eq!(complete.evidence[0].sha256, "b".repeat(64));
    assert_eq!(complete.usage_availability, UsageAvailability::Unknown);
    let mut partial = carrier();
    partial["completeness"] = json!("partial");
    let partial = validate_transient(&frozen, &encode(&partial));
    assert_eq!(kind(&partial), "partial");
    assert_eq!(
        payload(partial).usage_availability,
        UsageAvailability::Unknown
    );
}

// Pre-existing refusal controls: literal bytes preserve duplicate JSON keys.
// These are not new feature REDs and must not pass through serde_json::Value.
#[test]
fn supervised_result_shape_control_rejects_duplicate_known_carrier_keys() {
    let frozen = contract();
    for duplicated in [
        format!(r#""schemaId":"{SCHEMA}","schemaId":"{SCHEMA}""#),
        r#""completeness":"complete","completeness":"complete""#.into(),
        r#""summary":"Untrusted summary text.","summary":"Untrusted summary text.""#.into(),
        r#""evidence":[],"evidence":[]"#.into(),
    ] {
        let key = duplicated.split(':').next().unwrap();
        let mut fields = vec![
            format!(r#""schemaId":"{SCHEMA}""#),
            r#""completeness":"complete""#.into(),
            r#""summary":"Untrusted summary text.""#.into(),
            r#""evidence":[]"#.into(),
        ];
        fields.retain(|field| field.split(':').next() != Some(key));
        fields.push(duplicated);
        let encoded = format!("{{{}}}", fields.join(","));
        assert_eq!(
            invalid(&validate_transient(&frozen, encoded.as_bytes())),
            Some(ResultInvalidReason::Malformed)
        );
    }
}

#[test]
fn supervised_result_shape_control_rejects_duplicate_known_evidence_keys() {
    let frozen = contract();
    let digest = "b".repeat(64);
    for reference in [
        format!(r#"{{"path":"{PATH}","path":"{PATH}","sha256":"{digest}"}}"#),
        format!(r#"{{"path":"{PATH}","sha256":"{digest}","sha256":"{digest}"}}"#),
    ] {
        let encoded = format!(
            r#"{{"schemaId":"{SCHEMA}","completeness":"complete","summary":"Untrusted summary text.","evidence":[{reference}]}}"#
        );
        assert_eq!(
            invalid(&validate_transient(&frozen, encoded.as_bytes())),
            Some(ResultInvalidReason::Malformed)
        );
    }
}
