use super::*;
use crate::actions::compiled_catalog::compiled_catalog;
use serde_json::json;

fn definition(create: bool) -> ActionDefinition {
    let catalog = compiled_catalog().unwrap();
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    let material: DefinitionMaterial =
        serde_json::from_value(source["definitions"][usize::from(create)].clone()).unwrap();
    let mut isolated = crate::actions::catalog::ActionCatalog::default();
    let value = isolated.insert(material, "{}").unwrap();
    catalog
        .resolve(&value.action_id, &value.definition_digest)
        .unwrap()
}
fn create() -> IssuePlan {
    prepare(&definition(true), r#"{"repository":"OpenAI/Cerebro","title":"Review \"draft\"","body":"First line\n\n- second"}"#).unwrap()
}
fn read() -> IssuePlan {
    prepare(
        &definition(false),
        r#"{"repository":"OpenAI/Cerebro","number":42}"#,
    )
    .unwrap()
}
fn body(number: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "id":9007199254740993_u64,"number":number,"title":"Review draft","body":"Text",
        "html_url":format!("https://github.com/OpenAI/Cerebro/issues/{number}"),
        "repository_url":"https://api.github.com/repos/OpenAI/Cerebro",
        "user":{"login":"ignored"},"labels":[]
    }))
    .unwrap()
}

#[test]
fn create_request_and_preview_share_the_exact_supported_content() {
    let plan = create();
    assert_eq!(
        plan.endpoint,
        "https://api.github.com/repos/openai/cerebro/issues"
    );
    assert_eq!(plan.method, "POST");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(plan.body.as_ref().unwrap()).unwrap(),
        json!({"title":"Review \"draft\"","body":"First line\n\n- second"})
    );
    assert_eq!(
        plan.preview
            .fields
            .iter()
            .map(|f| (f.label.as_str(), f.value.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("Repository", "openai/cerebro"),
            ("Title", "Review \"draft\""),
            ("Body", "First line\n\n- second")
        ]
    );
    let other = prepare(
        &definition(true),
        r#"{"repository":"openai/CEREBRO","title":"Different","body":""}"#,
    )
    .unwrap();
    assert_eq!(
        plan.target, other.target,
        "case and content cannot bypass a target's unresolved fence"
    );
}

#[test]
fn read_request_uses_an_exact_integer_and_carries_no_body() {
    let plan = prepare(
        &definition(false),
        r#"{"repository":"openai/cerebro","number":4.2e1}"#,
    )
    .unwrap();
    assert_eq!(
        plan.endpoint,
        "https://api.github.com/repos/openai/cerebro/issues/42"
    );
    assert_eq!(plan.method, "GET");
    assert!(plan.body.is_none());
}

#[test]
fn repository_escape_and_uncompiled_definition_refuse_before_a_request_exists() {
    for repo in [
        "https://evil.invalid/a",
        "owner/../repo",
        "owner/a?x=1",
        "owner/a%2Fb",
        "owner/a#b",
        "owner/..",
        "owner/.",
        "owner/repo.git",
        "ownér/repo",
        "owner//repo",
        "-owner/repo",
    ] {
        assert!(
            prepare(
                &definition(false),
                &json!({"repository":repo,"number":42}).to_string()
            )
            .is_err(),
            "{repo}"
        );
    }
    let mut changed = definition(true);
    changed.adapter_revision = "changed".into();
    assert!(prepare(
        &changed,
        r#"{"repository":"openai/cerebro","title":"x","body":""}"#
    )
    .is_err());
}

#[test]
fn response_preserves_large_issue_identity_and_checks_the_requested_number() {
    let plan = read();
    let IssueOutcome::Succeeded {
        output,
        remote_reference,
    } = response(&plan, 200, "application/json; charset=utf-8", &body(42))
    else {
        panic!("valid issue response")
    };
    let value: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["issueId"], "9007199254740993");
    assert_eq!(value["repository"], "openai/cerebro");
    assert_eq!(
        remote_reference,
        "https://github.com/openai/cerebro/issues/42"
    );
    assert_eq!(
        response(&plan, 200, "application/json", &body(43)),
        IssueOutcome::Unknown
    );
}

