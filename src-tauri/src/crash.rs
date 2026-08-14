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
