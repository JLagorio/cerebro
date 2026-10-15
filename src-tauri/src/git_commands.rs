//! Tauri command surface for git (M9.4).
//!
//! Every command resolves the workspace first, so a vault nested inside a
//! larger repository is scoped correctly rather than reporting its parent's
//! files. Commands are `(async)` so their process spawning runs on the thread
//! pool instead of stalling the UI thread — a `git log` over a large history
//! is not instant.

use crate::git;
use crate::git::conflict::{ConflictMode, Resolution};
use crate::git::history::{FileAt, FileCommit};
use crate::git::provider::GitProviderStatus;
use crate::git::pulse::{LastCommitInfo, VaultPulse};
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

/// Throw away a file's uncommitted changes, as a person's write (M58.1, Q2):
/// its receipt is minted from the bundle guard, so a file in `knowledge/` is
/// refused like every human door refuses it. A discard there would leave the
/// ledger ahead of the file; Review and Restore are the bundle's own paths.
#[tauri::command(async)]
pub fn git_discard_file(vault: String, path: String) -> Result<(), String> {
    let by = crate::vault::receipt::WriteReceipt::ipc(crate::knowledge::guard_human_write(&path)?);
    git::status::discard_file(&git::workspace_for(&vault), &path, &by)
}

/// One page's history, each commit with the path the page had in it, its
/// parent and what it did to the page (M58.4).
#[tauri::command(async)]
pub fn get_file_history(vault: String, path: String) -> Result<Vec<FileCommit>, String> {
    git::history::file_history(&git::workspace_for(&vault), &path, HISTORY_LIMIT)
}

/// One file as a commit held it, byte for byte, or that it was absent,
/// binary or too large there (M58.4): what the version lens reads.
#[tauri::command(async)]
pub fn get_file_at_commit(vault: String, path: String, commit: String) -> Result<FileAt, String> {
    git::history::file_at_commit(&git::workspace_for(&vault), &path, &commit)
}

/// Restore a page to one version from its history, as the person (M58.4).
/// Whether a running run wrote the page is read from runtime.db through a
/// read-only handle; a database that will not open or answer reads as
/// "could not tell", which restores with one warning.
#[tauri::command(async)]
pub fn restore_note_version(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    commit: String,
) -> Result<git::restore::Restored, String> {
    let data = crate::config_dir(&app).ok();
    restore_note_version_in(&vault, &path, &commit, data.as_deref())
}

/// `restore_note_version` against the runtime database in `data`, if any.
/// The note target is judged before the receipt is minted, so a path
/// `save_note` refuses as no note is refused in those words first, as the
/// mock refuses it (note-targets.json); then the bundle guard mints it.
pub(crate) fn restore_note_version_in(
    vault: &str,
    path: &str,
    commit: &str,
    data: Option<&std::path::Path>,
) -> Result<git::restore::Restored, String> {
    let root = std::path::Path::new(vault);
    crate::vault::write::restore_target(root, path)?;
    let by = crate::vault::receipt::WriteReceipt::ipc(crate::knowledge::guard_human_write(path)?);
    git::restore::restore_version(root, path, commit, &by, |rel| {
        let ro = crate::runtime::ReadOnly::open(data?).ok()?;
        let landed = crate::vault::write::landing_path(root, rel)?;
        crate::runtime::fleet::live_run_wrote(
            &ro,
            &crate::runtime::scope::derive_vault_id(root),
            &landed,
        )
        .ok()
    })
}

#[tauri::command(async)]
pub fn get_file_diff(vault: String, path: String) -> Result<String, String> {
    git::history::file_diff(&git::workspace_for(&vault), &path)
}

/// What one commit did to one file. `previous_path`, the path the file had
/// before the commit, reads a rename as one (M58.4).
#[tauri::command(async)]
pub fn get_file_diff_at_commit(
    vault: String,
    path: String,
    commit: String,
    previous_path: Option<String>,
) -> Result<String, String> {
    git::history::file_diff_at_commit(
        &git::workspace_for(&vault),
        &path,
        &commit,
        previous_path.as_deref(),
    )
}

/// One file's patch in one commit, capped at 2 MiB, or that it is binary:
/// what a turn's changeset loads when a file is expanded (M58.3).
#[tauri::command(async)]
pub fn get_file_patch(
    vault: String,
    path: String,
    commit: String,
) -> Result<git::history::FilePatch, String> {
    git::history::file_patch_at_commit(&git::workspace_for(&vault), &path, &commit)
}

#[tauri::command(async)]
pub fn get_commit_diff(vault: String, commit: String) -> Result<String, String> {
    git::history::commit_diff(&git::workspace_for(&vault), &commit)
}

#[tauri::command(async)]
pub fn get_vault_pulse(vault: String) -> Result<VaultPulse, String> {
    git::pulse::vault_pulse(&git::workspace_for(&vault), HISTORY_LIMIT)
}

#[tauri::command(async)]
pub fn get_last_commit_info(vault: String) -> Result<Option<LastCommitInfo>, String> {
    git::pulse::last_commit(&git::workspace_for(&vault))
}

/// Commit every change but the paths a live run owns (M58.3): those commit
/// with their run when it ends.
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
