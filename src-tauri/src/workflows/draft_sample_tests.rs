//! Unsaved preview compilation uses the same draft codec and definition/input
//! validators as publication/execution. No file path or runtime is accepted.
use super::*;

fn draft() -> WorkflowDraft {
    WorkflowDraft {
        workflow_id: "unsaved-example".into(),
        entry_step_id: "done".into(),
        input_schema_json: r#"{"type":"object","properties":{"amount":{"type":"number"}},"required":["amount"],"additionalProperties":false}"#.into(),
        trigger_json: r#"{"kind":"manual"}"#.into(),
        steps: vec![WorkflowStepDraft {
            step_id: "done".into(), label: "Result".into(),
            operation: WorkflowOperationDraft::Result {
                output_json: r#"{"kind":"input","path":["amount"]}"#.into(),
            },
        }],
    }
}

#[test]
fn unsaved_sample_compiles_exact_decimal_without_save_publish_or_native_origin() {
    let source = draft();
    let sample = compile_sample(&source, "human:preview", r#" { "amount":9007199254740993.0000000000000001 } "#).unwrap();
    assert_eq!(sample.input, r#"{"amount":90071992547409930000000000000001e-16}"#);
    assert_eq!(sample.definition.definition.workflow_id, "unsaved-example");
    assert_eq!(sample.definition.definition.authored_by, "human:preview");
    assert!(sample.definition.definition.declared_action_digests.is_empty());
    assert!(validate(&source, "human:preview").valid);
    assert_eq!(sample.definition.definition_hash,
        definition::validate(&encode_draft(&source, "human:preview").unwrap()).unwrap().definition_hash);
}

#[test]
fn unsaved_sample_uses_current_edits_rather_than_a_saved_or_published_version() {
    let mut source = draft();
    let first = compile_sample(&source, "human:preview", r#"{"amount":1}"#).unwrap();
    source.steps[0].operation = WorkflowOperationDraft::Result {
        output_json: r#"{"kind":"literal","value":9007199254740993.0000000000000001}"#.into(),
    };
    let edited = compile_sample(&source, "human:preview", r#"{"amount":1}"#).unwrap();
    assert_ne!(edited.definition.definition_hash, first.definition.definition_hash);
    assert!(edited.definition.canonical.contains("90071992547409930000000000000001e-16"));
    assert_eq!(edited.input, r#"{"amount":1}"#);
}

#[test]
fn unsaved_sample_rejects_incomplete_graph_by_the_publication_validator() {
    let mut source = draft();
    source.entry_step_id = "missing".into();
    assert!(!validate(&source, "human:preview").valid);
    assert_eq!(compile_sample(&source, "human:preview", r#"{"amount":1}"#).unwrap_err().code,
        WorkflowErrorCode::InvalidDefinition);
}

#[test]
fn unsaved_sample_keeps_invalid_input_distinct_from_an_invalid_definition() {
    let source = draft();
    assert!(validate(&source, "human:preview").valid);
    for input in [r#"{}"#, r#"{"amount":"not a number"}"#, r#"{"amount":1,"amount":2}"#] {
        assert_eq!(compile_sample(&source, "human:preview", input).unwrap_err().code,
            WorkflowErrorCode::InvalidInput, "{input}");
    }
}

#[test]
fn unsaved_sample_refuses_unsupported_schema_without_losing_the_draft() {
    let mut source = draft();
    source.input_schema_json = r#"{"type":"object","$ref":"https://example.invalid/schema"}"#.into();
    let original = source.clone();
    assert_eq!(compile_sample(&source, "human:preview", "{}").unwrap_err().code,
        WorkflowErrorCode::InvalidDefinition);
    assert_eq!(source, original);
    assert!(!validate(&source, "human:preview").valid);
}

#[test]
fn unsaved_sample_refuses_input_larger_than_the_execution_input_bound() {
    let mut source = draft();
    source.input_schema_json = r#"{"type":"string"}"#.into();
    source.steps[0].operation = WorkflowOperationDraft::Result {
        output_json: r#"{"kind":"input","path":[]}"#.into(),
    };
    assert!(validate(&source, "human:preview").valid);
    let input = format!("\"{}\"", "x".repeat(300_000));
    assert_eq!(compile_sample(&source, "human:preview", &input).unwrap_err().code,
        WorkflowErrorCode::InvalidInput);
}
