//! Bounded descriptive editor request/results. These values never grant authority.
use super::pair_types::OriginalReceipt;
use super::{AuthorityError, SelectedRecordVersion};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedEditorTarget {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum EditorSavePhase {
    Start,
    Resolve,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorSaveRequest {
    pub(crate) target: SelectedEditorTarget,
    pub(crate) request_key: String,
    /// Optional stale-target expectation for dependent body transforms. It is
    /// descriptive CAS evidence, never authority. General editor saves omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expected_version: Option<SelectedRecordVersion>,
    pub(crate) phase: EditorSavePhase,
    pub(crate) original: Option<Box<EditorOperation>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorOperation {
    pub(crate) target: SelectedEditorTarget,
    pub(crate) path: String,
    pub(crate) request_key: String,
    pub(crate) operation_id: String,
    pub(crate) version: SelectedRecordVersion,
    pub(crate) receipt: Box<EditorReceiptView>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum EditorBodyCoherence {
    Paired,
    ExternalChange,
}
/// Exact visible-body observation for the human workspace presentation. It
/// describes no mutation, writer eligibility or canonical acknowledgement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedBodyObservation {
    pub(crate) coherence: EditorBodyCoherence,
    pub(crate) observed_body_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedEditorSnapshot {
    pub(crate) target: SelectedEditorTarget,
    pub(crate) path: String,
    pub(crate) version: SelectedRecordVersion,
    pub(crate) body: String,
    pub(crate) observed_body_hash: String,
    pub(crate) coherence: EditorBodyCoherence,
    pub(crate) editable: bool,
    pub(crate) read_only_reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum EditorSaveResult {
    #[serde(rename = "selected_applied")]
    Applied {
        operation: Box<EditorOperation>,
        #[serde(rename = "currentVersion")]
        current_version: SelectedRecordVersion,
        #[serde(rename = "reconcileRequired")]
        reconcile_required: bool,
        recovery: Option<EditorRecoveryView>,
    },
    /// A fresh native observation, never a claim of request-key deduplication.
    #[serde(rename = "selected_unchanged")]
    Unchanged { version: SelectedRecordVersion },
    #[serde(rename = "selected_pending")]
    Pending {
        operation: Box<EditorOperation>,
        error: AuthorityError,
    },
    /// No original receipt/intent can be proven; resolution never reapplies bytes.
    #[serde(rename = "selected_outcome_unknown")]
    OutcomeUnknown { error: AuthorityError },
}

/// Transport view only: historical IntentEnvelope continues serializing the
/// original i64 receipt privately, with no global serde/schema change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EditorReceiptView {
    pub(crate) workspace_id: String,
    pub(crate) epoch: String,
    pub(crate) record_id: String,
    pub(crate) previous_revision: String,
    pub(crate) revision: String,
    pub(crate) metadata_before_hash: String,
    pub(crate) metadata_after_hash: String,
    pub(crate) body_before_hash: String,
    pub(crate) body_after_hash: String,
    pub(crate) actor: String,
    pub(crate) run_id: Option<String>,
    pub(crate) approved_by: Option<String>,
    pub(crate) operation: String,
    pub(crate) at: String,
}
impl From<&OriginalReceipt> for EditorReceiptView {
    fn from(r: &OriginalReceipt) -> Self {
        Self {
            workspace_id: r.workspace_id.clone(),
            epoch: r.epoch.to_string(),
            record_id: r.record_id.clone(),
            previous_revision: r.previous_revision.to_string(),
            revision: r.revision.to_string(),
            metadata_before_hash: r.metadata_before_hash.clone(),
            metadata_after_hash: r.metadata_after_hash.clone(),
            body_before_hash: r.body_before_hash.clone(),
            body_after_hash: r.body_after_hash.clone(),
            actor: r.actor.clone(),
            run_id: r.run_id.clone(),
            approved_by: r.approved_by.clone(),
            operation: r.operation.clone(),
            at: r.at.clone(),
        }
    }
}

/// Selected transport only. Preserve the legacy/internal recovery Outcome and
/// express a known usize count losslessly, including an over-quota old store.
/// Recovery cannot reconstruct the original count; None preserves that absence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum EditorRecoveryView {
    Off,
    NotRetained { reason: String },
    Retained { id: String, evicted: Option<String> },
    Pending { id: String, evicted: Option<String> },
    WithoutCopy,
}
impl From<crate::vault::recovery::Outcome> for EditorRecoveryView {
    fn from(outcome: crate::vault::recovery::Outcome) -> Self {
        use crate::vault::recovery::Outcome;
        match outcome {
            Outcome::Off => Self::Off,
            Outcome::NotRetained { reason } => Self::NotRetained { reason },
            Outcome::Retained { id, evicted } => Self::Retained {
                id,
                evicted: Some(evicted.to_string()),
            },
            Outcome::Pending { id, evicted } => Self::Pending {
                id,
                evicted: Some(evicted.to_string()),
            },
            Outcome::WithoutCopy => Self::WithoutCopy,
        }
    }
}
#[cfg(test)]
mod editor_wire_tests {
    use super::*;
    #[test]
    fn editor_recovery_count_transport_is_exact_for_the_whole_native_range() {
        let view = EditorRecoveryView::from(crate::vault::recovery::Outcome::Retained {
            id: "wire-only".into(),
            evicted: usize::MAX,
        });
        let value = serde_json::to_value(view).unwrap();
        assert_eq!(value["evicted"], usize::MAX.to_string());
        assert!(value["evicted"].is_string());
    }
}

/// Definite refusal before this fresh editor dispatch published an intent.
/// Resolve errors retain their unknown/pending owner state; they cannot claim
/// the earlier original operation was never applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum EditorSaveRefusal {
    SelectedRefused { error: AuthorityError },
}
