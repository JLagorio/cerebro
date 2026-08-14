//! The state-aware half of the interpreter (M24.4).
//!
//! `verdict::table_verdict` decides everything the artifact alone can decide.
//! What it cannot see is the world: whether the Belief a proposal wants to
//! rewrite has been reviewed by a human, and how much else depends on it.
//! Those are the two deterministic escalator signals, and this module is
//! where they are DERIVED — from reducer state, on the server, never from
//! anything the caller said.
//!
//! That direction matters more than the arithmetic. Declared risk may only
//! RAISE (D5); if an agent could also supply the signals, it could lower the
//! effective risk by understating the world instead of understating itself,
//! and the ladder would be advisory.
//!
//! No threshold or floor appears here either. The signal NAMES come out of
//! the table's own escalator rows, so adding a third escalator is a table
//! edit plus a derivation, not a new branch in the ladder.

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{ProposalV1, TargetClass};

use super::risk::{SignalValue, Signals};
use super::submit::{facts_of, SubmitError};
use super::table::PolicyTable;
use super::verdict::ProposalFacts;

/// The `escalators[].signal` name for "a human has reviewed this target".
pub const SIGNAL_TARGET_HAS_ATTESTATION: &str = "target_has_attestation";
/// The `escalators[].signal` name for "how much depends on this target".
pub const SIGNAL_LINEAGE_FAN_IN: &str = "lineage_fan_in";

/// How many live relations point INTO this Belief — the count of other
/// records that would be talking about something that changed underneath
/// them.
///
/// The design fixes the mechanism (fan-in above a named threshold floors
/// HIGH) and leaves the measure to the server; this is that choice, written
/// once. Incoming live relations are the edges a reader actually follows, so
/// they are what "much depends on this" means here. Outgoing edges are this
/// record's own claims about others and say nothing about who would be
/// surprised.
pub fn lineage_fan_in(state: &EpistemicState, belief_id: &str) -> u64 {
    state
        .relations
        .values()
        .filter(|relation| relation.live && relation.to == belief_id)
        .count() as u64
}

/// Has a human attested any Belief this proposal targets?
fn target_has_attestation(state: &EpistemicState, proposal: &ProposalV1) -> bool {
    proposal.targets.iter().any(|target| {
        target.target_class == TargetClass::Belief
            && state
                .beliefs
                .get(&target.target_id)
                .is_some_and(|belief| belief.attested.is_some())
    })
}

/// Derive every escalator signal for one proposal at one snapshot.
///
/// A proposal escalates when ANY of its targets trips an escalator, so flags
/// are OR-ed and counts are MAXed across the target set — the dangerous
/// member decides, not the average.
pub fn signals_at(state: &EpistemicState, proposal: &ProposalV1) -> Signals {
    let fan_in = proposal
        .targets
        .iter()
        .filter(|target| target.target_class == TargetClass::Belief)
        .map(|target| lineage_fan_in(state, &target.target_id))
        .max()
        .unwrap_or(0);
    Signals::from([
        (
            SIGNAL_TARGET_HAS_ATTESTATION.to_string(),
            SignalValue::Flag(target_has_attestation(state, proposal)),
        ),
        (
            SIGNAL_LINEAGE_FAN_IN.to_string(),
            SignalValue::Count(fan_in),
        ),
    ])
}

