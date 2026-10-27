//! Existing paired owner is the sole selected editor writer. No caller identity
//! or acknowledgement below creates a grant, schema, registration or lock file.
use super::*;
pub(crate) fn read_editor_snapshot(
    root: &Path,
    path: &str,
    target: &SelectedEditorTarget,
) -> Result<SelectedEditorSnapshot, AuthorityError> {
    store::read_editor_snapshot(root, path, target)
}
pub(crate) fn save_editor_body(
    root: &Path,
    path: &str,
    body: &[u8],
    request: &EditorSaveRequest,
    journal: &crate::vault::recovery::Journal,
    bypass: Option<&str>,
    by: &WriteReceipt<Human>,
) -> Result<EditorSaveResult, ProtectedBodyError> {
    store::save_editor_body(root, path, body, request, journal, bypass, by)
}
