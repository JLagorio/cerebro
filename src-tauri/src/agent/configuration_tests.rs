//! Actual token-slot projection input; no fabricated permission capability.
use super::*;
use crate::mcp::{native_publication_test_support as transport, WriteAsks};

#[test]
fn run_configuration_every_selector_vector_and_chain_is_secret_free() {
    let vault = crate::vault::testutil::temp_vault("m97-selector-canaries");
    let mcp = transport::without_socket();
    let secret = "M97_ACTOR_AND_CHAIN_CANARY_7f03";
    let tools = vec![
        "read_page".to_string(),
        "Bash(M97_GRANT_TOOL_CANARY_7f03)".into(),
    ];
    let write = vec!["M97_WRITE_PREFIX_CANARY_7f03".into()];
    let read = vec!["M97_READ_PREFIX_CANARY_7f03".into()];
    let token = mcp
        .run_token(
            Some(secret),
            Some(write),
            Some(read),
            Some(tools),
            "m97-projection".into(),
            &vault,
            WriteAsks::UNASKED,
        )
        .unwrap();
    let grant = transport::actual_grant_for_configuration(&mcp, &token).unwrap();
    let cli = vec!["Read".into(), "Bash(M97_CLI_TOOL_CANARY_7f03)".into()];
    let allow = vec!["Read".into(), "Bash(M97_ALLOW_CANARY_7f03)".into()];
    let deny = vec!["Bash(M97_DENY_CANARY_7f03)".into()];
    let ask = vec!["Bash(M97_ASK_CANARY_7f03)".into()];
    let connector_ids = vec!["M97_CONNECTOR_ID_CANARY_7f03".into()];
    let result = project_selectors(SelectorInput {
        grant: &grant,
        cli_tools: &cli,
        allowed: &allow,
        denied: &deny,
        asked: &ask,
        requested_model: Some("sk-ant-private-model-canary-7f03"),
        connector_ids: &connector_ids,
    });
    let serialized = serde_json::to_string(&result).unwrap();
    std::fs::remove_dir_all(vault).unwrap();
    assert!(result.is_ok(), "new selector projection is not implemented");
    for canary in [
        secret,
        "M97_GRANT_TOOL_CANARY_7f03",
        "M97_WRITE_PREFIX_CANARY_7f03",
        "M97_READ_PREFIX_CANARY_7f03",
        "M97_CLI_TOOL_CANARY_7f03",
        "M97_ALLOW_CANARY_7f03",
        "M97_DENY_CANARY_7f03",
        "M97_ASK_CANARY_7f03",
        "sk-ant-private-model-canary-7f03",
        "M97_CONNECTOR_ID_CANARY_7f03",
    ] {
        assert!(
            !serialized.contains(canary),
            "arbitrary selector/chain value reached durable metadata"
        );
    }
    let result = result.unwrap();
    assert!(result
        .requested_model
        .as_ref()
        .unwrap()
        .metadata_label
        .is_none());
    assert_eq!(
        (
            result.chain.len(),
            result.grant_write.as_ref().unwrap().len(),
            result.grant_read.as_ref().unwrap().len(),
            result.grant_tools.as_ref().unwrap().len()
        ),
        (1, 1, 1, 2)
    );
    assert_eq!(
        (
            result.cli_tools.len(),
            result.allowed.len(),
            result.denied.len(),
            result.asked.len()
        ),
        (2, 2, 1, 1)
    );
    assert_eq!(result.cli_tools[0].metadata_label.as_deref(), Some("Read"));
    assert_eq!(result.connector_ids.len(), 1);
    for identity in [
        &result.actor,
        &result.chain[0],
        &result.grant_write.as_ref().unwrap()[0],
        &result.grant_read.as_ref().unwrap()[0],
        &result.grant_tools.as_ref().unwrap()[1],
        &result.cli_tools[1],
        &result.allowed[1],
        &result.denied[0],
        &result.asked[0],
        &result.connector_ids[0],
    ] {
        assert!(identity.metadata_label.is_none());
        assert_eq!(identity.sha256.len(), 64);
        assert!(identity.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}

#[test]
fn run_configuration_cli_version_is_a_strict_recognized_representation() {
    assert_eq!(
        observed_cli_version(Some("2.1.250 (Claude Code)")),
        Known::Recorded {
            value: StrictCliVersion {
                major: 2,
                minor: 1,
                patch: 250
            }
        }
    );
    assert_eq!(
        observed_cli_version(Some("2.1.250")),
        Known::Recorded {
            value: StrictCliVersion {
                major: 2,
                minor: 1,
                patch: 250
            }
        }
    );
    for raw in [
        "2.1.250 M97_VERSION_CANARY_7f03",
        "2.1.250\nM97_VERSION_CANARY_7f03",
        "M97_VERSION_CANARY_7f03",
        "2.1.250 (Claude Code) M97_VERSION_CANARY_7f03",
        "999999999999999999999.1.2",
        "2.1",
        "2.1.250.9",
    ] {
        let projected = observed_cli_version(Some(raw));
        assert!(matches!(
            projected,
            Known::Unknown {
                reason: UnknownReason::UnrecognizedCliVersion
            }
        ));
        assert!(!serde_json::to_string(&projected)
            .unwrap()
            .contains("M97_VERSION_CANARY_7f03"));
    }
    assert!(matches!(
        observed_cli_version(None),
        Known::Unknown {
            reason: UnknownReason::NotReportedByNativeProbe
        }
    ));
}
