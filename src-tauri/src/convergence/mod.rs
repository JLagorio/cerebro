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
use crate::ledger::reduce::EpistemicState;

/// Compute one window's output from a store's frames.
pub fn over(
    frames: &[Frame],
    store_uuid: &str,
    window: diff::Window,
) -> Result<diff::Output, String> {
    over_with_now(frames, store_uuid, window).map(|(output, _)| output)
}

/// [`over`], plus the fold at the window's end.
///
/// For the attended answer, which names each line's subject by the file that
/// projects it (M52.4). The name is not part of `Output` — that is
/// content-hashed and stored — so the caller that reads the output aloud gets
/// the fold it was computed from instead of reducing the ledger a third time.
pub fn over_with_now(
    frames: &[Frame],
    store_uuid: &str,
    window: diff::Window,
) -> Result<(diff::Output, EpistemicState), String> {
    let (then, now) = diff::states(frames, store_uuid, window)?;
    let routes = crate::policy::authority::resolvable()?;
    let output = diff::compute(&then, &now, window, &routes);
    Ok((output, now))
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

/// Home starts at the person's Done mark, or the latest stored run's start.
pub fn home_window(
    after_seq: Option<u64>,
    last_run_from: Option<u64>,
    head_seq: u64,
) -> diff::Window {
    diff::Window {
        from_seq: after_seq.or(last_run_from).unwrap_or(0).min(head_seq),
        to_seq: head_seq,
    }
}
/// The newest frame in sequence order supplies the recorded display time.
/// Wall-clock anomalies never reorder the ledger.
pub fn changed_at(frames: &[Frame], window: diff::Window) -> Option<String> {
    frames
        .iter()
        .filter(|f| f.seq > window.from_seq && f.seq <= window.to_seq)
        .max_by_key(|f| f.seq)
        .map(|f| f.ingested_at.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_starts_at_the_mark_then_the_last_run_then_the_beginning() {
        assert_eq!(
            home_window(Some(8), Some(4), 10),
            diff::Window {
                from_seq: 8,
                to_seq: 10
            }
        );
        assert_eq!(
            home_window(None, Some(4), 10),
            diff::Window {
                from_seq: 4,
                to_seq: 10
            }
        );
        assert_eq!(
            home_window(None, None, 10),
            diff::Window {
                from_seq: 0,
                to_seq: 10
            }
        );
        assert_eq!(
            home_window(Some(99), Some(4), 10),
            diff::Window {
                from_seq: 10,
                to_seq: 10
            }
        );
    }
    #[test]
    fn changed_time_is_the_newest_frame_in_the_window_and_quiet_has_none() {
        let frame = |seq: u64, at: &str| Frame {
            v: 0,
            seq,
            event_id: String::new(),
            prev: String::new(),
            hash: String::new(),
            ingested_at: at.into(),
            wall_clock_anomaly: false,
            kind: String::new(),
            body: serde_json::Value::Null,
        };
        let frames = vec![
            frame(1, "2026-07-28T12:00:00Z"),
            frame(2, "2026-07-28T11:59:00Z"),
            frame(3, "2026-07-29T12:00:00Z"),
        ];
        assert_eq!(
            changed_at(
                &frames,
                diff::Window {
                    from_seq: 0,
                    to_seq: 2
                }
            ),
            Some("2026-07-28T11:59:00Z".into())
        );
        assert_eq!(
            changed_at(
                &frames,
                diff::Window {
                    from_seq: 2,
                    to_seq: 2
                }
            ),
            None
        );
    }

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
