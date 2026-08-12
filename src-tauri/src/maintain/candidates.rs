//! What one maintenance pass finds (M26.6) — deterministic, and nothing else.
//!
//! **Twelve GC verbs, zero new opcodes (§16).** Merging, splitting, archiving
//! and compressing are PASS BEHAVIOURS that end in risk-classed M24 proposals,
//! never twelve ledger operations. This module finds candidates; the policy
//! table decides what each one costs and who has to say yes.
//!
//! **Conservative by table (§78).** `merge_beliefs_exact` is the only LOW
//! path and the only one this module surfaces automatically, because exact
//! equivalence is the only equivalence a machine can prove. Semantic
//! coalescing — "these two say the same thing in different words" — is a
//! judgement, and a judgement that took the LOW path would be exact
//! equivalence in costume. `merge_entities` is CRITICAL and reaches a person;
//! `split_belief` is the only decomposition op and is HIGH.
//!
//! **No clocks decide anything.** Silence-never-resolves (M24, schema
//! enforced) exists to constrain exactly this pass, and the constraint is
//! taken seriously here rather than left to the validator: not one finding in
//! this module reads a timestamp. "Old" is not a reason to archive, "quiet" is
//! not a reason to merge, and a candidate that could only be justified by how
//! long something has sat is not surfaced at all.
//!
//! **No scores.** A finding names what it found and why. There is no ranking,
//! no salience number, and no ordering that means importance — the surrounding
//! milestone forbids scalar salience, and a maintenance pass is precisely
//! where a number would grow legs.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{normalize_alias_v1, BeliefBasis, Lifecycle, RelationKind};

/// Two or more live beliefs about one entity whose current revisions say the
/// same thing, byte for byte after normalization.
///
/// The only equivalence a machine can prove, which is why it is the only one
/// that takes the LOW path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactMerge {
    pub entity_id: String,
    /// Sorted, so the same base surfaces the same candidate.
    pub belief_ids: Vec<String>,
    /// The single source everything in the group rests on. See
    /// [`exact_merges`] — a group resting on several is not surfaced.
    pub source_id: Option<String>,
}

/// A retired belief nothing still points at.
///
/// The compress candidate, defined WITHOUT a clock: not "superseded a long
/// time ago" — which would be silence resolving something — but "superseded,
/// and nothing live refers to it any more". Whether its history is still worth
/// keeping is a person's call, which is what makes archiving HIGH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compress {
    pub belief_id: String,
    pub entity_id: String,
    /// The belief that replaced it, when the projection records one.
    pub superseded_by: Option<String>,
}

/// Why a belief is worth a look. Closed, and each one is a fact rather than a
/// judgement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Signal {
    /// Somebody contested it and nothing has closed that.
    OpenContest,
    /// A live `contradicts` edge touches it. The base disagrees with itself
    /// here and has not said which side won.
    UnresolvedContradiction,
    /// Everything it rests on came from one source. Not wrong — a great deal
    /// of true knowledge has one source — but it is the shape that looks like
    /// corroboration and is not.
    SingleSourceSupport,
    /// It is live and promoted past draft and rests on nothing at all.
    UnsupportedStanding,
}

impl Signal {
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::OpenContest => "open_contest",
            Signal::UnresolvedContradiction => "unresolved_contradiction",
            Signal::SingleSourceSupport => "single_source_support",
            Signal::UnsupportedStanding => "unsupported_standing",
        }
    }
}

/// One belief and every signal it tripped. Never empty — a belief with no
/// signal is not in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attention {
    pub belief_id: String,
    pub entity_id: String,
    pub signals: Vec<Signal>,
}

/// Everything one pass found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Findings {
    pub exact_merges: Vec<ExactMerge>,
    pub compress: Vec<Compress>,
    pub attention: Vec<Attention>,
}

impl Findings {
    pub fn is_empty(&self) -> bool {
        self.exact_merges.is_empty() && self.compress.is_empty() && self.attention.is_empty()
    }

    pub fn len(&self) -> usize {
        self.exact_merges.len() + self.compress.len() + self.attention.len()
    }
}

/// Look at the base once.
pub fn find(state: &EpistemicState) -> Findings {
    Findings {
        exact_merges: exact_merges(state),
        compress: compress(state),
        attention: attention(state),
    }
}

