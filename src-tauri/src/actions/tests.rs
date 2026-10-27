use super::{catalog::*, schema::*, types::*};
use serde_json::{json, Value};
fn cases() -> Value {
    serde_json::from_str(include_str!("../../../shared/actions/cases.v1.json")).unwrap()
}
#[test]
fn replays_canonical_cases_without_precision_loss() {
    for c in cases()["canonicalCases"].as_array().unwrap() {
        let got = canonicalize(c["source"].as_str().unwrap(), false).unwrap();
        assert_eq!(
            got.canonical,
            c["canonical"].as_str().unwrap(),
            "{}",
            c["name"]
        );
        assert_eq!(got.digest, digest(got.canonical.as_bytes()));
    }
    for c in cases()["invalidJson"].as_array().unwrap() {
        assert!(canonicalize(c.as_str().unwrap(), false).is_err(), "{c}");
    }
}
#[test]
fn replays_schema_and_unsupported_cases() {
    for c in cases()["schemaCases"].as_array().unwrap() {
        let schema = compile_schema(&c["schema"].to_string()).unwrap();
        assert_eq!(
            validate(&schema, c["input"].as_str().unwrap()).is_ok(),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
    }
    for c in cases()["unsupportedSchemas"].as_array().unwrap() {
        assert_eq!(
            compile_schema(&c["schema"].to_string()).unwrap_err().code,
            ActionErrorCode::UnsupportedSchema,
            "{}",
            c["name"]
        );
    }
}
fn material(schema: &str) -> DefinitionMaterial {
    DefinitionMaterial {
        action_id: ActionId("fixture:send".into()),
        input_schema: schema.into(),
        output_schema: "{\"type\":\"null\"}".into(),
        adapter_revision: "fixture-v1".into(),
        effect_class: EffectClass::ExternalSend,
        required_capabilities: vec!["fixture:send".into()],
        retry: RetryContract::Never,
        cancel: false,
        reconcile: false,
        secret_input_fields: Vec::new(),
    }
}
#[test]
fn definition_digest_changes_with_schema_and_history_survives_export_import() {
    let mut catalog = ActionCatalog::default();
    let old = catalog
        .insert(material("{\"type\":\"string\"}"), "{}")
        .unwrap();
    let new = catalog
        .insert(material("{\"type\":\"string\",\"minLength\":1}"), "{}")
        .unwrap();
    assert_ne!(old.definition_digest, new.definition_digest);
    let bytes = catalog
        .export(&old.action_id, &old.definition_digest)
        .unwrap();
    let mut restarted = ActionCatalog::default();
    restarted.import(&bytes).unwrap();
    assert_eq!(
        restarted
            .resolve(&old.action_id, &old.definition_digest)
            .unwrap(),
        old
    );
    let tampered = bytes.replace("fixture-v1", "fixture-v2");
    assert_eq!(
        restarted.import(&tampered).unwrap_err().code,
        ActionErrorCode::DefinitionMismatch
    );
    assert_eq!(
        catalog
            .resolve(&old.action_id, &old.definition_digest)
            .unwrap(),
        old
    );
    assert!(validate_input(&old, "\"ok\"").is_ok());
    assert!(validate_input(&old, "null").is_err());
}
#[test]
fn local_classification_ignores_provider_annotations() {
    for c in cases()["effectCases"].as_array().unwrap() {
        let effect: EffectClass = serde_json::from_value(c["local"].clone()).unwrap();
        let mut trusted = material("{\"type\":\"string\"}");
        trusted.effect_class = effect;
        let mut catalog = ActionCatalog::default();
        let definition = catalog.insert(trusted, &c["provider"].to_string()).unwrap();
        assert_eq!(
            serde_json::to_value(definition.effect_class).unwrap(),
            c["expected"]
        );
        let exported = catalog
            .export(&definition.action_id, &definition.definition_digest)
            .unwrap();
        assert!(!exported.contains("providerAnnotations"));
    }
}
#[test]
fn bounds_apply_before_materialization_and_duplicate_values() {
    for source in [
        format!("[{}]", vec!["null"; 1025].join(",")),
        format!("\"{}\"", "x".repeat(8193)),
        format!("{}0{}", "[".repeat(33), "]".repeat(33)),
        " ".repeat(65537),
    ] {
        assert!(canonicalize(&source, false).is_err());
    }
    assert_eq!(
        canonicalize("{\"a\":1,\"a\":[broken]}", false)
            .unwrap_err()
            .message,
        "Duplicate object key."
    );
}
fn bundle() -> Value {
    json!({"version":1,"types":{
        "ChatRecoveryInspection":schemars::schema_for!(super::recovery_read_types::ChatRecoveryInspection),
        "InvocationState":schemars::schema_for!(InvocationState),
        "ActionSubjectView":schemars::schema_for!(ActionSubjectView),
        "ActionEffectDetails":schemars::schema_for!(ActionEffectDetails),
        "PrepareAction":schemars::schema_for!(PrepareAction),
        "PreparedAction":schemars::schema_for!(PreparedAction),
        "ActionCatalogPage":schemars::schema_for!(ActionCatalogPage),
        "ActionDefinitionView":schemars::schema_for!(ActionDefinitionView),
        "ActionError":schemars::schema_for!(ActionError),
        "ActionReadError":schemars::schema_for!(ActionReadError),
        "ConnectionStatus":schemars::schema_for!(crate::connections::ConnectionStatus),
        "ConnectionError":schemars::schema_for!(crate::connections::ConnectionError),
        "ManagedConnectionPage":schemars::schema_for!(crate::connections::metadata::ManagedConnectionPage),
        "CredentialAcquisitionView":schemars::schema_for!(crate::connections::metadata::CredentialAcquisitionView),
        "RunActionAccessView":schemars::schema_for!(super::native_owner::RunActionAccessView),
        "SetRunActionAccess":schemars::schema_for!(super::native_owner::SetRunActionAccess),
        "SetRunActionAccessResult":schemars::schema_for!(super::native_owner::SetRunActionAccessResult)
    }})
}
#[test]
fn rust_declarations_match_committed_schema() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared/actions/contracts.v1.json");
    // Compare exporter bytes directly. Re-parsing Schemars' f64 bounds through
    // serde_json without float_roundtrip can round MAX_SAFE_INTEGER down by one.
    // The wire cap remains the exact checked u64 and JS-safe integer projection.
    let committed = std::fs::read_to_string(path).unwrap();
    assert_eq!(
        format!("{}\n", serde_json::to_string_pretty(&bundle()).unwrap()),
        committed
    );
}
#[test]
#[ignore = "explicit contract regeneration"]
fn export_action_contract_schema() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../shared/actions/contracts.v1.json");
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&bundle()).unwrap()),
    )
    .unwrap();
}
#[test]
fn counters_refuse_unsafe_transport_and_overflow() {
    assert!(serde_json::from_str::<SafeCounter>("9007199254740992").is_err());
    assert!(serde_json::from_str::<SafeCounter>("-1").is_err());
    assert!(serde_json::from_str::<SafeCounter>("1.5").is_err());
    assert!(SafeCounter::new(9007199254740991).unwrap().next().is_err());
    assert_eq!(
        serde_json::to_string(&SafeCounter::new(41).unwrap().next().unwrap()).unwrap(),
        "42"
    );
}
#[test]
fn output_is_validated_and_never_reports_a_remote_failure() {
    let definition = ActionCatalog::default()
        .insert(material("{\"type\":\"string\"}"), "{}")
        .unwrap();
    assert!(validate_output(&definition, "null").is_ok());
    assert_eq!(
        validate_output(&definition, "{}").unwrap_err().code,
        ActionErrorCode::InvalidInput
    );
    // Validation has no invocation state or dispatch path to mark failed.
}
#[test]
fn no_unsupported_definition_enters_the_catalog() {
    let mut catalog = ActionCatalog::default();
    for c in cases()["unsupportedSchemas"].as_array().unwrap() {
        assert_eq!(
            catalog
                .insert(material(&c["schema"].to_string()), "{}")
                .unwrap_err()
                .code,
            ActionErrorCode::UnsupportedSchema
        );
    }
    assert_eq!(
        catalog
            .resolve(
                &ActionId("fixture:send".into()),
                &DefinitionDigest("absent".into())
            )
            .unwrap_err()
            .code,
        ActionErrorCode::NotFound
    );
}
#[test]
fn action_policy_bytes_match_the_committed_digest() {
    assert_eq!(
        digest(POLICY.as_bytes()),
        include_str!("../../../shared/policy/actions.v1.sha256").trim()
    );
}
#[test]
#[ignore = "explicitly regenerate action policy byte anchor"]
fn write_action_policy_digest() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/policy/actions.v1.sha256");
    std::fs::write(path, format!("{}\n", digest(POLICY.as_bytes()))).unwrap();
}

