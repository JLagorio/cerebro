//! What has changed.

use serde::Serialize;

use super::command;
use super::workspace::GitWorkspaceInfo;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifiedFile {
    /// Vault-relative.
    pub path: String,
    pub status: FileStatus,
    pub staged: bool,
}

/// Parse one `git status --porcelain=v1 -z` record.
///
/// The two status characters are index-then-worktree. `??` is untracked, and
/// any of the `U`/`AA`/`DD` combinations mean a conflict — those must not be
/// reported as ordinary modifications, or the Changes surface would offer to
/// commit a half-merged file.
fn classify(code: &str) -> (FileStatus, bool) {
    let bytes: Vec<char> = code.chars().collect();
    let index = bytes.first().copied().unwrap_or(' ');
    let tree = bytes.get(1).copied().unwrap_or(' ');

    if code == "??" {
        return (FileStatus::Untracked, false);
    }
    if index == 'U' || tree == 'U' || (index == 'A' && tree == 'A') || (index == 'D' && tree == 'D')
    {
        return (FileStatus::Conflicted, false);
    }

    let staged = index != ' ' && index != '?';
    let effective = if staged { index } else { tree };
    let status = match effective {
        'A' => FileStatus::Added,
        'D' => FileStatus::Deleted,
        'R' => FileStatus::Renamed,
        _ => FileStatus::Modified,
    };
    (status, staged)
}

pub fn modified_files(ws: &GitWorkspaceInfo) -> Result<Vec<ModifiedFile>, String> {
    if !ws.is_repo() {
        return Ok(vec![]);
    }
    let dir = ws.dir();
    let mut args: Vec<String> = vec![
        "status".into(),
        "--porcelain=v1".into(),
        "-z".into(),
        "--untracked-files=all".into(),
    ];
    args.extend(ws.pathspec_args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = command::run_str(&dir, &refs)?;

    let mut files = Vec::new();
    // -z output is NUL-separated. A rename record is followed by a second NUL
    // field holding the old path, which we skip.
    let mut parts = out.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let (code, path) = record.split_at(2);
        let path = path.trim_start();
        let (status, staged) = classify(code);
        if status == FileStatus::Renamed {
            // Consume the old-path field that follows a rename.
            parts.next();
        }
        let Some(vault_relative) = ws.to_vault_relative(path) else {
            continue;
        };
        files.push(ModifiedFile {
            path: vault_relative,
            status,
            staged,
        });
    }
    Ok(files)
}

/// Throw away a file's uncommitted changes. Untracked files are removed;
/// tracked ones are restored from HEAD.
pub fn discard_file(ws: &GitWorkspaceInfo, vault_relative: &str) -> Result<(), String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let safe = command::safe_relative(vault_relative)?;
    let dir = ws.dir();
    let git_path = ws.to_git_relative(&safe);

    let tracked = command::succeeds(&dir, &["ls-files", "--error-unmatch", &git_path]);
    if tracked {
        command::run_str(&dir, &["checkout", "HEAD", "--", &git_path])?;
    } else {
        command::run_str(&dir, &["clean", "-f", "--", &git_path])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_is_its_own_status() {
        assert_eq!(classify("??").0, FileStatus::Untracked);
    }

    #[test]
    fn conflicts_are_never_reported_as_modifications() {
        for code in ["UU", "AA", "DD", "AU", "UD"] {
            assert_eq!(classify(code).0, FileStatus::Conflicted, "code {code}");
        }
    }

    #[test]
    fn index_column_wins_and_marks_staged() {
        assert_eq!(classify("M "), (FileStatus::Modified, true));
        assert_eq!(classify(" M"), (FileStatus::Modified, false));
        assert_eq!(classify("A "), (FileStatus::Added, true));
        assert_eq!(classify(" D"), (FileStatus::Deleted, false));
    }
}
