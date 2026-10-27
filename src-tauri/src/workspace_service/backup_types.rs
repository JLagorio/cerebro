//! Generated-wire views only. No descriptor, ticket, window proof or writer.
use serde::Serialize;
use super::types::selected::AuthorityError;
use crate::workspace_migration::backup::BackupErrorKind;

#[cfg(test)]
fn bounded_u32_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType, NumberValidation, SchemaObject};
    SchemaObject {
        instance_type: Some(InstanceType::Integer.into()),
        number: Some(Box::new(NumberValidation { minimum: Some(0.0), maximum: Some(f64::from(u32::MAX)), ..NumberValidation::default() })),
        ..SchemaObject::default()
    }.into()
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceBackupMode { Create, Check, Restore }
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBackupLabels { pub source: Option<String>, pub input: Option<String>, pub output: Option<String> }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBackupSummary {
    pub workspace_id: String,
    #[cfg_attr(test, schemars(schema_with = "bounded_u32_schema"))]
    pub portable_version: u32,
    #[cfg_attr(test, schemars(schema_with = "bounded_u32_schema"))]
    pub schema_version: u32,
    #[cfg_attr(test, schemars(schema_with = "bounded_u32_schema"))]
    pub part_count: u32,
    pub total_bytes: String, pub omissions: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceBackupLocationVerification { Verified, OriginalSpellingOnly, Unavailable }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBackupLocation { pub display_location: String, pub verification: WorkspaceBackupLocationVerification }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupDisposition {
    NoneCreated, CreationUncertain { location: WorkspaceBackupLocation },
    Incomplete { location: WorkspaceBackupLocation }, CompletionUnknown { location: Option<WorkspaceBackupLocation> },
    Completed { location: WorkspaceBackupLocation }, CompletedButResponseUnavailable { location: WorkspaceBackupLocation },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkspaceBackupRefusalKind { Busy, InvalidChoice, ExpiredChoice, WrongWindow, WrongMode, StaleOpening, OutputOverlap, ChangedChoice, DestinationUnavailable, UnsupportedCurrentVault, UnsupportedPlatform, InvalidBackup, RecoveryRequired, UnknownOutcome, Unavailable }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBackupErrorView { pub code: String, pub kind: BackupErrorKind, pub message: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBackupRefusal {
    pub kind: WorkspaceBackupRefusalKind, pub message: String, pub authority: Option<AuthorityError>,
    pub backup: Option<WorkspaceBackupErrorView>, pub output: WorkspaceBackupDisposition,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceBackupReview {
    pub operation_id: String, pub token: String, pub mode: WorkspaceBackupMode, pub expires_at: Option<String>,
    pub labels: WorkspaceBackupLabels, pub summary: Option<WorkspaceBackupSummary>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupTerminal {
    Completed { #[serde(rename = "workspaceId")] workspace_id: Option<String>, summary: Option<WorkspaceBackupSummary>, output: WorkspaceBackupDisposition },
    Refused { refusal: WorkspaceBackupRefusal },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupOperation {
    None, Choosing { #[serde(rename = "operationId")] operation_id: String, mode: WorkspaceBackupMode, labels: WorkspaceBackupLabels },
    Pending { review: WorkspaceBackupReview }, Running { #[serde(rename = "operationId")] operation_id: String, mode: WorkspaceBackupMode, labels: WorkspaceBackupLabels },
    Terminal { #[serde(rename = "operationId")] operation_id: String, mode: WorkspaceBackupMode, labels: WorkspaceBackupLabels, result: WorkspaceBackupTerminal },
    Unavailable { refusal: WorkspaceBackupRefusal }, Preview { message: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupAvailability {
    Available { #[serde(rename = "sourceLabel")] source_label: String, #[serde(rename = "checkRestore")] check_restore: bool }, UnsupportedCurrentVault { message: String, #[serde(rename = "checkRestore")] check_restore: bool },
    Unavailable { refusal: WorkspaceBackupRefusal, #[serde(rename = "checkRestore")] check_restore: bool }, UnsupportedPlatform, Preview { message: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupChoiceResult {
    Cancelled, Review { review: WorkspaceBackupReview }, Refused { refusal: WorkspaceBackupRefusal }, Preview { mode: WorkspaceBackupMode, message: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupCommitResult {
    Started { #[serde(rename = "operationId")] operation_id: String, mode: WorkspaceBackupMode, labels: WorkspaceBackupLabels },
    AlreadyStarted { operation: WorkspaceBackupOperation }, Refused { refusal: WorkspaceBackupRefusal }, Preview { mode: WorkspaceBackupMode, message: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceBackupCancelResult {
    Cancelled, AlreadyStarted { operation: WorkspaceBackupOperation }, Refused { refusal: WorkspaceBackupRefusal }, Preview { message: String },
}

#[cfg(test)]
#[path = "backup_types_tests.rs"]
mod tests;
