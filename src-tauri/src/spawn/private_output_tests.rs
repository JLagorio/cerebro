//! Synthetic OS seams only. No child, clock sleep, file or account is opened.
use super::*;
use std::collections::VecDeque;
use std::time::Duration;

enum ScriptRead {
    Bytes(Vec<u8>),
    Eof,
    WouldBlock,
    Interrupted,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Read,
    Reap,
    Close,
    Signal(GroupSignal),
    GroupProbe,
}
struct Driver {
    started: Instant,
    elapsed: Duration,
    reads: VecDeque<ScriptRead>,
    reap: ReapPoll,
    term: GroupSignalDisposition,
    kill: GroupSignalDisposition,
    group: GroupAbsence,
    actions: Vec<Action>,
}
impl Driver {
    fn new(reads: Vec<ScriptRead>) -> Self {
        Self {
            started: Instant::now(),
            elapsed: Duration::ZERO,
            reads: reads.into(),
            reap: ReapPoll::ReapedSuccess,
            term: GroupSignalDisposition::Sent,
            kill: GroupSignalDisposition::Sent,
            group: GroupAbsence::Absent,
            actions: Vec::new(),
        }
    }
}
impl CaptureDriver for Driver {
    fn now(&self) -> Instant {
        self.started + self.elapsed
    }
    fn read_stdout(&mut self, scratch: &mut [u8]) -> ReadPoll {
        self.actions.push(Action::Read);
        match self.reads.pop_front().unwrap_or(ScriptRead::WouldBlock) {
            ScriptRead::Bytes(mut bytes) => {
                let count = scratch.len().min(bytes.len());
                scratch[..count].copy_from_slice(&bytes[..count]);
                bytes.drain(..count);
                if !bytes.is_empty() {
                    self.reads.push_front(ScriptRead::Bytes(bytes));
                }
                ReadPoll::Bytes(count)
            }
            ScriptRead::Eof => ReadPoll::Eof,
            ScriptRead::WouldBlock => ReadPoll::WouldBlock,
            ScriptRead::Interrupted => ReadPoll::Interrupted,
            ScriptRead::Failed => ReadPoll::Failed,
        }
    }
    fn try_reap(&mut self) -> ReapPoll {
        self.actions.push(Action::Reap);
        self.reap
    }
    fn close_stdout(&mut self) {
        self.actions.push(Action::Close);
    }
    fn send_group(&mut self, signal: GroupSignal) -> GroupSignalDisposition {
        self.actions.push(Action::Signal(signal));
        match signal {
            GroupSignal::Term => self.term,
            GroupSignal::Kill => self.kill,
        }
    }
    fn group_absence(&mut self) -> GroupAbsence {
        self.actions.push(Action::GroupProbe);
        self.group
    }
}
fn finish(state: &mut CaptureState, driver: &mut Driver, cancelled: bool) -> bool {
    for _ in 0..64 {
        if state.poll(driver, cancelled) == CapturePoll::Finished {
            return true;
        }
    }
    false
}
fn output_matches(state: &mut CaptureState, expected: &[u8]) -> bool {
    match state.take_result() {
        Some(Ok(output)) => output.as_bytes() == expected,
        _ => false,
    }
}
fn failed(state: &mut CaptureState) -> Option<PrivateFailure> {
    state.take_result().and_then(Result::err)
}
fn close_precedes_signals(driver: &Driver) -> bool {
    let close = driver.actions.iter().position(|a| *a == Action::Close);
    let term = driver
        .actions
        .iter()
        .position(|a| *a == Action::Signal(GroupSignal::Term));
    let kill = driver
        .actions
        .iter()
        .position(|a| *a == Action::Signal(GroupSignal::Kill));
    matches!((close, term, kill), (Some(c), Some(t), Some(k)) if c < t && t < k)
}

#[test]
fn m96_private_output_success_waits_for_eof_and_reap() {
    let expected = b"synthetic-capture";
    let mut driver = Driver::new(vec![
        ScriptRead::Interrupted,
        ScriptRead::Bytes(expected.to_vec()),
        ScriptRead::WouldBlock,
        ScriptRead::Eof,
    ]);
    driver.reap = ReapPoll::Running;
    let mut state = CaptureState::new(driver.started);
    assert_eq!(state.poll(&mut driver, false), CapturePoll::Pending);
    assert!(
        state.take_result().is_none(),
        "no result before EOF and reap"
    );
    for _ in 0..4 {
        assert_eq!(state.poll(&mut driver, false), CapturePoll::Pending);
    }
    assert!(
        state.take_result().is_none(),
        "EOF alone cannot finish capture"
    );
    driver.reap = ReapPoll::ReapedSuccess;
    assert!(finish(&mut state, &mut driver, false));
    assert!(
        output_matches(&mut state, expected),
        "only the synthetic bytes return"
    );
    assert!(
        state.take_result().is_none(),
        "private output is consumed once"
    );
}

