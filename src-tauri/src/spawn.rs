//! Every child process Cerebro starts (M53.10).
//!
//! Two doors, and production code has no other: clippy.toml bans a raw
//! `Command::new` (M53.21), and the one call in [`command`] carries the
//! reasoned exception.
//!
//! - [`command`] builds a call that is waited on: `which`, the
//!   login-shell probe, the CLI's `--version`, the system browser, and git's
//!   local reads. It scrubs the repo-selecting variables and nulls stdin
//!   unless its caller pipes it to write it (its doc names who), and it
//!   leaves the child in our process group (its doc says why). Quick Look
//!   is its one long-lived child: shell::open keeps one, ends the previous
//!   preview on replacement or quit, and a waiter reaps it when it closes.
//! - [`supervise`] starts a run that may have to be ended: the Claude Code
//!   CLI, and git under a deadline (M58.3, `git::command::run_bounded`: the
//!   network calls and each step of a commit). The child leads its own process
//!   group, so ending it ends everything it started inside that group, ssh
//!   and git's remote helpers included. Its stderr is drained while it runs,
//!   into a bounded tail, so a chatty child never blocks on a full pipe.
//!   Whoever finishes it reaps it.
//!
//! The limit, stated rather than discovered: a process that starts its own
//! session (`setsid`) leaves the group, and nothing here reaches it. The CLI's
//! Bash tool runs its shells that way, so Cerebro trusts the CLI to end them
//! when it is sent TERM. That is why ending a run sends TERM first and waits
//! before it sends KILL.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{self, Read};
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Repository-selecting variables that no child may inherit.
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
/// Every child Cerebro starts loses these, the CLI included: [`command`]
/// removes them, and the CLI's spawn hands [`supervise`] a command built by
/// it. A vault operation acts on the vault it was given, never on a
/// repository some ancestor process happened to name, and neither does a
/// shell the CLI opens inside the vault.
pub(crate) const REPO_SELECTING_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

/// How much of a supervised child's stderr is kept: the last 64 KiB.
pub const STDERR_TAIL_BYTES: usize = 64 * 1024;

/// How often a stop, or a finish, looks at the child again.
const POLL: Duration = Duration::from_millis(25);

/// A command built the way every child Cerebro starts is built: the
/// repo-selecting variables removed, stdin null.
///
/// A null stdin because no child Cerebro starts reads a person's typing. A
/// child that prompts (an rc file that asks a question, an ssh host-key
/// check) must fail fast rather than hang the app on a read nobody will
/// answer. A caller that writes its child's stdin pipes it after this, and
/// is the pipe's only writer: git's pathspec and credential input
/// (`git::command`), `check-ignore`'s paths and the clipboard's bytes, and a
/// seated Claude Code run's turn input (M92.13, `agent::turn_input`), which
/// carries the run's prompt and the one context ask, and closes on every
/// path the run ends by.
///
/// It does NOT move the child into a process group of its own, and that is
/// deliberate. When the app runs from a terminal, a process in a background
/// group that touches the terminal is stopped by SIGTTIN or SIGTTOU, and a
/// stopped child is a call that never returns. `zsh -lic` (the login-shell
/// probe) reads the terminal. A run is the opposite case, and [`supervise`]
/// gives it a group. Network git runs supervised under a deadline (M58.3), and
/// that is the cost it pays: from a dev terminal, an ssh host-key or
/// passphrase prompt stops on SIGTTIN and reads as a timeout at the deadline.
/// A packaged app has no terminal, so there the prompt fails at once.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[expect(
        clippy::disallowed_methods,
        reason = "the one door Cerebro's children start through: the scrub and the null stdin \
                  below, and supervise's process group, TERM then KILL, and stderr tail"
    )]
    let mut cmd = Command::new(program);
    for var in REPO_SELECTING_VARS {
        cmd.env_remove(var);
    }
    cmd.stdin(Stdio::null());
    cmd
}

/// Bounded one-shot helpers that return no output. A timeout kills and reaps
/// the whole child group; output is null, so a noisy helper cannot fill a pipe.
pub fn wait_within(cmd: &mut Command, timeout: Duration) -> io::Result<Option<ExitStatus>> {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(POLL),
            result => {
                #[cfg(unix)]
                if let Ok(pid) = i32::try_from(child.id()) {
                    // SAFETY: this child leads the fresh group established above.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
                return result.map(|_| None);
            }
        }
    }
}

