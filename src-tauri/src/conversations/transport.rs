//! Data only. IDs/cursors are selectors; native original-opening checks admit reads.
#[cfg(test)]
use crate::actions::read_types::RequiredNullable;
use crate::actions::{read_types::required_nullable, SafeCounter};
pub(crate) use crate::agent::archive_codec::ArchiveTurnV1;
pub(crate) use crate::runtime::conversations::{DisplayMessage, RetentionChoice};
use serde::{Deserialize, Serialize};
macro_rules! words {($name:ident{$($variant:ident),+$(,)?})=>{#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]#[cfg_attr(test,derive(schemars::JsonSchema))]#[serde(rename_all="snake_case")]pub(crate) enum $name {$($variant),+}};}
words!(ArchiveErrorCode {
    Invalid,
    Conflict,
    Denied,
    Unavailable
});
words!(ContentState {
    Retained,
    MetadataOnly,
    Expired
});
words!(PersistenceState {
    Retained,
    Off,
    Expired,
    Unavailable,
    Deleted
});
words!(CleanupState {
    Completed,
    Deferred,
    Failed
});
words!(ExportFormat { Json, Markdown });
words!(ContentOrigin {
    NativeRun,
    BrowserCache
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveContext {
    pub vault_id: String,
    pub store_uuid: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveError {
    pub code: ArchiveErrorCode,
    pub message: String,
}
impl ArchiveError {
    pub(crate) fn unavailable() -> Self {
        Self {
            code: ArchiveErrorCode::Unavailable,
            message:
                "Conversation archive is unavailable. Your active conversation has not been resent."
                    .into(),
        }
    }
    pub(crate) fn from_rows(error: crate::runtime::chat_generations::Error) -> Self {
        use crate::runtime::chat_generations::Error;
        Self {
            code: match error {
                Error::Invalid => ArchiveErrorCode::Invalid,
                Error::Conflict => ArchiveErrorCode::Conflict,
                Error::Denied => ArchiveErrorCode::Denied,
                Error::Unavailable => ArchiveErrorCode::Unavailable,
            },
            message: match error {
                Error::Invalid => "The archive request is invalid.",
                Error::Conflict => "The archive changed. Refresh before trying again.",
                Error::Denied => "This archive belongs to a different opening.",
                Error::Unavailable => "Conversation archive is unavailable.",
            }
            .into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveSetting {
    pub context: ArchiveContext,
    pub choice: RetentionChoice,
    pub revision: SafeCounter,
    pub logical_bytes: SafeCounter,
    pub budget_bytes: SafeCounter,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveThread {
    pub id: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub title: Option<String>,
    /// Expiry of title_generation_id's exact source content, never thread max.
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub title_expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub parent_thread_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub branch_message_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub session_id: Option<String>,
    pub content_state: ContentState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadPage {
    pub context: ArchiveContext,
    pub items: Vec<ArchiveThread>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompletedContent {
    #[cfg_attr(test, schemars(schema_with = "version_schema"))]
    pub version: u8,
    pub display_message: DisplayMessage,
    pub answer: ArchiveTurnV1,
    pub completion_status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveMessage {
    pub attempt_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub run_id: Option<String>,
    pub origin: ContentOrigin,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub imported_at: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub completed_at: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub expires_at: Option<String>,
    pub content_state: ContentState,
    pub persistence: PersistenceState,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<CompletedContent>"))]
    pub content: Option<CompletedContent>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessagePage {
    pub context: ArchiveContext,
    pub thread_id: String,
    pub items: Vec<ArchiveMessage>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PruneResult {
    pub context: ArchiveContext,
    pub removed_messages: SafeCounter,
    pub removed_search_rows: SafeCounter,
    pub logical_bytes_released: SafeCounter,
    pub cleanup: CleanupState,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub safe_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DeleteResult {
    Deleted { cleanup: CleanupState },
    AlreadyDeleted {},
    BlockedActive { owners: Vec<String> },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ExportResult {
    Cancelled {},
    Saved { path: String, partial: bool },
}
#[cfg(test)]
pub(crate) fn version_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::*;
    Schema::Object(SchemaObject {
        instance_type: Some(InstanceType::Integer.into()),
        number: Some(Box::new(NumberValidation {
            minimum: Some(1.0),
            maximum: Some(1.0),
            ..Default::default()
        })),
        ..Default::default()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportResult {
    pub context: ArchiveContext,
    pub items: Vec<crate::runtime::conversations::legacy::ImportItem>,
    pub confirmed: Vec<ImportedIdentity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportedIdentity {
    pub thread_id: String,
    pub attempt_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub expires_at: Option<String>,
    pub imported_at: String,
}