#[test]
fn declared_secret_inputs_are_explicitly_unsupported_and_never_echoed() {
    for c in cases()["secretCases"].as_array().unwrap() {
        let mut m = material("{\"type\":\"object\"}");
        m.secret_input_fields = serde_json::from_value(c["fields"].clone()).unwrap();
        let rejected = ActionCatalog::default().insert(m, "{}").unwrap_err();
        assert_eq!(rejected.code, ActionErrorCode::UnsupportedSchema);
        assert!(!serde_json::to_string(&rejected)
            .unwrap()
            .contains("SECRET_SENTINEL_ONLY"));
    }
}

#[test]
fn shared_transport_keeps_unknown_outcome_and_required_nulls() {
    for c in cases()["transportCases"].as_array().unwrap() {
        let details: ActionEffectDetails = serde_json::from_value(c["details"].clone()).unwrap();
        assert_eq!(serde_json::to_value(details).unwrap(), c["details"]);
    }
}

#[test]
fn omitted_nullable_inspection_fields_are_not_recorded_nulls() {
    assert!(serde_json::from_value::<ActionEffectRef>(
        json!({"invocationId":"i","state":"outcome_unknown","canRetry":false,"canReconcile":false})
    )
    .is_err());
}

#[test]
fn accepted_escaped_material_exports_and_imports_in_a_fresh_catalog() {
    let mut source = material("{\"type\":\"string\"}");
    source.required_capabilities = vec!["\u{0001}".repeat(40); 500];
    let mut catalog = ActionCatalog::default();
    let definition = catalog.insert(source, "{}").unwrap();
    let bytes = catalog
        .export(&definition.action_id, &definition.definition_digest)
        .unwrap();
    let mut restored = ActionCatalog::default();
    assert_eq!(restored.import(&bytes).unwrap(), definition);
    assert_eq!(
        restored
            .export(&definition.action_id, &definition.definition_digest)
            .unwrap(),
        bytes
    );
}

