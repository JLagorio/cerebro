//! Making commits, and the repository that holds them.

use std::path::Path;

use super::author;
use super::command;
use super::workspace::GitWorkspaceInfo;

/// What cerebro keeps out of a vault's git history.
///
/// Deliberately short. `views/*.yml`, `types/*.md`, and — above all —
/// `knowledge/` are content the user wants versioned. Ignoring the knowledge
/// bundle would defeat the whole reason git is here: the assistant writes
/// there unattended, and untracked writes cannot be reviewed or reverted.
///
/// `.cerebro/` is the opposite case and the reason this is per-entry rather
/// than one write-once block: connectors.json documents Authorization
/// headers and env API keys as ITS contents, and the Settings page promises
/// "your credentials never leave this vault". An automatic checkpoint that
/// commits it — and a sync that pushes it — would make that promise a lie.
const IGNORE_ENTRIES: &[&str] = &[".DS_Store", ".cerebro/"];

pub fn ensure_gitignore(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let missing: Vec<&str> = IGNORE_ENTRIES
        .iter()
        .copied()
        .filter(|entry| !existing.lines().any(|line| line.trim() == *entry))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut next = if existing.trim().is_empty() {
        "# Cerebro\n".to_string()
    } else {
        format!("{}\n", existing.trim_end())
    };
    for entry in missing {
        next.push_str(entry);
        next.push('\n');
    }
    std::fs::write(&path, next).map_err(|e| e.to_string())?;
    // A config already swept into the index keeps getting committed no
    // matter what .gitignore says — untrack it so the NEXT checkpoint stops
    // carrying it. Best-effort: not a repo yet, or nothing tracked, is fine.
    let _ = command::run_str(
        dir,
        &["rm", "-r", "--cached", "--ignore-unmatch", "-q", ".cerebro"],
    );
    Ok(())
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
    // Self-healing for vaults whose repo predates an entry (M13.3: the
    // .cerebro/ credential exclusion must reach EXISTING repos, and init is
    // the one moment this otherwise ran).
    ensure_gitignore(Path::new(&ws.vault_root))?;

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
    use std::path::PathBuf;

    /// A scratch directory for a test that will `git init`, stage and commit
    /// in it — and a hard refusal to hand back anything but a path under the
    /// system temp dir.
    ///
    /// TWICE these tests have written to the cerebro checkout instead: once
    /// taking out the M14 branch, once the M16 board branch, each time as a
    /// commit titled "old state" that deleted every tracked file. Both were
    /// recovered by hand. The proof it was this module is that the wipe left
    /// `.cerebro/connectors.json` holding exactly `{"servers":{}}` and a
    /// `.gitignore` of exactly `# Cerebro\n.DS_Store\n` — the two string
    /// literals below.
    ///
    /// So the FILE writes landed at the checkout root, not just the git
    /// commands, which means `dir` itself was wrong. Checking that git agrees
    /// about the repo root cannot catch that: ask a checkout where its root
    /// is and it will happily answer itself. Containment under `temp_dir()`
    /// is the check that does, and it has to run before the
    /// `remove_dir_all` below — that line, pointed at the checkout, deletes
    /// the working tree outright and its result is discarded.
    ///
    /// Both runs happened under `.husky/pre-push`, which invokes `cargo test`
    /// from the worktree root rather than from `src-tauri/` as AGENTS.md
    /// documents. Git hooks also run with a sanitized environment, so
    /// `TMPDIR` may be absent there in a way it never is in a shell.
    fn scratch_repo_dir(label: &str) -> PathBuf {
        // Canonicalize BEFORE joining: on macOS `temp_dir()` hands back
        // /var/folders/… which is a symlink to /private/var/folders/…, so
        // comparing a path built from one against the resolved form of the
        // other fails for every run and the guard would fire on itself.
        let base = std::fs::canonicalize(std::env::temp_dir())
            .expect("the system temp dir must exist and resolve");
        let dir = base.join(format!("cerebro-{label}-{}", std::process::id()));
        assert!(
            dir.starts_with(&base) && dir != base,
            "REFUSING to run a destructive git test in {dir:?}: it is not inside the \
             system temp dir {base:?}. This test removes the directory and then commits \
             in it, so a wrong path here rewrites a real repository."
        );
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Second belt: after `git init`, git must agree the repo root is our
    /// scratch dir and nothing above it.
    fn assert_isolated(dir: &Path) {
        let top = command::run_str(dir, &["rev-parse", "--show-toplevel"])
            .expect("the scratch repo must answer rev-parse --show-toplevel");
        let got = std::fs::canonicalize(top.trim()).expect("that toplevel must exist on disk");
        let want = std::fs::canonicalize(dir).expect("the scratch dir must exist on disk");
        assert_eq!(
            got, want,
            "REFUSING to stage or commit: git reports the repo root as {got:?}, but this \
             test's scratch repo is {want:?}."
        );
    }

    #[test]
    fn gitignore_is_written_once() {
        let dir = scratch_repo_dir("ignore");
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
    fn cerebro_config_is_ignored_and_untracked_even_in_existing_repos() {
        let dir = scratch_repo_dir("ignore3");
        std::fs::create_dir_all(dir.join(".cerebro")).unwrap();
        std::fs::write(dir.join(".cerebro/connectors.json"), "{\"servers\":{}}").unwrap();
        // A pre-M13.3 vault: repo exists, .gitignore already has .DS_Store
        // (the old early-return), and the config is already TRACKED.
        command::run_str(&dir, &["init"]).unwrap();
        // Before ANY staging or committing — see assert_isolated.
        assert_isolated(&dir);
        author::ensure_identity(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "# Cerebro\n.DS_Store\n").unwrap();
        command::run_str(&dir, &["add", "-A"]).unwrap();
        command::run_str(&dir, &["commit", "-m", "old state"]).unwrap();

        ensure_gitignore(&dir).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(content.contains(".cerebro/"));
        // Untracked from the index: the next commit no longer carries it.
        let tracked = command::run_str(&dir, &["ls-files", "--cached", ".cerebro"]).unwrap();
        assert!(
            tracked.trim().is_empty(),
            "credentials must leave the index: {tracked}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn appends_to_an_existing_gitignore() {
        let dir = scratch_repo_dir("ignore2");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        ensure_gitignore(&dir).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(content.contains("node_modules/"));
        assert!(content.contains(".DS_Store"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
