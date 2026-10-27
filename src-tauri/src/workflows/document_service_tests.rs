use super::super::{definition, files::DefinitionStore};
use super::*;
struct Vault(std::path::PathBuf);
impl Vault {
    fn new() -> Self {
        Self(crate::vault::testutil::temp_vault(
            "workflow-document-service",
        ))
    }
}
impl Drop for Vault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn context() -> WorkflowContext {
    WorkflowContext {
        vault_id: "a".repeat(32),
        store_uuid: "fixture-store".into(),
    }
}
fn draft() -> WorkflowDraft {
    WorkflowDraft {
        workflow_id: "example".into(),
        entry_step_id: "done".into(),
        input_schema_json: r#"{"type":"object","properties":{},"additionalProperties":false}"#
            .into(),
        trigger_json: r#"{"kind":"manual"}"#.into(),
        steps: vec![WorkflowStepDraft {
            step_id: "done".into(),
            label: "Result".into(),
            operation: WorkflowOperationDraft::Result {
                output_json: r#"{"kind":"literal","value":9007199254740993.0000000000000001}"#
                    .into(),
            },
        }],
    }
}
fn request(draft: WorkflowDraft, etag: Option<String>) -> WorkflowSaveRequest {
    WorkflowSaveRequest {
        context: context(),
        draft,
        expected_etag: etag,
    }
}
#[test]
fn workflow_document_real_file_roundtrip_preserves_exact_decimal_and_native_provenance() {
    let vault = Vault::new();
    let saved = save(
        &vault.0,
        &request(draft(), None),
        "human:actual-native-owner",
    )
    .unwrap();
    let stored = DefinitionStore::open(&vault.0, "example")
        .unwrap()
        .read_draft()
        .unwrap()
        .unwrap();
    assert!(stored.json.contains("9007199254740993.0000000000000001"));
    let checked = definition::validate(&stored.json).unwrap();
    assert_eq!(checked.definition.authored_by, "human:actual-native-owner");
    assert!(checked.definition.declared_action_digests.is_empty());
    assert_eq!(
        checked.definition.input_schema_digest,
        crate::actions::schema::workflow_schema_digest(&draft().input_schema_json).unwrap()
    );
    let published = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: saved.etag,
            expected_publication_revision: None,
        },
    )
    .unwrap();
    assert_eq!(published.version.definition_hash, checked.definition_hash);
    assert_eq!(published.revision.get(), 1);
    let pinned = version(&vault.0, &published.version).unwrap();
    let WorkflowOperationDraft::Result { output_json } = pinned.steps[0].operation.clone() else {
        panic!("actual result mapping");
    };
    let expected = definition::canonical_json(
        r#"{"kind":"literal","value":9007199254740993.0000000000000001}"#,
    )
    .unwrap();
    assert_eq!(
        expected, r#"{"kind":"literal","value":90071992547409930000000000000001e-16}"#,
        "shared canonicalizer retains every significant digit"
    );
    assert_eq!(
        output_json, expected,
        "pinned output must preserve the exact canonical decimal value"
    );
    let document = document(&vault.0, context(), "example").unwrap();
    assert_eq!(document.publication, Some(published));
    assert!(matches!(
        document.activation,
        WorkflowActivationView::Unavailable {}
    ));
    assert!(!vault.0.join("runtime.db").exists());
    assert!(!vault
        .0
        .join(".cerebro/workflows/example/activation.json")
        .exists());
}
#[test]
fn workflow_document_incomplete_graph_is_saved_but_cannot_publish_or_replace_prior_version() {
    let vault = Vault::new();
    let first = save(&vault.0, &request(draft(), None), "human:me").unwrap();
    let published = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: first.etag.clone(),
            expected_publication_revision: None,
        },
    )
    .unwrap();
    let mut incomplete = draft();
    incomplete.entry_step_id = "missing".into();
    incomplete.steps.clear();
    let changed = save(
        &vault.0,
        &request(incomplete.clone(), Some(first.etag)),
        "human:me",
    )
    .unwrap();
    assert_eq!(changed.draft, incomplete);
    assert!(!validate(&changed.draft, "human:me").valid);
    let refused = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: changed.etag,
            expected_publication_revision: Some(published.revision),
        },
    )
    .unwrap_err();
    assert_eq!(refused.code, WorkflowErrorCode::InvalidDefinition);
    assert_eq!(
        document(&vault.0, context(), "example")
            .unwrap()
            .publication,
        Some(published)
    );
}
#[test]
fn workflow_document_malformed_leaf_and_stale_save_leave_actual_draft_intact() {
    let vault = Vault::new();
    let first = save(&vault.0, &request(draft(), None), "human:me").unwrap();
    let mut changed = draft();
    changed.steps[0].operation = WorkflowOperationDraft::Result {
        output_json: r#"{"kind":"literal","value":1,"value":2}"#.into(),
    };
    assert_eq!(
        save(
            &vault.0,
            &request(changed, Some(first.etag.clone())),
            "human:me"
        )
        .unwrap_err()
        .code,
        WorkflowErrorCode::InvalidInput
    );
    assert_eq!(
        save(
            &vault.0,
            &request(draft(), Some("b".repeat(64))),
            "human:me"
        )
        .unwrap_err()
        .code,
        WorkflowErrorCode::Conflict
    );
    assert_eq!(
        document(&vault.0, context(), "example").unwrap().draft,
        Some(first)
    );
}
#[test]
fn workflow_document_empty_catalog_and_exact_missing_version_never_create_namespace() {
    let vault = Vault::new();
    let catalog = catalog(&vault.0, context(), None).unwrap();
    assert!(catalog.items.is_empty());
    assert!(!catalog.truncated);
    assert_eq!(catalog.next_cursor, None);
    assert!(version(
        &vault.0,
        &WorkflowVersionRef {
            workflow_id: "missing".into(),
            definition_hash: "a".repeat(64)
        }
    )
    .is_err());
    assert!(!vault.0.join(".cerebro").exists());
}

