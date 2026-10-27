//! Scoped boundary budgets and deterministic identity handoff tests.
use super::*;
use crate::vault::testutil;

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        Self {
            root: testutil::temp_vault(label).canonicalize().unwrap(),
        }
    }
    fn scope(&self, tree: bool) -> Vec<(PathBuf, bool)> {
        vec![(self.root.clone(), tree)]
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn room() -> Limits {
    Limits {
        entries: 1000,
        depth: 32,
        path_bytes: 1_048_576,
        marker_bytes: 8192,
        single_marker_bytes: 4096,
    }
}
fn expect_kind(result: Result<Inspection, AuthorityError>, kind: AuthorityErrorKind) {
    assert_eq!(result.unwrap_err().kind, kind);
}
#[test]
fn recursive_entry_budget_accepts_its_last_entry_and_refuses_the_next() {
    let f = Fixture::new("m99-boundary-entry-cap");
    testutil::write(&f.root, "a.txt", "A");
    testutil::write(&f.root, "b.txt", "B");
    let mut bounds = room();
    // Each canonical ancestor is inspected for markers and request identity;
    // the tree root and its two children are then visited once each.
    bounds.entries = 2 * f.root.ancestors().count() + 3;
    inspect_with_limits(None, &f.scope(true), bounds).unwrap();
    testutil::write(&f.root, "c.txt", "C");
    expect_kind(
        inspect_with_limits(None, &f.scope(true), bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn tree_depth_zero_accepts_root_only_and_refuses_its_first_child() {
    let f = Fixture::new("m99-boundary-depth-cap");
    let mut bounds = room();
    bounds.depth = 0;
    inspect_with_limits(None, &f.scope(true), bounds).unwrap();
    testutil::write(&f.root, "child.txt", "Child");
    expect_kind(
        inspect_with_limits(None, &f.scope(true), bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn aggregate_pathname_budget_refuses_before_collecting_the_excess_child() {
    let f = Fixture::new("m99-boundary-path-cap");
    let mut bounds = room();
    bounds.path_bytes = 2 * f
        .root
        .ancestors()
        .map(|p| p.as_os_str().len())
        .sum::<usize>()
        + f.root.as_os_str().len();
    inspect_with_limits(None, &f.scope(true), bounds).unwrap();
    testutil::write(&f.root, "excess.txt", "Excess");
    expect_kind(
        inspect_with_limits(None, &f.scope(true), bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn exact_file_scope_does_not_spend_the_unrelated_sibling_tree_budget() {
    let f = Fixture::new("m99-boundary-exact-cost");
    testutil::write(&f.root, "ordinary.txt", "Ordinary");
    for n in 0..100 {
        testutil::write(&f.root, &format!("wide/{n}.txt"), "Sibling");
    }
    let mut bounds = room();
    bounds.entries = 2 * f.root.ancestors().count() + 2;
    inspect_with_limits(None, &[(f.root.join("ordinary.txt"), false)], bounds).unwrap();
    expect_kind(
        inspect_with_limits(None, &f.scope(true), bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn finite_scopes_share_one_entry_budget() {
    let f = Fixture::new("m99-boundary-finite-cap");
    testutil::write(&f.root, "a.txt", "A");
    testutil::write(&f.root, "b.txt", "B");
    let one = vec![(f.root.join("a.txt"), false)];
    let mut bounds = room();
    bounds.entries = 2 * f.root.ancestors().count() + 1;
    inspect_with_limits(None, &one, bounds).unwrap();
    let two = vec![(f.root.join("a.txt"), false), (f.root.join("b.txt"), false)];
    expect_kind(
        inspect_with_limits(None, &two, bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn marker_single_part_budget_precedes_malformed_json_parsing() {
    let f = Fixture::new("m99-boundary-marker-part");
    testutil::write(
        &f.root,
        crate::workspace_migration::format_gate::FORMAT_MARKER,
        "123456789",
    );
    let mut bounds = room();
    bounds.single_marker_bytes = 8;
    expect_kind(
        inspect_with_limits(None, &f.scope(true), bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn marker_aggregate_budget_is_independent_of_the_single_part_budget() {
    let f = Fixture::new("m99-boundary-marker-total");
    testutil::write(
        &f.root,
        crate::workspace_migration::format_gate::FORMAT_MARKER,
        "123456789",
    );
    let mut bounds = room();
    bounds.marker_bytes = 8;
    expect_kind(
        inspect_with_limits(None, &f.scope(true), bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn absent_marker_does_not_let_a_nondirectory_control_parent_disappear() {
    let f = Fixture::new("m99-boundary-control-parent");
    testutil::write(&f.root, ".cerebro", "ordinary file cannot contain a marker");
    expect_kind(
        inspect_with_limits(None, &f.scope(false), room()),
        AuthorityErrorKind::InvalidFormat,
    );
}
#[test]
fn revalidation_refuses_a_marker_installed_after_inspection() {
    let f = Fixture::new("m99-boundary-late-marker");
    testutil::write(&f.root, "ordinary.txt", "Ordinary");
    let ticket =
        inspect_with_limits(None, &[(f.root.join("ordinary.txt"), false)], room()).unwrap();
    testutil::write(
        &f.root,
        crate::workspace_migration::format_gate::FORMAT_MARKER,
        "{new marker}",
    );
    assert_eq!(
        ticket.revalidate().unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[cfg(unix)]
#[test]
fn revalidation_refuses_replaced_directory_identity() {
    let f = Fixture::new("m99-boundary-replaced-directory");
    testutil::write(&f.root, "child/note.txt", "Original");
    let ticket = inspect_with_limits(None, &f.scope(true), room()).unwrap();
    fs::rename(f.root.join("child"), f.root.join("old-child")).unwrap();
    testutil::write(&f.root, "child/note.txt", "Replacement");
    assert_eq!(
        ticket.revalidate().unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[cfg(unix)]
#[test]
fn alias_cycle_terminates_under_the_same_scope_budget() {
    let f = Fixture::new("m99-boundary-alias-cycle");
    std::os::unix::fs::symlink(&f.root, f.root.join("loop")).unwrap();
    inspect_with_limits(None, &f.scope(true), room()).unwrap();
}
#[cfg(unix)]
#[test]
fn revalidation_refuses_alias_retarget_without_sleep() {
    let f = Fixture::new("m99-boundary-alias-retarget");
    testutil::write(&f.root, "a.txt", "A");
    testutil::write(&f.root, "b.txt", "B");
    let alias = f.root.join("alias.txt");
    std::os::unix::fs::symlink(f.root.join("a.txt"), &alias).unwrap();
    let ticket = inspect_with_limits(None, &[(alias.clone(), false)], room()).unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(f.root.join("b.txt"), &alias).unwrap();
    assert_eq!(
        ticket.revalidate().unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[cfg(unix)]
#[test]
fn hidden_alias_to_marked_subtree_cannot_be_excluded_from_broad_scope() {
    let f = Fixture::new("m99-boundary-hidden-alias");
    let other = Fixture::new("m99-boundary-hidden-marked");
    testutil::write(
        &other.root,
        crate::workspace_migration::format_gate::FORMAT_MARKER,
        r#"{"format":999}"#,
    );
    std::os::unix::fs::symlink(&other.root, f.root.join(".hidden-alias")).unwrap();
    expect_kind(
        inspect_with_limits(None, &f.scope(true), room()),
        AuthorityErrorKind::UnsupportedFormat,
    );
}

#[test]
fn held_inventory_refuses_a_late_child_marker_before_handing_out_content_descriptor() {
    let f = Fixture::new("m99-boundary-late-read");
    testutil::write(&f.root, "child/page.md", "# Protected after inspection\n");
    let inspection = inspect_with_limits(None, &f.scope(true), room()).unwrap();
    testutil::write(
        &f.root,
        "child/.cerebro/workspace-format.json",
        "{new marker}",
    );
    assert_eq!(
        inspection
            .open_file(&f.root.join("child/page.md"))
            .unwrap_err()
            .kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[cfg(unix)]
#[test]
fn held_inventory_refuses_a_replacement_inode_at_the_same_content_path() {
    let f = Fixture::new("m99-boundary-replaced-read");
    testutil::write(&f.root, "page.md", "# Original\n");
    let inspection = inspect_with_limits(None, &f.scope(true), room()).unwrap();
    fs::rename(f.root.join("page.md"), f.root.join("old-page.md")).unwrap();
    testutil::write(&f.root, "page.md", "# Replacement\n");
    assert_eq!(
        inspection
            .open_file(&f.root.join("page.md"))
            .unwrap_err()
            .kind,
        AuthorityErrorKind::SourceChanged
    );
}

#[test]
fn native_finite_rename_checks_destination_before_handler() {
    let f = Fixture::new("m99-boundary-finite-native-deny");
    let origin = Fixture::new("m99-boundary-finite-native-origin");
    testutil::write(&f.root, "ordinary.md", "# Ordinary\n");
    testutil::write(
        &f.root,
        "protected/.cerebro/workspace-format.json",
        r#"{"format":2,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#,
    );
    let request = crate::workspace_service::native_admission::request(
        "rename_note",
        &tauri::ipc::InvokeBody::Json(
            serde_json::json!({"vault":f.root,"from":"ordinary.md","to":"protected/new.md"}),
        ),
    )
    .unwrap();
    let reached = std::cell::Cell::new(false);
    let result = crate::workspace_service::native_admission::dispatch_checked(
        &AuthorityContext::new(origin.root.clone()),
        request,
        || reached.set(true),
    );
    assert!(!reached.get());
    assert_eq!(
        result.unwrap_err().kind,
        AuthorityErrorKind::InactiveWorkspace
    );
}
#[test]
fn native_finite_rename_preserves_unrelated_exact_source_and_destination() {
    let f = Fixture::new("m99-boundary-finite-native-control");
    let origin = Fixture::new("m99-boundary-finite-native-control-origin");
    testutil::write(&f.root, "ordinary.md", "# Ordinary\n");
    testutil::write(
        &f.root,
        "protected/.cerebro/workspace-format.json",
        r#"{"format":2,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#,
    );
    let request = crate::workspace_service::native_admission::request(
        "rename_note",
        &tauri::ipc::InvokeBody::Json(
            serde_json::json!({"vault":f.root,"from":"ordinary.md","to":"ordinary-next.md"}),
        ),
    )
    .unwrap();
    let result = crate::workspace_service::native_admission::dispatch_checked(
        &AuthorityContext::new(origin.root.clone()),
        request,
        || "finite scope admitted",
    );
    assert_eq!(result.unwrap(), "finite scope admitted");
}

#[cfg(unix)]
#[path = "boundary_alias_review_tests.rs"]
mod review_aliases;

#[cfg(unix)]
#[path = "boundary_legacy_regression_tests.rs"]
mod legacy_regressions;
