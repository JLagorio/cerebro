//! [`BeliefFacetKey`] — what the three axes are actually about (M27.1).
//!
//! **A belief is not the unit of assessment; a facet is.** One revision can
//! rest on an assertion about `ci_status` at stage `implemented` and another
//! about `bill_of_materials` at stage `shipping`. Those two claims go stale on
//! different clocks, are authoritative through different routes, and are
//! covered by different sources. Answering "how fresh is this belief?" would
//! force a choice of canonical predicate and stage that nothing in the base
//! authorizes, and whichever one won would be wrong about the other.
//!
//! **`supports` only.** A facet is derived from the links the revision
//! declared as `supports`, not from `opposes` or `context`. Counterevidence is
//! weighed by a revision and is genuinely part of its history — that is why
//! [`crate::attention::signals`] counts both — but the question these axes
//! answer is "what rests UNDER this claim", and an assertion recorded as
//! opposing it does not.
//!
//! **An unsupported revision yields exactly one facet, and it is not an
//! absence.** `unknown/unknown` is a row that says "there is nothing here to
//! key on", which is a different sentence from having no rows at all. The
//! empty case is said out loud, here as everywhere in this codebase.
//!
//! **The derivation is Rust-side and deliberately outside the conformance
//! vector contract**, for the same reason [`crate::ledger::reduce`]'s
//! `assertion_facets` index is: it reads the predicate and scope of each
//! assertion, and the TypeScript reducer holds neither. What crosses the
//! language boundary is the KEY — a closed shape the
//! `freshness.transitioned` body carries and both reducers validate — not the
//! walk that produced it.

use std::collections::BTreeSet;

use crate::ledger::reduce::{BeliefState, EpistemicState};
use crate::ledger::schema::{BasisRole, BeliefBasis, StateStage};

// The KEY itself belongs to the ledger schema, not here: it is a field of the
// `freshness.transitioned` body, and a wire shape defined beside its
// derivation is a wire shape one refactor away from being defined twice.
// What this module owns is the WALK — which facets a revision has — and that
// is Rust-only for the reason the module doc gives.
pub use crate::ledger::schema::{BeliefFacetKey, FacetPredicate};

/// One derived facet: its key, and the assertion events that produced it.
///
/// The supports are carried because every axis needs them — freshness picks
/// an anchor from them, Support counts families among them, Coverage folds the
/// assessments of their sources. Deriving the key without them would mean
/// walking the basis three more times.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facet {
    pub key: BeliefFacetKey,
    /// Sorted, duplicate-free assertion (observation) event ids.
    pub supports: Vec<String>,
}

/// Every facet of one belief's CURRENT revision.
///
/// Deterministic and total: `BTreeSet` ordering throughout, and a revision
/// that supports nothing still gets its one `unknown/unknown` row.
pub fn facets_of(state: &EpistemicState, belief: &BeliefState) -> Vec<Facet> {
    facets_of_revision(state, belief, belief.current().event_id.as_str())
}

/// Every facet of one PINNED revision of a belief.
///
/// Returns an empty vector when the revision does not belong to this belief —
/// a caller asking about a revision that is not there gets nothing rather
/// than a fabricated unsupported facet.
pub fn facets_of_revision(
    state: &EpistemicState,
    belief: &BeliefState,
    revision_event_id: &str,
) -> Vec<Facet> {
    let Some(revision) = belief
        .revisions
        .iter()
        .find(|r| r.event_id == revision_event_id)
    else {
        return Vec::new();
    };

    // BTreeMap over the key so the pairs come out in one deterministic order
    // regardless of basis-link order, and so two links about the same
    // (predicate, stage) collapse into one facet carrying both.
    let mut pairs: std::collections::BTreeMap<(FacetPredicate, StateStage), BTreeSet<String>> =
        std::collections::BTreeMap::new();

    if let BeliefBasis::Linked { links } = &revision.basis {
        for link in links {
            if link.role != BasisRole::Supports {
                continue;
            }
            // An assertion the reducer never indexed is one that asserted no
            // predicate at all (a snapshot, a system event). It supports the
            // belief and contributes no facet key, which is why it lands in
            // the `unknown/unknown` bucket rather than being dropped: the
            // evidence is real even when the key is not.
            let (predicate, stage) = match state.assertion_facets.get(&link.observation_event_id) {
                Some(facet) => (
                    FacetPredicate::Known {
                        value: facet.predicate.clone(),
                    },
                    StateStage::of(facet.scope.stage),
                ),
                None => (FacetPredicate::Unknown, StateStage::Unknown),
            };
            pairs
                .entry((predicate, stage))
                .or_default()
                .insert(link.observation_event_id.clone());
        }
    }

    if pairs.is_empty() {
        // Said out loud: one facet keyed on nothing, with no supports. An
        // empty vector here would read as "this belief has no facets", which
        // is a different and false claim.
        return vec![Facet {
            key: BeliefFacetKey {
                belief_id: belief.belief_id.clone(),
                belief_revision_event_id: revision.event_id.clone(),
                predicate: FacetPredicate::Unknown,
                state_stage: StateStage::Unknown,
            },
            supports: Vec::new(),
        }];
    }

    pairs
        .into_iter()
        .map(|((predicate, state_stage), supports)| Facet {
            key: BeliefFacetKey {
                belief_id: belief.belief_id.clone(),
                belief_revision_event_id: revision.event_id.clone(),
                predicate,
                state_stage,
            },
            supports: supports.into_iter().collect(),
        })
        .collect()
}

