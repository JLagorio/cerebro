//! The deterministic conflict detector (M26.7b).
//!
//! **It reads no clock, no prose, and no model.** Everything below is a
//! function of reducer state: which beliefs are live, what their current
//! revisions rest on, and what those assertions said about subject,
//! predicate, value digest, scope, and valid time. Two runs over the same
//! base find the same pairs in the same order, which is what makes the
//! comparison ids stable and the append idempotent.
//!
//! **It never decides that anything disagrees.** The output is "these two
//! need classifying, and here is what did not separate them" — M27's gauntlet
//! resolves subject, scope, time, stage, and finally meaning. The reason
//! codes are therefore mostly statements about what is NOT ruled out.
//!
//! **Agreement is not a candidate.** A pair whose value digests match is a
//! duplicate, and duplicates belong to the maintenance pass's exact-merge
//! finder, which already has the right risk class for them. Raising them here
//! too would be two systems asking one question.
//!
//! **A declared `contradicts` relation ENRICHES a candidate; it does not
//! create one.** M27 owns declared-relation comparisons outright — they have
//! a different id formula and their own registration event, because neither
//! legacy migration nor relation editing fabricates the assertions an
//! endpoint needs. What M26 can honestly say is that a pair it found on the
//! evidence also has someone's declaration attached to it.

use std::collections::BTreeMap;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    BasisRole, BeliefBasis, ConflictCandidateEndpointV1, ConflictCandidateReason, RelationKind,
    Scope, StateStage, ValidInterval,
};

/// Which detector build produced a signal, so it can be read against the
/// rules that produced it.
pub const DETECTOR_VERSION: &str = "conflict-detector-v1";

/// One pair worth classifying. Endpoints are already in the canonical order
/// the comparison id sorts them into.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub left: ConflictCandidateEndpointV1,
    pub right: ConflictCandidateEndpointV1,
    pub reason_codes: Vec<ConflictCandidateReason>,
}

/// An endpoint plus the belief it came from, so relation lookups do not have
/// to go back through the state.
struct Sighting {
    belief_id: String,
    endpoint: ConflictCandidateEndpointV1,
}

/// Every comparable endpoint in the base.
///
/// The CURRENT revision of each live belief, and only that. A detector that
/// walked every historical revision would raise a comparison for every pair
/// of things the base has ever believed, which is a different feature
/// (M27 compares revisions historically, on purpose, against a pinned
/// endpoint) and not one anybody asked for as background work.
fn sightings(state: &EpistemicState) -> Vec<Sighting> {
    let mut out = Vec::new();
    for belief in state.beliefs.values() {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        let revision = belief.current();
        let BeliefBasis::Linked { links } = &revision.basis else {
            continue;
        };
        for link in links {
            // `context` links are not claims about the subject — they are
            // background the revision cited. Comparing them would compare
            // things nobody asserted.
            if !matches!(link.role, BasisRole::Supports | BasisRole::Opposes) {
                continue;
            }
            let Some(facet) = state.assertion_facets.get(&link.observation_event_id) else {
                continue;
            };
            out.push(Sighting {
                belief_id: belief.belief_id.clone(),
                endpoint: ConflictCandidateEndpointV1 {
                    assertion_event_id: link.observation_event_id.clone(),
                    belief_id: belief.belief_id.clone(),
                    belief_revision_event_id: revision.event_id.clone(),
                    subject_id: belief.entity_id.clone(),
                    predicate: facet.predicate.clone(),
                    value_hash: facet.value_hash.clone(),
                    scope: facet.scope.clone(),
                    state_stage: StateStage::of(facet.scope.stage),
                    valid_time: facet.valid_time.clone(),
                },
            });
        }
    }
    out
}

/// Do two scope qualifiers leave room for each other? An unset qualifier
/// applies everywhere, so it overlaps anything; two set ones overlap only
/// when they match.
fn qualifiers_overlap(a: &Scope, b: &Scope) -> bool {
    [
        (&a.revision, &b.revision),
        (&a.environment, &b.environment),
        (&a.geography, &b.geography),
    ]
    .iter()
    .all(|(left, right)| match (left, right) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    })
}

fn stages_overlap(a: &Scope, b: &Scope) -> bool {
    match (a.stage, b.stage) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    }
}

/// Interval overlap on the instant line, with an unset end open.
///
/// The stamps are parsed rather than string-compared: `2026-08-10T00:00:00Z`
/// and `2026-08-09T20:00:00-04:00` are the same moment and sort differently
/// as text. An unparseable stamp cannot be committed (the schema refuses it),
/// so treating one as open here is unreachable rather than lenient.
fn instant(stamp: &Option<String>) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    stamp
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
}

