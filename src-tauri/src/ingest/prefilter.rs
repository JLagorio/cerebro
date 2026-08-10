//! The materiality prefilter (M25.5) — deterministic, Rust-only, no LLM.
//!
//! Given the before and after of one watched artifact, it returns a verdict
//! and the route that verdict takes. **It gates LLM spend, never epistemic
//! recording**: an item it closes as `no_change` still has whatever
//! Observations the capture path recorded; what it decided is that no model
//! needs to look at it.
//!
//! **Git operations and projection regeneration cost zero tokens by
//! construction.** Both rewrite bytes without moving a normalized field, and
//! the diff is over normalized fields — so they land on `no_change` or
//! `non_material_change` and stop there. This is the same property
//! `runtime::catchup` gives at the queue level, one layer down: catch-up
//! decides whether an item is even looked at, and this decides whether
//! looking at it is worth a run.

use crate::ledger::schema::{Independence, MaterialDimension, PrefilterVerdict, Route};
use crate::runtime::normalize::Snapshot;

/// What the prefilter concluded, with everything a receipt needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub verdict: PrefilterVerdict,
    pub dimensions: Vec<MaterialDimension>,
    pub independence: Independence,
    /// Field paths that moved, sorted — display and diagnosis only. A route
    /// never reads them.
    pub changed_fields: Vec<String>,
}

/// What the caller knows about an item beyond its two snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Context {
    /// The artifact bytes moved, even if no normalized field did.
    pub artifact_changed: bool,
    /// A positive independence record exists between this item's assertion
    /// and an existing one about the same value. Only a RECORDED fact sets
    /// this; see [`super::independence`].
    pub corroborates_existing_value: bool,
    /// The item shares a lineage ancestor with the existing assertion.
    pub same_lineage: bool,
    /// The deterministic mapper could build a complete M24 proposal from
    /// this change. When it cannot, a material candidate goes to M26 rather
    /// than nowhere.
    pub deterministic_proposal_available: bool,
    /// Something about the change is deterministically undecidable —
    /// free-text prose moved, a field this build has no mapper for. Residual
    /// ambiguity is escalated, never discarded.
    pub residual_ambiguity: bool,
}

/// Which dimension a changed field path speaks to.
///
/// `belief_state` is what the base itself asserts; `world_state` is what the
/// record says about the world. The split matters because a change to only
/// the base's own bookkeeping is a different kind of news from a change to
/// the thing being tracked.
fn dimension_of(field: &str) -> MaterialDimension {
    if field.starts_with("relationships.") || field == "outgoing_links" {
        // A relation is a claim the base holds ABOUT the world's structure.
        MaterialDimension::BeliefState
    } else {
        MaterialDimension::WorldState
    }
}

/// Decide.
///
/// The order is not arbitrary. Evidence-state is checked FIRST and
/// independently of the field diff, because the whole point of §17 is that a
/// second independent lineage for an unchanged value is material — a
/// prefilter that started from "did a field move" would discard exactly that
/// case, and it is the case corroboration is made of.
pub fn assess(before: &Snapshot, after: &Snapshot, context: &Context) -> Verdict {
    let changed_fields = after.changed_fields(before);
    let independence = if context.same_lineage {
        Independence::KnownSameLineage
    } else if context.corroborates_existing_value {
        Independence::KnownIndependent
    } else {
        Independence::IndependenceUnknown
    };

    let mut dimensions: Vec<MaterialDimension> =
        changed_fields.iter().map(|f| dimension_of(f)).collect();
    if independence == Independence::KnownIndependent {
        dimensions.push(MaterialDimension::EvidenceState);
    }
    dimensions.sort();
    dimensions.dedup();

    // Residual ambiguity escalates whatever it touches. `independence_unknown`
    // is NOT weak corroboration: when the caller thought a value might be
    // corroborated and no positive record exists, the honest answer is that a
    // model has to look, not that we may assume.
    let semantic = context.residual_ambiguity
        || (context.corroborates_existing_value && independence != Independence::KnownIndependent);

    let verdict = if semantic {
        PrefilterVerdict::NeedsSemanticJudgment
    } else if !dimensions.is_empty() {
        PrefilterVerdict::MaterialCandidate
    } else if changed_fields.is_empty() && !context.artifact_changed {
        PrefilterVerdict::NoChange
    } else {
        // Bytes moved and nothing the base tracks did: a reformat, a
        // regenerated projection, a checkout. Closed, and the underlying
        // capture stays recorded.
        PrefilterVerdict::NonMaterialChange
    };

    if matches!(
        verdict,
        PrefilterVerdict::NoChange | PrefilterVerdict::NonMaterialChange
    ) {
        dimensions.clear();
    }

    Verdict {
        verdict,
        dimensions,
        independence,
        changed_fields,
    }
}

