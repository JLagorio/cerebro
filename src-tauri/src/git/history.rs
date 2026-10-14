//! Commits and diffs.

use std::path::Path;

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

/// Did this `git log` fail because HEAD names a branch nobody has committed
/// to yet?
///
/// git exits 128 for that, and 128 again for a branch ref a crash left
/// empty, NUL-filled or garbage, while the vault's commits sit right there.
/// `rev-parse --verify HEAD` cannot tell the two apart: both leave HEAD
/// unresolved. The log's own message can, because git words them apart —
/// "your current branch 'main' does not have any commits yet" against "your
/// current branch appears to be broken". The text is stable because
/// `git_command` forces `LC_ALL=C`, and it must be a whole `fatal:` line, so
/// a path echoed by an inherited `GIT_TRACE` cannot pass for it.
fn is_unborn(failure: &command::GitFailure) -> bool {
    failure.code == Some(128)
        && failure.stderr.lines().any(|line| {
            line.starts_with("fatal: your current branch '")
                && line.trim_end().ends_with("' does not have any commits yet")
        })
}

/// Run a `git log`, reading an unborn HEAD as an empty history (M53.15).
///
/// A repository nobody has committed to is a new vault, not a failed read.
/// Every other failure, a broken branch ref included, returns the log's own
/// error. The failure git already returned is what gets classified, so no
/// path runs a second process.
pub(crate) fn log_or_unborn(dir: &Path, args: &[&str]) -> Result<String, String> {
    command::run(dir, args).or_else(|failure| {
        if is_unborn(&failure) {
            Ok(String::new())
        } else {
            Err(failure.message())
        }
    })
}

/// One note's commits. A vault that is not a repository has none, and so
/// does a repository nobody has committed to; a log that fails is an error.
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
    let out = log_or_unborn(
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
        return command::run(&dir, &["diff", "--no-index", "--", "/dev/null", &git_path])
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
        .or_else(|_| command::run_str(&ws.dir(), &["show", "--format=", &commit, "--", &git_path]))
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
    use crate::git::commit::tests::{assert_isolated, broken_branch_repo, scratch_repo_dir};
    use crate::git::workspace;

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

    /// A vault nobody has committed to: `git log` exits 128 there, and that
    /// is an empty history, not a failed read (M53.15).
    #[test]
    fn an_unborn_head_is_an_empty_history() {
        let dir = scratch_repo_dir("history-unborn");
        std::fs::create_dir_all(&dir).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        assert_isolated(&dir);

        let ws = workspace::resolve(&dir);
        assert!(ws.is_repo());
        assert_eq!(file_history(&ws, "note.md", 50).unwrap().len(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Only git's own unborn line reads as unborn: not the broken-branch line
    /// that shares its exit code, not an exit 1, and not a traced path that
    /// happens to carry the same words.
    #[test]
    fn only_the_unborn_fatal_line_reads_as_unborn() {
        let failure = |code, stderr: &str| command::GitFailure {
            stderr: stderr.into(),
            code,
        };
        let unborn = "fatal: your current branch 'main' does not have any commits yet\n";
        assert!(is_unborn(&failure(Some(128), unborn)));
        assert!(!is_unborn(&failure(Some(1), unborn)));
        assert!(!is_unborn(&failure(
            Some(128),
            "fatal: your current branch appears to be broken\n"
        )));
        assert!(!is_unborn(&failure(
            Some(128),
            "00:00:00.000000 git.c:476 trace: built-in: git log -- 'x/' does not have any \
             commits yet\nfatal: your current branch appears to be broken\n"
        )));
    }

    /// A branch ref a crash left broken leaves HEAD as unresolved as an unborn
    /// branch does, but the commits are still there and nobody can list them:
    /// a failed read, never an empty history (M53.15).
    #[test]
    fn a_broken_branch_ref_is_a_failed_read() {
        let junk = ["garbage\n", "\0\0\0\0\0\0\0\0", ""];
        for (i, junk) in junk.into_iter().enumerate() {
            let dir = broken_branch_repo(&format!("history-broken-{i}"), junk);
            let ws = workspace::resolve(&dir);
            assert!(ws.is_repo(), "a broken branch is still a repository");
            let err = file_history(&ws, "note.md", 50)
                .expect_err("a broken branch ref must not read as an empty history");
            assert!(err.contains("broken"), "the log's own error, got {err:?}");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// Reading unborn as empty must not launder corruption either: a HEAD
    /// naming an object that is not there is a failed read, not a new vault.
    #[test]
    fn a_head_at_a_missing_object_is_a_failed_read() {
        let dir = scratch_repo_dir("history-badhead");
        std::fs::create_dir_all(&dir).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        // Before touching anything under .git — see assert_isolated.
        assert_isolated(&dir);
        let format = command::run_str(&dir, &["rev-parse", "--show-object-format"])
            .unwrap_or_else(|_| "sha1".into());
        let hex_len = if format.trim() == "sha256" { 64 } else { 40 };
        let head = dir.join(".git").join("HEAD");
        assert!(
            head.is_file(),
            "the scratch repo must have its own HEAD at {head:?}"
        );
        std::fs::write(&head, format!("{}\n", "e".repeat(hex_len))).unwrap();

        let ws = workspace::resolve(&dir);
        assert!(ws.is_repo(), "a detached HEAD is still a repository");
        assert!(file_history(&ws, "note.md", 50).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
