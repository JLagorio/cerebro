use super::{authority::AuthorityContext, native_admission as native, types::selected::*};
use crate::vault::testutil;
use serde_json::json;
use std::{cell::Cell, fs, path::PathBuf};

const WORKSPACE: &str = "3ee5b6eb-9f80-4bac-9538-f2a0c5938a62";
struct Fixture {
    origin: PathBuf,
    root: PathBuf,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let origin = testutil::temp_vault(&format!("m99-native-origin-{label}"));
        let root = testutil::temp_vault(&format!("m99-native-root-{label}"));
        testutil::write(&origin,"workspaces/bindings.v1.json",&json!({"version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":root.to_str().unwrap()}]}).to_string());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for p in [&origin, &origin.join("workspaces")] {
                fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
            }
            fs::set_permissions(
                origin.join("workspaces/bindings.v1.json"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        testutil::write(&root,".cerebro/workspace-format.json",&json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":WORKSPACE}).to_string());
        Self { origin, root }
    }
    fn context(&self) -> AuthorityContext {
        AuthorityContext::new(self.origin.clone())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.origin);
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn dispatch<T>(
    f: &Fixture,
    name: &str,
    args: serde_json::Value,
    handler: impl FnOnce() -> T,
) -> Result<T, AuthorityError> {
    let request = native::request(name, &tauri::ipc::InvokeBody::Json(args))?;
    native::dispatch_checked(&f.context(), request, handler)
}
#[test]
fn selected_denial_precedes_the_real_dispatch_closure_for_unsupported_read_write_and_report_doors()
{
    let f = Fixture::new("deny");
    for command in [
        "update_frontmatter",
        "create_folder",
        "apply_batch",
        "init_git_repo",
        "ledger_status",
        "list_interactions",
        "read_note_source",
        "fleet_run_configuration",
    ] {
        let effect = Cell::new(false);
        let result = dispatch(
            &f,
            command,
            json!({"vault":f.root,"path":"page.md","authority":{"kind":"legacy"}}),
            || {
                effect.set(true);
                "synthetic empty report must not run"
            },
        );
        assert!(!effect.get(), "{command} reached its handler before denial");
        let error = result.unwrap_err();
        assert_eq!(error.kind, AuthorityErrorKind::UnsupportedOperation);
        assert!(!error.retryable);
    }
}
#[test]
fn known_selected_binding_with_removed_marker_stays_closed_but_globals_are_usable() {
    let f = Fixture::new("removed");
    fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
    let effect = Cell::new(false);
    let error = dispatch(&f, "update_frontmatter", json!({"vault":f.root}), || {
        effect.set(true)
    })
    .unwrap_err();
    assert!(!effect.get());
    assert_eq!(error.kind, AuthorityErrorKind::MissingMarker);
    fs::write(f.origin.join("workspaces/bindings.v1.json"), "{corrupt").unwrap();
    for command in [
        "stop_agent",
        "stop_all_agents",
        "revoke_client_token",
        "finish_quit",
        "cancel_quit",
        "client_access_status",
        "fleet_runs",
        "write_clipboard",
    ] {
        assert_eq!(
            dispatch(&f, command, json!({}), || "global result").unwrap(),
            "global result",
            "{command}"
        );
    }
}
#[test]
fn explicitly_legacy_roots_keep_existing_dispatch_results() {
    let f = Fixture::new("legacy");
    let legacy = testutil::temp_vault("m99-native-legacy");
    assert_eq!(
        dispatch(
            &f,
            "update_frontmatter",
            json!({"vault":legacy,"path":"page.md"}),
            || { "existing hash" }
        )
        .unwrap(),
        "existing hash"
    );
    assert_eq!(
        dispatch(&f, "claude_user_settings", json!({"vault":null}), || {
            "existing global settings"
        })
        .unwrap(),
        "existing global settings"
    );
    fs::remove_dir_all(legacy).unwrap();
}
#[test]
fn native_destination_guard_blocks_missing_marker_and_nonexistent_descendants_before_publication() {
    let f = Fixture::new("dest");
    fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
    let target = f.root.join("new/subtree/export.csv");
    assert!(native::guard_external_write(&f.context(), &target).is_err());
    assert!(!target.exists());
    assert!(native::guard_external_write(&f.context(), &f.root).is_err());
    let outside = testutil::temp_vault("m99-native-outside");
    native::guard_external_write(&f.context(), &outside.join("explicit.csv")).unwrap();
    assert!(dispatch(
        &f,
        "git_clone",
        json!({"destination":target,"url":"https://example.invalid/demo"}),
        || "must not spawn"
    )
    .is_err());
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn finite_command_table_matches_actual_registered_native_handlers_exactly() {
    use std::collections::BTreeSet;
    let source = include_str!("../lib.rs");
    let handler = source
        .split_once("tauri::generate_handler![")
        .unwrap()
        .1
        .split_once(']')
        .unwrap()
        .0;
    let actual: BTreeSet<String> = handler
        .lines()
        .map(|line| line.split("//").next().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.rsplit("::").next().unwrap().to_owned())
        .collect();
    let table: serde_json::Value =
        serde_json::from_str(include_str!("../../../shared/workspace/authority.v2.json")).unwrap();
    let rows = table["nativeCommands"].as_array().unwrap();
    let policy: BTreeSet<String> = rows
        .iter()
        .map(|r| r["command"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        policy.len(),
        rows.len(),
        "command dispositions must be unique"
    );
    assert_eq!(
        actual, policy,
        "registered handler changes require a reviewed finite disposition"
    );
}
#[test]
fn active_root_publication_is_generation_checked_and_not_last_vault_config() {
    let f = Fixture::new("generation");
    let context = f.context();
    assert!(context.active_root().unwrap().is_none());
    let old = context.begin_open().unwrap();
    let current = context.begin_open().unwrap();
    assert!(context.publish_open(old, &f.root).is_err());
    assert!(context.active_root().unwrap().is_none());
    context.publish_open(current, &f.root).unwrap();
    assert_eq!(
        context.active_root().unwrap(),
        Some(f.root.canonicalize().unwrap())
    );
    let effect = Cell::new(false);
    let request = native::request(
        "set_client_access",
        &tauri::ipc::InvokeBody::Json(json!({"enabled":true})),
    )
    .unwrap();
    assert!(native::dispatch_checked(&context, request, || effect.set(true)).is_err());
    assert!(!effect.get());
    let request = native::request(
        "set_client_access",
        &tauri::ipc::InvokeBody::Json(json!({"enabled":false})),
    )
    .unwrap();
    native::dispatch_checked(&context, request, || effect.set(true)).unwrap();
    assert!(effect.get());
    let _failed = context.begin_open().unwrap();
    assert!(context.active_root().unwrap().is_none());
}
#[test]
fn requested_mounted_root_and_symlink_aliases_cannot_bypass_selected_containment() {
    let f = Fixture::new("root-id");
    let context = f.context();
    crate::app_config::save(
        &f.origin,
        &crate::app_config::AppConfig {
            last_vault: Some(f.root.to_str().unwrap().into()),
            ..Default::default()
        },
    )
    .unwrap();
    let request = native::request(
        "read_file_text",
        &tauri::ipc::InvokeBody::Json(json!({"rootId":"0","path":"page.md"})),
    )
    .unwrap();
    assert!(native::dispatch_checked(&context, request, || "must not read").is_err());
    #[cfg(unix)]
    {
        let outside = testutil::temp_vault("m99-native-alias");
        std::os::unix::fs::symlink(&f.root, outside.join("alias")).unwrap();
        assert!(
            native::guard_external_write(&context, &outside.join("alias/new/export.csv")).is_err()
        );
        fs::remove_dir_all(outside).unwrap();
    }
}

#[test]
fn exact_post_dialog_export_and_demo_seams_retain_typed_selected_refusal_before_effects() {
    let f = Fixture::new("typed-destination");
    let path = f.root.join("export.csv");
    let error = native::publish_export(&f.context(), &path, b"must not publish").unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["kind"],
        "unsupported_operation"
    );
    assert!(!path.exists());
    let staging = f.root.join("Cerebro Demo Vault (incomplete)");
    testutil::write(&staging, "keep.md", "# Keep\n");
    let error = native::guard_demo_destinations(&f.context(), &[f.root.clone(), staging.clone()])
        .unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["kind"],
        "unsupported_operation"
    );
    assert!(staging.join("keep.md").exists());
}
#[cfg(unix)]
#[test]
fn dangling_export_symlink_cannot_hide_a_selected_destination() {
    let f = Fixture::new("dangling-target");
    let outside = testutil::temp_vault("m99-native-dangling-outside");
    let link = outside.join("export.csv");
    std::os::unix::fs::symlink(f.root.join("new.csv"), &link).unwrap();
    assert!(native::guard_external_write(&f.context(), &link).is_err());
    assert!(!f.root.join("new.csv").exists());
    fs::remove_dir_all(outside).unwrap();
}
#[test]
fn overlapping_registered_selected_roots_are_invalid_instead_of_ambiguous_authority() {
    let f = Fixture::new("overlap");
    let child = f.root.join("nested");
    fs::create_dir(&child).unwrap();
    let raw = json!({"version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":f.root},{"workspaceId":"5e42a681-f796-4cd8-83c4-ab8285fcce35","bodyRoot":child}]});
    fs::write(
        f.origin.join("workspaces/bindings.v1.json"),
        raw.to_string(),
    )
    .unwrap();
    let request = native::request(
        "scan_vault",
        &tauri::ipc::InvokeBody::Json(json!({"vault":f.root})),
    )
    .unwrap();
    assert_eq!(
        native::dispatch_checked(&f.context(), request, || ())
            .unwrap_err()
            .kind,
        AuthorityErrorKind::InvalidBinding
    );
}
#[test]
fn actual_selected_open_teardown_closes_prior_app_session_and_ambient_target() {
    let _sink = crate::runtime::sink::test_lock();
    let _shadow = crate::ledger::shadow::testing::lock();
    let origin = testutil::temp_vault("m99-selected-session-close");
    let root = testutil::temp_vault("m99-selected-prior-legacy");
    crate::runtime::sink::arm(&origin).unwrap();
    let vault_id = crate::runtime::sink::with_sink(|conn| {
        crate::runtime::scope::register(conn, &root).unwrap()
    })
    .unwrap();
    let scope = crate::runtime::VaultScope {
        vault_id,
        store_uuid: Some("fixture-legacy-store".into()),
    };
    crate::runtime::sessions::track(&scope);
    let ambient = crate::ingest::ambient::AmbientState::default();
    ambient.retarget(&root);
    assert!(ambient.watching().is_some());
    let watcher = crate::vault::watcher::WatcherState::default();
    let agents = crate::agent::AgentState::default();
    crate::suspend_legacy_for_selected(&watcher, &ambient, &agents).unwrap();
    assert!(ambient.watching().is_none());
    let precision: String = crate::runtime::sink::with_sink(|conn| {
        conn.query_row(
            "SELECT close_precision FROM app_sessions WHERE vault_id=?1",
            [&scope.vault_id],
            |r| r.get(0),
        )
        .unwrap()
    })
    .unwrap();
    crate::runtime::sessions::close_current();
    crate::runtime::sink::disarm();
    fs::remove_dir_all(origin).unwrap();
    fs::remove_dir_all(root).unwrap();
    assert_eq!(precision, "clean_exact");
}
#[test]
fn actual_legacy_open_publication_never_binds_a_superseded_generation() {
    let f = Fixture::new("late-listener");
    let context = f.context();
    let agents = crate::agent::AgentState::default();
    let stale = context.begin_open().unwrap();
    agents.begin_open(stale).unwrap();
    let current = context.begin_open().unwrap();
    agents.begin_open(current).unwrap();
    let bound = Cell::new(false);
    assert!(
        crate::finish_legacy_open(&context, stale, &f.root, &agents, || bound.set(true)).is_err()
    );
    assert!(
        agents.admit().is_err(),
        "a superseded open left admission enabled"
    );
    assert!(
        !bound.get(),
        "superseded watcher published a listener binding"
    );
}

