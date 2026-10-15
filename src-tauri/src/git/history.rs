//! Commits and diffs, and one file as a commit held it (M58.4).

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

/// What one commit did to one file (M58.4), from git's own name-status
/// letter: A, M, D, R, C or T.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

impl FileChange {
    fn from_status(status: &str) -> Option<Self> {
        match status.chars().next()? {
            'A' => Some(Self::Added),
            'M' => Some(Self::Modified),
            'D' => Some(Self::Deleted),
            'R' => Some(Self::Renamed),
            'C' => Some(Self::Copied),
            'T' => Some(Self::TypeChanged),
            _ => None,
        }
    }
}

/// One commit in one file's history (M58.4), with the path the file had in
/// it. The fields are written out rather than flattened from [`GitCommit`]:
/// M54.3's contract scan reads one level of fields and refuses a flatten.
///
/// - `parent`: the commit's first parent, `None` for a root commit.
/// - `previous_at`: when the path was committed before this one, in the
///   runtime database's spelling (RFC 3339, milliseconds, `Z`): where "who
///   else wrote it" starts for a run's commit. `None` when this commit
///   created the page.
/// - `path_at`: the vault-relative path the file had in this commit, `None`
///   when it lay outside the vault then (a nested vault's history).
/// - `previous_path`: the path it had before, for a rename or a copy.
/// - `change`: what the commit did to it, `None` for a merge, which carries
///   no name-status line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    /// Unix seconds.
    pub date: i64,
    pub parent: Option<String>,
    pub previous_at: Option<String>,
    pub path_at: Option<String>,
    pub previous_path: Option<String>,
    pub change: Option<FileChange>,
}

/// One file's history, `-z` framed: a header per commit, then its
/// name-status line, NUL-separated.
const FOLLOW_FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s";

/// A commit header in [`FOLLOW_FORMAT`]'s output, starting with `\x1e`.
const RECORD: char = '\x1e';

/// Unix seconds in the runtime database's spelling, so a commit time and a
/// `vault_writes` time compare as strings.
fn stored_time(seconds: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Split `git log --follow -M --name-status -z` output in
/// [`FOLLOW_FORMAT`] into rows (M58.4).
///
/// The output is NUL-separated. A token starting with `\x1e` is a header of
/// six fields (a subject holding the separator is rejoined, never cut); the
/// next token, less its leading newline, is the name-status letter, and R
/// and C take two paths (from, to) where the rest take one. A merge carries
/// no status line, and keeps the path the file had just before the newer
/// row; the newest row starts at `asked`, the git path the log was asked
/// for. `to_vault` turns a git path into a vault-relative one, or `None`
/// outside the vault. Each row's `previous_at` is the next row's date; the
/// last row's is left `None` for the caller to read.
pub fn parse_follow_log(
    out: &str,
    asked: &str,
    to_vault: impl Fn(&str) -> Option<String>,
) -> Vec<FileCommit> {
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut rows: Vec<FileCommit> = Vec::new();
    // The git path the file had just before the newest row read so far.
    let mut current = asked.to_string();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i].trim_start_matches('\n');
        i += 1;
        let Some(header) = token.strip_prefix(RECORD) else {
            continue;
        };
        let mut fields = header.split(SEP);
        let (Some(hash), Some(short_hash), Some(author), Some(date), Some(parents)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        let Ok(date) = date.parse::<i64>() else {
            continue;
        };
        let message = fields.collect::<Vec<_>>().join(SEP);
        let parent = parents
            .split(' ')
            .find(|p| !p.is_empty())
            .map(str::to_string);
        // The status line, when the next token is one and not a header.
        let status = tokens
            .get(i)
            .map(|t| t.trim_start_matches('\n'))
            .filter(|t| !t.is_empty() && !t.starts_with(RECORD));
        let (change, path_at, previous_path) = match status {
            Some(letter) => {
                i += 1;
                let change = FileChange::from_status(letter);
                if matches!(change, Some(FileChange::Renamed | FileChange::Copied)) {
                    let from = tokens.get(i).copied().unwrap_or_default().to_string();
                    let to = tokens.get(i + 1).copied().unwrap_or_default().to_string();
                    i += 2;
                    (change, to, Some(from))
                } else {
                    let path = tokens.get(i).copied().unwrap_or_default().to_string();
                    i += 1;
                    (change, path, None)
                }
            }
            None => (None, current.clone(), None),
        };
        current = previous_path.clone().unwrap_or_else(|| path_at.clone());
        rows.push(FileCommit {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            message,
            author: author.to_string(),
            date,
            parent,
            previous_at: None,
            path_at: to_vault(&path_at),
            previous_path: previous_path.as_deref().and_then(&to_vault),
            change,
        });
    }
    for n in 0..rows.len().saturating_sub(1) {
        if rows[n].change != Some(FileChange::Added) {
            rows[n].previous_at = stored_time(rows[n + 1].date);
        }
    }
    rows
}

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

