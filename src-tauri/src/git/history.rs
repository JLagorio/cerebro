//! Commits and diffs.

use serde::Serialize;

use super::command;
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    /// Unix seconds.
    pub date: i64,
}

/// Field separator for `--format`. A literal control character, because a
/// commit message can contain anything printable — including whatever
/// punctuation we might have picked instead.
const SEP: &str = "\x1f";
const FORMAT: &str = "--format=%H\x1f%h\x1f%an\x1f%at\x1f%s";

pub fn parse_log(out: &str) -> Vec<GitCommit> {
    out.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split(SEP);
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let date = parts.next()?.parse::<i64>().ok()?;
            // A subject can itself contain the separator only if git emitted
            // it, which it does not — but rejoin defensively rather than
            // truncate someone's message.
            let message = parts.collect::<Vec<_>>().join(SEP);
            Some(GitCommit {
                hash,
                short_hash,
                message,
                author,
                date,
            })
        })
        .collect()
}

pub fn file_history(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    limit: usize,
) -> Result<Vec<GitCommit>, String> {
    if !ws.is_repo() {
        return Ok(vec![]);
    }
    let safe = command::safe_relative(vault_relative)?;
    let git_path = ws.to_git_relative(&safe);
    let limit_arg = format!("-{limit}");
    // --follow so a renamed note keeps its history; that rename is exactly
    // the moment you most want to look backwards.
    let out = command::run_str(
        &ws.dir(),
        &["log", &limit_arg, "--follow", FORMAT, "--", &git_path],
    )?;
    Ok(parse_log(&out))
}

/// Working-tree diff for one file. Untracked files have nothing to diff
/// against, so they report as wholly added.
pub fn file_diff(ws: &GitWorkspaceInfo, vault_relative: &str) -> Result<String, String> {
    if !ws.is_repo() {
        return Ok(String::new());
    }
    let safe = command::safe_relative(vault_relative)?;
    let dir = ws.dir();
    let git_path = ws.to_git_relative(&safe);

    if !command::succeeds(&dir, &["ls-files", "--error-unmatch", &git_path]) {
        // /dev/null against the file gives a real unified diff for something
        // git does not track yet.
        return command::run(
            &dir,
            &["diff", "--no-index", "--", "/dev/null", &git_path],
        )
        .or_else(|f| {
            // --no-index exits 1 when there ARE differences, which is the
            // normal case here — the stdout it produced is the diff.
            if f.code == Some(1) {
                Ok(String::new())
            } else {
                Err(f.message())
            }
        })
        .or_else(|_: String| Ok(String::new()));
    }

    command::run_str(&dir, &["diff", "HEAD", "--", &git_path])
}

/// What one commit did to one file.
pub fn file_diff_at_commit(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    commit: &str,
) -> Result<String, String> {
    if !ws.is_repo() {
        return Ok(String::new());
    }
    let safe = command::safe_relative(vault_relative)?;
    let commit = safe_rev(commit)?;
    let git_path = ws.to_git_relative(&safe);
    let range = format!("{commit}^!");
    command::run_str(&ws.dir(), &["diff", &range, "--", &git_path])
        // A root commit has no parent, so `^!` fails; show it against the
        // empty tree instead of reporting an error.
        .or_else(|_| {
            command::run_str(&ws.dir(), &["show", "--format=", &commit, "--", &git_path])
        })
}

/// Everything one commit changed.
pub fn commit_diff(ws: &GitWorkspaceInfo, commit: &str) -> Result<String, String> {
    if !ws.is_repo() {
        return Ok(String::new());
    }
    let commit = safe_rev(commit)?;
    let mut args: Vec<String> = vec!["show".into(), "--format=".into(), commit];
    args.extend(ws.pathspec_args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    command::run_str(&ws.dir(), &refs)
}

/// Revisions reach the command line, so they get the same flag guard paths do.
pub fn safe_rev(rev: &str) -> Result<String, String> {
    let trimmed = rev.trim();
    if trimmed.is_empty() {
        return Err("empty revision".into());
    }
    if trimmed.starts_with('-') {
        return Err(format!("refusing revision that looks like a flag: {rev}"));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.' | '^' | '~' | '@'))
    {
        return Err(format!("refusing unexpected revision: {rev}"));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_log_line() {
        let out = "abc123\x1fabc\x1fAna\x1f1750000000\x1fFix the thing\n";
        let commits = parse_log(out);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].short_hash, "abc");
        assert_eq!(commits[0].author, "Ana");
        assert_eq!(commits[0].date, 1_750_000_000);
        assert_eq!(commits[0].message, "Fix the thing");
    }

    #[test]
    fn keeps_a_message_containing_the_separator() {
        let out = "h\x1fs\x1fA\x1f1\x1fone\x1ftwo\n";
        assert_eq!(parse_log(out)[0].message, "one\x1ftwo");
    }

    #[test]
    fn skips_malformed_lines_rather_than_failing() {
        assert!(parse_log("garbage\n\n").is_empty());
    }

    #[test]
    fn revisions_reject_flags_and_junk() {
        assert!(safe_rev("--upload-pack=evil").is_err());
        assert!(safe_rev("a b").is_err());
        assert!(safe_rev("HEAD~2").is_ok());
        assert!(safe_rev("abc123").is_ok());
    }
}
