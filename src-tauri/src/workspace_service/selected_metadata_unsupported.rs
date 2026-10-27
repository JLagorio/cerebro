//! Preserve legacy selected reads; new metadata requests need the Unix owner.
use super::*;
pub(super) fn schema_version() -> i64 {
    static VERSION: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../shared/workspace/metadata-patch.v1.json"
        ))
        .expect("metadata patch policy")["selectedSchemaVersion"]
            .as_i64()
            .expect("metadata schema version")
    })
}
pub(super) fn paired_schema(version: i64) -> bool {
    version == crate::workspace_migration::journal::rules().selected_schema_version
        || version == schema_version()
}
pub(super) fn validate_requests(
    conn: &Connection,
    _workspace: &str,
    _snapshot: &Snapshot,
) -> Result<(), AuthorityError> {
    if store::schema_version(conn)? == schema_version() {
        return Err(error(
            AuthorityErrorKind::UnsupportedOperation,
            "Durable selected metadata requests are unavailable on this platform.",
        ));
    }
    Ok(())
}
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Original metadata request owner/native producer remain disabled."
    )
)]
pub(crate) fn patch_metadata(
    _root: &Path,
    _path: &str,
    _request: &MetadataPatchRequest,
    _by: &WriteReceipt<Human>,
) -> Result<MetadataPatchResult, AuthorityError> {
    Err(error(
        AuthorityErrorKind::UnsupportedOperation,
        "Durable selected metadata requests are unavailable on this platform.",
    ))
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Requested-field native producer is not enabled yet."
    )
)]
pub(crate) fn read_property(
    _root: &Path,
    _path: &str,
    _target: &SelectedEditorTarget,
    _field: &str,
) -> Result<SelectedPropertySnapshot, AuthorityError> {
    Err(error(
        AuthorityErrorKind::UnsupportedOperation,
        "Selected requested-field snapshots are unavailable on this platform.",
    ))
}
