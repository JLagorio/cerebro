use super::*;
use serde_json::json;

const CASES: &str = include_str!("../../../shared/policy/connector-ownership-cases.v1.json");
const DIGEST_PATH: &str = "shared/policy/connector-ownership.v1.sha256";
fn repo(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(path)
}
fn expected(case: &Value) -> Ownership {
    serde_json::from_value(case["expected"].clone()).unwrap()
}

#[test]
fn m96_owner_policy_digest_matches_compiled_and_disk() {
    assert_eq!(
        POLICY_JSON,
        std::fs::read_to_string(repo("shared/policy/connector-ownership.v1.json")).unwrap()
    );
    assert_eq!(
        crate::ledger::sha256_hex(POLICY_JSON.as_bytes()),
        std::fs::read_to_string(repo(DIGEST_PATH)).unwrap().trim()
    );
    let policy = table().expect("the compiled ownership policy is available");
    assert_eq!(policy.format, 1);
    assert_eq!(policy.artifact_version, 1);
}

#[test]
fn m96_owner_replays_shared_entry_cases() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    for case in cases["entry_cases"].as_array().unwrap() {
        assert_eq!(ownership(&case["entry"]), expected(case), "{}", case["id"]);
        let reason = refusal(&case["entry"]);
        match expected(case) {
            Ownership::Cli => assert!(reason.is_none(), "{}", case["id"]),
            Ownership::Managed => {
                assert_eq!(reason, Some(table().unwrap().messages.managed.as_str()))
            }
            Ownership::Invalid => {
                assert_eq!(reason, Some(table().unwrap().messages.invalid.as_str()))
            }
            Ownership::Unavailable => unreachable!("entry cases use a valid policy"),
        }
    }
}

#[test]
fn m96_owner_replays_shared_policy_cases_and_fails_closed() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    for case in cases["policy_cases"].as_array().unwrap() {
        let raw = if let Some(raw) = case["raw"].as_str() {
            raw.to_string()
        } else {
            let mut value: Value = serde_json::from_str(POLICY_JSON).unwrap();
            if let Some(patch) = case.get("patch") {
                value
                    .as_object_mut()
                    .unwrap()
                    .extend(patch.as_object().unwrap().clone());
            } else {
                value = case["value"].clone();
            }
            value.to_string()
        };
        let policy = parse(&raw);
        assert_eq!(
            policy.is_some(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
        if policy.is_none() {
            assert_eq!(
                ownership_with(&json!({}), None),
                Ownership::Unavailable,
                "{}",
                case["id"]
            );
            assert_eq!(
                ownership_with(&json!({"executionOwner": "cli"}), None),
                Ownership::Unavailable
            );
        }
        if let Some(probes) = case["probes"].as_array() {
            for probe in probes {
                assert_eq!(
                    ownership_with(&probe["entry"], policy.as_ref()),
                    expected(probe),
                    "{}",
                    case["id"]
                );
            }
        }
    }
}

#[test]
#[ignore = "deliberate artifact edit: regenerates the shared ownership digest"]
fn write_connector_ownership_digest() {
    std::fs::write(
        repo(DIGEST_PATH),
        format!("{}\n", crate::ledger::sha256_hex(POLICY_JSON.as_bytes())),
    )
    .unwrap();
}