#[test]
fn actual_legacy_binding_callback_finishes_before_a_new_open_generation_can_begin() {
    let f = Fixture::new("publication-serialization");
    let context = f.context();
    let legacy = testutil::temp_vault("m99-open-publication-legacy");
    let generation = context.begin_open().unwrap();
    let agents = crate::agent::AgentState::default();
    agents.begin_open(generation).unwrap();
    let (attempt_tx, attempt_rx) = std::sync::mpsc::channel();
    let (begun_tx, begun_rx) = std::sync::mpsc::channel();
    let mut worker = None;
    let began_during_callback = Cell::new(false);
    crate::finish_legacy_open(&context, generation, &legacy, &agents, || {
        let next = context.clone();
        let next_agents = agents.clone();
        worker = Some(std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            let generation = next.begin_open().unwrap();
            next_agents.begin_open(generation).unwrap();
            begun_tx.send(generation).unwrap();
        }));
        attempt_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        began_during_callback.set(
            begun_rx
                .recv_timeout(std::time::Duration::from_millis(250))
                .is_ok(),
        );
    })
    .unwrap();
    worker.unwrap().join().unwrap();
    fs::remove_dir_all(legacy).unwrap();
    assert!(
        !began_during_callback.get(),
        "a superseding opening began while the previous binding callback was still executing"
    );
    assert!(context.active_root().unwrap().is_none());
    assert!(
        agents.admit().is_err(),
        "the new opening must disable run admission"
    );
}