#[test]
fn creation_response_requires_its_expected_status_and_repository() {
    let plan = create();
    assert!(matches!(
        response(&plan, 201, "application/json", &body(72)),
        IssueOutcome::Succeeded { .. }
    ));
    assert_eq!(
        response(&plan, 200, "application/json", &body(72)),
        IssueOutcome::Unknown
    );
    let mut wrong: serde_json::Value = serde_json::from_slice(&body(72)).unwrap();
    wrong["repository_url"] = json!("https://api.github.com/repos/another/repo");
    assert_eq!(
        response(
            &plan,
            201,
            "application/json",
            &serde_json::to_vec(&wrong).unwrap()
        ),
        IssueOutcome::Unknown
    );
}

#[test]
fn malformed_or_oversized_success_never_proves_failure_or_permits_replay() {
    let plan = create();
    for payload in [
        b"{".to_vec(),
        b"{\"id\":1,\"id\":2}".to_vec(),
        vec![b' '; 65537],
    ] {
        assert_eq!(
            response(&plan, 201, "application/json", &payload),
            IssueOutcome::Unknown
        );
    }
    assert_eq!(
        response(&plan, 201, "text/html", &body(72)),
        IssueOutcome::Unknown
    );
    assert_eq!(
        response(&plan, 503, "application/json", b"{}"),
        IssueOutcome::Unknown
    );
    assert_eq!(
        response(&plan, 302, "application/json", b"{}"),
        IssueOutcome::Unknown
    );
}

#[test]
fn a_pull_request_or_unsafe_response_url_is_not_an_issue_success() {
    let plan = read();
    let original: serde_json::Value = serde_json::from_slice(&body(42)).unwrap();
    let mut pr = original.clone();
    pr["pull_request"] = json!({"url":"https://api.github.com/repos/openai/cerebro/pulls/42"});
    assert_eq!(
        response(
            &plan,
            200,
            "application/json",
            &serde_json::to_vec(&pr).unwrap()
        ),
        IssueOutcome::Unknown
    );
    for url in [
        "https://github.com.evil.invalid/openai/cerebro/issues/42",
        "https://github.com/openai/cerebro/issues/42?next=evil",
        "javascript:alert(1)",
    ] {
        let mut wrong = original.clone();
        wrong["html_url"] = json!(url);
        assert_eq!(
            response(
                &plan,
                200,
                "application/json",
                &serde_json::to_vec(&wrong).unwrap()
            ),
            IssueOutcome::Unknown
        );
    }
}

#[test]
fn explicit_empty_body_is_supported_but_missing_or_overlong_body_is_not() {
    let plan = read();
    let mut value: serde_json::Value = serde_json::from_slice(&body(42)).unwrap();
    value["body"] = serde_json::Value::Null;
    let IssueOutcome::Succeeded { output, .. } = response(
        &plan,
        200,
        "application/json",
        &serde_json::to_vec(&value).unwrap(),
    ) else {
        panic!("null means no body")
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&output).unwrap()["body"],
        ""
    );
    value.as_object_mut().unwrap().remove("body");
    assert_eq!(
        response(
            &plan,
            200,
            "application/json",
            &serde_json::to_vec(&value).unwrap()
        ),
        IssueOutcome::Unknown
    );
    value["body"] = json!("x".repeat(8193));
    assert_eq!(
        response(
            &plan,
            200,
            "application/json",
            &serde_json::to_vec(&value).unwrap()
        ),
        IssueOutcome::Unknown
    );
}

#[test]
fn documented_create_rejections_are_terminal_without_parsing_provider_error_text() {
    let plan = create();
    for status in [400, 403, 404, 410, 422] {
        assert_eq!(
            response(&plan, status, "application/json", b"private provider error"),
            IssueOutcome::NotApplied
        );
    }
    assert_eq!(
        response(&plan, 429, "application/json", b"{}"),
        IssueOutcome::Unknown
    );
}

#[test]
fn every_compiled_definition_field_is_bound_before_preparing_a_request() {
    let original = definition(true);
    let input = r#"{"repository":"openai/cerebro","title":"x","body":""}"#;
    assert!(prepare(&original, input).is_ok());
    let mut changed = Vec::new();
    let mut candidate = original.clone();
    candidate.effect_class = EffectClass::Read;
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.required_capabilities.clear();
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.input_schema = r#"{"type":"object"}"#.into();
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.output_schema = r#"{"type":"object"}"#.into();
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.input_schema_digest = "0".repeat(64);
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.output_schema_digest = "0".repeat(64);
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.retry = RetryContract::Idempotent;
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.cancel = true;
    changed.push(candidate);
    let mut candidate = original.clone();
    candidate.reconcile = true;
    changed.push(candidate);
    for candidate in changed {
        assert_eq!(candidate.action_id, original.action_id);
        assert_eq!(candidate.definition_digest, original.definition_digest);
        assert!(
            prepare(&candidate, input).is_err(),
            "retained selectors cannot authenticate changed definition material"
        );
    }
}

