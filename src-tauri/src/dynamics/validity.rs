//! [`Validity`] — the bundle, not an enum (M27.1).
//!
//! **Three fields, deliberately orthogonal** (§49). A belief facet may be
//! stale AND contested while active; it may be fresh and archived, for
//! historical display. A single `claim_status` enum would have to choose one
//! word for a state that genuinely has three, and every collapse loses the one
//! a person needed.
//!
//! **`contested` means somebody has said these disagree.** In M27.1 that is a
//! live declared `contradicts` relation touching the belief. M27.3 adds the
//! second term — an open contradiction edge from the classification pipeline —
//! and it is an OR, not a replacement: an unclassified legacy relation stays a
//! visible protected conflict until the backfill classifies it, which is the
//! contradiction lane's rule and the preservation gate's.
//!
//! **A detected comparison is NOT contested.** M26.7's
//! `conflict.candidate_detected` says a pair is worth classifying. Reading
//! that as disagreement is exactly the crying-wolf failure the resolution
//! pipeline exists to prevent: most candidates resolve as stage lag or
//! temporal succession, and a chip that said "contested" about every one of
//! them would train the owner to ignore the word.

use crate::ledger::reduce::{BeliefState, EpistemicState};
use crate::ledger::schema::{Lifecycle as SchemaLifecycle, RelationKind};

use super::freshness::Freshness;

/// Where a belief is in its life. `Tombstoned` is a member here and not in
/// the schema's own enum, because tombstoning is a separate terminal event
/// (M24) and a bundle that could not say the word would have to render a
/// tombstoned belief as `active`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Active,
    Superseded,
    Archived,
    Tombstoned,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Lifecycle::Active => "active",
            Lifecycle::Superseded => "superseded",
            Lifecycle::Archived => "archived",
            Lifecycle::Tombstoned => "tombstoned",
        }
    }

    pub const ALL: [Lifecycle; 4] = [
        Lifecycle::Active,
        Lifecycle::Superseded,
        Lifecycle::Archived,
        Lifecycle::Tombstoned,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Conflict {
    Clear,
    Contested,
}

impl Conflict {
    pub fn as_str(self) -> &'static str {
        match self {
            Conflict::Clear => "clear",
            Conflict::Contested => "contested",
        }
    }
}

/// The bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Validity {
    pub freshness: Freshness,
    pub conflict: Conflict,
    pub lifecycle: Lifecycle,
}

impl Validity {
    /// The human-readable half of the composed chip line ("stale and
    /// contested"). Lifecycle is named only when it is not `active`, because
    /// "active" is the unremarkable case and saying it every time makes the
    /// exceptional case harder to see.
    pub fn describe(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        match self.freshness {
            Freshness::Fresh => parts.push("fresh"),
            Freshness::Stale => parts.push("stale"),
            Freshness::Unknown => parts.push("freshness unknown"),
        }
        if self.conflict == Conflict::Contested {
            parts.push("contested");
        }
        if self.lifecycle != Lifecycle::Active {
            parts.push(self.lifecycle.as_str());
        }
        parts.join(" and ")
    }
}

/// Whether anybody has declared this belief in conflict.
pub fn conflict_of(state: &EpistemicState, belief_id: &str) -> Conflict {
    let declared = state.relations.values().any(|relation| {
        relation.live
            && relation.relation == RelationKind::Contradicts
            && (relation.from == belief_id || relation.to == belief_id)
    });
    if declared {
        return Conflict::Contested;
    }
    Conflict::Clear
}

pub fn lifecycle_of(belief: &BeliefState) -> Lifecycle {
    // Terminal wins: a tombstoned belief whose last lifecycle transition said
    // `archived` is tombstoned, and the archive is history.
    if belief.tombstoned_by.is_some() {
        return Lifecycle::Tombstoned;
    }
    match belief.lifecycle {
        SchemaLifecycle::Active => Lifecycle::Active,
        SchemaLifecycle::Superseded => Lifecycle::Superseded,
        SchemaLifecycle::Archived => Lifecycle::Archived,
    }
}

