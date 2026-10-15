//! Running `git`.
//!
//! Cerebro shells out to the user's own `git` rather than linking libgit2.
//! That is a deliberate trade: no build-time C dependency, and — the reason
//! that actually matters — no reimplementation of authentication. Credential
//! helpers, SSH agents, and the macOS keychain all work because it is the
//! same binary the user already configured.
//!
//! Ported from tolaria's `git/command.rs` + `git/credentials.rs`.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long fetch, pull, push and the credential probe may run (M58.3, Q8).
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a clone may run.
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(600);
/// How long each step of a partial commit may run: a gpg-signing config that
/// waits on a pinentry is the case it ends.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a timed-out git's group has between TERM and KILL.
const TIMEOUT_GRACE: Duration = Duration::from_secs(2);
/// How long stdout may stay open once git has exited: a process outside the
/// group (an ssh ControlMaster) can hold it, and the call does not wait on it.
const STDOUT_WAIT: Duration = Duration::from_secs(2);

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
///
/// `GIT_OPTIONAL_LOCKS=0` (M58.3): a read never takes `index.lock`. `git
/// status` refreshes the index by default, which takes the lock, so the
/// status poll, the changes list and a run's commit raced each other on it.
/// The cost is that status re-stats files it could have cached.
pub fn git_command() -> Command {
    let mut cmd = crate::spawn::command("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("SSH_ASKPASS", "");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
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

/// Run git and keep stdout as the bytes git wrote (M58.4): a blob read back
/// for a Restore must come back byte for byte, a BOM, a CRLF or invalid
/// UTF-8 included, which [`run`]'s lossy decode would change. Same helper
/// and environment as [`run`].
pub fn run_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitFailure> {
    let output = git_at(dir).args(args).output().map_err(|e| GitFailure {
        stderr: format!("could not run git: {e}"),
        code: None,
    })?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(GitFailure {
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            code: output.status.code(),
        })
    }
}

/// Run git under a deadline (M58.3), supervised: git leads its own process
/// group, so the deadline's group kill also ends ssh and git-remote-http,
/// which a kill of git alone would orphan holding its pipes. stdout is read
/// on a thread while the leader is polled; at `limit` the group gets TERM,
/// then KILL after two seconds, and the call fails with "operation timed out
/// after N s", which `remote::classify` reads as a network error.
pub fn run_bounded(dir: &Path, args: &[&str], limit: Duration) -> Result<String, GitFailure> {
    run_bounded_with_input(dir, args, None, limit)
}

/// [`run_bounded`], with `input` written to git's stdin and the pipe closed:
/// a pathspec list (`--pathspec-from-file=-`), or the credential protocol.
pub fn run_bounded_with_input(
    dir: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    limit: Duration,
) -> Result<String, GitFailure> {
    let failed = |e: std::io::Error| GitFailure {
        stderr: format!("could not run git: {e}"),
        code: None,
    };
    let mut cmd = git_at(dir);
    cmd.args(args);
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let (supervised, mut stdout) = crate::spawn::supervise(&mut cmd).map_err(failed)?;
    if let (Some(bytes), Some(mut stdin)) = (input, supervised.take_stdin()) {
        // On a thread, so a list larger than the pipe never blocks the
        // deadline's clock; a git that exits without reading it ends the write.
        let bytes = bytes.to_vec();
        let _ = std::thread::Builder::new()
            .name("cerebro-git-stdin".into())
            .spawn(move || {
                let _ = stdin.write_all(&bytes);
            });
    }
    let read = Arc::new(Mutex::new(Vec::new()));
    let (closed, drained) = std::sync::mpsc::sync_channel::<()>(1);
    let sink = read.clone();
    let reader = std::thread::Builder::new()
        .name("cerebro-git-stdout".into())
        .spawn(move || {
            let mut chunk = [0u8; 8 * 1024];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => sink
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .extend_from_slice(&chunk[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = closed.send(());
        });
    let handle = supervised.handle();
    if let Err(e) = reader {
        handle.terminate(Duration::ZERO);
        let _ = supervised.finish(Duration::ZERO);
        return Err(failed(e));
    }
    let deadline = Instant::now() + limit;
    let timed_out = loop {
        if !handle.alive() {
            break false;
        }
        if Instant::now() >= deadline {
            handle.terminate(TIMEOUT_GRACE);
            break true;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let _ = drained.recv_timeout(STDOUT_WAIT);
    let (status, tail) = supervised.finish(STDOUT_WAIT);
    if timed_out {
        return Err(GitFailure {
            stderr: format!("operation timed out after {} s", limit.as_secs()),
            code: None,
        });
    }
    let out = String::from_utf8_lossy(&read.lock().unwrap_or_else(|p| p.into_inner())).to_string();
    match status {
        Some(status) if status.success() => Ok(out),
        status => Err(GitFailure {
            stderr: tail.text(),
            code: status.and_then(|s| s.code()),
        }),
    }
}

/// [`run_bounded`], mapping failure to a message.
pub fn run_bounded_str(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    run_bounded(dir, args, limit).map_err(|e| e.message())
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

    /// Every Cerebro-spawned git reads without `index.lock` (M58.3): the
    /// variable reaches the process, as an alias that prints it shows.
    #[test]
    fn spawned_git_takes_no_optional_locks() {
        let dir = crate::vault::testutil::temp_vault("m58-optional-locks");
        crate::git::commit::init_repo(&dir).unwrap();
        let seen = run_str(
            &dir,
            &[
                "-c",
                "alias.optlocks=!printenv GIT_OPTIONAL_LOCKS",
                "optlocks",
            ],
        )
        .unwrap();
        assert_eq!(seen.trim(), "0");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A remote that accepts and never answers: the fetch ends at its
    /// deadline, not at curl's own much later one, and says it timed out.
    #[test]
    fn a_hung_fetch_gives_up_at_its_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = std::thread::spawn(move || {
            // Hold every connection open, silent, until the test is done.
            let mut open = Vec::new();
            for stream in listener.incoming().take(4).flatten() {
                open.push(stream);
            }
            std::thread::sleep(Duration::from_secs(8));
            drop(open);
        });
        let dir = crate::vault::testutil::temp_vault("m58-hung-fetch");
        crate::git::commit::init_repo(&dir).unwrap();
        let url = format!("http://127.0.0.1:{port}/r.git");
        let started = Instant::now();
        let failure = run_bounded(&dir, &["fetch", &url], Duration::from_secs(2))
            .expect_err("a remote that never answers cannot succeed");
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "took {:?}",
            started.elapsed()
        );
        assert_eq!(failure.message(), "operation timed out after 2 s");
        let _ = std::fs::remove_dir_all(&dir);
        drop(held);
    }

    /// A git whose ssh asks the terminal fails by its deadline: from a dev
    /// terminal the prompt stops on SIGTTIN and the deadline ends it, and
    /// with no terminal the read fails at once. Either way it never hangs.
    #[cfg(unix)]
    #[test]
    fn a_git_waiting_on_a_terminal_prompt_fails_by_its_deadline() {
        let dir = crate::vault::testutil::temp_vault("m58-tty-prompt");
        crate::git::commit::init_repo(&dir).unwrap();
        let fake = dir.join("fake-ssh.sh");
        std::fs::write(&fake, "#!/bin/sh\nread answer < /dev/tty\nsleep 30\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let ssh = format!("core.sshCommand={}", fake.display());
        let started = Instant::now();
        let result = run_bounded(
            &dir,
            &["-c", &ssh, "fetch", "ssh://git@example.invalid/r.git"],
            Duration::from_secs(2),
        );
        assert!(result.is_err(), "a prompt nobody answers cannot succeed");
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "took {:?}",
            started.elapsed()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
