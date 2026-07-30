//! The vault's activity log.
//!
//! Commits with per-file add/modify/delete counts. This is the surface that
//! makes the assistant's unattended work legible — "the base edited 14 notes
//! overnight" becomes a list you can read and a diff you can revert — which
//! is what earns it a place under the no-idle-chrome rule.

use serde::Serialize;

use super::command;
use super::history::{parse_log, GitCommit};
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseFile {
    pub path: String,
    pub status: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub date: i64,
    pub files: Vec<PulseFile>,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
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

pub fn vault_pulse(ws: &GitWorkspaceInfo, limit: usize) -> Result<Vec<PulseCommit>, String> {
    if !ws.is_repo() {
        return Ok(vec![]);
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
        parse_log(&command::run_str(&dir, &refs)?)
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
        // A commit whose files we cannot list is still worth showing.
        let names = command::run_str(&dir, &refs).unwrap_or_default();

        let mut files = Vec::new();
        let (mut added, mut modified, mut deleted) = (0usize, 0usize, 0usize);
        for line in names.lines() {
            let mut parts = line.split('\t');
            let Some(code) = parts.next() else { continue };
            let Some(path) = parts.last() else { continue };
            if path.trim().is_empty() {
                continue;
            }
            let Some(vault_path) = ws.to_vault_relative(path) else {
                continue;
            };
            let first = code.chars().next().unwrap_or('M');
            match first {
                'A' => added += 1,
                'D' => deleted += 1,
                _ => modified += 1,
            }
            files.push(PulseFile {
                title: title_for(&vault_path),
                path: vault_path,
                status: status_word(first).to_string(),
            });
        }

        out.push(PulseCommit {
            hash: c.hash,
            short_hash: c.short_hash,
            message: c.message,
            author: c.author,
            date: c.date,
            files,
            added,
            modified,
            deleted,
        });
    }
    Ok(out)
}

pub fn last_commit(ws: &GitWorkspaceInfo) -> Result<Option<LastCommitInfo>, String> {
    if !ws.is_repo() {
        return Ok(None);
    }
    let out = command::run_str(&ws.dir(), &["log", "-1", "--format=%h\x1f%at\x1f%s"])
        // A repository with no commits yet is not an error.
        .unwrap_or_default();
    let mut parts = out.trim().split('\x1f');
    let (Some(short_hash), Some(date), Some(message)) =
        (parts.next(), parts.next(), parts.next())
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

    #[test]
    fn humanizes_a_note_stem() {
        assert_eq!(title_for("projects/atlas/items/fld-1.md"), "Fld 1");
        assert_eq!(title_for("knowledge/onboarding_drop_off.md"), "Onboarding Drop Off");
    }

    #[test]
    fn falls_back_to_the_path_when_there_is_no_stem() {
        assert_eq!(title_for(".md"), ".md");
    }
}
