pub mod agent;
pub mod app_config;
pub mod connectors;
pub mod demo;
pub mod git;
pub mod git_commands;
pub mod knowledge;
pub mod mcp;
pub mod search;
pub mod vault;

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use vault::entry::Entry;
use vault::watcher::WatcherState;
use vault::write::{CollectionYaml, ViewYaml};

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn remember_vault(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let dir = config_dir(app)?;
    let mut config = app_config::load(&dir);
    config.last_vault = Some(path.to_string());
    app_config::save(&dir, &config)
}

#[tauri::command]
async fn pick_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().to_string();
    remember_vault(&app, &path)?;
    Ok(Some(path))
}

// All commands below are `(async)` so their disk IO runs on the thread pool
// instead of stalling the main thread on large vaults (M1.x).
/// Copy the bundled demo vault somewhere writable and remember it, so a fresh
/// install has something to open instead of a folder picker onto an empty Mac.
#[tauri::command(async)]
fn open_demo_vault(app: tauri::AppHandle) -> Result<String, String> {
    let path = demo::ensure(&app)?;
    remember_vault(&app, &path)?;
    Ok(path)
}

#[tauri::command(async)]
fn get_last_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app_config::load(&config_dir(&app)?).last_vault)
}

#[tauri::command(async)]
fn scan_vault(vault: String) -> Result<Vec<Entry>, String> {
    vault::scan::scan_vault(Path::new(&vault))
}

#[tauri::command(async)]
fn read_note(vault: String, path: String) -> Result<String, String> {
    vault::write::read_note(Path::new(&vault), &path)
}

// The write commands below are the HUMAN path — every one of them is
// reachable from the UI, so each guards the knowledge/ bundle (M5). The
// agent's MCP tools have their own, narrower boundary (M17.1): they reach
// the bundle through `write_concept` alone. See mcp.rs.
#[tauri::command(async)]
fn save_note(vault: String, path: String, body: String) -> Result<(), String> {
    knowledge::guard_human_write(&path)?;
    vault::write::save_note(Path::new(&vault), &path, &body)
}

#[tauri::command(async)]
fn update_frontmatter(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    knowledge::guard_human_write(&path)?;
    vault::write::update_frontmatter(Path::new(&vault), &path, &patch)
}

/// The one sanctioned human write into the bundle: recording that a person
/// has confirmed a concept. Scoped to the `verified` key (see knowledge.rs).
#[tauri::command(async)]
fn verify_concept(
    vault: String,
    path: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    knowledge::guard_verify(&path, &patch)?;
    vault::write::update_frontmatter(Path::new(&vault), &path, &patch)
}

#[tauri::command(async)]
fn create_note(
    vault: String,
    folder: String,
    slug: String,
    frontmatter: serde_json::Map<String, serde_json::Value>,
    body: String,
) -> Result<String, String> {
    knowledge::guard_human_write(&folder)?;
    vault::write::create_note(Path::new(&vault), &folder, &slug, &frontmatter, &body)
}

#[tauri::command(async)]
fn set_note_title(vault: String, path: String, title: String) -> Result<(), String> {
    knowledge::guard_human_write(&path)?;
    vault::write::set_note_title(Path::new(&vault), &path, &title)
}

#[tauri::command(async)]
fn list_views(vault: String) -> Result<Vec<ViewYaml>, String> {
    vault::write::list_views(Path::new(&vault))
}

#[tauri::command(async)]
fn save_view(
    vault: String,
    id: String,
    yaml: String,
    folder: Option<String>,
) -> Result<(), String> {
    vault::write::save_view(Path::new(&vault), &id, &yaml, folder.as_deref())
}

#[tauri::command(async)]
fn list_collections(vault: String) -> Result<Vec<CollectionYaml>, String> {
    vault::write::list_collections(Path::new(&vault))
}

#[tauri::command(async)]
fn save_collection(vault: String, folder: String, yaml: String) -> Result<(), String> {
    knowledge::guard_human_write(&folder)?;
    vault::write::save_collection(Path::new(&vault), &folder, &yaml)
}