/// One note's commits, each with the path the note had in it, its parent,
/// what it did to the note and when the note was committed before (M58.4).
/// A vault that is not a repository has none, and so does a repository
/// nobody has committed to; a log that fails is an error.
///
/// `--follow -M` so a renamed note keeps its history, each version under its
/// own name: that rename is exactly the moment you most want to look
/// backwards. `--literal-pathspecs` so `a*.md` names one file. The oldest
/// row's `previous_at` comes from one more `git log -1` on its parent, when
/// the limit cut the history there.
pub fn file_history(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    limit: usize,
) -> Result<Vec<FileCommit>, String> {
    if !ws.is_repo() {
        return Ok(vec![]);
    }
    let safe = command::safe_relative(vault_relative)?;
    let git_path = ws.to_git_relative(&safe);
    let limit_arg = format!("-{limit}");
    let dir = ws.dir();
    let out = log_or_unborn(
        &dir,
        &[
            "--literal-pathspecs",
            "log",
            &limit_arg,
            "--follow",
            "-M",
            "--name-status",
            "-z",
            FOLLOW_FORMAT,
            "--",
            &git_path,
        ],
    )?;
    let mut rows = parse_follow_log(&out, &git_path, |p| ws.to_vault_relative(p));
    if let Some(last) = rows.last_mut() {
        if last.change != Some(FileChange::Added) {
            if let Some(parent) = last.parent.clone() {
                let before = last
                    .previous_path
                    .clone()
                    .or_else(|| last.path_at.clone())
                    .map(|p| ws.to_git_relative(&p));
                if let Some(before) = before {
                    last.previous_at = command::run_str(
                        &dir,
                        &[
                            "--literal-pathspecs",
                            "log",
                            "-1",
                            "--format=%at",
                            &parent,
                            "--",
                            &before,
                        ],
                    )
                    .ok()
                    .and_then(|at| at.trim().parse::<i64>().ok())
                    .and_then(stored_time);
                }
            }
        }
    }
    Ok(rows)
}

/// The largest version a lens or a Restore reads whole: 8 MiB.
pub const VERSION_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

/// One file as a commit held it (M58.4). `absent`: the commit has no file at
/// that path. `binary`: not a regular file (a symlink, a submodule) or not
/// UTF-8. `too_large`: over [`VERSION_LIMIT_BYTES`], with its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileAt {
    Text { text: String },
    Absent,
    Binary,
    TooLarge { bytes: u64 },
}

