//! Closing a window (M26.4d) — the exact batch a finished run commits.
//!
//! A run ends three ways and all three close the window. What must not happen
//! is a window that ends with its items still parked: a queued receipt whose
//! successor was never written is work the scheduler will hold forever, and
//! the run that would have finished it has already been paid for.
//!
//! So this builds the whole closure at once — the `ingest.semantic_assessed`
//! outcome and one successor `ingest.assessed` per input receipt — and
//! refuses if the items it was handed do not exactly cover the window it was
//! asked to close. The caller commits them as ONE M22 logical batch, outcome
//! first, which is the order `check_receipt_against_outcome` requires: a
//! successor is checked against what its outcome concluded, and there is
//! nothing to check against until the outcome has applied.
//!
//! **The proposals stay on the outcome.** A `m26_completed` receipt MAY carry
//! proposal refs, and these carry none, because the run proposed over the
//! whole window and never said which item produced which proposal. Spreading
//! them across the successors would attribute an authorship nobody claimed;
//! copying them onto every successor would say each item produced all of
//! them. The outcome holds them, the successors point at the outcome, and
//! nothing is invented.
//!
//! **A blocked window still closes every item**, as `failed_visible` — which
//! M25 restores as `recovery_held`. Never auto-retried: an owner retry or
//! changed bytes, or it stays visible. A blocked window that quietly re-ran
//! would be the automatic duplicate spend M25 exists to prevent.

use std::collections::BTreeSet;

use crate::ledger::schema::{
    self, Actor, BlockedReason, ContentLabel, Independence, IngestAssessed, IngestSemanticAssessed,
    MaterialDimension, PrefilterVerdict, Route, SemanticDisposition, SemanticOutcome,
};

use super::window::Window;

/// One queued receipt, with everything its successor has to restate.
///
/// A successor receipt describes the SAME source item at the SAME bytes as
/// the receipt it supersedes — the reducer checks it — so these are copied
/// forward rather than re-derived from a vault that may have moved on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedItem {
    pub receipt_id: String,
    pub item_id: String,
    pub source_id: String,
    pub source_record_id: Option<String>,
    pub artifact_hash: String,
    pub normalized_snapshot_hash: String,
    pub normalizer_version: String,
    pub processing_epoch: u64,
    pub prefilter_verdict: PrefilterVerdict,
    pub independence: Independence,
    pub observation_event_ids: Vec<String>,
}

/// What the run came back with. One variant per outcome, so a caller cannot
/// hand over a blocked run that also carries proposals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunResult {
    Material {
        proposal_ids: Vec<String>,
        evaluated_dimensions: Vec<MaterialDimension>,
        material_dimensions: Vec<MaterialDimension>,
        explanation: String,
    },
    NonMaterial {
        evaluated_dimensions: Vec<MaterialDimension>,
        explanation: String,
    },
    Blocked {
        reason: BlockedReason,
        evaluated_dimensions: Vec<MaterialDimension>,
        explanation: String,
    },
}

impl RunResult {
    fn outcome(&self) -> SemanticOutcome {
        match self {
            RunResult::Material { .. } => SemanticOutcome::Material,
            RunResult::NonMaterial { .. } => SemanticOutcome::NonMaterial,
            RunResult::Blocked { .. } => SemanticOutcome::Undetermined,
        }
    }

    /// Which route the successor receipts take. Derived from the same value
    /// the outcome is, so the two cannot be made to disagree here — the
    /// reducer would refuse them, but not until they were already written.
    fn successor_route(&self) -> Route {
        match self {
            RunResult::Blocked { .. } => Route::FailedVisible,
            _ => Route::M26Completed,
        }
    }
}

