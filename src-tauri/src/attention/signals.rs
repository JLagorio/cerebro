//! The attention primitives (M26.7c) — deterministic signals, no lanes.
//!
//! **These are counts and stamps, never scores.** M27's lanes will rank; this
//! computes the facts a ranking would need. There is deliberately no priority
//! field, no weighting, and no threshold: the moment one appears, the ranking
//! has been decided here rather than in the layer that has to justify it to a
//! person.
//!
//! **`as_of` is an ARGUMENT.** Staleness is the one signal that needs a clock,
//! and passing the time in rather than reading it means the same base at the
//! same moment computes the same row on every machine — and that a test can
//! ask what the signals are on a day of its choosing without pretending to be
//! that day.
//!
//! **Age is measured from when the STORE learned it**, not from the source's
//! own stamp. `occurred_at` is a label the source supplied and D3 refuses to
//! order by it; a source that stamps everything with last year would otherwise
//! make a base that has never been more current look abandoned.
//!
//! **Unresolved contradictions are counted over what exists today**: live
//! declared `contradicts` relations, and the comparisons M26.7b detects. There
//! are no contradiction EDGES yet — M27 opens those — so a comparison here
//! means "nobody has classified this", which is the honest count and not a
//! contradiction count dressed up.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{BasisRole, BeliefBasis, RelationKind};

/// The rules version, so a stored row can be read against the computation
/// that produced it.
pub const SIGNALS_VERSION: &str = "attention-signals-v1";

/// One live belief's signals. Every field is a fact about the base; none of
/// them is an opinion about what to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signals {
    pub belief_id: String,
    pub entity_id: String,
    /// The current revision these signals were computed from.
    pub revision_event_id: String,
    /// Assertions the current revision rests on, `supports` and `opposes`
    /// both — a revision that weighed counterevidence weighed it.
    pub supporting_assertions: u32,
    /// How many distinct registered sources those assertions came from. Not
    /// "independent": independence is a proof M22 records separately, and
    /// two sources with one upstream are one family.
    pub distinct_sources: u32,
    /// The newest `recorded_at` among them, and its age at `as_of`. Both are
    /// `None` for an unsupported revision — which is a different thing from
    /// age zero, and the reason this is an option rather than a default.
    pub newest_evidence_at: Option<String>,
    pub evidence_age_seconds: Option<i64>,
    /// Coverage assessments naming this belief's subject. Zero means BLIND —
    /// nobody has assessed what could be seen — which §90 insists is not the
    /// same as "nothing to see".
    pub coverage_assessments: u32,
    /// Open coverage gaps touching those assessments' sources.
    pub open_coverage_gaps: u32,
    /// Live `contradicts` relations with this belief at either end.
    pub declared_contradictions: u32,
    /// Detected comparisons naming this belief. In M26 every one of them is
    /// unclassified, because there is nothing yet that could classify one.
    pub open_comparisons: u32,
}

/// Compute every live belief's signals as of `as_of`.
///
/// Deterministic and total: `BTreeMap` iteration everywhere, and a belief
/// with nothing to say still gets a row saying so.
pub fn compute(state: &EpistemicState, as_of: chrono::DateTime<chrono::Utc>) -> Vec<Signals> {
    let contradictions = declared_contradictions(state);
    let comparisons = comparison_counts(state);
    let mut out = Vec::new();

    for belief in state.beliefs.values() {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        let revision = belief.current();
        let mut sources: BTreeSet<&str> = BTreeSet::new();
        let mut assertions = 0u32;
        if let BeliefBasis::Linked { links } = &revision.basis {
            for link in links {
                if !matches!(link.role, BasisRole::Supports | BasisRole::Opposes) {
                    continue;
                }
                assertions += 1;
                if let Some(observation) = state.observations.get(&link.observation_event_id) {
                    sources.insert(observation.source_id.as_str());
                }
            }
        }
        let newest = newest_evidence(state, belief);
        let (coverage_assessments, open_coverage_gaps) = coverage_for(state, &belief.entity_id);

        out.push(Signals {
            belief_id: belief.belief_id.clone(),
            entity_id: belief.entity_id.clone(),
            revision_event_id: revision.event_id.clone(),
            supporting_assertions: assertions,
            distinct_sources: sources.len() as u32,
            newest_evidence_at: newest.map(str::to_string),
            evidence_age_seconds: newest.and_then(|stamp| age_seconds(stamp, as_of)),
            coverage_assessments,
            open_coverage_gaps,
            declared_contradictions: *contradictions.get(&belief.belief_id).unwrap_or(&0),
            open_comparisons: *comparisons.get(&belief.belief_id).unwrap_or(&0),
        });
    }
    out
}

