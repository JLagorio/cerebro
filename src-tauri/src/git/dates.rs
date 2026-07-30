//! Real authorship dates.
//!
//! `Entry.createdAt` / `modifiedAt` come from filesystem metadata, which is
//! wrong the moment a vault is cloned or a branch is checked out — every file
//! looks touched at the same instant. When the vault is a repository, git
//! knows better: the first commit that added a path, and the last that
//! touched it.
//!
//! Applied as an OVERRIDE during scan rather than a replacement, because an
//! untracked file has no git dates and its filesystem mtime is the truth.

use std::collections::HashMap;

use super::command;
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Copy)]
pub struct GitDates {
    /// Unix seconds of the commit that added the path.
    pub created: i64,
    /// Unix seconds of the most recent commit touching it.
    pub modified: i64,
}

/// One pass over the whole log, not one call per file.
///
/// A vault of a few thousand notes would otherwise mean a few thousand git
/// invocations at every scan. `--name-only` over the full history walked
/// newest-first gives both dates in a single traversal: the first sighting of
/// a path is its latest modification, the last sighting is its creation.
pub fn all_file_dates(ws: &GitWorkspaceInfo) -> HashMap<String, GitDates> {
    let mut out: HashMap<String, GitDates> = HashMap::new();
    if !ws.is_repo() {
        return out;
    }

    let mut args: Vec<String> = vec![
        "log".into(),
        "--name-only".into(),
        "--format=\x01%at".into(),
        "--no-renames".into(),
    ];
    args.extend(ws.pathspec_args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let Ok(log) = command::run_str(&ws.dir(), &refs) else {
        return out;
    };

    let mut current: i64 = 0;
    for line in log.lines() {
        if let Some(stamp) = line.strip_prefix('\x01') {
            current = stamp.trim().parse().unwrap_or(current);
            continue;
        }
        let path = line.trim();
        if path.is_empty() {
            continue;
        }
        let Some(vault_path) = ws.to_vault_relative(path) else {
            continue;
        };
        out.entry(vault_path)
            .and_modify(|d| {
                // Walking newest-first: every later sighting is older, so it
                // is the better candidate for "created".
                if current < d.created {
                    d.created = current;
                }
            })
            .or_insert(GitDates {
                created: current,
                modified: current,
            });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::workspace::GitRootRelation;

    fn not_a_repo() -> GitWorkspaceInfo {
        GitWorkspaceInfo {
            vault_root: "/v".into(),
            git_root: None,
            vault_pathspec: None,
            git_root_relation: GitRootRelation::None,
            resolution_failure: None,
        }
    }

    #[test]
    fn a_non_repo_reports_no_dates_rather_than_failing() {
        assert!(all_file_dates(&not_a_repo()).is_empty());
    }
}
