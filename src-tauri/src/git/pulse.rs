//! The vault's activity log.
//!
//! Commits with per-file add/modify/delete counts. This is the surface that
//! makes the assistant's unattended work legible — "the base edited 14 notes
//! overnight" becomes a list you can read and a diff you can revert — which
//! is what earns it a place under the no-idle-chrome rule.
//!
//! Three answers stay apart (M53.15): a vault that is not a repository
//! (`tracked: false`), a repository with nothing committed (`tracked: true`,
//! no commits), and a log that failed (`Err`). A commit whose file list could
//! not be read carries `changes: None`, never an empty list.

use serde::Serialize;

use super::command;
use super::history::{log_or_unborn, parse_log, GitCommit};
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PulseFile {
    pub path: String,
    pub status: String,
    pub title: String,
}

/// What one commit did inside the vault.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PulseChanges {
    pub files: Vec<PulseFile>,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub date: i64,
    /// `None` when the file list could not be read. An empty list would say
    /// the commit touched nothing, which nobody measured.
    pub changes: Option<PulseChanges>,
}

/// The vault's history, or the fact that it keeps none.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultPulse {
    /// False when the vault is not a git repository at all.
    pub tracked: bool,
    pub commits: Vec<PulseCommit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommitInfo {
    pub short_hash: String,
    pub message: String,
    pub date: i64,
}

/// A readable title for a file in a commit: the note's stem, humanized.
fn title_for(path: &str) -> String {
    let stem = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md");
    if stem.is_empty() {
        return path.to_string();
    }
    let mut out = String::new();
    for (i, word) in stem.split(['-', '_']).enumerate() {
        if word.is_empty() {
            continue;
        }
        if i > 0 {
            out.push(' ');
        }
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() {
        path.to_string()
    } else {
        out
    }
}

fn status_word(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        _ => "modified",
    }
}

/// Count one commit's `git show --name-status` listing.
///
/// A rename counts as a change and is filed under its new path (the last
/// field), and a path outside the vault is skipped: in a nested vault the
/// commit may also touch the rest of the repository.
fn tally(ws: &GitWorkspaceInfo, names: &str) -> PulseChanges {
    let mut changes = PulseChanges::default();
    for line in names.lines() {
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        let Some(path) = parts.next_back() else {
            continue;
        };
        if path.trim().is_empty() {
            continue;
        }
        let Some(vault_path) = ws.to_vault_relative(path) else {
            continue;
        };
        let first = code.chars().next().unwrap_or('M');
        match first {
            'A' => changes.added += 1,
            'D' => changes.deleted += 1,
            _ => changes.modified += 1,
        }
        changes.files.push(PulseFile {
            title: title_for(&vault_path),
            path: vault_path,
            status: status_word(first).to_string(),
        });
    }
    changes
}

pub fn vault_pulse(ws: &GitWorkspaceInfo, limit: usize) -> Result<VaultPulse, String> {
    if !ws.is_repo() {
        return Ok(VaultPulse {
            tracked: false,
            commits: vec![],
        });
    }
    let dir = ws.dir();
    let commits: Vec<GitCommit> = {
        let limit_arg = format!("-{limit}");
        let mut args: Vec<String> = vec![
            "log".into(),
            limit_arg,
            "--format=%H\x1f%h\x1f%an\x1f%at\x1f%s".into(),
        ];
        args.extend(ws.pathspec_args());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        parse_log(&log_or_unborn(&dir, &refs)?)
    };

    let mut out = Vec::with_capacity(commits.len());
    for c in commits {
        let mut args: Vec<String> = vec![
            "show".into(),
            "--name-status".into(),
            "--format=".into(),
            c.hash.clone(),
        ];
        args.extend(ws.pathspec_args());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        // A commit whose files we cannot list is still shown, with its files
        // unknown: an empty tally would claim it changed nothing.
        let changes = command::run_str(&dir, &refs)
            .ok()
            .map(|names| tally(ws, &names));

        out.push(PulseCommit {
            hash: c.hash,
            short_hash: c.short_hash,
            message: c.message,
            author: c.author,
            date: c.date,
            changes,
        });
    }
    Ok(VaultPulse {
        tracked: true,
        commits: out,
    })
}