/// Live beliefs about one entity whose current content matches exactly.
///
/// **A group resting on more than one source is NOT surfaced, and that is the
/// interesting rule.** Two beliefs saying the same thing from two different
/// sources is corroboration — it is the strongest thing a base can hold — and
/// merging them would collapse two pieces of evidence into one while looking
/// like tidying. The shape that is safe to merge is the duplicate: one source
/// recorded twice.
fn exact_merges(state: &EpistemicState) -> Vec<ExactMerge> {
    let mut groups: BTreeMap<(String, String), Vec<&str>> = BTreeMap::new();
    for belief in state.beliefs.values() {
        if !live(belief) {
            continue;
        }
        let key = (
            belief.entity_id.clone(),
            normalize_alias_v1(&belief.current().content),
        );
        if key.1.trim().is_empty() {
            // Two empty beliefs are not two of the same thing; they are two
            // beliefs nobody wrote down.
            continue;
        }
        groups.entry(key).or_default().push(&belief.belief_id);
    }

    let mut out = Vec::new();
    for ((entity_id, _), mut belief_ids) in groups {
        if belief_ids.len() < 2 {
            continue;
        }
        belief_ids.sort();
        let sources: BTreeSet<String> = belief_ids
            .iter()
            .flat_map(|id| sources_of(state, id))
            .collect();
        // More than one source is corroboration. Leave it alone.
        if sources.len() > 1 {
            continue;
        }
        out.push(ExactMerge {
            entity_id,
            belief_ids: belief_ids.into_iter().map(str::to_string).collect(),
            source_id: sources.into_iter().next(),
        });
    }
    out
}

/// Retired beliefs nothing live still points at.
fn compress(state: &EpistemicState) -> Vec<Compress> {
    let mut referenced: BTreeSet<&str> = BTreeSet::new();
    let mut replaced_by: BTreeMap<&str, &str> = BTreeMap::new();
    for relation in state.relations.values() {
        if !relation.live {
            continue;
        }
        match relation.relation {
            // `supersedes` points from the replacement to the retired belief,
            // and that edge is what makes it retired — it does not count as
            // something still depending on it.
            RelationKind::Supersedes => {
                replaced_by.insert(relation.to.as_str(), relation.from.as_str());
            }
            _ => {
                referenced.insert(relation.from.as_str());
                referenced.insert(relation.to.as_str());
            }
        }
    }

    let mut out = Vec::new();
    for belief in state.beliefs.values() {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        if !matches!(belief.lifecycle, Lifecycle::Superseded) {
            continue;
        }
        if referenced.contains(belief.belief_id.as_str()) {
            // Something live still refers to it, so its retention is not
            // pure history.
            continue;
        }
        out.push(Compress {
            belief_id: belief.belief_id.clone(),
            entity_id: belief.entity_id.clone(),
            superseded_by: replaced_by
                .get(belief.belief_id.as_str())
                .map(|id| (*id).to_string()),
        });
    }
    out
}

/// Every live belief that tripped at least one signal.
fn attention(state: &EpistemicState) -> Vec<Attention> {
    let contested = contested(state);
    let mut out = Vec::new();
    for belief in state.beliefs.values() {
        if !live(belief) {
            continue;
        }
        let mut signals = Vec::new();
        if belief.open_contest_event.is_some() {
            signals.push(Signal::OpenContest);
        }
        if contested.contains(belief.belief_id.as_str()) {
            signals.push(Signal::UnresolvedContradiction);
        }
        match &belief.current().basis {
            BeliefBasis::Unsupported { .. } => {
                // A draft resting on nothing is a draft. A belief that has
                // been promoted past draft and still rests on nothing is a
                // claim the base is standing behind without evidence.
                if !matches!(
                    belief.qualification,
                    crate::ledger::schema::Qualification::Draft
                ) {
                    signals.push(Signal::UnsupportedStanding);
                }
            }
            BeliefBasis::Linked { .. } => {
                if sources_of(state, &belief.belief_id).len() == 1 {
                    signals.push(Signal::SingleSourceSupport);
                }
            }
        }
        if signals.is_empty() {
            continue;
        }
        signals.sort();
        signals.dedup();
        out.push(Attention {
            belief_id: belief.belief_id.clone(),
            entity_id: belief.entity_id.clone(),
            signals,
        });
    }
    out
}

/// Beliefs a live `contradicts` edge touches, from either end.
fn contested(state: &EpistemicState) -> BTreeSet<&str> {
    let mut out = BTreeSet::new();
    for relation in state.relations.values() {
        if relation.live && relation.relation == RelationKind::Contradicts {
            out.insert(relation.from.as_str());
            out.insert(relation.to.as_str());
        }
    }
    out
}

