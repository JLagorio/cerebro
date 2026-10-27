//! Explicit macOS smoke executable. Not compiled by default or in release builds.
//! Real Wry window, injected command, existing open/run/read paths; local CLI fixture.
use crate::actions::read_types::{ActionId, ActionReadErrorCode, DefinitionDigest};
use crate::credential_commands;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};

include!("../../conformance/outcomes/native-inputs.generated.rs");

pub(crate) struct SmokePaths {
    root: PathBuf,
    config: PathBuf,
    cache: PathBuf,
    vault_a: PathBuf,
    vault_b: PathBuf,
    settings_metadata: bool,
    workflow_pinned: bool,
    delegation_origin: bool,
    child_grant_freeze: bool,
    child_claim: bool,
    child_claim_deadline: bool,
    restart: restart_profile::Role,
    quit: Option<quit_profile::Case>,
    #[cfg(feature = "native-action-smoke")]
    managed_action: Option<managed_action_profile::Scenario>,
    #[cfg(feature = "native-credential-smoke")]
    credential_metadata: bool,
    #[cfg(feature = "native-credential-smoke")]
    credential_public: bool,
    #[cfg(feature = "native-credential-smoke")]
    credential_import_fixture: bool,
    #[cfg(feature = "native-keychain-smoke")]
    keychain: bool,
    metadata_write_observed: AtomicBool,
    started: AtomicBool,
    finished: AtomicBool,
}
// Under the explicit feature, absence of this managed resource refuses instead
// of falling back to the person's installed or checkout-scoped application data.
pub(crate) fn isolated_app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.try_state::<SmokePaths>()
        .map(|p| p.config.clone())
        .ok_or_else(|| "Native smoke isolation is unavailable.".to_owned())
}
pub(crate) fn isolated_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.try_state::<SmokePaths>()
        .map(|p| p.cache.clone())
        .ok_or_else(|| "Native smoke isolation is unavailable.".to_owned())
}
fn private_dir(path: &Path) -> std::io::Result<()> {
    fs::DirBuilder::new().create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}