pub fn last_commit(ws: &GitWorkspaceInfo) -> Result<Option<LastCommitInfo>, String> {
    if !ws.is_repo() {
        return Ok(None);
    }
    let out = command::run_str(&ws.dir(), &["log", "-1", "--format=%h\x1f%at\x1f%s"])
        // A repository with no commits yet is not an error.
        .unwrap_or_default();
    let mut parts = out.trim().split('\x1f');
    let (Some(short_hash), Some(date), Some(message)) = (parts.next(), parts.next(), parts.next())
    else {
        return Ok(None);
    };
    if short_hash.is_empty() {
        return Ok(None);
    }
    Ok(Some(LastCommitInfo {
        short_hash: short_hash.to_string(),
        message: message.to_string(),
        date: date.parse().unwrap_or(0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commit::tests::{assert_isolated, broken_branch_repo, scratch_repo_dir};
    use crate::git::workspace::{self, GitRootRelation};

    #[test]
    fn humanizes_a_note_stem() {
        assert_eq!(title_for("projects/atlas/items/fld-1.md"), "Fld 1");
        assert_eq!(
            title_for("knowledge/onboarding_drop_off.md"),
            "Onboarding Drop Off"
        );
    }

    #[test]
    fn falls_back_to_the_path_when_there_is_no_stem() {
        assert_eq!(title_for(".md"), ".md");
    }

    fn nested_vault() -> GitWorkspaceInfo {
        GitWorkspaceInfo {
            vault_root: "/repo/notes".into(),
            git_root: Some("/repo".into()),
            vault_pathspec: Some("notes".into()),
            git_root_relation: GitRootRelation::Parent,
            resolution_failure: None,
        }
    }

    #[test]
    fn tally_counts_each_status_and_keeps_to_the_vault() {
        let names = "\nA\tnotes/new-idea.md\nM\tnotes/plan.md\n\nD\tnotes/old.md\n\
                     R087\tnotes/draft.md\tnotes/final-plan.md\nM\tsrc/main.rs\nM\n";
        let changes = tally(&nested_vault(), names);
        assert_eq!(
            (changes.added, changes.modified, changes.deleted),
            (1, 2, 1)
        );
        let seen: Vec<(&str, &str)> = changes
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert_eq!(
            seen,
            [
                ("new-idea.md", "added"),
                ("plan.md", "modified"),
                ("old.md", "deleted"),
                ("final-plan.md", "renamed"),
            ]
        );
        assert_eq!(changes.files[3].title, "Final Plan");
    }

    #[test]
    fn a_vault_that_is_not_a_repository_is_untracked() {
        let pulse = vault_pulse(&workspace::resolve("/definitely/not/here"), 50).unwrap();
        assert!(!pulse.tracked);
        assert!(pulse.commits.is_empty());
    }

    /// `git log` exits 128 before the first commit. That is a new vault, so
    /// History must say "nothing committed yet", not that it could not read.
    #[test]
    fn an_unborn_repository_is_tracked_with_nothing_committed() {
        let dir = scratch_repo_dir("pulse-unborn");
        std::fs::create_dir_all(&dir).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        assert_isolated(&dir);

        let pulse = vault_pulse(&workspace::resolve(&dir), 50).unwrap();
        assert!(pulse.tracked);
        assert!(pulse.commits.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `git log` exits 128 for a broken branch ref too, but there the vault's
    /// commits exist and cannot be read: History must say so, never "nothing
    /// committed yet".
    #[test]
    fn a_broken_branch_ref_is_a_failed_read_not_an_empty_history() {
        let dir = broken_branch_repo("pulse-broken", "garbage\n");
        let ws = workspace::resolve(&dir);
        assert!(ws.is_repo(), "a broken branch is still a repository");
        assert!(vault_pulse(&ws, 50).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The TypeScript mirror (`engine/git.ts`) reads these names. Unread files
    /// cross as `null`, which the UI renders as "files unknown".
    #[test]
    fn the_wire_shape_keeps_unknown_files_null() {
        let pulse = VaultPulse {
            tracked: true,
            commits: vec![PulseCommit {
                hash: "h".into(),
                short_hash: "s".into(),
                message: "m".into(),
                author: "a".into(),
                date: 1,
                changes: None,
            }],
        };
        let wire = serde_json::to_value(&pulse).unwrap();
        assert_eq!(wire["tracked"], true);
        assert_eq!(wire["commits"][0]["shortHash"], "s");
        assert!(wire["commits"][0]["changes"].is_null());
    }
}
