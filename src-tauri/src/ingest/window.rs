//! The settled change-window (M26.4b) — what one pass will and will not spend
//! a model on.
//!
//! M25's prefilter answers one item at a time. This answers a WINDOW: given
//! everything the deterministic pass assessed, it partitions the items into
//! the ones already finished and the ones that still need a model, and mints
//! exactly one semantic run for the second group.
//!
//! **One run, or none.** Not one per file and not one per role — Observer,
//! Extractor, Resolver and Proposer share a single run over the whole
//! residual. `Plan::window` is an `Option`, so "at most one" is the type
//! rather than a rule somebody enforces.
//!
//! **An all-deterministic window costs nothing.** If every item routed
//! somewhere terminal, there is no window and no run. This is the property
//! the prefilter was built to buy, and it is the one worth asserting: a pass
//! that quietly spent a run to conclude "nothing to do" would pass every
//! other test in this file.
//!
//! **Neither branch loses work.** Every assessed item lands in exactly one of
//! the two halves. `material_candidate` with a deterministic mapper closes;
//! `material_candidate` without one queues; `needs_semantic_judgment` queues.
//! Nothing is dropped for being awkward, which is the failure this partition
//! is shaped to make impossible rather than to test for.
//!
//! **The window is given, not chosen here.** What counts as settled — how
//! long the edits have to stop, which lane the items came from — is M25's
//! scheduler's question. This module takes the set it is handed. A window too
//! large to assemble is therefore a real possibility, and its answer is
//! M26.4c's: a `batch_input_incomplete` block, not a silent split, because
//! splitting would make "one run per settled window" false.

use std::collections::BTreeSet;

use crate::ledger::schema::{derive_m26_batch_key, derive_semantic_assessment_id, Route};
use crate::runtime::scheduler::SchedulerState;

/// One item the deterministic pass has assessed and receipted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessed {
    pub receipt_id: String,
    pub item_id: String,
    pub route: Route,
}

/// An item the deterministic pass finished. It costs no run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closed {
    pub receipt_id: String,
    pub item_id: String,
    pub route: Route,
    /// Where M25's scheduler puts it — read from [`Route::scheduler_state`]
    /// rather than decided again here.
    pub landed: SchedulerState,
}

/// The one semantic run this window needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub batch_key: String,
    /// Precomputed so the caller commits the id it planned rather than one it
    /// derives again later from a set that may have moved.
    pub assessment_id: String,
    /// Sorted, duplicate-free — the shape `IngestSemanticAssessed` requires.
    pub input_receipt_ids: Vec<String>,
}

/// What the pass will do with one settled window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub closed: Vec<Closed>,
    pub window: Option<Window>,
}

impl Plan {
    /// Zero or one. There is no third answer, and that is the point.
    pub fn runs_needed(self: &Plan) -> usize {
        usize::from(self.window.is_some())
    }
}

