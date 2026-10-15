//! Making commits, and the repository that holds them.
//!
//! **One index writer at a time per repository** (M58.3). A run's commit, a
//! checkpoint, a discard, a conflict's resolution and a pull each write
//! `index.lock`, and two at once failed one of them on it. Every index writer
//! here takes [`repo_lock`] first, keyed by the canonical repository dir, so a
//! vault nested in a larger repository shares its parent's lock as it shares
//! its index. Internal helpers (`commit_all_in`, `commit_paths_in`,
//! `ensure_gitignore`'s untrack) never take it again. Lock order: the repo
//! lock, then the run-ownership registry (`changeset`), then the runtime
//! sink. Reads take no lock: `GIT_OPTIONAL_LOCKS=0` keeps them off the index.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use super::author;
use super::command;
use super::workspace::GitWorkspaceInfo;

/// The lock every index writer in `dir`'s repository takes (M58.3):
/// process-global, keyed by the canonical directory. Take it with [`hold`],
/// or [`hold_within`] where waiting must end.
pub fn repo_lock(dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(key).or_default().clone()
}

/// Hold a repository's lock. A lock a panic poisoned still guards nothing
/// half-written (the index is git's), so it is taken all the same.
pub fn hold(lock: &Arc<Mutex<()>>) -> MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// [`hold`], giving up after `limit`: a run's commit waits about five seconds
/// for a checkpoint or a pull, then says History was busy.
pub fn hold_within(lock: &Arc<Mutex<()>>, limit: Duration) -> Option<MutexGuard<'_, ()>> {
    let deadline = Instant::now() + limit;
    loop {
        match lock.try_lock() {
            Ok(guard) => return Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

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
///
/// `.trash/` (M60.8, Q20) holds the pages a person deleted until Settings
/// restores them or the launch purge hands them to the OS Trash. A deleted
/// page was meant to go, and git already holds its history, so its Trash
/// copy never travels with the vault.
const IGNORE_ENTRIES: &[&str] = &[".DS_Store", ".cerebro/", ".trash/"];

/// The folders `ensure_gitignore` also untracks: an entry above that an
/// older checkpoint already swept into the index.
const UNTRACKED_DIRS: &[&str] = &[".cerebro", ".trash"];

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
    // A config (or a Trash) already swept into the index keeps getting
    // committed no matter what .gitignore says — untrack it so the NEXT
    // checkpoint stops carrying it. Best-effort: not a repo yet, or nothing
    // tracked, is fine.
    for tracked in UNTRACKED_DIRS {
        let _ = command::run_str(
            dir,
            &["rm", "-r", "--cached", "--ignore-unmatch", "-q", tracked],
        );
    }
    Ok(())
}

/// Turn a vault into a repository, with an identity and a first commit.
pub fn init_repo(vault: &Path) -> Result<(), String> {
    if !vault.is_dir() {
        return Err("vault directory does not exist".into());
    }
    let lock = repo_lock(vault);
    let _held = hold(&lock);
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

/// Commit every change in the vault's scope except the paths a live run
/// owns (M58.3, `changeset::owned_paths`): those commit with their run when
/// it ends. Under the repository's lock, through [`commit_paths_in`].
///
/// Returns Ok(None) when there was nothing to commit — an idle checkpoint
/// firing on a clean tree, or one where only a run's files changed, is
/// normal, not an error. The hash is the short one its callers show.
pub fn commit_all(ws: &GitWorkspaceInfo, message: &str) -> Result<Option<String>, String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    let dir = ws.dir();
    let lock = repo_lock(&dir);
    let _held = hold(&lock);
    if unowned_changes(ws)?.is_empty() {
        return Ok(None);
    }
    author::ensure_identity(&dir)?;
    // Self-healing for vaults whose repo predates an entry (M13.3: the
    // .cerebro/ credential exclusion must reach EXISTING repos, and init is
    // the one moment this otherwise ran). Its untrack is a change too, so the
    // list is read again after it.
    ensure_gitignore(Path::new(&ws.vault_root))?;
    let paths = unowned_changes(ws)?;
    let Some(full) = commit_paths_in(ws, &paths, message)? else {
        return Ok(None);
    };
    Ok(Some(
        command::run_str(&dir, &["rev-parse", "--short", &full])?
            .trim()
            .to_string(),
    ))
}

/// What a checkpoint may commit: every changed path in the vault's scope that
/// no live run owns and no conflict holds.
fn unowned_changes(ws: &GitWorkspaceInfo) -> Result<Vec<String>, String> {
    Ok(super::status::modified_files(ws)?
        .into_iter()
        .filter(|f| f.owner.is_none() && f.status != super::status::FileStatus::Conflicted)
        .map(|f| f.path)
        .collect())
}

/// Commit exactly `paths` (vault-relative), and nothing else the index or the
/// tree holds (M58.3): the one partial commit, under the repository's lock.
/// Returns the new commit's full hash, or None when none of them changed.
pub fn commit_paths(
    ws: &GitWorkspaceInfo,
    paths: &[String],
    message: &str,
) -> Result<Option<String>, String> {
    if !ws.is_repo() {
        return Err("this vault is not a git repository".into());
    }
    let lock = repo_lock(&ws.dir());
    let _held = hold(&lock);
    commit_paths_in(ws, paths, message)
}

/// [`commit_paths`] for a caller already holding the lock. Each step runs
/// under `command::LOCAL_TIMEOUT`: the identity, then status for those paths
/// (a rename brings its old path along), then `add -A` and `commit --only`
/// over the paths that changed, passed on stdin so a long list never meets
/// argv's limit, then `rev-parse HEAD`. `--literal-pathspecs` so a `*` or a
/// `:` in a file name is that file. `commit --only` takes each path's whole
/// diff from the tree, whatever was staged before, and leaves every other
/// staged change staged.
pub(crate) fn commit_paths_in(
    ws: &GitWorkspaceInfo,
    paths: &[String],
    message: &str,
) -> Result<Option<String>, String> {
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    let dir = ws.dir();
    let wanted: HashSet<String> = paths.iter().map(|p| ws.to_git_relative(p)).collect();
    let mut changed: BTreeSet<String> = BTreeSet::new();
    for record in super::status::records(ws)? {
        if record.conflicted {
            continue;
        }
        let hit = wanted.contains(&record.git_path)
            || record.orig.as_ref().is_some_and(|o| wanted.contains(o));
        if hit {
            changed.insert(record.git_path);
            changed.extend(record.orig);
        }
    }
    if changed.is_empty() {
        return Ok(None);
    }
    author::ensure_identity(&dir)?;
    let mut list = Vec::new();
    for path in &changed {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    let from_stdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
    let mut add = vec!["--literal-pathspecs", "add", "-A"];
    add.extend(from_stdin);
    command::run_bounded_with_input(&dir, &add, Some(&list), command::LOCAL_TIMEOUT)
        .map_err(|e| e.message())?;
    let mut commit = vec!["--literal-pathspecs", "commit", "--only", "-m", message];
    commit.extend(from_stdin);
    command::run_bounded_with_input(&dir, &commit, Some(&list), command::LOCAL_TIMEOUT)
        .map_err(|e| e.message())?;
    Ok(Some(
        command::run_bounded_str(&dir, &["rev-parse", "HEAD"], command::LOCAL_TIMEOUT)?
            .trim()
            .to_string(),
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A scratch directory for a test that will `git init`, stage and commit
    /// in it — and a hard refusal to hand back anything but a path under the
    /// system temp dir.
    ///
    /// Shared with the history and pulse tests (M53.15), so every git test
    /// that builds a repository goes through this one guard. The label must
    /// be unique across the crate: tests share a process id.
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
    pub(crate) fn scratch_repo_dir(label: &str) -> PathBuf {
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
    pub(crate) fn assert_isolated(dir: &Path) {
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

    /// A scratch repository whose current branch ref holds `junk`, the way a
    /// crash mid-write can leave it (M53.15). Nothing is committed: git
    /// reports the broken ref before it looks for a single commit.
    pub(crate) fn broken_branch_repo(label: &str, junk: &str) -> PathBuf {
        let dir = scratch_repo_dir(label);
        std::fs::create_dir_all(&dir).unwrap();
        // A loose ref file belongs to the files backend. Pin it, so a reftable
        // default (from config, or a later git) cannot leave no file to break;
        // a git without reftable ignores the key.
        command::run_str(&dir, &["-c", "init.defaultRefFormat=files", "init"]).unwrap();
        // Before touching anything under .git — see assert_isolated.
        assert_isolated(&dir);
        let branch = command::run_str(&dir, &["symbolic-ref", "HEAD"]).unwrap();
        let ref_file = dir.join(".git").join(branch.trim());
        std::fs::create_dir_all(ref_file.parent().unwrap())
            .and_then(|()| std::fs::write(&ref_file, junk))
            .unwrap_or_else(|e| panic!("could not break the branch ref at {ref_file:?}: {e}"));
        dir
    }

    /// A live run's paths wait for its own commit (M58.3): a checkpoint
    /// commits everything else, and a checkpoint with only the run's files
    /// changed commits nothing.
    #[test]
    fn commit_all_leaves_a_live_runs_paths_alone() {
        let vault = crate::vault::testutil::temp_vault("m58-commit-all-owned");
        let data = crate::vault::testutil::temp_vault("m58-commit-all-owned-data");
        for name in ["a", "b", "c"] {
            crate::vault::testutil::write(&vault, &format!("{name}.md"), "# seed\n");
        }
        init_repo(&vault).unwrap();
        command::run_str(&vault, &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&vault, &["config", "user.name", "t"]).unwrap();
        let ws = super::super::workspace::resolve(&vault);
        let claim = super::super::changeset::claim_run(&vault, &data, "run-live", "claude-code");
        claim.note_cli_write("a.md");
        claim.note_cli_write("b.md");
        for name in ["a", "b", "c"] {
            crate::vault::testutil::write(&vault, &format!("{name}.md"), "# changed\n");
        }

        let short = commit_all(&ws, "checkpoint")
            .unwrap()
            .expect("c.md commits");
        let named =
            command::run_str(&vault, &["show", "--name-only", "--format=", &short]).unwrap();
        assert_eq!(named.trim(), "c.md");
        assert_eq!(
            commit_all(&ws, "again").unwrap(),
            None,
            "only the run's files are left, and they are its own"
        );
        let left = command::run_str(&vault, &["status", "--porcelain"]).unwrap();
        assert_eq!(left.lines().collect::<Vec<_>>(), vec![" M a.md", " M b.md"]);

        drop(claim);
        assert!(commit_all(&ws, "after the run").unwrap().is_some());
        for d in [&vault, &data] {
            let _ = std::fs::remove_dir_all(d);
        }
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
    fn gitignore_ignores_the_trash() {
        let dir = scratch_repo_dir("ignore-trash");
        std::fs::create_dir_all(&dir).unwrap();
        ensure_gitignore(&dir).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(content, "# Cerebro\n.DS_Store\n.cerebro/\n.trash/\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_tracked_trash_is_untracked() {
        let dir = scratch_repo_dir("ignore-trash-tracked");
        std::fs::create_dir_all(dir.join(".trash/20261014T093000Z-a1b2/notes")).unwrap();
        std::fs::write(dir.join(".trash/20261014T093000Z-a1b2/notes/a.md"), "# A\n").unwrap();
        std::fs::write(dir.join("kept.md"), "# Kept\n").unwrap();
        command::run_str(&dir, &["init"]).unwrap();
        // Before ANY staging or committing — see assert_isolated.
        assert_isolated(&dir);
        author::ensure_identity(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "# Cerebro\n.DS_Store\n.cerebro/\n").unwrap();
        command::run_str(&dir, &["add", "-A"]).unwrap();
        command::run_str(&dir, &["commit", "-m", "old state"]).unwrap();

        ensure_gitignore(&dir).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert!(content.ends_with(".trash/\n"), "{content}");
        let tracked = command::run_str(&dir, &["ls-files", "--cached"]).unwrap();
        assert!(
            !tracked.contains(".trash"),
            "the Trash leaves the index: {tracked}"
        );
        assert!(tracked.contains("kept.md"), "{tracked}");
        assert!(
            dir.join(".trash/20261014T093000Z-a1b2/notes/a.md")
                .is_file(),
            "untracking keeps the file"
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