/// The end of a supervised child's stderr: the last [`STDERR_TAIL_BYTES`] it
/// wrote, and a count of the bytes that scrolled out before them.
#[derive(Debug, Clone)]
pub struct StderrTail {
    bytes: VecDeque<u8>,
    cap: usize,
    dropped: u64,
    /// Stderr had not closed when the child was finished: the child is gone,
    /// but a process outside its group still holds the pipe. What was read
    /// before then is kept; whatever that process writes later is not.
    held_open: bool,
}

impl Default for StderrTail {
    fn default() -> Self {
        Self::with_cap(STDERR_TAIL_BYTES)
    }
}

impl StderrTail {
    fn with_cap(cap: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            cap,
            dropped: 0,
            held_open: false,
        }
    }

    /// Keep `chunk`, and drop from the front whatever no longer fits.
    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.cap {
            let skipped = chunk.len() - self.cap;
            self.dropped += (self.bytes.len() + skipped) as u64;
            self.bytes.clear();
            self.bytes.extend(&chunk[skipped..]);
            return;
        }
        let overflow = (self.bytes.len() + chunk.len()).saturating_sub(self.cap);
        self.bytes.drain(..overflow);
        self.dropped += overflow as u64;
        self.bytes.extend(chunk);
    }

    /// Bytes kept.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Bytes written before the kept ones, and not kept.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Whether stderr was still open when the child was finished.
    pub fn held_open(&self) -> bool {
        self.held_open
    }

    /// What was kept, decoded lossily. A tail that lost its start begins in
    /// the middle of whatever was being written, so a character cut in half
    /// there is skipped rather than shown as a replacement mark.
    fn kept(&self) -> String {
        let (front, back) = self.bytes.as_slices();
        let mut raw = Vec::with_capacity(self.bytes.len());
        raw.extend_from_slice(front);
        raw.extend_from_slice(back);
        let cut = if self.dropped > 0 {
            raw.iter()
                .take(3)
                .take_while(|byte| (**byte & 0b1100_0000) == 0b1000_0000)
                .count()
        } else {
            0
        };
        String::from_utf8_lossy(&raw[cut..]).into_owned()
    }

    /// Everything kept, prefixed with how much was not, and followed by a
    /// note when stderr was still held open.
    pub fn text(&self) -> String {
        let mut text = self.kept();
        if self.dropped > 0 {
            text = format!(
                "[{} earlier bytes of stderr were not kept]\n{text}",
                self.dropped
            );
        }
        if self.held_open {
            text.push_str("\n[stderr was still held open by a process outside the run's group]");
        }
        text
    }

    /// The last `n` characters kept, trailing whitespace trimmed: what a
    /// failure message has room for. A cut tail starts with `…`, counted
    /// inside the `n`.
    pub fn last_chars(&self, n: usize) -> String {
        let kept = self.kept();
        let trimmed = kept.trim_end();
        let count = trimmed.chars().count();
        if count <= n {
            return trimmed.to_string();
        }
        if n == 0 {
            return String::new();
        }
        let end: String = trimmed.chars().skip(count - (n - 1)).collect();
        format!("…{end}")
    }
}

/// The lock, poisoned or not. Neither a `Child` nor a tail is left half
/// updated by a panic elsewhere, so a poisoned guard is still a good one.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A child started by [`supervise`]: the leader of its own process group,
/// its stderr drained into a tail while it runs.
pub struct Supervised {
    child: Arc<Mutex<Child>>,
    pgid: i32,
    tail: Arc<Mutex<StderrTail>>,
    drained: Receiver<()>,
}

