//! Portable paired result/receipt data; none of these values grants authority.
use super::SelectedRecordVersion;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OriginalReceipt {
    pub(super) workspace_id: String,
    pub(super) epoch: i64,
    pub(super) record_id: String,
    pub(super) previous_revision: i64,
    pub(super) revision: i64,
    pub(super) metadata_before_hash: String,
    pub(super) metadata_after_hash: String,
    pub(super) body_before_hash: String,
    pub(super) body_after_hash: String,
    pub(super) actor: String,
    pub(super) run_id: Option<String>,
    pub(super) approved_by: Option<String>,
    pub(super) operation: String,
    pub(super) at: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SelectedBodyAck {
    Unchanged {
        version: SelectedRecordVersion,
    },
    Applied {
        version: SelectedRecordVersion,
        epoch: String,
        operation_id: String,
        receipt: Box<OriginalReceipt>,
    },
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecoveryReport {
    Clean,
    RolledBack {
        operation_id: String,
        receipt: OriginalReceipt,
    },
    Completed {
        operation_id: String,
        receipt: OriginalReceipt,
    },
}

/// Descriptive result of the protected explicit CAS primitive. This does not
/// change the general editor's winner rule or confer mutation authority.
#[derive(Debug)]
pub(crate) struct ProtectedBodyAck {
    pub(crate) pair: SelectedBodyAck,
    pub(crate) recovery: crate::vault::recovery::Outcome,
}
#[derive(Debug)]
pub(crate) enum ProtectedBodyError {
    Authority(crate::workspace_service::types::selected::AuthorityError),
    Retention(String),
}

impl From<crate::workspace_service::types::selected::AuthorityError> for ProtectedBodyError {
    fn from(error: crate::workspace_service::types::selected::AuthorityError) -> Self {
        Self::Authority(error)
    }
}
impl std::fmt::Display for ProtectedBodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Authority(error) => f.write_str(&error.message),
            Self::Retention(message) => f.write_str(message),
        }
    }
}
