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
/// `views/*.yml`, `types/*.md`, and — above all —
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

/// Gitignore is case-sensitive on some filesystems; match the policy's ASCII
/// case-insensitive folders there too, without broadening to sibling names.
fn case_insensitive_ignore(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                c.to_string()
            }
        })
        .collect()
}
pub fn ensure_gitignore(dir: &Path) -> Result<(), String> {
    let path = dir.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mail = &crate::policy::mail::table().kept_out_of_git;
    let entries: Vec<String> = IGNORE_ENTRIES
        .iter()
        .map(|entry| (*entry).to_owned())
        .chain(mail.iter().cloned())
        .chain(mail.iter().map(|entry| case_insensitive_ignore(entry)))
        .collect();
    // Keep privacy rules last: an earlier matching row can be overridden by
    // a later negation. Appending one terminal block also closes that case.
    let suffix = entries.join("\n") + "\n";
    if !existing.ends_with(&suffix) {
        let next = if existing.trim().is_empty() {
            format!("# Cerebro\n{suffix}")
        } else {
            format!("{}\n{suffix}", existing.trim_end())
        };
        std::fs::write(&path, next).map_err(|e| e.to_string())?;
    }
    // Previously tracked private material stays on disk but leaves the index.
    // Run even when the ignore rows already exist: a force-add or an older
    // checkpoint may have tracked it since. Best-effort before git init.
    for tracked in UNTRACKED_DIRS {
        let _ = command::run_str(
            dir,
            &[
                "rm",
                "-r",
                "--cached",
                "--ignore-unmatch",
                "-q",
                "--",
                tracked,
            ],
        );
    }
    // Outside a repository there is no index yet. Once one exists, privacy
    // removal must succeed before any checkpoint can continue.
    if command::succeeds(dir, &["rev-parse", "--git-dir"]) {
        untrack_mail(dir)?;
    }
    Ok(())
}

