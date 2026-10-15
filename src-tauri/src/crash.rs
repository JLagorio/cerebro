//! Crash-injection seam for crash-safety tests (M21).
//!
//! `crash_point(name)` is a no-op unless the process was launched with
//! `CEREBRO_CRASH_POINT=<name>`, in which case it aborts on the spot — no
//! unwinding, no destructors, no buffered-IO flushing: the closest a test can
//! get to `kill -9` at an exact line. Crash tests spawn the current test
//! binary as a child with the variable armed (see `vault::testutil`) and
//! assert filesystem post-conditions from the parent.

/// Abort the process here iff `CEREBRO_CRASH_POINT` names this point.
pub fn crash_point(name: &str) {
    if std::env::var("CEREBRO_CRASH_POINT").as_deref() == Ok(name) {
        std::process::abort();
    }
}

/// Exit the process here, cleanly, iff `CEREBRO_STOP_POINT` names this
/// point (M60.6): `std::process::exit(86)`, never an abort, so a test can
/// stop a batch between two steps without the crash harness. The Mac runs
/// these children; only the abort-based crash tests are left to CI's Linux
/// job. Test builds only.
#[cfg(test)]
pub fn stop_point(name: &str) {
    if std::env::var("CEREBRO_STOP_POINT").as_deref() == Ok(name) {
        std::process::exit(86);
    }
}

/// Outside tests a stop point is nothing.
#[cfg(not(test))]
#[inline(always)]
pub fn stop_point(_name: &str) {}
