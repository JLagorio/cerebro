//! What reaches a person when they have turned everything down (M27.9).
//!
//! §33 says preference may tune verbosity, ordering, phrasing, grouping and
//! cadence, and may never suppress a protected class. §8 says a few things
//! bypass lanes entirely. Both are asserted where they live —
//! `attention::preferences` attempts suppression through every knob, and
//! `attention::critical` replays its goldens — but neither module has ever
//! been asked the acceptance question, which is about all of them at once:
//! **with every knob at its quietest, does blindness, contradiction AND
//! critical still get through?**
//!
//! **The wrong implementation is a build where each half is right and the
//! composition is not.** A surface that ran `present` and then applied its own
//! cap, or one that fed the bypass through the same preference object because
//! it was there, passes both modules' suites. The composition only exists at
//! the seam, and the seam is what a person actually meets.
//!
//! **The bypass takes no preferences, and that is the assertion.** There is no
//! knob to turn it down because there is no parameter to put one in — this
//! file proves the property by exercising the two together rather than by
//! reading the signature, so a future refactor that threaded preferences in
//! would fail here rather than in review.

use crate::attention::critical::{self, Candidate};
use crate::attention::lanes::{self, Lane};
use crate::attention::preferences::{present, Cadence, Ordering, Preferences, Verbosity};
use crate::attention::status;
use crate::dynamics::bundle;
use crate::ledger::reduce::EpistemicState;

const AS_OF: &str = "2026-08-12T00:00:00Z";

fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(stamp)
        .unwrap()
        .with_timezone(&chrono::Utc)
}

/// Every knob at its quietest, aimed by id at everything in the base.
///
/// Built FROM the computed lanes rather than from a hand-written list: a
/// fixture that dismissed two ids while the base held three would look like a
/// passing suppression test and be testing nothing about the third.
fn everything_turned_down(computed: &lanes::Lanes) -> Preferences {
    let ids: std::collections::BTreeSet<String> = computed
        .items
        .iter()
        .map(|item| item.belief_id.clone())
        .collect();
    Preferences {
        verbosity: Verbosity::Terse,
        ordering: Ordering::ByEntity,
        cadence: Cadence::Quiet,
        dismissed: ids.clone(),
        shown_recently: ids,
    }
}

/// A base with something in every lane: an open edge, an unassessed facet,
/// stale evidence, and a belief the base is standing behind.
fn loud_base() -> EpistemicState {
    use crate::assembly::fixture::{B_ONE, B_TWO};
    use crate::ledger::reduce::ContradictionEdgeRow;
    use crate::ledger::schema::EdgeKind;

    let mut state = lanes::tests::standing();
    let edge_id = "e".repeat(32);
    state.contradiction_edges.insert(
        edge_id.clone(),
        ContradictionEdgeRow {
            edge_id: edge_id.clone(),
            comparison_id: "c".repeat(32),
            kind: EdgeKind::GenuineDirect,
            left_belief_id: B_ONE.into(),
            right_belief_id: B_TWO.into(),
            opened_event_id: "1".repeat(32),
            classified_event_id: "2".repeat(32),
            closed: None,
        },
    );
    state
}

fn computed(state: &EpistemicState) -> (lanes::Definitions, lanes::Lanes) {
    let tables = bundle::Tables::load().expect("the shipped artifacts");
    let definitions = lanes::load().expect("the shipped lane definitions");
    let computed = lanes::lanes(state, &tables, &definitions, &[], at(AS_OF));
    (definitions, computed)
}

/// A migrated base whose every support for one belief traces back to that
/// belief's own revision, and which the base is standing behind.
///
/// The qualification matters: §89's lane is about what the base RELIES on, so
/// a draft holding itself up is a curiosity and a promoted one is debt.
fn descendant_only() -> EpistemicState {
    use crate::assembly::fixture::{B_ONE, OBS_AUTHORITY, OBS_INFERRED, REV_ONE};
    use crate::ledger::schema::Qualification;

    let mut state = lanes::tests::standing();
    state
        .belief_revision_events
        .insert(REV_ONE.into(), (B_ONE.into(), 1));
    for event in [OBS_AUTHORITY, OBS_INFERRED] {
        state
            .derived_belief_sources
            .push((event.into(), REV_ONE.into()));
    }
    state.beliefs.get_mut(B_ONE).unwrap().qualification = Qualification::Qualified;
    state
}

