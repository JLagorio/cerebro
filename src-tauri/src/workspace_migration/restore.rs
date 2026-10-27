//! Restore-to-new-roots boundary. No registration, activation or IPC door.
use super::backup::BackupError;
use std::path::Path;

#[derive(Debug)]
pub struct RestoreReport {
    pub workspace_id: String,
}
/// Copies a completely verified bundle into two new roots and leaves them inactive.
pub fn restore_workspace(
    bundle: &Path,
    new_bodies: &Path,
    new_metadata: &Path,
) -> Result<RestoreReport, BackupError> {
    #[cfg(unix)]
    {
        super::backup::portable::restore_bundle(bundle, new_bodies, new_metadata)
    }
    #[cfg(not(unix))]
    {
        let _ = (bundle, new_bodies, new_metadata);
        Err(super::backup::unavailable())
    }
}
