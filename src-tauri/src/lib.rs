pub mod agent;
pub mod app_config;
pub mod knowledge;
pub mod mcp;
pub mod vault;

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use vault::entry::Entry;
use vault::write::ViewYaml;
use vault::watcher::WatcherState;

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
// agent's MCP tools call vault::write directly and are not gated here.
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
fn save_view(vault: String, id: String, yaml: String, folder: Option<String>) -> Result<(), String> {
    vault::write::save_view(Path::new(&vault), &id, &yaml, folder.as_deref())
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
    vault::write::delete_note(Path::new(&vault), &path)
}

#[tauri::command(async)]
fn list_folders(vault: String) -> Result<Vec<String>, String> {
    vault::scan::list_folders(Path::new(&vault))
}

// --- Local agent + MCP (M6) ------------------------------------------------

#[tauri::command(async)]
fn check_agent() -> agent::AgentStatus {
    agent::status()
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

#[tauri::command(async)]
fn run_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    vault: String,
    request: agent::AgentRequest,
) -> Result<(), String> {
    let dir = config_dir(&app)?;
    agent::stream(app.clone(), state.inner(), Path::new(&vault), request, &dir)
}

#[tauri::command(async)]
fn stop_agent(state: tauri::State<'_, agent::AgentState>) -> Result<(), String> {
    state.stop()
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
            create_folder,
            rename_note,
            delete_note,
            list_folders,
            start_watcher,
            check_agent,
            start_mcp,
            run_agent,
            stop_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