/// The §8 fixture: a production signing certificate that expired yesterday.
fn expired_certificate() -> Vec<Candidate> {
    vec![Candidate {
        id: "cert-1".into(),
        active: true,
        fields: [
            ("kind", "production_signing_certificate"),
            ("environment", "production"),
            ("expires_at", "2026-08-11T00:00:00Z"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect(),
    }]
}

#[test]
fn the_quietest_possible_settings_still_show_blindness_and_contradiction() {
    // The acceptance row, through the function every surface must go through.
    let state = loud_base();
    let (definitions, all) = computed(&state);
    assert!(
        all.of(Lane::Contradiction).count() > 0 && all.of(Lane::Blindness).count() > 0,
        "the fixture must have something in both protected lanes"
    );

    let presented = present(&definitions, &all, &everything_turned_down(&all));

    for lane in [Lane::Contradiction, Lane::Blindness] {
        let before = all.items.iter().filter(|i| i.lane == lane).count();
        let after = presented.items.iter().filter(|i| i.lane == lane).count();
        assert_eq!(
            after,
            before,
            "{lane:?} lost {} item(s) to a preference",
            before - after
        );
    }

    // And the tunable lanes really were quieted, or the assertion above is
    // about a `present` that does nothing at all.
    for lane in [Lane::Staleness, Lane::EpistemicDebt] {
        assert_eq!(
            presented.items.iter().filter(|i| i.lane == lane).count(),
            0,
            "{lane:?} survived every knob, so the knobs are not connected"
        );
    }
    assert!(
        presented.withheld > 0,
        "what was held back has to be sayable, or the cap reads as an empty base"
    );
}

#[test]
fn the_surface_a_person_opens_is_the_one_that_carries_the_guarantee() {
    // One layer up: `status::view` is what the app calls, and it must not be
    // able to re-cap what `present` protected. A surface that applied its own
    // limit would pass every preferences test and break §33 anyway.
    let state = loud_base();
    let (definitions, all) = computed(&state);
    let view = status::view(
        &definitions,
        &all,
        &everything_turned_down(&all),
        Vec::new(),
    );

    for lane in view.lanes.iter().filter(|lane| lane.protected) {
        let expected = all
            .items
            .iter()
            .filter(|i| i.lane.as_str() == lane.id)
            .count();
        assert_eq!(lane.items.len(), expected, "lane {} was thinned", lane.id);
        assert_eq!(lane.withheld, 0);
    }
    // The protected lanes also SAY they are protected, so the guarantee is
    // legible rather than merely true.
    let protected: Vec<&str> = view
        .lanes
        .iter()
        .filter(|lane| lane.protected)
        .map(|lane| lane.id.as_str())
        .collect();
    assert_eq!(protected, ["contradiction", "blindness"]);
}

#[test]
fn the_bypass_fires_under_the_same_settings_that_silenced_everything_else() {
    // §8's half of the acceptance row. The two are composed here and nowhere
    // else, because neither module can see the other.
    let state = loud_base();
    let (definitions, all) = computed(&state);
    let quiet = everything_turned_down(&all);
    let presented = present(&definitions, &all, &quiet);
    assert!(
        presented.withheld > 0,
        "the preferences must actually be suppressing something"
    );

    let triggers = critical::load().expect("the shipped triggers");
    let fired = critical::evaluate(
        &triggers,
        &expired_certificate(),
        &[],
        at("2026-08-12T00:00:00Z"),
    );
    assert_eq!(fired.len(), 1);
    assert_eq!(
        fired[0].trigger_id,
        "production_signing_certificate_expired"
    );
}

#[test]
fn a_belief_held_up_by_its_own_output_reaches_the_debt_lane() {
    // §80 end to end, and the fixture that would have caught the gap: a
    // migrated base whose only support for a belief traces back to that
    // belief's own revision. M26's preventive check never saw it, and until
    // M27.9 nothing downstream did either.
    use crate::dynamics::hygiene;

    let state = descendant_only();
    let findings = hygiene::scan(&state);
    assert!(
        findings
            .iter()
            .any(|f| f.kind == hygiene::FindingKind::DescendantOnlyReinforcement),
        "the fixture must produce the finding this test is about"
    );

    let (_, all) = computed(&state);
    let debt: Vec<&lanes::Item> = all.of(Lane::EpistemicDebt).collect();
    assert!(
        debt.iter().any(|item| item
            .reasons
            .contains(&lanes::Reason::DescendantOnlyReinforcement)),
        "detected and not surfaced is the same as not detected: {debt:?}"
    );
}
