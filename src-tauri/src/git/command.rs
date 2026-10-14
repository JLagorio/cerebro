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
use std::process::{Command, Output};

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

/// A `git` command with prompting disabled.
///
/// This is the prompt-suppression half of credential handling, and it
/// prevents a hang rather than an error: `git pull` against an auth-required
/// remote with no credential helper blocks forever waiting on a terminal
/// prompt that does not exist in a GUI app. `GIT_TERMINAL_PROMPT=0` plus an
/// empty `GIT_ASKPASS` turns that into a fast failure, which
/// `remote::classify` can then explain. `credentials.rs` (M32.10) holds the
/// readiness probe, which asks git whether auth would succeed without
/// attempting it.
///
/// Suppression without classification would only turn a hang into an
/// unexplained failure, so the two always ship together.
///
/// Built on `spawn::command`, which scrubs `spawn::REPO_SELECTING_VARS` and
/// nulls stdin, so the directory a caller names is the repository git acts
/// on.
pub fn git_command() -> Command {
    let mut cmd = crate::spawn::command("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("SSH_ASKPASS", "");
    // Stable, parseable output regardless of the user's config, plus the
    // M32.10 protocol pins — one env var, so this list is EXTENDED and never
    // clobbered (dropping `core.quotepath=false` would break every path with
    // a non-ASCII character in it).
    //
    // `ext::` transports are arbitrary command execution and are never
    // legitimate here; `file://` stays user-initiated only; fsmonitor daemons
    // have no business being started by an app that spawns git on a timer; and
    // a repository's own hooks NEVER run under Cerebro-spawned git — fetch
    // fires reference-transaction hooks and pull fires post-merge, which in a
    // mounted repo means running that repo's code. /var/empty exists and holds
    // nothing on macOS; command-scope config outranks repo-local.
    //
    // The hooks pin applies to VAULT git flows too, deliberately: an app
    // auto-committing on a timer must never hang on, or execute, a repo's
    // hook. A user who wants their vault's hooks runs git themselves.
    //
    // Residual vectors that CANNOT be pinned off without breaking legitimate
    // auth, written down so nobody thinks they were missed: `credential.helper`
    // and `core.sshCommand` in a mounted repo's `.git/config` still execute
    // during an authenticated fetch/pull — an empty `credential.helper` pin
    // would reset the helper LIST and kill the user's keychain helper.
    // Mounting a repository is trusting its `.git/config`; SECURITY.md says so.
    cmd.env(
        "GIT_CONFIG_PARAMETERS",
        "'core.quotepath=false' 'protocol.ext.allow=never' 'protocol.file.allow=user' \
         'core.fsmonitor=false' 'core.hooksPath=/var/empty'",
    );
    cmd.env("LC_ALL", "C");
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
    use std::path::PathBuf;

    /// How the parent tells its child where the scratch repository is.
    const SCRATCH_VAR: &str = "CEREBRO_ENVGUARD_SCRATCH";

    /// A git subprocess must obey the directory it was given, not a `GIT_DIR`
    /// it inherited.
    ///
    /// Git exports `GIT_DIR` to its hooks, so everything `.husky/pre-push`
    /// spawns inherits it. Three times that turned a test's throwaway repo
    /// into the cerebro checkout and deleted every tracked file.
    ///
    /// The hook's environment is rebuilt in a child, so this process never
    /// changes its own: [`inherited_git_dir_child`] runs with `GIT_DIR` naming
    /// a decoy repository and asks git which repository a command aimed at
    /// the scratch directory opens. It asks `--absolute-git-dir` because
    /// `--show-toplevel` cannot tell: with `GIT_DIR` set and no work tree, git
    /// takes the working directory as the top level, so it names the scratch
    /// directory with or without the scrub. With the scrub in `spawn::command`
    /// taken out, this test fails; it was checked that way once.
    #[test]
    fn an_inherited_git_dir_cannot_redirect_a_command() {
        let scratch = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("cerebro-envguard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        run_str(&scratch, &["init"]).unwrap();
        let decoy = scratch.join("decoy");
        std::fs::create_dir_all(&decoy).unwrap();
        run_str(&decoy, &["init"]).unwrap();

        let decoy_git_dir = decoy.join(".git");
        let child = crate::vault::testutil::run_test_child(
            "git::command::env_tests::inherited_git_dir_child",
            &[
                ("GIT_DIR", decoy_git_dir.as_os_str()),
                (SCRATCH_VAR, scratch.as_os_str()),
            ],
        );
        let _ = std::fs::remove_dir_all(&scratch);

        let stdout = String::from_utf8_lossy(&child.stdout);
        let shown = format!(
            "--- child stdout ---\n{stdout}\n--- child stderr ---\n{}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            child.status.success(),
            "GIT_DIR outranked the working directory — a command aimed at one repository \
             would operate on another\n{shown}"
        );
        // A filter that matched nothing would exit 0 as well.
        assert!(
            stdout.contains("1 passed"),
            "the child ran no test\n{shown}"
        );
    }

    /// The child half of [`an_inherited_git_dir_cannot_redirect_a_command`],
    /// started with the decoy `GIT_DIR` its parent set, as a hook's children
    /// are. Run on its own, with no scratch repository named, it has nothing
    /// to check.
    #[test]
    #[ignore = "child half of an_inherited_git_dir_cannot_redirect_a_command"]
    fn inherited_git_dir_child() {
        let Some(scratch) = std::env::var_os(SCRATCH_VAR).map(PathBuf::from) else {
            return;
        };
        assert!(
            std::env::var_os("GIT_DIR").is_some(),
            "the parent hands this child a GIT_DIR, the way a hook does"
        );
        let git_dir = run_str(&scratch, &["rev-parse", "--absolute-git-dir"]).unwrap();
        assert_eq!(
            std::fs::canonicalize(git_dir.trim()).unwrap(),
            std::fs::canonicalize(scratch.join(".git")).unwrap(),
            "GIT_DIR outranked the working directory: git opened the decoy repository"
        );
    }

    /// Every Cerebro-spawned git carries the M32.10 protocol pins.
    ///
    /// `GIT_CONFIG_PARAMETERS` entries are visible to `git config` inside the
    /// spawned process — that is the property this relies on. It also proves
    /// the pins were APPENDED: `core.quotepath` still has to be there, and
    /// clobbering that env var would break every non-ASCII path.
    #[test]
    fn spawned_git_carries_the_protocol_pins() {
        let dir = crate::vault::testutil::temp_vault("m32-pins");
        crate::git::commit::init_repo(&dir).unwrap();

        for (key, expected) in [
            ("protocol.ext.allow", "never"),
            ("core.fsmonitor", "false"),
            ("core.hooksPath", "/var/empty"),
            ("protocol.file.allow", "user"),
            // The pre-existing pin must survive being extended (M32.10 trap).
            ("core.quotepath", "false"),
        ] {
            let value = run_str(&dir, &["config", key]).unwrap();
            assert_eq!(value.trim(), expected, "{key} is not pinned");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