/// `vault_relative` at `rev`, byte for byte. `ls-tree -l` names the object,
/// its mode and its size first, so a symlink, a submodule or a file too large
/// is told without reading it; a blob is then read raw (`command::run_bytes`),
/// so a BOM or a CRLF comes back as it was committed.
pub fn file_at_commit(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    rev: &str,
) -> Result<FileAt, String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let safe = command::safe_relative(vault_relative)?;
    let rev = safe_rev(rev)?;
    let git_path = ws.to_git_relative(&safe);
    let dir = ws.dir();
    let listing = command::run_str(
        &dir,
        &[
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            "-l",
            "--full-tree",
            &rev,
            "--",
            &git_path,
        ],
    )?;
    let Some(entry) = listing.split('\0').find(|e| !e.is_empty()) else {
        return Ok(FileAt::Absent);
    };
    // `<mode> <type> <object> <size>\t<path>`, the size padded.
    let meta = entry.split('\t').next().unwrap_or_default();
    let mut fields = meta.split_whitespace();
    let (Some(mode), Some(kind), Some(object), Some(size)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Err(format!("unreadable tree entry for {safe}"));
    };
    if kind != "blob" || mode == "120000" {
        return Ok(FileAt::Binary);
    }
    let bytes: u64 = size
        .parse()
        .map_err(|_| format!("unreadable size for {safe}"))?;
    if bytes > VERSION_LIMIT_BYTES {
        return Ok(FileAt::TooLarge { bytes });
    }
    let blob = command::run_bytes(&dir, &["cat-file", "blob", object]).map_err(|e| e.message())?;
    Ok(match String::from_utf8(blob) {
        Ok(text) => FileAt::Text { text },
        Err(_) => FileAt::Binary,
    })
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

/// What one commit did to one file, a rename read as one (M58.4): with
/// `previous`, the path the file had before the commit, both paths are in
/// the pathspec and `-M` pairs them, so the lens shows a move as a move and
/// not as a deletion beside an addition. Callers pass the row's `path_at`.
pub fn file_diff_at_commit(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    commit: &str,
    previous: Option<&str>,
) -> Result<String, String> {
    if !ws.is_repo() {
        return Ok(String::new());
    }
    let safe = command::safe_relative(vault_relative)?;
    let commit = safe_rev(commit)?;
    let mut paths = vec![ws.to_git_relative(&safe)];
    if let Some(previous) = previous.filter(|p| *p != safe) {
        paths.push(ws.to_git_relative(&command::safe_relative(previous)?));
    }
    let dir = ws.dir();
    let parent = format!("{commit}^");
    if !command::succeeds(&dir, &["rev-parse", "--verify", "-q", &parent]) {
        // A root commit has no parent, and `diff <root>^!` answers nothing
        // at all, as if the commit changed nothing: show it against the
        // empty tree instead.
        let mut show: Vec<&str> = vec![
            "--literal-pathspecs",
            "show",
            "-M",
            "--format=",
            &commit,
            "--",
        ];
        show.extend(paths.iter().map(String::as_str));
        return command::run_str(&dir, &show);
    }
    let range = format!("{commit}^!");
    let mut diff: Vec<&str> = vec!["--literal-pathspecs", "diff", "-M", &range, "--"];
    diff.extend(paths.iter().map(String::as_str));
    command::run_str(&dir, &diff)
}

/// The most of one file's patch a turn's footer is handed (M58.3): 2 MiB.
pub const PATCH_LIMIT_BYTES: usize = 2 * 1024 * 1024;

/// One file's patch in one commit, as a turn's changeset expands it (M58.3).
/// `truncated` says the text stops at [`PATCH_LIMIT_BYTES`]; a binary file
/// carries no text, and `binary` says why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePatch {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