fn create(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
fn paths() -> Result<SmokePaths, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    let keychain = cfg!(feature = "native-keychain-smoke")
        && matches!(args.as_slice(), [_, _, profile] if profile == "--keychain-adhoc");
    #[cfg(feature = "native-credential-smoke")]
    let credential_metadata =
        matches!(args.as_slice(), [_, _, profile] if profile == "--credential-metadata");
    #[cfg(feature = "native-credential-smoke")]
    let credential_public =
        matches!(args.as_slice(), [_, _, profile] if profile == "--credential-public");
    #[cfg(feature = "native-credential-smoke")]
    let credential_import_fixture =
        matches!(args.as_slice(), [_, _, profile] if profile == "--credential-import-fixture");
    let delegation_origin =
        matches!(args.as_slice(), [_, _, profile] if profile == "--delegation-origin");
    let child_grant_freeze =
        matches!(args.as_slice(), [_, _, profile] if profile == "--child-grant-freeze");
    let child_claim = matches!(args.as_slice(), [_, _, profile] if profile == "--child-claim");
    let child_claim_deadline =
        matches!(args.as_slice(), [_, _, profile] if profile == "--child-claim-deadline");
    let restart = match args.as_slice() {
        [_, _, profile] if profile == "--child-restart-prepare" => restart_profile::Role::Prepare,
        [_, _, profile] if profile == "--child-restart-verify" => restart_profile::Role::Verify,
        [_, _, profile] if profile == "--child-restart-verify-r1" => {
            restart_profile::Role::VerifyR1
        }
        [_, _, profile] if profile == "--child-restart-prepare-r2" => {
            restart_profile::Role::PrepareR2
        }
        [_, _, profile] if profile == "--child-restart-verify-r2" => {
            restart_profile::Role::VerifyR2
        }
        _ => restart_profile::Role::None,
    };
    #[cfg(feature = "native-action-smoke")]
    let managed_action = match args.as_slice() {
        [_, _, profile] => managed_action_profile::Scenario::parse(profile),
        _ => None,
    };
    let quit = match args.as_slice() {
        [_, _, profile] => quit_profile::Case::parse(profile),
        _ => None,
    };
    let workflow_pinned =
        matches!(args.as_slice(), [_, _, profile] if workflow_profile::selected(profile));
    let settings_metadata = match args.as_slice() {
        [_, _] => false,
        [_, _, _] if quit.is_some() => false,
        [_, _, _] if workflow_pinned => false,
        #[cfg(feature="native-action-smoke")]
        [_, _, _] if managed_action.is_some() => false,
        [_, _, profile] if profile == "--settings-metadata" => true,
        [_, _, profile] if profile == "--delegation-origin" => false,
        [_, _, profile] if profile == "--child-grant-freeze" => false,
        [_, _, profile] if profile == "--child-claim" => false,
        [_, _, profile] if profile == "--child-claim-deadline" => false,
        [_, _, profile] if profile == "--child-restart-prepare" || profile == "--child-restart-verify" || profile == "--child-restart-verify-r1" || profile == "--child-restart-prepare-r2" || profile == "--child-restart-verify-r2" => false,
        #[cfg(feature = "native-credential-smoke")]
        [_, _, profile] if profile == "--credential-metadata" => false,
        #[cfg(feature = "native-credential-smoke")]
        [_, _, profile] if profile == "--credential-public" => false,
        #[cfg(feature = "native-credential-smoke")]
        [_, _, profile] if profile == "--credential-import-fixture" => false,
        #[cfg(feature = "native-keychain-smoke")]
        [_, _, profile] if profile == "--keychain-adhoc" => false,
        _ => return Err(
            "pass one empty, canonical, private report directory and an enabled optional native profile"
                .into(),
        ),
    };
    let root = PathBuf::from(&args[1]);
    let meta = fs::symlink_metadata(&root)?;
    // SAFETY: geteuid is a side-effect-free identity observation.
    let uid = unsafe { libc::geteuid() };
    if !root.is_absolute()
        || fs::canonicalize(&root)? != root
        || !meta.is_dir()
        || meta.uid() != uid
        || meta.permissions().mode() & 0o077 != 0
        || (!matches!(
            restart,
            restart_profile::Role::Verify
                | restart_profile::Role::VerifyR1
                | restart_profile::Role::VerifyR2
        ) && fs::read_dir(&root)?.next().is_some())
    {
        return Err("report directory must be new, empty, private and owned".into());
    }
    // The supervisor supplies only this child's isolated lookup environment.
    // Validate before creating fixtures; never mutate the process environment.
    for (name, expected) in [
        ("PATH", root.join("bin")),
        ("SHELL", root.join("bin/smoke-shell")),
        ("CLAUDE_CONFIG_DIR", root.join("claude-config")),
    ] {
        if std::env::var_os(name).as_deref() != Some(expected.as_os_str()) {
            return Err("native smoke child environment is not isolated".into());
        }
    }
    for name in [
        "CEREBRO_SHARED_APP_DATA",
        "CEREBRO_RECORD_DIR",
        "CEREBRO_ASK_TOOLS",
        "CLAUDE_CODE_PROJECT_DIR_NAME",
        "CEREBRO_ACTION_TEST_DIR",
        "CEREBRO_ACTION_PROCESS_GATE",
    ] {
        if std::env::var_os(name).is_some() {
            return Err("native smoke child environment contains a forbidden variable".into());
        }
    }
    if matches!(
        restart,
        restart_profile::Role::Verify
            | restart_profile::Role::VerifyR1
            | restart_profile::Role::VerifyR2
    ) {
        if restart == restart_profile::Role::VerifyR2 {
            restart_profile::validate_reopen_r2(&root)?;
        } else if restart == restart_profile::Role::VerifyR1 {
            restart_profile::validate_reopen_r1(&root)?;
        } else {
            restart_profile::validate_reopen(&root)?;
        }
    } else if keychain {
        for name in ["config", "cache"] {
            private_dir(&root.join(name))?;
        }
    } else {
        for name in [
            "config",
            "cache",
            "vault-a",
            "vault-b",
            "bin",
            "claude-config",
        ] {
            private_dir(&root.join(name))?;
        }
        for name in ["vault-a", "vault-b"] {
            private_dir(&root.join(name).join(".cerebro"))?;
            create(&root.join(name).join(".cerebro/connectors.json"), b"{}\n")?;
        }
        let executable = std::env::current_exe()?;
        for name in ["claude", "smoke-shell"] {
            let target = root.join("bin").join(name);
            fs::copy(&executable, &target)?;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
        }
    }
    if matches!(
        restart,
        restart_profile::Role::Prepare | restart_profile::Role::PrepareR2
    ) {
        create(&root.join("restart.marker"), b"cerebro-r0-v1\n")?;
    }
    #[cfg(feature = "native-action-smoke")]
    if managed_action.is_some() {
        create(&root.join("managed-action.marker"), b"managed-action-v1\n")?;
    }
    Ok(SmokePaths {
        config: root.join("config"),
        cache: root.join("cache"),
        vault_a: root.join("vault-a"),
        vault_b: root.join("vault-b"),
        root,
        settings_metadata,
        workflow_pinned,
        delegation_origin,
        child_grant_freeze,
        child_claim,
        child_claim_deadline,
        restart,
        quit,
        #[cfg(feature = "native-action-smoke")]
        managed_action,
        #[cfg(feature = "native-credential-smoke")]
        credential_metadata,
        #[cfg(feature = "native-credential-smoke")]
        credential_public,
        #[cfg(feature = "native-credential-smoke")]
        credential_import_fixture,
        #[cfg(feature = "native-keychain-smoke")]
        keychain,
        metadata_write_observed: AtomicBool::new(false),
        started: AtomicBool::new(false),
        finished: AtomicBool::new(false),
    })
}
fn fixture_child() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    let name = Path::new(&args[0]).file_name().and_then(|s| s.to_str());
    if name == Some("smoke-shell") {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let output = format!("\n__CEREBRO_PATH__{}\n", path.to_string_lossy());
        let _ = std::io::stdout().write_all(output.as_bytes());
        return true;
    }
    if name != Some("claude") {
        return false;
    }
    if args.iter().any(|a| a == "--version") {
        let _ = std::io::stdout().write_all(b"2.1.250 (local native-read smoke fixture)\n");
    } else {
        let _ = std::io::stdout().write_all(b"{\"type\":\"system\",\"subtype\":\"init\",\"permissionMode\":\"default\",\"claude_code_version\":\"2.1.250\",\"tools\":[]}\n");
        if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
            if let Some(root) = Path::new(&dir).parent() {
                let marker = root.join("restart.marker");
                if marker.exists() {
                    if settings_identity(&marker, false).is_err()
                        || fs::read(&marker).ok().as_deref() != Some(b"cerebro-r0-v1\n")
                    {
                        restart_profile::exit_rejected();
                    }
                    crate::spawn::native_restart_toy(root);
                }
            }
        }
        #[cfg(feature = "native-action-smoke")]
        if managed_action_profile::child(&args) {
            return true;
        }
        // Actual AgentState owns/kills/reaps this child. The deadline also bounds
        // an orphan if the smoke parent is externally killed before cleanup.
        std::thread::sleep(Duration::from_secs(45));
    }
    true
}
#[derive(Serialize)]
struct Case {
    name: &'static str,
    observed: &'static str,
}
fn observed(
    cases: &mut Vec<Case>,
    name: &'static str,
    condition: bool,
    value: &'static str,
) -> Result<(), &'static str> {
    if !condition {
        return Err(name);
    }
    cases.push(Case {
        name,
        observed: value,
    });
    Ok(())
}
fn checked<T>(
    command: &str,
    payload: serde_json::Value,
    operation: impl FnOnce() -> T,
) -> Result<T, &'static str> {
    let context = crate::workspace_service::authority::context().map_err(|_| "outer-context")?;
    let request = crate::workspace_service::native_admission::request(
        command,
        &tauri::ipc::InvokeBody::Json(payload),
    )
    .map_err(|_| "outer-request")?;
    crate::workspace_service::native_admission::dispatch_checked(&context, request, operation)
        .map_err(|_| "outer-admission")
}
fn open(app: &AppHandle, window: &WebviewWindow, path: &Path) -> Result<(), &'static str> {
    let vault = path.to_str().ok_or("open-path")?.to_owned();
    checked("start_watcher", serde_json::json!({"vault":vault}), || {
        crate::start_watcher(
            app.clone(),
            window.clone(),
            app.state(),
            app.state(),
            app.state(),
            vault,
        )
    })?
    .map(|_| ())
    .map_err(|_| "actual-start-watcher")
}
fn start(app: &AppHandle, window: &WebviewWindow, path: &Path) -> Result<u64, &'static str> {
    let request = serde_json::from_value(serde_json::json!({
        "message":"", "attended":true, "connectors":false,
        "connector_names":[], "allowed_tools":[], "scope":[], "read_scope":[],
        "ask_first":true, "shell":"off", "web":false, "delegate":"off"
    }))
    .map_err(|_| "request-shape")?;
    let vault = path.to_str().ok_or("run-path")?.to_owned();
    match checked("run_agent", serde_json::json!({"vault":vault}), || {
        crate::run_agent(
            app.clone(),
            window.clone(),
            app.state(),
            vault,
            request,
            None,
            None,
            None,
            None,
        )
    })?
    .map_err(|_| "actual-run-agent")?
    {
        crate::RunStart::Started(handle) => Ok(handle.run),
        _ => Err("actual-run-not-started"),
    }
}
fn catalog(
    app: &AppHandle,
    window: &WebviewWindow,
    run: u64,
) -> Result<
    crate::actions::read_types::ActionCatalogPage,
    crate::actions::read_types::ActionReadError,
