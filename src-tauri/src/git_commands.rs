//! Tauri command surface for git (M9.4).
//!
//! Every command resolves the workspace first, so a vault nested inside a
//! larger repository is scoped correctly rather than reporting its parent's
//! files. Commands are `(async)` so their process spawning runs on the thread
//! pool instead of stalling the UI thread — a `git log` over a large history
//! is not instant.

use crate::git;
use crate::git::conflict::{ConflictMode, Resolution};
use crate::git::history::GitCommit;
use crate::git::provider::GitProviderStatus;
use crate::git::pulse::{LastCommitInfo, PulseCommit};
use crate::git::remote::{GitRemoteStatus, RemoteResult};
use crate::git::status::ModifiedFile;
use crate::git::workspace::GitWorkspaceInfo;

/// Default page size for history and pulse. Enough to fill a panel without
/// walking an entire multi-year log on every open.
const HISTORY_LIMIT: usize = 50;

#[tauri::command(async)]
pub fn git_workspace_info(vault: String) -> GitWorkspaceInfo {
    git::workspace_for(&vault)
}

#[tauri::command(async)]
pub fn is_git_repo(vault: String) -> bool {
    git::workspace_for(&vault).is_repo()
}

#[tauri::command(async)]
pub fn init_git_repo(vault: String) -> Result<(), String> {
    git::commit::init_repo(std::path::Path::new(&vault))
}

#[tauri::command(async)]
pub fn git_author_identity(vault: String) -> git::author::GitAuthorIdentity {
    git::author::identity(&git::workspace_for(&vault).dir())
}

#[tauri::command(async)]
pub fn get_modified_files(vault: String) -> Result<Vec<ModifiedFile>, String> {
    git::status::modified_files(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_discard_file(vault: String, path: String) -> Result<(), String> {
    git::status::discard_file(&git::workspace_for(&vault), &path)
}

#[tauri::command(async)]
pub fn get_file_history(vault: String, path: String) -> Result<Vec<GitCommit>, String> {
    git::history::file_history(&git::workspace_for(&vault), &path, HISTORY_LIMIT)
}

#[tauri::command(async)]
pub fn get_file_diff(vault: String, path: String) -> Result<String, String> {
    git::history::file_diff(&git::workspace_for(&vault), &path)
}

#[tauri::command(async)]
pub fn get_file_diff_at_commit(
    vault: String,
    path: String,
    commit: String,
) -> Result<String, String> {
    git::history::file_diff_at_commit(&git::workspace_for(&vault), &path, &commit)
}

#[tauri::command(async)]
pub fn get_commit_diff(vault: String, commit: String) -> Result<String, String> {
    git::history::commit_diff(&git::workspace_for(&vault), &commit)
}

#[tauri::command(async)]
pub fn get_vault_pulse(vault: String) -> Result<Vec<PulseCommit>, String> {
    git::pulse::vault_pulse(&git::workspace_for(&vault), HISTORY_LIMIT)
}

#[tauri::command(async)]
pub fn get_last_commit_info(vault: String) -> Result<Option<LastCommitInfo>, String> {
    git::pulse::last_commit(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_commit(vault: String, message: String) -> Result<Option<String>, String> {
    git::commit::commit_all(&git::workspace_for(&vault), &message)
}

#[tauri::command(async)]
pub fn git_has_pending_changes(vault: String) -> Result<bool, String> {
    git::commit::has_pending_changes(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_file_url(vault: String, path: String) -> Option<String> {
    git::file_url(&git::workspace_for(&vault), &path)
}

#[tauri::command(async)]
pub fn git_remote_status(vault: String) -> Result<GitRemoteStatus, String> {
    git::remote::remote_status(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_pull(vault: String) -> RemoteResult {
    git::remote::pull(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_push(vault: String) -> RemoteResult {
    git::remote::push(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_add_remote(vault: String, url: String) -> RemoteResult {
    git::remote::add_remote(&git::workspace_for(&vault), &url)
}

#[tauri::command(async)]
pub fn git_disconnect_remote(vault: String) -> Result<(), String> {
    git::remote::disconnect_remotes(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_clone(url: String, destination: String) -> Result<String, String> {
    git::clone_repo(&url, &destination)
}

#[tauri::command(async)]
pub fn get_conflict_files(vault: String) -> Vec<String> {
    git::conflict::files(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn get_conflict_mode(vault: String) -> ConflictMode {
    git::conflict::mode(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_resolve_conflict(vault: String, path: String, keep: String) -> Result<(), String> {
    let resolution = match keep.as_str() {
        "ours" => Resolution::Ours,
        "theirs" => Resolution::Theirs,
        other => return Err(format!("unknown resolution: {other}")),
    };
    git::conflict::resolve(&git::workspace_for(&vault), &path, resolution)
}

#[tauri::command(async)]
pub fn git_commit_conflict_resolution(vault: String) -> Result<String, String> {
    git::conflict::commit_resolution(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_abort_conflict(vault: String) -> Result<(), String> {
    git::conflict::abort(&git::workspace_for(&vault))
}

#[tauri::command(async)]
pub fn git_provider_status() -> GitProviderStatus {
    git::provider::probe()
}