#[test]
fn workflow_document_unsupported_valid_json_schema_remains_an_editable_draft() {
    let vault = Vault::new();
    let mut incomplete = draft();
    incomplete.input_schema_json =
        r#"{"type":"object","$ref":"https://example.invalid/schema"}"#.into();
    let saved = save(&vault.0, &request(incomplete.clone(), None), "human:me").unwrap();
    assert_eq!(saved.draft, incomplete);
    let restored = document(&vault.0, context(), "example").unwrap();
    assert_eq!(restored.draft, Some(saved.clone()));
    assert!(restored.publication.is_none());
    let validation = validate(&saved.draft, "human:me");
    assert!(!validation.valid);
    assert!(validation
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == WorkflowErrorCode::InvalidDefinition));
    let refused = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: saved.etag,
            expected_publication_revision: None,
        },
    )
    .unwrap_err();
    assert_eq!(refused.code, WorkflowErrorCode::InvalidDefinition);
    assert!(document(&vault.0, context(), "example")
        .unwrap()
        .publication
        .is_none());
}

#[test]
fn workflow_document_publication_counter_overflow_refuses_before_any_file_commit() {
    let vault = Vault::new();
    let first = save(&vault.0, &request(draft(), None), "human:me").unwrap();
    let published = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: first.etag.clone(),
            expected_publication_revision: None,
        },
    )
    .unwrap();
    let pointer = vault.0.join(".cerebro/workflows/example/published.json");
    let mut stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&pointer).unwrap()).unwrap();
    let maximum = crate::actions::SafeCounter::new(9_007_199_254_740_991).unwrap();
    stored["revision"] = serde_json::json!(maximum.get());
    let previous = serde_json::to_vec(&stored).unwrap();
    std::fs::write(&pointer, &previous).unwrap();
    let mut changed = draft();
    changed.steps[0].label = "Second".into();
    let saved = save(
        &vault.0,
        &request(changed.clone(), Some(first.etag)),
        "human:me",
    )
    .unwrap();
    let next_hash = definition::validate(&encode_draft(&changed, "human:me").unwrap())
        .unwrap()
        .definition_hash;
    assert_ne!(next_hash, published.version.definition_hash);
    let refusal = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: saved.etag,
            expected_publication_revision: Some(maximum),
        },
    );
    assert_eq!(
        std::fs::read(&pointer).unwrap(),
        previous,
        "counter refusal must preserve original publication bytes"
    );
    assert!(
        !vault
            .0
            .join(".cerebro/workflows/example/versions")
            .join(format!("{next_hash}.json"))
            .exists(),
        "counter refusal occurs before immutable version installation"
    );
    assert_eq!(refusal.unwrap_err().code, WorkflowErrorCode::LimitExceeded);
}
fn mismatched_stored_workflow() -> (Vault, Vec<u8>) {
    let vault = Vault::new();
    let mut wrong = draft();
    wrong.workflow_id = "other".into();
    let raw = encode_draft(&wrong, "human:me").unwrap();
    DefinitionStore::open(&vault.0, "example")
        .unwrap()
        .save_draft(&raw, None)
        .unwrap();
    let bytes = std::fs::read(vault.0.join(".cerebro/workflows/example/draft.json")).unwrap();
    (vault, bytes)
}
#[test]
fn workflow_document_refuses_draft_identity_from_a_different_directory_without_rewriting() {
    let (vault, before) = mismatched_stored_workflow();
    let result = document(&vault.0, context(), "example");
    assert!(
        matches!(
            result,
            Err(WorkflowError {
                code: WorkflowErrorCode::InvalidDefinition,
                ..
            })
        ),
        "inner draft identity must match requested original directory"
    );
    assert_eq!(
        std::fs::read(vault.0.join(".cerebro/workflows/example/draft.json")).unwrap(),
        before
    );
}
#[test]
fn workflow_catalog_marks_mismatched_draft_identity_unreadable_without_adopting_it() {
    let (vault, before) = mismatched_stored_workflow();
    let result = catalog(&vault.0, context(), None).unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].workflow_id, "example");
    assert!(
        !result.items[0].readable,
        "mismatched draft must not be presented as a readable workflow"
    );
    assert_eq!(
        std::fs::read(vault.0.join(".cerebro/workflows/example/draft.json")).unwrap(),
        before
    );
}

