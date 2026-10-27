use super::{legacy, types::*};
use crate::vault::{testutil, write};

fn schema_bundle() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "types": {
            "LegacyRecordLocator": schemars::schema_for!(LegacyRecordLocator),
            "LegacyRecordSnapshot": schemars::schema_for!(LegacyRecordSnapshot),
            "StoreError": schemars::schema_for!(StoreError),
            "PropertyValue": schemars::schema_for!(values::PropertyValue),
            "PropertyChange": schemars::schema_for!(values::PropertyChange),
            "ValueSchema": schemars::schema_for!(values::ValueSchema),
            "ValueError": schemars::schema_for!(values::ValueError),
            "SelectedRecordVersion": schemars::schema_for!(selected::SelectedRecordVersion),
            "SelectedEntryProperties": schemars::schema_for!(selected::SelectedEntryProperties),
            "SelectedSavedViewRequest": schemars::schema_for!(super::selected::SelectedSavedViewRequest),
            "SelectedSavedViewRecord": schemars::schema_for!(super::selected::SelectedSavedViewRecord),
            "SelectedSavedViewColumn": schemars::schema_for!(super::selected::SelectedSavedViewColumn),
            "SelectedSavedViewLayout": schemars::schema_for!(super::selected::SelectedSavedViewLayout),
            "SelectedSavedViewFrame": schemars::schema_for!(super::selected::SelectedSavedViewFrame),
            "SelectedMode": schemars::schema_for!(selected::SelectedMode),
            "SelectedMetadataAck": schemars::schema_for!(selected::SelectedMetadataAck),
            "SelectedEditorTarget": schemars::schema_for!(super::selected::SelectedEditorTarget),
            "EditorSaveRefusal": schemars::schema_for!(super::selected::EditorSaveRefusal),
            "EditorSaveRequest": schemars::schema_for!(super::selected::EditorSaveRequest),
            "MetadataPatchRequest": schemars::schema_for!(super::selected::MetadataPatchRequest),
            "MetadataPatchOperation": schemars::schema_for!(super::selected::MetadataPatchOperation),
            "MetadataPatchResult": schemars::schema_for!(super::selected::MetadataPatchResult),
            "MetadataPatchRefusal": schemars::schema_for!(super::selected::MetadataPatchRefusal),
            "SelectedPropertySnapshot": schemars::schema_for!(super::selected::SelectedPropertySnapshot),
            "SelectedPropertyValue": schemars::schema_for!(super::selected::SelectedPropertyValue),
            "EditorOperation": schemars::schema_for!(super::selected::EditorOperation),
            "EditorReceiptView": schemars::schema_for!(super::selected::EditorReceiptView),
            "SelectedEditorSnapshot": schemars::schema_for!(super::selected::SelectedEditorSnapshot),
            "SelectedBodyObservation": schemars::schema_for!(super::selected::SelectedBodyObservation),
            "EditorSaveResult": schemars::schema_for!(super::selected::EditorSaveResult),

            "AuthorityError": schemars::schema_for!(selected::AuthorityError),
            "CommandReadError": schemars::schema_for!(selected::CommandReadError),
            "WorkspaceBackupAvailability": schemars::schema_for!(super::backup_types::WorkspaceBackupAvailability),
            "WorkspaceBackupChoiceResult": schemars::schema_for!(super::backup_types::WorkspaceBackupChoiceResult),
            "WorkspaceBackupCommitResult": schemars::schema_for!(super::backup_types::WorkspaceBackupCommitResult),
            "WorkspaceBackupCancelResult": schemars::schema_for!(super::backup_types::WorkspaceBackupCancelResult),
            "WorkspaceBackupOperation": schemars::schema_for!(super::backup_types::WorkspaceBackupOperation),
            "WorkspaceBackupReview": schemars::schema_for!(super::backup_types::WorkspaceBackupReview),
            "WorkspaceBackupSummary": schemars::schema_for!(super::backup_types::WorkspaceBackupSummary),
            "WorkspaceBackupRefusal": schemars::schema_for!(super::backup_types::WorkspaceBackupRefusal),
            "WorkspaceBackupDisposition": schemars::schema_for!(super::backup_types::WorkspaceBackupDisposition),
        }
    })
}

fn schema_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/workspace/contracts.v1.json")
}

#[test]
fn rust_declarations_match_the_committed_contract_schema() {
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(schema_path()).unwrap()).unwrap();
    assert_eq!(
        schema_bundle(),
        committed,
        "regenerate the Rust contract schema before its TS projection"
    );
}

#[test]
#[ignore = "explicitly regenerate the Rust-owned schema; see shared/workspace/README.md"]
fn export_workspace_contract_schema() {
    let bytes = format!(
        "{}\n",
        serde_json::to_string_pretty(&schema_bundle()).unwrap()
    );
    std::fs::write(schema_path(), bytes).unwrap();
}

