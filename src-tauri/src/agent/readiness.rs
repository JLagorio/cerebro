//! Bounded native CLI discovery. Discovery observes an executable, never sign-in.
//!
//! Every check and run takes a fresh observation. Its executable identity,
//! version and recovered PATH travel together; no failure or login PATH is
//! cached for the process lifetime. Probe children use the shared supervisor,
//! null stdin and bounded capture, never the seated run's input protocol.

use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{ChildStdout, Command};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

const PROBE_BUDGET: Duration = Duration::from_secs(5);
const OUTPUT_BYTES: usize = 16 * 1024;
const SEARCH_ENTRIES: usize = 256;
const POLL: Duration = Duration::from_millis(5);
pub(super) const PATH_SENTINEL: &str = "__CEREBRO_PATH__";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeError {
    Timeout,
    Permission,
    ProbeFailed,
    OutputLimit,
}

impl ProbeError {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Timeout => "Checking Claude Code timed out. Check again before starting a run.",
            Self::Permission => "Claude Code could not be checked because access was denied. Check its executable permissions and try again.",
            Self::ProbeFailed => "Claude Code readiness could not be checked. Try checking again.",
            Self::OutputLimit => "Claude Code discovery returned too much output. Check again after fixing the local setup.",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CliReadiness {
    Available {
        path: String,
        version: Option<String>,
        backend: &'static str,
    },
    Missing,
    Unavailable {
        code: ProbeError,
    },
}

#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mode: u32,
}

impl Fingerprint {
    fn at(path: &Path) -> Result<Self, ProbeError> {
        let meta = path.metadata().map_err(classify_io)?;
        if !meta.is_file() {
            return Err(ProbeError::Permission);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if meta.permissions().mode() & 0o111 == 0 {
                return Err(ProbeError::Permission);
            }
            Ok(Self {
                len: meta.len(),
                modified: meta.modified().map_err(classify_io)?,
                device: meta.dev(),
                inode: meta.ino(),
                mode: meta.mode(),
            })
        }
        #[cfg(not(unix))]
        {
            Ok(Self {
                len: meta.len(),
                modified: meta.modified().map_err(classify_io)?,
            })
        }
    }
}

/// One native observation, held by a run while it plans its gate and argv.
/// Neither the webview nor a caller's claimed path/version can construct it.
pub(crate) struct Observation {
    pub(crate) binary: PathBuf,
    pub(crate) version: Option<String>,
    path: OsString,
    fingerprint: Fingerprint,
}

impl Observation {
    pub(crate) fn configure_command(&self, command: &mut Command) -> Result<(), ProbeError> {
        self.check_identity()?;
        command.env("PATH", &self.path);
        Ok(())
    }

    pub(crate) fn check_identity(&self) -> Result<(), ProbeError> {
        if Fingerprint::at(&self.binary)? != self.fingerprint {
            return Err(ProbeError::ProbeFailed);
        }
        Ok(())
    }
}

struct ProbeConfig {
    path: OsString,
    shell: Option<PathBuf>,
    fallbacks: Box<dyn FnOnce() -> Result<Vec<PathBuf>, ProbeError>>,
}

/// The command's wire answer has no account, sign-in or credential claim.
pub fn check() -> CliReadiness {
    match observe() {
        Ok(Some(found)) => CliReadiness::Available {
            path: found.binary.to_string_lossy().into_owned(),
            version: found.version,
            backend: "native",
        },
        Ok(None) => CliReadiness::Missing,
        Err(code) => CliReadiness::Unavailable { code },
    }
}

pub(crate) fn observe() -> Result<Option<Observation>, ProbeError> {
    let started = Instant::now();
    let home = std::env::var("HOME").unwrap_or_default();
    let config = ProbeConfig {
        path: std::env::var_os("PATH").unwrap_or_default(),
        shell: if cfg!(unix) {
            Some(std::env::var_os("SHELL").map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from))
        } else {
            None
        },
        fallbacks: Box::new(move || candidates_for(&home)),
    };
    // Optional installer enumeration is deferred, within this same budget.
    observe_with(config, PROBE_BUDGET.saturating_sub(started.elapsed()))
}

struct Deadline {
    stop: Instant,
    end: Instant,
}