fn untrack_mail(dir: &Path) -> Result<(), String> {
    for tracked in &crate::policy::mail::table().kept_out_of_git {
        let pathspec = format!(":(icase,literal){}", tracked.trim_end_matches('/'));
        command::run_str(
            dir,
            &[
                "rm",
                "-r",
                "-f",
                "--cached",
                "--ignore-unmatch",
                "-q",
                "--",
                &pathspec,
            ],
        )?;
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
    untrack_mail(dir)?;
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
/// it ends. Under the repository's lock.
///
/// A checkpoint commits from the index, never with `--only`: it stages each
/// unowned path whose worktree side changed, unstages any path a run owns,
/// then runs a plain `git commit`. So what the index alone holds commits as
/// it stands: a deletion or rename staged outside Cerebro, and
/// `ensure_gitignore`'s untrack, whose file stays on disk and ignored. A
/// merge whose conflicts are all resolved is finished here too, even with
/// nothing else changed, since git refuses a partial commit during a merge.
/// The plain commit also carries what a person staged outside a nested
/// vault's scope, as every checkpoint before M58.3 did.
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
    ensure_gitignore(Path::new(&ws.vault_root))?;
    let merging = super::conflict::mode(ws) == super::conflict::ConflictMode::Merge;
    let (unowned, _) = split_by_owner(ws)?;
    if unowned.is_empty() && !merging {
        return Ok(None);
    }
    author::ensure_identity(&dir)?;
    let (unowned, owned) = split_by_owner(ws)?;
    let conflicted = unowned
        .iter()
        .chain(&owned)
        .filter(|r| r.conflicted)
        .count();
    if conflicted > 0 {
        return Err(format!(
            "{conflicted} file{} still conflicted: resolve {} first",
            if conflicted == 1 { " is" } else { "s are" },
            if conflicted == 1 { "it" } else { "them" },
        ));
    }
    // Only a worktree-side change needs staging. An index-only change (a
    // staged deletion, a rename's old path, the untrack) is already staged,
    // and naming it would fail the add: no such file, or an ignored one.
    let stage: Vec<&str> = unowned
        .iter()
        .filter(|r| r.tree != ' ')
        .map(|r| r.git_path.as_str())
        .collect();
    pathspec_step(&dir, &["add", "-A"], &stage)?;
    // A run's path keeps out of the index commit: whatever was staged for it
    // goes back to HEAD, and its run commits the tree's whole diff. Not
    // during a merge, where what the index holds for it is the merge's.
    let unstage: Vec<&str> = owned
        .iter()
        .filter(|r| !merging && r.index != ' ' && r.index != '?')
        .flat_map(|r| std::iter::once(r.git_path.as_str()).chain(r.orig.as_deref()))
        .collect();
    pathspec_step(&dir, &["reset", "-q"], &unstage)?;
    // Staging and ownership resets must never reintroduce private mail.
    untrack_mail(Path::new(&ws.vault_root))?;
    let staged = !command::succeeds(&dir, &["diff", "--cached", "--quiet"]);
    if !staged && !merging {
        return Ok(None);
    }
    command::run_bounded(&dir, &["commit", "-m", message], command::LOCAL_TIMEOUT)
        .map_err(|e| e.message())?;
    Ok(Some(
        command::run_bounded_str(
            &dir,
            &["rev-parse", "--short", "HEAD"],
            command::LOCAL_TIMEOUT,
        )?
        .trim()
        .to_string(),
    ))
}

/// Every change in the vault's scope, split into the ones no live run owns
/// (conflicts among them) and the ones a live run does.
fn split_by_owner(
    ws: &GitWorkspaceInfo,
) -> Result<
    (
        Vec<super::status::StatusRecord>,
        Vec<super::status::StatusRecord>,
    ),
    String,
> {
    let records = super::status::records(ws)?;
    if records.is_empty() {
        return Ok((vec![], vec![]));
    }
    let owners = super::changeset::owned_paths(Path::new(&ws.vault_root));
    Ok(records.into_iter().partition(|record| {
        ws.to_vault_relative(&record.git_path)
            .is_none_or(|path| !owners.contains_key(&path))
    }))
}

/// Run `git --literal-pathspecs <args>` over `paths`, passed on stdin so a
/// long list never meets argv's limit; nothing to run for no paths.
fn pathspec_step(dir: &Path, args: &[&str], paths: &[&str]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut list = Vec::new();
    for path in paths {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    let mut argv = vec!["--literal-pathspecs"];
    argv.extend_from_slice(args);
    argv.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    command::run_bounded_with_input(dir, &argv, Some(&list), command::LOCAL_TIMEOUT)
        .map(|_| ())
        .map_err(|e| e.message())
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
/// (a rename brings its old path along), then `add -A` over the ones whose
/// worktree side changed and `commit --only` over every one with something
/// left to commit, each list on stdin, then `rev-parse HEAD`.
/// `--literal-pathspecs` so a `*` or a `:` in a file name is that file.
/// `commit --only` takes each path's whole diff from the tree, whatever was
/// staged before, commits a path gone from the tree and the index as a
/// deletion, and leaves every other staged change staged.
///
/// Three index states stay out: a staged deletion whose file is still on
/// disk is an untrack (`--only` would re-add the file, so the next
/// checkpoint commits it from the index); a file added then deleted (`AD`)
/// leaves nothing to commit once the add drops it; and during a merge git
/// refuses any partial commit, so that is said first.
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
    let mut stage: BTreeSet<String> = BTreeSet::new();
    let mut commit: BTreeSet<String> = BTreeSet::new();
    for record in super::status::records(ws)? {
        if record.conflicted {
            continue;
        }
        let hit = wanted.contains(&record.git_path)
            || record.orig.as_ref().is_some_and(|o| wanted.contains(o));
        if !hit {
            continue;
        }
        let untrack = record.index == 'D'
            && record.tree == ' '
            && std::fs::symlink_metadata(dir.join(&record.git_path)).is_ok();
        if untrack {
            continue;
        }
        if record.tree != ' ' {
            stage.insert(record.git_path.clone());
        }
        if !(record.index == 'A' && record.tree == 'D') {
            commit.insert(record.git_path);
            commit.extend(record.orig);
        }
    }
    if stage.is_empty() && commit.is_empty() {
        return Ok(None);
    }
    if super::conflict::mode(ws) == super::conflict::ConflictMode::Merge {
        return Err("a merge is in progress: finish it on the Changes page first".into());
    }
    author::ensure_identity(&dir)?;
    let stage: Vec<&str> = stage.iter().map(String::as_str).collect();
    pathspec_step(&dir, &["add", "-A"], &stage)?;
    if commit.is_empty() {
        return Ok(None);
    }
    let commit: Vec<&str> = commit.iter().map(String::as_str).collect();
    pathspec_step(&dir, &["commit", "--only", "-m", message], &commit)?;
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

    /// A scratch repository holding `files`, committed, with an identity:
    /// the vault is the repository.
    fn seeded(label: &str, files: &[(&str, &str)]) -> (PathBuf, GitWorkspaceInfo) {
        let dir = scratch_repo_dir(label);
        std::fs::create_dir_all(&dir).unwrap();
        for (path, body) in files {
            let at = dir.join(path);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, body).unwrap();
        }
        command::run_str(&dir, &["init", "-q"]).unwrap();
        // Before ANY staging or committing — see assert_isolated.
        assert_isolated(&dir);
        let _ = command::run_str(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        author::ensure_identity(&dir).unwrap();
        command::run_str(&dir, &["add", "-A"]).unwrap();
        command::run_str(&dir, &["commit", "-q", "-m", "seed"]).unwrap();
        let ws = super::super::workspace::resolve(&dir);
        (dir, ws)
    }

    fn porcelain(dir: &Path) -> String {
        command::run_str(dir, &["status", "--porcelain"]).unwrap()
    }

    fn named(dir: &Path, rev: &str) -> Vec<String> {
        command::run_str(dir, &["show", "--name-status", "--format=", rev])
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    const IGNORES: (&str, &str) = (".gitignore", "# Cerebro\n.DS_Store\n.cerebro/\n.trash/\nsources/mail/\n.comments/sources/mail/\n[sS][oO][uU][rR][cC][eE][sS]/[mM][aA][iI][lL]/\n.[cC][oO][mM][mM][eE][nN][tT][sS]/[sS][oO][uU][rR][cC][eE][sS]/[mM][aA][iI][lL]/\n");

    /// A deletion staged outside Cerebro (`git rm`) is index-only: a
    /// checkpoint commits it from the index, and the next one still works.
    #[test]
    fn a_checkpoint_commits_a_staged_deletion() {
        let (dir, ws) = seeded(
            "m58-staged-rm",
            &[IGNORES, ("a.md", "# a\n"), ("b.md", "# b\n")],
        );
        command::run_str(&dir, &["rm", "-q", "a.md"]).unwrap();
        std::fs::write(dir.join("b.md"), "# b, edited\n").unwrap();
        let short = commit_all(&ws, "checkpoint").unwrap().expect("a commit");
        assert_eq!(named(&dir, &short), vec!["D\ta.md", "M\tb.md"]);
        assert_eq!(porcelain(&dir), "");
        std::fs::write(dir.join("b.md"), "# b, again\n").unwrap();
        assert!(commit_all(&ws, "again").unwrap().is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A rename staged outside Cerebro (`git mv`) commits whole: its old
    /// path is not on disk, and is never named to `add`.
    #[test]
    fn a_checkpoint_commits_a_staged_rename() {
        let (dir, ws) = seeded("m58-staged-mv", &[IGNORES, ("a.md", "# a\n")]);
        command::run_str(&dir, &["mv", "a.md", "moved.md"]).unwrap();
        let short = commit_all(&ws, "checkpoint").unwrap().expect("a commit");
        assert_eq!(named(&dir, &short), vec!["R100\ta.md\tmoved.md"]);
        assert_eq!(porcelain(&dir), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// M13.3's self-heal: a tracked `.cerebro/connectors.json` is untracked
    /// by `ensure_gitignore`, and the checkpoint commits that untrack from
    /// the index. The file stays on disk and never comes back into the index.
    #[test]
    fn a_checkpoint_commits_the_untrack_and_never_retracks_it() {
        let (dir, ws) = seeded(
            "m58-untrack",
            &[
                (".gitignore", "# Cerebro\n.DS_Store\n"),
                (".cerebro/connectors.json", "{\"servers\":{}}"),
                ("a.md", "# a\n"),
            ],
        );
        std::fs::write(dir.join("a.md"), "# a, edited\n").unwrap();
        let short = commit_all(&ws, "checkpoint").unwrap().expect("a commit");
        let changed = named(&dir, &short);
        assert!(
            changed.contains(&"D\t.cerebro/connectors.json".to_string()),
            "{changed:?}"
        );
        assert!(changed.contains(&"M\ta.md".to_string()), "{changed:?}");
        let tracked = command::run_str(&dir, &["ls-files", "--cached", ".cerebro"]).unwrap();
        assert_eq!(tracked.trim(), "", "credentials stay out of the index");
        assert!(dir.join(".cerebro/connectors.json").is_file());
        assert_eq!(porcelain(&dir), "");
        // The next checkpoint leaves it out too.
        std::fs::write(dir.join("a.md"), "# a, once more\n").unwrap();
        assert!(commit_all(&ws, "again").unwrap().is_some());
        let tracked = command::run_str(&dir, &["ls-files", "--cached", ".cerebro"]).unwrap();
        assert_eq!(tracked.trim(), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A run's partial commit skips what it cannot carry: a staged deletion
    /// commits as one, an untracked-but-present file stays for the
    /// checkpoint, and a file added then deleted leaves nothing to commit.
    #[test]
    fn a_partial_commit_reads_the_index_side() {
        let (dir, ws) = seeded(
            "m58-partial-index",
            &[IGNORES, ("gone.md", "# gone\n"), ("kept.md", "# kept\n")],
        );
        command::run_str(&dir, &["rm", "-q", "gone.md"]).unwrap();
        command::run_str(&dir, &["rm", "-q", "--cached", "kept.md"]).unwrap();
        std::fs::write(
            dir.join(".gitignore"),
            "# Cerebro\n.DS_Store\n.cerebro/\n.trash/\nkept.md\n",
        )
        .unwrap();
        std::fs::write(dir.join("brief.md"), "# brief\n").unwrap();
        command::run_str(&dir, &["add", "brief.md"]).unwrap();
        std::fs::remove_file(dir.join("brief.md")).unwrap();
        let paths: Vec<String> = ["gone.md", "kept.md", "brief.md"]
            .map(String::from)
            .to_vec();
        let full = commit_paths(&ws, &paths, "run")
            .unwrap()
            .expect("gone.md commits");
        assert_eq!(named(&dir, &full), vec!["D\tgone.md"]);
        assert_eq!(
            commit_paths(&ws, &["brief.md".to_string()], "nothing").unwrap(),
            None,
            "added then deleted: nothing left"
        );
        let tracked = command::run_str(&dir, &["ls-files", "--cached", "kept.md"]).unwrap();
        assert_eq!(tracked.trim(), "", "the untrack is left for the checkpoint");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A pull that landed in conflict, resolved with Keep mine, leaves a
    /// clean tree and an open merge. A checkpoint finishes it with an index
    /// commit (git refuses `--only` during a merge), and a run's partial
    /// commit says so first rather than failing on git's words.
    #[test]
    fn a_checkpoint_finishes_a_resolved_merge() {
        let (dir, ws) = seeded("m58-merge", &[IGNORES, ("a.md", "# a\n")]);
        command::run_str(&dir, &["checkout", "-q", "-b", "theirs"]).unwrap();
        std::fs::write(dir.join("a.md"), "# a, theirs\n").unwrap();
        command::run_str(&dir, &["commit", "-q", "-am", "theirs"]).unwrap();
        command::run_str(&dir, &["checkout", "-q", "main"]).unwrap();
        std::fs::write(dir.join("a.md"), "# a, mine\n").unwrap();
        command::run_str(&dir, &["commit", "-q", "-am", "mine"]).unwrap();
        assert!(command::run_str(&dir, &["merge", "-q", "theirs"]).is_err());
        assert!(
            commit_all(&ws, "checkpoint").is_err(),
            "a conflicted file stops the checkpoint"
        );
        super::super::conflict::resolve(&ws, "a.md", super::super::conflict::Resolution::Ours)
            .unwrap();
        assert_eq!(porcelain(&dir), "", "Keep mine leaves nothing to show");
        assert!(commit_paths(&ws, &["a.md".to_string()], "run")
            .unwrap()
            .is_none());
        std::fs::write(dir.join("b.md"), "# b\n").unwrap();
        let err = commit_paths(&ws, &["b.md".to_string()], "run").unwrap_err();
        assert!(err.contains("merge is in progress"), "{err}");
        std::fs::remove_file(dir.join("b.md")).unwrap();

        assert!(commit_all(&ws, "checkpoint").unwrap().is_some());
        assert_eq!(
            super::super::conflict::mode(&ws),
            super::super::conflict::ConflictMode::None
        );
        let parents =
            command::run_str(&dir, &["rev-list", "--parents", "-n", "1", "HEAD"]).unwrap();
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "a merge commit: {parents}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("a.md")).unwrap(),
            "# a, mine\n"
        );
        std::fs::remove_dir_all(&dir).ok();
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
        assert_eq!(content, IGNORES.1);
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
        assert!(content.lines().any(|line| line == ".trash/"), "{content}");
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
    #[test]
    fn gitignore_keeps_mail_and_its_comments_out() {
        let (dir, ws) = seeded("m69-mail-ignore", &[("kept.md", "# Kept\n")]);
        command::run_str(&dir, &["config", "core.ignorecase", "false"]).unwrap();
        for path in [
            "sources/mail/a.md",
            ".comments/sources/mail/a.md.json",
            "Sources/Mail/case.md",
        ] {
            let target = dir.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, "private").unwrap();
        }
        commit_all(&ws, "checkpoint").unwrap();
        let tracked = command::run_str(&dir, &["ls-files"]).unwrap();
        assert!(!tracked.to_ascii_lowercase().contains("mail/"), "{tracked}");
        for path in [
            "sources/mail/a.md",
            ".comments/sources/mail/a.md.json",
            "Sources/Mail/case.md",
        ] {
            assert!(!command::run_str(&dir, &["check-ignore", "--", path])
                .unwrap()
                .trim()
                .is_empty());
            assert!(dir.join(path).is_file());
        }
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn a_tracked_digest_is_untracked_even_when_ignore_rows_exist() {
        let (dir, ws) = seeded(
            "m69-mail-tracked",
            &[
                IGNORES,
                ("sources/mail/a.md", "private"),
                (".comments/sources/mail/a.md.json", "comment"),
            ],
        );
        // The fixture's ignore rows prevent its ordinary add; emulate an older
        // checkpoint or an explicit force-add, then a clean working tree.
        command::run_str(
            &dir,
            &[
                "add",
                "-f",
                "--",
                "sources/mail/a.md",
                ".comments/sources/mail/a.md.json",
            ],
        )
        .unwrap();
        command::run_str(&dir, &["commit", "-q", "-m", "old tracked mail"]).unwrap();
        assert!(commit_all(&ws, "private files leave history")
            .unwrap()
            .is_some());
        let tracked = command::run_str(&dir, &["ls-files"]).unwrap();
        assert!(!tracked.contains("sources/mail"), "{tracked}");
        assert!(dir.join("sources/mail/a.md").is_file());
        assert!(dir.join(".comments/sources/mail/a.md.json").is_file());
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn staged_mail_with_three_versions_leaves_the_index_and_keeps_disk() {
        let (dir, ws) = seeded("m69-mail-three-versions", &[("sources/mail/a.md", "head")]);
        std::fs::write(dir.join("sources/mail/a.md"), "index").unwrap();
        command::run_str(&dir, &["add", "--", "sources/mail/a.md"]).unwrap();
        std::fs::write(dir.join("sources/mail/a.md"), "disk").unwrap();
        commit_all(&ws, "keep mail private").unwrap();
        assert!(!command::run_str(&dir, &["ls-files"])
            .unwrap()
            .contains("sources/mail"));
        assert_eq!(
            std::fs::read_to_string(dir.join("sources/mail/a.md")).unwrap(),
            "disk"
        );
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn later_ignore_negations_cannot_put_mail_in_a_checkpoint() {
        let (dir, ws) = seeded("m69-mail-negation", &[IGNORES]);
        let prior = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        std::fs::write(
            dir.join(".gitignore"),
            format!("{prior}!sources/mail/\n!sources/mail/**\n"),
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("sources/mail")).unwrap();
        std::fs::write(dir.join("sources/mail/a.md"), "private").unwrap();
        commit_all(&ws, "keep exclusions last").unwrap();
        assert!(!command::run_str(&dir, &["ls-files"])
            .unwrap()
            .contains("sources/mail"));
        assert!(command::succeeds(
            &dir,
            &["check-ignore", "sources/mail/a.md"]
        ));
        assert_eq!(
            std::fs::read_to_string(dir.join("sources/mail/a.md")).unwrap(),
            "private"
        );
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn a_nested_vault_keeps_mail_out() {
        let (dir, _) = seeded(
            "m69-mail-nested",
            &[("vault/kept.md", "kept"), ("outside.md", "outside")],
        );
        let vault = dir.join("vault");
        let ws = super::super::workspace::resolve(&vault);
        std::fs::create_dir_all(vault.join("sources/mail")).unwrap();
        std::fs::write(vault.join("sources/mail/a.md"), "private").unwrap();
        commit_all(&ws, "nested checkpoint").unwrap();
        assert!(!command::run_str(&dir, &["ls-files"])
            .unwrap()
            .contains("sources/mail"));
        assert!(
            !command::run_str(&vault, &["check-ignore", "sources/mail/a.md"])
                .unwrap()
                .trim()
                .is_empty()
        );
        std::fs::remove_dir_all(dir).ok();
    }
}