#[test]
fn mixed_mounted_root_preserves_real_outside_file_read_and_sibling_subtree() {
    let mut f = Fixture::new("mixed-mount");
    let parent = testutil::temp_vault("m99-mixed-mounted-parent");
    let selected = parent.join("selected");
    fs::rename(&f.root, &selected).unwrap();
    f.root = selected;
    fs::write(
        f.origin.join("workspaces/bindings.v1.json"),
        json!({"version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":f.root}]}).to_string(),
    )
    .unwrap();
    crate::app_config::save(
        &f.origin,
        &crate::app_config::AppConfig {
            last_vault: Some(parent.to_str().unwrap().into()),
            ..Default::default()
        },
    )
    .unwrap();
    testutil::write(&parent, "legacy.txt", "Legacy sibling remains readable\r\n");
    testutil::write(&parent, "outside/item.txt", "Outside subtree\n");
    let result = dispatch(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"legacy.txt"}),
        || crate::roots::read::read_file_text(&parent, "legacy.txt"),
    );
    let actual = result.unwrap();
    assert!(
        matches!(actual,crate::roots::read::FileText::Text{ref content} if content=="Legacy sibling remains readable\r\n")
    );
    let entries = dispatch(
        &f,
        "list_dir",
        json!({"rootId":"0","path":"outside"}),
        || crate::roots::tree::list_dir(&parent, "outside"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "outside/item.txt");
    fs::remove_dir_all(parent).unwrap();
}
#[test]
fn mixed_mounted_selected_child_alias_and_tree_scope_stay_closed_after_marker_removal() {
    let mut f = Fixture::new("mixed-closed");
    let parent = testutil::temp_vault("m99-mixed-closed-parent");
    let selected = parent.join("selected");
    fs::rename(&f.root, &selected).unwrap();
    f.root = selected;
    fs::write(
        f.origin.join("workspaces/bindings.v1.json"),
        json!({"version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":f.root}]}).to_string(),
    )
    .unwrap();
    crate::app_config::save(
        &f.origin,
        &crate::app_config::AppConfig {
            last_vault: Some(parent.to_str().unwrap().into()),
            ..Default::default()
        },
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&f.root, parent.join("alias")).unwrap();
    let mut paths = vec!["selected/page.md"];
    #[cfg(unix)]
    paths.push("alias/page.md");
    for path in paths {
        let effect = Cell::new(false);
        assert!(dispatch(
            &f,
            "read_file_text",
            json!({"rootId":"0","path":path}),
            || effect.set(true)
        )
        .is_err());
        assert!(!effect.get());
    }
    for command in [
        "root_git_workspace_info",
        "root_git_remote_status",
        "root_git_modified_files",
        "root_git_pulse",
        "root_git_fetch",
        "root_git_pull_ff",
        "root_git_file_url",
    ] {
        assert!(dispatch(
            &f,
            command,
            json!({"rootId":"0","path":"outside.txt"}),
            || "must not spawn"
        )
        .is_err());
    }
    assert!(
        dispatch(&f, "list_dir", json!({"rootId":"0","path":""}), || {
            "must not list"
        })
        .is_err()
    );
    fs::remove_file(f.root.join(".cerebro/workspace-format.json")).unwrap();
    assert!(dispatch(
        &f,
        "read_file_text",
        json!({"rootId":"0","path":"selected/page.md"}),
        || "must not read"
    )
    .is_err());
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn actual_export_publication_protects_derived_metadata_and_registry_even_when_registry_disappears()
{
    for name in [
        "workspaces/bindings.v1.json",
        "workspaces/3ee5b6eb-9f80-4bac-9538-f2a0c5938a62/workspace.db",
    ] {
        let f = Fixture::new("metadata-destination");
        let context = f.context();
        let destination = f.origin.join(name);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        if name.ends_with("workspace.db") {
            fs::write(&destination, b"canonical bytes must stay").unwrap();
        }
        let before = fs::read(&destination).unwrap();
        let result =
            native::publish_export(&context, &destination, b"must not overwrite authority");
        assert!(
            result.is_err(),
            "export admitted derived canonical destination {name}"
        );
        assert_eq!(
            serde_json::to_value(result.unwrap_err()).unwrap()["kind"],
            "unsupported_operation"
        );
        assert_eq!(fs::read(&destination).unwrap(), before);
        fs::remove_file(f.origin.join("workspaces/bindings.v1.json")).unwrap();
        let result = native::publish_export(
            &context,
            &destination,
            b"must not recreate missing authority",
        );
        assert!(result.is_err());
        assert_eq!(
            serde_json::to_value(result.unwrap_err()).unwrap()["kind"],
            "unsupported_operation"
        );
        let outside = f.origin.join("explicit-outside-workspaces.csv");
        native::publish_export(&context, &outside, b"outside bytes remain allowed").unwrap();
        assert_eq!(fs::read(outside).unwrap(), b"outside bytes remain allowed");
    }
}

