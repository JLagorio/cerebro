//! Resolving a conflicted merge or rebase.
//!
//! The lowest-frequency surface in the git port, and the one it would be
//! worst to leave out: a pull that lands in conflict puts the vault in a
//! state the app created, and an app that cannot get you out of it has
//! trapped you in its own half-finished operation.

use serde::Serialize;

use super::command;
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictMode {
    Merge,
    Rebase,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    /// Keep what is in this vault.
    Ours,
    /// Keep what came from the remote.
    Theirs,
}

fn git_dir(ws: &GitWorkspaceInfo) -> Option<std::path::PathBuf> {
    let out = command::run_str(&ws.dir(), &["rev-parse", "--git-dir"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = std::path::PathBuf::from(trimmed);
    Some(if path.is_absolute() {
        path
    } else {
        ws.dir().join(path)
    })
}

pub fn mode(ws: &GitWorkspaceInfo) -> ConflictMode {
    let Some(dir) = git_dir(ws) else {
        return ConflictMode::None;
    };
    // A rebase in progress leaves one of these directories behind; a merge
    // leaves MERGE_HEAD. They need different commands to finish, so the
    // resolution flow has to know which one it is in.
    if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        return ConflictMode::Rebase;
    }
    if dir.join("MERGE_HEAD").exists() {
        return ConflictMode::Merge;
    }
    ConflictMode::None
}

pub fn files(ws: &GitWorkspaceInfo) -> Vec<String> {
    super::remote::conflict_files(ws)
}

/// Take one side of one conflicted file.
///
/// During a REBASE the sides are swapped relative to what the user means:
/// git replays your commits onto theirs, so `--ours` is the upstream branch
/// and `--theirs` is your work. Mapping the user's intent here rather than
/// exposing git's naming is the difference between resolving a conflict and
/// silently discarding your own edits.
pub fn resolve(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    keep: Resolution,
) -> Result<(), String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let safe = command::safe_relative(vault_relative)?;
    let dir = ws.dir();
    let git_path = ws.to_git_relative(&safe);

    let rebasing = mode(ws) == ConflictMode::Rebase;
    let flag = match (keep, rebasing) {
        (Resolution::Ours, false) | (Resolution::Theirs, true) => "--ours",
        (Resolution::Theirs, false) | (Resolution::Ours, true) => "--theirs",
    };

    command::run_str(&dir, &["checkout", flag, "--", &git_path])?;
    command::run_str(&dir, &["add", "--", &git_path])?;
    Ok(())
}

/// Finish the operation once nothing is left conflicted.
pub fn commit_resolution(ws: &GitWorkspaceInfo) -> Result<String, String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let remaining = files(ws);
    if !remaining.is_empty() {
        return Err(format!(
            "{} file{} still conflicted",
            remaining.len(),
            if remaining.len() == 1 { "" } else { "s" }
        ));
    }
    let dir = ws.dir();
    match mode(ws) {
        ConflictMode::Rebase => {
            command::run_str(&dir, &["rebase", "--continue"])?;
        }
        ConflictMode::Merge => {
            // --no-edit: the merge message git prepared is correct, and there
            // is no editor to open in a GUI app.
            command::run_str(&dir, &["commit", "--no-edit"])?;
        }
        ConflictMode::None => return Err("nothing to resolve".into()),
    }
    Ok(command::run_str(&dir, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string())
}

/// Back out of a conflicted operation entirely.
pub fn abort(ws: &GitWorkspaceInfo) -> Result<(), String> {
    let dir = ws.dir();
    match mode(ws) {
        ConflictMode::Rebase => command::run_str(&dir, &["rebase", "--abort"]).map(|_| ()),
        ConflictMode::Merge => command::run_str(&dir, &["merge", "--abort"]).map(|_| ()),
        ConflictMode::None => Ok(()),
    }
}
