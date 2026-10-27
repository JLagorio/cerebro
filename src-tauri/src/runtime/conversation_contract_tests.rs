use super::*;
fn bundle() -> serde_json::Value {
    serde_json::json!({"version":1,"types":{
        "AttemptBinding":schemars::schema_for!(AttemptBinding),
        "DisplayMessage":schemars::schema_for!(DisplayMessage),
        "ArchiveContext":schemars::schema_for!(crate::conversations::transport::ArchiveContext),
        "ArchiveError":schemars::schema_for!(crate::conversations::transport::ArchiveError),
        "ArchiveSetting":schemars::schema_for!(crate::conversations::transport::ArchiveSetting),
        "ThreadPage":schemars::schema_for!(crate::conversations::transport::ThreadPage),
        "MessagePage":schemars::schema_for!(crate::conversations::transport::MessagePage),
        "PruneResult":schemars::schema_for!(crate::conversations::transport::PruneResult),
        "DeleteResult":schemars::schema_for!(crate::conversations::transport::DeleteResult),
        "ExportResult":schemars::schema_for!(crate::conversations::transport::ExportResult),
        "ExportFormat":schemars::schema_for!(crate::conversations::transport::ExportFormat),
        "ImportBatch":schemars::schema_for!(crate::runtime::conversations::legacy::ImportBatch),
        "ImportResult":schemars::schema_for!(crate::conversations::transport::ImportResult)
    }})
}
#[test]
#[ignore = "explicit conversation transport regeneration"]
fn export_conversation_contract_schema() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared/conversations/contracts.v1.json");
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&bundle()).unwrap()),
    )
    .unwrap();
}
#[test]
fn conversation_contract_matches_rust_owned_transport() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared/conversations/contracts.v1.json");
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        format!("{}\n", serde_json::to_string_pretty(&bundle()).unwrap())
    );
}
#[test]
fn conversation_display_transport_rejects_authority_and_missing_recorded_absence() {
    let value = serde_json::json!({"threadId":"thread","userMessageId":"user","assistantMessageId":"answer","parentThreadId":null,"branchMessageId":null,"displayMessage":{"text":"Visible","addressedLabel":null,"attachmentRefs":[]}});
    assert!(serde_json::from_value::<AttemptBinding>(value.clone()).is_ok());
    let mut authority = value.clone();
    authority["runId"] = serde_json::json!("caller-claimed");
    assert!(serde_json::from_value::<AttemptBinding>(authority).is_err());
    let mut missing = value;
    missing.as_object_mut().unwrap().remove("parentThreadId");
    assert!(serde_json::from_value::<AttemptBinding>(missing).is_err());
}