> {
    // Uses the actual production command, including its blocking worker handoff.
    checked(
        "native_action_catalog",
        serde_json::json!({"run":run,"cursor":null}),
        || {
            tauri::async_runtime::block_on(crate::native_action_catalog(
                app.clone(),
                window.clone(),
                run,
                None,
            ))
        },
    )
    .unwrap_or_else(|_| Err(crate::native_catalog_join_error()))
}
fn available(app: &AppHandle, window: &WebviewWindow, run: u64) -> bool {
    catalog(app, window, run).is_ok_and(|page| {
        page.descriptors.is_empty()
            && page.next_cursor.is_none()
            && page.snapshot_digest.0.len() == 64
    })
}
fn unavailable(app: &AppHandle, window: &WebviewWindow, run: u64) -> bool {
    catalog(app, window, run).is_err_and(|e| e.code == ActionReadErrorCode::Unavailable)
}
fn capture(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    observed(
        cases,
        "unstarted-run",
        unavailable(app, window, 9_000_000),
        "unavailable",
    )?;
    open(app, window, &paths.vault_a)?;
    let run = start(app, window, &paths.vault_a)?;
    observed(
        cases,
        "live-original-origin-catalog",
        available(app, window, run),
        "empty-measured-no-account-grants",
    )?;
    let status = checked(
        "managed_connection_status",
        serde_json::json!({"connectionId":"smoke-absent-connection"}),
        || {
            tauri::async_runtime::block_on(crate::managed_connection_status(
                app.clone(),
                window.clone(),
                crate::actions::ids::ConnectionId("smoke-absent-connection".into()),
            ))
        },
    )?;
    observed(
        cases,
        "authenticated-managed-metadata-read",
        matches!(status, Err(crate::connections::ConnectionError::NotFound)),
        "not-found",
    )?;
    let definition = checked(
        "native_action_definition",
        serde_json::json!({"run":run,"id":"github.issue.read","digest":"a".repeat(64)}),
        || {
            tauri::async_runtime::block_on(crate::native_action_definition(
                app.clone(),
                window.clone(),
                run,
                ActionId("github.issue.read".into()),
                DefinitionDigest("a".repeat(64)),
            ))
        },
    )?;
    observed(
        cases,
        "ungranted-definition",
        definition.is_err_and(|e| e.code == ActionReadErrorCode::NotFound),
        "not-found",
    )?;
    crate::stop_agent(app.state(), run).map_err(|_| "actual-stop-agent")?;
    observed(
        cases,
        "stopped-original-run",
        unavailable(app, window, run),
        "unavailable",
    )?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "reap-stopped-run")?;

    let run = start(app, window, &paths.vault_a)?;
    observed(
        cases,
        "before-same-path-opening",
        available(app, window, run),
        "catalog-available",
    )?;
    open(app, window, &paths.vault_a)?;
    observed(
        cases,
        "same-path-new-opening",
        unavailable(app, window, run),
        "unavailable",
    )?;
    crate::stop_agent(app.state(), run).map_err(|_| "stop-reopened-run")?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "reap-reopened-run")?;

    let run = start(app, window, &paths.vault_a)?;
    observed(
        cases,
        "before-opening-departure",
        available(app, window, run),
        "catalog-available",
    )?;
    open(app, window, &paths.vault_b)?;
    open(app, window, &paths.vault_a)?;
    observed(
        cases,
        "opening-A-B-A",
        unavailable(app, window, run),
        "unavailable",
    )?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "reap-departed-run")?;

    let run = start(app, window, &paths.vault_a)?;
    observed(
        cases,
        "before-store-replacement",
        available(app, window, run),
        "catalog-available",
    )?;
    let store = crate::ledger::ledger_dir(&paths.vault_a).join("store.json");
    let held = store.with_file_name("store.smoke-original");
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&store)
        .map_err(|_| "store-read")?;
    let metadata = file.metadata().map_err(|_| "store-metadata")?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("store-size");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "store-bounded-read")?;
    if bytes.len() > 4096 {
        return Err("store-size");
    }
    fs::rename(&store, &held).map_err(|_| "store-rename-original")?;
    create(&store, &bytes).map_err(|_| "store-create-same-id")?;
    let refused = unavailable(app, window, run);
    fs::remove_file(&store).map_err(|_| "store-remove-owned-replacement")?;
    fs::rename(&held, &store).map_err(|_| "store-restore-original")?;
    observed(
        cases,
        "same-id-store-inode-replaced",
        refused,
        "unavailable",
    )?;
    crate::stop_agent(app.state(), run).map_err(|_| "stop-store-run")?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "reap-store-run")?;

    let run = start(app, window, &paths.vault_a)?;
    observed(
        cases,
        "before-native-window-destroy",
        available(app, window, run),
        "catalog-available",
    )?;
    window.destroy().map_err(|_| "actual-window-destroy")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while app.get_webview_window(crate::shell::MAIN_WINDOW).is_some() {
        if Instant::now() >= deadline {
            return Err("native-window-destroy-timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    observed(
        cases,
        "destroyed-native-owner",
        unavailable(app, window, run),
        "unavailable",
    )?;
    Ok(())
}
// Separate process profile. It never calls or changes the thirteen-case capture.
use crate::actions::ids::ConnectionId;
use crate::connections::{
    metadata::{ManagedConnectionPage, MetadataRecord, STATUS_SQL},
    ConnectionError, ConnectionHealth, ConnectionStatus, RemoteRevocation,
};
type SettingsCall<T> = Result<Result<T, ConnectionError>, &'static str>;
const SETTINGS_LOGIN: &str = "cerebro-native-smoke";
fn settings_list(
    app: &AppHandle,
    window: &WebviewWindow,
    cursor: Option<ConnectionId>,
) -> SettingsCall<ManagedConnectionPage> {
    checked(
        "managed_connections",
        serde_json::json!({"cursor":cursor}),
        || {
            tauri::async_runtime::block_on(crate::managed_connections(
                app.clone(),
                window.clone(),
                cursor,
            ))
        },
    )
}
fn settings_status(
    app: &AppHandle,
    window: &WebviewWindow,
    id: &ConnectionId,
) -> SettingsCall<ConnectionStatus> {
    checked(
        "managed_connection_status",
        serde_json::json!({"connectionId":id}),
        || {
            tauri::async_runtime::block_on(crate::managed_connection_status(
                app.clone(),
                window.clone(),
                id.clone(),
            ))
        },
    )
}
fn settings_add(
    app: &AppHandle,
    window: &WebviewWindow,
    host: &str,
    login: &str,
) -> SettingsCall<ConnectionStatus> {
    checked(
        "managed_connection_add",
        serde_json::json!({"host":host,"login":login}),
        || {
            tauri::async_runtime::block_on(crate::managed_connection_add(
                app.clone(),
                window.clone(),
                host.into(),
                login.into(),
            ))
        },
    )
}
fn settings_disable(
    app: &AppHandle,
    window: &WebviewWindow,
    id: &ConnectionId,
    expected: u64,
) -> SettingsCall<ConnectionStatus> {
    checked(
        "managed_connection_disable",
        serde_json::json!({"connectionId":id,"expectedRevision":expected}),
        || {
            tauri::async_runtime::block_on(crate::managed_connection_disable(
                app.clone(),
                window.clone(),
                id.clone(),
                expected,
            ))
        },
    )
}
fn settings_same(
    app: &AppHandle,
    window: &WebviewWindow,
    expected: &ConnectionStatus,
) -> Result<bool, &'static str> {
    let status = settings_status(app, window, &expected.connection_id)?;
    let page = settings_list(app, window, None)?;
    Ok(status.as_ref() == Ok(expected)
        && page.is_ok_and(|page| {
            page.items.as_slice() == std::slice::from_ref(expected) && page.next_cursor.is_none()
        }))
}
fn settings_refused(
    app: &AppHandle,
    window: &WebviewWindow,
    id: &ConnectionId,
    expected: u64,
) -> Result<bool, &'static str> {
    // Evaluate every actual wrapper. Outer admission failure is never reduced to
    // the expected inner Unavailable, and no caller supplies authority.
    let list = settings_list(app, window, None)?;
    let status = settings_status(app, window, id)?;
    let add = settings_add(app, window, "github.com", SETTINGS_LOGIN)?;
    let disable = settings_disable(app, window, id, expected)?;
    Ok(list == Err(ConnectionError::Unavailable)
        && status == Err(ConnectionError::Unavailable)
        && add == Err(ConnectionError::Unavailable)
        && disable == Err(ConnectionError::Unavailable))
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
struct SettingsIdentity {
    dev: u64,
    ino: u64,
}
fn settings_identity(path: &Path, directory: bool) -> Result<SettingsIdentity, &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "settings-owned-metadata")?;
    // SAFETY: geteuid observes the current process, never caller identity.
    let uid = unsafe { libc::geteuid() };
    if meta.uid() != uid
        || meta.file_type().is_symlink()
        || (directory && (!meta.is_dir() || meta.mode() & 0o077 != 0))
        || (!directory && (!meta.is_file() || meta.mode() & 0o022 != 0))
    {
        return Err("settings-owned-path");
    }
    Ok(SettingsIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
    })
}
fn settings_absent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}
#[derive(Serialize)]
struct SettingsRuntime {
    root: SettingsIdentity,
    config: SettingsIdentity,
    database: SettingsIdentity,
}
impl SettingsRuntime {
    fn capture(paths: &SmokePaths) -> Result<Self, &'static str> {
        let value = Self {
            root: settings_identity(&paths.root, true)?,
            config: settings_identity(&paths.config, true)?,
            database: settings_identity(&crate::runtime::runtime_db_path(&paths.config), false)?,
        };
        value.recheck(paths)?;
        Ok(value)
    }
    fn root_current(&self, paths: &SmokePaths) -> Result<(), &'static str> {
        if fs::canonicalize(&paths.root).map_err(|_| "settings-root-canonical")? != paths.root
            || settings_identity(&paths.root, true)? != self.root
            || paths.config != paths.root.join("config")
        {
            return Err("settings-root-changed");
        }
        Ok(())
    }
    fn recheck(&self, paths: &SmokePaths) -> Result<(), &'static str> {
        self.root_current(paths)?;
        if fs::canonicalize(&paths.config).map_err(|_| "settings-config-canonical")? != paths.config
            || settings_identity(&paths.config, true)? != self.config
            || settings_identity(&crate::runtime::runtime_db_path(&paths.config), false)?
                != self.database
        {
            return Err("settings-runtime-changed");
        }
        Ok(())
    }
}
fn settings_journal(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    stage: &'static str,
) -> Result<(), &'static str> {
    known.root_current(paths)?;
    let value = serde_json::json!({"format":1,"stage":stage,"configName":"config",
        "heldName":"config.settings-original","physicalIdentity":known});
    let bytes = serde_json::to_vec(&value).map_err(|_| "settings-journal-encode")?;
    if bytes.len() > 4096 {
        return Err("settings-journal-bound");
    }
    create(
        &paths.root.join(format!("settings-origin-{stage}.json")),
        &bytes,
    )
    .map_err(|_| "settings-journal-write")?;
    fs::File::open(&paths.root)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "settings-journal-sync")
}
fn settings_rename_exclusive(from: &Path, to: &Path) -> Result<(), &'static str> {
    use std::os::unix::ffi::OsStrExt;
    let from =
        std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| "settings-rename-path")?;
    let to =
        std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| "settings-rename-path")?;
    // SAFETY: macOS-only smoke; two live NUL-terminated, owned fixed paths.
    // RENAME_EXCL refuses an unexpected destination instead of overwriting it.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err("settings-rename-refused")
    }
}
fn settings_alias_identity(path: &Path, held: &Path) -> Result<SettingsIdentity, &'static str> {
    let meta = fs::symlink_metadata(path).map_err(|_| "settings-alias-metadata")?;
    // SAFETY: observation of this process identity only.
    let uid = unsafe { libc::geteuid() };
    if !meta.file_type().is_symlink()
        || meta.uid() != uid
        || fs::read_link(path).map_err(|_| "settings-alias-target")? != held
    {
        return Err("settings-alias-changed");
    }
    Ok(SettingsIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
    })
}
fn settings_origin_probe(
    app: &AppHandle,
    window: &WebviewWindow,
    paths: &SmokePaths,
    known: &SettingsRuntime,
    expected: &ConnectionStatus,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    let held = paths.root.join("config.settings-original");
    if !settings_absent(&held) {
        return Err("settings-origin-held-exists");
    }
    settings_journal(paths, known, "00-prepared")?;
    known.recheck(paths)?;
    settings_rename_exclusive(&paths.config, &held)?;
    let mut alias_created = false;
    let mut alias = None;
    // Ordinary errors and panics both reach exact restoration. A process kill
    // leaves the create-only journal and held original for explicit recovery.
    let attempted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        known.root_current(paths)?;
        if settings_identity(&held, true)? != known.config || !settings_absent(&paths.config) {
            return Err("settings-origin-rename-changed");
        }
        settings_journal(paths, known, "01-renamed")?;
        std::os::unix::fs::symlink(&held, &paths.config).map_err(|_| "settings-origin-link")?;
        alias_created = true;
        alias = Some(settings_alias_identity(&paths.config, &held)?);
        settings_journal(paths, known, "02-linked")?;
        settings_refused(app, window, &expected.connection_id, expected.revision)
    }))
    .unwrap_or(Err("settings-origin-probe-panicked"));
    let journal_restore = settings_journal(paths, known, "03-restore-intent");
    let restored = (|| {
        known.root_current(paths)?;
        if settings_identity(&held, true)? != known.config
            || settings_identity(&crate::runtime::runtime_db_path(&held), false)? != known.database
        {
            return Err("settings-origin-held-changed");
        }
        if alias_created {
            let identity = alias.ok_or("settings-origin-alias-unobserved")?;
            if settings_alias_identity(&paths.config, &held)? != identity {
                return Err("settings-origin-alias-changed");
            }
            // Unlink only the exact created symlink; never follow its target.
            fs::remove_file(&paths.config).map_err(|_| "settings-origin-unlink")?;
        } else if !settings_absent(&paths.config) {
            return Err("settings-origin-name-occupied");
        }
        known.root_current(paths)?;
        if settings_identity(&held, true)? != known.config {
            return Err("settings-origin-held-changed");
        }
        settings_rename_exclusive(&held, &paths.config)?;
        known.recheck(paths)?;
        if !settings_absent(&held) {
            return Err("settings-origin-held-remains");
        }
        settings_journal(paths, known, "04-restored")
    })();
    if restored.is_err() {
        return Err("settings-origin-restoration-pending");
    }
    journal_restore?;
    attempted
}
fn settings_audit(
    paths: &SmokePaths,
    known: &SettingsRuntime,
    expected: &ConnectionStatus,
) -> Result<bool, &'static str> {
    known.recheck(paths)?;
    if !settings_absent(&paths.root.join("config.settings-original")) {
        return Err("settings-audit-unrestored-origin");
    }
    // Observation only after retirement. No RuntimeOwner, writer, migration or
    // current-vault lookup is created; the original restored path is pinned.
    let read = crate::runtime::ReadOnly::open(&paths.config).map_err(|_| "settings-audit-open")?;
    known.recheck(paths)?;
    let counts: (i64, i64, i64, i64, i64) = read.query_row(
        "SELECT (SELECT count(*) FROM managed_connections),(SELECT count(*) FROM managed_connection_attempts),(SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL),(SELECT count(*) FROM managed_secret_cleanup),(SELECT count(*) FROM action_account_grants)",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).map_err(|_| "settings-audit-counts")?;
    let record = read
        .query_row(
            STATUS_SQL,
            [
                &expected.connection_id.0,
                &crate::actions::schema::admission_rules().owner_storage_key,
            ],
            MetadataRecord::read,
        )
        .map_err(|_| "settings-audit-status")?;
    drop(read);
    known.recheck(paths)?;
    let matches = record.status == *expected
        && record.active.is_none()
        && record.reference.is_none()
        && counts == (1, 0, 0, 0, 0);
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "format":1,"profile":"settings-metadata","counts":{
            "connections":counts.0,"attempts":counts.1,"secretReferences":counts.2,
            "cleanup":counts.3,"accountGrants":counts.4},
        "status":record.status,"matchesExpected":matches,"physicalIdentity":known,
        "activeAttemptAbsent":record.active.is_none(),"secretReferenceAbsent":record.reference.is_none()
    })).map_err(|_| "settings-audit-encode")?;
    if bytes.len() > 16384 {
        return Err("settings-audit-bound");
    }
    create(&paths.root.join("settings-audit.json"), &bytes).map_err(|_| "settings-audit-write")?;
    Ok(matches)
}
fn capture_settings(
    app: &AppHandle,
    window: &WebviewWindow,
    cases: &mut Vec<Case>,
) -> Result<(), &'static str> {
    let paths = app.state::<SmokePaths>();
    let absent = ConnectionId("settings-not-created".into());
    observed(
        cases,
        "settings-before-open",
        settings_refused(app, window, &absent, 1)?,
        "all-four-unavailable",
    )?;
    open(app, window, &paths.vault_a)?;
    let known = SettingsRuntime::capture(&paths)?;
    let empty =
        settings_list(app, window, None)?.map_err(|_| "settings-initial-list-unavailable")?;
    observed(
        cases,
        "settings-initial-list",
        empty.items.is_empty() && empty.next_cursor.is_none(),
        "empty-measured",
    )?;
    let invalid_host = settings_add(app, window, "unsupported.example", SETTINGS_LOGIN)?;
    let invalid_login = settings_add(app, window, "github.com", "bad login")?;
    let empty =
        settings_list(app, window, None)?.map_err(|_| "settings-invalid-list-unavailable")?;
    observed(
        cases,
        "settings-invalid-selection",
        invalid_host == Err(ConnectionError::Unsupported)
            && invalid_login == Err(ConnectionError::InvalidSelection)
            && empty.items.is_empty()
            && empty.next_cursor.is_none(),
        "unsupported-invalid-unchanged",
    )?;
    let added = settings_add(app, window, "github.com", SETTINGS_LOGIN)?
        .map_err(|_| "settings-add-unavailable")?;
    paths.metadata_write_observed.store(true, Ordering::SeqCst);
    observed(
        cases,
        "settings-add-metadata",
        !added.connection_id.0.is_empty()
            && added.connection_id.0.len()
                <= crate::actions::schema::admission_rules()
                    .limits
                    .identity_bytes
            && added.revision == 1
            && added.login == SETTINGS_LOGIN
            && added.health == ConnectionHealth::SignInRequired
            && added.account.is_none()
            && added.secret_revision == 0
            && added.revocation_generation == 0
            && !added.cleanup_pending
            && added.remote_revocation == RemoteRevocation::NotAttempted,
        "sign-in-required-no-credential",
    )?;
    observed(
        cases,
        "settings-point-and-list",
        settings_same(app, window, &added)?,
        "exact-row",
    )?;
    let invalid_cursor = settings_list(app, window, Some(ConnectionId(String::new())))?;
    observed(
        cases,
        "settings-invalid-cursor",
        invalid_cursor == Err(ConnectionError::InvalidSelection)
            && settings_same(app, window, &added)?,
        "invalid-unchanged",
    )?;
    let stale = settings_disable(app, window, &added.connection_id, 0)?;
    observed(
        cases,
        "settings-stale-disable",
        stale == Err(ConnectionError::StaleRevision) && settings_same(app, window, &added)?,
        "stale-unchanged",
    )?;
    let disabled = settings_disable(app, window, &added.connection_id, added.revision)?
        .map_err(|_| "settings-disable-unavailable")?;
    observed(
        cases,
        "settings-disable",
        disabled.connection_id == added.connection_id
            && disabled.login == added.login
            && disabled.health == ConnectionHealth::Disabled
            && disabled.revision == added.revision + 1
            && disabled.revocation_generation == added.revocation_generation + 1
            && disabled.account == added.account
            && disabled.secret_revision == added.secret_revision
            && !disabled.cleanup_pending
            && disabled.remote_revocation == RemoteRevocation::NotAttempted
            && settings_same(app, window, &disabled)?,
        "disabled-no-cleanup-required",
    )?;
    let repeated = settings_disable(app, window, &added.connection_id, added.revision)?;
    observed(
        cases,
        "settings-replayed-disable",
        repeated == Err(ConnectionError::StaleRevision) && settings_same(app, window, &disabled)?,
        "stale-unchanged",
    )?;
    let run = start(app, window, &paths.vault_a)?;
    crate::stop_agent(app.state(), run).map_err(|_| "settings-stop-run")?;
    app.state::<crate::agent::AgentState>()
        .stop_all()
        .map_err(|_| "settings-reap-run")?;
    observed(
        cases,
        "settings-after-stop",
        settings_same(app, window, &disabled)?,
        "same-app-account",
    )?;
    open(app, window, &paths.vault_b)?;
    open(app, window, &paths.vault_a)?;
    observed(
        cases,
        "settings-after-opening-aba",
        settings_same(app, window, &disabled)?,
        "same-app-account",
    )?;
    observed(
        cases,
        "settings-before-origin-alias",
        settings_same(app, window, &disabled)?,
        "exact-disabled-row",
    )?;
    let refused = settings_origin_probe(app, window, &paths, &known, &disabled)?;
    observed(
        cases,
        "settings-origin-alias",
        refused,
        "all-four-unavailable",
    )?;
    observed(
        cases,
        "settings-original-origin-restored",
        settings_same(app, window, &disabled)?,
        "exact-disabled-row",
    )?;
    window.destroy().map_err(|_| "settings-window-destroy")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while app.get_webview_window(crate::shell::MAIN_WINDOW).is_some() {
        if Instant::now() >= deadline {
            return Err("settings-window-destroy-timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    observed(
        cases,
        "settings-destroyed-window",
        settings_refused(app, window, &disabled.connection_id, disabled.revision)?,
        "all-four-unavailable",
    )?;
    observed(
        cases,
        "settings-final-storage-audit",
        settings_audit(&paths, &known, &disabled)?,
        "one-metadata-zero-acquisition-secret-cleanup-grants",
    )?;
    Ok(())
}
fn settings_report(
    paths: &SmokePaths,
    cases: &[Case],
    failed_stage: Option<&'static str>,
) -> serde_json::Value {
    let authenticated = cases
        .iter()
        .any(|case| case.name == "settings-initial-list");
    let run = cases.iter().any(|case| case.name == "settings-after-stop");
    let writes = paths
        .metadata_write_observed
        .load(Ordering::SeqCst)
        .then_some(true);
    serde_json::json!({
        "format":2,"observer":"native-injected-window-settings-metadata-smoke","profile":"settings-metadata",
        "passed":failed_stage.is_none(),"failedStage":failed_stage,"cases":cases,
        "compiledInputs":compiled_inputs(),
        "claims":{"actualMacosWindow":authenticated,"actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "disposableAccountMetadataWrites":writes,"providerFreeFixtureCli":run,
            "credentialAccess":false,"realAccountImport":false,"providerNetwork":false,
            "grantsOrEffectsEnabled":false,"realCliAcceptance":false,"packagedKeychainAcceptance":false,
            "positivePendingCleanupExercised":false},
        "timeBasis":"wall-clock deadlines; not deterministic performance evidence"
    })
}

fn compiled_inputs() -> serde_json::Value {
    let mut hash = Sha256::new();
    hash.update(b"cerebro-native-producer-inputs-v1\n");
    let mut total = 0usize;
    let mut previous = "";
    assert!(!NATIVE_PRODUCER_INPUTS.is_empty() && NATIVE_PRODUCER_INPUTS.len() <= 2048);
    for &(path, bytes) in NATIVE_PRODUCER_INPUTS {
        assert!(path > previous && bytes.len() <= 4 * 1024 * 1024);
        previous = path;
        total += bytes.len();
        assert!(total <= 64 * 1024 * 1024);
        hash.update(format!("{path}\0{}\0{:x}\n", bytes.len(), Sha256::digest(bytes)).as_bytes());
    }
    serde_json::json!({
        "scope":"cerebro-native-producer-inputs-v1", "aggregateDigest":format!("{:x}", hash.finalize()),
        "fileCount":NATIVE_PRODUCER_INPUTS.len(), "totalBytes":total,
        "smokeConfigSha256":format!("{:x}", Sha256::digest(include_bytes!("../native-read-smoke/tauri.conf.json")))
    })
}
#[cfg(feature = "native-keychain-smoke")]
fn finish_keychain(
    app: &AppHandle,
    observation: crate::connections::keychain_acceptance::Observation,
) {
    let paths = app.state::<SmokePaths>();
    if paths.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    let passed = observation.outcome == "pass";
    let report = serde_json::json!({
        "format":3,"observer":"native-injected-window-packaged-keychain-smoke",
        "profile":"keychain-adhoc","passed":passed,"compiledInputs":compiled_inputs(),
        "signingProfile":"adhoc-minus-no-entitlements","observation":observation,
        "claims":{"actualInjectedCommand":paths.started.load(Ordering::SeqCst),
            "realCredentials":false,"realAccountImport":false,"providerNetwork":false,
            "grantsOrEffectsEnabled":false,"runtimeAccountLifecycle":false,
            "productionSigningAcceptance":false},
        "timeBasis":"wall-clock observation limit; no hard Security.framework deadline"
    });
    let bytes = serde_json::to_vec_pretty(&report).expect("closed keychain smoke report");
    let saved = bytes.len() <= 65536 && create(&paths.root.join("report.json"), &bytes).is_ok();
    app.exit(if saved && passed { 0 } else { 2 });
}
#[path = "native_child_claim_smoke.rs"]
pub(crate) mod child_claim_profile;
use child_claim_profile::restart_profile;
#[path = "native_child_freeze_smoke.rs"]
mod child_freeze_profile;
#[cfg(feature = "native-credential-smoke")]
#[path = "native_credential_import_smoke.rs"]
mod credential_import_profile;
#[cfg(feature = "native-credential-smoke")]
#[path = "native_credentials_smoke.rs"]
mod credential_profile;
#[path = "native_delegation_smoke.rs"]
mod delegation_profile;

#[cfg(feature = "native-action-smoke")]
#[path = "native_managed_action_smoke.rs"]
mod managed_action_profile;
#[path = "native_quit_smoke.rs"]
mod quit_profile;
#[path = "native_workflow_smoke.rs"]
mod workflow_profile;
#[cfg(feature = "native-action-smoke")]
pub(crate) fn record_managed_child_launch(
    config_dir: &Path,
    run: u64,
    child: &crate::spawn::Handle,
) {
    // Observation failure must not unwind/drop a successfully Started child.
    // The genuine AgentState/stream retains cleanup ownership; bootstrap
    // refuses a missing receipt before releasing the scripted original child.
    let _ = managed_action_profile::record_child_launch(config_dir, run, child);
}

#[tauri::command]
async fn native_managed_action_probe(
    app: AppHandle,
    window: WebviewWindow,
    probe: serde_json::Value,
) -> Result<serde_json::Value, &'static str> {
    #[cfg(feature = "native-action-smoke")]
    {
        return managed_action_profile::probe(app, window, probe).await;
    }
    #[cfg(not(feature = "native-action-smoke"))]
    {
        let _ = (app, window, probe);
        Err("managed-action-profile-not-enabled")
    }
}

