//! Stale truth, and the axes that must not collapse into each other (M27.9).
//!
//! §37 names "stale truth" as a golden scenario, and it is the one this
//! milestone is most likely to get wrong in a way nobody notices: a belief
//! that is corroborated, uncontested, fully observed, and OLD. Every axis says
//! something good about it except one clock.
//!
//! **The wrong implementation is a build that lets staleness leak.** Under
//! §9's warning against scalar salience and §49's against a monolithic
//! claim-status enum, the three axes are orthogonal on purpose — but nothing
//! in a per-module test notices when they stop being. A build that dropped
//! Support to `single_source` because the evidence aged, or folded a stale
//! facet's coverage back to `partial`, or wrote "possibly wrong" into the
//! composed line, passes every test in `support`, `coverage` and `validity`
//! and is exactly the failure the spec spent three sections warning about.
//!
//! So this asks all three at once, over one belief, and asserts what each one
//! is allowed to say.

use crate::assembly::fixture::{
    belief, linked, observation, revision, B_ONE, FALCON, OBS_AUTHORITY, OBS_INFERRED, REV_ONE,
    SOURCE_A, SOURCE_B,
};
use crate::attention::lanes::{self, Lane, Reason};
use crate::dynamics::bundle::{self, FacetChips};
use crate::dynamics::facet::tests::assertion_facet;
use crate::ledger::reduce::{CoverageAssessment, EpistemicState, IndependenceRow};
use crate::ledger::schema::{
    AuthorityProvenance, DimensionAssessment, DimensionState, Dimensions, IndependenceProof,
    Lifecycle, Stage,
};

const REG: &str = "60000000000000000000000000000001";
/// The evidence, then the two instants either side of the rule's boundary.
///
/// `ci_status` stales 21_600s after `occurred_at`, and the boundary is
/// INCLUSIVE — so 06:00:00 is the first stale instant and 05:59:59 is the last
/// fresh one. Straddling it by one second is what makes these fixtures about
/// the rule rather than about a comfortable margin.
const OBSERVED: &str = "2026-08-12T00:00:00Z";
const AFTER: &str = "2026-08-12T06:00:00Z";
const BEFORE: &str = "2026-08-12T05:59:59Z";

fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(stamp)
        .unwrap()
        .with_timezone(&chrono::Utc)
}

fn dimensions(state: DimensionState) -> Dimensions {
    let one = |state| DimensionAssessment {
        state,
        basis_event_ids: vec![],
        as_of: OBSERVED.into(),
    };
    Dimensions {
        source_connected: one(state),
        source_healthy: one(state),
        scope_known: one(state),
        scope_accessible: one(state),
        retention_known: one(state),
        index_current: one(state),
        retrieval_attempted: one(state),
    }
}

/// A belief in the best shape this system can describe: two independent
/// firsthand families behind one claim, every coverage dimension assessed
/// `yes`, no contradiction anywhere near it — and evidence recorded at
/// `OBSERVED`, which the shipped `ci_status` rule stales six hours later.
fn stale_truth() -> EpistemicState {
    let mut state = EpistemicState::default();
    state.beliefs.insert(
        B_ONE.into(),
        belief(
            B_ONE,
            FALCON,
            vec![revision(
                1,
                REV_ONE,
                "the pipeline was green",
                linked(&[OBS_AUTHORITY, OBS_INFERRED]),
            )],
        ),
    );
    for (event, source) in [(OBS_AUTHORITY, SOURCE_A), (OBS_INFERRED, SOURCE_B)] {
        state.observations.insert(
            event.into(),
            observation(
                event,
                FALCON,
                source,
                AuthorityProvenance::RegisteredDirectArtifact,
            ),
        );
        let mut assertion = assertion_facet("ci_status", Some(Stage::Implemented), OBSERVED);
        // `ci_status` measures from `occurred_at`, so this is the stamp the
        // freshness clock actually reads.
        assertion.observed_at = Some(OBSERVED.into());
        state.assertion_facets.insert(event.into(), assertion);

        state.coverage_assessments.insert(
            format!("assessment-{source}"),
            CoverageAssessment {
                assessment_id: format!("assessment-{source}"),
                subject_id: Some(FALCON.into()),
                predicate_class: None,
                scope: crate::ledger::schema::Scope::empty(),
                source_id: source.into(),
                dimensions: dimensions(DimensionState::Yes),
                retrieval_receipt: None,
                superseded: false,
            },
        );
    }
    // The proof that makes two sources two families rather than one origin
    // wearing two hats. Without it this belief is `single_source` and the
    // scenario is not the one §37 names.
    let (left, right) = if OBS_AUTHORITY <= OBS_INFERRED {
        (OBS_AUTHORITY, OBS_INFERRED)
    } else {
        (OBS_INFERRED, OBS_AUTHORITY)
    };
    state.independence.insert(
        (left.into(), right.into()),
        IndependenceRow {
            event_id: "90000000000000000000000000000001".into(),
            proof_kind: "independent_system_artifact".into(),
            proof: IndependenceProof::IndependentSystemArtifact {
                left_source_registration_event_id: REG.into(),
                right_source_registration_event_id: REG.into(),
                rule_version: "independence-rules-v1".into(),
            },
        },
    );
    state
}

