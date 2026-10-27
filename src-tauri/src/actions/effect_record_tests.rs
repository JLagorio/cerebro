//! Bounded stored-codec acceptance. These are real production decoder calls.
use super::*;
use serde_json::{json, Value};
pub(in crate::actions) fn fixture(scope: &ActionSubjectView, ordinal: usize) -> Value {
    let definition = super::super::catalog::ActionCatalog::default()
        .insert(
            DefinitionMaterial {
                action_id: ActionId("fixture:read".into()),
                input_schema: "{\"type\":\"string\"}".into(),
                output_schema: "{\"type\":\"null\"}".into(),
                adapter_revision: "v1".into(),
                effect_class: EffectClass::Read,
                required_capabilities: vec![],
                retry: RetryContract::Never,
                cancel: false,
                reconcile: false,
                secret_input_fields: vec![],
            },
            "{}",
        )
        .unwrap();
    let request = PrepareAction {
        action_id: definition.action_id.clone(),
        definition_digest: definition.definition_digest.clone(),
        connection_id: ConnectionId("connection".into()),
        account_id: AccountId("account".into()),
        snapshot_digest: SnapshotDigest("a".repeat(64)),
        input: "\"private-request\"".into(),
        request_key: format!("request-{ordinal}"),
    };
    let input_digest = schema::canonicalize(&request.input, false).unwrap().digest;
    json!({"lookup_version":1,"scope":scope,"request":request,"request_digest":request_digest(&request).unwrap(),"definition":definition,
        "binding":{"account_id":"account","account_identity_digest":schema::digest(br#"["issuer","subject"]"#),"account_revision":1,"account_label":"Safe account","grant_digest":"b".repeat(64),"policy_digest":"c".repeat(64),"revocation_generation":0,"snapshot_digest":"a".repeat(64)},
        "target":{"conflict_domain":"fixture","target":{"kind":"record","label":"Safe target","safeReference":"safe-reference"}},
        "canonical_input":"\"private-request\"","fence":null,
        "details":{"effect":{"invocationId":format!("{ordinal:032x}"),"state":"outcome_unknown","approvalId":null,"accountLabel":"Safe account","canRetry":true,"canReconcile":true},
            "revision":1,"account":{"accountId":"account","label":"Safe account","accountRevision":1},"target":{"kind":"record","label":"Safe target","safeReference":"safe-reference"},
            "definitionDigest":definition.definition_digest,"inputDigest":input_digest,"preview":{"summary":"Safe preview","fields":[{"label":"Label","value":"Safe value"}],"redactedFields":[]},"approval":null,
            "attempts":[{"attemptId":format!("{:032x}",ordinal+10000),"ordinal":1,"state":"outcome_unknown","dispatchedAt":"2026-10-25T00:00:00Z","observedAt":null,"receiptId":null,"remoteEffectReference":"safe-remote","outcomeSummary":"unknown"}]},
        "approval":null,"cancel_requested":false,"retry_decisions":[]})
}
fn scope() -> ActionSubjectView {
    ActionSubjectView {
        vault_id: "vault".into(),
        run_id: "root".into(),
        actor_id: "human:me".into(),
        child_job_id: None,
        client_id: None,
    }
}
#[test]
fn history_codec_preserves_exact_shared_persistence_and_versions() {
    let v = fixture(&scope(), 1);
    let raw = v.to_string();
    let decoded = decode_history(&raw).unwrap();
    assert_eq!(serde_json::to_value(&decoded).unwrap(), v);
    assert_eq!(decoded.lookup_version, 1);
    let mut legacy = v;
    legacy.as_object_mut().unwrap().remove("lookup_version");
    let request: PrepareAction = serde_json::from_value(legacy["request"].clone()).unwrap();
    legacy["request_digest"] = json!(legacy_request_digest(&request).unwrap());
    assert_eq!(
        decode_history(&legacy.to_string()).unwrap().lookup_version,
        0
    );
    legacy["lookup_version"] = json!(2);
    assert!(decode_history(&legacy.to_string()).is_err());
}
#[test]
fn history_codec_requires_nullable_fields_and_exact_positive_counters() {
    for pointer in [
        "/details/effect/accountLabel",
        "/details/account",
        "/details/target",
        "/details/approval",
        "/details/attempts/0/observedAt",
    ] {
        let mut v = fixture(&scope(), 1);
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        v.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(decode_history(&v.to_string()).is_err(), "{pointer}");
    }
    for pointer in [
        "/details/revision",
        "/details/account/accountRevision",
        "/details/attempts/0/ordinal",
    ] {
        for invalid in [json!(0), json!(-1), json!(1.5), json!(9007199254740992_u64)] {
            let mut v = fixture(&scope(), 1);
            *v.pointer_mut(pointer).unwrap() = invalid;
            assert!(decode_history(&v.to_string()).is_err(), "{pointer}");
        }
    }
}
#[test]
fn history_codec_streams_limits_before_building_the_record() {
    for raw in [
        format!("{}0{}", "[".repeat(33), "]".repeat(33)),
        format!("[{}]", vec!["0"; 1025].join(",")),
        format!(
            "{{{}}}",
            (0..257)
                .map(|i| format!("\"k{i}\":0"))
                .collect::<Vec<_>>()
                .join(",")
        ),
        "{\"x\":0,\"x\":1}".into(),
        format!("\"{}\"", "x".repeat(262145)),
    ] {
        assert!(structural_check(&raw).is_err());
    }
    for pointer in [
        "/details/attempts",
        "/retry_decisions",
        "/details/preview/fields",
        "/details/preview/redactedFields",
    ] {
        let mut v = fixture(&scope(), 1);
        *v.pointer_mut(pointer).unwrap() = json!(vec![Value::Null; 33]);
        assert!(decode_history(&v.to_string()).is_err(), "{pointer}");
    }
    let mut v = fixture(&scope(), 1);
    v["details"]["preview"]["fields"][0]["value"] = json!("é".repeat(4097));
    assert!(decode_history(&v.to_string()).is_err());
    let mut v = fixture(&scope(), 1);
    let attempt = v["details"]["attempts"][0].clone();
    v["details"]["attempts"]
        .as_array_mut()
        .unwrap()
        .push(attempt);
    assert!(decode_history(&v.to_string()).is_err());
}
#[test]
fn history_counting_serializer_caps_escaped_utf8_without_allocating_output() {
    assert_eq!(serialized_size(&"é", 4), Ok(4));
    assert!(serialized_size(&"é", 3).is_err());
    assert_eq!(serialized_size(&"\n", 4), Ok(4));
}

#[test]
fn history_structural_limits_accept_exact_boundaries_and_refuse_one_more() {
    for raw in [
        format!("{}0{}", "[".repeat(32), "]".repeat(32)),
        format!("[{}]", vec!["null"; 1024].join(",")),
        format!(
            "{{{}}}",
            (0..256)
                .map(|i| format!("\"k{i}\":0"))
                .collect::<Vec<_>>()
                .join(",")
        ),
        format!("\"{}\"", "x".repeat(262144)),
    ] {
        assert!(structural_check(&raw).is_ok());
    }
    let groups = (0..32)
        .map(|i| {
            format!(
                "[{}]",
                vec!["null"; if i == 31 { 991 } else { 1024 }].join(",")
            )
        })
        .collect::<Vec<_>>();
    let exact = format!("[{}]", groups.join(","));
    assert!(structural_check(&exact).is_ok());
    let mut more = groups;
    more[31] = format!("[{}]", vec!["null"; 992].join(","));
    let over = format!("[{}]", more.join(","));
    assert!(structural_check(&over).is_err());
    // Escaped UTF-8 is counted as decoded bytes before allocating an ID string.
    assert!(structural_check(&format!("{{\"runId\":\"{}\"}}", "\\u0061".repeat(128))).is_ok());
    assert!(structural_check(&format!("{{\"runId\":\"{}\"}}", "\\u0061".repeat(129))).is_err());
}
#[test]
fn history_field_specific_limits_do_not_apply_an_8192_cap_to_private_definition_strings() {
    assert!(structural_check(&format!(
        "{{\"definition\":{{\"inputSchema\":\"{}\"}}}}",
        "x".repeat(32768)
    ))
    .is_ok());
    assert!(structural_check(&format!(
        "{{\"definition\":{{\"inputSchema\":\"{}\"}}}}",
        "x".repeat(32769)
    ))
    .is_err());
    for (pointer, cap) in [
        ("/details/preview/summary", 512),
        ("/details/preview/fields/0/label", 128),
        ("/details/preview/fields/0/value", 8192),
        ("/details/account/label", 512),
        ("/details/target/safeReference", 8192),
        ("/details/attempts/0/outcomeSummary", 8192),
    ] {
        let mut v = fixture(&scope(), 1);
        *v.pointer_mut(pointer).unwrap() = json!("x".repeat(cap));
        assert!(decode_history(&v.to_string()).is_ok(), "{pointer}");
        *v.pointer_mut(pointer).unwrap() = json!("x".repeat(cap + 1));
        assert!(decode_history(&v.to_string()).is_err(), "{pointer}");
    }
}
#[test]
fn history_attempts_accept_thirty_two_unique_ordered_receipts_but_not_duplicate_or_reversed() {
    let mut v = fixture(&scope(), 1);
    let template = v["details"]["attempts"][0].clone();
    v["details"]["attempts"] = json!((1..=32)
        .map(|n| {
            let mut a = template.clone();
            a["attemptId"] = json!(format!("{n:032x}"));
            a["ordinal"] = json!(n);
            a
        })
        .collect::<Vec<_>>());
    assert!(decode_history(&v.to_string()).is_ok());
    v["details"]["attempts"][31]["ordinal"] = json!(31);
    assert!(decode_history(&v.to_string()).is_err());
}

#[test]
fn history_field_vectors_reject_a_valid_thirty_third_element() {
    for pointer in [
        "/details/preview/fields",
        "/details/preview/redactedFields",
        "/retry_decisions",
    ] {
        let item = match pointer {
            "/details/preview/fields" => json!({"label":"safe","value":"value"}),
            "/details/preview/redactedFields" => json!("redacted"),
            _ => {
                json!({"person_id":"human:me","acknowledged_at":"2026-10-25T00:00:00Z","prior_revision":1,"prior_attempt_id":"11111111111111111111111111111111"})
            }
        };
        let mut v = fixture(&scope(), 1);
        *v.pointer_mut(pointer).unwrap() = json!(vec![item.clone(); 32]);
        assert!(decode_history(&v.to_string()).is_ok(), "{pointer}");
        v.pointer_mut(pointer)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .push(item);
        assert!(decode_history(&v.to_string()).is_err(), "{pointer}");
    }
    let mut v = fixture(&scope(), 1);
    let template = v["details"]["attempts"][0].clone();
    v["details"]["attempts"] = json!((1..=33)
        .map(|n| {
            let mut a = template.clone();
            a["attemptId"] = json!(format!("{n:032x}"));
            a["ordinal"] = json!(n);
            a
        })
        .collect::<Vec<_>>());
    assert!(decode_history(&v.to_string()).is_err());
    v["details"]["attempts"].as_array_mut().unwrap().pop();
    assert!(decode_history(&v.to_string()).is_ok());
    v["details"]["attempts"][31]["attemptId"] = v["details"]["attempts"][0]["attemptId"].clone();
    assert!(decode_history(&v.to_string()).is_err());
}

// M95 P1a review R1: the history decoder must retain target identity bounds.
#[test]
fn history_target_identity_retains_existing_512_byte_bound() {
    for paths in [
        vec!["/target/target/kind", "/details/target/kind"],
        vec!["/target/conflict_domain"],
    ] {
        let mut value = fixture(&scope(), 1);
        let accepted = "é".repeat(256);
        assert_eq!(accepted.len(), 512);
        for path in &paths {
            *value.pointer_mut(path).unwrap() = json!(accepted.clone());
        }
        assert!(decode_history(&value.to_string()).is_ok(), "{paths:?}");
        for rejected in [format!("{accepted}x"), "é".repeat(257)] {
            for path in &paths {
                *value.pointer_mut(path).unwrap() = json!(rejected.clone());
            }
            assert!(decode_history(&value.to_string()).is_err(), "{paths:?}");
        }
    }
}

// R1 addendum: nonempty/control-free target semantics survive persistence.
#[test]
fn history_target_identity_rejects_empty_and_control_text_in_every_occurrence() {
    let mut observations = Vec::new();
    for path in [
        "/target/conflict_domain",
        "/target/target/kind",
        "/target/target/label",
        "/target/target/safeReference",
        "/details/target/kind",
        "/details/target/label",
        "/details/target/safeReference",
    ] {
        for rejected in [
            "",
            "safe\u{0}forged",
            "safe\nforged",
            "safe\tforged",
            "safe\u{7f}forged",
            "safe\u{85}forged",
        ] {
            let mut value = fixture(&scope(), 1);
            *value.pointer_mut(path).unwrap() = json!(rejected);
            observations.push((path, rejected, decode_history(&value.to_string()).is_err()));
        }
    }
    assert!(
        observations.iter().all(|(_, _, refused)| *refused),
        "{observations:?}"
    );
}

#[test]
fn history_target_label_and_reference_keep_the_approved_distinct_byte_bounds() {
    for (paths, cap) in [
        (vec!["/target/target/label", "/details/target/label"], 512),
        (
            vec![
                "/target/target/safeReference",
                "/details/target/safeReference",
            ],
            8192,
        ),
    ] {
        let mut value = fixture(&scope(), 1);
        let accepted = "é".repeat(cap / 2);
        assert_eq!(accepted.len(), cap);
        for path in &paths {
            *value.pointer_mut(path).unwrap() = json!(accepted.clone());
        }
        assert!(decode_history(&value.to_string()).is_ok(), "{paths:?}");
        for path in &paths {
            *value.pointer_mut(path).unwrap() = json!(format!("{accepted}x"));
        }
        assert!(decode_history(&value.to_string()).is_err(), "{paths:?}");
    }
    // Existing validation requires nonempty, not trimmed or ASCII-only text.
    let mut value = fixture(&scope(), 1);
    for path in [
        "/target/conflict_domain",
        "/target/target/kind",
        "/target/target/label",
        "/target/target/safeReference",
        "/details/target/kind",
        "/details/target/label",
        "/details/target/safeReference",
    ] {
        *value.pointer_mut(path).unwrap() = json!(" ");
    }
    assert!(decode_history(&value.to_string()).is_ok());
}
