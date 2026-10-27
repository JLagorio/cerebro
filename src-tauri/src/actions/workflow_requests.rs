//! Pure frozen ACT request data. No subject mint, approval or execution door.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "pure workflow ACT request bridge precedes retained native runner wiring"
    )
)]
use super::{
    effect_record::{request_digest, PrepareAction},
    ids::{AccountId, ConnectionId},
    read_types::{
        ActionDefinition, ActionError, ActionErrorCode, ActionId, DefinitionDigest,
        RetryDisposition, SnapshotDigest,
    },
    schema,
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selectors {
    pub action_id: String,
    pub definition_digest: String,
    pub connection_id: String,
    pub account_id: String,
    pub snapshot_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrozenRequest {
    pub selectors: Selectors,
    pub request_key: String,
    pub input: String,
    pub input_digest: String,
    pub request_digest: String,
}
fn error(code: ActionErrorCode) -> ActionError {
    ActionError {
        code,
        retry_disposition: RetryDisposition::Never,
        message: "Action request identity is unavailable or invalid.".into(),
    }
}
fn text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn definition(action_id: &str, digest: &str) -> Result<ActionDefinition, ActionError> {
    if !text(action_id) || !hash(digest) {
        return Err(error(ActionErrorCode::InvalidInput));
    }
    super::compiled_catalog::compiled_catalog()
        .map_err(|_| error(ActionErrorCode::Unavailable))?
        .resolve(
            &ActionId(action_id.into()),
            &DefinitionDigest(digest.into()),
        )
}
pub(crate) fn input_schema_for(action_id: &str, digest: &str) -> Result<String, ActionError> {
    Ok(definition(action_id, digest)?.input_schema)
}
pub(crate) fn input_schema(selectors: &Selectors) -> Result<String, ActionError> {
    input_schema_for(&selectors.action_id, &selectors.definition_digest)
}
pub(crate) fn freeze(
    selectors: Selectors,
    input: &str,
    key: &str,
) -> Result<FrozenRequest, ActionError> {
    if !text(&selectors.connection_id)
        || !text(&selectors.account_id)
        || !hash(&selectors.snapshot_digest)
        || !hash(key)
    {
        return Err(error(ActionErrorCode::InvalidInput));
    }
    let definition = definition(&selectors.action_id, &selectors.definition_digest)?;
    let input = schema::validate_input(&definition, input)?;
    let canonical = input.value.canonical();
    let request = PrepareAction {
        action_id: definition.action_id,
        definition_digest: definition.definition_digest,
        connection_id: ConnectionId(selectors.connection_id.clone()),
        account_id: AccountId(selectors.account_id.clone()),
        snapshot_digest: SnapshotDigest(selectors.snapshot_digest.clone()),
        input: canonical.clone(),
        request_key: key.into(),
    };
    let request_digest = request_digest(&request)?;
    Ok(FrozenRequest {
        selectors,
        request_key: key.into(),
        input: canonical,
        input_digest: input.digest,
        request_digest,
    })
}
#[cfg(test)]
pub(crate) fn fixture_selectors() -> Selectors {
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    let material: super::read_types::DefinitionMaterial =
        serde_json::from_value(source["definitions"][1].clone()).unwrap();
    let definition = super::catalog::ActionCatalog::default()
        .insert(material, "{}")
        .unwrap();
    Selectors {
        action_id: definition.action_id.0,
        definition_digest: definition.definition_digest.0,
        connection_id: "connection".into(),
        account_id: "account".into(),
        snapshot_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const INPUT: &str = r#"{"repository":"owner/repo","title":"first","body":"body"}"#;
    #[test]
    fn workflow_request_uses_actual_act_request_codec_and_normalized_input() {
        let frozen = freeze(fixture_selectors(), INPUT, KEY).unwrap();
        let request = super::super::effect_record::PrepareAction {
            action_id: super::super::read_types::ActionId(frozen.selectors.action_id.clone()),
            definition_digest: super::super::read_types::DefinitionDigest(
                frozen.selectors.definition_digest.clone(),
            ),
            connection_id: super::super::ids::ConnectionId(frozen.selectors.connection_id.clone()),
            account_id: super::super::ids::AccountId(frozen.selectors.account_id.clone()),
            snapshot_digest: super::super::read_types::SnapshotDigest(
                frozen.selectors.snapshot_digest.clone(),
            ),
            input: frozen.input.clone(),
            request_key: frozen.request_key.clone(),
        };
        assert_eq!(
            frozen.request_digest,
            super::super::effect_record::request_digest(&request).unwrap()
        );
        assert_eq!(
            frozen.input_digest,
            super::super::schema::digest(frozen.input.as_bytes())
        );
    }
    #[test]
    fn workflow_request_resolves_exact_compiled_schema_not_a_caller_schema() {
        let selectors = fixture_selectors();
        let schema = input_schema(&selectors).unwrap();
        super::super::schema::workflow_validate_input(&schema, INPUT).unwrap();
        assert!(super::super::schema::workflow_validate_input(&schema, "{}").is_err());
    }
    #[test]
    fn workflow_request_wrong_definition_digest_is_not_recaptured() {
        let mut selectors = fixture_selectors();
        selectors.definition_digest = "f".repeat(64);
        assert_eq!(
            input_schema(&selectors).unwrap_err().code,
            ActionErrorCode::NotFound
        );
    }
    #[test]
    fn workflow_request_snapshot_identity_is_part_of_original_request_digest() {
        let selectors = fixture_selectors();
        let first = freeze(selectors.clone(), INPUT, KEY).unwrap();
        let mut changed = selectors;
        changed.snapshot_digest = "c".repeat(64);
        let second = freeze(changed, INPUT, KEY).unwrap();
        assert_ne!(first.request_digest, second.request_digest);
        assert_eq!(first.input_digest, second.input_digest);
    }
}
