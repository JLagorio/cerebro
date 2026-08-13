//! Convergence synthesis (M26.8) — "how did our model change?"
//!
//! [`diff`] is the whole computation: two folds of one ledger, and the typed
//! difference between them. [`store`] keeps a scheduled run's output in
//! app-data, where it is disposable by construction.
//!
//! **There is no narrative object here, and there is not going to be one in
//! M26.** §31's earned-persistence trigger stands: a convergence output is a
//! reading of the ledger, deleting one causes recomputation and nothing else,
//! and no UI copy may call it a Narrative.

pub mod diff;
pub mod store;

use crate::ledger::frame::Frame;

/// Compute one window's output from a store's frames.
pub fn over(
    frames: &[Frame],
    store_uuid: &str,
    window: diff::Window,
) -> Result<diff::Output, String> {
    let (then, now) = diff::states(frames, store_uuid, window)?;
    Ok(diff::compute(&then, &now, window))
}

/// The window a scheduled run should cover: from wherever the last stored run
/// stopped, to the head.
///
/// `None` when there is nothing new to say — the head has not moved past the
/// last run's `to_seq`, so the answer would be the same empty answer. A base
/// nobody is writing to should not be paying for a daily re-read of itself.
pub fn next_window(last_to_seq: Option<u64>, head_seq: u64) -> Option<diff::Window> {
    let from_seq = last_to_seq.unwrap_or(0);
    if head_seq <= from_seq {
        return None;
    }
    Some(diff::Window {
        from_seq,
        to_seq: head_seq,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_nobody_wrote_to_gets_no_scheduled_run() {
        assert_eq!(next_window(Some(40), 40), None);
        assert_eq!(next_window(Some(40), 39), None, "and never a backwards one");
    }

    #[test]
    fn the_first_run_starts_at_the_beginning() {
        assert_eq!(
            next_window(None, 12),
            Some(diff::Window {
                from_seq: 0,
                to_seq: 12
            })
        );
    }

    #[test]
    fn a_later_run_picks_up_where_the_last_stopped() {
        assert_eq!(
            next_window(Some(12), 30),
            Some(diff::Window {
                from_seq: 12,
                to_seq: 30
            })
        );
    }
}