fn chips(state: &EpistemicState, as_of: &str) -> FacetChips {
    let tables = bundle::Tables::load().expect("the shipped artifacts");
    let mut rows = bundle::all_chips(state, &tables, at(as_of));
    assert_eq!(rows.len(), 1, "the fixture holds one belief");
    let mut belief = rows.remove(0);
    assert_eq!(belief.facets.len(), 1, "one predicate at one stage");
    belief.facets.remove(0)
}

#[test]
fn a_stale_truth_is_stale_and_nothing_else() {
    // §37's golden scenario. The clock moved and NOTHING else may move with
    // it: this is the assertion that keeps three axes from becoming one.
    let state = stale_truth();
    let fresh = chips(&state, BEFORE);
    let stale = chips(&state, AFTER);

    assert_eq!(fresh.validity.freshness.as_str(), "fresh");
    assert_eq!(stale.validity.freshness.as_str(), "stale");

    // Support is untouched. Aging evidence is still the same evidence from
    // the same two independent families — a build that demoted it here would
    // be answering "is this still current" with "how well is it attested".
    assert_eq!(fresh.support.level(), "corroborated");
    assert_eq!(stale.support.level(), fresh.support.level());
    assert_eq!(
        stale.support.ancestral_family_count(),
        fresh.support.ancestral_family_count()
    );

    // Coverage is untouched. How much anybody LOOKED does not change because
    // time passed since they looked.
    assert_eq!(fresh.coverage.summary().as_str(), "observed");
    assert_eq!(stale.coverage.summary(), fresh.coverage.summary());

    // And the rest of Validity is untouched: nothing contests this and
    // nothing retired it.
    assert_eq!(stale.validity.conflict.as_str(), "clear");
    assert_eq!(stale.validity.lifecycle.as_str(), "active");
}

#[test]
fn nothing_on_the_surface_calls_a_stale_truth_wrong() {
    // The tone half of the same claim, and the one a reader meets first.
    // "Stale" means nobody has checked lately. A line that reached for
    // "unverified", "doubtful" or "may be wrong" would be asserting something
    // about the world that no rule in this milestone derived.
    let stale = chips(&stale_truth(), AFTER);

    assert!(
        stale.validity_text.contains("stale"),
        "the honest word is missing: {}",
        stale.validity_text
    );
    for forbidden in [
        "wrong",
        "false",
        "incorrect",
        "doubt",
        "unreliable",
        "suspect",
        "invalid",
    ] {
        assert!(
            !stale.line.to_lowercase().contains(forbidden),
            "{forbidden:?} appears in {:?} — staleness is a clock, not a verdict",
            stale.line
        );
    }
    // And it still says the two good things out loud rather than leading
    // with the bad one.
    assert!(stale.line.contains("corroborated"), "{}", stale.line);
    assert!(stale.line.contains("observed"), "{}", stale.line);
}

