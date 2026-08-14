//! The contradiction chain, end to end (M27.9).
//!
//! Every stage of this is asserted where it lives — the detector raises pairs,
//! the gauntlet settles or refuses them, the reducer opens edges, the lane
//! ranks them, the gate refuses to compress one away. What no module can
//! assert is that a genuine conflict travels ALL of it and a stage-lagged
//! truth travels none of it, because no module sees both ends.
//!
//! **The wrong implementation this is aimed at is a chain with one silent
//! link.** Every unit test passes while an edge opens that no lane lists, or a
//! lane lists a pair the gate would happily merge away. Each of those is
//! invisible from inside the module that has the bug, and each is the whole
//! milestone failing.
//!
//! **The negative control is half the suite.** A build that opened an edge for
//! every disagreement would pass the positive cases and destroy the product:
//! stage lag is the common case, and a surface that cries wolf about it is one
//! people learn to click through. So the same pipeline runs over the canonical
//! lead/main/BOM state, and the assertion is that NOTHING reaches any of it.

use crate::attention::lanes::{self, Lane, Reason};
use crate::conflict::detect::{self, DETECTOR_VERSION};
use crate::conflict::resolve::plan;
use crate::dynamics::bundle;
use crate::ledger::reduce::{
    ClassificationRow, ComparisonOrigin, ComparisonRow, ContradictionEdgeRow, EpistemicState,
};
use crate::ledger::schema::{
    derive_comparison_id, ConflictEndpoint, ContradictionOpened, ProposalTarget, TargetClass,
};
use crate::policy::preconditions::{check, TargetBinding};
use crate::policy::table::{PolicyTable, Risk};

const STORE: &str = "feedfacefeedfacefeedfacefeedface";
const AS_OF: &str = "2026-08-12T09:00:00.000Z";

fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(stamp)
        .unwrap()
        .with_timezone(&chrono::Utc)
}

/// Run the whole pipeline over a state and leave behind what the reducer
/// would have: committed comparisons, classifications, and open edges.
///
/// The edge rows are built from the planner's OWN emitted body rather than
/// hand-typed, so a fixture cannot quietly agree with itself about an edge id
/// the gauntlet never produced.
fn run_pipeline(state: &mut EpistemicState) {
    for (index, candidate) in detect::find(state).into_iter().enumerate() {
        let comparison_id = derive_comparison_id(&candidate.left, &candidate.right).unwrap();
        state.comparisons.insert(
            comparison_id.clone(),
            ComparisonRow {
                comparison_id,
                event_id: format!("910000000000000000000000000000{index:02}"),
                left: ConflictEndpoint::Asserted {
                    endpoint: candidate.left,
                },
                right: ConflictEndpoint::Asserted {
                    endpoint: candidate.right,
                },
                origin: ComparisonOrigin::Detected {
                    detector_version: DETECTOR_VERSION.into(),
                    reason_codes: candidate.reason_codes,
                },
            },
        );
    }

    for (index, planned) in plan(state, STORE, AS_OF).into_iter().enumerate() {
        let classified_event_id = format!("920000000000000000000000000000{index:02}");
        state.conflict_classifications.insert(
            planned.comparison_id.clone(),
            ClassificationRow {
                comparison_id: planned.comparison_id.clone(),
                event_id: classified_event_id.clone(),
                outcome: planned.outcome,
                classification: crate::ledger::schema::Classification::Deterministic {
                    rule_version: "conflict-gauntlet-v1".into(),
                },
                reason_codes: vec![],
                evidence_event_ids: vec![],
            },
        );
        for (kind, body) in &planned.members {
            if kind != "contradiction.opened" {
                continue;
            }
            let opened: ContradictionOpened = serde_json::from_value(body.clone())
                .expect("the planner emits a body the schema can read");
            state.contradiction_edges.insert(
                opened.edge_id.clone(),
                ContradictionEdgeRow {
                    edge_id: opened.edge_id.clone(),
                    comparison_id: opened.comparison_id.clone(),
                    kind: opened.kind,
                    left_belief_id: opened.left.belief_id().to_string(),
                    right_belief_id: opened.right.belief_id().to_string(),
                    opened_event_id: format!("930000000000000000000000000000{index:02}"),
                    classified_event_id: classified_event_id.clone(),
                    closed: None,
                },
            );
        }
    }
}

