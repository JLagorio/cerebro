use super::*;
use serde::Serialize;
use schemars::JsonSchema;
use std::collections::BTreeSet;
fn parity<T: Serialize + JsonSchema>(value: T, expected: &[&str]) {
    let wire = serde_json::to_value(value).unwrap();
    let kind = wire["kind"].as_str().unwrap();
    let schema = serde_json::to_value(schemars::schema_for!(T)).unwrap();
    let branches = schema.get("oneOf").or_else(|| schema.get("anyOf")).unwrap().as_array().unwrap();
    let object = branches.iter().find_map(|branch| {
        let properties = branch.get("properties")?.as_object()?;
        let kinds = properties.get("kind")?.get("enum")?.as_array()?;
        kinds.iter().any(|item| item.as_str() == Some(kind)).then_some(properties)
    }).expect("tagged variant schema");
    let actual: BTreeSet<_> = wire.as_object().unwrap().keys().map(String::as_str).collect();
    let advertised: BTreeSet<_> = object.keys().map(String::as_str).collect();
    assert_eq!(actual, advertised, "serialized fields and generated schema differ for {kind}");
    for field in expected { assert!(actual.contains(field), "missing expected camelCase field {field}"); }
}
fn refusal() -> WorkspaceBackupRefusal { WorkspaceBackupRefusal { kind: WorkspaceBackupRefusalKind::Unavailable, message: "synthetic refusal".into(), authority: None, backup: None, output: WorkspaceBackupDisposition::NoneCreated } }
#[test]
fn availability_enum_wire_and_schema_agree_on_camel_case_fields() {
    parity(WorkspaceBackupAvailability::Available { source_label: "synthetic source".into(), check_restore: true }, &["sourceLabel", "checkRestore"]);
    parity(WorkspaceBackupAvailability::UnsupportedCurrentVault { message: "synthetic legacy".into(), check_restore: true }, &["checkRestore"]);
    parity(WorkspaceBackupAvailability::Unavailable { refusal: refusal(), check_restore: false }, &["checkRestore"]);
}
#[test]
fn operation_enum_wire_and_schema_agree_on_original_operation_id() {
    let labels = WorkspaceBackupLabels::default();
    parity(WorkspaceBackupOperation::Choosing { operation_id: "synthetic operation".into(), mode: WorkspaceBackupMode::Check, labels: labels.clone() }, &["operationId"]);
    parity(WorkspaceBackupOperation::Running { operation_id: "synthetic operation".into(), mode: WorkspaceBackupMode::Restore, labels: labels.clone() }, &["operationId"]);
    parity(WorkspaceBackupOperation::Terminal { operation_id: "synthetic operation".into(), mode: WorkspaceBackupMode::Create, labels, result: WorkspaceBackupTerminal::Refused { refusal: refusal() } }, &["operationId"]);
}
#[test]
fn commit_and_completion_enum_wire_and_schema_agree_on_camel_case_ids() {
    parity(WorkspaceBackupCommitResult::Started { operation_id: "synthetic operation".into(), mode: WorkspaceBackupMode::Create, labels: WorkspaceBackupLabels::default() }, &["operationId"]);
    parity(WorkspaceBackupTerminal::Completed { workspace_id: Some("synthetic workspace".into()), summary: None, output: WorkspaceBackupDisposition::NoneCreated }, &["workspaceId"]);
}
