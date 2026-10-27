//! Rust-owned original-root inspection. None of these values is authority.
use super::effect_types::*;
use serde::{Deserialize, Serialize};
macro_rules! closed {
    ($name:ident { $($v:ident),+ }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(rename_all="snake_case")]
        pub(crate) enum $name { $($v),+ }
    }
}
closed!(HistoryReason {
    InvalidRecord,
    StoredPayloadLimit,
    AggregateLimit,
    OutputLimit,
    Overflow,
    MetadataLimit,
    AccountDenied,
    AccountUnavailable
});
closed!(DetailsRead {
    Available,
    Denied,
    Unavailable
});
closed!(InventoryState {
    Complete,
    Incomplete
});
closed!(UnknownCoverageState { Unknown });
closed!(GenerationReason {
    RootOnlyNoGenerationBinding
});
closed!(ExternalEffectsReason {
    UnbrokeredExecutionNotCovered
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryOrigin {
    pub root_attempt_id: String,
    pub run_id: String,
    pub vault_id: String,
    pub store_id: String,
    pub actor_id: String,
    pub cli_session_id: String,
    pub historical_app_session_id: String,
    pub outcome: String,
    pub started_at: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub ended_at: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub native_closed_at: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub native_close_kind: Option<String>,
    pub app_close_precision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryEffect {
    pub effect: ActionEffectRef,
    pub details_read: DetailsRead,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<ActionEffectDetails>"))]
    pub details: Option<ActionEffectDetails>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<HistoryReason>"))]
    pub reason: Option<HistoryReason>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrokerInventory {
    pub state: InventoryState,
    pub inspected_run_ids: Vec<String>,
    pub observed_count: SafeCounter,
    pub overflow: bool,
    pub reasons: Vec<HistoryReason>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerationCoverage {
    pub state: UnknownCoverageState,
    pub reason: GenerationReason,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExternalEffectsCoverage {
    pub state: UnknownCoverageState,
    pub reason: ExternalEffectsReason,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryIssue {
    pub reason: HistoryReason,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatRecoveryInspection {
    pub origin: HistoryOrigin,
    pub effects: Vec<HistoryEffect>,
    pub broker_inventory: BrokerInventory,
    pub generation_coverage: GenerationCoverage,
    pub external_effects_coverage: ExternalEffectsCoverage,
    pub issues: Vec<HistoryIssue>,
}
