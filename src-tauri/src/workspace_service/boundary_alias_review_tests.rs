//! Regression fixtures from green-v1 review: preserve lexical namespace and actual target.
use super::*;
use crate::workspace_service::types::selected::CommandReadError;
use crate::workspace_service::{authority, native_admission as native};
use serde_json::json;
use std::cell::Cell;

const PREPARING: &str =
    r#"{"format":2,"authority":"sqlite_metadata","state":"preparing","manifest_hash":null}"#;
struct Aliases {
    root: Fixture,
    origin: Fixture,
}
impl Aliases {
    fn new(label: &str) -> Self {
        let root = Fixture::new(label);
        let origin = Fixture::new(&format!("{label}-origin"));
        testutil::write(&root.root, "ordinary/page.md", "# Ordinary Markdown\n");
        testutil::write(&root.root, "protected/page.md", "# Protected Markdown\n");
        testutil::write(
            &root.root,
            "protected/.cerebro/workspace-format.json",
            PREPARING,
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink("../ordinary", root.root.join("protected/link")).unwrap();
        Self { root, origin }
    }
    fn context(&self) -> AuthorityContext {
        AuthorityContext::new(self.origin.root.clone())
    }
    fn read(&self, vault: &Path, relative: &str) -> Result<String, CommandReadError> {
        authority::with_fixture_context(self.context(), || {
            crate::read_note(vault.to_str().unwrap().to_owned(), relative.to_owned())
        })
    }
    fn mount(&self, root: &Path) {
        crate::app_config::save(
            &self.origin.root,
            &crate::app_config::AppConfig {
                last_vault: Some(root.to_str().unwrap().to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
    }
    fn missing_known_marker(&self) {
        let registry = self.origin.root.join("workspaces/bindings.v1.json");
        testutil::write(
            &self.origin.root,
            "workspaces/bindings.v1.json",
            &json!({
                "version":1,"bindings":[{"workspaceId":"3ee5b6eb-9f80-4bac-9538-f2a0c5938a62",
                    "bodyRoot":self.root.root.join("protected")}]
            })
            .to_string(),
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&registry, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::remove_file(
            self.root
                .root
                .join("protected/.cerebro/workspace-format.json"),
        )
        .unwrap();
    }
}
fn authority_error(result: Result<String, CommandReadError>, kind: AuthorityErrorKind) {
    match result {
        Err(CommandReadError::Authority(error)) => assert_eq!(error.kind, kind),
        other => panic!("expected authority refusal before content, got {other:?}"),
    }
}
fn denied(f: &Aliases, command: &str, args: serde_json::Value, kind: AuthorityErrorKind) {
    let request = native::request(command, &tauri::ipc::InvokeBody::Json(args)).unwrap();
    let reached = Cell::new(false);
    let result = native::dispatch_checked(&f.context(), request, || reached.set(true));
    assert!(
        !reached.get(),
        "{command} erased the protected lexical route"
    );
    assert_eq!(result.unwrap_err().kind, kind);
}

#[cfg(unix)]
#[test]
fn actual_note_reader_refuses_alias_out_through_protected_namespace() {
    let f = Aliases::new("m99-lexical-actual-reader");
    authority_error(
        f.read(&f.root.root, "protected/link/page.md"),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn checked_note_reader_refuses_the_same_stable_alias_out_route() {
    let f = Aliases::new("m99-lexical-checked-reader");
    let result = authority::with_fixture_context(f.context(), || {
        crate::vault::write::read_note_checked(&f.root.root, "protected/link/page.md")
    });
    authority_error(result, AuthorityErrorKind::InactiveWorkspace);
}
#[cfg(unix)]
#[test]
fn native_vault_scope_retains_alias_out_relative_spelling() {
    let f = Aliases::new("m99-lexical-native-vault");
    denied(
        &f,
        "read_note",
        json!({"vault":f.root.root,"path":"protected/link/page.md"}),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn native_root_id_scope_retains_alias_out_relative_spelling() {
    let f = Aliases::new("m99-lexical-native-root");
    f.mount(&f.root.root);
    denied(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"protected/link/page.md"}),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn actual_note_reader_retains_the_original_vault_selector_route() {
    let f = Aliases::new("m99-lexical-selector-read");
    authority_error(
        f.read(&f.root.root.join("protected/link"), "page.md"),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn native_vault_selector_does_not_canonicalize_away_its_protected_parent() {
    let f = Aliases::new("m99-lexical-selector-native");
    denied(
        &f,
        "read_note",
        json!({"vault":f.root.root.join("protected/link"),"path":"page.md"}),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn native_root_id_selector_does_not_canonicalize_away_its_protected_parent() {
    let f = Aliases::new("m99-lexical-selector-root-id");
    f.mount(&f.root.root.join("protected/link"));
    denied(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"page.md"}),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn future_export_through_alias_out_refuses_before_creating_ordinary_target() {
    let f = Aliases::new("m99-lexical-future-export");
    let requested = f.root.root.join("protected/link/future.md");
    let result = native::publish_export(&f.context(), &requested, b"must not publish");
    match result {
        Err(CommandReadError::Authority(error)) => {
            assert_eq!(error.kind, AuthorityErrorKind::InactiveWorkspace)
        }
        other => panic!("expected typed pre-publication refusal, got {other:?}"),
    }
    assert!(!f.root.root.join("ordinary/future.md").exists());
}
#[cfg(unix)]
#[test]
fn known_missing_lexical_boundary_stays_specific_for_actual_reader() {
    let f = Aliases::new("m99-lexical-known-missing-reader");
    f.missing_known_marker();
    authority_error(
        f.read(&f.root.root, "protected/link/page.md"),
        AuthorityErrorKind::MissingMarker,
    );
}
#[cfg(unix)]
#[test]
fn known_missing_lexical_boundary_stays_specific_for_root_id() {
    let f = Aliases::new("m99-lexical-known-missing-root");
    f.missing_known_marker();
    f.mount(&f.root.root);
    denied(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"protected/link/page.md"}),
        AuthorityErrorKind::MissingMarker,
    );
}
#[cfg(unix)]
#[test]
fn alias_into_protected_target_still_refuses_actual_reader() {
    let f = Aliases::new("m99-lexical-alias-in-control");
    std::os::unix::fs::symlink("protected", f.root.root.join("link")).unwrap();
    authority_error(
        f.read(&f.root.root, "link/page.md"),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn direct_ordinary_sibling_stays_readable_through_native_vault_and_actual_reader() {
    let f = Aliases::new("m99-lexical-direct-sibling");
    let request = native::request(
        "read_note",
        &tauri::ipc::InvokeBody::Json(json!({
            "vault":f.root.root,"path":"ordinary/page.md"
        })),
    )
    .unwrap();
    let result = native::dispatch_checked(&f.context(), request, || {
        f.read(&f.root.root, "ordinary/page.md")
    });
    assert_eq!(result.unwrap().unwrap(), "# Ordinary Markdown\n");
}
#[cfg(unix)]
#[test]
fn direct_ordinary_sibling_stays_readable_through_root_id() {
    let f = Aliases::new("m99-lexical-direct-root-sibling");
    f.mount(&f.root.root);
    let request = native::request(
        "read_file_text",
        &tauri::ipc::InvokeBody::Json(json!({
            "rootId":"0","path":"ordinary/page.md"
        })),
    )
    .unwrap();
    let result = native::dispatch_checked(&f.context(), request, || {
        crate::roots::read::read_file_text(&f.root.root, "ordinary/page.md")
    })
    .unwrap();
    assert!(
        matches!(result, crate::roots::read::FileText::Text { ref content } if content == "# Ordinary Markdown\n")
    );
}
#[cfg(unix)]
#[test]
fn stable_contained_leaf_alias_is_readable_by_the_actual_note_command() {
    let root = Fixture::new("m99-stable-leaf-read");
    let origin = Fixture::new("m99-stable-leaf-read-origin");
    testutil::write(&root.root, "page.md", "# Stable leaf bytes\r\n");
    std::os::unix::fs::symlink("page.md", root.root.join("alias.md")).unwrap();
    let result =
        authority::with_fixture_context(AuthorityContext::new(origin.root.clone()), || {
            crate::read_note(
                root.root.to_str().unwrap().to_owned(),
                "alias.md".to_owned(),
            )
        });
    assert_eq!(result.unwrap(), "# Stable leaf bytes\r\n");
}
#[cfg(unix)]
#[test]
fn held_leaf_alias_retarget_still_refuses_descriptor_handoff() {
    let root = Fixture::new("m99-leaf-retarget-control");
    testutil::write(&root.root, "page.md", "# Original\n");
    testutil::write(&root.root, "other.md", "# Other\n");
    let alias = root.root.join("alias.md");
    std::os::unix::fs::symlink("page.md", &alias).unwrap();
    let inspection = inspect_with_limits(None, &[(alias.clone(), false)], room()).unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink("other.md", &alias).unwrap();
    assert_eq!(
        inspection.open_file(&alias).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[cfg(unix)]
#[test]
fn held_leaf_alias_target_inode_replacement_still_refuses_descriptor_handoff() {
    let root = Fixture::new("m99-leaf-inode-control");
    testutil::write(&root.root, "page.md", "# Original\n");
    let alias = root.root.join("alias.md");
    std::os::unix::fs::symlink("page.md", &alias).unwrap();
    let inspection = inspect_with_limits(None, &[(alias.clone(), false)], room()).unwrap();
    fs::rename(root.root.join("page.md"), root.root.join("old-page.md")).unwrap();
    testutil::write(&root.root, "page.md", "# Replacement\n");
    assert_eq!(
        inspection.open_file(&alias).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[cfg(unix)]
#[test]
fn leaf_alias_into_marked_target_still_refuses_actual_reader() {
    let f = Aliases::new("m99-leaf-marked-control");
    std::os::unix::fs::symlink("protected/page.md", f.root.root.join("alias.md")).unwrap();
    authority_error(
        f.read(&f.root.root, "alias.md"),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn held_alias_out_route_rechecks_a_later_lexical_marker_before_content_handoff() {
    let f = Aliases::new("m99-lexical-late-marker");
    fs::remove_file(f.root.root.join("protected/.cerebro/workspace-format.json")).unwrap();
    let requested = f.root.root.join("protected/link/page.md");
    let inspection = inspect_with_limits(None, &[(requested.clone(), false)], room()).unwrap();
    testutil::write(
        &f.root.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    assert_eq!(
        inspection.open_file(&requested).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}

#[cfg(unix)]
#[test]
fn stable_contained_directory_alias_keeps_actual_note_reader_usable() {
    let f = Aliases::new("m99-directory-alias-positive");
    std::os::unix::fs::symlink("ordinary", f.root.root.join("ordinary-alias")).unwrap();
    assert_eq!(
        f.read(&f.root.root.join("ordinary-alias"), "page.md")
            .unwrap(),
        "# Ordinary Markdown\n"
    );
}

#[cfg(unix)]
#[test]
fn an_aliased_intermediate_marked_directory_cannot_alias_out_to_ordinary_content() {
    let f = Aliases::new("m99-two-aliases-protected-route");
    std::os::unix::fs::symlink("protected", f.root.root.join("route")).unwrap();
    authority_error(
        f.read(&f.root.root, "route/link/page.md"),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[cfg(unix)]
#[test]
fn an_aliased_intermediate_known_missing_boundary_stays_specific() {
    let f = Aliases::new("m99-two-aliases-known-route");
    f.missing_known_marker();
    std::os::unix::fs::symlink("protected", f.root.root.join("route")).unwrap();
    denied(
        &f,
        "read_note",
        json!({"vault":f.root.root,"path":"route/link/page.md"}),
        AuthorityErrorKind::MissingMarker,
    );
}

// Round-two Finding 1: the intermediate alias lands below the boundary.
fn deep_route(label: &str, marked: bool) -> Aliases {
    let f = Aliases::new(label);
    fs::create_dir_all(f.root.root.join("protected/deep")).unwrap();
    std::os::unix::fs::symlink("../../ordinary", f.root.root.join("protected/deep/link")).unwrap();
    std::os::unix::fs::symlink("protected/deep", f.root.root.join("route")).unwrap();
    if !marked {
        fs::remove_file(f.root.root.join("protected/.cerebro/workspace-format.json")).unwrap();
    }
    f
}
fn admitted_read(f: &Aliases, relative: &str, root_id: bool) {
    let (command, args) = if root_id {
        f.mount(&f.root.root);
        ("read_file_text", json!({"rootId":"0","path":relative}))
    } else {
        ("read_note", json!({"vault":f.root.root,"path":relative}))
    };
    let request = native::request(command, &tauri::ipc::InvokeBody::Json(args)).unwrap();
    let reached = Cell::new(false);
    let result = native::dispatch_checked(&f.context(), request, || reached.set(true));
    result.unwrap();
    assert!(
        reached.get(),
        "ordinary exact route did not reach {command}"
    );
}
#[test]
fn deeper_alias_out_actual_reader_inspects_the_landing_ancestors() {
    let f = deep_route("m99-deep-route-reader", true);
    authority_error(
        f.read(&f.root.root, "route/link/page.md"),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[test]
fn deeper_alias_out_native_vault_inspects_the_landing_ancestors() {
    let f = deep_route("m99-deep-route-native", true);
    denied(
        &f,
        "read_note",
        json!({"vault":f.root.root,"path":"route/link/page.md"}),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[test]
fn deeper_alias_out_native_root_id_inspects_the_landing_ancestors() {
    let f = deep_route("m99-deep-route-root-id", true);
    f.mount(&f.root.root);
    denied(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"route/link/page.md"}),
        AuthorityErrorKind::InactiveWorkspace,
    );
}
#[test]
fn deeper_alias_out_direct_sibling_actual_reader_control() {
    let f = deep_route("m99-deep-sibling-reader", true);
    assert_eq!(
        f.read(&f.root.root, "ordinary/page.md").unwrap(),
        "# Ordinary Markdown\n"
    );
}
#[test]
fn deeper_alias_out_direct_sibling_native_vault_control() {
    let f = deep_route("m99-deep-sibling-native", true);
    admitted_read(&f, "ordinary/page.md", false);
}
#[test]
fn deeper_alias_out_direct_sibling_native_root_id_control() {
    let f = deep_route("m99-deep-sibling-root-id", true);
    admitted_read(&f, "ordinary/page.md", true);
}
#[test]
fn deeper_unmarked_route_actual_reader_control() {
    let f = deep_route("m99-deep-unmarked-reader", false);
    assert_eq!(
        f.read(&f.root.root, "route/link/page.md").unwrap(),
        "# Ordinary Markdown\n"
    );
}
#[test]
fn deeper_unmarked_route_native_vault_control() {
    let f = deep_route("m99-deep-unmarked-native", false);
    admitted_read(&f, "route/link/page.md", false);
}
#[test]
fn deeper_unmarked_route_native_root_id_control() {
    let f = deep_route("m99-deep-unmarked-root-id", false);
    admitted_read(&f, "route/link/page.md", true);
}
#[test]
fn held_aliased_intermediate_directory_rechecks_its_new_marker_before_handoff() {
    let f = Aliases::new("m99-held-routed-marker");
    fs::remove_file(f.root.root.join("protected/.cerebro/workspace-format.json")).unwrap();
    std::os::unix::fs::symlink("protected", f.root.root.join("route")).unwrap();
    let requested = f.root.root.join("route/link/page.md");
    let inspection = inspect_with_limits(None, &[(requested.clone(), false)], room()).unwrap();
    testutil::write(
        &f.root.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    assert_eq!(
        inspection.open_file(&requested).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[test]
fn held_deeper_landing_rechecks_its_ancestor_new_marker_before_handoff() {
    let f = deep_route("m99-held-deep-routed-marker", false);
    let requested = f.root.root.join("route/link/page.md");
    let inspection = inspect_with_limits(None, &[(requested.clone(), false)], room()).unwrap();
    testutil::write(
        &f.root.root,
        "protected/.cerebro/workspace-format.json",
        PREPARING,
    );
    assert_eq!(
        inspection.open_file(&requested).unwrap_err().kind,
        AuthorityErrorKind::SourceChanged
    );
}
#[test]
fn held_unmarked_deeper_route_still_hands_out_the_actual_content_descriptor() {
    use std::io::Read;
    let f = deep_route("m99-held-deep-unmarked-control", false);
    let requested = f.root.root.join("route/link/page.md");
    let inspection = inspect_with_limits(None, &[(requested.clone(), false)], room()).unwrap();
    let mut content = String::new();
    inspection
        .open_file(&requested)
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "# Ordinary Markdown\n");
}
#[test]
fn intermediate_routed_ancestry_uses_the_same_entry_budget() {
    let f = deep_route("m99-deep-route-budget-deny", false);
    let mut bounds = room();
    // Canonical final ancestry k+1, lexical positions k+3, routed ordinary
    // ancestry k+1, routed protected/deep ancestry k+2, canonical file 1.
    bounds.entries = 4 * f.root.root.ancestors().count() + 7;
    expect_kind(
        inspect_with_limits(
            None,
            &[(f.root.root.join("route/link/page.md"), false)],
            bounds,
        ),
        AuthorityErrorKind::SourceLimit,
    );
}
#[test]
fn intermediate_routed_ancestry_exact_budget_ignores_unrelated_sibling_trees() {
    let f = deep_route("m99-deep-route-budget-control", false);
    for n in 0..100 {
        testutil::write(&f.root.root, &format!("wide/{n}.md"), "# Sibling\n");
    }
    let mut bounds = room();
    bounds.entries = 4 * f.root.root.ancestors().count() + 8;
    inspect_with_limits(
        None,
        &[(f.root.root.join("route/link/page.md"), false)],
        bounds,
    )
    .unwrap();
}