#[test]
fn request_json_uses_the_compiled_schema_and_duplicate_key_refusal() {
    let def = definition(true);
    assert!(prepare(
        &def,
        r#"{"repository":"openai/cerebro","title":"x","body":""}"#
    )
    .is_ok());
    for input in [
        r#"{"repository":"openai/cerebro","repository":"another/repo","title":"x","body":""}"#,
        r#"{"repository":"openai/cerebro","title":"x","body":"","url":"https://evil.invalid"}"#,
        r#"{"repository":"openai/cerebro","title":"x","body":"","headers":{"Authorization":"caller-owned"}}"#,
        r#"{"repository":"openai/cerebro","title":"x","body":"","idempotencyKey":"caller-owned"}"#,
        r#"{"repository":"openai/cerebro","title":"x"}"#,
        r#"{"repository":"openai/cerebro","title":"","body":""}"#,
        r#"{"repository":"openai/cerebro","title":null,"body":""}"#,
        r#"{"repository":"openai/cerebro","title":"x","body":[]}"#,
    ] {
        assert!(prepare(&def, input).is_err(), "{input}");
    }
}

#[test]
fn repository_components_have_independent_grammar_and_byte_limits() {
    let def = definition(false);
    for (repository, endpoint) in [
        (
            "OpenAI/.github",
            "https://api.github.com/repos/openai/.github/issues/42",
        ),
        (
            "OpenAI/repo_name-with.dots",
            "https://api.github.com/repos/openai/repo_name-with.dots/issues/42",
        ),
    ] {
        assert_eq!(
            prepare(
                &def,
                &json!({"repository":repository,"number":42}).to_string()
            )
            .unwrap()
            .endpoint,
            endpoint
        );
    }
    let largest = format!("{}/{}", "o".repeat(39), "r".repeat(100));
    assert!(prepare(&def, &json!({"repository":largest,"number":42}).to_string()).is_ok());
    let invalid = vec![
        "owner/repo\\path".into(),
        "owner/repo\n".into(),
        " owner/repo".into(),
        "owner/repo ".into(),
        "owner/repo\u{0000}".into(),
        "owner-/repo".into(),
        format!("{}/repo", "o".repeat(40)),
        format!("owner/{}", "r".repeat(101)),
    ];
    for repository in invalid {
        assert!(
            prepare(
                &def,
                &json!({"repository":repository,"number":42}).to_string()
            )
            .is_err(),
            "{repository:?}"
        );
    }
    for number in [json!(0), json!(-1), json!(1.5), json!(9007199254740992_u64)] {
        assert!(prepare(
            &def,
            &json!({"repository":"openai/cerebro","number":number}).to_string()
        )
        .is_err());
    }
    assert!(prepare(
        &def,
        r#"{"repository":"openai/cerebro","number":9007199254740991}"#
    )
    .unwrap()
    .endpoint
    .ends_with("/9007199254740991"));
}

#[test]
fn maximum_supported_utf8_body_is_previewed_and_submitted_in_full() {
    let body = "é".repeat(4096);
    assert_eq!(body.len(), 8192);
    let title = r#"  Keep "title" • exactly  "#;
    let input = json!({"repository":"OpenAI/Cerebro","title":title,"body":body});
    let plan = prepare(&definition(true), &input.to_string()).unwrap();
    assert_eq!(
        plan.preview
            .fields
            .iter()
            .find(|field| field.label == "Body")
            .unwrap()
            .value,
        body
    );
    assert_eq!(
        plan.preview
            .fields
            .iter()
            .find(|field| field.label == "Title")
            .unwrap()
            .value,
        title
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(plan.body.as_ref().unwrap()).unwrap(),
        json!({"title":title,"body":body})
    );
    let over = json!({"repository":"openai/cerebro","title":title,"body":format!("{body}x")});
    assert!(
        prepare(&definition(true), &over.to_string()).is_err(),
        "ACT's byte limit must refuse rather than truncate preview or submission"
    );
}