/// The terminal route for a verdict. Total by construction: every arm of
/// [`PrefilterVerdict`] lands somewhere, and the schema's route matrix
/// refuses any pairing this function could not have produced.
pub fn route_for(verdict: &Verdict, context: &Context, proposal: Option<ProposalOutcome>) -> Route {
    match verdict.verdict {
        PrefilterVerdict::NoChange => Route::ClosedNoChange,
        PrefilterVerdict::NonMaterialChange => Route::ClosedNonMaterial,
        PrefilterVerdict::NeedsSemanticJudgment => Route::M26Queued,
        PrefilterVerdict::MaterialCandidate => {
            if !context.deterministic_proposal_available {
                // A candidate with no deterministic mapper does not vanish
                // because its consumer lands one milestone later.
                return Route::M26Queued;
            }
            match proposal {
                Some(ProposalOutcome::Applied) => Route::DeterministicProposalApplied,
                Some(ProposalOutcome::Queued) => Route::DeterministicProposalQueued,
                Some(ProposalOutcome::Rejected) => Route::DeterministicProposalRejected,
                // The mapper was available and the proposal has not been
                // decided yet — the caller is asking too early. Queuing for
                // M26 would be wrong (a proposal exists); the caller must
                // submit first.
                None => Route::M26Queued,
            }
        }
    }
}

