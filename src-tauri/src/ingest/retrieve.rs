//! What the base already believes about a window (M26.4i).
//!
//! §22 says a pass must be shown its counterevidence or carry a typed record
//! that it could not be. `prompt::Candidate` has a field for it, and until
//! now nothing filled that field in — which left exactly one wrong answer
//! available: hand every candidate over as non-disconfirming. The prompt
//! prints "The base holds no disconfirming belief here — that is an absence
//! the retrieval found" when the disagreeing section is empty, so all-false
//! would have made the prompt assert an absence nobody established. A
//! fabricated absence is worse than a missing section.
//!
//! **So the section says which test it ran.** `RelationKind::Contradicts` is
//! the only committed representation of disagreement in this tree: a live
//! `contradicts` edge is a fact somebody recorded, and nothing else in M22
//! means "these two claims cannot both be right". This module walks those
//! edges and nothing else, and [`Standing`] is named for what it actually
//! checked rather than for what a reader might hope it means.
//!
//! **`Contested` is not "disagrees with THIS change".** The change has not
//! been interpreted yet — interpreting it is the run's whole job — so no
//! belief can be known to bear on it. What can be said, truthfully, is that
//! the base already disagrees with itself here, and that is the accessible
//! counterevidence the contract wants surfaced. The prompt says so in those
//! words.
//!
//! **`retrieval::candidates` is not used, and the reason is structural.** It
//! takes a `Query` with a `subject_id` — the entity a PROPOSED belief is
//! about — and an ingest window has no subject yet. Its expansion also
//! returns one flat list with the relation kind discarded, so a caller could
//! not recover which candidates the contradicts edges reached. What is shared
//! is the part worth sharing: `entities_named_in`, the whole-token-run alias
//! match, is called rather than reimplemented.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::RelationKind;

use super::prompt::{Candidate, SourceItem, Standing};

/// Which candidates one window's bytes reach.
///
/// Sorted by belief id and duplicate-free, so a re-run renders the identical
/// prompt. There is no ranking: a score would be a number nobody could
/// defend, and the surrounding milestone forbids scalar salience outright.
pub fn candidates(state: &EpistemicState, items: &[SourceItem]) -> Vec<Candidate> {
    let mut entities: BTreeSet<String> = BTreeSet::new();
    for item in items {
        entities.extend(crate::retrieval::entities_named_in(state, &item.content));
    }
    let contested = contested_beliefs(state);

    let mut out: BTreeMap<String, Candidate> = BTreeMap::new();
    for belief in state.beliefs.values() {
        if !entities.contains(&belief.entity_id) {
            continue;
        }
        // A tombstoned belief is not something this window could be an
        // update to. Superseded and archived ones stay — "there is already a
        // retired belief about this" is exactly what a reader wants.
        if belief.tombstoned_by.is_some() {
            continue;
        }
        out.insert(
            belief.belief_id.clone(),
            Candidate {
                belief_id: belief.belief_id.clone(),
                statement: belief.current().content.clone(),
                standing: if contested.contains(&belief.belief_id) {
                    Standing::Contested
                } else {
                    Standing::Uncontested
                },
            },
        );
    }
    out.into_values().collect()
}