#[test]
fn credential_bridge_global_selectors_reach_authenticated_door_without_vault_authority() {
    let f = Fixture::new("credential-bridge-global");
    let context = f.context();
    let opening = context.begin_open().unwrap();
    context.publish_open(opening, &f.root).unwrap();
    // Unknown commands remain refused on an active selected workspace.
    let unknown = Cell::new(false);
    let request = native::request(
        "m96_unknown_credential_probe",
        &tauri::ipc::InvokeBody::Json(json!({})),
    )
    .unwrap();
    assert!(native::dispatch_checked(&context, request, || unknown.set(true)).is_err());
    assert!(!unknown.get());
    // These global account doors still perform native owner/window admission;
    // renderer vault/person extras grant nothing at this outer workspace layer.
    fs::write(f.origin.join("workspaces/bindings.v1.json"), "{unavailable").unwrap();
    for command in [
        "begin_gh_import",
        "credential_acquisition",
        "cancel_credential_acquisition",
    ] {
        let reached = Cell::new(false);
        let request = native::request(
            command,
            &tauri::ipc::InvokeBody::Json(json!({
                "vault": f.root, "person": "human:forged", "attemptId": "selector-only",
            })),
        )
        .unwrap();
        assert_eq!(
            native::dispatch_checked(&context, request, || {
                reached.set(true);
                "authenticated door still decides"
            })
            .unwrap(),
            "authenticated door still decides"
        );
        assert!(
            reached.get(),
            "{command} must reach its own native admission"
        );
    }
}

