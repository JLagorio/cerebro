//! Ordinary legacy regressions and retained P1 controls for bounded route inspection.
use super::*;
use crate::workspace_service::authority;

const PREPARING: &str =
    r#"{"format":1,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#;
fn ordinary_parent_route(label: &str) -> (Fixture, PathBuf) {
    let f = Fixture::new(label);
    fs::create_dir_all(f.root.join("anchor")).unwrap();
    testutil::write(&f.root, "ordinary/page.md", "# Ordinary\n");
    let requested = f.root.join("anchor/../ordinary");
    (f, requested)
}
fn protected_parent_route(label: &str) -> (Fixture, PathBuf) {
    let f = Fixture::new(label);
    fs::create_dir_all(f.root.join("protected/deep")).unwrap();
    testutil::write(&f.root, "ordinary/page.md", "# Ordinary\n");
    testutil::write(
        &f.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    let requested = f.root.join("protected/deep/../../ordinary");
    (f, requested)
}

#[test]
fn ordinary_absolute_parent_root_remains_readable_by_the_actual_scan() {
    let (_f, requested) = ordinary_parent_route("m99-parent-root-scan");
    let origin = Fixture::new("m99-parent-root-scan-origin");
    let entries =
        authority::with_fixture_context(AuthorityContext::new(origin.root.clone()), || {
            crate::vault::scan::scan_vault(&requested)
        })
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "page.md");
}
#[test]
fn ordinary_absolute_parent_root_remains_readable_by_the_actual_corpus() {
    let (_f, requested) = ordinary_parent_route("m99-parent-root-corpus");
    let origin = Fixture::new("m99-parent-root-corpus-origin");
    let corpus =
        authority::with_fixture_context(AuthorityContext::new(origin.root.clone()), || {
            crate::vault::corpus::CorpusCache::new(1).snapshot(&requested)
        })
        .unwrap();
    assert_eq!(corpus.entries.len(), 1);
    assert_eq!(corpus.entries[0].path, "page.md");
    assert_eq!(corpus.texts[0].body, "# Ordinary\n");
}
#[test]
fn parent_root_does_not_fold_away_a_protected_namespace() {
    let (f, requested) = protected_parent_route("m99-parent-root-protected");
    expect_kind(
        inspect_with_limits(None, &[(requested, true)], room()),
        AuthorityErrorKind::InactiveWorkspace,
    );
    assert_eq!(
        fs::read(f.root.join("ordinary/page.md")).unwrap(),
        b"# Ordinary\n"
    );
}
#[test]
fn parent_root_does_not_fold_away_a_symlink_routed_protected_namespace() {
    let (f, _) = protected_parent_route("m99-parent-root-alias-protected");
    std::os::unix::fs::symlink("protected/deep", f.root.join("route")).unwrap();
    expect_kind(
        inspect_with_limits(None, &[(f.root.join("route/../../ordinary"), true)], room()),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[test]
fn held_parent_root_rechecks_a_marker_on_its_intermediate_namespace() {
    let (f, requested) = protected_parent_route("m99-parent-root-late-marker");
    fs::remove_file(f.root.join("protected/.cerebro/workspace-format.json")).unwrap();
    let file = requested.join("page.md");
    let inspection = inspect_with_limits(None, &[(file.clone(), false)], room()).unwrap();
    testutil::write(
        &f.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    assert_eq!(
        inspection.open_file(&file).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[test]
fn blocked_future_prefix_keeps_its_regular_file_identity_witness() {
    let f = Fixture::new("m99-blocked-prefix-replacement");
    testutil::write(&f.root, "blocker", "# Blocker\n");
    let inspection =
        inspect_with_limits(None, &[(f.root.join("blocker/a.md"), false)], room()).unwrap();
    fs::rename(f.root.join("blocker"), f.root.join("old-blocker")).unwrap();
    testutil::write(&f.root, "blocker/a.md", "# New target\n");
    assert_eq!(
        inspection.revalidate().unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[test]
fn blocked_future_prefix_is_not_a_content_descriptor_grant() {
    let f = Fixture::new("m99-blocked-prefix-no-content");
    testutil::write(&f.root, "blocker", "# Blocker\n");
    let file = f.root.join("blocker/a.md");
    let inspection = inspect_with_limits(None, &[(file.clone(), false)], room()).unwrap();
    assert_eq!(
        inspection.open_file(&file).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
    assert_eq!(fs::read(f.root.join("blocker")).unwrap(), b"# Blocker\n");
}
#[test]
fn blocked_future_prefix_still_denies_a_reachable_protected_ancestor() {
    let f = Fixture::new("m99-blocked-prefix-protected");
    testutil::write(&f.root, "protected/blocker", "# Blocker\n");
    testutil::write(
        &f.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    expect_kind(
        inspect_with_limits(
            None,
            &[(f.root.join("protected/blocker/a.md"), false)],
            room(),
        ),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[test]
fn blocked_future_prefix_uses_the_same_exact_entry_budget() {
    let f = Fixture::new("m99-blocked-prefix-budget-control");
    testutil::write(&f.root, "blocker", "# Blocker\n");
    let mut bounds = room();
    // k real root ancestors plus the regular-file barrier in each of
    // canonical ancestry and the requested route: 2k+2 total entries.
    bounds.entries = 2 * f.root.ancestors().count() + 2;
    inspect_with_limits(None, &[(f.root.join("blocker/a.md"), false)], bounds).unwrap();
}
#[test]
fn blocked_future_prefix_refuses_one_entry_beyond_its_shared_budget() {
    let f = Fixture::new("m99-blocked-prefix-budget-deny");
    testutil::write(&f.root, "blocker", "# Blocker\n");
    let mut bounds = room();
    bounds.entries = 2 * f.root.ancestors().count() + 1;
    expect_kind(
        inspect_with_limits(None, &[(f.root.join("blocker/a.md"), false)], bounds),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn ordinary_note_prevalidation_does_not_admit_a_marked_source_read() {
    let f = Fixture::new("m99-source-order-marked-control");
    let origin = Fixture::new("m99-source-order-marked-origin");
    testutil::write(&f.root, "protected/page.md", "# Protected\n");
    testutil::write(
        &f.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    let error = authority::with_fixture_context(AuthorityContext::new(origin.root.clone()), || {
        crate::read_note_source(
            f.root.to_str().unwrap().to_owned(),
            "protected/page.md".to_owned(),
        )
    })
    .unwrap_err();
    assert_eq!(error, "Selected workspace preparation is incomplete.");
    assert_eq!(
        fs::read(f.root.join("protected/page.md")).unwrap(),
        b"# Protected\n"
    );
}
