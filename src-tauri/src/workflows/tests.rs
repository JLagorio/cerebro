use super::definition::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn digest(bytes: &str) -> String { format!("{:x}", Sha256::digest(bytes.as_bytes())) }
fn fixture() -> Value {
    // Hand-normalized schema: the same bytes determine the independently pinned digest.
    let schema = r#"{"additionalProperties":false,"properties":{"count":{"minimum":1,"type":"integer"}},"required":["count"],"type":"object"}"#;
    json!({"formatVersion":1,"workflowId":"review","entryStepId":"first",
        "inputSchema":serde_json::from_str::<Value>(schema).unwrap(),
        "inputSchemaDigest":digest(schema),"authoredBy":"human:me",
        "declaredActionDigests":[],"trigger":{"kind":"manual"},
        "steps":[{"stepId":"first","label":"Return count","operation":{"kind":"result",
        "output":{"kind":"input","path":["count"]}}}]})
}
fn result(id: &str, output: Value) -> Value {
    json!({"stepId":id,"label":id,"operation":{"kind":"result","output":output}})
}
fn transform(id: &str, next: &str) -> Value {
    json!({"stepId":id,"label":id,"operation":{"kind":"transform",
        "mapping":{"kind":"literal","value":1},"outputSchema":{"type":"integer"},"nextStepId":next}})
}
fn condition(id: &str, yes: &str, no: &str) -> Value {
    json!({"stepId":id,"label":id,"operation":{"kind":"condition","predicate":{"kind":"exists",
        "value":{"kind":"input","path":["count"]}},"ifTrue":yes,"ifFalse":no}})
}
fn check(value: &Value) -> Result<ValidatedDefinition, DefinitionError> { validate(&value.to_string()) }

#[test]
fn valid_definition_seals_and_uses_its_pinned_schema_for_inputs() {
    let validated = check(&fixture()).unwrap();
    assert_eq!(validated.definition.workflow_id, "review");
    assert_eq!(validate_input(&validated, r#"{"count":2}"#), Ok(()));
    for input in [r#"{"count":0}"#, r#"{"count":"2"}"#, "{}", r#"{"count":2,"extra":1}"#] {
        assert_eq!(validate_input(&validated, input), Err(DefinitionError::InvalidInput));
    }
    let sealed = validate(&validated.canonical).unwrap();
    assert_eq!(sealed.definition_hash, validated.definition_hash);
    let mut changed: Value = serde_json::from_str(&validated.canonical).unwrap();
    changed["steps"][0]["label"] = json!("Edited under old digest");
    assert_eq!(check(&changed).unwrap_err(), DefinitionError::DefinitionMismatch);
}

#[test]
fn unknown_format_script_and_unknown_fields_never_become_valid_definitions() {
    let mut value = fixture();
    value["formatVersion"] = json!(2);
    assert_eq!(check(&value).unwrap_err(), DefinitionError::UnsupportedFormat);
    value = fixture();
    value["steps"][0]["operation"] = json!({"kind":"script","source":"doSomething()"});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidJson);
    value = fixture();
    value["enabled"] = json!(true);
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidJson);
}

#[test]
fn schema_edit_requires_new_digest_and_creates_a_distinct_version() {
    let before = check(&fixture()).unwrap();
    let mut value = fixture();
    value["inputSchema"] = json!({"type":"string"});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::SchemaDigestMismatch);
    value["inputSchemaDigest"] = json!(digest(r#"{"type":"string"}"#));
    let after = check(&value).unwrap();
    assert_ne!(before.definition_hash, after.definition_hash);
    assert!(validate_input(&before, r#""a string""#).is_err());
    assert!(validate_input(&after, r#""a string""#).is_ok());
    value["inputSchema"] = json!({"type":"string","pattern":".*"});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::UnsupportedSchema);
}

#[test]
fn cycles_duplicate_ids_unreachable_and_unknown_successors_are_rejected() {
    for steps in [
        json!([transform("first", "first")]),
        json!([transform("first", "second"), transform("second", "first")]),
        json!([result("first", json!({"kind":"input","path":[]})), result("first", json!({"kind":"input","path":[]}))]),
        json!([result("first", json!({"kind":"input","path":[]})), result("unused", json!({"kind":"input","path":[]}))]),
        json!([transform("first", "missing")]),
    ] {
        let mut value = fixture(); value["steps"] = steps;
        assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidGraph);
    }
}

#[test]
fn required_output_must_dominate_consumer_on_every_branch() {
    let mut value = fixture();
    value["steps"] = json!([condition("first", "producer", "done"), transform("producer", "done"),
        result("done", json!({"kind":"output","stepId":"producer","path":[]}))]);
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidMapping);
    value["steps"][0] = condition("first", "producer", "producer");
    assert!(check(&value).is_ok());
}

#[test]
fn schema_optional_transform_field_can_omit_skipped_ancestor_output() {
    let mut value = fixture();
    let mut consume = transform("consume", "done");
    consume["operation"]["mapping"] = json!({"kind":"object","fields":{
        "optional":{"kind":"output","stepId":"producer","path":[]}}});
    consume["operation"]["outputSchema"] = json!({"type":"object",
        "properties":{"optional":{"type":"integer"}},"additionalProperties":false});
    value["steps"] = json!([condition("first", "producer", "consume"), transform("producer", "consume"),
        consume, result("done", json!({"kind":"output","stepId":"consume","path":[]}))]);
    assert!(check(&value).is_ok(), "declared optional output may inspect a skipped ancestor");
    value["steps"][2]["operation"]["outputSchema"]["required"] = json!(["optional"]);
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidMapping);
    value["steps"][2]["operation"]["outputSchema"] = json!({"type":"object","additionalProperties":true});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidMapping,
        "an undeclared property is not schema-optional");
}

