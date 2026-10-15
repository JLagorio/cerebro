//! Tauri command surface for mounted roots (M30).
//!
//! Commands are `(async)` so filesystem and git work runs on the thread pool
//! rather than stalling the UI thread — listing a large directory or reading a
//! file off a slow disk is not instant.

use crate::roots::read::FileText;
use crate::roots::tree::DirEntry;
use crate::roots::{MountRefusal, Root};

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    crate::app_config::app_dir(app)
}

fn root_path(app: &tauri::AppHandle, root_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = config_dir(app)?;
    crate::files::bytes::root_dir(&dir, root_id).map_err(|error| error.message)
}

#[tauri::command(async)]
pub fn file_thumbnail(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
    size: u32,
) -> Result<crate::files::thumbs::Thumbnail, String> {
    Ok(crate::files::thumbs::thumbnail(
        &config_dir(&app)?,
        &crate::app_config::cache_dir(&app)?,
        &root_id,
        &path,
        size,
    ))
}

#[tauri::command(async)]
pub fn probe_file(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<crate::files::bytes::Probe, crate::files::bytes::Refusal> {
    let config = config_dir(&app).map_err(|_| crate::files::bytes::refusal("no_such_root"))?;
    crate::files::bytes::probe(&config, &root_id, &path)
}

#[tauri::command(async)]
pub fn read_file_bytes(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<tauri::ipc::Response, crate::files::bytes::Refusal> {
    let config = config_dir(&app).map_err(|_| crate::files::bytes::refusal("no_such_root"))?;
    crate::files::bytes::read_for_ipc(&config, &root_id, &path).map(tauri::ipc::Response::new)
}

#[tauri::command(async)]
pub fn open_file_outside(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<crate::shell::file_actions::FileActionOutcome, crate::files::bytes::Refusal> {
    crate::shell::file_actions::act(
        &app,
        &root_id,
        &path,
        crate::shell::file_actions::Action::Open,
    )
}

#[tauri::command(async)]
pub fn reveal_file(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<crate::shell::file_actions::FileActionOutcome, crate::files::bytes::Refusal> {
    crate::shell::file_actions::act(
        &app,
        &root_id,
        &path,
        crate::shell::file_actions::Action::Reveal,
    )
}

#[tauri::command(async)]
pub fn quick_look_file(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<crate::shell::file_actions::FileActionOutcome, crate::files::bytes::Refusal> {
    crate::shell::file_actions::act(
        &app,
        &root_id,
        &path,
        crate::shell::file_actions::Action::Preview,
    )
}

#[tauri::command(async)]
pub fn save_file_copy(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<crate::shell::file_actions::FileActionOutcome, crate::files::bytes::Refusal> {
    crate::shell::file_actions::act(
        &app,
        &root_id,
        &path,
        crate::shell::file_actions::Action::Save,
    )
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

#[cfg(test)]
mod tests {
    #[test]
    fn read_file_text_reads_the_vault_through_root_zero() {
        let config = crate::vault::testutil::temp_vault("roots-vault-config");
        let vault = crate::vault::testutil::temp_vault("roots-vault-zero");
        crate::vault::testutil::write(&vault, "notes/a.md", "# A\n");
        crate::app_config::save(
            &config,
            &crate::app_config::AppConfig {
                last_vault: Some(vault.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let root = crate::files::bytes::root_dir(&config, "0").unwrap();
        assert_eq!(
            crate::roots::read::read_file_text(&root, "notes/a.md"),
            crate::roots::read::FileText::Text {
                content: "# A\n".into()
            }
        );
        let rows = crate::roots::tree::list_dir(&root, "notes").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "notes/a.md");
        let _ = std::fs::remove_dir_all(config);
        let _ = std::fs::remove_dir_all(vault);
    }
}