#[test]
fn issue_success_preserves_every_supported_output_field_without_recomposing_content() {
    let plan = read();
    let title = r#"  Provider "title" •  "#;
    let markdown = "# Exact body\n\n- é and quoted text\n";
    let payload = json!({
        "id":9007199254740993_u64, "number":42, "title":title, "body":markdown,
        "html_url":"https://github.com/OpenAI/Cerebro/issues/42",
        "repository_url":"https://api.github.com/repos/OpenAI/Cerebro"
    });
    let IssueOutcome::Succeeded {
        output,
        remote_reference,
    } = response(
        &plan,
        200,
        "application/json",
        &serde_json::to_vec(&payload).unwrap(),
    )
    else {
        panic!("complete issue output");
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&output).unwrap(),
        json!({
            "issueId":"9007199254740993", "repository":"openai/cerebro", "number":42,
            "url":"https://github.com/openai/cerebro/issues/42", "title":title, "body":markdown
        })
    );
    assert_eq!(
        remote_reference,
        "https://github.com/openai/cerebro/issues/42"
    );
}

#[test]
fn malformed_provider_numeric_identity_never_proves_issue_creation() {
    let plan = create();
    let original: serde_json::Value = serde_json::from_slice(&body(72)).unwrap();
    for id in [json!(0), json!(-1), json!(1.5), json!("72"), json!(null)] {
        let mut invalid = original.clone();
        invalid["id"] = id;
        assert_eq!(
            response(
                &plan,
                201,
                "application/json",
                &serde_json::to_vec(&invalid).unwrap()
            ),
            IssueOutcome::Unknown
        );
    }
    for number in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("72"),
        json!(9007199254740992_u64),
    ] {
        let mut invalid = original.clone();
        invalid["number"] = number;
        assert_eq!(
            response(
                &plan,
                201,
                "application/json",
                &serde_json::to_vec(&invalid).unwrap()
            ),
            IssueOutcome::Unknown
        );
    }
}

#[test]
fn provider_output_schema_violations_are_unknown_instead_of_successful_empty_output() {
    let plan = create();
    let original: serde_json::Value = serde_json::from_slice(&body(72)).unwrap();
    for (key, value) in [
        ("title", json!("")),
        ("title", json!("t".repeat(1025))),
        ("title", json!(12)),
        ("body", json!([])),
    ] {
        let mut invalid = original.clone();
        invalid[key] = value;
        assert_eq!(
            response(
                &plan,
                201,
                "application/json",
                &serde_json::to_vec(&invalid).unwrap()
            ),
            IssueOutcome::Unknown
        );
    }
    for key in ["id", "number", "title", "html_url", "repository_url"] {
        let mut invalid = original.clone();
        invalid.as_object_mut().unwrap().remove(key);
        assert_eq!(
            response(
                &plan,
                201,
                "application/json",
                &serde_json::to_vec(&invalid).unwrap()
            ),
            IssueOutcome::Unknown
        );
    }
}

#[test]
fn exact_response_identity_representation_and_status_are_required_together() {
    let plan = read();
    let original: serde_json::Value = serde_json::from_slice(&body(42)).unwrap();
    for url in [
        "https://github.com/openai/cerebro/issues/43",
        "https://person@github.com/openai/cerebro/issues/42",
        "https://github.com:444/openai/cerebro/issues/42",
        "https://github.com/openai/cerebro/issues/42#fragment",
        "https://github.com/openai/cerebro/issues/%34%32",
    ] {
        let mut invalid = original.clone();
        invalid["html_url"] = json!(url);
        assert_eq!(
            response(
                &plan,
                200,
                "application/json",
                &serde_json::to_vec(&invalid).unwrap()
            ),
            IssueOutcome::Unknown,
            "{url}"
        );
    }
    let mut extra_path = original.clone();
    extra_path["repository_url"] = json!("https://api.github.com/repos/openai/cerebro/issues");
    assert_eq!(
        response(
            &plan,
            200,
            "application/json",
            &serde_json::to_vec(&extra_path).unwrap()
        ),
        IssueOutcome::Unknown
    );
    for content_type in ["application/jsonp", "text/json", "text/plain"] {
        assert_eq!(
            response(&plan, 200, content_type, &body(42)),
            IssueOutcome::Unknown
        );
    }
    for status in [201, 301, 307, 308, 401, 409, 429, 500] {
        assert_eq!(
            response(&plan, status, "application/json", &body(42)),
            IssueOutcome::Unknown
        );
    }
}
