//! The Support axis: what actually rests under a facet (M27.2c).
//!
//! **Repetition strengthens nothing** (§72/§75). Four copies of one Slack
//! message are one ancestral evidence family, and the collapse is a graph
//! property — never an LLM judgement, never a similarity score. Two
//! observations join a family when their lineage ancestries intersect (the
//! same relation `apply_independence` calls `known_same_lineage`, so families
//! and independence can never disagree about what "same lineage" means), or
//! when they are byte-identical claims from the SAME registered source.
//!
//! **Same source is load-bearing in that second clause.** Identical content
//! resting on two DIFFERENT sources is corroboration, not duplication —
//! M26.6's maintenance pass makes the same distinction for the same reason.
//! Collapsing across sources would turn the strongest evidence state the base
//! can reach into the weakest.
//!
//! **Independence is tri-state, and "no edge detected" is not independence**
//! (§85). Two families are `known_independent` only through a committed M22
//! `observation.independence_recorded` whose endpoints land in those two
//! families; everything else is `independence_unknown`, which is COUNTED and
//! shown rather than quietly rounded up. Two engineers may both have heard it
//! in one meeting, and nothing in the base can tell.
//!
//! **`unsupported` does not mean false.** It means no admissible support
//! revision — the state a migrated `verified: true` concept keeps, with its
//! review attestation rendering separately (D8 channel 1), because M22 forbids
//! attestation from entering lineage at all.
//!
//! **Authority is per predicate AND stage, never a rank.** A responsible owner
//! authoritative for `intent_rationale` at `planned` is not authoritative for
//! what shipped, and a machine artifact can be authoritative without any human
//! having authored it. The route match runs through
//! [`crate::policy::authority::satisfies`] — one evaluator, reading one
//! artifact.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{IndependenceProof, StateStage};
use crate::policy::authority::{self, AuthorityRoutesV1, RouteStage};

use super::facet::Facet;

/// Which kind of route carried the authority. Closed, and these are route
/// CLASSES rather than a ladder: nothing here says a human outranks an
/// artifact or the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityClass {
    DirectArtifact,
    ResponsibleOwnerFirsthand,
    FirsthandObserver,
}

impl AuthorityClass {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthorityClass::DirectArtifact => "direct_artifact",
            AuthorityClass::ResponsibleOwnerFirsthand => "responsible_owner_firsthand",
            AuthorityClass::FirsthandObserver => "firsthand_observer",
        }
    }
}

/// Everything a reader needs to check an authority claim without trusting it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AuthorityScope {
    pub predicate: String,
    pub state_stage: String,
    pub authority_class: AuthorityClass,
    pub authority_route_id: String,
    pub authority_rule_version: u64,
    pub authority_artifact_hash: String,
    /// WHICH assertion carried it, and which registration made that assertion
    /// trustworthy. Both pinned: authority that could not name its own
    /// evidence is a label.
    pub assertion_event_id: String,
    pub source_registration_event_id: String,
    pub authority_provenance: String,
}

/// How a family's independence stands against the rest (§85).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Independence {
    KnownIndependent,
    IndependenceUnknown,
}

/// One collapsed ancestral evidence family.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Family {
    /// The lexicographically-first member, which names the family
    /// deterministically without minting an id nothing else refers to.
    pub family_id: String,
    /// Sorted assertion (observation) event ids.
    pub members: Vec<String>,
    /// The registered sources the members came from.
    pub source_ids: Vec<String>,
    pub independence: Independence,
}

/// One accepted positive independence proof between two families.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IndependenceEdge {
    pub left_family_id: String,
    pub right_family_id: String,
    pub proof_kind: String,
    /// Present for the two deterministic proofs; `None` for
    /// `human_confirmed`, which pins a proposal and a decision instead.
    pub rule_version: Option<String>,
    pub proposal_id: Option<String>,
    pub decision_event_id: Option<String>,
    pub recorded_by_event_id: String,
}