#[test]
fn exists_can_inspect_skipped_output_but_not_forward_or_unknown_output() {
    let mut value = fixture();
    value["steps"] = json!([condition("first", "producer", "check"), transform("producer", "check"),
        condition("check", "done", "done"), result("done", json!({"kind":"input","path":[]}))]);
    value["steps"][2]["operation"]["predicate"]["value"] = json!({"kind":"output","stepId":"producer","path":[]});
    assert!(check(&value).is_ok());
    value["steps"][2]["operation"]["predicate"]["value"]["stepId"] = json!("done");
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidMapping);
    value["steps"][2]["operation"]["predicate"]["value"]["stepId"] = json!("invented");
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidMapping);
}

#[test]
fn oversized_definitions_and_expression_trees_are_refused_before_execution() {
    assert_eq!(validate(&" ".repeat(262_145)).unwrap_err(), DefinitionError::LimitExceeded);
    let mut value = fixture();
    value["steps"][0]["operation"]["output"] = json!({"kind":"array","items":(0..128)
        .map(|_|json!({"kind":"input","path":[]})).collect::<Vec<_>>()});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::LimitExceeded);
    let mut mapping = json!({"kind":"input","path":[]});
    for _ in 0..16 { mapping = json!({"kind":"array","items":[mapping]}); }
    value["steps"][0]["operation"]["output"] = mapping;
    assert_eq!(check(&value).unwrap_err(), DefinitionError::LimitExceeded);
}

#[test]
fn definition_identity_cannot_escape_owned_directory_and_json_keys_cannot_repeat() {
    for id in ["../outside", "a/b", ".", "", "with space"] {
        let mut value = fixture(); value["workflowId"] = json!(id);
        assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidIdentity);
    }
    let text = fixture().to_string().replacen("\"formatVersion\":1", "\"formatVersion\":1,\"formatVersion\":1", 1);
    assert_eq!(validate(&text).unwrap_err(), DefinitionError::InvalidJson);
}

#[test]
fn exists_cannot_read_a_future_control_flow_step_even_if_listed_earlier() {
    let mut value = fixture();
    value["steps"] = json!([transform("producer", "done"), condition("first", "producer", "done"),
        result("done", json!({"kind":"input","path":[]}))]);
    value["steps"][1]["operation"]["predicate"]["value"] = json!({"kind":"output","stepId":"producer","path":[]});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::InvalidMapping);
}

#[test]
fn maximum_step_count_is_usable_and_one_more_is_refused() {
    let mut value = fixture(); value["entryStepId"] = json!("step0");
    let mut steps: Vec<_> = (0..31).map(|i| transform(&format!("step{i}"), &format!("step{}", i+1))).collect();
    steps.push(result("step31", json!({"kind":"input","path":[]})));
    value["steps"] = json!(steps);
    assert!(check(&value).is_ok());
    steps[31] = transform("step31", "step32");
    steps.push(result("step32", json!({"kind":"input","path":[]})));
    value["steps"] = json!(steps);
    assert_eq!(check(&value).unwrap_err(), DefinitionError::LimitExceeded);
}

#[test]
fn sealed_schedule_remains_readable_and_hashes_exact_large_decimals() {
    let mut value = fixture();
    value["trigger"] = json!({"kind":"schedule","intervalSeconds":100,"catchUp":"skip_missed"});
    let sealed = check(&value).unwrap();
    assert_eq!(validate(&sealed.canonical).unwrap().definition_hash, sealed.definition_hash);
    value["steps"][0]["operation"]["output"] = json!({"kind":"literal","value":"DECIMAL"});
    let text = value.to_string().replace("\"DECIMAL\"", "9007199254740993");
    let first = validate(&text).unwrap();
    let second = validate(&text.replace("9007199254740993", "9007199254740992")).unwrap();
    assert_ne!(first.definition_hash, second.definition_hash);
    assert_eq!(validate(&first.canonical).unwrap().definition_hash, first.definition_hash);
}

#[test]
fn future_format_with_new_step_tags_reports_unsupported_format() {
    let mut value = fixture();
    value["formatVersion"] = json!(2);
    value["steps"][0]["operation"] = json!({"kind":"future_parallel"});
    value["futureField"] = json!({"versionTwo":true});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::UnsupportedFormat);
}

#[test]
fn supported_expression_depth_is_reachable_without_losing_the_json_bound() {
    let mut value = fixture();
    let mut mapping = json!({"kind":"input","path":[]});
    for _ in 0..15 { mapping = json!({"kind":"array","items":[mapping]}); }
    value["steps"][0]["operation"]["output"] = mapping.clone();
    assert!(check(&value).is_ok(), "16 AST nodes deep is a supported expression");
    value["steps"][0]["operation"]["output"] = json!({"kind":"array","items":[mapping]});
    assert_eq!(check(&value).unwrap_err(), DefinitionError::LimitExceeded);
}

#[test]
fn equivalent_raw_values_have_one_sealed_representation_under_their_hash() {
    let mut value = fixture();
    value["steps"][0]["operation"]["output"] = json!({"kind":"literal","value":"RAW"});
    let a = validate(&value.to_string().replace("\"RAW\"", r#"{ "b": 1.0, "a": 10.00 }"#)).unwrap();
    let b = validate(&value.to_string().replace("\"RAW\"", r#"{"a":1e1,"b":1}"#)).unwrap();
    assert_eq!(a.definition_hash, b.definition_hash);
    assert_eq!(a.canonical, b.canonical, "one immutable hash must install identical sealed bytes");
}