#[test]
fn m96_private_output_cap_is_enforced_before_retention() {
    let exact = vec![b'x'; 16_384];
    let mut exact_driver = Driver::new(vec![ScriptRead::Bytes(exact.clone()), ScriptRead::Eof]);
    let mut exact_state = CaptureState::new(exact_driver.started);
    assert!(finish(&mut exact_state, &mut exact_driver, false));
    assert!(
        output_matches(&mut exact_state, &exact),
        "exact cap must be usable"
    );

    let mut over_driver = Driver::new(vec![ScriptRead::Bytes(vec![b'x'; 16_385]), ScriptRead::Eof]);
    let mut over_state = CaptureState::new(over_driver.started);
    for _ in 0..64 {
        let phase = over_state.poll(&mut over_driver, false);
        assert!(over_state.retained_len() <= 16_384);
        if phase == CapturePoll::Finished {
            break;
        }
    }
    assert_eq!(
        failed(&mut over_state).map(|f| f.kind),
        Some(FailureKind::OutputLimit)
    );
    assert_eq!(over_state.retained_len(), 0);
    assert!(close_precedes_signals(&over_driver));
}

#[test]
fn m96_private_output_deadline_is_inclusive() {
    let mut driver = Driver::new(vec![ScriptRead::WouldBlock]);
    driver.reap = ReapPoll::Running;
    let mut state = CaptureState::new(driver.started);
    driver.elapsed = Duration::from_millis(14_999);
    assert_eq!(state.poll(&mut driver, false), CapturePoll::Pending);
    assert!(state.take_result().is_none());
    driver.elapsed = Duration::from_millis(15_000);
    driver
        .reads
        .push_back(ScriptRead::Bytes(b"too-late".to_vec()));
    let reads_before = driver
        .actions
        .iter()
        .filter(|a| **a == Action::Read)
        .count();
    assert_eq!(state.poll(&mut driver, false), CapturePoll::Reaping);
    assert_eq!(
        driver
            .actions
            .iter()
            .filter(|a| **a == Action::Read)
            .count(),
        reads_before,
        "inclusive deadline refuses the new bytes before reading"
    );
    assert!(
        state.take_result().is_none(),
        "failure retains unreaped ownership"
    );
    driver.reap = ReapPoll::ReapedFailure;
    assert!(finish(&mut state, &mut driver, false));
    assert_eq!(
        failed(&mut state).map(|f| f.kind),
        Some(FailureKind::TimedOut)
    );
    assert!(close_precedes_signals(&driver));
}

#[test]
fn m96_private_output_eof_and_exit_are_distinct() {
    let mut eof_driver = Driver::new(vec![ScriptRead::Eof]);
    eof_driver.reap = ReapPoll::Running;
    let mut eof_state = CaptureState::new(eof_driver.started);
    assert_eq!(eof_state.poll(&mut eof_driver, false), CapturePoll::Pending);
    eof_driver.elapsed = Duration::from_millis(15_000);
    assert_eq!(eof_state.poll(&mut eof_driver, false), CapturePoll::Reaping);
    eof_driver.reap = ReapPoll::ReapedFailure;
    assert!(finish(&mut eof_state, &mut eof_driver, false));
    assert_eq!(
        failed(&mut eof_state).map(|f| f.kind),
        Some(FailureKind::TimedOut)
    );

    let mut exit_driver = Driver::new(vec![ScriptRead::WouldBlock]);
    let mut exit_state = CaptureState::new(exit_driver.started);
    assert_eq!(
        exit_state.poll(&mut exit_driver, false),
        CapturePoll::Pending
    );
    exit_driver.elapsed = Duration::from_millis(15_000);
    assert!(finish(&mut exit_state, &mut exit_driver, false));
    assert_eq!(
        failed(&mut exit_state).map(|f| f.kind),
        Some(FailureKind::StdoutHeldOpen)
    );
    assert!(close_precedes_signals(&exit_driver));
}