impl Deadline {
    fn new(budget: Duration) -> Self {
        let now = Instant::now();
        // Leave kill/reap and the bounded stderr-drain wait inside the budget.
        let cleanup = (budget / 5).min(Duration::from_millis(200));
        Self {
            stop: now + budget.saturating_sub(cleanup),
            end: now + budget,
        }
    }
    fn check(&self) -> Result<(), ProbeError> {
        if Instant::now() >= self.stop {
            Err(ProbeError::Timeout)
        } else {
            Ok(())
        }
    }
}

fn observe_with(config: ProbeConfig, budget: Duration) -> Result<Option<Observation>, ProbeError> {
    let deadline = Deadline::new(budget);
    deadline.check()?;
    let path = if let Some(shell) = &config.shell {
        let mut command = crate::spawn::command(shell);
        command.args(["-lic", "printf '\\n__CEREBRO_PATH__%s\\n' \"$PATH\""]);
        command.env("PATH", &config.path);
        let output = capture(&mut command, &deadline)?;
        let login = path_from_probe(&output).ok_or(ProbeError::ProbeFailed)?;
        let mut merged = OsString::from(login);
        if !config.path.is_empty() {
            merged.push(":");
            merged.push(&config.path);
        }
        merged
    } else {
        config.path
    };
    // Relative PATH entries must keep the same meaning after cli_command
    // changes cwd to the vault, including an env-node script's interpreter.
    let cwd = std::env::current_dir().map_err(classify_io)?;
    let mut directories = Vec::new();
    for directory in std::env::split_paths(&path) {
        deadline.check()?;
        if directories.len() >= SEARCH_ENTRIES {
            return Err(ProbeError::OutputLimit);
        }
        directories.push(if directory.is_absolute() {
            directory
        } else {
            cwd.join(directory)
        });
    }
    let path = std::env::join_paths(&directories).map_err(|_| ProbeError::ProbeFailed)?;
    let mut candidates = directories
        .into_iter()
        .map(|directory| {
            directory.join(if cfg!(windows) {
                "claude.exe"
            } else {
                "claude"
            })
        })
        .collect::<Vec<_>>()
        .into_iter();
    let mut load_fallbacks = Some(config.fallbacks);
    let mut denied = false;
    loop {
        deadline.check()?;
        let binary = match candidates.next() {
            Some(binary) => binary,
            None => {
                // An unrelated optional installer tree cannot refuse a CLI
                // already found on PATH. Inspect it once, only when needed.
                let Some(load) = load_fallbacks.take() else {
                    break;
                };
                let loaded = load();
                deadline.check()?;
                let fallbacks = loaded?;
                if fallbacks.len() > SEARCH_ENTRIES {
                    return Err(ProbeError::OutputLimit);
                }
                candidates = fallbacks
                    .into_iter()
                    .map(|candidate| {
                        if candidate.is_absolute() {
                            candidate
                        } else {
                            cwd.join(candidate)
                        }
                    })
                    .collect::<Vec<_>>()
                    .into_iter();
                continue;
            }
        };
        let fingerprint = match Fingerprint::at(&binary) {
            Ok(identity) => identity,
            Err(ProbeError::Permission) => {
                denied = true;
                continue;
            }
            Err(ProbeError::ProbeFailed) if !binary.try_exists().map_err(classify_io)? => continue,
            Err(error) => return Err(error),
        };
        let mut command = crate::spawn::command(&binary);
        command.arg("--version").env("PATH", &path);
        let version = capture(&mut command, &deadline)?;
        let found = Observation {
            binary,
            version: (!version.trim().is_empty()).then(|| version.trim().to_owned()),
            path,
            fingerprint,
        };
        found.check_identity()?;
        deadline.check()?;
        return Ok(Some(found));
    }
    deadline.check()?;
    if denied {
        Err(ProbeError::Permission)
    } else {
        Ok(None)
    }
}

fn classify_io(error: io::Error) -> ProbeError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        ProbeError::Permission
    } else {
        ProbeError::ProbeFailed
    }
}

pub(super) fn path_from_probe(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix(PATH_SENTINEL))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

pub(super) fn candidates_for(home: &str) -> Result<Vec<PathBuf>, ProbeError> {
    let mut candidates: Vec<_> = [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ]
    .iter()
    .map(PathBuf::from)
    .chain(
        [
            ".local/bin/claude",
            ".claude/local/claude",
            ".bun/bin/claude",
            ".volta/bin/claude",
            ".yarn/bin/claude",
            ".npm-global/bin/claude",
            ".local/share/pnpm/claude",
        ]
        .iter()
        .map(|relative| PathBuf::from(home).join(relative)),
    )
    .collect();
    candidates.extend(nvm_candidates(home)?);
    Ok(candidates)
}

