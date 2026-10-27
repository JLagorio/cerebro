//! Restart reconciliation of an original selected human operation. Recovery
//! never mints an approval, receipt or SystemWriter or applies a new SQL change.
//! Exact v2 without pending evidence is a startup no-op; v3 may let SQLite
//! perform its own crash rollback before reconciling the original paired intent.
use crate::workspace_service::{selected, types::selected::AuthorityError};
use std::path::Path;

pub(crate) use selected::RecoveryReport;

pub(crate) fn recover_workspace(root: &Path) -> Result<RecoveryReport, AuthorityError> {
    selected::recover_workspace(root)
}

/// Explicit setup-owned Journal for protected paired restart reconciliation.
pub(crate) fn recover_workspace_with_retention(
    root: &Path,
    journal: &crate::vault::recovery::Journal,
) -> Result<RecoveryReport, AuthorityError> {
    selected::recover_workspace_with_retention(root, journal)
}