#[test]
fn internal_errors_use_an_existing_operational_code_and_never_claim_automatic_retry() {
    let error = StoreError {
        code: StoreErrorCode::CapabilityUnavailable,
        message: "The existing reader could not return this source.".into(),
        retryable: false,
    };
    let serialized = serde_json::to_value(error).unwrap();
    assert_eq!(
        serialized,
        serde_json::json!({
            "code": "capability_unavailable",
            "message": "The existing reader could not return this source.",
            "retryable": false,
        })
    );
    let policy: serde_json::Value =
        serde_json::from_str(include_str!("../../../shared/policy/policy.v3.json")).unwrap();
    assert_eq!(
        policy["rejection_destinies"][serialized["code"].as_str().unwrap()],
        "operational"
    );
}

fn fixtures() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../shared/workspace/legacy-source-cases.v1.json"
    ))
    .unwrap()
}

#[test]
fn reads_exact_source_and_same_read_hash_without_projecting_metadata() {
    let vault = testutil::temp_vault("workspace-service-source");
    for case in fixtures()["reads"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        let expected: LegacyRecordSnapshot =
            serde_json::from_value(case["expected"].clone()).unwrap();
        testutil::write(&vault, path, &expected.content);
        let read = legacy::read_record(&vault, &LegacyRecordLocator { path: path.into() }).unwrap();
        assert_eq!(read, expected, "{}", case["name"]);
        assert_eq!(serde_json::to_value(read).unwrap(), case["expected"]);
        assert_eq!(
            std::fs::read(vault.join(path)).unwrap(),
            expected.content.as_bytes()
        );
        assert!(
            !vault.join(".cerebro").exists(),
            "a read must not mint identity or metadata"
        );
    }
    std::fs::remove_dir_all(vault).unwrap();
}

#[test]
fn source_changes_are_read_fresh_and_empty_is_a_real_success() {
    let vault = testutil::temp_vault("workspace-service-fresh");
    let locator = LegacyRecordLocator {
        path: "notes/a.md".into(),
    };
    testutil::write(&vault, &locator.path, "old");
    let old = legacy::read_record(&vault, &locator).unwrap();
    testutil::write(&vault, &locator.path, "");
    let empty = legacy::read_record(&vault, &locator).unwrap();
    assert_eq!(empty.content, "");
    assert_eq!(
        empty.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_ne!(old.hash, empty.hash);
    std::fs::remove_dir_all(vault).unwrap();
}

#[test]
fn refuses_the_existing_targets_and_preserves_the_original_failure() {
    let vault = testutil::temp_vault("workspace-service-refused");
    for path in fixtures()["refusedPaths"].as_array().unwrap() {
        let path = path.as_str().unwrap();
        let error =
            legacy::read_record(&vault, &LegacyRecordLocator { path: path.into() }).unwrap_err();
        assert_eq!(
            error.message,
            write::read_note_source(&vault, path).unwrap_err()
        );
        assert_eq!(error.code, StoreErrorCode::CapabilityUnavailable);
        assert!(!error.retryable);
    }
    std::fs::remove_dir_all(vault).unwrap();
}

#[test]
fn an_unavailable_or_non_utf8_file_is_an_error_and_never_empty() {
    let vault = testutil::temp_vault("workspace-service-unavailable");
    let path = fixtures()["unavailablePath"].as_str().unwrap().to_string();
    let missing =
        legacy::read_record(&vault, &LegacyRecordLocator { path: path.clone() }).unwrap_err();
    assert_eq!(
        missing.message,
        write::read_note_source(&vault, &path).unwrap_err()
    );
    testutil::write(&vault, &path, "placeholder");
    std::fs::write(vault.join(&path), [0xff, 0xfe]).unwrap();
    let invalid =
        legacy::read_record(&vault, &LegacyRecordLocator { path: path.clone() }).unwrap_err();
    assert_eq!(
        invalid.message,
        write::read_note_source(&vault, &path).unwrap_err()
    );
    assert!(!invalid.retryable);
    std::fs::remove_dir_all(vault).unwrap();
}

#[cfg(unix)]
#[test]
fn cannot_read_through_a_symlink_outside_the_vault() {
    let vault = testutil::temp_vault("workspace-service-symlink");
    let outside = testutil::temp_vault("workspace-service-outside");
    testutil::write(&outside, "secret.md", "private outside bytes");
    std::os::unix::fs::symlink(outside.join("secret.md"), vault.join("escape.md")).unwrap();
    let error = legacy::read_record(
        &vault,
        &LegacyRecordLocator {
            path: "escape.md".into(),
        },
    )
    .unwrap_err();
    assert!(!error.message.contains("private outside bytes"));
    assert_eq!(
        error.message,
        write::read_note_source(&vault, "escape.md").unwrap_err()
    );
    std::fs::remove_dir_all(vault).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}
