//! Filesystem fixtures only. No native home discovery, installed gh execution,
//! actual account configuration, provider, or Keychain access occurs here.
use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "cerebro-gh-trust-test-{}",
            super::super::super::opaque_id()
        ));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
    fn file(&self, name: &str, mode: u32) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, b"synthetic-content-only").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }
    fn uid(&self) -> u32 {
        fs::symlink_metadata(&self.0).unwrap().uid()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn metadata_checks_reject_symlink_nonregular_and_shared_writes() {
    let tree = Tree::new();
    let file = tree.file("regular", 0o600);
    assert!(trusted_metadata(&file, tree.uid(), false).is_ok());
    let link = tree.0.join("link");
    symlink(&file, &link).unwrap();
    assert_eq!(
        trusted_metadata(&link, tree.uid(), false).err(),
        Some(ConnectionError::UnsafePath)
    );
    assert_eq!(
        trusted_metadata(&tree.0, tree.uid(), false).err(),
        Some(ConnectionError::UnsafePath)
    );
    fs::set_permissions(&file, fs::Permissions::from_mode(0o620)).unwrap();
    assert_eq!(
        trusted_metadata(&file, tree.uid(), false).err(),
        Some(ConnectionError::UnsafePath)
    );
}
#[test]
fn default_config_files_are_metadata_only_with_private_required_hosts() {
    let tree = Tree::new();
    assert_eq!(
        config_files(&tree.0, tree.uid()).err(),
        Some(ConnectionError::SignInRequired)
    );
    let hosts = tree.file("hosts.yml", 0o600);
    // Deliberately not YAML: metadata checks must never parse raw accounts.
    assert_eq!(config_files(&tree.0, tree.uid()).unwrap().len(), 1);
    tree.file("config.yml", 0o644);
    assert_eq!(config_files(&tree.0, tree.uid()).unwrap().len(), 2);
    fs::set_permissions(&hosts, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        config_files(&tree.0, tree.uid()).err(),
        Some(ConnectionError::UnsafePath)
    );
}
#[test]
fn optional_configuration_symlink_is_not_treated_as_absence() {
    let tree = Tree::new();
    tree.file("hosts.yml", 0o600);
    symlink(tree.0.join("missing"), tree.0.join("config.yml")).unwrap();
    assert_eq!(
        config_files(&tree.0, tree.uid()).err(),
        Some(ConnectionError::UnsafePath)
    );
}
#[test]
fn source_pin_detects_same_path_replacement_and_mode_change() {
    let tree = Tree::new();
    let path = tree.file("gh", 0o700);
    let first = PathPin::new(&path, &fs::symlink_metadata(&path).unwrap());
    let replacement = tree.file("replacement", 0o700);
    fs::rename(replacement, &path).unwrap();
    let second = PathPin::new(&path, &fs::symlink_metadata(&path).unwrap());
    assert!(first != second);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o500)).unwrap();
    assert!(second != PathPin::new(&path, &fs::symlink_metadata(&path).unwrap()));
}
#[test]
fn native_capture_failure_mapping_is_finite_and_secret_free() {
    use crate::spawn::private_output::{
        ChildOwnership, CleanupFacts, GroupAbsence, GroupSignalDisposition,
    };
    for kind in [
        FailureKind::InvalidCommand,
        FailureKind::Spawn,
        FailureKind::Pipe,
        FailureKind::OutputLimit,
        FailureKind::TimedOut,
        FailureKind::Cancelled,
        FailureKind::ExitFailure,
        FailureKind::StdoutHeldOpen,
        FailureKind::Cleanup,
    ] {
        let error = channel_error(PrivateFailure {
            kind,
            cleanup: CleanupFacts {
                child: ChildOwnership::Reaped,
                term: GroupSignalDisposition::Sent,
                kill: GroupSignalDisposition::Sent,
                group: GroupAbsence::Absent,
            },
        });
        assert_eq!(
            error,
            if kind == FailureKind::Cancelled {
                ConnectionError::Cancelled
            } else {
                ConnectionError::Unavailable
            }
        );
        assert!(matches!(
            serde_json::to_string(&error).unwrap().as_str(),
            "\"cancelled\"" | "\"unavailable\""
        ));
    }
}
#[test]
fn native_adapter_construction_does_not_discover_or_launch() {
    let adapter = NativeGhProcess::new(|| true);
    assert_eq!(
        adapter
            .capture_token(&GhTokenCommand {
                program: "gh",
                args: Vec::new(),
                clear_environment: false,
                environment: Vec::new(),
                timeout_ms: 0,
                output_limit: 0
            })
            .err(),
        Some(ConnectionError::Cancelled)
    );
}

#[test]
fn native_process_permit_refuses_overlap_and_releases_on_owner_drop() {
    let first = CapturePermit::acquire().unwrap();
    assert_eq!(
        CapturePermit::acquire().err(),
        Some(ConnectionError::Unavailable)
    );
    drop(first);
    drop(CapturePermit::acquire().unwrap());
}