#[test]
fn recovery_history_uses_only_current_legacy_root_and_cannot_be_disabled_by_payload() {
    let f = Fixture::new("history-current-root");
    let context = f.context();
    context
        .publish_open(context.begin_open().unwrap(), &f.root)
        .unwrap();
    let legacy = testutil::temp_vault("m95-spoofed-legacy-root");
    for args in [
        json!({"runId":"root"}),
        json!({"runId":"root","vault":legacy,"enabled":false}),
    ] {
        let request =
            native::request("chat_recovery_inspect", &tauri::ipc::InvokeBody::Json(args)).unwrap();
        let called = Cell::new(false);
        assert!(native::dispatch_checked(&context, request, || called.set(true)).is_err());
        assert!(!called.get());
    }
    assert!(context.capture_current_legacy_opening().is_err());
    context
        .publish_open(context.begin_open().unwrap(), &legacy)
        .unwrap();
    let (observed, ticket) = context.capture_current_legacy_opening().unwrap();
    assert_eq!(observed, legacy.canonicalize().unwrap());
    let request = native::request(
        "chat_recovery_inspect",
        &tauri::ipc::InvokeBody::Json(json!({"runId":"root","vault":f.root})),
    )
    .unwrap();
    assert_eq!(
        native::dispatch_checked(&context, request, || 17).unwrap(),
        17
    );
    context
        .publish_open(context.begin_open().unwrap(), &f.root)
        .unwrap();
    context
        .publish_open(context.begin_open().unwrap(), &legacy)
        .unwrap();
    assert!(context
        .with_legacy_opening(&ticket, || panic!("old opening revived"))
        .is_err());
    fs::remove_dir_all(legacy).unwrap();
}