#[test]
fn oversized_complete_envelope_is_rejected_before_catalog_mutation() {
    let mut source = material("{\"type\":\"string\"}");
    source.required_capabilities = vec!["\u{0001}".repeat(40); 1000];
    // Derive the lookup selector without admitting the material to a catalog.
    let canonical = parse_bounded(
        &serde_json::to_string(&source).unwrap(),
        limits().definition_bytes,
    )
    .unwrap()
    .canonical();
    let rejected_digest = DefinitionDigest(digest(canonical.as_bytes()));
    let mut catalog = ActionCatalog::default();
    let original = catalog
        .insert(material("{\"type\":\"string\"}"), "{}")
        .unwrap();
    let original_bytes = catalog
        .export(&original.action_id, &original.definition_digest)
        .unwrap();
    let error = catalog.insert(source, "{}").unwrap_err();
    assert_eq!(error.code, ActionErrorCode::LimitExceeded);
    assert_eq!(
        catalog
            .resolve(&original.action_id, &rejected_digest)
            .unwrap_err()
            .code,
        ActionErrorCode::NotFound
    );
    assert_eq!(
        catalog
            .export(&original.action_id, &original.definition_digest)
            .unwrap(),
        original_bytes
    );
    let mut restored = ActionCatalog::default();
    assert_eq!(restored.import(&original_bytes).unwrap(), original);
}

