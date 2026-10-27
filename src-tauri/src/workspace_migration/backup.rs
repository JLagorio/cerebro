//! Closed boundary for the portable, inactive directory-bundle backup.
//! Live export is macOS-only; offline validation/restore use the Unix descriptor boundary.
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum BackupErrorKind {
    NotImplemented,
    UnsupportedContainer,
    UnsupportedPlatform,
    UnsupportedDependency,
    InvalidManifest,
    InvalidPath,
    SourceLimit,
    RequiredPartMissing,
    PartMismatch,
    InvalidMetadata,
    InvalidLedger,
    SourceChanged,
    RecoveryRequired,
    DestinationUnavailable,
    Busy,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupError {
    pub code: &'static str,
    pub kind: BackupErrorKind,
    pub message: String,
}
#[cfg(not(unix))]
pub(super) fn unavailable() -> BackupError {
    BackupError {
        code: "capability_unavailable",
        kind: BackupErrorKind::UnsupportedPlatform,
        message: "Portable backup requires the supported Unix descriptor boundary.".into(),
    }
}
#[cfg(unix)]
#[path = "portable.rs"]
pub(super) mod portable;
#[derive(Debug)]
pub struct BackupReport {
    pub workspace_id: String,
}
/// Private admitted result only. Public path-library reports keep their API.
#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct NativeCopyReport {
    pub workspace_id: String,
    pub summary: Option<CheckedBackupSummary>,
}
/// Opaque validation evidence, never a selected binding or an activation grant.
#[derive(Debug)]
pub struct VerifiedBackup {
    #[cfg(unix)]
    _verified: portable::Verified,
    #[cfg(not(unix))]
    _private: (),
}
pub fn backup_workspace(
    source_root: &Path,
    new_bundle: &Path,
) -> Result<BackupReport, BackupError> {
    #[cfg(unix)]
    {
        portable::create_backup(source_root, new_bundle)
    }
    #[cfg(not(unix))]
    {
        let _ = (source_root, new_bundle);
        Err(unavailable())
    }
}
pub fn validate_backup(bundle: &Path) -> Result<VerifiedBackup, BackupError> {
    #[cfg(unix)]
    {
        portable::validate_bundle(bundle).map(|_verified| VerifiedBackup { _verified })
    }
    #[cfg(not(unix))]
    {
        let _ = bundle;
        Err(unavailable())
    }
}
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn effective_limit_for_test(name: &str) -> u64 {
    let limits = portable::limits().expect("compiled limit arithmetic");
    match name {
        "file_bytes" | "body_bytes" => limits.body,
        "retained_bytes" => limits.retained,
        "total_bytes" => limits.body_total + limits.database + limits.retained_total,
        "database_bytes" => limits.database,
        "manifest_bytes" => limits.manifest,
        "files" => limits.files as u64,
        "entries" => limits.entries as u64,
        "depth" => limits.depth as u64,
        "path_bytes" => limits.path_bytes as u64,
        _ => panic!("Unknown test limit: {name}"),
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) use portable::with_step as with_step_for_test;

#[cfg(all(test, not(target_os = "macos")))]
mod unsupported_export_tests {
    use super::*;
    use std::{collections::BTreeMap, fs, path::PathBuf};

    fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        walkdir::WalkDir::new(root)
            .min_depth(1)
            .into_iter()
            .map(|entry| {
                let entry = entry.unwrap();
                let relative = entry.path().strip_prefix(root).unwrap().to_path_buf();
                let bytes = if entry.file_type().is_dir() {
                    None
                } else {
                    assert!(entry.file_type().is_file());
                    Some(fs::read(entry.path()).unwrap())
                };
                (relative, bytes)
            })
            .collect()
    }

    #[test]
    fn portable_live_export_refuses_unsupported_platform_without_any_path_mutation() {
        let root = crate::vault::testutil::temp_vault("portable-unsupported-platform");
        crate::vault::testutil::write(&root, "source/page.md", "# Source sentinel\n");
        crate::vault::testutil::write(
            &root,
            "source/.cerebro/workspace-format.json",
            "unread marker sentinel",
        );
        crate::vault::testutil::write(&root, "source/workspace.db", "unread database sentinel");
        crate::vault::testutil::write(
            &root,
            "existing-bundle/foreign",
            "foreign destination sentinel",
        );
        let before = tree(&root);
        for (source, destination) in [
            ("source", "new-bundle"),
            ("source", "existing-bundle"),
            ("absent-source", "new-bundle"),
        ] {
            let error = backup_workspace(&root.join(source), &root.join(destination)).unwrap_err();
            assert_eq!(error.code, "capability_unavailable");
            assert_eq!(error.kind, BackupErrorKind::UnsupportedPlatform);
            assert!(!error.message.is_empty());
            assert_eq!(tree(&root), before);
            assert!(!root.join("new-bundle").exists());
            assert!(!root.join("source/selected.lock").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn portable_nonmac_unix_offline_entrypoints_still_refuse_missing_input_without_outputs() {
        // Dispatch coverage only: successful image decoding/restore needs a real
        // portable bundle fixture and execution on the nonmac Unix target.
        let root = crate::vault::testutil::temp_vault("portable-offline-entrypoints");
        let bundle = root.join("missing-bundle");
        let bodies = root.join("bodies");
        let metadata = root.join("metadata");
        assert_eq!(
            validate_backup(&bundle).unwrap_err().kind,
            BackupErrorKind::RequiredPartMissing
        );
        assert_eq!(
            crate::workspace_migration::restore::restore_workspace(&bundle, &bodies, &metadata)
                .unwrap_err()
                .kind,
            BackupErrorKind::RequiredPartMissing
        );
        assert!(tree(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

/// Native-held output choice. No filesystem mutation until consumed by its lease.
#[cfg(unix)]
pub(crate) struct NewDirectoryChoice {
    parent: portable::io::Root,
    leaf: String,
    path: std::path::PathBuf,
}
#[cfg(unix)]
impl NewDirectoryChoice {
    pub(crate) fn new(parent: &Path, leaf: &str) -> Result<Self, BackupError> {
        portable::checked_path(leaf)?;
        if Path::new(leaf).components().count() != 1 {
            return Err(portable::error(
                BackupErrorKind::InvalidPath,
                "One new directory name is required.",
            ));
        }
        let parent = portable::io::Root::open(parent)?;
        let path = parent.path.join(leaf);
        let choice = Self {
            parent,
            leaf: leaf.to_owned(),
            path,
        };
        choice.validate()?;
        Ok(choice)
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn parent(&self) -> &Path {
        &self.parent.path
    }
    pub(crate) fn validate(&self) -> Result<(), BackupError> {
        self.parent.validate()?;
        match std::fs::symlink_metadata(&self.path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(portable::error(
                BackupErrorKind::DestinationUnavailable,
                "The new output directory is no longer absent.",
            )),
        }
    }
    pub(crate) fn create_observed(
        self,
        facts: &OutputFacts,
    ) -> Result<OutputDirectory, BackupError> {
        self.validate()?;
        self.parent
            .create_child_observed(&self.leaf, facts)
            .map(|root| OutputDirectory { root })
    }
}
/// Kept by the native worker, inside its outer OutputReservation lifetime.
#[cfg(unix)]
pub(crate) struct OutputDirectory {
    root: portable::io::Root,
}
#[cfg(unix)]
impl OutputDirectory {
    pub(super) fn into_root(self) -> portable::io::Root {
        self.root
    }
    pub(crate) fn path(&self) -> &Path {
        &self.root.path
    }
    pub(crate) fn held_identity(&self) -> Result<(u64, u64), BackupError> {
        self.root.held_identity()
    }
    pub(crate) fn passive_directory(&self) -> Result<std::fs::File, BackupError> {
        self.root.passive_directory()
    }
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Used by native output ownership acceptance tests."
        )
    )]
    pub(crate) fn validate(&self) -> Result<(), BackupError> {
        self.root.validate()
    }
}

/// Native coordinator handoff only; no command or activation exposes it yet.
/// The inner call owns EVERY reader/writer. On success, error or unwind they
/// close before this outer reservation is released; no timeout owns this scope.
#[cfg(target_os = "macos")]
pub(crate) fn backup_admitted(
    source: crate::workspace_service::authority::AdmittedBackupRead,
    mut output: crate::workspace_service::authority::OutputReservation,
) -> Result<NativeCopyReport, BackupError> {
    portable::create_reserved_backup(source, &mut output)
}

/// Compact checked facts only; no per-part inventory or validation object.
#[cfg(unix)]
pub(crate) use portable::CheckedBackupInput;
#[cfg(unix)]
pub(crate) use portable::CheckedBackupSummary;

#[cfg(unix)]
pub(crate) fn check_backup_input(bundle: &Path) -> Result<CheckedBackupInput, BackupError> {
    portable::check_input(bundle)
}

/// Native worker entry: input and every transient writer drop before this
/// outer reservation, on return, error or unwind. No timeout releases it.
#[cfg(unix)]
pub(crate) fn restore_admitted(
    input: CheckedBackupInput,
    mut output: crate::workspace_service::authority::OutputReservation,
) -> Result<NativeCopyReport, BackupError> {
    let summary = input.summary().clone();
    portable::restore_reserved(input, &mut output).map(|report| NativeCopyReport {
        workspace_id: report.workspace_id,
        summary: Some(summary),
    })
}

/// Real owned output facts. No path lookup or caller boolean can advance them.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum OutputPhase {
    NotStarted,
    CreationAttempted,
    Created,
    PublicationAttempted,
    Published,
}
#[cfg(unix)]
pub(crate) struct OutputFacts(std::sync::atomic::AtomicU8);
#[cfg(unix)]
impl OutputFacts {
    pub(crate) fn new() -> Self {
        Self(std::sync::atomic::AtomicU8::new(0))
    }
    pub(crate) fn phase(&self) -> OutputPhase {
        match self.0.load(std::sync::atomic::Ordering::SeqCst) {
            0 => OutputPhase::NotStarted,
            1 => OutputPhase::CreationAttempted,
            2 => OutputPhase::Created,
            3 => OutputPhase::PublicationAttempted,
            4 => OutputPhase::Published,
            _ => unreachable!("private output phase"),
        }
    }
    fn advance(&self, phase: OutputPhase) {
        // One original recorder, monotonic even when error/unwind follows a
        // successful syscall/publication. Never derive phase from path existence.
        self.0
            .fetch_max(phase as u8, std::sync::atomic::Ordering::SeqCst);
    }
    pub(crate) fn creation_attempted(&self) {
        self.advance(OutputPhase::CreationAttempted);
    }
    pub(crate) fn created(&self) {
        self.advance(OutputPhase::Created);
    }
    pub(crate) fn publication_attempted(&self) {
        self.advance(OutputPhase::PublicationAttempted);
    }
    pub(crate) fn published(&self) {
        self.advance(OutputPhase::Published);
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) fn native_copy_step(name: &'static str, first: &Path, second: &Path) {
    portable::step(name, first, second);
}

#[cfg(unix)]
pub(crate) fn omissions() -> Vec<String> {
    portable::rules().omitted_scopes.clone()
}