fn valid_times_overlap(a: &ValidInterval, b: &ValidInterval) -> bool {
    let (a_from, a_to) = (instant(&a.from), instant(&a.to));
    let (b_from, b_to) = (instant(&b.from), instant(&b.to));
    let starts_before_other_ends = match (a_from, b_to) {
        (Some(from), Some(to)) => from <= to,
        _ => true,
    };
    let other_starts_before_this_ends = match (b_from, a_to) {
        (Some(from), Some(to)) => from <= to,
        _ => true,
    };
    starts_before_other_ends && other_starts_before_this_ends
}

/// Live `contradicts` relations, as an unordered belief-pair lookup.
fn declared(state: &EpistemicState) -> BTreeMap<(String, String), ()> {
    state
        .relations
        .values()
        .filter(|r| r.live && r.relation == RelationKind::Contradicts)
        .map(|r| {
            let (a, b) = if r.from <= r.to {
                (r.from.clone(), r.to.clone())
            } else {
                (r.to.clone(), r.from.clone())
            };
            ((a, b), ())
        })
        .collect()
}

/// Find every pair worth classifying.
///
/// Deterministic in what it returns AND in what order: sightings come out of
/// `BTreeMap` iteration, and the pairs are walked in index order, so the
/// returned vector is a function of the state alone.
pub fn find(state: &EpistemicState) -> Vec<Candidate> {
    let sightings = sightings(state);
    let declared = declared(state);
    let mut out = Vec::new();

    for (i, one) in sightings.iter().enumerate() {
        for two in sightings.iter().skip(i + 1) {
            if one.endpoint.subject_id != two.endpoint.subject_id
                || one.endpoint.predicate != two.endpoint.predicate
            {
                continue;
            }
            // Agreement is a duplicate, and duplicates are the maintenance
            // pass's exact-merge finder. A pair that says the same thing is
            // not a question about what is true.
            if one.endpoint.value_hash == two.endpoint.value_hash {
                continue;
            }
            // The same assertion reached through two beliefs is one claim
            // seen twice, not two claims.
            if one.endpoint.assertion_event_id == two.endpoint.assertion_event_id {
                continue;
            }

            let mut reasons = vec![
                ConflictCandidateReason::IncompatibleValueHash,
                ConflictCandidateReason::SameSubjectPredicate,
            ];
            if qualifiers_overlap(&one.endpoint.scope, &two.endpoint.scope) {
                reasons.push(ConflictCandidateReason::OverlappingScope);
            }
            if valid_times_overlap(&one.endpoint.valid_time, &two.endpoint.valid_time) {
                reasons.push(ConflictCandidateReason::OverlappingValidTime);
            }
            if stages_overlap(&one.endpoint.scope, &two.endpoint.scope) {
                reasons.push(ConflictCandidateReason::StageRequiresClassification);
            }
            let pair = if one.belief_id <= two.belief_id {
                (one.belief_id.clone(), two.belief_id.clone())
            } else {
                (two.belief_id.clone(), one.belief_id.clone())
            };
            if declared.contains_key(&pair) {
                reasons.push(ConflictCandidateReason::DeclaredContradictsRelation);
            }
            reasons.sort_unstable();

            let (left, right) = canonical_order(&one.endpoint, &two.endpoint);
            out.push(Candidate {
                left,
                right,
                reason_codes: reasons,
            });
        }
    }
    out
}

/// Put the pair in the order the comparison id sorts them into, so the body
/// the emitter builds is a function of the pair rather than of the scan.
fn canonical_order(
    a: &ConflictCandidateEndpointV1,
    b: &ConflictCandidateEndpointV1,
) -> (ConflictCandidateEndpointV1, ConflictCandidateEndpointV1) {
    match serde_json::to_string(a) {
        Ok(rendered) => match crate::ledger::schema::ordered_endpoints(a, b) {
            Ok((first, _)) if rendered == first => (a.clone(), b.clone()),
            Ok(_) => (b.clone(), a.clone()),
            // Unreachable: both endpoints serialized a line above. Keeping
            // the given order means a malformed pair is refused by the
            // schema rather than silently reordered into a different id.
            Err(_) => (a.clone(), b.clone()),
        },
        Err(_) => (a.clone(), b.clone()),
    }
}

/// Never a clock, never prose, never a model — the same tripwire the
/// maintenance finders carry, for the same reason. A detector that could read
/// the time could raise a candidate because something got old, and "old" is
/// not a disagreement.
#[cfg(test)]
mod discipline {
    #[test]
    fn nothing_in_the_detector_reads_a_clock_or_a_claim() {
        let source = include_str!("detect.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in [
            "Utc::now",
            "SystemTime",
            "Local::now",
            "extracted_text",
            "rendered_text",
            ".content",
        ] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the detector — it compares shapes, not claims, and \
                 never asks what time it is"
            );
        }
    }
}