/// What the policy layer did with a deterministic proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalOutcome {
    Applied,
    Queued,
    Rejected,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::normalize;
    use crate::vault::entry::Entry;

    fn snapshot(title: &str) -> Snapshot {
        let mut entry = Entry::empty_for_test("records/a.md");
        entry.title = title.into();
        normalize::snapshot(&entry)
    }

    fn with_field(title: &str, key: &str, value: serde_json::Value) -> Snapshot {
        let mut entry = Entry::empty_for_test("records/a.md");
        entry.title = title.into();
        entry.properties.insert(key.into(), value);
        normalize::snapshot(&entry)
    }

    #[test]
    fn a_git_checkout_and_a_projection_rewrite_both_cost_zero() {
        // Identical normalized fields. The first has identical bytes too (a
        // checkout that restored the same content); the second does not (a
        // regenerated projection). Neither warrants a model.
        let before = snapshot("Alpha");
        let checkout = assess(&before, &snapshot("Alpha"), &Context::default());
        assert_eq!(checkout.verdict, PrefilterVerdict::NoChange);
        assert_eq!(
            route_for(&checkout, &Context::default(), None),
            Route::ClosedNoChange
        );

        let context = Context {
            artifact_changed: true,
            ..Context::default()
        };
        let reformatted = assess(&before, &snapshot("Alpha"), &context);
        assert_eq!(reformatted.verdict, PrefilterVerdict::NonMaterialChange);
        assert!(reformatted.dimensions.is_empty());
        assert_eq!(
            route_for(&reformatted, &context, None),
            Route::ClosedNonMaterial
        );
    }

    #[test]
    fn a_changed_field_is_a_material_candidate_and_names_its_dimension() {
        let verdict = assess(&snapshot("Alpha"), &snapshot("Beta"), &Context::default());
        assert_eq!(verdict.verdict, PrefilterVerdict::MaterialCandidate);
        assert_eq!(verdict.dimensions, vec![MaterialDimension::WorldState]);
        assert_eq!(verdict.changed_fields, vec!["title".to_string()]);
    }

    #[test]
    fn a_relation_edit_is_belief_state_and_a_property_edit_is_world_state() {
        let mut before = Entry::empty_for_test("records/a.md");
        before
            .relationships
            .insert("owner".into(), vec!["Ada".into()]);
        let mut after = before.clone();
        after
            .relationships
            .insert("owner".into(), vec!["Grace".into()]);
        let verdict = assess(
            &normalize::snapshot(&before),
            &normalize::snapshot(&after),
            &Context::default(),
        );
        assert_eq!(verdict.dimensions, vec![MaterialDimension::BeliefState]);

        let verdict = assess(
            &snapshot("Alpha"),
            &with_field("Alpha", "status", serde_json::json!("shipped")),
            &Context::default(),
        );
        assert_eq!(verdict.dimensions, vec![MaterialDimension::WorldState]);
    }

    #[test]
    fn corroborating_duplicate_content_is_material_despite_zero_field_diff() {
        // THE acceptance row, and the reason "no field changed → discard" is
        // forbidden: a second independent lineage for a value that did not
        // move takes the base from single-source to corroborated, and that is
        // news about the EVIDENCE rather than about the world.
        let context = Context {
            artifact_changed: true,
            corroborates_existing_value: true,
            ..Context::default()
        };
        let verdict = assess(&snapshot("Alpha"), &snapshot("Alpha"), &context);
        assert_eq!(verdict.verdict, PrefilterVerdict::MaterialCandidate);
        assert_eq!(verdict.dimensions, vec![MaterialDimension::EvidenceState]);
        assert_eq!(verdict.independence, Independence::KnownIndependent);
    }

    #[test]
    fn independence_unknown_never_counts_as_corroboration() {
        // The caller believed this might corroborate and no positive record
        // exists. Weak corroboration is not a thing; a model has to look.
        let context = Context {
            artifact_changed: true,
            corroborates_existing_value: false,
            residual_ambiguity: true,
            ..Context::default()
        };
        let verdict = assess(&snapshot("Alpha"), &snapshot("Alpha"), &context);
        assert_eq!(verdict.independence, Independence::IndependenceUnknown);
        assert_eq!(verdict.verdict, PrefilterVerdict::NeedsSemanticJudgment);
        assert!(!verdict
            .dimensions
            .contains(&MaterialDimension::EvidenceState));
        assert_eq!(route_for(&verdict, &context, None), Route::M26Queued);
    }

    #[test]
    fn shared_lineage_is_known_same_lineage_and_never_corroborates() {
        let context = Context {
            artifact_changed: true,
            corroborates_existing_value: true,
            same_lineage: true,
            ..Context::default()
        };
        let verdict = assess(&snapshot("Alpha"), &snapshot("Alpha"), &context);
        assert_eq!(verdict.independence, Independence::KnownSameLineage);
        assert!(!verdict
            .dimensions
            .contains(&MaterialDimension::EvidenceState));
        assert_eq!(
            verdict.verdict,
            PrefilterVerdict::NeedsSemanticJudgment,
            "the caller thought it corroborated and the ledger says otherwise — escalate"
        );
    }

    #[test]
    fn a_material_candidate_with_no_mapper_joins_the_next_batch_rather_than_vanishing() {
        let context = Context {
            deterministic_proposal_available: false,
            ..Context::default()
        };
        let verdict = assess(&snapshot("Alpha"), &snapshot("Beta"), &context);
        assert_eq!(verdict.verdict, PrefilterVerdict::MaterialCandidate);
        assert_eq!(route_for(&verdict, &context, None), Route::M26Queued);
    }

    #[test]
    fn a_deterministic_candidate_takes_the_route_the_policy_layer_decided() {
        let context = Context {
            deterministic_proposal_available: true,
            ..Context::default()
        };
        let verdict = assess(&snapshot("Alpha"), &snapshot("Beta"), &context);
        for (outcome, route) in [
            (
                ProposalOutcome::Applied,
                Route::DeterministicProposalApplied,
            ),
            (ProposalOutcome::Queued, Route::DeterministicProposalQueued),
            (
                ProposalOutcome::Rejected,
                Route::DeterministicProposalRejected,
            ),
        ] {
            assert_eq!(route_for(&verdict, &context, Some(outcome)), route);
        }
    }

    #[test]
    fn every_verdict_lands_on_a_route_the_schema_accepts() {
        // Totality, checked against the closed matrix rather than asserted.
        // A verdict with nowhere to go is what this pairing prevents.
        let cases = [
            (Context::default(), snapshot("Alpha"), None),
            (
                Context {
                    artifact_changed: true,
                    ..Context::default()
                },
                snapshot("Alpha"),
                None,
            ),
            (Context::default(), snapshot("Beta"), None),
            (
                Context {
                    deterministic_proposal_available: true,
                    ..Context::default()
                },
                snapshot("Beta"),
                Some(ProposalOutcome::Applied),
            ),
            (
                Context {
                    residual_ambiguity: true,
                    ..Context::default()
                },
                snapshot("Beta"),
                None,
            ),
        ];
        let mut seen = std::collections::BTreeSet::new();
        for (context, after, outcome) in cases {
            let verdict = assess(&snapshot("Alpha"), &after, &context);
            let route = route_for(&verdict, &context, outcome);
            seen.insert(verdict.verdict.as_str());
            // The schema's own matrix must accept this pairing — that is the
            // seam where a drifted prefilter would be caught.
            let mut receipt = crate::ledger::schema::ingest::tests::valid(route);
            receipt.prefilter_verdict = verdict.verdict;
            receipt.material_dimensions = verdict.dimensions.clone();
            receipt.independence = verdict.independence;
            receipt.validate().unwrap_or_else(|e| {
                panic!("{} -> {}: {e}", verdict.verdict.as_str(), route.as_str())
            });
        }
        assert_eq!(seen.len(), 4, "all four verdicts exercised");
    }
}