#[test]
fn a_stale_truth_is_in_one_lane_and_only_one() {
    // The lanes are where a person meets this, and a build that put a stale
    // belief in the blindness or contradiction lane would be telling them to
    // go and resolve something that is not there. Both of those lanes are
    // PROTECTED, so a false positive in either cannot be turned off.
    let state = stale_truth();
    let tables = bundle::Tables::load().expect("the shipped artifacts");
    let definitions = lanes::load().expect("the shipped lane definitions");
    let computed = lanes::lanes(&state, &tables, &definitions, &[], at(AFTER));

    let staleness: Vec<&lanes::Item> = computed.of(Lane::Staleness).collect();
    assert_eq!(staleness.len(), 1);
    assert_eq!(staleness[0].reasons, vec![Reason::FreshnessStale]);

    assert_eq!(computed.of(Lane::Contradiction).count(), 0);
    assert_eq!(computed.of(Lane::Blindness).count(), 0);
    // Nor is it debt. Nobody is standing on an unsupported claim here — the
    // claim is well supported and merely old, and §89's lane is about what
    // the base cannot stand behind.
    assert_eq!(computed.of(Lane::EpistemicDebt).count(), 0);

    // Before the boundary it is in no lane at all. Without this the test
    // above would pass for a build that put everything in the staleness lane.
    let earlier = lanes::lanes(&state, &tables, &definitions, &[], at(BEFORE));
    assert!(earlier.items.is_empty(), "{:?}", earlier.items);
}

#[test]
fn an_archived_belief_keeps_its_freshness_and_its_contest_beside_it() {
    // The acceptance row that says lifecycle is a fourth fact and not a
    // replacement for the other three. A build that short-circuited on
    // `archived` would lose the reason somebody archived it.
    use crate::assembly::fixture::relate;
    use crate::ledger::schema::RelationKind;

    let mut state = stale_truth();
    state.beliefs.get_mut(B_ONE).unwrap().lifecycle = Lifecycle::Archived;
    // A second belief to contradict it with, and a live declaration between
    // them — the cheapest thing that makes `conflict` contested.
    let other = "b0000000000000000000000000000009";
    state.beliefs.insert(
        other.into(),
        belief(
            other,
            FALCON,
            vec![revision(
                1,
                "10000000000000000000000000000009",
                "it was red",
                linked(&[]),
            )],
        ),
    );
    relate(
        &mut state,
        &"r".repeat(32),
        other,
        B_ONE,
        RelationKind::Contradicts,
        true,
    );

    let tables = bundle::Tables::load().expect("the shipped artifacts");
    let rows = bundle::all_chips(&state, &tables, at(AFTER));
    let facet = rows
        .iter()
        .find(|row| row.belief_id == B_ONE)
        .and_then(|row| row.facets.first())
        .expect("the archived belief still has a facet");

    assert_eq!(facet.validity.lifecycle.as_str(), "archived");
    assert_eq!(facet.validity.freshness.as_str(), "stale");
    assert_eq!(facet.validity.conflict.as_str(), "contested");
    assert_eq!(
        facet.support.level(),
        "corroborated",
        "archiving is a decision about relevance, not about evidence"
    );
}

#[test]
fn the_same_state_read_a_week_later_says_the_same_thing() {
    // §37's replay clause. Freshness is a function of `state` and the instant
    // it is asked about — never of when the process happens to run — so two
    // reads at the same instant agree no matter how much wall-clock has
    // passed between them, and the byte-level assertion is what proves the
    // derivation never reached for a clock of its own.
    let state = stale_truth();
    let first = chips(&state, AFTER);
    let later = chips(&state, AFTER);
    assert_eq!(
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&later).unwrap()
    );

    // A week further on it is still stale, and stale in the same words: the
    // rule is a boundary, not a decaying score.
    let a_week_on = chips(&state, "2026-08-19T06:00:00Z");
    assert_eq!(a_week_on.validity_text, first.validity_text);
    assert_eq!(a_week_on.freshness_basis, first.freshness_basis);
}
