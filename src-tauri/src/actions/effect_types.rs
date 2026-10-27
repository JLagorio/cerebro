//! Wire inspection data is deliberately separate from internal authority.
pub(super) use super::read_types::*;
#[cfg(test)]
use schemars::{
    schema::{InstanceType, NumberValidation, Schema, SchemaObject},
    JsonSchema,
};
use serde::{Deserialize, Serialize};

pub(super) use super::ids::{AccountId, AttemptId, ConnectionId};

macro_rules! id {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(transparent)]
        pub(crate) struct $name(pub(crate) String);
    )+};
}
id!(InvocationId, ApprovalId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub(crate) struct SafeCounter(u64);
impl SafeCounter {
    pub(crate) fn new(value: u64) -> Result<Self, ActionError> {
        if value <= 9_007_199_254_740_991 {
            Ok(Self(value))
        } else {
            Err(error(
                ActionErrorCode::LimitExceeded,
                "Counter exceeds exact transport range.",
            ))
        }
    }
    pub(crate) fn get(self) -> u64 {
        self.0
    }
    pub(crate) fn next(self) -> Result<Self, ActionError> {
        Self::new(
            self.0
                .checked_add(1)
                .ok_or_else(|| error(ActionErrorCode::LimitExceeded, "Counter overflow."))?,
        )
    }
}
impl<'de> Deserialize<'de> for SafeCounter {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(u64::deserialize(d)?)
            .map_err(|_| serde::de::Error::custom("counter outside exact transport range"))
    }
}
#[cfg(test)]
impl JsonSchema for SafeCounter {
    fn schema_name() -> String {
        "SafeCounter".into()
    }
    fn json_schema(_: &mut schemars::gen::SchemaGenerator) -> Schema {
        Schema::Object(SchemaObject {
            instance_type: Some(InstanceType::Integer.into()),
            number: Some(Box::new(NumberValidation {
                minimum: Some(0.0),
                maximum: Some(9_007_199_254_740_991.0),
                ..Default::default()
            })),
            ..Default::default()
        })
    }
}

macro_rules! wire_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(rename_all="snake_case")]
        pub(crate) enum $name { $($variant),+ }
    };
}
wire_enum!(InvocationState {
    Prepared,
    AwaitingApproval,
    Ready,
    Dispatched,
    Succeeded,
    Failed,
    OutcomeUnknown,
    Cancelled
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEffectRef {
    pub(crate) invocation_id: InvocationId,
    pub(crate) state: InvocationState,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<ApprovalId>"))]
    pub(crate) approval_id: Option<ApprovalId>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) account_label: Option<String>,
    pub(crate) can_reconcile: bool,
    pub(crate) can_retry: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewField {
    pub(crate) label: String,
    pub(crate) value: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SafeEffectPreview {
    pub(crate) summary: String,
    pub(crate) fields: Vec<PreviewField>,
    pub(crate) redacted_fields: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionAttemptSummary {
    pub(crate) attempt_id: AttemptId,
    pub(crate) ordinal: SafeCounter,
    pub(crate) state: InvocationState,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) dispatched_at: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) observed_at: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) receipt_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) remote_effect_reference: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) outcome_summary: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EffectAccount {
    pub(crate) account_id: AccountId,
    pub(crate) label: String,
    pub(crate) account_revision: SafeCounter,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EffectTarget {
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) safe_reference: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EffectApproval {
    pub(crate) approval_id: ApprovalId,
    pub(crate) revision: SafeCounter,
    pub(crate) expires_at: String,
    pub(crate) asked_input_digest: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) approved_input_digest: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<SafeEffectPreview>"))]
    pub(crate) approved_preview: Option<SafeEffectPreview>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionEffectDetails {
    pub(crate) effect: ActionEffectRef,
    pub(crate) revision: SafeCounter,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<EffectAccount>"))]
    pub(crate) account: Option<EffectAccount>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<EffectTarget>"))]
    pub(crate) target: Option<EffectTarget>,
    pub(crate) definition_digest: DefinitionDigest,
    pub(crate) input_digest: String,
    pub(crate) preview: SafeEffectPreview,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<EffectApproval>"))]
    pub(crate) approval: Option<EffectApproval>,
    pub(crate) attempts: Vec<ActionAttemptSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PreparedAction {
    pub(super) effect: ActionEffectRef,
    pub(super) preview: SafeEffectPreview,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<ApprovalId>"))]
    pub(super) approval_id: Option<ApprovalId>,
}