#[test]
fn m96_private_output_cancel_failure_retains_one_reap_owner() {
    for (cancelled, first_read, expected) in [
        (true, ScriptRead::WouldBlock, FailureKind::Cancelled),
        (false, ScriptRead::Failed, FailureKind::Pipe),
    ] {
        let mut driver = Driver::new(vec![first_read]);
        driver.reap = ReapPoll::Running;
        let mut state = CaptureState::new(driver.started);
        assert_eq!(state.poll(&mut driver, cancelled), CapturePoll::Reaping);
        assert!(state.take_result().is_none());
        assert_eq!(state.retained_len(), 0);
        assert!(close_precedes_signals(&driver));
        driver.reap = ReapPoll::Failed;
        assert_eq!(
            state.poll(&mut driver, cancelled),
            CapturePoll::Reaping,
            "an unavailable wait observation cannot become a successful reap"
        );
        assert!(state.take_result().is_none());
        driver.reap = ReapPoll::ReapedFailure;
        assert!(finish(&mut state, &mut driver, cancelled));
        let failure = failed(&mut state).expect("finite failure after actual modeled reap");
        assert_eq!(failure.kind, expected);
        assert_eq!(failure.cleanup.child, ChildOwnership::Reaped);
    }
    let mut driver = Driver::new(vec![
        ScriptRead::Bytes(b"must-not-return".to_vec()),
        ScriptRead::Eof,
    ]);
    driver.reap = ReapPoll::ReapedFailure;
    let mut state = CaptureState::new(driver.started);
    assert!(finish(&mut state, &mut driver, false));
    assert_eq!(
        failed(&mut state).map(|f| f.kind),
        Some(FailureKind::ExitFailure)
    );
    assert_eq!(state.retained_len(), 0);
}

#[test]
fn m96_private_output_cleanup_facts_distinguish_delivery_from_exit() {
    for disposition in [
        GroupSignalDisposition::Sent,
        GroupSignalDisposition::AlreadyAbsent,
        GroupSignalDisposition::RefusedOrFailed,
    ] {
        let mut driver = Driver::new(vec![ScriptRead::Failed]);
        driver.term = disposition;
        driver.kill = disposition;
        driver.group = if disposition == GroupSignalDisposition::RefusedOrFailed {
            GroupAbsence::Unavailable
        } else {
            GroupAbsence::Absent
        };
        let mut state = CaptureState::new(driver.started);
        assert!(finish(&mut state, &mut driver, false));
        let failure = failed(&mut state).expect("failure contains finite cleanup facts");
        assert_eq!(failure.cleanup.term, disposition);
        assert_eq!(failure.cleanup.kill, disposition);
        assert_eq!(failure.cleanup.child, ChildOwnership::Reaped);
        assert_eq!(failure.cleanup.group, driver.group);
    }
    for group in [GroupAbsence::Present, GroupAbsence::Unavailable] {
        let mut driver = Driver::new(vec![
            ScriptRead::Bytes(b"not-released".to_vec()),
            ScriptRead::Eof,
        ]);
        driver.group = group;
        let mut state = CaptureState::new(driver.started);
        assert!(finish(&mut state, &mut driver, false));
        let failure = failed(&mut state).expect("uncertain cleanup cannot release output");
        assert_eq!(failure.kind, FailureKind::Cleanup);
        assert_eq!(failure.cleanup.group, group);
    }
    for (refused, term, kill) in [
        (
            "TERM",
            GroupSignalDisposition::RefusedOrFailed,
            GroupSignalDisposition::Sent,
        ),
        (
            "KILL",
            GroupSignalDisposition::Sent,
            GroupSignalDisposition::RefusedOrFailed,
        ),
    ] {
        let mut driver = Driver::new(vec![
            ScriptRead::Bytes(b"must-not-release-on-refusal".to_vec()),
            ScriptRead::Eof,
        ]);
        driver.reap = ReapPoll::ReapedSuccess;
        driver.group = GroupAbsence::Absent;
        driver.term = term;
        driver.kill = kill;
        let mut state = CaptureState::new(driver.started);
        assert!(finish(&mut state, &mut driver, false));
        let result = state.take_result();
        assert!(
            matches!(result.as_ref(), Some(Err(_))),
            "refused {refused} must not release captured output"
        );
        let failure = result
            .and_then(Result::err)
            .expect("refused cleanup has finite failure facts");
        assert_eq!(failure.kind, FailureKind::Cleanup);
        assert_eq!(
            failure.cleanup,
            CleanupFacts {
                child: ChildOwnership::Reaped,
                term,
                kill,
                group: GroupAbsence::Absent,
            }
        );
        assert_eq!(state.retained_len(), 0);
        assert!(state.take_result().is_none());
        assert!(close_precedes_signals(&driver));
    }
}

#[test]
fn m96_private_output_setup_failure_does_not_abandon_started_child() {
    let mut driver = Driver::new(vec![]);
    driver.reap = ReapPoll::Running;
    let mut state = CaptureState::after_child_acquired(driver.started, FailureKind::Pipe);
    assert_eq!(state.poll(&mut driver, false), CapturePoll::Reaping);
    assert!(
        state.take_result().is_none(),
        "post-acquisition failure keeps its child owner"
    );
    assert!(close_precedes_signals(&driver));
    driver.reap = ReapPoll::ReapedFailure;
    assert!(finish(&mut state, &mut driver, false));
    let failure = failed(&mut state).expect("setup failure after direct reap");
    assert_eq!(failure.kind, FailureKind::Pipe);
    assert_eq!(failure.cleanup.child, ChildOwnership::Reaped);
}