#[tauri::command(async)]
fn save_list(vault: String, folder: String, id: String, yaml: String) -> Result<(), String> {
    knowledge::guard_human_write(&folder)?;
    vault::write::save_list(Path::new(&vault), &folder, &id, &yaml)
}

#[tauri::command(async)]
fn create_folder(vault: String, path: String) -> Result<(), String> {
    knowledge::guard_human_write(&path)?;
    vault::write::create_folder(Path::new(&vault), &path)
}

#[tauri::command(async)]
fn rename_note(vault: String, from: String, to: String) -> Result<(), String> {
    knowledge::guard_human_move(&from, &to)?;
    vault::write::rename_note(Path::new(&vault), &from, &to)
}

#[tauri::command(async)]
fn delete_note(vault: String, path: String) -> Result<(), String> {
    // The one write command that never had this guard (M17.1). Read-only
    // that a delete can empty is not read-only: every other door into the
    // bundle was shut while this one let a concept — and its provenance —
    // be thrown away outright.
    knowledge::guard_human_write(&path)?;
    vault::write::delete_note(Path::new(&vault), &path)
}

#[tauri::command(async)]
fn list_folders(vault: String) -> Result<Vec<String>, String> {
    vault::scan::list_folders(Path::new(&vault))
}

// --- Attachments (M16.13c) --------------------------------------------------

/// Native multi-file picker. Returns absolute paths; empty when cancelled.
///
/// Split from `import_attachment` so the copy stays a pure, unit-testable
/// function and so a future drag-and-drop can reuse it — the picker is the
/// only half that needs an AppHandle.
///
/// Not `(async)` but an `async fn`, matching `pick_vault`: the blocking
/// dialog must not run on the main thread.
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_files() else {
        return Ok(Vec::new());
    };
    picked
        .into_iter()
        .map(|f| {
            f.into_path()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| e.to_string())
        })
        .collect()
}

/// Copy a picked file into the vault's `attachments/` folder; returns its
/// vault-relative path. No knowledge guard: the destination is fixed inside
/// `import_attachment` and can never be `knowledge/`.
#[tauri::command(async)]
fn import_attachment(vault: String, source: String) -> Result<String, String> {
    vault::write::import_attachment(Path::new(&vault), &source)
}

// --- Local agent + MCP (M6) ------------------------------------------------

#[tauri::command(async)]
fn check_agent() -> agent::AgentStatus {
    agent::status()
}

/// What the CLI has stored about this vault OUTSIDE it (M17.14).
#[tauri::command(async)]
fn agent_workspace(vault: String) -> agent::CliWorkspace {
    agent::cli_workspace(Path::new(&vault))
}

#[tauri::command(async)]
fn purge_agent_workspace(vault: String) -> Result<usize, String> {
    agent::purge_cli_workspace(Path::new(&vault))
}

/// Start (or retarget) the loopback MCP endpoint and return its address. The
/// token is handed to the CLI through a private config file; the frontend
/// carries it only to pass it back into `run_agent`.
#[tauri::command(async)]
fn start_mcp(
    app: tauri::AppHandle,
    state: tauri::State<'_, mcp::McpState>,
    vault: String,
) -> Result<mcp::McpInfo, String> {
    state.ensure(&app, Path::new(&vault))
}

/// Returns the run's id — the tag on every event this run emits.
#[tauri::command(async)]
fn run_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    mcp_state: tauri::State<'_, mcp::McpState>,
    vault: String,
    request: agent::AgentRequest,
) -> Result<u64, String> {
    // Attribution rides the run's own bearer token (M13.4): the MCP server
    // stamps `generated.by` from the token each request presents, so a
    // child killed while a write is in flight still stamps as itself.
    // Shared "current actor" state had a window — set here, before the old
    // child was gone — where the outgoing run's trailing writes stamped as
    // the incoming run (PR #5 security review).
    let mut request = request;
    // M17.13: the scope rides the same token. It is taken from the REQUEST,
    // which the app builds from the Agent record — the CLI never sees it and
    // therefore cannot argue with it.
    request.mcp_token = Some(mcp_state.run_token(request.actor.as_deref(), request.scope.clone())?);
    let dir = config_dir(&app)?;
    agent::stream(app.clone(), state.inner(), Path::new(&vault), request, &dir)
}

