/// A path selector in the current vault format, not a portable record identity.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyRecordLocator {
    pub path: String,
}

/// Complete UTF-8 source and SHA-256 of those same bytes. `hash` includes the
/// frontmatter and BOM; it is not a body hash or a metadata revision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyRecordSnapshot {
    pub content: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum StoreErrorCode {
    CapabilityUnavailable,
}

/// Internal error envelope. The existing IPC command still returns its original
/// displayable error string; no read failure is replaced with empty content.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub(crate) struct StoreError {
    pub code: StoreErrorCode,
    pub message: String,
    pub retryable: bool,
}

/// Canonical tagged values, used by inactive selected-store staging (M99.6).
pub(crate) mod values {
    use std::collections::BTreeMap;

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    // Empty struct variants keep deny_unknown_fields effective (Serde unit
    // variants otherwise ignore extra payload fields). Their wire shape is unchanged.
    pub(crate) enum PropertyValue {
        Null {},
        String {
            value: String,
        },
        Boolean {
            value: bool,
        },
        Decimal {
            value: String,
        },
        Array {
            value: Vec<PropertyValue>,
        },
        Object {
            value: BTreeMap<String, PropertyValue>,
        },
        Date {
            value: String,
        },
        Instant {
            value: String,
        },
        Relation {
            spelling: String,
            fragment: Option<String>,
            resolution: RelationResolution,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
    pub(crate) enum RelationResolution {
        Unresolved {},
        Ambiguous {},
        Resolved {
            #[serde(rename = "targetId")]
            target_id: String,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
    pub(crate) enum PropertyChange {
        Set { key: String, value: PropertyValue },
        Remove { key: String },
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum ValueSchema {
        Plain,
        Date,
        Instant,
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum ValueErrorCode {
        SchemaInvalid,
        CapabilityUnavailable,
    }

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(deny_unknown_fields)]
    pub(crate) struct ValueError {
        pub code: ValueErrorCode,
        pub message: String,
        pub retryable: bool,
    }
}

/// M99.4 disposable contracts, deliberately separate from production admission
/// and receipt-bearing mutations. These are not IPC DTOs or writable-vault APIs.
#[cfg(test)]
pub(crate) mod prototype {
    use super::values::{PropertyChange, PropertyValue};
    use serde::{Deserialize, Serialize};
    use std::{
        collections::{BTreeMap, BTreeSet},
        path::PathBuf,
    };

    pub(crate) type Properties = BTreeMap<String, PropertyValue>;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct RecordVersion {
        pub metadata_revision: u64,
        pub body_hash: String,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct Record {
        pub id: String,
        pub path: String,
        pub properties: Properties,
        pub version: RecordVersion,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(crate) struct RecordSnapshot {
        pub record: Record,
        pub body: Vec<u8>,
    }
    /// Constructed only by the disposable owner; never deserialized from input.
    #[derive(Debug, Clone)]
    pub(crate) struct PrototypeScope {
        pub(super) root: PathBuf,
        pub(super) workspace_id: String,
        pub(super) readable: BTreeSet<String>,
        pub(super) writable: BTreeSet<String>,
        pub(super) create_paths: BTreeSet<String>,
    }
    impl PrototypeScope {
        pub(crate) fn for_disposable_owner(
            root: PathBuf,
            workspace_id: String,
            readable: BTreeSet<String>,
            writable: BTreeSet<String>,
            create_paths: BTreeSet<String>,
        ) -> Self {
            Self {
                root,
                workspace_id,
                readable,
                writable,
                create_paths,
            }
        }
        pub(crate) fn matches(&self, root: &std::path::Path, workspace_id: &str) -> bool {
            self.root == root && self.workspace_id == workspace_id
        }
        pub(crate) fn can_read(&self, id: &str) -> bool {
            self.readable.contains(id)
        }
        pub(crate) fn can_write(&self, id: &str) -> bool {
            self.writable.contains(id)
        }
        pub(crate) fn can_create(&self, path: &str) -> bool {
            self.create_paths.contains(path)
        }
        pub(crate) fn fingerprint(&self) -> String {
            crate::ledger::sha256_hex(
                format!("{:?}|{}|{:?}", self.root, self.workspace_id, self.readable).as_bytes(),
            )
        }
    }
    #[derive(Debug, Clone)]
    pub(crate) enum Mutation {
        Create {
            id: String,
            path: String,
            body: Vec<u8>,
            properties: Properties,
            expected_schema: u64,
        },
        Patch {
            id: String,
            expected: RecordVersion,
            expected_schema: u64,
            changes: Vec<PropertyChange>,
        },
        Delete {
            id: String,
            expected: RecordVersion,
            expected_schema: u64,
        },
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub(crate) struct PrototypeOutcome {
        pub workspace_revision: u64,
        pub schema_revision: u64,
        pub version: Option<RecordVersion>,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub(crate) struct PrototypeError {
        pub kind: String,
        pub detail: String,
    }
    pub(crate) fn error(kind: &str, detail: impl Into<String>) -> PrototypeError {
        PrototypeError {
            kind: kind.into(),
            detail: detail.into(),
        }
    }
    pub(crate) type Result<T> = std::result::Result<T, PrototypeError>;
    #[derive(Debug, Clone)]
    pub(crate) struct QueryRequest {
        pub query: serde_json::Value,
        pub zone: String,
        pub today: String,
        pub cursor: Option<String>,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub(crate) struct QueryPage {
        pub rows: Vec<RecordSnapshot>,
        pub cursor: Option<String>,
        pub workspace_revision: u64,
        pub schema_revision: u64,
    }
}

/// Activated format contracts. An input version is an expectation, never authority.
pub(crate) mod selected {
    use super::StoreErrorCode;
    use serde::{Deserialize, Serialize};
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SelectedRecordVersion {
        pub kind: SelectedAuthorityKind,
        pub workspace_id: String,
        pub record_id: String,
        pub metadata_revision: String,
        pub metadata_hash: String,
        pub body_hash: String,
    }
    /// Exact selected metadata from the same guarded record as Entry.authority.
    /// Compatible legacy fields never replace canonical presence or kind tags.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(crate) struct SelectedEntryProperties {
        pub value: super::values::PropertyValue,
        pub unavailable_legacy_keys: Vec<String>,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "snake_case")]
    pub enum SelectedAuthorityKind {
        SqliteMetadata,
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum SelectedMode {
        Wide,
        Default,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    pub(crate) enum SelectedMetadataAck {
        Applied {
            version: SelectedRecordVersion,
            #[serde(rename = "fullWidth")]
            full_width: bool,
        },
        Unchanged {
            version: SelectedRecordVersion,
            #[serde(rename = "fullWidth")]
            full_width: bool,
        },
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum AuthorityErrorKind {
        SelectedAuthorityUnavailable,
        ContextUnavailable,
        BindingUnavailable,
        InvalidBinding,
        MissingMarker,
        InvalidFormat,
        UnsupportedFormat,
        InactiveWorkspace,
        UnboundWorkspace,
        WrongIdentity,
        MetadataUnavailable,
        InvalidMetadata,
        UnsupportedProjection,
        SourceChanged,
        StaleMetadata,
        UnsupportedOperation,
        SourceLimit,
        Busy,
        RecoveryRequired,
        RecoveryConflict,
        ArtifactPressure,
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(untagged)]
    pub(crate) enum CommandReadError {
        Legacy(String),
        Authority(AuthorityError),
    }
    impl From<String> for CommandReadError {
        fn from(message: String) -> Self {
            Self::Legacy(message)
        }
    }
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(schemars::JsonSchema))]
    #[serde(deny_unknown_fields)]
    pub(crate) struct AuthorityError {
        pub code: StoreErrorCode,
        pub kind: AuthorityErrorKind,
        pub message: String,
        pub retryable: bool,
    }
}