/// Start `cmd` as a supervised run.
///
/// The child leads a new process group (on unix), so [`Handle::terminate`]
/// reaches everything it starts in that group. stdout comes back to the
/// caller, which reads it to the end. stderr never does: a thread reads it in
/// 8 KiB chunks into a [`StderrTail`] for as long as it stays open, so a child
/// that writes a flood to stderr is never blocked by a full pipe while its
/// reader waits on stdout.
///
/// Build `cmd` with [`command`], so the child loses the repo-selecting
/// variables and gets a null stdin, unless the caller piped it to write it
/// ([`Supervised::take_stdin`]).
pub fn supervise(cmd: &mut Command) -> io::Result<(Supervised, ChildStdout)> {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        // Both were piped above, so this cannot happen; if it ever does, no
        // child is left behind for it.
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other(
            "the child started without its output pipes",
        ));
    };
    let Ok(pgid) = i32::try_from(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other(
            "the child's pid does not fit a process group id",
        ));
    };
    let tail = Arc::new(Mutex::new(StderrTail::default()));
    let sink = tail.clone();
    let (closed, drained) = mpsc::sync_channel::<()>(1);
    let drain = std::thread::Builder::new()
        .name("cerebro-stderr".into())
        .spawn(move || {
            let mut chunk = [0u8; 8 * 1024];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => lock(&sink).push(&chunk[..n]),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = closed.send(());
        });
    if let Err(error) = drain {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((
        Supervised {
            child: Arc::new(Mutex::new(child)),
            pgid,
            tail,
            drained,
        },
        stdout,
    ))
}

impl Supervised {
    /// The child's stdin, once, when `cmd` piped it before [`supervise`]
    /// (M58.3: git reads a pathspec list there; M92.13: a seated run reads
    /// its turn input there). Dropping it closes the pipe.
    pub fn take_stdin(&self) -> Option<std::process::ChildStdin> {
        lock(&self.child).stdin.take()
    }

    /// A handle that can ask after the child, and end it, from any thread.
    pub fn handle(&self) -> Handle {
        Handle {
            child: self.child.clone(),
            pgid: self.pgid,
        }
    }

    /// Reap the child and collect its stderr tail. Called once its stdout has
    /// closed, so the wait is normally a poll or two.
    ///
    /// It polls `try_wait` and holds the lock for one poll at a time, never
    /// across a blocking wait: a Stop arriving meanwhile takes the same lock
    /// to ask whether the child is alive, and it must never queue behind the
    /// very exit it is trying to cause. Then it waits up to `tail_wait` for
    /// stderr to close. A tail that does not close in time comes back with
    /// what was read so far, marked held open: the pipe is held by a process
    /// that left the group, and a run is not kept waiting on it.
    pub fn finish(self, tail_wait: Duration) -> (Option<ExitStatus>, StderrTail) {
        let status = loop {
            let polled = lock(&self.child).try_wait();
            match polled {
                Ok(Some(status)) => break Some(status),
                Ok(None) => std::thread::sleep(POLL),
                Err(_) => break None,
            }
        };
        let held_open = matches!(
            self.drained.recv_timeout(tail_wait),
            Err(RecvTimeoutError::Timeout)
        );
        let mut tail = lock(&self.tail).clone();
        tail.held_open = held_open;
        (status, tail)
    }
}

/// A shared handle on a supervised child.
#[derive(Clone)]
pub struct Handle {
    child: Arc<Mutex<Child>>,
    pgid: i32,
}

#[cfg(all(target_os = "macos", any(test, feature = "native-action-smoke")))]
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub(crate) struct NativeActionChildIdentity {
    pub(crate) pid: u32,
    pub(crate) parent_pid: u32,
    pub(crate) group_pid: u32,
    pub(crate) uid: u32,
    pub(crate) start_seconds: u64,
    pub(crate) start_micros: u64,
}

