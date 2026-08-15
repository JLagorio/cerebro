//! Root-scoped git reads (M32.8). M30 mounted the roots and probed
//! `caps.git`; this is the first consumer. READ-ONLY by design in this
//! phase — mutations arrive in M32.11 with typed outcomes, and work-repo
//! commit/push is a policy-layer milestone, not this one.
//!
//! Every command goes through `workspace()`, so the capability gate is not
//! something an individual command can forget to apply. Refusals are typed
//! values the caller READS — the documented exemption to the store-layer
//! never-throw rule, exactly as M30's mount flow works.

use tauri::Manager;

use crate::git;
use crate::git::pulse::PulseCommit;
use crate::git::remote::GitRemoteStatus;
use crate::git::status::ModifiedFile;
use crate::git::workspace::GitWorkspaceInfo;
use crate::roots::RootGitRefusal;

fn workspace(app: &tauri::AppHandle, root_id: &str) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| RootGitRefusal::new("config_unavailable", e.to_string()))?;
    crate::roots::git_workspace(&dir, root_id)
}

#[tauri::command(async)]
pub fn root_git_workspace_info(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    workspace(&app, &root_id)
}

#[tauri::command(async)]
pub fn root_git_remote_status(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<GitRemoteStatus, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::remote::remote_status(&ws).map_err(|e| RootGitRefusal::new("git_error", e))
}

#[tauri::command(async)]
pub fn root_git_modified_files(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<Vec<ModifiedFile>, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::status::modified_files(&ws).map_err(|e| RootGitRefusal::new("git_error", e))
}

#[tauri::command(async)]
pub fn root_git_pulse(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<Vec<PulseCommit>, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::pulse::vault_pulse(&ws, 50).map_err(|e| RootGitRefusal::new("git_error", e))
}

/// The MUTATION gate (M32.11) — stricter than `workspace()`: it also refuses
/// a root mounted inside a larger repository.
fn sync_workspace(
    app: &tauri::AppHandle,
    root_id: &str,
) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| RootGitRefusal::new("config_unavailable", e.to_string()))?;
    crate::roots::git_workspace_for_sync(&dir, root_id)
}

/// Fetch is the safe half of sync: it updates remote-tracking refs and
/// touches no file in the working tree.
#[tauri::command(async)]
pub fn root_git_fetch(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<crate::git::remote::RemoteResult, RootGitRefusal> {
    Ok(git::remote::fetch(&sync_workspace(&app, &root_id)?))
}

/// Fast-forward only: Cerebro can never CREATE a conflict in a repository it
/// does not own. A pull that would need a merge comes back `rejected` and the
/// user resolves it in their own tooling.
#[tauri::command(async)]
pub fn root_git_pull_ff(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<crate::git::remote::RemoteResult, RootGitRefusal> {
    Ok(git::remote::pull_ff(&sync_workspace(&app, &root_id)?))
}

#[tauri::command(async)]
pub fn root_git_file_url(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<Option<String>, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    Ok(git::file_url(&ws, &path))
}