/// Assemble the bundle for one facet's belief.
pub fn validity_of(state: &EpistemicState, belief: &BeliefState, freshness: Freshness) -> Validity {
    Validity {
        freshness,
        conflict: conflict_of(state, &belief.belief_id),
        lifecycle: lifecycle_of(belief),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{relate, B_ONE, B_TWO};
    use crate::dynamics::facet::tests::base;

    #[test]
    fn stale_and_contested_and_active_all_survive_together() {
        // The acceptance row: a bundle that could not hold all three at once
        // would force a choice, and every choice here drops something true.
        let mut state = base();
        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            true,
        );
        let validity = validity_of(&state, state.beliefs.get(B_ONE).unwrap(), Freshness::Stale);
        assert_eq!(
            validity,
            Validity {
                freshness: Freshness::Stale,
                conflict: Conflict::Contested,
                lifecycle: Lifecycle::Active,
            }
        );
        assert_eq!(validity.describe(), "stale and contested");
    }

    #[test]
    fn a_retired_relation_leaves_the_belief_clear() {
        let mut state = base();
        relate(
            &mut state,
            "r1",
            B_ONE,
            B_TWO,
            RelationKind::Contradicts,
            false,
        );
        assert_eq!(conflict_of(&state, B_ONE), Conflict::Clear);
    }

    #[test]
    fn a_detected_comparison_is_not_contestation() {
        // The crying-wolf guard. A candidate says "worth classifying", and
        // most of them resolve as stage lag.
        let mut state = base();
        let candidates = crate::conflict::detect::find(&crate::conflict::detect::fixture::base());
        assert!(!candidates.is_empty(), "the fixture disagrees with itself");
        let comparison_id =
            crate::ledger::schema::derive_comparison_id(&candidates[0].left, &candidates[0].right)
                .unwrap();
        state.comparisons.insert(
            comparison_id.clone(),
            crate::ledger::reduce::ComparisonRow {
                comparison_id,
                event_id: "90000000000000000000000000000001".into(),
                left: candidates[0].left.clone(),
                right: candidates[0].right.clone(),
                reason_codes: candidates[0].reason_codes.clone(),
                detector_version: "conflict-detector-v1".into(),
            },
        );
        assert_eq!(
            conflict_of(&state, &candidates[0].left.belief_id),
            Conflict::Clear
        );
    }

    #[test]
    fn a_tombstone_outranks_whatever_the_lifecycle_field_says() {
        let mut state = base();
        let belief = state.beliefs.get_mut(B_ONE).unwrap();
        belief.lifecycle = SchemaLifecycle::Archived;
        belief
            .tombstoned_by
            .replace("90000000000000000000000000000009".into());
        assert_eq!(
            lifecycle_of(state.beliefs.get(B_ONE).unwrap()),
            Lifecycle::Tombstoned
        );
    }

    #[test]
    fn every_lifecycle_value_is_reachable_and_spelled_once() {
        let mut state = base();
        for (schema, expected) in [
            (SchemaLifecycle::Active, Lifecycle::Active),
            (SchemaLifecycle::Superseded, Lifecycle::Superseded),
            (SchemaLifecycle::Archived, Lifecycle::Archived),
        ] {
            state.beliefs.get_mut(B_ONE).unwrap().lifecycle = schema;
            assert_eq!(lifecycle_of(state.beliefs.get(B_ONE).unwrap()), expected);
        }
        let mut spellings: Vec<&str> = Lifecycle::ALL.iter().map(|l| l.as_str()).collect();
        spellings.sort_unstable();
        spellings.dedup();
        assert_eq!(spellings.len(), 4);
    }

    #[test]
    fn the_composed_line_names_only_what_is_worth_saying() {
        assert_eq!(
            Validity {
                freshness: Freshness::Fresh,
                conflict: Conflict::Clear,
                lifecycle: Lifecycle::Active,
            }
            .describe(),
            "fresh"
        );
        assert_eq!(
            Validity {
                freshness: Freshness::Unknown,
                conflict: Conflict::Clear,
                lifecycle: Lifecycle::Superseded,
            }
            .describe(),
            "freshness unknown and superseded"
        );
    }
}