/// The distinct sources one belief's current revision rests on.
fn sources_of(state: &EpistemicState, belief_id: &str) -> BTreeSet<String> {
    let Some(belief) = state.beliefs.get(belief_id) else {
        return BTreeSet::new();
    };
    let BeliefBasis::Linked { links } = &belief.current().basis else {
        return BTreeSet::new();
    };
    links
        .iter()
        .filter_map(|link| state.observations.get(&link.observation_event_id))
        .map(|observation| observation.source_id.clone())
        .collect()
}

/// Live: not tombstoned, and not already retired.
fn live(belief: &crate::ledger::reduce::BeliefState) -> bool {
    belief.tombstoned_by.is_none() && matches!(belief.lifecycle, Lifecycle::Active)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture;
    use crate::ledger::schema::Qualification;

    /// The assembler's base, reused: one Falcon cutover the base disagrees
    /// with itself about, one belief resting on two sources, one on none.
    fn state() -> EpistemicState {
        fixture::state()
    }

    #[test]
    fn a_duplicate_from_one_source_is_an_exact_merge_candidate() {
        let mut state = state();
        // B_ONE's current revision rests on OBS_AUTHORITY and OBS_INFERRED,
        // which are two different sources. Narrow it to one, then add a
        // byte-identical twin resting on the same one.
        let one = state.beliefs.get_mut(fixture::B_ONE).unwrap();
        one.revisions[1].basis = fixture::linked(&[fixture::OBS_AUTHORITY]);
        let content = one.current().content.clone();
        let twin = fixture::belief(
            "b0000000000000000000000000000009",
            fixture::FALCON,
            vec![fixture::revision(
                1,
                "10000000000000000000000000000019",
                &content,
                fixture::linked(&[fixture::OBS_AUTHORITY]),
            )],
        );
        state
            .beliefs
            .insert("b0000000000000000000000000000009".into(), twin);

        let found = find(&state);
        assert_eq!(found.exact_merges.len(), 1, "{:?}", found.exact_merges);
        let merge = &found.exact_merges[0];
        assert_eq!(
            merge.belief_ids,
            vec![
                fixture::B_ONE.to_string(),
                "b0000000000000000000000000000009".to_string()
            ]
        );
        assert_eq!(merge.source_id.as_deref(), Some(fixture::SOURCE_A));
    }

    #[test]
    fn the_same_thing_from_two_sources_is_corroboration_and_is_left_alone() {
        // The rule worth stating: merging these would collapse two pieces of
        // evidence into one while looking like tidying.
        let mut state = state();
        let content = state
            .beliefs
            .get(fixture::B_ONE)
            .unwrap()
            .current()
            .content
            .clone();
        state.beliefs.get_mut(fixture::B_ONE).unwrap().revisions[1].basis =
            fixture::linked(&[fixture::OBS_AUTHORITY]);
        let twin = fixture::belief(
            "b0000000000000000000000000000009",
            fixture::FALCON,
            vec![fixture::revision(
                1,
                "10000000000000000000000000000019",
                &content,
                // A DIFFERENT source says the same thing.
                fixture::linked(&[fixture::OBS_PLANNED]),
            )],
        );
        state
            .beliefs
            .insert("b0000000000000000000000000000009".into(), twin);

        assert!(
            find(&state).exact_merges.is_empty(),
            "two independent sources agreeing is the strongest thing a base can hold"
        );
    }

    #[test]
    fn beliefs_about_different_entities_are_never_one_merge() {
        let mut state = state();
        let content = state
            .beliefs
            .get(fixture::B_ONE)
            .unwrap()
            .current()
            .content
            .clone();
        state.beliefs.get_mut(fixture::B_ONE).unwrap().revisions[1].basis =
            fixture::linked(&[fixture::OBS_AUTHORITY]);
        // Same words, different subject. `merge_entities` is a CRITICAL op and
        // a person's decision; it is not something a word match may imply.
        let elsewhere = fixture::belief(
            "b0000000000000000000000000000009",
            fixture::KESTREL,
            vec![fixture::revision(
                1,
                "10000000000000000000000000000019",
                &content,
                fixture::linked(&[fixture::OBS_AUTHORITY]),
            )],
        );
        state
            .beliefs
            .insert("b0000000000000000000000000000009".into(), elsewhere);
        assert!(find(&state).exact_merges.is_empty());
    }

    #[test]
    fn a_live_contradicts_edge_is_an_attention_signal_on_both_ends() {
        let found = find(&state());
        let flagged: Vec<&str> = found
            .attention
            .iter()
            .filter(|a| a.signals.contains(&Signal::UnresolvedContradiction))
            .map(|a| a.belief_id.as_str())
            .collect();
        assert_eq!(flagged, vec![fixture::B_ONE, fixture::B_TWO]);
    }

    #[test]
    fn a_promoted_belief_resting_on_nothing_is_flagged_and_a_draft_is_not() {
        // A draft resting on nothing is a draft. A belief the base has stood
        // behind and still cannot source is a different thing.
        let mut state = state();
        assert!(
            !find(&state)
                .attention
                .iter()
                .any(|a| a.signals.contains(&Signal::UnsupportedStanding)),
            "the fixture's unsupported beliefs are drafts"
        );
        state.beliefs.get_mut(fixture::B_TWO).unwrap().qualification = Qualification::Qualified;
        let found = find(&state);
        let flagged = found
            .attention
            .iter()
            .find(|a| a.belief_id == fixture::B_TWO)
            .expect("B_TWO");
        assert!(flagged.signals.contains(&Signal::UnsupportedStanding));
    }

    #[test]
    fn one_source_behind_everything_is_a_signal_and_two_are_not() {
        let mut state = state();
        // B_ONE rests on two sources in the fixture.
        assert!(!find(&state)
            .attention
            .iter()
            .find(|a| a.belief_id == fixture::B_ONE)
            .is_some_and(|a| a.signals.contains(&Signal::SingleSourceSupport)));
        state.beliefs.get_mut(fixture::B_ONE).unwrap().revisions[1].basis =
            fixture::linked(&[fixture::OBS_AUTHORITY]);
        assert!(find(&state)
            .attention
            .iter()
            .find(|a| a.belief_id == fixture::B_ONE)
            .expect("B_ONE")
            .signals
            .contains(&Signal::SingleSourceSupport));
    }

    #[test]
    fn a_retired_belief_nothing_points_at_is_a_compress_candidate() {
        let mut state = state();
        state.beliefs.get_mut(fixture::B_KESTREL).unwrap().lifecycle = Lifecycle::Superseded;
        // The fixture's `refines` edge still touches it, so it is not free.
        assert!(
            find(&state).compress.is_empty(),
            "something live still refers to it"
        );
        state.relations.get_mut("r2").unwrap().live = false;
        let found = find(&state);
        assert_eq!(found.compress.len(), 1);
        assert_eq!(found.compress[0].belief_id, fixture::B_KESTREL);
    }

    #[test]
    fn a_supersedes_edge_does_not_count_as_still_depending_on_it() {
        // The edge that MAKES it retired cannot be the reason it can never be
        // compressed, or nothing would ever be compressible.
        let mut state = state();
        state.beliefs.get_mut(fixture::B_KESTREL).unwrap().lifecycle = Lifecycle::Superseded;
        state.relations.get_mut("r2").unwrap().live = false;
        fixture::relate(
            &mut state,
            "r3",
            fixture::B_ONE,
            fixture::B_KESTREL,
            RelationKind::Supersedes,
            true,
        );
        let found = find(&state);
        assert_eq!(found.compress.len(), 1);
        assert_eq!(
            found.compress[0].superseded_by.as_deref(),
            Some(fixture::B_ONE)
        );
    }

    #[test]
    fn not_one_finding_reads_a_clock() {
        // Silence-never-resolves, taken seriously here rather than left to the
        // validator: this pass is the thing that rule exists to constrain, so
        // the source is asserted to contain no time at all.
        let source = include_str!("candidates.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in [
            "Utc::now",
            "SystemTime",
            "DateTime",
            "occurred_at",
            "ingested_at",
            "as_of",
            "chrono",
        ] {
            assert!(
                !body.contains(forbidden),
                "a maintenance finding that reads {forbidden} lets time resolve something"
            );
        }
    }

    #[test]
    fn the_same_base_finds_the_same_things_in_the_same_order() {
        let state = state();
        assert_eq!(find(&state), find(&state));
    }

    #[test]
    fn a_base_with_nothing_wrong_finds_nothing() {
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            fixture::B_ONE.into(),
            fixture::belief(
                fixture::B_ONE,
                fixture::FALCON,
                vec![fixture::revision(
                    1,
                    "10000000000000000000000000000002",
                    "the cutover is on track",
                    fixture::linked(&[fixture::OBS_AUTHORITY, fixture::OBS_INFERRED]),
                )],
            ),
        );
        for (event, source) in [
            (fixture::OBS_AUTHORITY, fixture::SOURCE_A),
            (fixture::OBS_INFERRED, fixture::SOURCE_B),
        ] {
            state.observations.insert(
                event.into(),
                fixture::observation(
                    event,
                    fixture::FALCON,
                    source,
                    crate::ledger::schema::AuthorityProvenance::RegisteredDirectArtifact,
                ),
            );
        }
        assert!(find(&state).is_empty(), "{:?}", find(&state));
    }
}