impl Handle {
    /// Finite metadata from this retained owning Child only. No arbitrary PID,
    /// waiter, signal or native/action authority is accepted or returned.
    #[cfg(all(target_os = "macos", any(test, feature = "native-action-smoke")))]
    pub(crate) fn native_action_identity(&self) -> io::Result<NativeActionChildIdentity> {
        // This mutex retains the actual Child across the observation. Its PID is
        // never accepted from a caller. Do not consume status via try_wait/wait.
        let child = self
            .child
            .lock()
            .map_err(|_| io::Error::other("Original child ownership is unavailable."))?;
        let pid = child.id();
        let requested = i32::try_from(pid)
            .map_err(|_| io::Error::other("Original child identity is unavailable."))?;
        if requested <= 1 || self.pgid != requested {
            return Err(io::Error::other("Original child group differs."));
        }
        let parent = std::process::id();
        // SAFETY: geteuid observes only this process's effective user identity.
        let uid = unsafe { libc::geteuid() };
        // SAFETY: proc_bsdinfo contains integer fields; zero is valid storage.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = i32::try_from(std::mem::size_of_val(&info))
            .map_err(|_| io::Error::other("Original child identity ABI differs."))?;
        if size != 136 {
            return Err(io::Error::other("Original child identity ABI differs."));
        }
        // SAFETY: Darwin's thread-local errno pointer is valid on this thread.
        let errno = unsafe { libc::__error() };
        // SAFETY: the fixed BSD flavor writes at most the declared, correctly
        // sized buffer. Clear/copy errno immediately around this one read; no
        // formatting/allocation/other FFI intervenes. Arg 1 includes retained
        // exited children, whose original identity still needs later cleanup.
        let (returned, error) = unsafe {
            *errno = 0;
            let returned = libc::proc_pidinfo(
                requested,
                libc::PROC_PIDTBSDINFO,
                1,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            );
            (returned, *errno)
        };
        if returned != size {
            return Err(if error > 0 {
                io::Error::from_raw_os_error(error)
            } else {
                io::Error::other("Original child identity read was incomplete.")
            });
        }
        // Decode only a full read, bound to this actual owning parent/user and
        // the private group established by supervise. Metadata confers no
        // process, native-origin, grant or action authority.
        if info.pbi_pid != pid
            || info.pbi_ppid != parent
            || info.pbi_pgid != pid
            || info.pbi_uid != uid
            || info.pbi_start_tvsec == 0
            || info.pbi_start_tvusec >= 1_000_000
        {
            return Err(io::Error::other("Original child identity differs."));
        }
        Ok(NativeActionChildIdentity {
            pid,
            parent_pid: info.pbi_ppid,
            group_pid: info.pbi_pgid,
            uid: info.pbi_uid,
            start_seconds: info.pbi_start_tvsec,
            start_micros: info.pbi_start_tvusec,
        })
    }
    #[cfg(all(feature = "native-read-smoke", target_os = "macos"))]
    pub(crate) fn native_restart_retain(
        self,
        prepared: crate::native_read_smoke::child_claim_profile::restart_profile::Prepared,
        cancelled: Arc<std::sync::atomic::AtomicBool>,
        closing: Arc<std::sync::atomic::AtomicBool>,
    ) -> ! {
        native_restart::retain(self, prepared, cancelled, closing)
    }

    /// The child's pid, which is also its process group's id.
    pub fn id(&self) -> u32 {
        lock(&self.child).id()
    }

    /// Is the leader still running? `try_wait` under the lock, so this may be
    /// what reaps it; std caches the exit status, so whichever thread reaps
    /// first, every later look sees the same answer.
    pub fn alive(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(None))
    }

    /// End the run: TERM to its group if the leader is alive, up to `grace`
    /// for it to go, then KILL to the group. Blocks for up to `grace`.
    pub fn terminate(&self, grace: Duration) {
        terminate_all(std::slice::from_ref(self), grace);
    }

    /// [`Handle::terminate`] on a thread of its own, so a stop answers at
    /// once and the grace is spent elsewhere.
    pub fn terminate_later(&self, grace: Duration) {
        let handle = self.clone();
        let spawned = std::thread::Builder::new()
            .name("cerebro-stop".into())
            .spawn(move || handle.terminate(grace));
        if spawned.is_err() {
            // No thread to spend the grace on: end it now, without one.
            self.terminate(Duration::ZERO);
        }
    }

    fn signal(&self, signal: Signal) {
        #[cfg(unix)]
        {
            let _ = signal_group(self.pgid, signal);
        }
        #[cfg(not(unix))]
        {
            // No process groups to reach here: the leader is all std can
            // signal, and killing it is all std can do to it.
            let _ = (signal, self.pgid);
            let _ = lock(&self.child).kill();
        }
    }
}