/// The detector's fixture, at module scope because [`super::emit`]'s tests
/// build against it too — a second copy of "a base that disagrees with
/// itself" is a second base that drifts.
#[cfg(test)]
pub(crate) mod fixture {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, revision, B_KESTREL, B_ONE, B_TWO, FALCON, KESTREL,
        OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED, REV_KESTREL, REV_ONE, REV_TWO, SOURCE_A,
        SOURCE_B, SOURCE_C,
    };
    use crate::ledger::reduce::AssertionFacet;
    use crate::ledger::schema::{derive_value_hash, AuthorityProvenance, Stage, TypedValue};

    pub(crate) fn scope(stage: Option<Stage>, environment: Option<&str>) -> Scope {
        Scope {
            stage,
            revision: None,
            environment: environment.map(str::to_string),
            geography: None,
        }
    }

    pub(crate) fn interval(from: Option<&str>, to: Option<&str>) -> ValidInterval {
        ValidInterval {
            from: from.map(str::to_string),
            to: to.map(str::to_string),
        }
    }

    pub(crate) fn facet(predicate: &str, value: &str, scope: Scope) -> AssertionFacet {
        AssertionFacet {
            predicate: predicate.into(),
            value_hash: derive_value_hash(&TypedValue::string(value)).unwrap(),
            scope,
            valid_time: interval(None, None),
        }
    }

    /// Two beliefs about Falcon that say different things about the same
    /// predicate, and one about Kestrel that says something else entirely.
    pub(crate) fn base() -> EpistemicState {
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            B_ONE.into(),
            belief(
                B_ONE,
                FALCON,
                vec![revision(1, REV_ONE, "on track", linked(&[OBS_AUTHORITY]))],
            ),
        );
        state.beliefs.insert(
            B_TWO.into(),
            belief(
                B_TWO,
                FALCON,
                vec![revision(1, REV_TWO, "slipped", linked(&[OBS_PLANNED]))],
            ),
        );
        state.beliefs.insert(
            B_KESTREL.into(),
            belief(
                B_KESTREL,
                KESTREL,
                vec![revision(1, REV_KESTREL, "after", linked(&[OBS_INFERRED]))],
            ),
        );
        for (event, source) in [
            (OBS_AUTHORITY, SOURCE_A),
            (OBS_PLANNED, SOURCE_C),
            (OBS_INFERRED, SOURCE_B),
        ] {
            state.observations.insert(
                event.into(),
                observation(
                    event,
                    FALCON,
                    source,
                    AuthorityProvenance::RegisteredDirectArtifact,
                ),
            );
        }
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            facet("cutover_status", "on track", scope(None, None)),
        );
        state.assertion_facets.insert(
            OBS_PLANNED.into(),
            facet("cutover_status", "slipped", scope(None, None)),
        );
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            facet("ship_order", "after Falcon", scope(None, None)),
        );
        state
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{base, facet, interval, scope};
    use super::*;
    use crate::assembly::fixture::{
        relate, unsupported, B_ONE, B_TWO, FALCON, OBS_AUTHORITY, OBS_PLANNED,
    };
    use crate::ledger::schema::Stage;

    #[test]
    fn one_pair_disagreeing_about_one_predicate_is_one_candidate() {
        let found = find(&base());
        assert_eq!(found.len(), 1, "{found:#?}");
        let candidate = &found[0];
        assert_eq!(candidate.left.subject_id, FALCON);
        assert!(candidate.reason_codes.windows(2).all(|p| p[0] < p[1]));
        assert!(candidate
            .reason_codes
            .contains(&ConflictCandidateReason::IncompatibleValueHash));
        assert!(candidate
            .reason_codes
            .contains(&ConflictCandidateReason::SameSubjectPredicate));
        // Nothing separated them, so both non-separations are named.
        assert!(candidate
            .reason_codes
            .contains(&ConflictCandidateReason::OverlappingScope));
        assert!(candidate
            .reason_codes
            .contains(&ConflictCandidateReason::StageRequiresClassification));
        // Nobody declared anything.
        assert!(!candidate
            .reason_codes
            .contains(&ConflictCandidateReason::DeclaredContradictsRelation));
    }

    #[test]
    fn agreement_is_not_a_candidate() {
        // Same predicate, same value: a duplicate, which is the maintenance
        // pass's exact-merge finder's question and not this one's.
        let mut state = base();
        state.assertion_facets.insert(
            OBS_PLANNED.into(),
            facet("cutover_status", "on track", scope(None, None)),
        );
        assert!(find(&state).is_empty());
    }

    #[test]
    fn two_subjects_saying_different_things_are_not_in_conflict() {
        // Kestrel's belief disagrees with nothing: different subject AND a
        // different predicate. Same words about a different entity is never
        // this module's business.
        let found = find(&base());
        assert!(found
            .iter()
            .all(|c| c.left.subject_id == FALCON && c.right.subject_id == FALCON));
    }

    #[test]
    fn a_tombstoned_belief_brings_nothing_to_compare() {
        let mut state = base();
        state
            .beliefs
            .get_mut(B_TWO)
            .unwrap()
            .tombstoned_by
            .replace("90000000000000000000000000000009".into());
        assert!(find(&state).is_empty());
    }

    #[test]
    fn an_unsupported_revision_has_no_endpoint_to_offer() {
        // Not a gap being hidden: an endpoint is a claim that a belief rested
        // on an assertion, and an unsupported revision rested on none.
        let mut state = base();
        state.beliefs.get_mut(B_TWO).unwrap().revisions[0].basis = unsupported();
        assert!(find(&state).is_empty());
    }

    #[test]
    fn disjoint_stages_are_reported_as_separated_rather_than_dropped() {
        // M27's gauntlet resolves stage, and "we almost called this a
        // contradiction and here is why we didn't" is worth recording. So
        // the pair is still raised — without the stage reason.
        let mut state = base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            facet(
                "cutover_status",
                "on track",
                scope(Some(Stage::Shipping), None),
            ),
        );
        state.assertion_facets.insert(
            OBS_PLANNED.into(),
            facet(
                "cutover_status",
                "slipped",
                scope(Some(Stage::Planned), None),
            ),
        );
        let found = find(&state);
        assert_eq!(found.len(), 1);
        assert!(!found[0]
            .reason_codes
            .contains(&ConflictCandidateReason::StageRequiresClassification));
    }

    #[test]
    fn a_declared_contradiction_enriches_a_candidate_it_did_not_create() {
        let mut state = base();
        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            true,
        );
        let found = find(&state);
        assert_eq!(found.len(), 1);
        assert!(found[0]
            .reason_codes
            .contains(&ConflictCandidateReason::DeclaredContradictsRelation));

        // And a retired relation says nothing.
        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            false,
        );
        assert!(!find(&state)[0]
            .reason_codes
            .contains(&ConflictCandidateReason::DeclaredContradictsRelation));
    }

    #[test]
    fn a_declared_contradiction_with_nothing_to_pin_creates_nothing() {
        // Both sides unsupported: M27's `comparison_registered` owns this
        // case, with its own id formula and its own tagged endpoint, because
        // nothing here may fabricate the assertion an endpoint needs.
        let mut state = base();
        for id in [B_ONE, B_TWO] {
            state.beliefs.get_mut(id).unwrap().revisions[0].basis = unsupported();
        }
        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            true,
        );
        assert!(find(&state).is_empty());
    }

    #[test]
    fn the_same_base_finds_the_same_pairs_in_the_same_order() {
        assert_eq!(find(&base()), find(&base()));
    }

    #[test]
    fn an_unset_qualifier_applies_everywhere() {
        assert!(qualifiers_overlap(
            &scope(None, None),
            &scope(None, Some("prod"))
        ));
        assert!(qualifiers_overlap(
            &scope(None, Some("prod")),
            &scope(None, Some("prod"))
        ));
        assert!(!qualifiers_overlap(
            &scope(None, Some("prod")),
            &scope(None, Some("staging"))
        ));
    }

    #[test]
    fn two_named_stages_that_differ_separate_the_pair() {
        assert!(stages_overlap(&scope(None, None), &scope(None, None)));
        assert!(stages_overlap(
            &scope(Some(Stage::Planned), None),
            &scope(None, None)
        ));
        assert!(!stages_overlap(
            &scope(Some(Stage::Planned), None),
            &scope(Some(Stage::Shipping), None)
        ));
    }

    #[test]
    fn valid_time_is_compared_as_instants_not_as_text() {
        // The same moment, spelled two ways. A string comparison puts the
        // second one first and would call these disjoint.
        let utc = interval(Some("2026-08-10T00:00:00Z"), None);
        let offset = interval(None, Some("2026-08-09T20:00:00-04:00"));
        assert!(valid_times_overlap(&utc, &offset));

        let earlier = interval(None, Some("2026-08-01T00:00:00Z"));
        assert!(!valid_times_overlap(&utc, &earlier));
    }

    #[test]
    fn an_open_interval_overlaps_anything() {
        let open = interval(None, None);
        assert!(valid_times_overlap(
            &open,
            &interval(Some("2020-01-01T00:00:00Z"), Some("2020-01-02T00:00:00Z"))
        ));
    }
}
