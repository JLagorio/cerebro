//! Closed descriptive metadata request/results. No field grants store authority.
use super::{AuthorityError, EditorReceiptView, SelectedEditorTarget, SelectedRecordVersion};
use crate::workspace_service::types::values::{PropertyChange, PropertyValue};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum MetadataPatchPhase {
    Start,
    Resolve,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MetadataPatchRequest {
    pub(crate) target: SelectedEditorTarget,
    pub(crate) request_key: String,
    pub(crate) expected_version: SelectedRecordVersion,
    pub(crate) changes: Vec<PropertyChange>,
    pub(crate) phase: MetadataPatchPhase,
    pub(crate) original: Option<Box<MetadataPatchOperation>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MetadataPatchOperation {
    pub(crate) target: SelectedEditorTarget,
    pub(crate) path: String,
    pub(crate) request_key: String,
    pub(crate) operation_id: String,
    pub(crate) version: SelectedRecordVersion,
    pub(crate) receipt: Box<EditorReceiptView>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum MetadataPatchResult {
    Applied {
        operation: Box<MetadataPatchOperation>,
        #[serde(rename = "currentVersion")]
        current_version: SelectedRecordVersion,
        #[serde(rename = "reconcileRequired")]
        reconcile_required: bool,
    },
    /// Durable original request evidence; deliberately no mutation receipt.
    Unchanged {
        target: SelectedEditorTarget,
        path: String,
        #[serde(rename = "requestKey")]
        request_key: String,
        version: SelectedRecordVersion,
        #[serde(rename = "currentVersion")]
        current_version: SelectedRecordVersion,
        #[serde(rename = "reconcileRequired")]
        reconcile_required: bool,
    },
    OutcomeUnknown {
        #[serde(rename = "requestKey")]
        request_key: String,
        error: AuthorityError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(
    not(unix),
    expect(
        dead_code,
        reason = "Requested property wire is not produced outside the supported native adapter."
    )
)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SelectedPropertyValue {
    Absent {},
    Present { value: PropertyValue },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(
    not(unix),
    expect(
        dead_code,
        reason = "Requested property wire is not produced outside the supported native adapter."
    )
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedPropertySnapshot {
    pub(crate) target: SelectedEditorTarget,
    pub(crate) path: String,
    pub(crate) field: String,
    pub(crate) version: SelectedRecordVersion,
    pub(crate) value: SelectedPropertyValue,
    pub(crate) observed_body_hash: String,
    pub(crate) coherence: super::EditorBodyCoherence,
    pub(crate) editable: bool,
    pub(crate) read_only_reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum MetadataPatchRefusal {
    MetadataRefused { error: AuthorityError },
}