// Approved first-provider definitions are local material, not remote discovery,
// account grants, native caller authentication or an executable provider route.
#[test]
fn compiled_first_provider_definitions_keep_approved_ids_and_effects() {
    let artifact: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    assert_eq!(artifact["version"], 1);
    assert_eq!(artifact["source"], "compiled_local_definitions");
    let entries = artifact["definitions"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let mut catalog = ActionCatalog::default();
    for (index, (expected, effect)) in [
        ("github.issue.read", EffectClass::Read),
        ("github.issue.create", EffectClass::ExternalMutation),
    ]
    .into_iter()
    .enumerate()
    {
        let material: DefinitionMaterial = serde_json::from_value(entries[index].clone()).unwrap();
        let definition = catalog.insert(material, "{}").unwrap();
        assert_eq!(definition.action_id.0, expected);
        assert_eq!(definition.effect_class, effect);
        assert_eq!(definition.required_capabilities, vec![expected.to_string()]);
        assert_eq!(definition.retry, RetryContract::Never);
        assert!(!definition.cancel && !definition.reconcile);
        let envelope = catalog
            .export(&definition.action_id, &definition.definition_digest)
            .unwrap();
        let mut restored = ActionCatalog::default();
        assert_eq!(restored.import(&envelope).unwrap(), definition);
    }
}

#[test]
fn first_provider_dotted_namespace_rejects_empty_and_unsafe_segments() {
    let artifact: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    for id in [
        "github..issue",
        ".github.issue",
        "github.issue.",
        "github.issue read",
        "github.\nissue",
    ] {
        let mut material: DefinitionMaterial =
            serde_json::from_value(artifact["definitions"][0].clone()).unwrap();
        material.action_id = ActionId(id.into());
        assert!(
            ActionCatalog::default().insert(material, "{}").is_err(),
            "accepted {id:?}"
        );
    }
    let mut legacy: DefinitionMaterial =
        serde_json::from_value(artifact["definitions"][0].clone()).unwrap();
    legacy.action_id = ActionId("legacy:issue-read".into());
    assert!(ActionCatalog::default().insert(legacy, "{}").is_ok());
}

#[test]
fn replays_approved_action_id_namespace_cases() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../shared/actions/action-id-cases.v1.json"
    ))
    .unwrap();
    let artifact: Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    for case in cases["cases"].as_array().unwrap() {
        let mut material: DefinitionMaterial =
            serde_json::from_value(artifact["definitions"][0].clone()).unwrap();
        material.action_id = ActionId(case["id"].as_str().unwrap().into());
        assert_eq!(
            ActionCatalog::default().insert(material, "{}").is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
    }
}

#[test]
fn malformed_colon_action_ids_are_not_legacy_compatibility() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../shared/actions/action-id-cases.v1.json"
    ))
    .unwrap();
    let artifact: Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    for case in cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["id"].as_str().unwrap().contains(':'))
    {
        let mut material: DefinitionMaterial =
            serde_json::from_value(artifact["definitions"][0].clone()).unwrap();
        material.action_id = ActionId(case["id"].as_str().unwrap().into());
        assert_eq!(
            ActionCatalog::default().insert(material, "{}").is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
    }
}