/// The batch a closing window commits, in commit order.
#[derive(Debug, Clone, PartialEq)]
pub struct Closure {
    pub batch_id: String,
    /// Preallocated, because the successors have to NAME it and the writer
    /// only mints an id at append time. Derived from the assessment id, so
    /// rebuilding this closure lands on the same event rather than a second
    /// one — which is what makes a retry of an uncertain commit safe.
    pub outcome_event_id: String,
    /// Commit FIRST.
    pub outcome: IngestSemanticAssessed,
    /// Commit after the outcome, one per input receipt.
    pub successors: Vec<IngestAssessed>,
}

impl Closure {
    /// Members in the order they must be appended, each with the event id the
    /// writer must use (`None` = mint one).
    pub fn members(&self) -> Vec<(&'static str, serde_json::Value, Option<String>)> {
        let mut out = vec![(
            schema::KIND_INGEST_SEMANTIC_ASSESSED,
            serde_json::to_value(&self.outcome).expect("schema body serializes"),
            Some(self.outcome_event_id.clone()),
        )];
        for successor in &self.successors {
            out.push((
                schema::KIND_INGEST_ASSESSED,
                serde_json::to_value(successor).expect("schema body serializes"),
                None,
            ));
        }
        out
    }
}

/// `sha256_first128("m26-outcome-event-v1" | assessment id)`.
fn outcome_event_id_for(assessment_id: &str) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"m26-outcome-event-v1");
    bytes.push(0);
    bytes.extend_from_slice(assessment_id.as_bytes());
    schema::sha256_first128(&bytes)
}

/// `sha256_first128("m26-close-batch-v1" | assessment id)` — one batch per
/// window, derived so a retry of the same closure reuses the same marker
/// rather than opening a second one.
fn batch_id_for(assessment_id: &str) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"m26-close-batch-v1");
    bytes.push(0);
    bytes.extend_from_slice(assessment_id.as_bytes());
    schema::sha256_first128(&bytes)
}

/// Build the closure for one window.
///
/// `chain_head` is the ledger head the closing decision read — what it could
/// have known, which is the only honest way to read a receipt later.
pub fn close(
    store_id: &str,
    window: &Window,
    items: &[QueuedItem],
    chain_head: &str,
    actor: &str,
    result: &RunResult,
) -> Result<Closure, String> {
    let expected: BTreeSet<&str> = window
        .input_receipt_ids
        .iter()
        .map(String::as_str)
        .collect();
    let supplied: BTreeSet<&str> = items.iter().map(|i| i.receipt_id.as_str()).collect();
    if supplied.len() != items.len() {
        return Err("a window's items are distinct receipts; one was supplied twice".into());
    }
    if supplied != expected {
        // Not a warning and not a partial close. A window whose items do not
        // match is a window somebody has already changed, and closing it
        // against the wrong set is how a queued item gets stranded.
        let missing: Vec<&str> = expected.difference(&supplied).copied().collect();
        let extra: Vec<&str> = supplied.difference(&expected).copied().collect();
        return Err(format!(
            "the items do not cover window {} — missing {missing:?}, unexpected {extra:?}",
            window.batch_key
        ));
    }

    let outcome_kind = result.outcome();
    let batch_id = batch_id_for(&window.assessment_id);
    let outcome_event_id = outcome_event_id_for(&window.assessment_id);
    let outcome = build_outcome(window, &batch_id, actor, result)?;
    outcome.validate().map_err(|e| format!("outcome: {e}"))?;

    // Sorted, so the batch's member order is a function of the window and not
    // of whatever order the caller read its rows in.
    let mut ordered: Vec<&QueuedItem> = items.iter().collect();
    ordered.sort_by(|a, b| a.receipt_id.cmp(&b.receipt_id));

    let route = result.successor_route();
    let mut successors = Vec::with_capacity(ordered.len());
    for item in ordered {
        let receipt = build_successor(
            store_id,
            item,
            window,
            &batch_id,
            &outcome_event_id,
            chain_head,
            actor,
            route,
        );
        receipt
            .validate()
            .map_err(|e| format!("successor for {}: {e}", item.receipt_id))?;
        successors.push(receipt);
    }
    debug_assert_eq!(outcome_kind, outcome.outcome);
    Ok(Closure {
        batch_id,
        outcome_event_id,
        outcome,
        successors,
    })
}

