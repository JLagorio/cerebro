//! Native first paired mutation. Admission and transaction ownership remain in
//! the selected service; no staging conversion or activation is implied.
use crate::{
    vault::receipt::{Human, WriteReceipt},
    workspace_service::{
        selected,
        types::selected::{AuthorityError, SelectedRecordVersion},
    },
};
use std::path::Path;

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Explicit paired CAS remains separate from the general editor winner rule; its consumer is pending."
    )
)]
pub(crate) fn commit_workspace_change(
    root: &Path,
    path: &str,
    expected: &SelectedRecordVersion,
    body: &[u8],
    by: &WriteReceipt<Human>,
) -> Result<selected::SelectedBodyAck, AuthorityError> {
    selected::replace_body(root, path, expected, body, by)
}

/// Protected explicit native CAS, sharing the original paired writer and locks.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Protected explicit CAS remains separate from the general editor winner rule; its consumer is pending."
    )
)]
pub(crate) fn commit_workspace_change_with_recovery(
    root: &Path,
    path: &str,
    expected: &SelectedRecordVersion,
    body: &[u8],
    journal: &crate::vault::recovery::Journal,
    bypass: Option<&str>,
    by: &WriteReceipt<Human>,
) -> Result<selected::ProtectedBodyAck, selected::ProtectedBodyError> {
    selected::replace_body_with_recovery(root, path, expected, body, journal, bypass, by)
}