#[test]
fn actual_workflow_and_managed_access_selectors_preserve_the_outer_selected_boundary() {
    let source = include_str!("../lib.rs");
    let handler = source
        .split_once("tauri::generate_handler![")
        .unwrap()
        .1
        .split_once(']')
        .unwrap()
        .0;
    let text = handler
        .lines()
        .map(|line| line.split("//").next().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let names: Vec<_> = text
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.rsplit("::").next().unwrap())
        .filter(|name| {
            name.starts_with("workflow_")
                || matches!(
                    *name,
                    "read_managed_action_access" | "set_managed_action_access"
                )
        })
        .collect();
    assert_eq!(names.len(), 28);
    let f = Fixture::new("workflow-access-selectors");
    let context = f.context();
    let legacy = testutil::temp_vault("workflow-access-legacy");
    for name in names {
        context.begin_open().unwrap();
        let request = native::request(name, &tauri::ipc::InvokeBody::Json(json!({}))).unwrap();
        let entered = Cell::new(false);
        // This outer gate protects selected storage; the authenticated inner
        // handler owns the original-opening requirement, including no opening.
        native::dispatch_checked(&context, request, || entered.set(true)).unwrap();
        assert!(
            entered.get(),
            "{name} must delegate missing-opening authentication to its existing native handler"
        );
        entered.set(false);
        let opening = context.begin_open().unwrap();
        context.publish_open(opening, &f.root).unwrap();
        let request = native::request(
            name,
            &tauri::ipc::InvokeBody::Json(json!({"vault":legacy,"authority":"legacy"})),
        )
        .unwrap();
        let error = native::dispatch_checked(&context, request, || entered.set(true)).unwrap_err();
        assert_eq!(
            error.kind,
            AuthorityErrorKind::UnsupportedOperation,
            "{name}"
        );
        assert!(
            !entered.get(),
            "{name} must refuse selected storage before its handler"
        );
        let opening = context.begin_open().unwrap();
        context.publish_open(opening, &legacy).unwrap();
        let request = native::request(name, &tauri::ipc::InvokeBody::Json(json!({}))).unwrap();
        native::dispatch_checked(&context, request, || entered.set(true)).unwrap();
        assert!(
            entered.get(),
            "{name} must reach its existing authenticated handler on a current legacy root"
        );
    }
    fs::remove_dir_all(legacy).unwrap();
}