fn finish(app: &AppHandle, cases: Vec<Case>, failed_stage: Option<&'static str>) {
    #[cfg(feature = "native-action-smoke")]
    if managed_action_profile::enabled(app) {
        managed_action_profile::finish(app, failed_stage);
        return;
    }
    let paths = app.state::<SmokePaths>();
    #[cfg(feature = "native-keychain-smoke")]
    if paths.keychain {
        finish_keychain(
            app,
            crate::connections::keychain_acceptance::Observation::incomplete(
                failed_stage.unwrap_or("keychain-report-unavailable"),
            ),
        );
        return;
    }
    if paths.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    app.state::<crate::agent::AgentState>().shut_down();
    let _ = crate::vault::watcher::stop(app.state::<crate::vault::watcher::WatcherState>().inner());
    let positive_origin = cases
        .iter()
        .any(|case| case.name == "live-original-origin-catalog");
    #[cfg(feature = "native-credential-smoke")]
    let credential_report = if paths.credential_import_fixture {
        Some(credential_import_profile::report(
            &paths,
            &cases,
            failed_stage,
        ))
    } else if paths.credential_public {
        Some(credential_profile::public_report(
            &paths,
            &cases,
            failed_stage,
        ))
    } else {
        paths
            .credential_metadata
            .then(|| credential_profile::report(&paths, &cases, failed_stage))
    };
    #[cfg(not(feature = "native-credential-smoke"))]
    let credential_report: Option<serde_json::Value> = None;
    let report = if let Some(report) = credential_report {
        report
    } else if paths.workflow_pinned {
        workflow_profile::report(&paths, &cases, failed_stage)
    } else if paths.child_claim_deadline {
        child_claim_profile::report_deadline(&paths, &cases, failed_stage)
    } else if paths.child_claim {
        child_claim_profile::report(&paths, &cases, failed_stage)
    } else if paths.child_grant_freeze {
        child_freeze_profile::report(&paths, &cases, failed_stage)
    } else if paths.delegation_origin {
        delegation_profile::report(&paths, &cases, failed_stage)
    } else if paths.settings_metadata {
        settings_report(&paths, &cases, failed_stage)
    } else {
        serde_json::json!({
            "format":1, "observer":"native-injected-window-read-smoke",
            "passed":failed_stage.is_none(), "failedStage":failed_stage, "cases":cases,
            "compiledInputs":compiled_inputs(),
            "claims":{"actualMacosWindow":positive_origin,"actualInjectedCommand":paths.started.load(Ordering::SeqCst),
                "actualOpeningAndRunPublication":positive_origin,"providerFreeFixtureCli":positive_origin,
                "realClaudeCode":false,"providerOrAccount":false,"effectAuthority":false,
                "positiveGrantedDefinition":false,"packagedEntitlementAcceptance":false},
            "timeBasis":"wall-clock deadlines; not deterministic performance evidence"
        })
    };
    let bytes = serde_json::to_vec_pretty(&report).expect("closed smoke report");
    let saved = bytes.len() <= 65536 && create(&paths.root.join("report.json"), &bytes).is_ok();
    app.exit(if saved && failed_stage.is_none() {
        0
    } else {
        2
    });
}
#[tauri::command]
async fn capture_native_reads(
    app: AppHandle,
    window: WebviewWindow,
    probe: Option<quit_profile::Probe>,
) -> Result<serde_json::Value, &'static str> {
    #[cfg(feature = "native-action-smoke")]
    if managed_action_profile::enabled(&app) {
        if probe.is_some() {
            return Err("managed-profile-no-quit-probe");
        }
        return managed_action_profile::bootstrap(app, window).await;
    }
    if quit_profile::enabled(&app) {
        return match probe {
            None => quit_profile::bootstrap(&app, &window),
            Some(probe) => quit_profile::probe(&app, probe).await,
        };
    }
    if probe.is_some() {
        return Err("probe-requires-quit-profile");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let paths = app.state::<SmokePaths>();
        if paths.started.swap(true, Ordering::SeqCst) {
            return Err("capture-already-started");
        }
        #[cfg(feature = "native-keychain-smoke")]
        if paths.keychain {
            let observation = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::connections::keychain_acceptance::capture(&app, &window, &paths.root)
            }))
            .unwrap_or_else(|_| {
                crate::connections::keychain_acceptance::Observation::incomplete(
                    "keychain-worker-panicked",
                )
            });
            let passed = observation.outcome == "pass";
            finish_keychain(&app, observation);
            return if passed {
                Ok(())
            } else {
                Err("keychain-acceptance-not-passed")
            };
        }
        if paths.restart != restart_profile::Role::None {
            restart_profile::capture(&app, &window);
        }
        let mut cases = Vec::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            #[cfg(feature = "native-credential-smoke")]
            if paths.credential_import_fixture {
                return credential_import_profile::capture(&app, &window, &mut cases);
            }
            #[cfg(feature = "native-credential-smoke")]
            if paths.credential_metadata {
                return credential_profile::capture(&app, &window, &mut cases);
            }
            #[cfg(feature = "native-credential-smoke")]
            if paths.credential_public {
                return credential_profile::capture_public(&app, &window, &mut cases);
            }
            if paths.workflow_pinned {
                return workflow_profile::capture(&app, &window, &mut cases);
            }
            if paths.child_claim_deadline {
                return child_claim_profile::capture_deadline(&app, &window, &mut cases);
            }
            if paths.child_claim {
                return child_claim_profile::capture(&app, &window, &mut cases);
            }
            if paths.child_grant_freeze {
                return child_freeze_profile::capture(&app, &window, &mut cases);
            }
            if paths.delegation_origin {
                return delegation_profile::capture(&app, &window, &mut cases);
            }
            if paths.settings_metadata {
                capture_settings(&app, &window, &mut cases)
            } else {
                capture(&app, &window, &mut cases)
            }
        }))
        .unwrap_or(Err("native-capture-panicked"));
        finish(&app, cases, result.err());
        result
    })
    .await
    .map_err(|_| "capture-worker-unavailable")?
    .map(|_| serde_json::Value::Null)
}