/// The newest `recorded_at` behind one belief's CURRENT revision, or `None`
/// when nothing supports it.
///
/// Shared with `convergence::diff`, which asks the same question of two
/// states rather than one. Not a policy — a maximum — but a maximum both
/// sides have to take the same way: a plain string comparison would be wrong
/// for stamps in different offsets, and these are the store's own frame
/// stamps, which are always UTC `Z`. Anything else is a bug in the writer,
/// not a case to guess at here.
pub fn newest_evidence<'a>(
    state: &'a EpistemicState,
    belief: &crate::ledger::reduce::BeliefState,
) -> Option<&'a str> {
    let BeliefBasis::Linked { links } = &belief.current().basis else {
        return None;
    };
    let mut newest: Option<&str> = None;
    for link in links {
        if !matches!(link.role, BasisRole::Supports | BasisRole::Opposes) {
            continue;
        }
        if let Some(facet) = state.assertion_facets.get(&link.observation_event_id) {
            newest = Some(match newest {
                Some(current) if current >= facet.recorded_at.as_str() => current,
                _ => facet.recorded_at.as_str(),
            });
        }
    }
    newest
}

/// Seconds between a recorded stamp and `as_of`, floored at zero.
///
/// A negative age means the store's clock moved backwards between writing the
/// frame and asking the question. That is a real condition — the frame
/// envelope has a `wall_clock_anomaly` flag for exactly it — and reporting a
/// belief as "minus four hours old" would be a worse answer than reporting it
/// as new.
fn age_seconds(recorded_at: &str, as_of: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    let recorded = chrono::DateTime::parse_from_rfc3339(recorded_at).ok()?;
    Some(
        as_of
            .signed_duration_since(recorded.with_timezone(&chrono::Utc))
            .num_seconds()
            .max(0),
    )
}

fn declared_contradictions(state: &EpistemicState) -> BTreeMap<String, u32> {
    let mut out: BTreeMap<String, u32> = BTreeMap::new();
    for relation in state.relations.values() {
        if !relation.live || relation.relation != RelationKind::Contradicts {
            continue;
        }
        for end in [&relation.from, &relation.to] {
            *out.entry(end.clone()).or_default() += 1;
        }
    }
    out
}

fn comparison_counts(state: &EpistemicState) -> BTreeMap<String, u32> {
    let mut out: BTreeMap<String, u32> = BTreeMap::new();
    for comparison in state.comparisons.values() {
        // A comparison between two revisions of ONE belief counts once for
        // that belief: it is one thing to look at, not two.
        let mut ends = BTreeSet::new();
        ends.insert(comparison.left.belief_id.clone());
        ends.insert(comparison.right.belief_id.clone());
        for end in ends {
            *out.entry(end).or_default() += 1;
        }
    }
    out
}

