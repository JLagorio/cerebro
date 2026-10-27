//! Private capture: pure decisions and one native child/pipe owner.
//! Public credential acquisition stays unavailable until trusted provider/owner integration.
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

pub(crate) const PRIVATE_OUTPUT_LIMIT: usize = 16_384;
pub(crate) const CAPTURE_TIMEOUT_MS: u64 = 15_000;

pub(crate) struct PrivateOutput(Vec<u8>);
impl PrivateOutput {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub(crate) fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
    /// Synthetic input only; never widen with a future production module gate.
    #[cfg(test)]
    pub(crate) fn synthetic(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}
impl Drop for PrivateOutput {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureKind {
    InvalidCommand,
    Spawn,
    Pipe,
    OutputLimit,
    TimedOut,
    Cancelled,
    ExitFailure,
    StdoutHeldOpen,
    Cleanup,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChildOwnership {
    NotAcquired,
    Retained,
    Reaped,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupSignalDisposition {
    NotAttempted,
    Sent,
    AlreadyAbsent,
    RefusedOrFailed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupAbsence {
    NotChecked,
    Absent,
    Present,
    Unavailable,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CleanupFacts {
    pub child: ChildOwnership,
    pub term: GroupSignalDisposition,
    pub kill: GroupSignalDisposition,
    pub group: GroupAbsence,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PrivateFailure {
    pub kind: FailureKind,
    pub cleanup: CleanupFacts,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapturePoll {
    Pending,
    Reaping,
    Finished,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReadPoll {
    Bytes(usize),
    Eof,
    WouldBlock,
    Interrupted,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReapPoll {
    Running,
    ReapedSuccess,
    ReapedFailure,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GroupSignal {
    Term,
    Kill,
}
pub(super) trait CaptureDriver {
    fn now(&self) -> Instant;
    fn read_stdout(&mut self, scratch: &mut [u8]) -> ReadPoll;
    fn try_reap(&mut self) -> ReapPoll;
    fn close_stdout(&mut self);
    fn send_group(&mut self, signal: GroupSignal) -> GroupSignalDisposition;
    fn group_absence(&mut self) -> GroupAbsence;
}

struct PrivateScratch([u8; 4096]);
impl Drop for PrivateScratch {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub(super) struct CaptureState {
    started: Instant,
    output: PrivateOutput,
    eof: bool,
    // Some records an actual direct-child reap, never an unavailable observation.
    reaped: Option<bool>,
    failure: Option<FailureKind>,
    cleanup: Option<CleanupFacts>,
    finished: bool,
    result: Option<Result<PrivateOutput, PrivateFailure>>,
}
impl CaptureState {
    pub(super) fn new(started: Instant) -> Self {
        Self {
            started,
            output: PrivateOutput(Vec::with_capacity(PRIVATE_OUTPUT_LIMIT)),
            eof: false,
            reaped: None,
            failure: None,
            cleanup: None,
            finished: false,
            result: None,
        }
    }
    #[cfg(test)]
    pub(super) fn after_child_acquired(started: Instant, failure: FailureKind) -> Self {
        let mut state = Self::new(started);
        state.failure = Some(failure);
        state
    }
    fn interruption(&self, now: Instant, cancelled: bool) -> Option<FailureKind> {
        if cancelled {
            Some(FailureKind::Cancelled)
        } else if now.saturating_duration_since(self.started)
            >= Duration::from_millis(CAPTURE_TIMEOUT_MS)
        {
            Some(if self.reaped.is_some() && !self.eof {
                FailureKind::StdoutHeldOpen
            } else {
                FailureKind::TimedOut
            })
        } else {
            None
        }
    }
    fn discard_output(&mut self) {
        self.output.0.fill(0);
        self.output.0.clear();
    }
    fn observe_reap<D: CaptureDriver>(&mut self, driver: &mut D) {
        if self.reaped.is_some() {
            return;
        }
        match driver.try_reap() {
            ReapPoll::Running => {}
            ReapPoll::ReapedSuccess => self.reaped = Some(true),
            ReapPoll::ReapedFailure => self.reaped = Some(false),
            ReapPoll::Failed => {
                self.failure.get_or_insert(FailureKind::Cleanup);
            }
        }
    }
    fn begin_cleanup<D: CaptureDriver>(&mut self, driver: &mut D) {
        driver.close_stdout();
        if self.failure.is_some() {
            self.discard_output();
        }
        let term = driver.send_group(GroupSignal::Term);
        let kill = driver.send_group(GroupSignal::Kill);
        if !matches!(
            term,
            GroupSignalDisposition::Sent | GroupSignalDisposition::AlreadyAbsent
        ) || !matches!(
            kill,
            GroupSignalDisposition::Sent | GroupSignalDisposition::AlreadyAbsent
        ) {
            self.failure = Some(FailureKind::Cleanup);
            self.discard_output();
        }
        self.cleanup = Some(CleanupFacts {
            child: if self.reaped.is_some() {
                ChildOwnership::Reaped
            } else {
                ChildOwnership::Retained
            },
            term,
            kill,
            group: GroupAbsence::NotChecked,
        });
    }
    fn finish_reaping<D: CaptureDriver>(&mut self, driver: &mut D, cancelled: bool) -> CapturePoll {
        if self.failure.is_none() {
            self.failure = self.interruption(driver.now(), cancelled);
        }
        if self.failure.is_some() {
            self.discard_output();
        }
        if self.reaped.is_none() {
            return CapturePoll::Reaping;
        }
        let mut cleanup = self.cleanup.expect("cleanup began before finalization");
        cleanup.child = ChildOwnership::Reaped;
        cleanup.group = driver.group_absence();
        if cleanup.group != GroupAbsence::Absent {
            self.failure = Some(FailureKind::Cleanup);
        } else if self.failure.is_none() {
            self.failure = self.interruption(driver.now(), cancelled);
        }
        self.cleanup = Some(cleanup);
        self.result = Some(if let Some(kind) = self.failure {
            self.discard_output();
            Err(PrivateFailure { kind, cleanup })
        } else {
            Ok(PrivateOutput(std::mem::take(&mut self.output.0)))
        });
        self.finished = true;
        CapturePoll::Finished
    }
    pub(super) fn poll<D: CaptureDriver>(
        &mut self,
        driver: &mut D,
        cancelled: bool,
    ) -> CapturePoll {
        if self.finished {
            return CapturePoll::Finished;
        }
        if self.cleanup.is_some() {
            self.observe_reap(driver);
            return self.finish_reaping(driver, cancelled);
        }
        if self.failure.is_none() {
            self.failure = self.interruption(driver.now(), cancelled);
        }
        if self.failure.is_none() && !self.eof {
            let mut scratch = PrivateScratch([0; 4096]);
            let read = driver.read_stdout(&mut scratch.0);
            // Refuse bytes returned at the deadline before retaining any of them.
            self.failure = self.interruption(driver.now(), cancelled);
            if self.failure.is_none() {
                match read {
                    ReadPoll::Bytes(count) if count > scratch.0.len() => {
                        self.failure = Some(FailureKind::Pipe);
                    }
                    ReadPoll::Bytes(count)
                        if count > PRIVATE_OUTPUT_LIMIT - self.output.0.len() =>
                    {
                        self.failure = Some(FailureKind::OutputLimit);
                    }
                    ReadPoll::Bytes(count) => self.output.0.extend_from_slice(&scratch.0[..count]),
                    ReadPoll::Eof => self.eof = true,
                    ReadPoll::WouldBlock | ReadPoll::Interrupted => {}
                    ReadPoll::Failed => self.failure = Some(FailureKind::Pipe),
                }
            }
        }
        if self.failure.is_some() {
            self.begin_cleanup(driver);
            self.observe_reap(driver);
            return self.finish_reaping(driver, cancelled);
        }
        self.observe_reap(driver);
        if self.failure.is_none() {
            self.failure = self.interruption(driver.now(), cancelled);
        }
        if self.failure.is_none() && self.reaped == Some(false) {
            self.failure = Some(FailureKind::ExitFailure);
        }
        if self.failure.is_some() || (self.eof && self.reaped == Some(true)) {
            self.begin_cleanup(driver);
            return self.finish_reaping(driver, cancelled);
        }
        CapturePoll::Pending
    }
    #[cfg(test)]
    pub(super) fn retained_len(&self) -> usize {
        self.output.0.len()
    }
    pub(super) fn take_result(&mut self) -> Option<Result<PrivateOutput, PrivateFailure>> {
        self.result.take()
    }
}

#[cfg(test)]
#[path = "private_output_tests.rs"]
mod tests;

/// One owner from successful spawn through actual direct-child reap. Neither
/// private bytes nor the process/pipe handles have a formatting or clone path.
pub(crate) struct PrivateCapture {
    state: CaptureState,
    driver: NativeChildDriver,
}

struct NativeChildDriver {
    child: Child,
    stdout: Option<ChildStdout>,
    pgid: Option<i32>,
    reaped: Option<ExitStatus>,
    #[cfg(test)]
    witness: Option<std::sync::Arc<std::sync::Mutex<NativeWitness>>>,
}

fn before_acquisition_failure(kind: FailureKind) -> PrivateFailure {
    PrivateFailure {
        kind,
        cleanup: CleanupFacts {
            child: ChildOwnership::NotAcquired,
            term: GroupSignalDisposition::NotAttempted,
            kill: GroupSignalDisposition::NotAttempted,
            group: GroupAbsence::NotChecked,
        },
    }
}

pub(crate) fn start_private_output(
    command: &mut Command,
) -> Result<PrivateCapture, PrivateFailure> {
    let mut capture = PrivateCapture::spawn_owned(command)?;
    capture.prepare_stdout();
    Ok(capture)
}

impl PrivateCapture {
    fn spawn_owned(command: &mut Command) -> Result<Self, PrivateFailure> {
        let started = Instant::now();
        if !Path::new(command.get_program()).is_absolute() {
            return Err(before_acquisition_failure(FailureKind::InvalidCommand));
        }
        // Allocate the bounded private buffer before there is a child to own.
        let state = CaptureState::new(started);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        // No environment, argv, shell or PATH fallback is added here. Callers
        // supply their reviewed spawn::command recipe and cleared environment.
        let child = command
            .spawn()
            .map_err(|_| before_acquisition_failure(FailureKind::Spawn))?;
        // Establish the Drop owner before taking the pipe, checking setup,
        // locking a test witness or invoking any callback.
        let mut capture = Self {
            state,
            driver: NativeChildDriver {
                child,
                stdout: None,
                pgid: None,
                reaped: None,
                #[cfg(test)]
                witness: None,
            },
        };
        capture.driver.pgid = i32::try_from(capture.driver.child.id())
            .ok()
            .filter(|pgid| super::signalable(*pgid));
        if capture.driver.pgid.is_none() {
            capture.state.failure = Some(FailureKind::Pipe);
        }
        Ok(capture)
    }

    fn prepare_stdout(&mut self) {
        #[cfg(test)]
        if let Some(pgid) = self.driver.pgid {
            self.driver.record(NativeEvent::Acquired(AcquiredIdentity {
                pid: self.driver.child.id(),
                pgid,
            }));
        }
        if self.state.failure.is_some() {
            return;
        }
        self.driver.stdout = self.driver.child.stdout.take();
        if self.driver.stdout.is_none()
            || self.driver.child.stdin.is_some()
            || self.driver.child.stderr.is_some()
        {
            self.state.failure = Some(FailureKind::Pipe);
            return;
        }
        #[cfg(test)]
        self.driver.record(NativeEvent::StdioReady);
        let ready = self.driver.stdout.as_ref().is_some_and(|stdout| {
            let fd = stdout.as_raw_fd();
            // SAFETY: this capture solely owns the live stdout descriptor;
            // F_GETFL/F_SETFL take integer flags and do not access Rust memory.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 {
                return false;
            }
            // Preserve every pre-existing status flag while adding nonblocking.
            unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0 }
        });
        if !ready {
            self.state.failure = Some(FailureKind::Pipe);
        }
        #[cfg(test)]
        self.driver.record(NativeEvent::NonblockingReady);
    }

    pub(crate) fn poll(&mut self, cancelled: bool) -> CapturePoll {
        self.state.poll(&mut self.driver, cancelled)
    }

    pub(crate) fn take_result(&mut self) -> Option<Result<PrivateOutput, PrivateFailure>> {
        self.state.take_result()
    }

    #[cfg(test)]
    fn retained_len(&self) -> usize {
        self.state.retained_len()
    }
}

impl Drop for PrivateCapture {
    fn drop(&mut self) {
        // Normal owners poll to actual reap. Unwind/early Drop retains the same
        // owner synchronously; it never detaches a waiter or fabricates a reap.
        // An unavailable wait or refused signal can block abnormally. This is
        // intentionally not a hard wall-clock completion guarantee.
        while self.poll(true) != CapturePoll::Finished {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl NativeChildDriver {
    #[cfg(test)]
    fn record(&self, event: NativeEvent) {
        if let Some(witness) = &self.witness {
            match witness.lock() {
                Ok(mut witness) => witness.record(event),
                Err(poisoned) => {
                    // Evidence failure must not panic while Drop owns a child.
                    // The test refuses this witness; no poison is called clean.
                    let mut witness = poisoned.into_inner();
                    witness.overflowed = true;
                    witness.record(event);
                }
            }
        }
    }

    fn signal(&self, signal: GroupSignal) -> GroupSignalDisposition {
        let Some(pgid) = self.pgid.filter(|pgid| super::signalable(*pgid)) else {
            return GroupSignalDisposition::RefusedOrFailed;
        };
        let number = match signal {
            GroupSignal::Term => libc::SIGTERM,
            GroupSignal::Kill => libc::SIGKILL,
        };
        // SAFETY: spawn_owned requested a fresh group led by this owned Child;
        // the shared signalable guard rejects special ids and our own process.
        // Numeric PGID reuse remains the documented existing limitation, also
        // when the pure state machine observed direct reap before cleanup.
        let sent = unsafe { libc::killpg(pgid, number) };
        if sent == 0 {
            GroupSignalDisposition::Sent
        } else if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            GroupSignalDisposition::AlreadyAbsent
        } else {
            GroupSignalDisposition::RefusedOrFailed
        }
    }
}

impl CaptureDriver for NativeChildDriver {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn read_stdout(&mut self, scratch: &mut [u8]) -> ReadPoll {
        let Some(stdout) = self.stdout.as_mut() else {
            return ReadPoll::Failed;
        };
        match stdout.read(scratch) {
            Ok(0) => {
                #[cfg(test)]
                self.record(NativeEvent::StdoutEof);
                ReadPoll::Eof
            }
            Ok(count) => ReadPoll::Bytes(count),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => ReadPoll::Interrupted,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => ReadPoll::WouldBlock,
            Err(_) => ReadPoll::Failed,
        }
    }

    fn try_reap(&mut self) -> ReapPoll {
        let status = if let Some(status) = self.reaped {
            status
        } else {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.reaped = Some(status);
                    #[cfg(test)]
                    self.record(NativeEvent::Reaped(status));
                    status
                }
                Ok(None) => return ReapPoll::Running,
                Err(_) => return ReapPoll::Failed,
            }
        };
        if status.success() {
            ReapPoll::ReapedSuccess
        } else {
            ReapPoll::ReapedFailure
        }
    }

    fn close_stdout(&mut self) {
        drop(self.stdout.take());
        // Also covers unwind before prepare_stdout took the sole child pipe.
        drop(self.child.stdout.take());
    }

    fn send_group(&mut self, signal: GroupSignal) -> GroupSignalDisposition {
        let disposition = self.signal(signal);
        #[cfg(test)]
        self.record(NativeEvent::Signal(signal, disposition));
        disposition
    }

    fn group_absence(&mut self) -> GroupAbsence {
        let absence = match self.pgid.filter(|pgid| super::signalable(*pgid)) {
            Some(pgid) => {
                // SAFETY: signal zero only probes the validated original group;
                // it never delivers a signal or turns EPERM into absence.
                if unsafe { libc::killpg(pgid, 0) } == 0 {
                    GroupAbsence::Present
                } else if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                    GroupAbsence::Absent
                } else {
                    GroupAbsence::Unavailable
                }
            }
            None => GroupAbsence::Unavailable,
        };
        #[cfg(test)]
        self.record(NativeEvent::GroupObserved(absence));
        absence
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AcquiredIdentity {
    pid: u32,
    pgid: i32,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
enum NativeEvent {
    Acquired(AcquiredIdentity),
    StdioReady,
    NonblockingReady,
    StdoutEof,
    Signal(GroupSignal, GroupSignalDisposition),
    Reaped(std::process::ExitStatus),
    GroupObserved(GroupAbsence),
}

#[cfg(test)]
#[derive(Default)]
struct NativeWitness {
    events: Vec<NativeEvent>,
    overflowed: bool,
}

#[cfg(test)]
impl NativeWitness {
    fn record(&mut self, event: NativeEvent) {
        if self.events.len() < 32 {
            self.events.push(event);
        } else {
            self.overflowed = true;
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
enum TestSetupFailure {
    Refused,
}

/// The callback runs only after the capture owns the Child and private pipe.
/// Every post-acquisition setup refusal returns that same owner to the caller.
#[cfg(test)]
fn start_private_output_for_test(
    command: &mut Command,
    witness: std::sync::Arc<std::sync::Mutex<NativeWitness>>,
    after_acquired: &mut dyn FnMut(AcquiredIdentity) -> Result<(), TestSetupFailure>,
) -> Result<PrivateCapture, PrivateFailure> {
    let mut capture = PrivateCapture::spawn_owned(command)?;
    capture.driver.witness = Some(witness);
    capture.prepare_stdout();
    if capture.state.failure.is_none() {
        if let Some(pgid) = capture.driver.pgid {
            let identity = AcquiredIdentity {
                pid: capture.driver.child.id(),
                pgid,
            };
            if after_acquired(identity).is_err() {
                capture.state.failure = Some(FailureKind::Pipe);
            }
        } else {
            capture.state.failure = Some(FailureKind::Pipe);
        }
    }
    Ok(capture)
}

#[cfg(test)]
#[path = "private_output_native_tests.rs"]
mod native_tests;