/// Partition a settled window's assessments into "already done" and "needs
/// one run".
///
/// Refuses rather than guesses on three inputs that mean the caller is
/// confused about what a window is: a repeated receipt, an item with no
/// receipt id, and a TERMINAL successor route. The last one matters most —
/// `m26_completed` and `failed_visible` are how a window CLOSES, so feeding
/// one back in as fresh work is a loop, and a loop that spends a run each
/// time round.
pub fn plan(store_id: &str, assessed: &[Assessed]) -> Result<Plan, String> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut closed = Vec::new();
    let mut queued = Vec::new();

    for item in assessed {
        if item.receipt_id.is_empty() {
            return Err(format!(
                "item {} has no receipt id — a window is built from receipts, and an item \
                 without one has not been assessed yet",
                item.item_id
            ));
        }
        if !seen.insert(item.receipt_id.as_str()) {
            return Err(format!(
                "receipt {} appears twice in one window — the window key is derived from this \
                 set, so a repeat would change what window this is",
                item.receipt_id
            ));
        }
        match item.route {
            Route::M26Completed | Route::FailedVisible => {
                return Err(format!(
                    "receipt {} is a {} successor, which is how a window CLOSES — it cannot be \
                     input to another one",
                    item.receipt_id,
                    item.route.as_str()
                ));
            }
            Route::M26Queued => queued.push(item.receipt_id.clone()),
            _ => {
                let landed =
                    SchedulerState::parse(item.route.scheduler_state()).ok_or_else(|| {
                        // Unreachable unless `Route::scheduler_state` and
                        // `SchedulerState` have drifted apart, which is
                        // exactly the drift worth refusing over.
                        format!(
                            "route {} lands in {:?}, which is not a scheduler state",
                            item.route.as_str(),
                            item.route.scheduler_state()
                        )
                    })?;
                closed.push(Closed {
                    receipt_id: item.receipt_id.clone(),
                    item_id: item.item_id.clone(),
                    route: item.route,
                    landed,
                });
            }
        }
    }

    if queued.is_empty() {
        // The whole window was deterministic. No key, no id, no run.
        return Ok(Plan {
            closed,
            window: None,
        });
    }
    queued.sort();
    let batch_key = derive_m26_batch_key(store_id, &queued);
    Ok(Plan {
        closed,
        window: Some(Window {
            assessment_id: derive_semantic_assessment_id(store_id, &batch_key),
            batch_key,
            input_receipt_ids: queued,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";

    fn item(receipt: &str, route: Route) -> Assessed {
        Assessed {
            receipt_id: receipt.to_string(),
            item_id: format!("item-of-{receipt}"),
            route,
        }
    }

    /// Every route a fresh assessment can carry. `m26_completed` and
    /// `failed_visible` are excluded because they are how a window ends.
    const FRESH: [Route; 6] = [
        Route::ClosedNoChange,
        Route::ClosedNonMaterial,
        Route::DeterministicProposalApplied,
        Route::DeterministicProposalQueued,
        Route::DeterministicProposalRejected,
        Route::M26Queued,
    ];

    #[test]
    fn an_all_deterministic_window_costs_nothing() {
        let assessed: Vec<Assessed> = FRESH
            .iter()
            .filter(|r| **r != Route::M26Queued)
            .enumerate()
            .map(|(i, route)| item(&format!("r{i}"), *route))
            .collect();
        let plan = plan(STORE, &assessed).unwrap();
        assert_eq!(plan.runs_needed(), 0);
        assert!(plan.window.is_none());
        assert_eq!(plan.closed.len(), assessed.len());
    }

    #[test]
    fn an_empty_window_is_not_an_error_and_is_not_a_run() {
        let plan = plan(STORE, &[]).unwrap();
        assert_eq!(plan.runs_needed(), 0);
        assert!(plan.closed.is_empty());
    }

    #[test]
    fn neither_branch_loses_work() {
        // The partition is total over every route a fresh assessment can
        // carry: what is not closed is queued, and nothing is neither.
        let assessed: Vec<Assessed> = FRESH
            .iter()
            .enumerate()
            .map(|(i, route)| item(&format!("r{i}"), *route))
            .collect();
        let plan = plan(STORE, &assessed).unwrap();
        let queued = plan
            .window
            .as_ref()
            .map_or(0, |w| w.input_receipt_ids.len());
        assert_eq!(plan.closed.len() + queued, assessed.len());
    }

    #[test]
    fn a_residual_of_any_size_is_still_one_run() {
        for count in [1, 2, 17] {
            let assessed: Vec<Assessed> = (0..count)
                .map(|i| item(&format!("r{i}"), Route::M26Queued))
                .collect();
            let plan = plan(STORE, &assessed).unwrap();
            assert_eq!(plan.runs_needed(), 1, "{count} items");
            assert_eq!(
                plan.window.unwrap().input_receipt_ids.len(),
                count,
                "every item is in the one run"
            );
        }
    }

    #[test]
    fn the_window_key_is_its_residual_not_the_whole_window() {
        // Two windows with identical residuals but different deterministic
        // halves are the SAME semantic window: the closed items cost no run
        // and cannot change what the run is about.
        let a = plan(
            STORE,
            &[
                item("r0", Route::M26Queued),
                item("r1", Route::ClosedNoChange),
            ],
        )
        .unwrap();
        let b = plan(
            STORE,
            &[
                item("r0", Route::M26Queued),
                item("r2", Route::ClosedNonMaterial),
                item("r3", Route::DeterministicProposalApplied),
            ],
        )
        .unwrap();
        assert_eq!(a.window, b.window);
    }

    #[test]
    fn collection_order_does_not_mint_a_second_window() {
        let forward = plan(
            STORE,
            &[item("r0", Route::M26Queued), item("r1", Route::M26Queued)],
        )
        .unwrap();
        let reverse = plan(
            STORE,
            &[item("r1", Route::M26Queued), item("r0", Route::M26Queued)],
        )
        .unwrap();
        assert_eq!(forward.window, reverse.window);
    }

    #[test]
    fn a_window_that_gained_an_item_is_a_different_window() {
        let small = plan(STORE, &[item("r0", Route::M26Queued)]).unwrap();
        let grown = plan(
            STORE,
            &[item("r0", Route::M26Queued), item("r1", Route::M26Queued)],
        )
        .unwrap();
        assert_ne!(small.window, grown.window);
    }

    #[test]
    fn a_terminal_successor_cannot_start_another_window() {
        for route in [Route::M26Completed, Route::FailedVisible] {
            let err = plan(STORE, &[item("r0", route)]).expect_err("a closed item as input");
            assert!(err.contains("how a window CLOSES"), "{err}");
        }
    }

    #[test]
    fn a_repeated_receipt_is_refused_rather_than_deduped() {
        // Silently deduping would be worse than it looks: the caller thinks
        // it queued two items and the window key says one.
        let err = plan(
            STORE,
            &[item("r0", Route::M26Queued), item("r0", Route::M26Queued)],
        )
        .expect_err("a repeat");
        assert!(err.contains("appears twice"), "{err}");
    }

    #[test]
    fn an_unassessed_item_has_no_place_in_a_window() {
        let err = plan(STORE, &[item("", Route::M26Queued)]).expect_err("no receipt");
        assert!(err.contains("has not been assessed"), "{err}");
    }

    #[test]
    fn every_closed_route_lands_in_a_state_the_scheduler_knows() {
        // The tie between `Route::scheduler_state` and `SchedulerState`. If
        // one grows a name the other does not have, this is where it shows
        // up rather than at a database CHECK constraint at runtime.
        for route in Route::ALL {
            assert!(
                SchedulerState::parse(route.scheduler_state()).is_some(),
                "{} lands nowhere",
                route.as_str()
            );
        }
    }

    #[test]
    fn a_closed_item_lands_where_its_route_says() {
        let plan = plan(
            STORE,
            &[
                item("r0", Route::DeterministicProposalQueued),
                item("r1", Route::ClosedNoChange),
            ],
        )
        .unwrap();
        let landed: Vec<SchedulerState> = plan.closed.iter().map(|c| c.landed).collect();
        assert_eq!(
            landed,
            vec![SchedulerState::PendingReview, SchedulerState::Consumed]
        );
    }

    #[test]
    fn the_planned_assessment_id_is_the_one_the_window_will_commit() {
        let plan = plan(STORE, &[item("r0", Route::M26Queued)]).unwrap();
        let window = plan.window.unwrap();
        assert_eq!(
            window.assessment_id,
            derive_semantic_assessment_id(STORE, &window.batch_key)
        );
    }

    #[test]
    fn two_vaults_that_saw_the_same_items_do_not_share_a_window() {
        let mine = plan(STORE, &[item("r0", Route::M26Queued)]).unwrap();
        let theirs = plan(
            "0000000000000000000000000000beef",
            &[item("r0", Route::M26Queued)],
        )
        .unwrap();
        assert_ne!(mine.window, theirs.window);
    }
}