fn build_outcome(
    window: &Window,
    batch_id: &str,
    actor: &str,
    result: &RunResult,
) -> Result<IngestSemanticAssessed, String> {
    let (evaluated, material, proposals, blocked, explanation) = match result {
        RunResult::Material {
            proposal_ids,
            evaluated_dimensions,
            material_dimensions,
            explanation,
        } => (
            evaluated_dimensions.clone(),
            material_dimensions.clone(),
            proposal_ids.clone(),
            None,
            explanation.clone(),
        ),
        RunResult::NonMaterial {
            evaluated_dimensions,
            explanation,
        } => (
            evaluated_dimensions.clone(),
            Vec::new(),
            Vec::new(),
            None,
            explanation.clone(),
        ),
        RunResult::Blocked {
            reason,
            evaluated_dimensions,
            explanation,
        } => (
            evaluated_dimensions.clone(),
            Vec::new(),
            Vec::new(),
            Some(*reason),
            explanation.clone(),
        ),
    };
    let outcome = result.outcome();
    let mut body = IngestSemanticAssessed {
        schema: schema::BODY_SCHEMA,
        batch_id: Some(batch_id.to_string()),
        idempotency_key: None,
        actor: Actor {
            id: actor.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        semantic_assessment_id: window.assessment_id.clone(),
        m26_batch_key: window.batch_key.clone(),
        input_receipt_ids: window.input_receipt_ids.clone(),
        outcome,
        // Read from the outcome rather than accepted from the caller: the
        // pairing is closed, and a caller with an opinion about it is a
        // caller who can make the two disagree.
        disposition: match outcome {
            SemanticOutcome::Material => SemanticDisposition::ProposalsSubmitted,
            SemanticOutcome::NonMaterial => SemanticDisposition::ClosedNonMaterial,
            SemanticOutcome::Undetermined => SemanticDisposition::BlockedVisible,
        },
        evaluated_dimensions: sorted_dedup(evaluated),
        material_dimensions: sorted_dedup(material),
        proposal_ids: sorted_unique(proposals)?,
        blocked_reason: blocked,
        explanation,
        content_label: ContentLabel::AgentSupplied,
    };
    body.idempotency_key = Some(body.idempotency());
    Ok(body)
}

#[allow(clippy::too_many_arguments)] // Every one is a distinct fact a
                                     // successor receipt has to restate; bundling them into a struct would move
                                     // the argument list rather than shorten it.
fn build_successor(
    store_id: &str,
    item: &QueuedItem,
    window: &Window,
    batch_id: &str,
    outcome_event_id: &str,
    chain_head: &str,
    actor: &str,
    route: Route,
) -> IngestAssessed {
    let mut observations = item.observation_event_ids.clone();
    observations.sort();
    observations.dedup();
    let mut body = IngestAssessed {
        schema: schema::BODY_SCHEMA,
        batch_id: Some(batch_id.to_string()),
        idempotency_key: None,
        actor: Actor {
            id: actor.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        receipt_id: schema::derive_receipt_id(
            // The successor's id covers the same components its append-once
            // key does, with the route as the discriminator — so it cannot
            // collide with the queued receipt it supersedes.
            store_id,
            &item.source_id,
            &item.item_id,
            &item.artifact_hash,
            &item.normalizer_version,
            item.processing_epoch,
            route,
        ),
        item_id: item.item_id.clone(),
        source_id: item.source_id.clone(),
        source_record_id: item.source_record_id.clone(),
        artifact_hash: item.artifact_hash.clone(),
        normalized_snapshot_hash: item.normalized_snapshot_hash.clone(),
        normalizer_version: item.normalizer_version.clone(),
        processing_epoch: item.processing_epoch,
        assessed_against_chain_head: chain_head.to_string(),
        prefilter_verdict: item.prefilter_verdict,
        // The deterministic pass's dimensions belong to the receipt that
        // queued the item. Restating them here would be this pass claiming a
        // finding it did not make; the SEMANTIC dimensions live on the
        // outcome, which is where the run's conclusions belong.
        material_dimensions: Vec::new(),
        independence: item.independence,
        route,
        observation_event_ids: observations,
        proposal_ids: Vec::new(),
        m26_batch_key: Some(window.batch_key.clone()),
        m26_outcome_event_id: Some(outcome_event_id.to_string()),
        supersedes_receipt_id: Some(item.receipt_id.clone()),
    };
    body.idempotency_key = Some(body.idempotency());
    body
}

fn sorted_dedup(mut dimensions: Vec<MaterialDimension>) -> Vec<MaterialDimension> {
    dimensions.sort();
    dimensions.dedup();
    dimensions
}

fn sorted_unique(mut ids: Vec<String>) -> Result<Vec<String>, String> {
    let before = ids.len();
    ids.sort();
    ids.dedup();
    if ids.len() != before {
        return Err("the run named the same proposal twice".into());
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::window::{self, Assessed};

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";
    const HEAD: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
    const ACTOR: &str = "agent:m26-ingest";

    fn queued(n: u8) -> QueuedItem {
        let id128 = |b: u8| format!("{b:02x}").repeat(16);
        QueuedItem {
            receipt_id: String::new(),
            item_id: id128(n),
            source_id: id128(0xaa),
            source_record_id: None,
            artifact_hash: format!("{n:02x}").repeat(32),
            normalized_snapshot_hash: "bb".repeat(32),
            normalizer_version: "vault-entry-v1".into(),
            processing_epoch: 0,
            prefilter_verdict: PrefilterVerdict::NeedsSemanticJudgment,
            independence: Independence::IndependenceUnknown,
            observation_event_ids: vec![id128(0xee)],
        }
    }

    /// A window and the items it parked, agreeing by construction.
    fn fixture(count: u8) -> (window::Plan, Vec<QueuedItem>) {
        let mut items: Vec<QueuedItem> = (1..=count).map(queued).collect();
        for item in &mut items {
            item.receipt_id = schema::derive_receipt_id(
                STORE,
                &item.source_id,
                &item.item_id,
                &item.artifact_hash,
                &item.normalizer_version,
                item.processing_epoch,
                Route::M26Queued,
            );
        }
        let assessed: Vec<Assessed> = items
            .iter()
            .map(|i| Assessed {
                receipt_id: i.receipt_id.clone(),
                item_id: i.item_id.clone(),
                route: Route::M26Queued,
            })
            .collect();
        (window::plan(STORE, &assessed).unwrap(), items)
    }

    fn material() -> RunResult {
        RunResult::Material {
            proposal_ids: vec!["11".repeat(16)],
            evaluated_dimensions: vec![
                MaterialDimension::EvidenceState,
                MaterialDimension::WorldState,
            ],
            material_dimensions: vec![MaterialDimension::EvidenceState],
            explanation: "a second independent source for a value that did not move".into(),
        }
    }

    fn blocked() -> RunResult {
        RunResult::Blocked {
            reason: BlockedReason::RuntimeUnavailable,
            evaluated_dimensions: vec![],
            explanation: "the session did not start".into(),
        }
    }

    fn non_material() -> RunResult {
        RunResult::NonMaterial {
            evaluated_dimensions: vec![MaterialDimension::WorldState],
            explanation: "a heading was renamed".into(),
        }
    }

    #[test]
    fn every_parked_item_gets_a_successor_however_the_run_ended() {
        // The failure this exists to prevent: a window that ends with items
        // still parked, holding work the run was already paid for.
        for result in [material(), non_material(), blocked()] {
            let (plan, items) = fixture(3);
            let window = plan.window.unwrap();
            let closure = close(STORE, &window, &items, HEAD, ACTOR, &result).unwrap();
            assert_eq!(closure.successors.len(), 3, "{:?}", result);
            let closed: BTreeSet<&str> = closure
                .successors
                .iter()
                .map(|s| s.supersedes_receipt_id.as_deref().unwrap())
                .collect();
            let parked: BTreeSet<&str> = window
                .input_receipt_ids
                .iter()
                .map(String::as_str)
                .collect();
            assert_eq!(closed, parked);
        }
    }

    #[test]
    fn the_outcome_is_committed_before_the_receipts_that_name_it() {
        let (plan, items) = fixture(2);
        let closure = close(
            STORE,
            &plan.window.unwrap(),
            &items,
            HEAD,
            ACTOR,
            &material(),
        )
        .unwrap();
        let members = closure.members();
        assert_eq!(members[0].0, schema::KIND_INGEST_SEMANTIC_ASSESSED);
        assert_eq!(
            members[0].2.as_deref(),
            Some(closure.outcome_event_id.as_str())
        );
        assert!(members[1..]
            .iter()
            .all(|(kind, _, id)| *kind == schema::KIND_INGEST_ASSESSED && id.is_none()));
        // Every successor names the outcome that precedes it.
        assert!(closure
            .successors
            .iter()
            .all(|s| s.m26_outcome_event_id.as_deref() == Some(closure.outcome_event_id.as_str())));
    }

    #[test]
    fn a_blocked_window_closes_as_failed_visible_and_a_decided_one_does_not() {
        let (plan, items) = fixture(1);
        let window = plan.window.unwrap();
        for (result, route) in [
            (material(), Route::M26Completed),
            (non_material(), Route::M26Completed),
            (blocked(), Route::FailedVisible),
        ] {
            let closure = close(STORE, &window, &items, HEAD, ACTOR, &result).unwrap();
            assert_eq!(closure.successors[0].route, route);
        }
    }

    #[test]
    fn proposals_stay_on_the_outcome_rather_than_being_attributed_to_an_item() {
        // The run proposed over the window and never said which item produced
        // which proposal. Spreading them would invent an authorship.
        let (plan, items) = fixture(2);
        let closure = close(
            STORE,
            &plan.window.unwrap(),
            &items,
            HEAD,
            ACTOR,
            &material(),
        )
        .unwrap();
        assert_eq!(closure.outcome.proposal_ids, vec!["11".repeat(16)]);
        assert!(closure.successors.iter().all(|s| s.proposal_ids.is_empty()));
    }

    #[test]
    fn a_successor_restates_the_bytes_of_the_receipt_it_supersedes() {
        // The reducer requires the same item, source, and epoch. Re-deriving
        // any of it from a vault that has moved on would refuse at commit.
        let (plan, items) = fixture(1);
        let closure = close(
            STORE,
            &plan.window.unwrap(),
            &items,
            HEAD,
            ACTOR,
            &non_material(),
        )
        .unwrap();
        let s = &closure.successors[0];
        assert_eq!(s.item_id, items[0].item_id);
        assert_eq!(s.source_id, items[0].source_id);
        assert_eq!(s.artifact_hash, items[0].artifact_hash);
        assert_eq!(s.processing_epoch, items[0].processing_epoch);
        assert_ne!(
            s.receipt_id, items[0].receipt_id,
            "a new receipt, not a rewrite"
        );
    }

    #[test]
    fn items_that_do_not_cover_the_window_are_refused_rather_than_partly_closed() {
        let (plan, items) = fixture(3);
        let window = plan.window.unwrap();
        let err =
            close(STORE, &window, &items[..2], HEAD, ACTOR, &material()).expect_err("a short set");
        assert!(err.contains("do not cover window"), "{err}");
        assert!(err.contains("missing"), "{err}");
    }

    #[test]
    fn an_item_from_another_window_is_refused() {
        let (plan, mut items) = fixture(2);
        let (_other, other_items) = fixture(5);
        items[1] = other_items[4].clone();
        let err = close(
            STORE,
            &plan.window.unwrap(),
            &items,
            HEAD,
            ACTOR,
            &material(),
        )
        .expect_err("a stranger");
        assert!(err.contains("unexpected"), "{err}");
    }

    #[test]
    fn a_repeated_item_is_refused_before_anything_is_built() {
        let (plan, items) = fixture(1);
        let doubled = vec![items[0].clone(), items[0].clone()];
        let err = close(
            STORE,
            &plan.window.unwrap(),
            &doubled,
            HEAD,
            ACTOR,
            &material(),
        )
        .expect_err("a repeat");
        assert!(err.contains("supplied twice"), "{err}");
    }

    #[test]
    fn the_outcome_carries_the_id_the_planner_minted() {
        let (plan, items) = fixture(2);
        let window = plan.window.clone().unwrap();
        let closure = close(STORE, &window, &items, HEAD, ACTOR, &material()).unwrap();
        assert_eq!(closure.outcome.semantic_assessment_id, window.assessment_id);
        assert_eq!(closure.outcome.m26_batch_key, window.batch_key);
        assert_eq!(closure.outcome.input_receipt_ids, window.input_receipt_ids);
    }

    #[test]
    fn every_body_in_the_closure_validates_and_shares_one_batch() {
        for result in [material(), non_material(), blocked()] {
            let (plan, items) = fixture(2);
            let closure =
                close(STORE, &plan.window.unwrap(), &items, HEAD, ACTOR, &result).unwrap();
            closure.outcome.validate().unwrap();
            assert_eq!(
                closure.outcome.batch_id.as_deref(),
                Some(closure.batch_id.as_str())
            );
            for successor in &closure.successors {
                successor.validate().unwrap();
                assert_eq!(
                    successor.batch_id.as_deref(),
                    Some(closure.batch_id.as_str())
                );
            }
        }
    }

    #[test]
    fn closing_the_same_window_twice_builds_the_same_batch_marker() {
        // A retry of a closure that may or may not have committed must reuse
        // the marker rather than opening a second one.
        let (plan, items) = fixture(2);
        let window = plan.window.unwrap();
        let first = close(STORE, &window, &items, HEAD, ACTOR, &material()).unwrap();
        let second = close(STORE, &window, &items, HEAD, ACTOR, &material()).unwrap();
        assert_eq!(first.batch_id, second.batch_id);
        assert_eq!(first, second);
    }

    #[test]
    fn a_run_naming_one_proposal_twice_is_refused() {
        let (plan, items) = fixture(1);
        let doubled = RunResult::Material {
            proposal_ids: vec!["11".repeat(16), "11".repeat(16)],
            evaluated_dimensions: vec![MaterialDimension::WorldState],
            material_dimensions: vec![MaterialDimension::WorldState],
            explanation: "x".into(),
        };
        let err = close(STORE, &plan.window.unwrap(), &items, HEAD, ACTOR, &doubled)
            .expect_err("a repeat");
        assert!(err.contains("same proposal twice"), "{err}");
    }

    #[test]
    fn the_semantic_dimensions_stay_on_the_outcome() {
        // A successor restating them would be this pass claiming the
        // deterministic finding, and the deterministic finding is already on
        // the receipt it supersedes.
        let (plan, items) = fixture(1);
        let closure = close(
            STORE,
            &plan.window.unwrap(),
            &items,
            HEAD,
            ACTOR,
            &material(),
        )
        .unwrap();
        assert!(closure.successors[0].material_dimensions.is_empty());
        assert_eq!(
            closure.outcome.material_dimensions,
            vec![MaterialDimension::EvidenceState]
        );
    }
}