/// Every belief a LIVE `contradicts` edge touches, from either end.
///
/// Direction-blind for the reason `retrieval::related_beliefs` is: a
/// `contradicts` edge is one fact recorded from one end, and reading only
/// outgoing edges would surface the counterevidence for whichever belief
/// happened to be written second.
fn contested_beliefs(state: &EpistemicState) -> BTreeSet<String> {
    let mut contested = BTreeSet::new();
    for relation in state.relations.values() {
        if !relation.live || relation.relation != RelationKind::Contradicts {
            continue;
        }
        contested.insert(relation.from.clone());
        contested.insert(relation.to.clone());
    }
    contested
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{AliasState, BeliefState, RelationState, RevisionState};
    use crate::ledger::schema::{normalize_alias_v1, BeliefBasis, Lifecycle, Qualification};

    const FALCON: &str = "e0000000000000000000000000000001";
    const OTHER: &str = "e0000000000000000000000000000002";
    const B_ONE: &str = "b0000000000000000000000000000001";
    const B_TWO: &str = "b0000000000000000000000000000002";
    const B_ELSEWHERE: &str = "b0000000000000000000000000000003";

    fn belief(id: &str, entity: &str, content: &str) -> BeliefState {
        BeliefState {
            belief_id: id.to_string(),
            entity_id: entity.to_string(),
            created_event_id: "1".repeat(32),
            revisions: vec![RevisionState {
                revision: 1,
                event_id: "1".repeat(32),
                content: content.to_string(),
                fields: serde_json::json!({}),
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            }],
            attested: None,
            attestation_events: vec![],
            path: None,
            overrides: vec![],
            override_head_event: None,
            projection_head_event: "1".repeat(32),
            qualification: Qualification::Draft,
            lifecycle: Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            contest_head_event: None,
            lifecycle_head_event: None,
            entity_merge_event_ids: vec![],
        }
    }

    fn state() -> EpistemicState {
        let mut state = EpistemicState::default();
        for (alias, entity) in [("Falcon", FALCON), ("Kestrel", OTHER)] {
            state.alias_registry.insert(
                normalize_alias_v1(alias),
                AliasState {
                    normalized: normalize_alias_v1(alias),
                    alias: alias.to_string(),
                    entity_id: entity.to_string(),
                    event_id: "1".repeat(32),
                },
            );
        }
        for (id, entity, content) in [
            (B_ONE, FALCON, "the cutover is on track"),
            (B_TWO, FALCON, "the cutover slipped a week"),
            (B_ELSEWHERE, OTHER, "unrelated"),
        ] {
            state
                .beliefs
                .insert(id.to_string(), belief(id, entity, content));
        }
        state
    }

    fn relate(state: &mut EpistemicState, from: &str, to: &str, kind: RelationKind, live: bool) {
        let id = format!("r-{from}-{to}");
        state.relations.insert(
            id.clone(),
            RelationState {
                relation_id: id,
                from: from.to_string(),
                to: to.to_string(),
                relation: kind,
                live,
                last_add_event_id: "1".repeat(32),
                last_event_id: "1".repeat(32),
            },
        );
    }

    fn item(content: &str) -> SourceItem {
        SourceItem {
            item_id: "aa".repeat(16),
            path: "records/a.md".into(),
            content: content.into(),
        }
    }

    #[test]
    fn a_contradicts_edge_is_what_makes_a_candidate_contested() {
        let mut state = state();
        relate(&mut state, B_ONE, B_TWO, RelationKind::Contradicts, true);
        let found = candidates(&state, &[item("The Falcon cutover is under review.")]);
        let standings: Vec<(&str, Standing)> = found
            .iter()
            .map(|c| (c.belief_id.as_str(), c.standing))
            .collect();
        assert_eq!(
            standings,
            vec![(B_ONE, Standing::Contested), (B_TWO, Standing::Contested)],
            "an edge contests BOTH ends"
        );
    }

    #[test]
    fn only_contradicts_counts_and_only_while_it_is_live() {
        // The whole honesty of the section rests on this: `supersedes` and
        // `refines` are relations between claims, and neither says the two
        // cannot both be right.
        for kind in [RelationKind::Supersedes, RelationKind::Refines] {
            let mut state = state();
            relate(&mut state, B_ONE, B_TWO, kind, true);
            let found = candidates(&state, &[item("Falcon")]);
            assert!(
                found.iter().all(|c| c.standing == Standing::Uncontested),
                "{kind:?} is not disagreement"
            );
        }
        let mut state = state();
        relate(&mut state, B_ONE, B_TWO, RelationKind::Contradicts, false);
        let found = candidates(&state, &[item("Falcon")]);
        assert!(
            found.iter().all(|c| c.standing == Standing::Uncontested),
            "a retracted edge is not a live disagreement"
        );
    }

    #[test]
    fn candidates_are_the_beliefs_about_what_the_bytes_name() {
        let found = candidates(&state(), &[item("Falcon shipped on Tuesday.")]);
        let ids: Vec<&str> = found.iter().map(|c| c.belief_id.as_str()).collect();
        assert_eq!(ids, vec![B_ONE, B_TWO]);
        assert!(
            !ids.contains(&B_ELSEWHERE),
            "a belief about an entity nothing named is not a candidate"
        );
    }

    #[test]
    fn bytes_that_name_nothing_reach_nothing() {
        // And the prompt then says which test found no counterevidence,
        // rather than claiming there is none.
        assert!(candidates(&state(), &[item("a bare heading")]).is_empty());
    }

    #[test]
    fn every_item_in_the_window_contributes_its_names() {
        let found = candidates(
            &state(),
            &[item("Falcon is late"), item("Kestrel is early")],
        );
        let ids: Vec<&str> = found.iter().map(|c| c.belief_id.as_str()).collect();
        assert_eq!(ids, vec![B_ONE, B_TWO, B_ELSEWHERE]);
    }

    #[test]
    fn a_tombstoned_belief_is_not_a_candidate() {
        let mut state = state();
        state.beliefs.get_mut(B_ONE).unwrap().tombstoned_by = Some("1".repeat(32));
        let ids: Vec<String> = candidates(&state, &[item("Falcon")])
            .into_iter()
            .map(|c| c.belief_id)
            .collect();
        assert_eq!(ids, vec![B_TWO.to_string()]);
    }

    #[test]
    fn the_same_window_reaches_the_same_candidates_in_the_same_order() {
        // The prompt is rendered from this; an order that drifted would make
        // two identical windows produce two different prompts.
        let state = state();
        let items = [item("Falcon and Kestrel")];
        assert_eq!(candidates(&state, &items), candidates(&state, &items));
    }
}