pub fn main() {
    if fixture_child() {
        return;
    }
    // Before a trusted application path exists, the existing debug logger
    // mirrors bounded records to the supervisor-owned stderr capture.
    crate::diagnostics::init();
    let paths = match paths() {
        Ok(paths) => paths,
        Err(_) => {
            log::error!("native smoke startup refused: paths-or-environment");
            std::process::exit(2);
        }
    };
    if paths.restart != restart_profile::Role::None {
        let _ = crate::process_started();
    }
    let context = tauri::generate_context!("native-read-smoke/tauri.conf.json");
    let config = context.config();
    // Refuse inherited TAURI_CONFIG/dev-url overlays before any window can open.
    if config.identifier != "com.cerebro.native-read-smoke"
        || config.build.dev_url.is_some()
        || config.app.windows.len() != 1
        || config.app.windows[0].label != crate::shell::MAIN_WINDOW
        || config.app.windows[0].create
        || !config.app.windows[0].incognito
        || config.app.windows[0].data_directory.is_some()
        || !matches!(&config.app.windows[0].url, tauri::WebviewUrl::App(path) if path == Path::new("index.html"))
    {
        log::error!("native smoke context isolation: identifier={}, dev_url={}, window_count={}, label={}, create={}, incognito={}, data_directory={}, local_entry={}",
            config.identifier == "com.cerebro.native-read-smoke", config.build.dev_url.is_none(),
            config.app.windows.len(), config.app.windows.first().is_some_and(|w| w.label == crate::shell::MAIN_WINDOW),
            config.app.windows.first().is_some_and(|w| w.create), config.app.windows.first().is_some_and(|w| w.incognito),
            config.app.windows.first().is_some_and(|w| w.data_directory.is_none()),
            config.app.windows.first().is_some_and(|w| matches!(&w.url, tauri::WebviewUrl::App(path) if path == Path::new("index.html"))));
        std::process::exit(2);
    }
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(paths)
        .manage(quit_profile::Trace::default())
        .manage(crate::vault::watcher::WatcherState::default())
        .manage(crate::recovery_commands::RecoveryState::default())
        .manage(crate::draft_recovery_commands::DraftExportState::default())
        .manage(crate::agent::AgentState::default())
        .manage(crate::mcp::McpState::default())
        .manage(crate::ingest::ambient::AmbientState::default())
        .manage(crate::shell::quit::QuitState::default())
        .setup(|app| {
            #[cfg(feature = "native-action-smoke")]
            {
                if !app.manage(managed_action_profile::State::default())
                    || !app
                        .manage(crate::actions::native_owner::NativeActionSmokeFixture::default())
                {
                    return Err("Native managed smoke state was already installed.".into());
                }
            }
            crate::workspace_service::authority::install(isolated_app_dir(app.handle())?)
                .map_err(|e| e.message)?;
            crate::shell::build_main_window(app)
        })
        .invoke_handler({
            let generated: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                capture_native_reads,
                native_managed_action_probe,
                crate::read_managed_action_access,
                crate::set_managed_action_access,
                crate::list_interactions,
                crate::answer_interaction,
                crate::stop_agent,
                credential_commands::begin_gh_import,
                credential_commands::credential_acquisition,
                credential_commands::cancel_credential_acquisition,
                quit_profile::native_smoke_cancel_quit,
                quit_profile::native_smoke_finish_quit
            ];
            move |invoke: tauri::ipc::Invoke| {
                #[cfg(feature = "native-action-smoke")]
                if !matches!(
                    invoke.message.command(),
                    "capture_native_reads"
                        | "native_managed_action_probe"
                        | "native_smoke_cancel_quit"
                        | "native_smoke_finish_quit"
                ) {
                    // Exact production outer admission for real command handlers. Only
                    // this executable's closed measurement commands bypass it.
                    let resolver = invoke.resolver.clone();
                    let result = crate::workspace_service::native_admission::request(
                        invoke.message.command(),
                        invoke.message.payload(),
                    )
                    .and_then(|request| {
                        crate::workspace_service::authority::context().and_then(|context| {
                            crate::workspace_service::native_admission::dispatch_checked(
                                &context,
                                request,
                                || generated(invoke),
                            )
                        })
                    });
                    return match result {
                        Ok(handled) => handled,
                        Err(error) => {
                            resolver.reject(error);
                            true
                        }
                    };
                }
                generated(invoke)
            }
        })
        .build(context);
    let application = match application {
        Ok(app) => app,
        Err(_) => {
            log::error!("native smoke startup refused: builder");
            std::process::exit(2);
        }
    };
    application.run(|app, event| match event {
        tauri::RunEvent::Ready => {
            if quit_profile::enabled(app) {
                quit_profile::watchdog(app);
                return;
            }
            if restart_profile::active(app) {
                restart_profile::watchdog(60);
                return;
            }
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(60));
                finish(&app, Vec::new(), Some("smoke-deadline"));
            });
        }
        tauri::RunEvent::ExitRequested { api, .. }
            if !quit_profile::enabled(app)
                && !app.state::<SmokePaths>().finished.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
        }
        tauri::RunEvent::ExitRequested { .. } if quit_profile::enabled(app) => {
            quit_profile::exit_requested(app);
        }
        tauri::RunEvent::Exit => {
            if quit_profile::enabled(app) {
                quit_profile::exit(app);
            }
            if matches!(
                app.state::<SmokePaths>().restart,
                restart_profile::Role::Prepare | restart_profile::Role::PrepareR2
            ) {
                restart_profile::exit_rejected();
            }
            app.state::<crate::agent::AgentState>().shut_down();
            crate::client_access::shut_down();
            crate::runtime::sessions::close_current();
        }
        _ => {}
    });
}
