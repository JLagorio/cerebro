//! P1 RED: real portable restore output must not become legacy via an ancestor.
//! Admission sentinels launch no process; the ordinary list_dir control may invoke Git.
//! The tests install fixture-local authority only and do not constitute Wry/native acceptance.
use super::{file_tree, PortableFixture};
use crate::vault::testutil;
use crate::workspace_service::types::selected::{
    AuthorityError, AuthorityErrorKind, CommandReadError,
};
use crate::workspace_service::{authority, native_admission as native};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
};

const MARKER: &str = ".cerebro/workspace-format.json";
const WORKSPACE: &str = "3ee5b6eb-9f80-4bac-9538-f2a0c5938a62";

struct Restored {
    fixture: PortableFixture,
    container: PathBuf,
    bodies: PathBuf,
    metadata: PathBuf,
}
impl Restored {
    fn new(label: &str) -> Self {
        let fixture = PortableFixture::new(label);
        let bundle = fixture.export();
        let container = fixture.output.join("separate-copy");
        fs::create_dir(&container).unwrap();
        // Deliberately arbitrary labels: the marker, never these names, is authority.
        let bodies = container.join("restored-content-47");
        let metadata = container.join("retained-state-81");
        fixture.selected.run(|| {
            crate::workspace_migration::restore::restore_workspace(&bundle, &bodies, &metadata)
                .expect("real inactive restore fixture must succeed");
        });
        testutil::write(
            &fixture.output,
            "ordinary/keep.md",
            "# Ordinary sibling\r\n",
        );
        testutil::write(
            &fixture.output,
            "ordinary/keep.txt",
            "Ordinary exact bytes\r\n",
        );
        Self {
            fixture,
            container,
            bodies,
            metadata,
        }
    }
    fn higher(&self) -> &Path {
        &self.fixture.output
    }
    fn context(&self) -> authority::AuthorityContext {
        authority::AuthorityContext::new(self.fixture.selected.origin.clone())
    }
    fn run<T>(&self, operation: impl FnOnce() -> T) -> T {
        self.fixture.selected.run(operation)
    }
    fn mount(&self, root: &Path) {
        crate::app_config::save(
            &self.fixture.selected.origin,
            &crate::app_config::AppConfig {
                last_vault: Some(root.to_str().unwrap().to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
    }
}
fn relative(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .unwrap()
        .to_str()
        .unwrap()
        .replace('\\', "/")
}
fn dispatch<T>(
    f: &Restored,
    command: &str,
    args: Value,
    handler: impl FnOnce() -> T,
) -> Result<T, AuthorityError> {
    let request = native::request(command, &tauri::ipc::InvokeBody::Json(args))?;
    native::dispatch_checked(&f.context(), request, handler)
}
fn deny_dispatch(f: &Restored, command: &str, args: Value, kind: AuthorityErrorKind) {
    let reached = Cell::new(false);
    let result = dispatch(f, command, args, || reached.set(true));
    assert!(
        !reached.get(),
        "{command} reached its handler through a protected scope"
    );
    let error = result.expect_err("marked intersection must return a typed refusal");
    assert_eq!(error.kind, kind);
    assert!(!error.retryable);
}
fn invalid_read(result: Result<String, CommandReadError>) {
    match result {
        Err(CommandReadError::Authority(error)) => {
            assert_eq!(error.kind, AuthorityErrorKind::InvalidFormat);
            assert!(!error.retryable);
        }
        other => panic!("expected typed authority refusal before note bytes, got {other:?}"),
    }
}

// Mutations caught: root-only admission, descendant skip-as-success, or late dispatch denial.
#[test]
fn native_container_open_denies_before_handler() {
    let f = Restored::new("nested-container-open");
    deny_dispatch(
        &f,
        "start_watcher",
        json!({"vault":f.container}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn native_higher_ancestor_open_denies_before_handler() {
    let f = Restored::new("nested-higher-open");
    deny_dispatch(
        &f,
        "start_watcher",
        json!({"vault":f.higher()}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn native_container_agent_denies_before_handler() {
    let f = Restored::new("nested-container-agent");
    deny_dispatch(
        &f,
        "run_agent",
        json!({"vault":f.container}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn native_higher_ancestor_agent_denies_before_handler() {
    let f = Restored::new("nested-higher-agent");
    deny_dispatch(
        &f,
        "run_agent",
        json!({"vault":f.higher()}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn direct_restored_body_root_control_refuses_before_open_handler() {
    let f = Restored::new("nested-direct-control");
    deny_dispatch(
        &f,
        "start_watcher",
        json!({"vault":f.bodies}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn contained_native_read_is_typed_before_handler() {
    let f = Restored::new("nested-native-read");
    let rel = relative(f.higher(), &f.bodies.join("page.md"));
    deny_dispatch(
        &f,
        "read_note",
        json!({"vault":f.higher(),"path":rel}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn contained_native_save_is_typed_before_handler() {
    let f = Restored::new("nested-native-save");
    let rel = relative(f.higher(), &f.bodies.join("page.md"));
    deny_dispatch(
        &f,
        "save_note",
        json!({"vault":f.higher(),"path":rel,"body":"# Replaced\n"}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn actual_note_command_cannot_read_restored_body_through_container() {
    let f = Restored::new("nested-actual-read-container");
    let rel = relative(&f.container, &f.bodies.join("page.md"));
    f.run(|| {
        invalid_read(crate::read_note(
            f.container.to_str().unwrap().to_owned(),
            rel,
        ))
    });
}
#[test]
fn actual_note_command_cannot_read_restored_body_through_higher_ancestor() {
    let f = Restored::new("nested-actual-read-higher");
    let rel = relative(f.higher(), &f.bodies.join("page.md"));
    f.run(|| {
        invalid_read(crate::read_note(
            f.higher().to_str().unwrap().to_owned(),
            rel,
        ))
    });
}
#[test]
fn legacy_writer_refuses_a_contained_restored_body() {
    let f = Restored::new("nested-writer-refusal");
    let rel = relative(f.higher(), &f.bodies.join("page.md"));
    let by = crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write(&rel).unwrap(),
    );
    let result = f.run(|| {
        crate::vault::write::save_note(f.higher(), &rel, "# Forbidden overwrite\n", None, &by)
    });
    assert!(
        result.is_err(),
        "legacy writer accepted a restored body under an ancestor"
    );
}
#[test]
fn refused_contained_write_preserves_every_restored_carrier() {
    let f = Restored::new("nested-writer-preservation");
    let before = file_tree(&f.container);
    let rel = relative(f.higher(), &f.bodies.join("page.md"));
    let by = crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write(&rel).unwrap(),
    );
    let _result = f.run(|| {
        crate::vault::write::save_note(f.higher(), &rel, "# Forbidden overwrite\n", None, &by)
    });
    assert_eq!(
        file_tree(&f.container),
        before,
        "a denied write changed body, metadata or retained originals"
    );
}
#[test]
fn legacy_path_lock_cannot_authorize_nonexistent_descendant_in_restored_body_root() {
    let f = Restored::new("nested-new-child-lock");
    let rel = relative(f.higher(), &f.bodies.join("new/future.md"));
    let result = f.run(|| crate::vault::write::lock_paths(f.higher(), &[&rel]));
    assert!(
        result.is_err(),
        "path lock authorized a future child beneath the inactive marker"
    );
    assert!(!f.bodies.join("new").exists());
}
#[test]
fn actual_scan_command_reports_typed_unavailable_for_container() {
    let f = Restored::new("nested-command-scan");
    let result = f.run(|| crate::scan_vault(f.container.to_str().unwrap().to_owned()));
    match result {
        Err(CommandReadError::Authority(error)) => {
            assert_eq!(error.kind, AuthorityErrorKind::InvalidFormat)
        }
        other => panic!("expected typed unavailable scan, got {other:?}"),
    }
}
#[test]
fn library_scan_refuses_higher_ancestor_instead_of_returning_partial_entries() {
    let f = Restored::new("nested-library-scan");
    let result = f.run(|| crate::vault::scan::scan_vault(f.higher()));
    assert!(
        result.is_err(),
        "recursive scan consumed nested restore as legacy"
    );
}
#[test]
fn corpus_refuses_before_publishing_nested_body_text() {
    let f = Restored::new("nested-corpus");
    let cache = crate::vault::corpus::CorpusCache::new(1);
    let result = f.run(|| cache.snapshot(&f.container));
    assert!(
        result.is_err(),
        "search corpus published nested restored text"
    );
}
#[test]
fn folders_refuse_instead_of_listing_inactive_subtree() {
    let f = Restored::new("nested-folders");
    let result = f.run(|| crate::vault::scan::list_folders(&f.container));
    assert!(
        result.is_err(),
        "folder listing successfully traversed an inactive subtree"
    );
}
#[test]
fn mounted_recursive_tree_refuses_unregistered_nested_marker_before_handler() {
    let f = Restored::new("nested-mounted-tree");
    f.mount(f.higher());
    deny_dispatch(
        &f,
        "list_dir",
        json!({"rootId":"0","path":"separate-copy"}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn mounted_exact_body_control_already_refuses_by_actual_target_ancestry() {
    let f = Restored::new("nested-mounted-exact-control");
    f.mount(f.higher());
    let rel = relative(f.higher(), &f.bodies.join("page.md"));
    deny_dispatch(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":rel}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn open_publication_cannot_bind_ancestor_or_resume_agent_admission() {
    let f = Restored::new("nested-publication");
    let context = f.context();
    let agents = crate::agent::AgentState::default();
    let generation = context.begin_open().unwrap();
    agents.begin_open(generation).unwrap();
    let bound = Cell::new(false);
    let result = crate::finish_legacy_open(&context, generation, &f.container, &agents, || {
        bound.set(true)
    });
    assert!(
        !bound.get(),
        "ancestor opening published a binding before boundary denial"
    );
    assert_eq!(result.unwrap_err().kind, AuthorityErrorKind::InvalidFormat);
    assert_eq!(context.active_root().unwrap(), None);
    assert!(agents.prepare_run(&f.container).is_err());
}

// A second load-bearing RED: real restore metadata has no own denial marker today.
// Per-path ancestry cannot infer an unmarked sibling's ownership from Pages alone.
#[test]
fn restored_metadata_database_is_denied_before_native_bytes_handler() {
    let f = Restored::new("nested-metadata-database");
    f.mount(f.higher());
    let rel = relative(f.higher(), &f.metadata.join("workspace.db"));
    deny_dispatch(
        &f,
        "read_file_bytes",
        json!({"rootId":"0","path":rel}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn restored_original_is_denied_before_native_text_handler() {
    let f = Restored::new("nested-metadata-original");
    f.mount(f.higher());
    let rel = relative(f.higher(), &f.metadata.join("originals/page.md"));
    deny_dispatch(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":rel}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn actual_note_command_cannot_read_retained_original_from_ancestor() {
    let f = Restored::new("nested-original-command");
    let rel = relative(f.higher(), &f.metadata.join("originals/page.md"));
    f.run(|| {
        invalid_read(crate::read_note(
            f.higher().to_str().unwrap().to_owned(),
            rel,
        ))
    });
}
#[test]
fn legacy_writer_refuses_retained_original_from_ancestor() {
    let f = Restored::new("nested-original-writer");
    let rel = relative(f.higher(), &f.metadata.join("originals/page.md"));
    let by = crate::vault::receipt::WriteReceipt::ipc(
        crate::knowledge::guard_human_write(&rel).unwrap(),
    );
    let before = fs::read(f.metadata.join("originals/page.md")).unwrap();
    let result = f.run(|| {
        crate::vault::write::save_note(
            f.higher(),
            &rel,
            "# Forbidden original replacement\n",
            None,
            &by,
        )
    });
    assert!(
        result.is_err(),
        "legacy writer accepted the metadata original as an ordinary note"
    );
    assert_eq!(
        fs::read(f.metadata.join("originals/page.md")).unwrap(),
        before
    );
}
#[test]
fn recursive_scan_of_metadata_root_is_unavailable() {
    let f = Restored::new("nested-metadata-scan");
    let result = f.run(|| crate::vault::scan::scan_vault(&f.metadata));
    assert!(
        result.is_err(),
        "metadata originals were consumed by ordinary scanning"
    );
}
#[test]
fn metadata_export_overwrite_is_denied_before_effect() {
    let f = Restored::new("nested-metadata-export");
    let target = f.metadata.join("workspace.db");
    let before = fs::read(&target).unwrap();
    let result = native::publish_export(&f.context(), &target, b"forbidden database overwrite");
    assert_eq!(
        fs::read(&target).unwrap(),
        before,
        "post-dialog export overwrote restored metadata"
    );
    assert!(matches!(result, Err(CommandReadError::Authority(_))));
}

#[test]
fn malformed_nested_marker_denies_broad_dispatch() {
    let f = Restored::new("nested-malformed");
    fs::write(f.bodies.join(MARKER), b"{broken").unwrap();
    deny_dispatch(
        &f,
        "run_agent",
        json!({"vault":f.container}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn unsupported_nested_format_denies_broad_dispatch() {
    let f = Restored::new("nested-unsupported");
    fs::write(
        f.bodies.join(MARKER),
        br#"{"format":999,"authority":"future"}"#,
    )
    .unwrap();
    deny_dispatch(
        &f,
        "start_watcher",
        json!({"vault":f.container}),
        AuthorityErrorKind::UnsupportedFormat,
    );
}
#[test]
fn registered_missing_nested_marker_control_remains_specific() {
    let f = Restored::new("nested-known-missing");
    fs::write(
        f.fixture
            .selected
            .origin
            .join("workspaces/bindings.v1.json"),
        json!({
            "version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":f.bodies}]
        })
        .to_string(),
    )
    .unwrap();
    fs::remove_file(f.bodies.join(MARKER)).unwrap();
    deny_dispatch(
        &f,
        "run_agent",
        json!({"vault":f.container}),
        AuthorityErrorKind::MissingMarker,
    );
}
#[test]
fn registered_missing_marker_control_does_not_block_unrelated_exact_sibling() {
    let f = Restored::new("nested-missing-sibling");
    fs::write(
        f.fixture
            .selected
            .origin
            .join("workspaces/bindings.v1.json"),
        json!({
            "version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":f.bodies}]
        })
        .to_string(),
    )
    .unwrap();
    fs::remove_file(f.bodies.join(MARKER)).unwrap();
    f.mount(f.higher());
    let actual = dispatch(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"ordinary/keep.txt"}),
        || crate::roots::read::read_file_text(f.higher(), "ordinary/keep.txt"),
    )
    .unwrap();
    assert!(
        matches!(actual, crate::roots::read::FileText::Text { ref content } if content == "Ordinary exact bytes\r\n")
    );
}
#[test]
fn native_note_exact_sibling_stays_readable_under_mixed_ancestor() {
    let f = Restored::new("nested-note-sibling");
    let actual = dispatch(
        &f,
        "read_note",
        json!({"vault":f.higher(),"path":"ordinary/keep.md"}),
        || {
            f.run(|| {
                crate::read_note(
                    f.higher().to_str().unwrap().to_owned(),
                    "ordinary/keep.md".to_owned(),
                )
            })
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(actual, "# Ordinary sibling\r\n");
}
#[test]
fn native_note_exact_sibling_stays_writable_under_mixed_ancestor() {
    let f = Restored::new("nested-save-sibling");
    let before = file_tree(&f.container);
    dispatch(
        &f,
        "save_note",
        json!({"vault":f.higher(),"path":"ordinary/keep.md","body":"# Edited sibling\n"}),
        || {
            f.run(|| {
                crate::save_note_legacy(
                    f.higher().to_str().unwrap().to_owned(),
                    "ordinary/keep.md".to_owned(),
                    "# Edited sibling\n".to_owned(),
                    None,
                )
            })
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        fs::read_to_string(f.higher().join("ordinary/keep.md")).unwrap(),
        "# Edited sibling\n"
    );
    assert_eq!(file_tree(&f.container), before);
}
#[test]
fn unrelated_recursive_sibling_stays_listable_under_mixed_mount() {
    let f = Restored::new("nested-tree-sibling");
    f.mount(f.higher());
    let rows = dispatch(
        &f,
        "list_dir",
        json!({"rootId":"0","path":"ordinary"}),
        || crate::roots::tree::list_dir(f.higher(), "ordinary"),
    )
    .unwrap()
    .unwrap();
    let mut paths: Vec<_> = rows.iter().map(|row| row.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["ordinary/keep.md", "ordinary/keep.txt"]);
}
#[test]
fn ordinary_directory_with_same_label_as_body_root_is_not_format_authority() {
    let f = Restored::new("nested-name-control");
    let outside = f.higher().join("ordinary/restored-content-47");
    testutil::write(&outside, "page.md", "# Ordinary repeated label\n");
    let actual = dispatch(
        &f,
        "read_note",
        json!({"vault":outside,"path":"page.md"}),
        || f.run(|| crate::read_note(outside.to_str().unwrap().to_owned(), "page.md".to_owned())),
    )
    .unwrap()
    .unwrap();
    assert_eq!(actual, "# Ordinary repeated label\n");
}

#[cfg(unix)]
#[test]
fn symlink_alias_of_container_denies_broad_open() {
    let f = Restored::new("nested-alias-container");
    let alias = f.higher().join("container-alias");
    std::os::unix::fs::symlink(&f.container, &alias).unwrap();
    deny_dispatch(
        &f,
        "start_watcher",
        json!({"vault":alias}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[cfg(unix)]
#[test]
fn contained_symlink_to_inactive_body_denies_native_note_read() {
    let f = Restored::new("nested-alias-body");
    std::os::unix::fs::symlink(&f.bodies, f.higher().join("ordinary/body-alias")).unwrap();
    deny_dispatch(
        &f,
        "read_note",
        json!({"vault":f.higher(),"path":"ordinary/body-alias/page.md"}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[cfg(unix)]
#[test]
fn mounted_exact_alias_control_refuses_by_actual_body_ancestry() {
    let f = Restored::new("nested-mounted-alias-control");
    std::os::unix::fs::symlink(&f.bodies, f.higher().join("ordinary/body-alias")).unwrap();
    f.mount(f.higher());
    deny_dispatch(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"ordinary/body-alias/page.md"}),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[cfg(unix)]
#[test]
fn malformed_nested_marker_symlink_denies_broad_agent_scope() {
    let f = Restored::new("nested-marker-alias");
    fs::remove_file(f.bodies.join(MARKER)).unwrap();
    std::os::unix::fs::symlink(
        f.higher().join("missing-marker-target"),
        f.bodies.join(MARKER),
    )
    .unwrap();
    deny_dispatch(
        &f,
        "run_agent",
        json!({"vault":f.container}),
        AuthorityErrorKind::InvalidFormat,
    );
}

#[test]
fn clean_broad_sibling_scope_can_reach_dispatch_handler() {
    let f = Restored::new("nested-broad-sibling-control");
    let sibling = f.higher().join("ordinary");
    assert_eq!(
        dispatch(&f, "run_agent", json!({"vault":sibling}), || {
            "admitted ordinary scope"
        })
        .unwrap(),
        "admitted ordinary scope"
    );
}

#[path = "nested_format_boundary_extra_tests.rs"]
mod extra;