#[test]
fn compiled_provider_output_schema_refuses_missing_fields_and_over_parser_bound() {
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    let mut catalog = ActionCatalog::default();
    for material in source["definitions"].as_array().unwrap() {
        let definition = catalog
            .insert(serde_json::from_value(material.clone()).unwrap(), "{}")
            .unwrap();
        let cap = super::schema::limits().string_bytes;
        let mut output = serde_json::json!({"issueId":"42", "repository":"owner/repo", "number":1, "url":"https://github.com/owner/repo/issues/1", "title":"Example", "body":"x".repeat(cap)});
        assert!(super::schema::validate_output(&definition, &output.to_string()).is_ok());
        output["body"] = serde_json::json!("x".repeat(cap + 1));
        assert_eq!(
            super::schema::validate_output(&definition, &output.to_string())
                .unwrap_err()
                .code,
            ActionErrorCode::LimitExceeded
        );
        output["body"] = serde_json::json!("");
        output.as_object_mut().unwrap().remove("url");
        assert_eq!(
            super::schema::validate_output(&definition, &output.to_string())
                .unwrap_err()
                .code,
            ActionErrorCode::InvalidInput
        );
    }
}

#[test]
fn managed_account_wire_contract_is_closed_nullable_and_exact_for_javascript() {
    let status =
        serde_json::to_value(schemars::schema_for!(crate::connections::ConnectionStatus)).unwrap();
    assert_eq!(status["additionalProperties"], false);
    assert!(status["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "account"));
    assert!(status["properties"].get("secretRef").is_none());
    for name in ["revision", "secretRevision", "revocationGeneration"] {
        assert_eq!(
            status["properties"][name]["maximum"].as_f64(),
            Some(9_007_199_254_740_991.0)
        );
        assert!(status["properties"][name].get("format").is_none());
    }
    assert_eq!(
        status["definitions"]["AccountBinding"]["additionalProperties"],
        false
    );
    assert_eq!(
        status["definitions"]["AccountBinding"]["properties"]["accountRevision"]["maximum"]
            .as_f64(),
        Some(9_007_199_254_740_991.0)
    );
    let page = serde_json::to_value(schemars::schema_for!(
        crate::connections::metadata::ManagedConnectionPage
    ))
    .unwrap();
    assert_eq!(page["additionalProperties"], false);
    assert!(page["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "nextCursor"));
}

#[test]
fn acquisition_view_omits_owner_and_requires_the_nullable_error_key() {
    use crate::actions::ids::{AttemptId, ConnectionId};
    use crate::connections::{
        metadata::CredentialAcquisitionView, AcquisitionState, CredentialAcquisition,
    };
    let internal = CredentialAcquisition {
        attempt_id: AttemptId("0123456789abcdef0123456789abcdef".into()),
        connection_id: ConnectionId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
        person: "INTERNAL_OWNER_MUST_NOT_REACH_VIEW".into(),
        host: "github.com".into(),
        login: "alice".into(),
        expected_revision: 2,
        revocation_generation: 0,
        state: AcquisitionState::Pending,
        error: None,
        observed_at: "2026-10-24T00:00:00.000Z".into(),
    };
    let view = CredentialAcquisitionView::from(&internal);
    let encoded = serde_json::to_value(&view).unwrap();
    let object = encoded.as_object().unwrap();
    assert_eq!(object.len(), 9);
    assert!(!object.contains_key("person"));
    assert_eq!(object.get("error"), Some(&Value::Null));
    assert!(!serde_json::to_string(&encoded)
        .unwrap()
        .contains(&internal.person));
    let mut missing = encoded.clone();
    missing.as_object_mut().unwrap().remove("error");
    assert!(serde_json::from_value::<CredentialAcquisitionView>(missing).is_err());
    let mut forged = encoded;
    forged["person"] = json!("wire-owner");
    assert!(serde_json::from_value::<CredentialAcquisitionView>(forged).is_err());
    let schema = serde_json::to_value(schemars::schema_for!(CredentialAcquisitionView)).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    assert!(schema["properties"].get("person").is_none());
}