/// Empty string = the vault has no connectors.json (a real state Settings
/// names). A file that EXISTS but cannot be read — permissions, a blocked
/// symlink — is an Err, never an empty Ok (PR #5 review): runs fail closed
/// on that config, and Settings rendering it as "no explicit list" would
/// claim legacy open mode while runs are pinned to zero servers.
#[tauri::command(async)]
fn read_connectors(vault: String) -> Result<String, String> {
    connectors::read_raw_checked(Path::new(&vault))
}

#[tauri::command(async)]
fn save_connectors(vault: String, json: String) -> Result<(), String> {
    connectors::save_raw(Path::new(&vault), &json)
}

/// Returns the killed run's id (if anything was running) so the frontend can
/// recognize and drop that run's trailing events (PR #5 review).
#[tauri::command(async)]
/// Stop ONE run (M17.3). `false` means it had already finished — a race, not
/// an error. Taking a run id is the point: a global kill was safe only while
/// there could be one child, and it is how closing the assistant used to
/// abort a background distill that had nothing to do with it.
fn stop_agent(state: tauri::State<'_, agent::AgentState>, run: u64) -> Result<bool, String> {
    state.stop(run)
}

/// Stop everything, reporting what died. For shutdown and vault switches: a
/// child left pointed at the vault you just closed is worse than one
/// interrupted.
#[tauri::command(async)]
fn stop_all_agents(state: tauri::State<'_, agent::AgentState>) -> Result<Vec<u64>, String> {
    state.stop_all()
}

#[tauri::command(async)]
fn start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    vault: String,
) -> Result<(), String> {
    vault::watcher::start(app, state.inner(), PathBuf::from(vault))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .manage(agent::AgentState::default())
        .manage(mcp::McpState::default())
        .invoke_handler(tauri::generate_handler![
            pick_vault,
            open_demo_vault,
            get_last_vault,
            scan_vault,
            read_note,
            save_note,
            update_frontmatter,
            verify_concept,
            create_note,
            set_note_title,
            list_views,
            save_view,
            list_collections,
            save_collection,
            save_list,
            create_folder,
            rename_note,
            delete_note,
            list_folders,
            pick_files,
            import_attachment,
            start_watcher,
            read_connectors,
            save_connectors,
            check_agent,
            agent_workspace,
            purge_agent_workspace,
            start_mcp,
            run_agent,
            stop_agent,
            stop_all_agents,
            // M9.4 — git tracking. Every command resolves the workspace
            // first, so a vault nested in a larger repo scopes correctly.
            git_commands::git_workspace_info,
            git_commands::is_git_repo,
            git_commands::init_git_repo,
            git_commands::git_author_identity,
            git_commands::get_modified_files,
            git_commands::git_discard_file,
            git_commands::get_file_history,
            git_commands::get_file_diff,
            git_commands::get_file_diff_at_commit,
            git_commands::get_commit_diff,
            git_commands::get_vault_pulse,
            git_commands::get_last_commit_info,
            git_commands::git_commit,
            git_commands::git_has_pending_changes,
            git_commands::git_file_url,
            git_commands::git_remote_status,
            git_commands::git_pull,
            git_commands::git_push,
            git_commands::git_add_remote,
            git_commands::git_disconnect_remote,
            git_commands::git_clone,
            git_commands::get_conflict_files,
            git_commands::get_conflict_mode,
            git_commands::git_resolve_conflict,
            git_commands::git_commit_conflict_resolution,
            git_commands::git_abort_conflict,
            git_commands::git_provider_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
