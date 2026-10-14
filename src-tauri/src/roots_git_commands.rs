//! Root-scoped git (M32.8, M32.11). M30 mounted the roots and probed
//! `caps.git`; this is its consumer: five reads, plus fetch and a
//! fast-forward-only pull, each outcome typed. Nothing here commits, pushes or
//! merges in a mounted repository — work-repo writes are a policy-layer
//! milestone, not this one.
//!
//! Every read goes through `workspace()` and every mutation through the
//! stricter `sync_workspace()`, so the capability gate is not something an
//! individual command can forget to apply. Both find `roots.json` through
//! `app_config::app_dir`, the directory the mount commands write it to.
//! Refusals are typed values the caller READS — the documented exemption to
//! the store-layer never-throw rule, exactly as M30's mount flow works.

use std::path::PathBuf;

use crate::git;
use crate::git::pulse::VaultPulse;
use crate::git::remote::{GitRemoteStatus, RemoteResult};
use crate::git::status::ModifiedFile;
use crate::git::workspace::GitWorkspaceInfo;
use crate::roots::RootGitRefusal;

/// The directory holding `roots.json`. It is `app_config::app_dir`, as in
/// `roots_commands`: a dev build keeps its roots under `dev/<checkout>`, so
/// reading the bundle's own config directory instead would find none of them
/// and refuse every root with `no_such_root`.
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, RootGitRefusal> {
    crate::app_config::app_dir(app).map_err(|e| RootGitRefusal::new("config_unavailable", e))
}

fn workspace(app: &tauri::AppHandle, root_id: &str) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    crate::roots::git_workspace(&config_dir(app)?, root_id)
}

/// The MUTATION gate (M32.11) — stricter than `workspace()`: it also refuses
/// a root mounted inside a larger repository.
fn sync_workspace(
    app: &tauri::AppHandle,
    root_id: &str,
) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    crate::roots::git_workspace_for_sync(&config_dir(app)?, root_id)
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

/// The root's recent commits. The gate opens only for a repository, so the
/// answer is always `tracked: true`; a log that failed is `git_error`.
#[tauri::command(async)]
pub fn root_git_pulse(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<VaultPulse, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::pulse::vault_pulse(&ws, 50).map_err(|e| RootGitRefusal::new("git_error", e))
}

/// Fetch is the safe half of sync: it updates remote-tracking refs and
/// touches no file in the working tree.
#[tauri::command(async)]
pub fn root_git_fetch(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<RemoteResult, RootGitRefusal> {
    Ok(git::remote::fetch(&sync_workspace(&app, &root_id)?))
}

/// Fast-forward only: Cerebro can never CREATE a conflict in a repository it
/// does not own. A pull that would need a merge comes back `rejected` and the
/// user resolves it in their own tooling.
#[tauri::command(async)]
pub fn root_git_pull_ff(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<RemoteResult, RootGitRefusal> {
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
