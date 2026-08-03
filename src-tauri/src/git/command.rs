//! Running `git`.
//!
//! Cerebro shells out to the user's own `git` rather than linking libgit2.
//! That is a deliberate trade: no build-time C dependency, and — the reason
//! that actually matters — no reimplementation of authentication. Credential
//! helpers, SSH agents, and the macOS keychain all work because it is the
//! same binary the user already configured.
//!
//! Ported from tolaria's `git/command.rs` + `git/credentials.rs`.

use std::path::Path;
use std::process::{Command, Output, Stdio};

/// A git invocation that failed, split so callers can classify it.
#[derive(Debug)]
pub struct GitFailure {
    pub stderr: String,
    pub code: Option<i32>,
}

impl GitFailure {
    pub fn message(&self) -> String {
        let trimmed = self.stderr.trim();
        if trimmed.is_empty() {
            format!("git exited with status {}", self.code.unwrap_or(-1))
        } else {
            trimmed.to_string()
        }
    }
}

impl std::fmt::Display for GitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}

/// Repository-selecting variables that must never be inherited.
///
/// `GIT_DIR` and friends OUTRANK the working directory: with `GIT_DIR` set,
/// `Command::current_dir()` decides nothing, and a command aimed at one
/// directory operates on whatever repository the environment names. Git
/// exports exactly these when it runs a hook, so anything spawned from a hook
/// inherits them — which is how the "old state" wipes happened. A test
/// building a throwaway repo in `temp_dir()` had its `git add -A` and
/// `git commit` land in the cerebro checkout instead, three times, deleting
/// every tracked file; and no cwd-based guard could see it, because
/// `rev-parse --show-toplevel` honours `GIT_DIR` too and cheerfully agrees
/// with the wrong answer.
///
/// This matters beyond the tests. The app spawns git, and the Claude Code CLI
/// spawns processes that may inherit our environment; a vault operation must
/// act on the vault it was given, never on a repository some ancestor process
/// happened to name.
const REPO_SELECTING_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

/// A `git` command with prompting disabled.
///
/// This is the whole of `credentials.rs`, and it prevents a hang rather than
/// an error: `git pull` against an auth-required remote with no credential
/// helper blocks forever waiting on a terminal prompt that does not exist in
/// a GUI app. `GIT_TERMINAL_PROMPT=0` plus an empty `GIT_ASKPASS` turns that
/// into a fast failure, which `classify_remote_error` can then explain.
///
/// Suppression without classification would only turn a hang into an
/// unexplained failure, so the two always ship together.
///
/// It also scrubs `REPO_SELECTING_VARS`, so the directory a caller names is
/// the repository git acts on.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    for var in REPO_SELECTING_VARS {
        cmd.env_remove(var);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("SSH_ASKPASS", "");
    // Stable, parseable output regardless of the user's config.
    cmd.env("GIT_CONFIG_PARAMETERS", "'core.quotepath=false'");
    cmd.env("LC_ALL", "C");
    cmd.stdin(Stdio::null());
    cmd
}

/// A `git` command rooted at `dir`.
pub fn git_at(dir: &Path) -> Command {
    let mut cmd = git_command();
    cmd.current_dir(dir);
    cmd
}

/// Run git and capture stdout, or the failure.
pub fn run(dir: &Path, args: &[&str]) -> Result<String, GitFailure> {
    let output = git_at(dir).args(args).output().map_err(|e| GitFailure {
        stderr: format!("could not run git: {e}"),
        code: None,
    })?;
    from_output(output)
}

/// Run git and return stdout as a String, mapping failure to a message.
pub fn run_str(dir: &Path, args: &[&str]) -> Result<String, String> {
    run(dir, args).map_err(|e| e.message())
}

/// True when git exits 0; used for probes where the failure is the answer.
pub fn succeeds(dir: &Path, args: &[&str]) -> bool {
    git_at(dir)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn from_output(output: Output) -> Result<String, GitFailure> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(GitFailure {
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            code: output.status.code(),
        })
    }
}

/// Is `git` on PATH at all?
pub fn git_version() -> Option<String> {
    let output = git_command().arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Guard a user-supplied relative path before it reaches a git argument.
///
/// A path starting with `-` would be read as a flag, and `..` could escape
/// the vault. Both are rejected rather than escaped, because there is no
/// legitimate vault-relative path that needs either.
pub fn safe_relative(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("empty path".to_string());
    }
    if path.starts_with('-') {
        return Err(format!("refusing path that looks like a flag: {path}"));
    }
    if path.split('/').any(|part| part == "..") {
        return Err(format!("refusing path that escapes the vault: {path}"));
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod env_tests {
    use super::*;

    /// A git subprocess must obey the directory it was given, not a `GIT_DIR`
    /// it inherited.
    ///
    /// Git exports `GIT_DIR` to its hooks, so everything `.husky/pre-push`
    /// spawns inherits it. Three times that turned a test's throwaway repo
    /// into the cerebro checkout and deleted every tracked file. The bug is
    /// invisible to any check that asks git where it is, because that question
    /// is answered through the same variable.
    #[test]
    fn an_inherited_git_dir_cannot_redirect_a_command() {
        let scratch = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("cerebro-envguard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        run_str(&scratch, &["init"]).unwrap();

        // Point the environment at a DIFFERENT repository, the way a hook does.
        let decoy = scratch.join("decoy");
        std::fs::create_dir_all(&decoy).unwrap();
        run_str(&decoy, &["init"]).unwrap();
        std::env::set_var("GIT_DIR", decoy.join(".git"));

        let top = run_str(&scratch, &["rev-parse", "--show-toplevel"]).unwrap();
        std::env::remove_var("GIT_DIR");

        assert_eq!(
            std::fs::canonicalize(top.trim()).unwrap(),
            scratch,
            "GIT_DIR outranked the working directory — a command aimed at one \
             repository would operate on another"
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
