//! Preserve existing v2 access on platforms without the paired inode/VFS
//! adapter. New v3 access explicitly refuses; this is not native certification.
use super::*;

fn unsupported() -> AuthorityError {
    error(
        AuthorityErrorKind::UnsupportedOperation,
        "Paired selected storage is unavailable on this platform.",
    )
}
pub(super) struct WorkspaceLock;
impl WorkspaceLock {
    pub(super) fn validate(&self) -> Result<(), AuthorityError> {
        Err(unsupported())
    }
}
pub(super) fn schema_version(conn: &Connection) -> Result<i64, AuthorityError> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| invalid("Canonical schema version is unreadable."))
}
pub(super) fn verified_connection(
    binding: &SelectedBinding,
    writable: bool,
) -> Result<Connection, AuthorityError> {
    private_database(binding)?;
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let conn = Connection::open_with_flags(&binding.database, flags)
        .map_err(|_| missing("Canonical metadata cannot be opened."))?;
    conn.pragma_update(None, "trusted_schema", false)
        .map_err(|_| invalid("Canonical metadata cannot be inspected safely."))?;
    if metadata::paired_schema(schema_version(&conn)?) {
        return Err(unsupported());
    }
    private_database(binding)?;
    verify_schema(&conn)?;
    Ok(conn)
}
pub(super) fn read_guard(
    binding: &SelectedBinding,
) -> Result<Option<WorkspaceLock>, AuthorityError> {
    let parent = binding
        .database
        .parent()
        .ok_or_else(|| invalid("Missing metadata parent."))?;
    match fs::symlink_metadata(
        parent.join(&crate::workspace_migration::journal::rules().names.pending),
    ) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            return Err(error(
                AuthorityErrorKind::RecoveryRequired,
                "The workspace has an unfinished paired change.",
            ))
        }
    }
    verified_connection(binding, false)?;
    Ok(None)
}
pub(super) fn scan_presentation(binding: &SelectedBinding) -> Result<Vec<Entry>, AuthorityError> {
    // Preserve strict v2 reads. read_guard already refuses v3 on this platform.
    let _guard = read_guard(binding)?;
    scan_filtered_bound(binding, |_| true)
}
pub(super) fn selected_title(path: &str, body: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    crate::vault::parse::extract_h1_title(body.strip_prefix('\u{feff}').unwrap_or(body))
        .unwrap_or_else(|| {
            crate::vault::parse::humanize_stem(filename.strip_suffix(".md").unwrap_or(filename))
        })
}
pub(super) fn handle_unmoved(conn: &Connection) -> Result<(), AuthorityError> {
    if schema_version(conn)? == rules().schema_version {
        Ok(())
    } else {
        Err(unsupported())
    }
}
pub(super) fn page_budget(conn: &Connection, _: &SelectedBinding) -> Result<(), AuthorityError> {
    let pages: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(|_| invalid("Unreadable page count."))?;
    let size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|_| invalid("Unreadable page size."))?;
    let pages = u64::try_from(pages).map_err(|_| invalid("Invalid page count."))?;
    let size = u64::try_from(size).map_err(|_| invalid("Invalid page size."))?;
    if size == 0
        || pages
            .checked_mul(size)
            .is_none_or(|n| n > rules().limits.database_bytes)
    {
        return Err(error(
            AuthorityErrorKind::SourceLimit,
            "Canonical allocation exceeds its bound.",
        ));
    }
    Ok(())
}
pub(crate) fn replace_body(
    _: &Path,
    _: &str,
    _: &SelectedRecordVersion,
    _: &[u8],
    _: &WriteReceipt<Human>,
) -> Result<SelectedBodyAck, AuthorityError> {
    Err(unsupported())
}
pub(crate) fn recover_workspace(root: &Path) -> Result<RecoveryReport, AuthorityError> {
    let binding = authority::selected_binding(root)?;
    // read_guard refuses every pending object, validates exact v2 and already
    // returns typed unsupported for v3. No lock or metadata is created here.
    let _guard = read_guard(&binding)?;
    if authority::selected_binding(&binding.root)? != binding {
        return Err(error(
            AuthorityErrorKind::WrongIdentity,
            "The trusted workspace binding changed.",
        ));
    }
    Ok(RecoveryReport::Clean)
}

pub(crate) fn replace_body_with_recovery(
    _: &Path,
    _: &str,
    _: &SelectedRecordVersion,
    _: &[u8],
    _: &crate::vault::recovery::Journal,
    _: Option<&str>,
    _: &WriteReceipt<Human>,
) -> Result<ProtectedBodyAck, ProtectedBodyError> {
    Err(ProtectedBodyError::Authority(unsupported()))
}
pub(crate) fn recover_workspace_with_retention(
    root: &Path,
    _: &crate::vault::recovery::Journal,
) -> Result<RecoveryReport, AuthorityError> {
    recover_workspace(root)
}

pub(super) fn read_editor_snapshot(
    _: &Path,
    _: &str,
    _: &SelectedEditorTarget,
) -> Result<SelectedEditorSnapshot, AuthorityError> {
    Err(unsupported())
}
pub(super) fn save_editor_body(
    _: &Path,
    _: &str,
    _: &[u8],
    _: &EditorSaveRequest,
    _: &crate::vault::recovery::Journal,
    _: Option<&str>,
    _: &WriteReceipt<Human>,
) -> Result<EditorSaveResult, ProtectedBodyError> {
    Err(unsupported().into())
}

#[cfg(test)]
mod editor_portable_tests {
    use super::*;
    #[test]
    fn editor_adapter_refuses_without_touching_a_legacy_or_missing_path() {
        let target = SelectedEditorTarget {
            workspace_id: "e4a91c31-d241-4c30-bfac-183f2b32e304".into(),
            record_id: "5956a920-8034-4eb6-a267-5bf5c42c8464".into(),
        };
        let result =
            read_editor_snapshot(Path::new("this-path-is-never-opened"), "page.md", &target);
        assert_eq!(
            result.unwrap_err().kind,
            AuthorityErrorKind::UnsupportedOperation
        );
    }
}