/// The contradiction lane over a state, through the shipped artifacts.
fn contradiction_lane(state: &EpistemicState) -> Vec<lanes::Item> {
    let tables = bundle::Tables::load().expect("the shipped artifacts");
    let definitions = lanes::load().expect("the shipped lane definitions");
    lanes::lanes(state, &tables, &definitions, &[], at(AS_OF))
        .of(Lane::Contradiction)
        .cloned()
        .collect()
}

/// Would the gate let a supersede over `belief_id` through, naming nothing?
fn supersede_refused(state: &EpistemicState, belief_id: &str) -> Option<&'static str> {
    let table = PolicyTable::load().expect("the shipped policy table");
    let catalog = crate::policy::qualification::Catalog::of(STORE, vec![]);
    let actor = crate::ledger::schema::Actor {
        id: "agent:test".into(),
    };
    let proposal = crate::policy::fixtures::proposal(
        &"a".repeat(32),
        &"b".repeat(32),
        crate::ledger::schema::ProposalOp::SupersedeBelief {
            belief_id: belief_id.into(),
            successor_id: "c".repeat(32),
        },
        vec![ProposalTarget {
            target_class: TargetClass::Belief,
            target_id: belief_id.into(),
            expected_version: None,
        }],
        Risk::Medium,
    );
    let binding = TargetBinding {
        actor: &actor,
        staged_beliefs: &Default::default(),
        staged_entities: &Default::default(),
        decision_event_id: None,
    };
    check(&table, state, &catalog, &proposal, &binding)
        .err()
        .map(|failure| failure.code)
}

/// Two beliefs about one entity whose booleans differ: nothing in subject,
/// scope, time or stage separates them, so the gauntlet has nowhere to send
/// the pair except an edge.
fn genuine_conflict() -> EpistemicState {
    use crate::assembly::fixture::{OBS_AUTHORITY, OBS_PLANNED};
    use crate::conflict::detect::fixture::{base, facet, scope};
    use crate::ledger::schema::{derive_value_hash, TypedValue};

    let mut state = base();
    for (event, value) in [(OBS_AUTHORITY, true), (OBS_PLANNED, false)] {
        // The detector compares the digest and the gauntlet compares the
        // value, so both have to describe the same boolean or the fixture is
        // testing two different claims.
        let typed = TypedValue::Boolean { value };
        let mut assertion = facet("ships_on_time", "placeholder", scope(None, None));
        assertion.value_hash = derive_value_hash(&typed).unwrap();
        assertion.value = typed;
        state.assertion_facets.insert(event.into(), assertion);
    }
    state
}

#[test]
fn a_genuine_conflict_travels_the_whole_chain_and_stops_a_merge() {
    // THE positive case, and the reason the chain exists. Two booleans that
    // differ need no interpretation, so this is the one shape the gauntlet
    // may settle as a contradiction on its own.
    let mut state = genuine_conflict();
    run_pipeline(&mut state);

    let edges: Vec<&ContradictionEdgeRow> = state.contradiction_edges.values().collect();
    assert_eq!(edges.len(), 1, "one disagreement, one edge");
    let edge = edges[0];

    // The lane lists the edge the pipeline opened — the same id, not merely
    // "something in the contradiction lane".
    let lane = contradiction_lane(&state);
    assert_eq!(lane.len(), 1);
    assert_eq!(lane[0].edge_id.as_deref(), Some(edge.edge_id.as_str()));
    assert_eq!(lane[0].reasons, vec![Reason::OpenEdgeGenuineDirect]);

    // And the gate refuses to compress either end of it away.
    for belief_id in [&edge.left_belief_id, &edge.right_belief_id] {
        assert_eq!(
            supersede_refused(&state, belief_id),
            Some("contradiction_preservation_required"),
            "a supersede over {belief_id} went through with an open edge on it"
        );
    }
}