pub(super) fn nvm_candidates(home: &str) -> Result<Vec<PathBuf>, ProbeError> {
    let entries = match std::fs::read_dir(PathBuf::from(home).join(".nvm/versions/node")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(classify_io(error)),
    };
    let mut candidates = Vec::new();
    for entry in entries {
        if candidates.len() >= SEARCH_ENTRIES {
            return Err(ProbeError::OutputLimit);
        }
        candidates.push(entry.map_err(classify_io)?.path().join("bin/claude"));
    }
    candidates.sort();
    Ok(candidates)
}

#[cfg(unix)]
fn nonblocking(stdout: &ChildStdout) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: stdout owns this live descriptor. Only its flags change; the
    // probing thread below is its sole reader and drops it on every outcome.
    let flags = unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the same live descriptor and its previously read status flags.
    if unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(not(unix))]
fn nonblocking(_stdout: &ChildStdout) -> io::Result<()> {
    Err(io::Error::other(
        "bounded CLI discovery requires nonblocking pipes",
    ))
}

fn capture(command: &mut Command, deadline: &Deadline) -> Result<String, ProbeError> {
    deadline.check()?;
    let (supervised, mut stdout) = crate::spawn::supervise(command).map_err(classify_io)?;
    let handle = supervised.handle();
    let result = (|| {
        nonblocking(&stdout).map_err(classify_io)?;
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut eof = false;
        loop {
            deadline.check()?;
            if !eof {
                match stdout.read(&mut chunk) {
                    Ok(0) => eof = true,
                    Ok(n) if bytes.len().saturating_add(n) > OUTPUT_BYTES => {
                        return Err(ProbeError::OutputLimit)
                    }
                    Ok(n) => {
                        bytes.extend_from_slice(&chunk[..n]);
                        continue;
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(classify_io(error)),
                }
            }
            if eof && !handle.alive() {
                break;
            }
            std::thread::sleep(POLL);
        }
        String::from_utf8(bytes).map_err(|_| ProbeError::ProbeFailed)
    })();
    // Also kill remaining group members when the leader exited but a child
    // holds a pipe. This is the shared supervisor's existing group boundary;
    // a process deliberately starting a new session can escape it.
    handle.terminate(Duration::ZERO);
    drop(stdout);
    let (status, stderr) =
        supervised.finish(deadline.end.saturating_duration_since(Instant::now()));
    if stderr.dropped() > 0 {
        return Err(ProbeError::OutputLimit);
    }
    let text = result?;
    if Instant::now() >= deadline.end || stderr.held_open() {
        return Err(ProbeError::Timeout);
    }
    if !status.is_some_and(|status| status.success()) {
        return Err(ProbeError::ProbeFailed);
    }
    Ok(text)
}

#[cfg(test)]
pub(super) mod test_support {
    use super::*;

    /// Room for a toy probe to start and finish while the whole suite runs
    /// at once. Only a timeout under test keeps a short budget (`HUNG`).
    pub(crate) const ROOMY: Duration = Duration::from_secs(10);

    /// Observe only the provider-free fixture executable in its private PATH.
    pub(crate) fn fixture_observation(binary: &std::path::Path) -> Observation {
        let config = ProbeConfig {
            path: binary.parent().unwrap().as_os_str().to_owned(),
            shell: None,
            fallbacks: Box::new(|| Ok(Vec::new())),
        };
        observe_with(config, ROOMY).unwrap().unwrap()
    }

    /// Invalid-option tests never reach the executable. Supply the test
    /// runner's identity without discovering or invoking a person's CLI.
    pub(crate) fn inert_observation() -> Observation {
        let binary = std::env::current_exe().unwrap();
        Observation {
            fingerprint: Fingerprint::at(&binary).unwrap(),
            binary,
            version: None,
            path: OsString::new(),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use test_support::ROOMY;
    /// A timeout under test: long enough for the toy to start and record its
    /// pid on a loaded machine, far short of the 30 s it would sleep.
    const HUNG: Duration = Duration::from_secs(2);
    /// How long cleanup may take past a deadline before a child counts as kept.
    const SETTLE: Duration = Duration::from_secs(3);
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "cerebro-readiness-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn script(&self, name: &str, script: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
        fn config(&self) -> ProbeConfig {
            ProbeConfig {
                path: self.0.clone().into_os_string(),
                shell: None,
                fallbacks: Box::new(|| Ok(Vec::new())),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn error(result: Result<Option<Observation>, ProbeError>) -> ProbeError {
        match result {
            Err(error) => error,
            Ok(_) => panic!("expected unavailable"),
        }
    }
    fn shell(f: &Fixture, script: &str) -> ProbeConfig {
        ProbeConfig {
            shell: Some(f.script("login-shell", script)),
            ..f.config()
        }
    }
    fn alive(pid: i32) -> bool {
        // SAFETY: signal zero observes a disposable toy child without changing it.
        unsafe { libc::kill(pid, 0) == 0 }
    }
    fn wait_gone(pid: i32) {
        let until = Instant::now() + SETTLE;
        while alive(pid) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!alive(pid), "toy process {pid} survived probe cleanup");
    }
    fn read_pid(path: &Path) -> i32 {
        fs::read_to_string(path).unwrap().trim().parse().unwrap()
    }

    #[test]
    fn complete_search_without_a_binary_is_missing() {
        let f = Fixture::new();
        assert!(observe_with(f.config(), ROOMY).unwrap().is_none());
    }
    #[test]
    fn available_observation_pairs_the_executable_version_and_path() {
        let f = Fixture::new();
        let binary = f.script("claude", "printf '2.1.250 (toy)\\n'");
        let found = observe_with(f.config(), ROOMY).unwrap().unwrap();
        assert_eq!(found.binary, binary);
        assert_eq!(found.version.as_deref(), Some("2.1.250 (toy)"));
        assert_eq!(found.path, f.0.as_os_str());
    }
    #[test]
    fn a_non_executable_candidate_is_permission_unavailable() {
        let f = Fixture::new();
        fs::write(f.0.join("claude"), "no executable permission").unwrap();
        assert_eq!(
            error(observe_with(f.config(), ROOMY)),
            ProbeError::Permission
        );
    }
    #[test]
    fn version_process_failure_is_not_missing() {
        let f = Fixture::new();
        f.script("claude", "exit 7");
        assert_eq!(
            error(observe_with(f.config(), ROOMY)),
            ProbeError::ProbeFailed
        );
    }
    #[test]
    fn a_blank_version_still_observes_the_executable_without_claiming_sign_in() {
        let f = Fixture::new();
        f.script("claude", "exit 0");
        assert!(observe_with(f.config(), ROOMY)
            .unwrap()
            .unwrap()
            .version
            .is_none());
    }
    #[test]
    fn a_hung_login_shell_is_timed_out_and_reaped() {
        let f = Fixture::new();
        let pid = f.0.join("shell.pid");
        let config = shell(
            &f,
            &format!("echo $$ > '{}'; exec /bin/sleep 30", pid.display()),
        );
        let started = Instant::now();
        assert_eq!(error(observe_with(config, HUNG)), ProbeError::Timeout);
        assert!(started.elapsed() < HUNG + SETTLE);
        wait_gone(read_pid(&pid));
    }
    #[test]
    fn a_hung_version_process_is_timed_out_and_reaped() {
        let f = Fixture::new();
        let pid = f.0.join("version.pid");
        f.script(
            "claude",
            &format!("echo $$ > '{}'; exec /bin/sleep 30", pid.display()),
        );
        let started = Instant::now();
        assert_eq!(error(observe_with(f.config(), HUNG)), ProbeError::Timeout);
        assert!(started.elapsed() < HUNG + SETTLE);
        wait_gone(read_pid(&pid));
    }
    #[test]
    fn shell_and_version_share_one_deadline() {
        let f = Fixture::new();
        // Each step alone fits the budget; together they cannot.
        f.script("claude", "/bin/sleep 1; printf '2.1.250\\n'");
        let config = shell(
            &f,
            &format!(
                "/bin/sleep 1; printf '__CEREBRO_PATH__%s\\n' '{}'",
                f.0.display()
            ),
        );
        let started = Instant::now();
        assert_eq!(
            error(observe_with(config, Duration::from_millis(1500))),
            ProbeError::Timeout
        );
        assert!(started.elapsed() < Duration::from_millis(1500) + SETTLE);
    }
    #[test]
    fn stdout_flood_is_capped_and_the_child_is_reaped() {
        let f = Fixture::new();
        let pid = f.0.join("flood.pid");
        f.script("claude", &format!("echo $$ > '{}'; while :; do printf '0123456789012345678901234567890123456789'; done", pid.display()));
        assert_eq!(
            error(observe_with(f.config(), ROOMY)),
            ProbeError::OutputLimit
        );
        wait_gone(read_pid(&pid));
    }
    #[test]
    fn a_child_holding_stdout_cannot_outlive_probe_cleanup() {
        let f = Fixture::new();
        let pid = f.0.join("child.pid");
        f.script(
            "claude",
            &format!(
                "/bin/sleep 30 & echo $! > '{}'; printf '2.1.250\\n'",
                pid.display()
            ),
        );
        assert_eq!(error(observe_with(f.config(), HUNG)), ProbeError::Timeout);
        wait_gone(read_pid(&pid));
    }
    #[test]
    fn login_shell_failure_is_unavailable_instead_of_install_advice() {
        let f = Fixture::new();
        assert_eq!(
            error(observe_with(shell(&f, "exit 9"), ROOMY)),
            ProbeError::ProbeFailed
        );
    }
    #[test]
    fn refreshed_login_path_and_version_are_not_cached_forever() {
        let f = Fixture::new();
        let other = Fixture::new();
        f.script("claude", "printf '2.1.249\\n'");
        other.script("claude", "printf '2.1.250\\n'");
        let config = shell(
            &f,
            &format!(
                "printf 'banner\\n__CEREBRO_PATH__%s\\n' '{}'",
                f.0.display()
            ),
        );
        let first = observe_with(config, ROOMY).unwrap().unwrap();
        let config = shell(
            &f,
            &format!("printf '__CEREBRO_PATH__%s\\n' '{}'", other.0.display()),
        );
        let second = observe_with(config, ROOMY).unwrap().unwrap();
        assert_eq!(first.version.as_deref(), Some("2.1.249"));
        assert_eq!(second.version.as_deref(), Some("2.1.250"));
        assert!(!crate::agent::interaction::supports_gate(
            first.version.as_deref()
        ));
        assert!(crate::agent::interaction::supports_gate(
            second.version.as_deref()
        ));
        assert_eq!(second.binary, other.0.join("claude"));
    }
    #[test]
    fn failure_does_not_poison_the_next_observation() {
        let f = Fixture::new();
        assert_eq!(
            error(observe_with(shell(&f, "exit 9"), ROOMY)),
            ProbeError::ProbeFailed
        );
        f.script("claude", "printf '2.1.250\\n'");
        assert!(observe_with(f.config(), ROOMY).unwrap().is_some());
    }
    #[test]
    fn fallback_install_is_checked_after_path_candidates() {
        let f = Fixture::new();
        let install = Fixture::new();
        let candidate = install.script("claude", "printf '2.1.250\\n'");
        let config = ProbeConfig {
            fallbacks: Box::new({
                let candidate = candidate.clone();
                move || Ok(vec![candidate])
            }),
            ..f.config()
        };
        assert_eq!(
            observe_with(config, ROOMY).unwrap().unwrap().binary,
            candidate
        );
    }
    #[test]
    fn changed_executable_cannot_reuse_an_observed_capability_version() {
        let f = Fixture::new();
        let binary = f.script("claude", "printf '2.1.250\\n'");
        let found = observe_with(f.config(), ROOMY).unwrap().unwrap();
        let replacement = f.script("replacement", "printf '2.1.249\\n'");
        fs::rename(replacement, &binary).unwrap();
        let mut command = crate::spawn::command(&binary);
        assert_eq!(
            found.configure_command(&mut command),
            Err(ProbeError::ProbeFailed)
        );
    }
    #[test]
    fn executable_changed_during_version_capture_is_unavailable() {
        let f = Fixture::new();
        f.script(
            "claude",
            "printf '2.1.250\\n'; printf '# changed\\n' >> \"$0\"",
        );
        assert_eq!(
            error(observe_with(f.config(), ROOMY)),
            ProbeError::ProbeFailed
        );
    }
    #[test]
    fn actual_command_receives_the_observed_path_without_process_env_mutation() {
        let f = Fixture::new();
        f.script("claude", "printf '2.1.250\\n'");
        let found = observe_with(f.config(), ROOMY).unwrap().unwrap();
        let mut command = crate::spawn::command("/bin/sh");
        command.args(["-c", "printf '%s' \"$PATH\""]);
        found.configure_command(&mut command).unwrap();
        assert_eq!(
            capture(&mut command, &Deadline::new(ROOMY)).unwrap(),
            f.0.to_string_lossy()
        );
    }
    #[test]
    fn excessive_installer_directory_entries_are_unavailable() {
        let f = Fixture::new();
        let directory = f.0.join(".nvm/versions/node");
        fs::create_dir_all(&directory).unwrap();
        for at in 0..257 {
            fs::create_dir(directory.join(format!("v{at}"))).unwrap();
        }
        assert_eq!(
            nvm_candidates(f.0.to_str().unwrap()),
            Err(ProbeError::OutputLimit)
        );
    }
    #[test]
    fn excessive_path_entries_are_unavailable_instead_of_truncated_search() {
        let f = Fixture::new();
        let path = std::env::join_paths((0..257).map(|at| f.0.join(at.to_string()))).unwrap();
        let config = ProbeConfig { path, ..f.config() };
        assert_eq!(error(observe_with(config, ROOMY)), ProbeError::OutputLimit);
    }
    #[test]
    fn a_stopped_login_shell_is_killed_and_reaped_within_budget() {
        let f = Fixture::new();
        let pid = f.0.join("stopped.pid");
        let config = shell(
            &f,
            &format!("echo $$ > '{}'; kill -STOP $$; exit 0", pid.display()),
        );
        let started = Instant::now();
        assert_eq!(error(observe_with(config, HUNG)), ProbeError::Timeout);
        assert!(started.elapsed() < HUNG + SETTLE);
        wait_gone(read_pid(&pid));
    }
    #[test]
    fn stderr_flood_is_bounded_and_not_reported_as_missing() {
        let f = Fixture::new();
        let pid = f.0.join("stderr.pid");
        // Exceed the 64 KiB stderr tail with one bounded write, rather than
        // depending on thousands of tiny writes winning a scheduling race.
        let flood = "x".repeat(128 * 1024);
        f.script(
            "claude",
            &format!(
                "echo $$ > '{}'; printf '%s' '{flood}' >&2; exec /bin/sleep 30",
                pid.display()
            ),
        );
        assert_eq!(
            error(observe_with(f.config(), ROOMY)),
            ProbeError::OutputLimit
        );
        wait_gone(read_pid(&pid));
    }

    fn relative_from_cwd(path: &Path) -> PathBuf {
        let cwd = std::env::current_dir().unwrap();
        let mut relative = PathBuf::new();
        for _ in cwd.components().skip(1) {
            relative.push("..");
        }
        relative.push(path.strip_prefix("/").unwrap());
        relative
    }
    #[test]
    fn relative_installer_candidate_is_absolute_before_vault_spawn() {
        let f = Fixture::new();
        let install = Fixture::new();
        let binary = install.script("claude", "printf '2.1.250\\n'");
        let config = ProbeConfig {
            fallbacks: Box::new({
                let candidate = relative_from_cwd(&binary);
                move || Ok(vec![candidate])
            }),
            ..f.config()
        };
        let found = observe_with(config, ROOMY).unwrap().unwrap();
        assert!(found.binary.is_absolute());
        assert_eq!(
            fs::canonicalize(found.binary).unwrap(),
            fs::canonicalize(binary).unwrap()
        );
    }
    #[test]
    fn relative_path_entries_keep_their_meaning_after_changing_to_the_vault() {
        let f = Fixture::new();
        let vault = Fixture::new();
        f.script("claude", "printf '2.1.250\\n'");
        let config = ProbeConfig {
            path: relative_from_cwd(&f.0).into_os_string(),
            shell: None,
            fallbacks: Box::new(|| Ok(Vec::new())),
        };
        let found = observe_with(config, ROOMY).unwrap().unwrap();
        assert!(std::env::split_paths(&found.path).all(|entry| entry.is_absolute()));
        let mut command = crate::spawn::command("/bin/sh");
        command
            .args(["-c", "printf '%s' \"$PATH\""])
            .current_dir(&vault.0);
        found.configure_command(&mut command).unwrap();
        let shown = capture(&mut command, &Deadline::new(ROOMY)).unwrap();
        assert_eq!(
            fs::canonicalize(shown).unwrap(),
            fs::canonicalize(&f.0).unwrap()
        );
    }
    fn valid_path_in_child_with_unusable_nvm(test_name: &str, oversized: bool) {
        const MARKER: &str = "CEREBRO_READINESS_LAZY_FALLBACK_CHILD";
        if std::env::var_os(MARKER).is_some() {
            let found = super::observe()
                .expect(
                    "a valid PATH install must not depend on unused optional nvm fallback state",
                )
                .expect("toy CLI is on PATH");
            assert_eq!(found.version.as_deref(), Some("2.1.250 (toy)"));
            return;
        }
        let f = Fixture::new();
        f.script("claude", "printf '2.1.250 (toy)\\n'");
        let login = f.script("login-shell", "printf '\\n__CEREBRO_PATH__%s\\n' \"$PATH\"");
        fs::create_dir_all(f.0.join(".nvm/versions")).unwrap();
        let nvm = f.0.join(".nvm/versions/node");
        if oversized {
            fs::create_dir(&nvm).unwrap();
            for at in 0..257 {
                fs::create_dir(nvm.join(format!("v{at}"))).unwrap();
            }
        } else {
            fs::write(nvm, "unused malformed nvm fallback").unwrap();
        }
        let mut command = crate::spawn::command(std::env::current_exe().unwrap());
        command
            .args(["--exact", test_name, "--nocapture"])
            .env(MARKER, "1")
            .env("HOME", &f.0)
            .env("SHELL", login)
            .env("PATH", &f.0);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
    #[test]
    fn review_valid_path_survives_an_unusable_optional_nvm_directory() {
        valid_path_in_child_with_unusable_nvm(
            "agent::readiness::tests::review_valid_path_survives_an_unusable_optional_nvm_directory", false);
    }
    #[test]
    fn review_valid_path_survives_an_oversized_optional_nvm_directory() {
        valid_path_in_child_with_unusable_nvm(
            "agent::readiness::tests::review_valid_path_survives_an_oversized_optional_nvm_directory", true);
    }
    #[test]
    fn valid_path_does_not_load_a_failing_optional_source() {
        for failure in [
            ProbeError::ProbeFailed,
            ProbeError::Permission,
            ProbeError::OutputLimit,
        ] {
            let f = Fixture::new();
            f.script("claude", "printf '2.1.250 (toy)\\n'");
            let config = ProbeConfig {
                fallbacks: Box::new(move || Err(failure)),
                ..f.config()
            };
            let found = observe_with(config, ROOMY).unwrap().unwrap();
            assert_eq!(found.version.as_deref(), Some("2.1.250 (toy)"));
        }
    }
    #[test]
    fn a_necessary_fallback_source_failure_stays_unavailable() {
        for failure in [
            ProbeError::ProbeFailed,
            ProbeError::Permission,
            ProbeError::OutputLimit,
        ] {
            let f = Fixture::new();
            let config = ProbeConfig {
                fallbacks: Box::new(move || Err(failure)),
                ..f.config()
            };
            assert_eq!(error(observe_with(config, ROOMY)), failure);
        }
    }
    #[test]
    fn lazy_fallback_enumeration_and_version_share_the_original_deadline() {
        let f = Fixture::new();
        let install = Fixture::new();
        // Each step alone fits the budget; together they cannot.
        let binary = install.script("claude", "/bin/sleep 1; printf '2.1.250\\n'");
        let config = ProbeConfig {
            fallbacks: Box::new(move || {
                std::thread::sleep(Duration::from_secs(1));
                Ok(vec![binary])
            }),
            ..f.config()
        };
        let started = Instant::now();
        assert_eq!(
            error(observe_with(config, Duration::from_millis(1500))),
            ProbeError::Timeout
        );
        assert!(started.elapsed() < Duration::from_millis(1500) + SETTLE);
    }
    #[test]
    fn a_necessary_lazy_fallback_list_is_still_bounded() {
        let f = Fixture::new();
        let config = ProbeConfig {
            fallbacks: Box::new(|| {
                Ok((0..257)
                    .map(|at| PathBuf::from(format!("candidate-{at}")))
                    .collect())
            }),
            ..f.config()
        };
        assert_eq!(error(observe_with(config, ROOMY)), ProbeError::OutputLimit);
    }
}
