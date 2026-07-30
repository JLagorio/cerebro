//! Making commits, and the repository that holds them.

use std::path::Path;

use super::author;
use super::command;
use super::workspace::GitWorkspaceInfo;

/// What cerebro adds to a fresh vault's .gitignore.
///
/// Deliberately short. `views/*.yml`, `types/*.md`, and — above all —
/// `knowledge/` are content the user wants versioned. Ignoring the knowledge
/// bundle would defeat the whole reason git is here: the assistant writes
/// there unattended, and untracked writes cannot be reviewed or reverted.
const IGNORE_BLOCK: &str = "# Cerebro\n.DS_Store\n";

pub fn ensure_gitignore(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(".DS_Store") {
        return Ok(());
    }
    let next = if existing.trim().is_empty() {
        IGNORE_BLOCK.to_string()
    } else {
        format!("{}\n{IGNORE_BLOCK}", existing.trim_end())
    };
    std::fs::write(&path, next).map_err(|e| e.to_string())
}

/// Turn a vault into a repository, with an identity and a first commit.
pub fn init_repo(vault: &Path) -> Result<(), String> {
    if !vault.is_dir() {
        return Err("vault directory does not exist".into());
    }
    command::run_str(vault, &["init"])?;
    // Name the branch explicitly: git's default varies by version and config,
    // and remote-status reporting reads better with a known starting point.
    let _ = command::run_str(vault, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    ensure_gitignore(vault)?;
    author::ensure_identity(vault)?;
    command::run_str(vault, &["add", "-A"])?;
    // An empty vault has nothing to commit; that is not a failure.
    let _ = commit_all_in(vault, "Start tracking this vault with cerebro");
    Ok(())
}

fn commit_all_in(dir: &Path, message: &str) -> Result<String, String> {
    command::run_str(dir, &["add", "-A"])?;
    command::run_str(dir, &["commit", "-m", message])?;
    Ok(command::run_str(dir, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string())
}

/// True when there is anything to commit inside the vault's scope.
pub fn has_pending_changes(ws: &GitWorkspaceInfo) -> Result<bool, String> {
    Ok(!super::status::modified_files(ws)?.is_empty())
}

/// Stage everything in the vault's scope and commit it.
///
/// Returns Ok(None) when there was nothing to commit — an idle checkpoint
/// firing on a clean tree is normal, not an error.
pub fn commit_all(ws: &GitWorkspaceInfo, message: &str) -> Result<Option<String>, String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    if !has_pending_changes(ws)? {
        return Ok(None);
    }
    let dir = ws.dir();
    author::ensure_identity(&dir)?;

    let mut add: Vec<String> = vec!["add".into(), "-A".into()];
    // Scope the stage to the vault. In a nested vault, `git add -A` from the
    // repo root would sweep in the user's unrelated work.
    add.extend(ws.pathspec_args());
    let refs: Vec<&str> = add.iter().map(String::as_str).collect();
    command::run_str(&dir, &refs)?;

    // -- separates the message from any pathspec and stops a message
    // beginning with `-` being read as a flag.
    let mut args: Vec<String> = vec!["commit".into(), "-m".into(), message.to_string()];
    args.extend(ws.pathspec_args());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    command::run_str(&dir, &refs)?;

    Ok(Some(
        command::run_str(&dir, &["rev-parse", "--short", "HEAD"])?
            .trim()
            .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_is_written_once() {
        let dir = std::env::temp_dir().join(format!("cerebro-ignore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        ensure_gitignore(&dir).unwrap();
        let first = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        ensure_gitignore(&dir).unwrap();
        let second = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(first, second);
        assert!(first.contains(".DS_Store"));
        // The knowledge bundle must stay tracked — reviewability depends on it.
        assert!(!first.contains("knowledge"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn appends_to_an_existing_gitignore() {
        let dir = std::env::temp_dir().join(format!("cerebro-ignore2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        ensure_gitignore(&dir).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(content.contains("node_modules/"));
        assert!(content.contains(".DS_Store"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