#[test]
fn a_stage_lagged_truth_travels_none_of_it() {
    // THE negative control, and the one that matters more. The lead says AMD,
    // main has AMD committed, the BOM says NVIDIA about the previous
    // revision. Everything here looks like a contradiction and none of it is
    // one — a build that raised an edge would be right about the bytes and
    // wrong about the world, and the surface it produced is one people learn
    // to ignore.
    let mut state = crate::conflict::resolve::tests::lead_main_bom();
    run_pipeline(&mut state);

    assert!(
        state.contradiction_edges.is_empty(),
        "the gauntlet opened {} edge(s) over stage lag",
        state.contradiction_edges.len()
    );
    assert!(contradiction_lane(&state).is_empty());

    // Every one of the three can still be superseded, which is the point:
    // the gate is silent because there is nothing to preserve.
    for belief_id in state.beliefs.keys() {
        assert_ne!(
            supersede_refused(&state, belief_id),
            Some("contradiction_preservation_required"),
            "the gate fired over a pair the gauntlet resolved apart"
        );
    }

    // And the pairs were genuinely examined rather than skipped: two
    // comparisons were raised and both settled.
    assert_eq!(state.comparisons.len(), 2);
    assert_eq!(state.conflict_classifications.len(), 2);
}

#[test]
fn an_unclassified_declaration_is_refused_by_the_gate_and_named_by_the_lane() {
    // The two halves of one claim, which live in two modules and have never
    // been checked together: a `contradicts` relation nobody has classified
    // must BLOCK a merge and be VISIBLE while it does. A build with only the
    // first half refuses a merge for a reason nothing on screen explains,
    // which reads as a bug and gets routed around.
    use crate::assembly::fixture::{relate, B_ONE, B_TWO};
    use crate::ledger::schema::RelationKind;

    let mut state = genuine_conflict();
    relate(
        &mut state,
        &"r".repeat(32),
        B_TWO,
        B_ONE,
        RelationKind::Contradicts,
        true,
    );

    let lane = contradiction_lane(&state);
    let legacy: Vec<&lanes::Item> = lane
        .iter()
        .filter(|item| item.reasons == vec![Reason::LegacyUnclassified])
        .collect();
    assert_eq!(legacy.len(), 1, "the declaration is not on the surface");
    assert!(
        legacy[0].relation_id.is_some() && legacy[0].edge_id.is_none(),
        "an unclassified declaration has no edge to name, and the row says so"
    );

    assert_eq!(
        supersede_refused(&state, B_ONE),
        Some("contradiction_preservation_required")
    );
}

#[test]
fn the_pair_order_never_changes_what_the_chain_produces() {
    // Two detectors that saw the same disagreement from opposite sides must
    // produce one comparison and one edge. A build that ordered by discovery
    // would open two edges over one conflict, and a person would be asked to
    // resolve the same thing twice — with the second copy still open after
    // they had.
    let mut forward = genuine_conflict();
    run_pipeline(&mut forward);

    let candidate = detect::find(&genuine_conflict())
        .into_iter()
        .next()
        .expect("the fixture disagrees about something");
    let swapped = derive_comparison_id(&candidate.right, &candidate.left).unwrap();
    let straight = derive_comparison_id(&candidate.left, &candidate.right).unwrap();
    assert_eq!(straight, swapped, "the comparison id is a set, not a list");

    let edge = forward.contradiction_edges.values().next().unwrap();
    assert_eq!(edge.comparison_id, straight);
}