/// What `commit` did to `vault_relative`, capped at [`PATCH_LIMIT_BYTES`] on a
/// character boundary. A binary change is told by git's own numstat (`-` for
/// both counts) and carries no text.
pub fn file_patch_at_commit(
    ws: &GitWorkspaceInfo,
    vault_relative: &str,
    commit: &str,
) -> Result<FilePatch, String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let safe = command::safe_relative(vault_relative)?;
    let rev = safe_rev(commit)?;
    let git_path = ws.to_git_relative(&safe);
    let numstat = command::run_str(
        &ws.dir(),
        &["show", "--numstat", "--format=", &rev, "--", &git_path],
    )?;
    if numstat.lines().any(|line| line.starts_with("-\t-\t")) {
        return Ok(FilePatch {
            text: String::new(),
            truncated: false,
            binary: true,
        });
    }
    let whole = file_diff_at_commit(ws, &safe, &rev, None)?;
    if whole.len() <= PATCH_LIMIT_BYTES {
        return Ok(FilePatch {
            text: whole,
            truncated: false,
            binary: false,
        });
    }
    let mut cut = PATCH_LIMIT_BYTES;
    while !whole.is_char_boundary(cut) {
        cut -= 1;
    }
    Ok(FilePatch {
        text: whole[..cut].to_string(),
        truncated: true,
        binary: false,
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
    use crate::git::commit::tests::{assert_isolated, broken_branch_repo, scratch_repo_dir};
    use crate::git::workspace;
    use std::path::PathBuf;

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

    /// A committed scratch repository holding `files` (path, bytes), and the
    /// commit's full hash.
    fn committed(label: &str, files: &[(&str, &[u8])]) -> (PathBuf, String) {
        let dir = scratch_repo_dir(label);
        std::fs::create_dir_all(&dir).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        assert_isolated(&dir);
        command::run_str(&dir, &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&dir, &["config", "user.name", "t"]).unwrap();
        command::run_str(&dir, &["commit", "--allow-empty", "-m", "base"]).unwrap();
        for (path, bytes) in files {
            std::fs::write(dir.join(path), bytes).unwrap();
        }
        command::run_str(&dir, &["add", "-A"]).unwrap();
        command::run_str(&dir, &["commit", "-m", "files"]).unwrap();
        let hash = command::run_str(&dir, &["rev-parse", "HEAD"]).unwrap();
        (dir, hash.trim().to_string())
    }

    #[test]
    fn a_file_patch_stops_at_two_mib_and_says_so() {
        let line = "a line of a long note that keeps going past the cap\n";
        let big = line.repeat(PATCH_LIMIT_BYTES / line.len() + 100);
        let (dir, hash) = committed("m58-patch-cap", &[("big.md", big.as_bytes())]);
        let ws = workspace::resolve(&dir);
        let patch = file_patch_at_commit(&ws, "big.md", &hash).unwrap();
        assert!(patch.truncated);
        assert!(!patch.binary);
        assert_eq!(patch.text.len(), PATCH_LIMIT_BYTES);
        assert!(patch.text.contains("+a line of a long note"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_binary_patch_says_binary() {
        let (dir, hash) = committed(
            "m58-patch-binary",
            &[
                ("image.bin", &b"\x89PNG\0\0\x01\x02"[..]),
                ("note.md", &b"# Note\n"[..]),
            ],
        );
        let ws = workspace::resolve(&dir);
        let binary = file_patch_at_commit(&ws, "image.bin", &hash).unwrap();
        assert_eq!(
            binary,
            FilePatch {
                text: String::new(),
                truncated: false,
                binary: true
            }
        );
        let text = file_patch_at_commit(&ws, "note.md", &hash).unwrap();
        assert!(!text.binary && !text.truncated);
        assert!(text.text.contains("+# Note"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An initialised scratch repository with its own identity.
    fn scratch(label: &str) -> PathBuf {
        let dir = scratch_repo_dir(label);
        std::fs::create_dir_all(&dir).unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        assert_isolated(&dir);
        command::run_str(&dir, &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&dir, &["config", "user.name", "t"]).unwrap();
        dir
    }

    /// Stage everything and commit it; the full hash.
    fn commit_everything(dir: &Path, message: &str) -> String {
        command::run_str(dir, &["add", "-A"]).unwrap();
        command::run_str(dir, &["commit", "-m", message]).unwrap();
        command::run_str(dir, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string()
    }

    /// Lines enough that a rename with one edit stays a rename to `-M`.
    const BODY: &str = "# Plan\n\none\ntwo\nthree\nfour\nfive\nsix\n";

    // M58.4: the `-z` framing, read from canned bytes written as escapes
    // (CV-13). A rename takes two paths and moves the path back for the rows
    // below it; a merge has no status line and keeps that path; a subject
    // holding the separator stays whole; a path outside the vault has no
    // vault path; only a commit that created the page has no previous time.
    #[test]
    fn parse_follow_log_reads_renames_merges_and_paths_outside_the_vault() {
        let h = |c: char| c.to_string().repeat(40);
        let out = format!(
            "\x1e{a}\x1faaaaaaa\x1fAna\x1f1700000300\x1f{m}\x1fedit: one\x1ftwo\0\nM\0v/b.md\0\
             \x1e{m}\x1fmmmmmmm\x1fAna\x1f1700000200\x1f{r} {s}\x1fMerge side\0\
             \x1e{r}\x1frrrrrrr\x1fBo\x1f1700000100\x1f{c}\x1fmove\0\nR091\0out/a.md\0v/b.md\0\
             \x1e{c}\x1fccccccc\x1fBo\x1f1700000000\x1f\x1fcreate\0\nA\0out/a.md\0",
            a = h('a'),
            m = h('m'),
            r = h('r'),
            s = h('s'),
            c = h('c'),
        );
        let rows = parse_follow_log(&out, "v/b.md", |p| p.strip_prefix("v/").map(str::to_string));
        assert_eq!(rows.len(), 4);
        assert_eq!(
            rows[0].message, "edit: one\x1ftwo",
            "the subject stays whole"
        );
        assert_eq!(rows[0].change, Some(FileChange::Modified));
        assert_eq!(rows[0].path_at.as_deref(), Some("b.md"));
        assert_eq!(rows[0].parent, Some(h('m')));
        assert_eq!(rows[1].change, None, "a merge has no status line");
        assert_eq!(
            rows[1].path_at.as_deref(),
            Some("b.md"),
            "and keeps the newer path"
        );
        assert_eq!(rows[1].parent, Some(h('r')), "its first parent");
        assert_eq!(rows[2].change, Some(FileChange::Renamed));
        assert_eq!(rows[2].path_at.as_deref(), Some("b.md"));
        assert_eq!(
            rows[2].previous_path, None,
            "out/a.md lay outside the vault"
        );
        assert_eq!(rows[3].change, Some(FileChange::Added));
        assert_eq!(
            rows[3].path_at, None,
            "a version outside the vault has no vault path"
        );
        assert_eq!(rows[3].parent, None, "a root commit has no parent");
        assert_eq!(
            rows[0].previous_at.as_deref(),
            Some("2023-11-14T22:16:40.000Z")
        );
        assert_eq!(
            rows[2].previous_at.as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(
            rows[3].previous_at, None,
            "the commit that created the page"
        );

        // In a vault at the repository root, the rename's old path is a
        // vault path too.
        let rows = parse_follow_log(&out.replace("v/", ""), "b.md", |p| Some(p.to_string()));
        assert_eq!(rows[2].previous_path.as_deref(), Some("out/a.md"));
        assert_eq!(rows[3].path_at.as_deref(), Some("out/a.md"));
    }

    #[test]
    fn file_history_names_the_path_each_commit_had() {
        let dir = scratch("m58-history-paths");
        std::fs::write(dir.join("a.md"), BODY).unwrap();
        let created = commit_everything(&dir, "create a");
        command::run_str(&dir, &["mv", "a.md", "b.md"]).unwrap();
        std::fs::write(dir.join("b.md"), format!("{BODY}seven\n")).unwrap();
        let moved = commit_everything(&dir, "move to b");
        std::fs::write(dir.join("b.md"), format!("{BODY}seven\neight\n")).unwrap();
        let edited = commit_everything(&dir, "edit b");

        let ws = workspace::resolve(&dir);
        let rows = file_history(&ws, "b.md", 50).unwrap();
        let seen: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.hash.clone(),
                    r.change,
                    r.path_at.clone(),
                    r.previous_path.clone(),
                    r.parent.clone(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                (
                    edited.clone(),
                    Some(FileChange::Modified),
                    Some("b.md".into()),
                    None,
                    Some(moved.clone()),
                ),
                (
                    moved.clone(),
                    Some(FileChange::Renamed),
                    Some("b.md".into()),
                    Some("a.md".into()),
                    Some(created.clone()),
                ),
                (
                    created,
                    Some(FileChange::Added),
                    Some("a.md".into()),
                    None,
                    None
                ),
            ]
        );
        assert_eq!(rows[0].previous_at, stored_time(rows[1].date));
        assert_eq!(rows[1].previous_at, stored_time(rows[2].date));
        assert_eq!(rows[2].previous_at, None);

        // Cut at one row: the oldest shown reads its previous time from its
        // parent, under the path it had there.
        let cut = file_history(&ws, "b.md", 2).unwrap();
        assert_eq!(cut.len(), 2);
        assert_eq!(cut[1].previous_at, stored_time(rows[2].date));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_at_commit_keeps_bytes_and_tells_absent_from_binary() {
        let dir = scratch("m58-file-at");
        std::fs::write(dir.join("other.md"), "# Other\n").unwrap();
        let before = commit_everything(&dir, "before");
        let windows = "\u{feff}---\r\ntitle: Plan\r\n---\r\n\r\n# Plan\r\n";
        std::fs::write(dir.join("plan.md"), windows).unwrap();
        std::fs::write(dir.join("bad.md"), b"# Bad \xff\xfe\n").unwrap();
        std::os::unix::fs::symlink("plan.md", dir.join("link.md")).unwrap();
        let after = commit_everything(&dir, "after");

        let ws = workspace::resolve(&dir);
        assert_eq!(
            file_at_commit(&ws, "plan.md", &after).unwrap(),
            FileAt::Text {
                text: windows.to_string()
            },
            "a BOM and CRLF come back byte for byte"
        );
        assert_eq!(
            file_at_commit(&ws, "plan.md", &before).unwrap(),
            FileAt::Absent
        );
        assert_eq!(
            file_at_commit(&ws, "bad.md", &after).unwrap(),
            FileAt::Binary
        );
        assert_eq!(
            file_at_commit(&ws, "link.md", &after).unwrap(),
            FileAt::Binary
        );
        assert!(file_at_commit(&ws, "plan.md", "--output=x").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_with_glob_characters_reads_literally() {
        let dir = scratch("m58-glob");
        std::fs::write(dir.join("a*.md"), "# Star\n").unwrap();
        std::fs::write(dir.join("ab.md"), "# Ab\n").unwrap();
        let both = commit_everything(&dir, "both");
        std::fs::write(dir.join("ab.md"), "# Ab\n\nAgain.\n").unwrap();
        commit_everything(&dir, "only ab");

        let ws = workspace::resolve(&dir);
        let rows = file_history(&ws, "a*.md", 50).unwrap();
        assert_eq!(rows.len(), 1, "a*.md names one file, not ab.md");
        assert_eq!(rows[0].hash, both);
        assert_eq!(
            file_at_commit(&ws, "a*.md", "HEAD").unwrap(),
            FileAt::Text {
                text: "# Star\n".into()
            }
        );
        let diff = file_diff_at_commit(&ws, "a*.md", &both, None).unwrap();
        assert!(diff.contains("+# Star") && !diff.contains("# Ab"), "{diff}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_diff_at_commit_shows_a_rename_as_one() {
        let dir = scratch("m58-diff-rename");
        std::fs::write(dir.join("a.md"), BODY).unwrap();
        commit_everything(&dir, "create a");
        command::run_str(&dir, &["mv", "a.md", "b.md"]).unwrap();
        std::fs::write(dir.join("b.md"), format!("{BODY}seven\n")).unwrap();
        let moved = commit_everything(&dir, "move to b");

        let ws = workspace::resolve(&dir);
        let diff = file_diff_at_commit(&ws, "b.md", &moved, Some("a.md")).unwrap();
        assert!(diff.contains("rename from a.md"), "{diff}");
        assert!(diff.contains("rename to b.md"), "{diff}");
        assert!(diff.contains("+seven"), "{diff}");
        assert!(!diff.contains("deleted file"), "{diff}");
        std::fs::remove_dir_all(&dir).ok();
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