/// The axis.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "level", rename_all = "snake_case")]
pub enum Support {
    Unsupported {
        ancestral_family_count: usize,
        independent_family_count: usize,
        independence_unknown_count: usize,
    },
    SingleSource {
        ancestral_family_count: usize,
        independent_family_count: usize,
        independence_unknown_count: usize,
    },
    Corroborated {
        ancestral_family_count: usize,
        independent_family_count: usize,
        independence_unknown_count: usize,
    },
    AuthoritativeForPredicateStage {
        ancestral_family_count: usize,
        independent_family_count: usize,
        independence_unknown_count: usize,
        authority_scope: Box<AuthorityScope>,
    },
}

impl Support {
    pub fn level(&self) -> &'static str {
        match self {
            Support::Unsupported { .. } => "unsupported",
            Support::SingleSource { .. } => "single_source",
            Support::Corroborated { .. } => "corroborated",
            Support::AuthoritativeForPredicateStage { .. } => "authoritative_for_predicate_stage",
        }
    }

    pub fn ancestral_family_count(&self) -> usize {
        match self {
            Support::Unsupported {
                ancestral_family_count,
                ..
            }
            | Support::SingleSource {
                ancestral_family_count,
                ..
            }
            | Support::Corroborated {
                ancestral_family_count,
                ..
            }
            | Support::AuthoritativeForPredicateStage {
                ancestral_family_count,
                ..
            } => *ancestral_family_count,
        }
    }

    pub fn independent_family_count(&self) -> usize {
        match self {
            Support::Unsupported {
                independent_family_count,
                ..
            }
            | Support::SingleSource {
                independent_family_count,
                ..
            }
            | Support::Corroborated {
                independent_family_count,
                ..
            }
            | Support::AuthoritativeForPredicateStage {
                independent_family_count,
                ..
            } => *independent_family_count,
        }
    }

    pub fn independence_unknown_count(&self) -> usize {
        match self {
            Support::Unsupported {
                independence_unknown_count,
                ..
            }
            | Support::SingleSource {
                independence_unknown_count,
                ..
            }
            | Support::Corroborated {
                independence_unknown_count,
                ..
            }
            | Support::AuthoritativeForPredicateStage {
                independence_unknown_count,
                ..
            } => *independence_unknown_count,
        }
    }

    pub fn authority_scope(&self) -> Option<&AuthorityScope> {
        match self {
            Support::AuthoritativeForPredicateStage {
                authority_scope, ..
            } => Some(authority_scope),
            _ => None,
        }
    }

    /// The human-readable half of the composed chip line. The honest words
    /// the design asks for — "independence unknown" is said out loud rather
    /// than left as an absence.
    pub fn describe(&self) -> String {
        match self {
            Support::Unsupported { .. } => "unsupported".to_string(),
            Support::SingleSource {
                independence_unknown_count,
                ..
            } => {
                if *independence_unknown_count > 1 {
                    format!(
                        "single-source ({independence_unknown_count} with independence unknown)"
                    )
                } else {
                    "single-source".to_string()
                }
            }
            Support::Corroborated {
                independent_family_count,
                independence_unknown_count,
                ..
            } => {
                if *independence_unknown_count > 0 {
                    format!(
                        "corroborated by {independent_family_count} independent \
                         ({independence_unknown_count} with independence unknown)"
                    )
                } else {
                    format!("corroborated by {independent_family_count} independent")
                }
            }
            Support::AuthoritativeForPredicateStage {
                authority_scope, ..
            } => format!(
                "authoritative for {} at {} ({})",
                authority_scope.predicate,
                authority_scope.state_stage,
                authority_scope.authority_class.as_str()
            ),
        }
    }
}

/// What one derivation found, whole. The families and edges are carried
/// because a chip that says "corroborated by 2 independent" must be able to
/// show WHICH two and under which rules.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Derived {
    pub support: Support,
    pub families: Vec<Family>,
    pub independence_edges: Vec<IndependenceEdge>,
}

/// Every ancestor of an observation, itself included.
///
/// The same walk `apply_independence` uses, over every lineage kind. Family
/// membership and `known_same_lineage` are therefore ONE relation: a pair the
/// reducer refused to call independent can never appear here as two families.
fn ancestors(state: &EpistemicState, event_id: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![event_id.to_string()];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(observation) = state.observations.get(&id) {
            for (_, parent) in &observation.lineage_parents {
                stack.push(parent.clone());
            }
        }
    }
    seen
}

