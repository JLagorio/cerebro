//! Retained ownership of one already-spawned background writer thread.
//! No queue, scheduling or detached cleanup; callers retain the owner on timeout.
use std::{
    thread::JoinHandle,
    time::{Duration, Instant},
};
pub(crate) struct RetainedThread {
    handle: Option<JoinHandle<()>>,
    failed: bool,
}
impl RetainedThread {
    pub(crate) fn new(handle: JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
            failed: false,
        }
    }
    pub(crate) fn wait_within(&mut self, timeout: Duration) -> Result<(), String> {
        if self.failed {
            return Err("A background writer ended without confirmed cleanup.".into());
        }
        let deadline = Instant::now() + timeout;
        while self
            .handle
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            if Instant::now() >= deadline {
                return Err("A background writer has not finished stopping.".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(handle) = self.handle.take() {
            if handle.join().is_err() {
                self.failed = true;
                return Err("A background writer ended without confirmed cleanup.".into());
            }
        }
        Ok(())
    }
}
impl Drop for RetainedThread {
    fn drop(&mut self) {
        // A forgotten/unwinding owner cannot detach a still-writing thread.
        // Normal stop retains this object on timeout. This last-resort join may
        // block on abnormal OS/I/O state; it is not a wall-clock guarantee.
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod failed_join_tests {
    use super::*;
    #[test]
    fn a_panicked_writer_never_becomes_confirmed_cleanup_on_second_wait() {
        let handle = std::thread::spawn(|| panic!("synthetic owned writer failure"));
        let mut owner = RetainedThread::new(handle);
        let first = owner.wait_within(Duration::from_secs(2));
        let second = owner.wait_within(Duration::ZERO);
        assert!(first.is_err());
        assert!(
            second.is_err(),
            "a consumed panicked handle must retain sticky unconfirmed cleanup"
        );
    }
}