/// How much anybody has assessed about this subject, and how much of that is
/// currently broken.
fn coverage_for(state: &EpistemicState, entity_id: &str) -> (u32, u32) {
    let mut assessments = 0u32;
    let mut sources: BTreeSet<&str> = BTreeSet::new();
    for assessment in state.coverage_assessments.values() {
        // A subject-less assessment covers a source in general, and §90's
        // whole point is that general coverage is not coverage OF this
        // subject. It is not counted here.
        if assessment.subject_id.as_deref() != Some(entity_id) || assessment.superseded {
            continue;
        }
        assessments += 1;
        sources.insert(assessment.source_id.as_str());
    }
    let gaps = state
        .coverage_gaps
        .values()
        .filter(|gap| {
            !gap.closed
                && gap
                    .source_id
                    .as_deref()
                    .is_some_and(|id| sources.contains(id))
        })
        .count() as u32;
    (assessments, gaps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, relate, revision, unsupported, B_KESTREL, B_ONE, B_TWO,
        FALCON, OBS_AUTHORITY, OBS_INFERRED, REV_ONE, REV_TWO,
    };
    use crate::ledger::reduce::AssertionFacet;
    use crate::ledger::schema::{
        derive_value_hash, AuthorityProvenance, Scope, TypedValue, ValidInterval,
    };

    const NOW: &str = "2026-08-12T12:00:00.000Z";

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn facet(recorded_at: &str) -> AssertionFacet {
        AssertionFacet {
            predicate: "cutover_status".into(),
            value_hash: derive_value_hash(&TypedValue::string("on track")).unwrap(),
            scope: Scope::empty(),
            valid_time: ValidInterval {
                from: None,
                to: None,
            },
            recorded_at: recorded_at.into(),
            observed_at: Some("1999-01-01T00:00:00.000Z".into()),
        }
    }

    /// One belief resting on two assertions from two sources, one resting on
    /// nothing at all.
    fn base() -> EpistemicState {
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            B_ONE.into(),
            belief(
                B_ONE,
                FALCON,
                vec![revision(
                    1,
                    REV_ONE,
                    "on track",
                    linked(&[OBS_AUTHORITY, OBS_INFERRED]),
                )],
            ),
        );
        state.beliefs.insert(
            B_TWO.into(),
            belief(
                B_TWO,
                FALCON,
                vec![revision(1, REV_TWO, "slipped", unsupported())],
            ),
        );
        for (event, source, recorded) in [
            (
                OBS_AUTHORITY,
                crate::assembly::fixture::SOURCE_A,
                "2026-08-10T12:00:00.000Z",
            ),
            (
                OBS_INFERRED,
                crate::assembly::fixture::SOURCE_B,
                "2026-08-11T12:00:00.000Z",
            ),
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
            state.assertion_facets.insert(event.into(), facet(recorded));
        }
        state
    }

    fn find<'a>(signals: &'a [Signals], belief_id: &str) -> &'a Signals {
        signals
            .iter()
            .find(|s| s.belief_id == belief_id)
            .expect("a row for every live belief")
    }

    #[test]
    fn age_is_measured_from_the_newest_evidence_the_store_holds() {
        let signals = compute(&base(), now());
        let one = find(&signals, B_ONE);
        assert_eq!(one.supporting_assertions, 2);
        assert_eq!(one.distinct_sources, 2);
        assert_eq!(
            one.newest_evidence_at.as_deref(),
            Some("2026-08-11T12:00:00.000Z"),
            "the newer of the two, not the first one seen"
        );
        assert_eq!(one.evidence_age_seconds, Some(24 * 3600));
    }

    #[test]
    fn the_sources_own_stamp_is_carried_and_never_used_for_age() {
        // Every facet in the fixture claims to have happened in 1999. A base
        // that trusted `occurred_at` would report this belief as decades old
        // when the store learned it yesterday.
        let signals = compute(&base(), now());
        assert_eq!(find(&signals, B_ONE).evidence_age_seconds, Some(24 * 3600));
    }

    #[test]
    fn an_unsupported_revision_has_no_age_rather_than_age_zero() {
        // "We have no evidence" and "the evidence is fresh" are different
        // answers, and a default would make them one.
        let signals = compute(&base(), now());
        let two = find(&signals, B_TWO);
        assert_eq!(two.supporting_assertions, 0);
        assert_eq!(two.newest_evidence_at, None);
        assert_eq!(two.evidence_age_seconds, None);
    }

    #[test]
    fn a_clock_that_went_backwards_reports_new_rather_than_negative() {
        let earlier = chrono::DateTime::parse_from_rfc3339("2020-01-01T00:00:00.000Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let signals = compute(&base(), earlier);
        assert_eq!(find(&signals, B_ONE).evidence_age_seconds, Some(0));
    }

    #[test]
    fn no_assessment_at_all_is_reported_as_zero_which_means_blind() {
        let signals = compute(&base(), now());
        assert_eq!(find(&signals, B_ONE).coverage_assessments, 0);
    }

    #[test]
    fn a_live_contradiction_counts_at_both_ends_and_a_retired_one_at_neither() {
        let mut state = base();
        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            true,
        );
        let signals = compute(&state, now());
        assert_eq!(find(&signals, B_ONE).declared_contradictions, 1);
        assert_eq!(find(&signals, B_TWO).declared_contradictions, 1);

        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            false,
        );
        let signals = compute(&state, now());
        assert_eq!(find(&signals, B_ONE).declared_contradictions, 0);
    }

    #[test]
    fn a_refines_relation_is_not_a_contradiction() {
        let mut state = base();
        state.beliefs.insert(
            B_KESTREL.into(),
            belief(
                B_KESTREL,
                FALCON,
                vec![revision(1, REV_TWO, "after", unsupported())],
            ),
        );
        relate(
            &mut state,
            "r2",
            B_ONE,
            B_KESTREL,
            RelationKind::Refines,
            true,
        );
        assert_eq!(
            find(&compute(&state, now()), B_ONE).declared_contradictions,
            0
        );
    }

    #[test]
    fn a_tombstoned_belief_gets_no_row() {
        let mut state = base();
        state
            .beliefs
            .get_mut(B_TWO)
            .unwrap()
            .tombstoned_by
            .replace("90000000000000000000000000000009".into());
        let signals = compute(&state, now());
        assert!(signals.iter().all(|s| s.belief_id != B_TWO));
    }

    #[test]
    fn the_same_base_at_the_same_moment_computes_the_same_rows() {
        assert_eq!(compute(&base(), now()), compute(&base(), now()));
    }

    #[test]
    fn nothing_here_is_a_score() {
        // The firewall M27 inherits: ranking belongs to the layer that has to
        // justify it to a person. If this ever grows a priority, a weight, or
        // a threshold, the decision has moved here without an argument.
        let source = include_str!("signals.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half")
            .lines()
            // Prose is exempt, and has to be: this module's whole doc is
            // about why there is no ranking here, and a check that forbade
            // the word would forbid the explanation.
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        for forbidden in ["priority", "weight", "score", "rank", "threshold"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the attention primitives' CODE — these are counts \
                 and stamps, and ranking is M27's job"
            );
        }
    }
}