/// Collapse one facet's supports into ancestral families.
pub fn families_of(state: &EpistemicState, facet: &Facet) -> Vec<Family> {
    let members: Vec<&str> = facet.supports.iter().map(String::as_str).collect();
    if members.is_empty() {
        return Vec::new();
    }
    let ancestry: Vec<BTreeSet<String>> = members
        .iter()
        .map(|event_id| ancestors(state, event_id))
        .collect();

    // Union-find, small enough that the naive one is the readable one.
    let mut parent: Vec<usize> = (0..members.len()).collect();
    fn find(parent: &mut [usize], mut index: usize) -> usize {
        while parent[index] != index {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        index
    }
    let union = |parent: &mut Vec<usize>, a: usize, b: usize| {
        let (a, b) = (find(parent, a), find(parent, b));
        if a != b {
            parent[a.max(b)] = a.min(b);
        }
    };

    for left in 0..members.len() {
        for right in (left + 1)..members.len() {
            // Shared transformation ancestry — the copy/summary chain, and
            // every other lineage kind with it.
            if !ancestry[left].is_disjoint(&ancestry[right]) {
                union(&mut parent, left, right);
                continue;
            }
            // The content half: the identical claim, twice, from the SAME
            // registered source. Across two sources this is corroboration
            // and must stay two families.
            let (Some(a), Some(b)) = (
                state.observations.get(members[left]),
                state.observations.get(members[right]),
            ) else {
                continue;
            };
            if a.source_id != b.source_id {
                continue;
            }
            let (Some(fa), Some(fb)) = (
                state.assertion_facets.get(members[left]),
                state.assertion_facets.get(members[right]),
            ) else {
                continue;
            };
            if fa.predicate == fb.predicate && fa.value_hash == fb.value_hash {
                union(&mut parent, left, right);
            }
        }
    }

    let mut grouped: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for (index, member) in members.iter().enumerate() {
        let root = find(&mut parent, index);
        grouped.entry(root).or_default().push(member);
    }
    grouped
        .into_values()
        .map(|mut group| {
            group.sort_unstable();
            let sources: BTreeSet<String> = group
                .iter()
                .filter_map(|id| state.observations.get(*id))
                .map(|observation| observation.source_id.clone())
                .collect();
            Family {
                family_id: group[0].to_string(),
                members: group.iter().map(|id| id.to_string()).collect(),
                source_ids: sources.into_iter().collect(),
                // Filled in once the proofs are read.
                independence: Independence::IndependenceUnknown,
            }
        })
        .collect()
}

/// Derive one facet's Support.
pub fn support_of(state: &EpistemicState, routes: &[AuthorityRoutesV1], facet: &Facet) -> Derived {
    let mut families = families_of(state, facet);
    let mut of_member: BTreeMap<&str, String> = BTreeMap::new();
    for family in &families {
        for member in &family.members {
            of_member.insert(member.as_str(), family.family_id.clone());
        }
    }

    // Positive proofs, restricted to THIS facet's supports and to pairs that
    // land in two DIFFERENT families. A proof inside one collapsed family is
    // not a proof of anything — the reducer already refuses shared ancestry,
    // and the content-duplicate clause can collapse a pair it accepted.
    let mut edges: Vec<IndependenceEdge> = Vec::new();
    let mut proven: BTreeSet<String> = BTreeSet::new();
    for ((left, right), row) in &state.independence {
        let (Some(left_family), Some(right_family)) =
            (of_member.get(left.as_str()), of_member.get(right.as_str()))
        else {
            continue;
        };
        if left_family == right_family {
            continue;
        }
        // The registration refs still byte-match what the Observations pin.
        // The reducer checked this when the event folded; a later correction
        // could move an Observation's registration underneath it.
        let (proof_left, proof_right) = row.proof.registration_refs();
        let matches = state
            .observations
            .get(left)
            .is_some_and(|o| o.source_registration_event_id == proof_left)
            && state
                .observations
                .get(right)
                .is_some_and(|o| o.source_registration_event_id == proof_right);
        if !matches {
            continue;
        }
        let (rule_version, proposal_id, decision_event_id) = match &row.proof {
            IndependenceProof::DistinctFirsthandOrigin { rule_version, .. }
            | IndependenceProof::IndependentSystemArtifact { rule_version, .. } => {
                (Some(rule_version.clone()), None, None)
            }
            IndependenceProof::HumanConfirmed {
                proposal_id,
                decision_event_id,
                ..
            } => (
                None,
                Some(proposal_id.clone()),
                Some(decision_event_id.clone()),
            ),
        };
        let (first, second) = if left_family <= right_family {
            (left_family.clone(), right_family.clone())
        } else {
            (right_family.clone(), left_family.clone())
        };
        proven.insert(first.clone());
        proven.insert(second.clone());
        edges.push(IndependenceEdge {
            left_family_id: first,
            right_family_id: second,
            proof_kind: row.proof_kind.clone(),
            rule_version,
            proposal_id,
            decision_event_id,
            recorded_by_event_id: row.event_id.clone(),
        });
    }
    edges.sort_by(|a, b| {
        (
            &a.left_family_id,
            &a.right_family_id,
            &a.recorded_by_event_id,
        )
            .cmp(&(
                &b.left_family_id,
                &b.right_family_id,
                &b.recorded_by_event_id,
            ))
    });
    for family in &mut families {
        if proven.contains(&family.family_id) {
            family.independence = Independence::KnownIndependent;
        }
    }

    let ancestral = families.len();
    let independent = families
        .iter()
        .filter(|f| f.independence == Independence::KnownIndependent)
        .count();
    // The complement, in the same unit. `ancestral == independent + unknown`
    // always, which is what makes the three numbers readable together.
    let unknown = ancestral - independent;

    let support = if ancestral == 0 {
        Support::Unsupported {
            ancestral_family_count: 0,
            independent_family_count: 0,
            independence_unknown_count: 0,
        }
    } else if let Some(scope) = authority_scope(state, routes, facet) {
        Support::AuthoritativeForPredicateStage {
            ancestral_family_count: ancestral,
            independent_family_count: independent,
            independence_unknown_count: unknown,
            authority_scope: Box::new(scope),
        }
    } else if independent >= 2 {
        Support::Corroborated {
            ancestral_family_count: ancestral,
            independent_family_count: independent,
            independence_unknown_count: unknown,
        }
    } else {
        Support::SingleSource {
            ancestral_family_count: ancestral,
            independent_family_count: independent,
            independence_unknown_count: unknown,
        }
    };

    Derived {
        support,
        families,
        independence_edges: edges,
    }
}

/// Whether one route's declared predicate classes and stages cover a facet's.
///
/// The ONE place that decides it. `authority_scope` asks to pick a route to
/// evaluate; M27.6's debt lane asks whether any route exists at all. Two
/// copies of "predicate AND stage, never universally" is two chances to
/// disagree about what a route is for.
pub fn route_covers(route: &authority::AuthorityRoute, predicate: &str, stage: StateStage) -> bool {
    route.predicate_classes.iter().any(|c| c == predicate)
        && route.state_stages.contains(&route_stage(stage))
}

/// Does anything in the artifact set declare a route for this predicate at
/// this stage? Says nothing about whether the evidence satisfies one —
/// "nobody has said how this could be authoritative" and "nothing has met the
/// bar" are different sentences, and the lane renders them differently.
pub fn route_declared(
    routes: &[AuthorityRoutesV1],
    predicate: Option<&str>,
    stage: StateStage,
) -> bool {
    let Some(predicate) = predicate else {
        return false;
    };
    routes
        .iter()
        .any(|artifact| route_covers_any(&artifact.routes, predicate, stage))
}

fn route_covers_any(
    routes: &[authority::AuthorityRoute],
    predicate: &str,
    stage: StateStage,
) -> bool {
    routes
        .iter()
        .any(|route| route_covers(route, predicate, stage))
}

fn route_stage(stage: StateStage) -> RouteStage {
    match stage {
        StateStage::Planned => RouteStage::Planned,
        StateStage::Approved => RouteStage::Approved,
        StateStage::Implemented => RouteStage::Implemented,
        StateStage::Validated => RouteStage::Validated,
        StateStage::Deployed => RouteStage::Deployed,
        StateStage::Shipping => RouteStage::Shipping,
        StateStage::Unknown => RouteStage::Unknown,
    }
}

/// The first route this facet's evidence actually satisfies, for this
/// facet's OWN predicate and stage.
///
/// Deterministic: artifacts in load order, routes in artifact order, criteria
/// in route order, supports in sorted order. A base with two qualifying
/// assertions reports the same one on every machine.
fn authority_scope(
    state: &EpistemicState,
    routes: &[AuthorityRoutesV1],
    facet: &Facet,
) -> Option<AuthorityScope> {
    let predicate = facet.key.predicate.value()?;
    for artifact in routes {
        let artifact_hash = artifact.artifact_hash();
        for route in &artifact.routes {
            // Predicate AND stage, never universally. A responsible owner
            // authoritative for intent at `planned` is not authoritative for
            // what shipped.
            if !route_covers(route, predicate, facet.key.state_stage) {
                continue;
            }
            for criterion in &route.criteria {
                for support in &facet.supports {
                    if !authority::satisfies(state, support, criterion) {
                        continue;
                    }
                    let observation = state.observations.get(support)?;
                    let class = match criterion {
                        authority::Criterion::DirectArtifact { .. } => {
                            AuthorityClass::DirectArtifact
                        }
                        authority::Criterion::ResponsibleOwnerFirsthand { .. } => {
                            AuthorityClass::ResponsibleOwnerFirsthand
                        }
                        authority::Criterion::FirsthandObserver { .. } => {
                            AuthorityClass::FirsthandObserver
                        }
                    };
                    return Some(AuthorityScope {
                        predicate: predicate.to_string(),
                        state_stage: facet.key.state_stage.as_str().to_string(),
                        authority_class: class,
                        authority_route_id: route.authority_route_id.clone(),
                        authority_rule_version: route.authority_rule_version,
                        authority_artifact_hash: artifact_hash.clone(),
                        assertion_event_id: support.clone(),
                        source_registration_event_id: observation
                            .source_registration_event_id
                            .clone(),
                        authority_provenance: match observation.authority {
                            Some(crate::ledger::schema::AuthorityProvenance::TrustedHumanCapture) => {
                                "trusted_human_capture"
                            }
                            Some(
                                crate::ledger::schema::AuthorityProvenance::RegisteredDirectArtifact,
                            ) => "registered_direct_artifact",
                            _ => "agent_inferred",
                        }
                        .to_string(),
                    });
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, revision, unsupported, B_ONE, B_TWO, FALCON, OBS_AUTHORITY,
        OBS_INFERRED, OBS_PLANNED, REV_ONE, REV_TWO, SOURCE_A, SOURCE_B, SOURCE_C,
    };
    use crate::dynamics::facet::{facets_of, tests::assertion_facet};
    use crate::ledger::reduce::IndependenceRow;
    use crate::ledger::schema::{
        AuthorityProvenance, LineageKind, SourceRegistration, SubjectRole,
    };

    const REG: &str = "60000000000000000000000000000001";

    fn routes() -> Vec<AuthorityRoutesV1> {
        authority::resolvable().unwrap()
    }

    /// One belief resting on three assertions from three sources, all about
    /// the same predicate at the same stage — so one facet with three
    /// supports.
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
                    linked(&[OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED]),
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
        for (event, source) in [
            (OBS_AUTHORITY, SOURCE_A),
            (OBS_INFERRED, SOURCE_B),
            (OBS_PLANNED, SOURCE_C),
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
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("ci_status", None, "2026-08-01T00:00:00Z"),
            );
        }
        state
    }

    fn facet(state: &EpistemicState, belief_id: &str) -> Facet {
        facets_of(state, state.beliefs.get(belief_id).unwrap()).remove(0)
    }

    fn prove(state: &mut EpistemicState, left: &str, right: &str, kind: &str) {
        let (a, b) = if left <= right {
            (left, right)
        } else {
            (right, left)
        };
        let proof = match kind {
            "human_confirmed" => IndependenceProof::HumanConfirmed {
                left_source_registration_event_id: REG.into(),
                right_source_registration_event_id: REG.into(),
                proposal_id: "a".repeat(32),
                decision_event_id: "b".repeat(32),
            },
            _ => IndependenceProof::IndependentSystemArtifact {
                left_source_registration_event_id: REG.into(),
                right_source_registration_event_id: REG.into(),
                rule_version: "independence-rules-v1".into(),
            },
        };
        state.independence.insert(
            (a.into(), b.into()),
            IndependenceRow {
                event_id: "90000000000000000000000000000001".into(),
                proof_kind: kind.into(),
                proof,
            },
        );
    }

    #[test]
    fn no_admissible_support_is_unsupported_and_does_not_mean_false() {
        let state = base();
        let derived = support_of(&state, &routes(), &facet(&state, B_TWO));
        assert_eq!(derived.support.level(), "unsupported");
        assert_eq!(derived.support.ancestral_family_count(), 0);
        assert!(derived.families.is_empty());
        assert_eq!(derived.support.describe(), "unsupported");
    }

    #[test]
    fn four_copies_of_one_message_are_one_family() {
        // §72/§75, as arithmetic. The copies share a `copied_from` ancestor,
        // so union-find collapses them however many there are.
        let mut state = base();
        let root = "20000000000000000000000000000009";
        state.observations.insert(
            root.into(),
            observation(
                root,
                FALCON,
                SOURCE_A,
                AuthorityProvenance::RegisteredDirectArtifact,
            ),
        );
        for event in [OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED] {
            state
                .observations
                .get_mut(event)
                .unwrap()
                .lineage_parents
                .push((LineageKind::CopiedFrom, root.into()));
        }
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert_eq!(derived.families.len(), 1);
        assert_eq!(derived.families[0].members.len(), 3);
        assert_eq!(derived.support.level(), "single_source");
    }

    #[test]
    fn the_same_claim_twice_from_one_source_is_one_family_and_from_two_is_two() {
        // The content half, and the line that keeps corroboration alive.
        let mut state = base();
        // Two of the three now come from ONE source with identical claims.
        state.observations.get_mut(OBS_INFERRED).unwrap().source_id = SOURCE_A.into();
        assert_eq!(
            support_of(&state, &routes(), &facet(&state, B_ONE))
                .families
                .len(),
            2,
            "the duplicate collapses; the third source stays its own family"
        );

        // Put it back on its own source and the identical claim is
        // corroboration, not duplication.
        state.observations.get_mut(OBS_INFERRED).unwrap().source_id = SOURCE_B.into();
        assert_eq!(
            support_of(&state, &routes(), &facet(&state, B_ONE))
                .families
                .len(),
            3
        );
    }

    #[test]
    fn no_lineage_information_is_independence_unknown_and_never_corroboration() {
        // §85's whole point. Three sources, nothing proving they did not all
        // hear it in one meeting.
        let state = base();
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert_eq!(derived.support.level(), "single_source");
        assert_eq!(derived.support.ancestral_family_count(), 3);
        assert_eq!(derived.support.independent_family_count(), 0);
        assert_eq!(derived.support.independence_unknown_count(), 3);
        assert!(derived
            .families
            .iter()
            .all(|f| f.independence == Independence::IndependenceUnknown));
        assert_eq!(
            derived.support.describe(),
            "single-source (3 with independence unknown)"
        );
    }

    #[test]
    fn two_positively_independent_families_are_corroborated() {
        let mut state = base();
        prove(
            &mut state,
            OBS_AUTHORITY,
            OBS_INFERRED,
            "independent_system_artifact",
        );
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert_eq!(derived.support.level(), "corroborated");
        assert_eq!(derived.support.ancestral_family_count(), 3);
        assert_eq!(derived.support.independent_family_count(), 2);
        assert_eq!(
            derived.support.independence_unknown_count(),
            1,
            "the third family is counted visibly rather than rounded up"
        );
        assert_eq!(derived.independence_edges.len(), 1);
        assert_eq!(
            derived.independence_edges[0].rule_version.as_deref(),
            Some("independence-rules-v1"),
            "the proof's rules are retained, not re-derived at render time"
        );
    }

    #[test]
    fn a_human_confirmed_proof_carries_its_proposal_and_decision_instead_of_a_rule() {
        let mut state = base();
        prove(&mut state, OBS_AUTHORITY, OBS_INFERRED, "human_confirmed");
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert_eq!(derived.support.level(), "corroborated");
        let edge = &derived.independence_edges[0];
        assert_eq!(edge.rule_version, None);
        assert_eq!(edge.proposal_id.as_deref(), Some("a".repeat(32).as_str()));
        assert_eq!(
            edge.decision_event_id.as_deref(),
            Some("b".repeat(32).as_str())
        );
    }

    #[test]
    fn a_proof_inside_one_collapsed_family_proves_nothing() {
        // The design's rule: an independence event whose endpoints land in a
        // single current family is invalid. Here they are content duplicates
        // from one source, which the reducer's ancestry check never saw.
        let mut state = base();
        state.observations.get_mut(OBS_INFERRED).unwrap().source_id = SOURCE_A.into();
        prove(
            &mut state,
            OBS_AUTHORITY,
            OBS_INFERRED,
            "independent_system_artifact",
        );
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert!(derived.independence_edges.is_empty());
        assert_eq!(derived.support.level(), "single_source");
    }

    #[test]
    fn a_proof_whose_registration_refs_moved_underneath_it_stops_counting() {
        let mut state = base();
        prove(
            &mut state,
            OBS_AUTHORITY,
            OBS_INFERRED,
            "independent_system_artifact",
        );
        state
            .observations
            .get_mut(OBS_AUTHORITY)
            .unwrap()
            .source_registration_event_id = "9".repeat(32);
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert!(derived.independence_edges.is_empty());
        assert_eq!(derived.support.level(), "single_source");
    }

    #[test]
    fn a_proof_about_observations_this_facet_never_used_counts_for_nothing() {
        let mut state = base();
        prove(
            &mut state,
            OBS_AUTHORITY,
            "20000000000000000000000000000099",
            "independent_system_artifact",
        );
        assert!(support_of(&state, &routes(), &facet(&state, B_ONE))
            .independence_edges
            .is_empty());
    }

    #[test]
    fn a_matching_direct_artifact_is_authoritative_for_its_own_predicate_and_stage() {
        // The acceptance row: no human authorship required.
        let mut state = base();
        state.sources.insert(
            SOURCE_A.into(),
            crate::ledger::reduce::SourceState {
                source_id: SOURCE_A.into(),
                registration_event_id: REG.into(),
                registration: crate::ledger::schema::source::tests::registration("connector"),
                canonical: String::new(),
            },
        );
        for event in [OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED] {
            let mut facet = assertion_facet(
                "observable_machine_state",
                Some(crate::ledger::schema::Stage::Implemented),
                "2026-08-01T00:00:00Z",
            );
            facet.source_artifact_hash = Some("a".repeat(64));
            facet.raw_pointer = Some("github://acme/repo#L1".into());
            state.assertion_facets.insert(event.into(), facet);
        }
        let derived = support_of(&state, &routes(), &facet(&state, B_ONE));
        assert_eq!(derived.support.level(), "authoritative_for_predicate_stage");
        let scope = derived.support.authority_scope().unwrap();
        assert_eq!(scope.authority_class, AuthorityClass::DirectArtifact);
        assert_eq!(scope.state_stage, "implemented");
        assert_eq!(scope.assertion_event_id, OBS_AUTHORITY);
        assert_eq!(scope.source_registration_event_id, REG);
        assert!(!scope.authority_artifact_hash.is_empty());
    }

    #[test]
    fn the_same_evidence_at_another_stage_is_not_authoritative_here() {
        // Authority never transfers across facets: `route.observable_machine_state`
        // covers implemented/validated/deployed and not `shipping`.
        let mut state = base();
        state.sources.insert(
            SOURCE_A.into(),
            crate::ledger::reduce::SourceState {
                source_id: SOURCE_A.into(),
                registration_event_id: REG.into(),
                registration: crate::ledger::schema::source::tests::registration("connector"),
                canonical: String::new(),
            },
        );
        for event in [OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED] {
            let mut facet = assertion_facet(
                "observable_machine_state",
                Some(crate::ledger::schema::Stage::Shipping),
                "2026-08-01T00:00:00Z",
            );
            facet.source_artifact_hash = Some("a".repeat(64));
            facet.raw_pointer = Some("github://acme/repo#L1".into());
            state.assertion_facets.insert(event.into(), facet);
        }
        assert_eq!(
            support_of(&state, &routes(), &facet(&state, B_ONE))
                .support
                .level(),
            "single_source"
        );
    }

    #[test]
    fn a_responsible_owner_for_another_stage_is_not_authoritative_here() {
        // The acceptance row, on the human side. `route.intent_rationale`
        // covers planned/approved; this facet is at `shipping`.
        let mut state = base();
        state.sources.insert(
            SOURCE_A.into(),
            crate::ledger::reduce::SourceState {
                source_id: SOURCE_A.into(),
                registration_event_id: REG.into(),
                registration: SourceRegistration::HumanActor {
                    source_key: String::new(),
                    actor_id: "human:josef".into(),
                    authority_capability:
                        crate::ledger::schema::AuthorityCapability::HumanAssertion,
                    independence_domain_id: None,
                },
                canonical: String::new(),
            },
        );
        for event in [OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED] {
            let observation = state.observations.get_mut(event).unwrap();
            observation.kind = crate::ledger::schema::ObservationKind::HumanAssertion;
            observation.authority = Some(AuthorityProvenance::TrustedHumanCapture);
            observation.actor = "human:josef".into();
            observation.source_id = SOURCE_A.into();
            let mut facet = assertion_facet(
                "intent_rationale",
                Some(crate::ledger::schema::Stage::Shipping),
                "2026-08-01T00:00:00Z",
            );
            facet.relationship_role = SubjectRole::ProjectOwner;
            state.assertion_facets.insert(event.into(), facet);
        }
        assert_ne!(
            support_of(&state, &routes(), &facet(&state, B_ONE))
                .support
                .level(),
            "authoritative_for_predicate_stage"
        );

        // Move the same evidence to a stage the route covers and it carries.
        for event in [OBS_AUTHORITY, OBS_INFERRED, OBS_PLANNED] {
            let mut facet = assertion_facet(
                "intent_rationale",
                Some(crate::ledger::schema::Stage::Planned),
                "2026-08-01T00:00:00Z",
            );
            facet.relationship_role = SubjectRole::ProjectOwner;
            state.assertion_facets.insert(event.into(), facet);
        }
        assert_eq!(
            support_of(&state, &routes(), &facet(&state, B_ONE))
                .support
                .level(),
            "authoritative_for_predicate_stage"
        );
    }

    #[test]
    fn the_derivation_is_deterministic() {
        let mut state = base();
        prove(
            &mut state,
            OBS_AUTHORITY,
            OBS_INFERRED,
            "independent_system_artifact",
        );
        let facet = facet(&state, B_ONE);
        assert_eq!(
            support_of(&state, &routes(), &facet),
            support_of(&state, &routes(), &facet)
        );
    }

    #[test]
    fn the_three_counts_always_add_up() {
        // `ancestral == independent + unknown` is what makes the three
        // numbers readable together rather than as three unrelated facts.
        let mut state = base();
        for (left, right) in [(OBS_AUTHORITY, OBS_INFERRED), (OBS_INFERRED, OBS_PLANNED)] {
            prove(&mut state, left, right, "independent_system_artifact");
        }
        let support = support_of(&state, &routes(), &facet(&state, B_ONE)).support;
        assert_eq!(
            support.ancestral_family_count(),
            support.independent_family_count() + support.independence_unknown_count()
        );
        assert_eq!(support.independent_family_count(), 3);
        assert_eq!(support.describe(), "corroborated by 3 independent");
    }
}