/// Every facet of every live belief's current revision, belief id order.
pub fn all_facets(state: &EpistemicState) -> Vec<Facet> {
    state
        .beliefs
        .values()
        .filter(|belief| belief.tombstoned_by.is_none())
        .flat_map(|belief| facets_of(state, belief))
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, revision, unsupported, B_ONE, B_TWO, FALCON, OBS_AUTHORITY,
        OBS_INFERRED, REV_ONE, REV_TWO, SOURCE_A,
    };
    use crate::ledger::reduce::AssertionFacet;
    use crate::ledger::schema::{
        derive_value_hash, AuthorityProvenance, Scope, Stage, TypedValue, ValidInterval,
    };

    /// An indexed assertion with a predicate and a stage.
    pub(crate) fn assertion_facet(
        predicate: &str,
        stage: Option<Stage>,
        recorded_at: &str,
    ) -> AssertionFacet {
        AssertionFacet {
            predicate: predicate.into(),
            value_hash: derive_value_hash(&TypedValue::string(predicate)).unwrap(),
            scope: Scope {
                stage,
                ..Scope::empty()
            },
            valid_time: ValidInterval {
                from: None,
                to: None,
            },
            recorded_at: recorded_at.into(),
            observed_at: None,
            relationship_role: crate::ledger::schema::SubjectRole::Unknown,
            source_artifact_hash: None,
            raw_pointer: None,
        }
    }

    /// One belief resting on two assertions, plus one resting on nothing.
    pub(crate) fn base() -> EpistemicState {
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
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.observations.insert(
                event.into(),
                observation(
                    event,
                    FALCON,
                    SOURCE_A,
                    AuthorityProvenance::RegisteredDirectArtifact,
                ),
            );
        }
        state
    }

    #[test]
    fn two_predicates_on_one_revision_are_two_facets() {
        // The whole reason the key exists: a CI status and a BOM line go
        // stale on different clocks, and a single answer about "the belief"
        // would be wrong about one of them.
        let mut state = base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            assertion_facet(
                "ci_status",
                Some(Stage::Implemented),
                "2026-08-01T00:00:00Z",
            ),
        );
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            assertion_facet(
                "bill_of_materials",
                Some(Stage::Shipping),
                "2026-08-02T00:00:00Z",
            ),
        );
        let facets = facets_of(&state, state.beliefs.get(B_ONE).unwrap());
        assert_eq!(facets.len(), 2);
        assert_eq!(
            facets[0].key.predicate.value(),
            Some("bill_of_materials"),
            "sorted by the key, not by basis-link order"
        );
        assert_eq!(facets[0].key.state_stage, StateStage::Shipping);
        assert_eq!(facets[1].key.predicate.value(), Some("ci_status"));
        assert_eq!(facets[1].key.state_stage, StateStage::Implemented);
        assert_eq!(facets[0].supports, vec![OBS_INFERRED.to_string()]);
    }

    #[test]
    fn one_predicate_at_one_stage_from_two_assertions_is_one_facet() {
        let mut state = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.assertion_facets.insert(
                event.into(),
                assertion_facet(
                    "ci_status",
                    Some(Stage::Implemented),
                    "2026-08-01T00:00:00Z",
                ),
            );
        }
        let facets = facets_of(&state, state.beliefs.get(B_ONE).unwrap());
        assert_eq!(facets.len(), 1);
        assert_eq!(
            facets[0].supports,
            vec![OBS_AUTHORITY.to_string(), OBS_INFERRED.to_string()],
            "both supports, sorted"
        );
    }

    #[test]
    fn the_same_predicate_at_two_stages_stays_two_facets() {
        // Stage lag is the thing M27 exists not to alarm about. Collapsing
        // these would make "planned says A, shipping says B" one facet with
        // two answers.
        let mut state = base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            assertion_facet("ci_status", Some(Stage::Planned), "2026-08-01T00:00:00Z"),
        );
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            assertion_facet("ci_status", Some(Stage::Shipping), "2026-08-01T00:00:00Z"),
        );
        assert_eq!(
            facets_of(&state, state.beliefs.get(B_ONE).unwrap()).len(),
            2
        );
    }

    #[test]
    fn an_unsupported_revision_gets_one_unknown_facet_rather_than_none() {
        // "No facets" and "one facet we cannot key" are different sentences,
        // and only one of them is true here.
        let state = base();
        let facets = facets_of(&state, state.beliefs.get(B_TWO).unwrap());
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].key.predicate, FacetPredicate::Unknown);
        assert_eq!(facets[0].key.state_stage, StateStage::Unknown);
        assert!(facets[0].supports.is_empty());
    }

    #[test]
    fn an_assertion_with_no_indexed_predicate_lands_in_the_unknown_facet() {
        // The evidence is real even when the key is not. Dropping it would
        // make a supported belief look unsupported.
        let state = base();
        let facets = facets_of(&state, state.beliefs.get(B_ONE).unwrap());
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].key.predicate, FacetPredicate::Unknown);
        assert_eq!(
            facets[0].supports,
            vec![OBS_AUTHORITY.to_string(), OBS_INFERRED.to_string()]
        );
    }

    #[test]
    fn only_supports_make_a_facet() {
        // `opposes` is weighed history, not what rests under the claim.
        use crate::ledger::schema::{BasisLink, BasisRole};
        let mut state = base();
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            assertion_facet("ci_status", None, "2026-08-01T00:00:00Z"),
        );
        let belief = state.beliefs.get_mut(B_ONE).unwrap();
        belief.revisions[0].basis = BeliefBasis::Linked {
            links: vec![BasisLink {
                observation_event_id: OBS_INFERRED.into(),
                role: BasisRole::Opposes,
            }],
        };
        let facets = facets_of(&state, state.beliefs.get(B_ONE).unwrap());
        assert_eq!(facets.len(), 1);
        assert_eq!(facets[0].key.predicate, FacetPredicate::Unknown);
        assert!(facets[0].supports.is_empty());
    }

    #[test]
    fn a_facet_id_follows_from_the_key_and_nothing_else() {
        let key = BeliefFacetKey {
            belief_id: B_ONE.into(),
            belief_revision_event_id: REV_ONE.into(),
            predicate: FacetPredicate::Known {
                value: "ci_status".into(),
            },
            state_stage: StateStage::Shipping,
        };
        let mut other = key.clone();
        other.state_stage = StateStage::Planned;
        assert_eq!(key.facet_id(), key.clone().facet_id());
        assert_ne!(key.facet_id(), other.facet_id());
        assert_eq!(key.facet_id().len(), 32);
    }

    #[test]
    fn an_empty_predicate_string_is_the_unknown_variant_mis_spelled() {
        let mut key = BeliefFacetKey {
            belief_id: B_ONE.into(),
            belief_revision_event_id: REV_ONE.into(),
            predicate: FacetPredicate::Known {
                value: String::new(),
            },
            state_stage: StateStage::Unknown,
        };
        assert!(key.validate("facet").unwrap_err().contains("mis-spelled"));
        key.predicate = FacetPredicate::Unknown;
        key.validate("facet").unwrap();
    }

    #[test]
    fn a_revision_that_does_not_belong_to_the_belief_yields_nothing() {
        let state = base();
        assert!(facets_of_revision(
            &state,
            state.beliefs.get(B_ONE).unwrap(),
            "99999999999999999999999999999999"
        )
        .is_empty());
    }

    #[test]
    fn a_tombstoned_belief_contributes_no_facets() {
        let mut state = base();
        state
            .beliefs
            .get_mut(B_TWO)
            .unwrap()
            .tombstoned_by
            .replace("90000000000000000000000000000009".into());
        assert!(all_facets(&state).iter().all(|f| f.key.belief_id != B_TWO));
    }
}