/// The full facts for one proposal at one snapshot: the table-only
/// projection plus the server-derived signals.
pub fn facts_at(
    table: &PolicyTable,
    state: &EpistemicState,
    proposal: &ProposalV1,
) -> Result<ProposalFacts, SubmitError> {
    let mut facts = facts_of(table, proposal)?;
    facts.signals = signals_at(state, proposal);
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{BeliefState, RelationState, RevisionState};
    use crate::ledger::schema::{
        BeliefBasis, ProposalOp, RelationKind, TargetClass as Class, TypedValue,
    };
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::Risk;
    use crate::policy::verdict::{table_verdict, Verdict};

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    fn belief(attested: bool) -> BeliefState {
        BeliefState {
            belief_id: A.into(),
            entity_id: B.into(),
            created_event_id: B.into(),
            revisions: vec![RevisionState {
                event_id: B.into(),
                revision: 1,
                content: String::new(),
                fields: serde_json::json!({}),
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            }],
            attested: attested.then(|| (B.to_string(), B.to_string())),
            attestation_events: vec![],
            path: None,
            overrides: vec![],
            override_head_event: None,
            projection_head_event: B.into(),
            qualification: crate::ledger::schema::Qualification::Draft,
            lifecycle: crate::ledger::schema::Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        }
    }

    /// A world holding one Belief, optionally attested, with `fan_in` live
    /// relations pointing at it.
    fn world(attested: bool, fan_in: usize) -> EpistemicState {
        let mut state = EpistemicState::default();
        state.beliefs.insert(A.to_string(), belief(attested));
        for index in 0..fan_in {
            let from = format!("{index:032x}");
            let relation_id =
                crate::ledger::schema::derive_relation_id(&from, A, RelationKind::Refines);
            state.relations.insert(
                relation_id.clone(),
                RelationState {
                    relation_id,
                    from,
                    to: A.to_string(),
                    relation: RelationKind::Refines,
                    live: true,
                    last_add_event_id: B.into(),
                    last_event_id: B.into(),
                },
            );
        }
        state
    }

    fn update() -> crate::ledger::schema::ProposalV1 {
        proposal(
            A,
            B,
            ProposalOp::UpdateBelief {
                belief_id: A.into(),
                patch: vec![crate::ledger::schema::PatchOp {
                    field_path: "/fields/x".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("1"),
                }],
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            },
            vec![target(Class::Belief, A, Some(1))],
            Risk::Medium,
        )
    }

    /// Every signal the table escalates on must actually be derived, or a
    /// rule that looks like protection would never fire.
    #[test]
    fn every_escalator_signal_is_one_the_server_derives() {
        let table = PolicyTable::load().unwrap();
        let derived = signals_at(&world(false, 0), &update());
        for escalator in &table.escalators {
            assert!(
                derived.contains_key(&escalator.signal),
                "the table escalates on {:?}, which nothing derives — the rule could never fire",
                escalator.signal
            );
        }
    }

    #[test]
    fn attestation_and_fan_in_escalate_the_same_proposal_the_caller_cannot_touch() {
        // THE POINT OF DERIVING SIGNALS SERVER-SIDE. The proposal is
        // byte-identical in all three branches; only the world differs. If
        // an agent could supply these it could lower effective risk by
        // understating the world rather than itself, and the ladder would be
        // advisory.
        let table = PolicyTable::load().unwrap();
        let proposal = update();
        let verdict = |state: &EpistemicState| {
            table_verdict(&table, &facts_at(&table, state, &proposal).unwrap()).unwrap()
        };

        let quiet = verdict(&world(false, 0));
        assert_eq!(quiet.effective_risk(), Some(Risk::Medium));
        assert!(quiet.escalated_by().is_empty());

        let reviewed = verdict(&world(true, 0));
        assert_eq!(reviewed.effective_risk(), Some(Risk::High));
        assert_eq!(reviewed.escalated_by(), vec!["target_has_attestation"]);
        assert!(matches!(reviewed, Verdict::Queued { .. }));

        let threshold = table.threshold("lineage_fan_in_high").unwrap() as usize;
        let busy = verdict(&world(false, threshold + 1));
        assert_eq!(busy.effective_risk(), Some(Risk::High));
        assert_eq!(busy.escalated_by(), vec!["lineage_fan_in"]);
    }

    #[test]
    fn fan_in_is_strictly_above_the_threshold_not_at_it() {
        // A boundary a table edit could silently move: the escalator says
        // "above", and exactly-at must not fire.
        let table = PolicyTable::load().unwrap();
        let threshold = table.threshold("lineage_fan_in_high").unwrap() as usize;
        let at = facts_at(&table, &world(false, threshold), &update()).unwrap();
        assert!(table_verdict(&table, &at)
            .unwrap()
            .escalated_by()
            .is_empty());
    }

    #[test]
    fn fan_in_counts_incoming_edges_only() {
        // Outgoing edges are this record's own claims about others and say
        // nothing about who would be surprised by a change.
        let mut state = world(false, 0);
        state.beliefs.insert(B.to_string(), belief(false));
        let relation_id = crate::ledger::schema::derive_relation_id(A, B, RelationKind::Refines);
        state.relations.insert(
            relation_id.clone(),
            RelationState {
                relation_id,
                from: A.to_string(),
                to: B.to_string(),
                relation: RelationKind::Refines,
                live: true,
                last_add_event_id: B.into(),
                last_event_id: B.into(),
            },
        );
        assert_eq!(lineage_fan_in(&state, A), 0);
        assert_eq!(lineage_fan_in(&state, B), 1);
    }

    #[test]
    fn a_removed_relation_stops_counting() {
        let mut state = world(false, 1);
        for relation in state.relations.values_mut() {
            relation.live = false;
        }
        assert_eq!(lineage_fan_in(&state, A), 0);
    }
}