#[test]
fn workflow_document_saved_json_leaves_strip_only_outer_json_whitespace_without_rounding() {
    let vault = Vault::new();
    let mut original = draft();
    original.input_schema_json = format!(" \n{}\t ", original.input_schema_json);
    original.trigger_json = format!("\r {} \n", original.trigger_json);
    let exact = r#"{ "kind": "literal", "value": 9007199254740993.0000000000000001 }"#;
    original.steps[0].operation = WorkflowOperationDraft::Result {
        output_json: format!(" \n{exact} \t"),
    };
    let saved = save(&vault.0, &request(original.clone(), None), "human:me").unwrap();
    assert_eq!(
        saved.draft.input_schema_json,
        original
            .input_schema_json
            .trim_matches([' ', '\n', '\r', '\t'])
    );
    assert_eq!(
        saved.draft.trigger_json,
        original.trigger_json.trim_matches([' ', '\n', '\r', '\t'])
    );
    let WorkflowOperationDraft::Result { output_json } = &saved.draft.steps[0].operation else {
        panic!("result")
    };
    assert_eq!(
        output_json, exact,
        "interior whitespace and every numeric digit remain exact"
    );
    assert_eq!(
        document(&vault.0, context(), "example").unwrap().draft,
        Some(saved)
    );
}

#[test]
fn workflow_document_never_published_revision_is_explicit_zero() {
    let vault = Vault::new();
    save(&vault.0, &request(draft(), None), "human:me").unwrap();
    let read = document(&vault.0, context(), "example").unwrap();
    assert_eq!(read.publication_revision.get(), 0);
    assert!(read.publication.is_none());
}
#[test]
fn workflow_document_tombstone_keeps_revision_for_exact_republish() {
    let vault = Vault::new();
    let saved = save(&vault.0, &request(draft(), None), "human:me").unwrap();
    let first = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: saved.etag.clone(),
            expected_publication_revision: None,
        },
    )
    .unwrap();
    let published = document(&vault.0, context(), "example").unwrap();
    assert_eq!(published.publication_revision, first.revision);
    {
        let store = DefinitionStore::open(&vault.0, "example").unwrap();
        store
            .begin_publication_edit()
            .unwrap()
            .unpublish(
                &files::PublicationRef {
                    workflow_id: "example".into(),
                    definition_hash: first.version.definition_hash.clone(),
                    revision: first.revision.get(),
                },
                "dddddddddddddddddddddddddddddddd",
            )
            .unwrap();
    }
    let original_bytes =
        std::fs::read(vault.0.join(".cerebro/workflows/example/published.json")).unwrap();
    let tombstone = document(&vault.0, context(), "example").unwrap();
    assert!(tombstone.publication.is_none());
    assert_eq!(
        tombstone.publication_revision.get(),
        2,
        "unpublished is distinct from never published"
    );
    assert_eq!(tombstone.draft, Some(saved.clone()));
    assert!(tombstone.versions.contains(&first.version));
    assert_eq!(
        std::fs::read(vault.0.join(".cerebro/workflows/example/published.json")).unwrap(),
        original_bytes
    );
    assert_eq!(
        publish(
            &vault.0,
            &WorkflowPublishRequest {
                context: context(),
                workflow_id: "example".into(),
                expected_draft_etag: saved.etag.clone(),
                expected_publication_revision: None,
            }
        )
        .unwrap_err()
        .code,
        WorkflowErrorCode::Conflict
    );
    let republished = publish(
        &vault.0,
        &WorkflowPublishRequest {
            context: context(),
            workflow_id: "example".into(),
            expected_draft_etag: saved.etag,
            expected_publication_revision: Some(tombstone.publication_revision),
        },
    )
    .unwrap();
    assert_eq!(republished.revision.get(), 3);
    let current = document(&vault.0, context(), "example").unwrap();
    assert_eq!(current.publication_revision, republished.revision);
    assert_eq!(current.publication, Some(republished));
}
