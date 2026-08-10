//! Tauri command surface for mounted roots (M30).
//!
//! Commands are `(async)` so filesystem and git work runs on the thread pool
//! rather than stalling the UI thread — listing a large directory or indexing a
//! repository is not instant.

use tauri::Manager;

use crate::roots::index::IndexedDoc;
use crate::roots::read::FileText;
use crate::roots::tree::DirEntry;
use crate::roots::{MountRefusal, Root};

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn root_path(app: &tauri::AppHandle, root_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = config_dir(app)?;
    crate::roots::find(&dir, root_id)
        .map(|r| std::path::PathBuf::from(r.path))
        .ok_or_else(|| format!("no mounted root with id {root_id}"))
}

#[tauri::command(async)]
pub fn list_roots(app: tauri::AppHandle) -> Result<Vec<Root>, String> {
    Ok(crate::roots::list(&config_dir(&app)?))
}

#[tauri::command(async)]
pub fn mount_root(app: tauri::AppHandle, path: String) -> Result<Root, MountRefusal> {
    let dir = config_dir(&app).map_err(|e| MountRefusal {
        code: "config_unavailable".into(),
        message: e,
    })?;
    crate::roots::mount(&dir, &path)
}

#[tauri::command(async)]
pub fn unmount_root(app: tauri::AppHandle, root_id: String) -> Result<(), String> {
    crate::roots::unmount(&config_dir(&app)?, &root_id)
}

#[tauri::command(async)]
pub fn list_dir(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    crate::roots::tree::list_dir(&root_path(&app, &root_id)?, &path)
}

#[tauri::command(async)]
pub fn read_file_text(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<FileText, String> {
    Ok(crate::roots::read::read_file_text(
        &root_path(&app, &root_id)?,
        &path,
    ))
}

#[tauri::command(async)]
pub fn index_root_markdown(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<Vec<IndexedDoc>, String> {
    crate::roots::index::index_root(&root_path(&app, &root_id)?, &root_id)
}