/// End several runs on one shared grace: TERM every group whose leader is
/// alive, wait until none is or `grace` runs out, then KILL every group.
///
/// KILL goes to every group, the ones whose leader already exited included:
/// a leader that leaves on TERM can leave children behind in its group, and a
/// group with nobody left in it answers "no such process", which is what the
/// KILL was for. A group id stays reserved only while a member is alive, so an
/// id freed during the grace could in principle be reused by an unrelated
/// group before the KILL lands. That needs the pid space to wrap within two
/// seconds, and it is accepted rather than handled.
pub fn terminate_all(handles: &[Handle], grace: Duration) {
    let mut asked = false;
    for handle in handles {
        if handle.alive() {
            handle.signal(Signal::Term);
            asked = true;
        }
    }
    if asked {
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline && handles.iter().any(Handle::alive) {
            std::thread::sleep(POLL);
        }
    }
    for handle in handles {
        handle.signal(Signal::Kill);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    Term,
    Kill,
}

/// May `pgid` be signalled as a group? Never 0 (our own group), never 1
/// (init's), never the negative ids, and never our own pid.
#[cfg(unix)]
fn signalable(pgid: i32) -> bool {
    pgid > 1 && u32::try_from(pgid).is_ok_and(|id| id != std::process::id())
}

/// Signal a whole process group. A group that no longer exists is success:
/// everything in it has already gone, which is what the signal was for.
#[cfg(unix)]
fn signal_group(pgid: i32, signal: Signal) -> io::Result<()> {
    if !signalable(pgid) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to signal process group {pgid}"),
        ));
    }
    let number = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: killpg takes two integers and touches no memory of ours, so no
    // Rust invariant rides on it. What it may reach is answered above it:
    // `signalable` refuses 0, 1, the negative ids and our own pid, and the
    // only ids that get here are pids of children `supervise` made leaders.
    let sent = unsafe { libc::killpg(pgid, number) };
    if sent == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn wait_within_kills_a_child_past_its_limit() {
        let started = std::time::Instant::now();
        let result = super::wait_within(
            super::command("/bin/sh").args(["-c", "sleep 30"]),
            std::time::Duration::from_millis(25),
        )
        .unwrap();
        assert!(result.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }
    use super::*;
    #[cfg(unix)]
    use std::io::{BufRead, BufReader};

    /// Poll `done` until it holds or `limit` runs out.
    #[cfg(unix)]
    fn within(limit: Duration, done: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            if done() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL);
        }
    }

    /// Is `pid` still a live process? Asked of `ps`, so the test needs no
    /// signal of its own to find out. A zombie counts as gone.
    #[cfg(unix)]
    fn running(pid: u32) -> bool {
        command("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|out| {
                let stat = String::from_utf8_lossy(&out.stdout);
                out.status.success() && !stat.trim().is_empty() && !stat.trim().starts_with('Z')
            })
            .unwrap_or(false)
    }

    /// Start `script` under `sh`, supervised, and read its first stdout line
    /// (the script's signal that it is ready). The reader keeps the rest.
    #[cfg(unix)]
    fn started(script: &str) -> (Supervised, String, BufReader<ChildStdout>) {
        let (supervised, stdout) = supervise(command("sh").args(["-c", script])).unwrap();
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        (supervised, first.trim().to_string(), reader)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_action_identity_observes_only_the_genuine_retained_child_without_consuming_it() {
        let (supervised, announced, reader) = started("echo $$; exec sleep 30");
        let handle = supervised.handle();
        let actual = handle.id();
        let first = handle.native_action_identity();
        let second = handle.native_action_identity();
        let still_alive = handle.alive();
        // All assertions follow real owned cleanup even while the API is RED.
        handle.terminate(Duration::from_millis(100));
        drop(reader);
        let (status, _) = supervised.finish(Duration::from_secs(1));
        assert!(status.is_some());
        assert!(
            still_alive,
            "identity read must not wait/reap/stop the original child"
        );
        assert_eq!(announced.parse::<u32>().unwrap(), actual);
        let first = first.expect("owning Handle must provide exact original BSD start identity");
        let second = second.unwrap();
        assert_eq!(first.pid, actual);
        assert_eq!(first.parent_pid, std::process::id());
        assert_eq!(first.group_pid, actual);
        assert!(first.start_seconds > 0);
        assert!(first.start_micros < 1_000_000);
        assert_eq!(
            (first.pid, first.start_seconds, first.start_micros),
            (second.pid, second.start_seconds, second.start_micros)
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_action_identity_refuses_changed_group_metadata_without_targeting_or_stopping_it() {
        let (supervised, _, reader) = started("echo $$; exec sleep 30");
        let handle = supervised.handle();
        let mut changed = handle.clone();
        changed.pgid = changed.pgid.checked_add(1).unwrap();
        let refused = changed.native_action_identity().is_err();
        let alive = handle.alive();
        handle.terminate(Duration::from_millis(100));
        drop(reader);
        let (status, _) = supervised.finish(Duration::from_secs(1));
        assert!(status.is_some());
        assert!(refused);
        assert!(alive, "metadata refusal must leave the genuine owner alive");
    }

    #[test]
    fn the_tail_keeps_the_last_64_kib_and_counts_what_it_dropped() {
        let mut tail = StderrTail::default();
        assert!(tail.is_empty());
        tail.push(b"early ");
        assert_eq!(tail.len(), 6);
        assert_eq!(tail.dropped(), 0);
        assert_eq!(tail.text(), "early ");

        // One chunk past the cap: the front scrolls out, byte for byte.
        let flood = vec![b'x'; STDERR_TAIL_BYTES];
        tail.push(&flood);
        assert_eq!(tail.len(), STDERR_TAIL_BYTES);
        assert_eq!(tail.dropped(), 6);
        tail.push(b"\nfatal: the end\n");
        assert_eq!(tail.len(), STDERR_TAIL_BYTES);
        assert_eq!(tail.dropped(), 6 + 16);
        assert!(tail
            .text()
            .starts_with("[22 earlier bytes of stderr were not kept]\n"));
        assert!(tail.text().ends_with("fatal: the end\n"));

        // A single chunk bigger than the whole tail keeps only its own end.
        let mut big = StderrTail::with_cap(8);
        big.push(b"abc");
        big.push(b"0123456789");
        assert_eq!(big.text().lines().last(), Some("23456789"));
        assert_eq!(big.dropped(), 3 + 2);

        // The last characters, trailing whitespace trimmed, inside the limit.
        let mut short = StderrTail::default();
        short.push(b"warning: x\nfatal: the end\n\n");
        assert_eq!(short.last_chars(100), "warning: x\nfatal: the end");
        let cut = short.last_chars(8);
        assert_eq!(cut, "…the end");
        assert_eq!(cut.chars().count(), 8);
        assert!(tail.last_chars(2000).ends_with("fatal: the end"));
        assert_eq!(tail.last_chars(2000).chars().count(), 2000);

        // A tail that starts inside a character skips its broken half.
        let mut wide = StderrTail::with_cap(4);
        wide.push("aé€".as_bytes()); // 1 + 2 + 3 bytes: the cut lands inside é
        assert_eq!(wide.last_chars(10), "€");
    }

    // M92.13: a caller that pipes stdin writes it and closes it; every other
    // child reads a null one, which ends a read at once.
    #[cfg(unix)]
    #[test]
    fn a_piped_stdin_is_the_callers_to_write_and_to_close() {
        use std::io::Write;
        const ECHO: &str = "cat; echo closed";
        let mut cmd = command("sh");
        cmd.args(["-c", ECHO]).stdin(Stdio::piped());
        let (supervised, mut stdout) = supervise(&mut cmd).unwrap();
        let mut stdin = supervised.take_stdin().expect("piped before supervise");
        assert!(supervised.take_stdin().is_none(), "taken once");
        stdin.write_all(b"one line\n").unwrap();
        drop(stdin);
        let mut out = String::new();
        stdout.read_to_string(&mut out).unwrap();
        assert_eq!(out, "one line\nclosed\n", "the close is the child's EOF");
        assert!(supervised
            .finish(Duration::from_secs(1))
            .0
            .unwrap()
            .success());

        let (supervised, mut stdout) = supervise(command("sh").args(["-c", ECHO])).unwrap();
        assert!(supervised.take_stdin().is_none(), "nobody's to write");
        let mut out = String::new();
        stdout.read_to_string(&mut out).unwrap();
        assert_eq!(out, "closed\n");
        assert!(supervised
            .finish(Duration::from_secs(1))
            .0
            .unwrap()
            .success());
    }

    #[test]
    fn every_repo_selecting_variable_is_removed_from_every_child() {
        let cmd = command("true");
        let removed: Vec<String> = cmd
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        for var in REPO_SELECTING_VARS {
            assert!(
                removed.iter().any(|r| r == var),
                "{var} survives into the child"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_supervised_child_leads_its_own_process_group() {
        let (supervised, pgid, _rest) = started("ps -o pgid= -p $$");
        let pid = supervised.handle().id();
        assert_eq!(pgid, pid.to_string(), "the child is its own group's leader");
        let (status, _) = supervised.finish(Duration::from_secs(1));
        assert!(status.unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn terminate_sends_term_first_so_a_child_can_clean_up() {
        let (supervised, ready, _rest) =
            started("trap 'echo bye >&2; exit 0' TERM; echo ready; while :; do sleep 0.05; done");
        assert_eq!(ready, "ready", "the trap is set before anything is sent");
        supervised.handle().terminate(Duration::from_secs(5));
        let (status, tail) = supervised.finish(Duration::from_secs(1));
        assert!(
            status.unwrap().success(),
            "it left through its own trap, not to a KILL"
        );
        // The shell may report "Terminated: 15" for its foreground sleep
        // when the group receives TERM. Its final line and successful exit
        // prove the cleanup trap still ran before we could send KILL.
        assert_eq!(tail.last_chars(100).lines().last(), Some("bye"));
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_ignores_term_is_ended_after_the_grace() {
        use std::os::unix::process::ExitStatusExt;
        let (supervised, ready, _rest) =
            started("trap '' TERM; echo ready; while :; do sleep 0.05; done");
        assert_eq!(ready, "ready");
        let started_at = Instant::now();
        supervised.handle().terminate(Duration::from_millis(300));
        let (status, _) = supervised.finish(Duration::from_secs(1));
        assert!(
            started_at.elapsed() < Duration::from_secs(2),
            "ended within the grace and a KILL, took {:?}",
            started_at.elapsed()
        );
        assert_eq!(status.unwrap().signal(), Some(libc::SIGKILL));
    }

    #[cfg(unix)]
    #[test]
    fn a_grandchild_in_the_group_ends_with_it() {
        let (supervised, grandchild, _rest) = started("sleep 30 & echo $!; wait");
        let grandchild: u32 = grandchild.parse().unwrap();
        assert!(running(grandchild), "the grandchild is up before the stop");
        supervised.handle().terminate(Duration::from_secs(2));
        let _ = supervised.finish(Duration::from_secs(1));
        assert!(
            within(Duration::from_secs(3), || !running(grandchild)),
            "the grandchild outlived its group"
        );
    }

    /// The stated limit, pinned so nobody mistakes it for a bug that was
    /// fixed: a process that starts its own session has left the group, and
    /// ending the group does not reach it. The CLI runs its Bash tool's
    /// shells that way, which is why Cerebro sends TERM first and waits.
    #[cfg(unix)]
    #[test]
    fn a_process_that_starts_its_own_session_outlives_the_group_and_that_is_the_stated_limit() {
        // Perl's setsid announces its pid only once it has left, and gives up
        // the run's pipes before it execs, so the run's stdio closes with it.
        const LEAVE: &str = r#"use POSIX (); POSIX::setsid() or die "setsid: $!"; $| = 1; print "$$\n"; open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null"; exec "sleep", "20";"#;
        let (supervised, escaped, _rest) = started(&format!("perl -e '{LEAVE}' & wait"));
        let escaped: u32 = escaped.parse().unwrap();
        supervised.handle().terminate(Duration::from_millis(300));
        let (status, _) = supervised.finish(Duration::from_secs(1));
        assert!(status.is_some(), "the run itself ended");
        let survived = running(escaped);
        // End it by pid whatever happened, so the test leaves nothing behind.
        let _ = command("kill").arg(escaped.to_string()).status();
        assert!(survived, "a new session is outside the group's reach");
        assert!(within(Duration::from_secs(3), || !running(escaped)));
    }

    #[cfg(unix)]
    #[test]
    fn a_signal_never_reaches_our_own_group_or_pid_one() {
        let own = i32::try_from(std::process::id()).unwrap();
        for pgid in [0, 1, -5, own] {
            assert!(!signalable(pgid), "{pgid} must never be signalled");
        }
        assert!(signalable(own + 1), "any other group may be");
        // Refused before anything is sent. 1 and -5 are the two the kernel
        // would also turn down, so the refusal is told apart by its words.
        for pgid in [1, -5] {
            let refusal = signal_group(pgid, Signal::Term).unwrap_err();
            assert_eq!(refusal.kind(), io::ErrorKind::InvalidInput);
            assert!(refusal.to_string().contains("refusing"), "{refusal}");
        }
    }
}

#[cfg(all(feature = "native-read-smoke", target_os = "macos"))]
#[path = "native_restart_retention.rs"]
mod native_restart;
#[cfg(all(feature = "native-read-smoke", target_os = "macos"))]
pub(crate) fn native_restart_toy(root: &std::path::Path) -> ! {
    native_restart::toy(root)
}

// M96.2 accepted private capture, used only by the native gh adapter.
#[cfg(target_os = "macos")]
#[path = "spawn/private_output.rs"]
pub(crate) mod private_output;

pub(crate) mod retained_thread;
