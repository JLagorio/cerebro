//! Belief qualification, lifecycle, tombstone, and contest bodies (M24.3).
//!
//! M22 left `belief.tombstoned` RESERVED — the name claimed, the body
//! deliberately undefined so nothing could guess at it. These are those
//! bodies, plus the three transitions the D5 op ladder needs.
//!
//! Every transition here is EXACT. A created Belief is `active` lifecycle
//! and `draft` qualification; promotion is `draft → qualified`; supersede is
//! `active → superseded` with a required successor; archive and deprecate
//! both land on `archived` but differ in cause and in whether a replacement
//! is allowed; the stored inverses are `qualified → draft` and `superseded →
//! active`. Tombstone is a SEPARATE, non-reversible lifecycle that any of
//! the three live states can reach. Anything not listed is
//! `illegal_transition` — including a same-state transition and a
//! replacement equal to its own target, both of which are the shapes a
//! buggy maintenance pass produces.

use serde::{Deserialize, Serialize};

use super::{is_id128, is_sha256, schema_body};

/// The type-doc field roles a qualification profile can require (§15).
///
/// Capability-gated and TYPE-NAME-BLIND: the house no-type-special-casing
/// rule extended to policy. A profile says "this needs an owner and a
/// completion condition", never "this is a Task".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldRole {
    FailureCondition,
    Impact,
    Evidence,
    Trigger,
    CompletionCondition,
    Owner,
    Verb,
}

impl FieldRole {
    /// Every role, in the canonical order `required_roles` must be sorted
    /// into — the enum's own declaration order, not alphabetical.
    pub const ALL: [FieldRole; 7] = [
        FieldRole::FailureCondition,
        FieldRole::Impact,
        FieldRole::Evidence,
        FieldRole::Trigger,
        FieldRole::CompletionCondition,
        FieldRole::Owner,
        FieldRole::Verb,
    ];

    /// The wire spelling — identical to the serde one, which a test pins.
    pub fn as_str(&self) -> &'static str {
        match self {
            FieldRole::FailureCondition => "failure_condition",
            FieldRole::Impact => "impact",
            FieldRole::Evidence => "evidence",
            FieldRole::Trigger => "trigger",
            FieldRole::CompletionCondition => "completion_condition",
            FieldRole::Owner => "owner",
            FieldRole::Verb => "verb",
        }
    }

    /// A type doc's `role:` annotation, or None for a word this build does
    /// not know. The caller decides what an unknown annotation means — it is
    /// never silently dropped, because a typo that quietly disables a gate is
    /// the worst outcome available.
    pub fn parse(annotation: &str) -> Option<FieldRole> {
        FieldRole::ALL
            .iter()
            .copied()
            .find(|role| role.as_str() == annotation)
    }
}

/// Which profile a promotion was judged against, pinned by schema hash so a
/// later type-doc edit cannot retroactively re-decide an old promotion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationProfileRef {
    pub type_id: String,
    pub type_schema_hash: String,
    pub required_roles: Vec<FieldRole>,
}

impl QualificationProfileRef {
    pub fn validate(&self) -> Result<(), String> {
        if self.type_id.is_empty() {
            return Err("qualification profile type_id is empty".into());
        }
        if !is_sha256(&self.type_schema_hash) {
            return Err("qualification profile type_schema_hash is not a sha256".into());
        }
        if self.required_roles.is_empty() {
            return Err(
                "a qualification profile requiring no roles is a gate that never gates".into(),
            );
        }
        let mut sorted = self.required_roles.clone();
        sorted.sort();
        sorted.dedup();
        if sorted.len() != self.required_roles.len() {
            return Err("qualification profile repeats a required role".into());
        }
        if sorted != self.required_roles {
            return Err("qualification profile roles are not in canonical order".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Qualification {
    Draft,
    Qualified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationCause {
    Promoted,
    Reverted,
}

schema_body! {
    /// Draft ⇄ qualified. The only two legal edges are `draft → qualified`
    /// (promoted) and its stored inverse `qualified → draft` (reverted).
    pub struct BeliefQualificationChanged {
        pub belief_id: String,
        pub from: Qualification,
        pub to: Qualification,
        pub qualification_profile: QualificationProfileRef,
        pub cause: QualificationCause,
    }
}

impl BeliefQualificationChanged {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        self.qualification_profile.validate()?;
        match (self.from, self.to, self.cause) {
            (Qualification::Draft, Qualification::Qualified, QualificationCause::Promoted) => {
                Ok(())
            }
            (Qualification::Qualified, Qualification::Draft, QualificationCause::Reverted) => {
                Ok(())
            }
            (from, to, cause) => Err(format!(
                "illegal_transition: qualification {from:?} → {to:?} with cause {cause:?}"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Active,
    Superseded,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleCause {
    Superseded,
    Archived,
    Deprecated,
    Reverted,
}

schema_body! {
    /// The provenance-preserving lifecycle. `replacement_id` is required
    /// exactly where the transition means "this was replaced by that".
    pub struct BeliefLifecycleChanged {
        pub belief_id: String,
        pub from: Lifecycle,
        pub to: Lifecycle,
        pub cause: LifecycleCause,
        pub replacement_id: Option<String>,
    }
}

impl BeliefLifecycleChanged {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        if let Some(replacement) = &self.replacement_id {
            if !is_id128(replacement) {
                return Err("replacement_id is not a stable 128-bit hex id".into());
            }
            // A belief that replaces itself is a loop the projector and the
            // Skeptic would both have to special-case forever.
            if replacement == &self.belief_id {
                return Err("illegal_transition: a Belief cannot replace itself".into());
            }
        }
        use Lifecycle::*;
        use LifecycleCause as C;
        match (
            self.from,
            self.to,
            self.cause,
            self.replacement_id.is_some(),
        ) {
            // Supersede names its successor; without one, "superseded by
            // what?" has no answer and the lineage edge cannot exist.
            (Active, Superseded, C::Superseded, true) => Ok(()),
            // Archive is the deliberate no-replacement retirement.
            (Active, Archived, C::Archived, false) => Ok(()),
            // Deprecate may or may not point at what to use instead.
            (Active, Archived, C::Deprecated, _) => Ok(()),
            // The stored one-click inverse of a supersede.
            (Superseded, Active, C::Reverted, false) => Ok(()),
            (from, to, cause, has_replacement) => Err(format!(
                "illegal_transition: lifecycle {from:?} → {to:?} cause {cause:?} \
                 (replacement present: {has_replacement})"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TombstoneReason {
    Duplicate,
    Superseded,
    Invalid,
    OwnerRequested,
}

schema_body! {
    /// The separate, NON-REVERSIBLE terminal state. Reachable from any live
    /// lifecycle; reachable from nothing afterwards. It is a distinct body
    /// rather than a fourth `Lifecycle` variant precisely so no
    /// `lifecycle_changed` inverse can ever spell a way back out.
    pub struct BeliefTombstoned {
        pub belief_id: String,
        pub replacement_id: Option<String>,
        pub reason_code: TombstoneReason,
    }
}

impl BeliefTombstoned {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        if let Some(replacement) = &self.replacement_id {
            if !is_id128(replacement) {
                return Err("replacement_id is not a stable 128-bit hex id".into());
            }
            if replacement == &self.belief_id {
                return Err("illegal_transition: a Belief cannot replace itself".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContestAction {
    Open,
    Close,
}

schema_body! {
    /// A recorded challenge to a Belief. Opening REQUIRES counterevidence —
    /// contesting on a feeling is how a Validity axis becomes noise —
    /// and closing requires the event that addressed it.
    pub struct BeliefContested {
        pub belief_id: String,
        pub action: ContestAction,
        pub counterevidence_refs: Vec<String>,
        pub addressed_by_event_id: Option<String>,
    }
}

impl BeliefContested {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for reference in &self.counterevidence_refs {
            if !is_id128(reference) {
                return Err(format!(
                    "counterevidence ref {reference:?} is not an event id"
                ));
            }
            if !seen.insert(reference.as_str()) {
                return Err(format!("duplicate counterevidence ref {reference}"));
            }
        }
        if seen.len() != self.counterevidence_refs.len() {
            return Err("duplicate counterevidence ref".into());
        }
        let sorted: Vec<&str> = seen.into_iter().collect();
        if sorted
            != self
                .counterevidence_refs
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
        {
            return Err("counterevidence refs are not sorted".into());
        }
        match self.action {
            ContestAction::Open => {
                if self.counterevidence_refs.is_empty() {
                    return Err(
                        "a contest with no counterevidence is an opinion, not a challenge".into(),
                    );
                }
                if self.addressed_by_event_id.is_some() {
                    return Err("an opening contest cannot already be addressed".into());
                }
            }
            ContestAction::Close => match &self.addressed_by_event_id {
                Some(id) if is_id128(id) => {}
                Some(_) => return Err("addressed_by_event_id is not an event id".into()),
                None => return Err("closing a contest requires the event that addressed it".into()),
            },
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::Actor;

    const BELIEF: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const OTHER: &str = "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
    const EVENT: &str = "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3";

    fn profile() -> QualificationProfileRef {
        QualificationProfileRef {
            type_id: "Metric".into(),
            type_schema_hash: "f".repeat(64),
            required_roles: vec![FieldRole::Evidence, FieldRole::Owner],
        }
    }

    #[test]
    fn a_role_spells_itself_the_same_way_twice() {
        // `as_str` is what a type doc's `role:` annotation is matched
        // against and what a parked row records; serde is what the ledger
        // writes. Two spellings of one vocabulary would let a promotion be
        // judged against a role the event does not name.
        for role in FieldRole::ALL {
            let wire = serde_json::to_string(&role).unwrap();
            assert_eq!(wire, format!("\"{}\"", role.as_str()));
            assert_eq!(FieldRole::parse(role.as_str()), Some(role));
        }
        assert_eq!(FieldRole::parse("onwer"), None, "a typo is not a role");
    }

    #[test]
    fn the_canonical_role_order_is_the_declaration_order() {
        // `QualificationProfileRef::validate` demands sorted roles, and a
        // derived profile sorts with this same Ord. Alphabetical would put
        // `completion_condition` first and every derived profile would fail
        // validation.
        let mut sorted = FieldRole::ALL.to_vec();
        sorted.sort();
        assert_eq!(sorted, FieldRole::ALL.to_vec());
    }

    fn qualification(
        from: Qualification,
        to: Qualification,
        cause: QualificationCause,
    ) -> BeliefQualificationChanged {
        BeliefQualificationChanged {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor { id: "test".into() },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            from,
            to,
            qualification_profile: profile(),
            cause,
        }
    }

    fn lifecycle(
        from: Lifecycle,
        to: Lifecycle,
        cause: LifecycleCause,
        replacement: Option<&str>,
    ) -> BeliefLifecycleChanged {
        BeliefLifecycleChanged {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor { id: "test".into() },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            from,
            to,
            cause,
            replacement_id: replacement.map(str::to_string),
        }
    }

    #[test]
    fn promotion_and_its_stored_inverse_are_the_only_qualification_edges() {
        assert!(qualification(
            Qualification::Draft,
            Qualification::Qualified,
            QualificationCause::Promoted
        )
        .validate()
        .is_ok());
        assert!(qualification(
            Qualification::Qualified,
            Qualification::Draft,
            QualificationCause::Reverted
        )
        .validate()
        .is_ok());
        // A same-state transition is the shape a buggy retry produces.
        assert!(qualification(
            Qualification::Draft,
            Qualification::Draft,
            QualificationCause::Promoted
        )
        .validate()
        .is_err());
        // The right edge with the wrong cause is still wrong: the cause is
        // what the review card and the revert plan read.
        assert!(qualification(
            Qualification::Draft,
            Qualification::Qualified,
            QualificationCause::Reverted
        )
        .validate()
        .is_err());
    }

    #[test]
    fn a_profile_that_requires_nothing_is_refused() {
        let mut empty = profile();
        empty.required_roles.clear();
        assert!(empty.validate().unwrap_err().contains("never gates"));
    }

    #[test]
    fn supersede_must_name_its_successor_and_archive_must_not() {
        use Lifecycle::*;
        use LifecycleCause as C;
        assert!(lifecycle(Active, Superseded, C::Superseded, Some(OTHER))
            .validate()
            .is_ok());
        // "Superseded by what?" must have an answer, or the lineage edge
        // this event pairs with has no other end.
        assert!(lifecycle(Active, Superseded, C::Superseded, None)
            .validate()
            .is_err());
        assert!(lifecycle(Active, Archived, C::Archived, None)
            .validate()
            .is_ok());
        assert!(lifecycle(Active, Archived, C::Archived, Some(OTHER))
            .validate()
            .is_err());
        // Deprecation is the one transition where a replacement is optional.
        assert!(lifecycle(Active, Archived, C::Deprecated, Some(OTHER))
            .validate()
            .is_ok());
        assert!(lifecycle(Active, Archived, C::Deprecated, None)
            .validate()
            .is_ok());
    }

    #[test]
    fn the_stored_lifecycle_inverse_is_the_only_way_back_to_active() {
        use Lifecycle::*;
        use LifecycleCause as C;
        assert!(lifecycle(Superseded, Active, C::Reverted, None)
            .validate()
            .is_ok());
        // Un-archiving is not a v1 transition; it would be a new proposal.
        assert!(lifecycle(Archived, Active, C::Reverted, None)
            .validate()
            .is_err());
    }

    #[test]
    fn a_belief_can_never_replace_itself() {
        use Lifecycle::*;
        use LifecycleCause as C;
        assert!(lifecycle(Active, Superseded, C::Superseded, Some(BELIEF))
            .validate()
            .unwrap_err()
            .contains("cannot replace itself"));
    }

    #[test]
    fn a_contest_opens_only_with_counterevidence_and_closes_only_with_an_addressing_event() {
        let contest = |action, refs: Vec<&str>, addressed: Option<&str>| BeliefContested {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor { id: "test".into() },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            action,
            counterevidence_refs: refs.into_iter().map(str::to_string).collect(),
            addressed_by_event_id: addressed.map(str::to_string),
        };
        assert!(contest(ContestAction::Open, vec![EVENT], None)
            .validate()
            .is_ok());
        assert!(contest(ContestAction::Open, vec![], None)
            .validate()
            .unwrap_err()
            .contains("an opinion"));
        assert!(contest(ContestAction::Open, vec![EVENT], Some(EVENT))
            .validate()
            .is_err());
        assert!(contest(ContestAction::Close, vec![EVENT], Some(EVENT))
            .validate()
            .is_ok());
        assert!(contest(ContestAction::Close, vec![EVENT], None)
            .validate()
            .is_err());
        // Sorted and unique, so two spellings of one contest cannot exist.
        assert!(contest(ContestAction::Open, vec![OTHER, BELIEF], None)
            .validate()
            .unwrap_err()
            .contains("not sorted"));
    }

    #[test]
    fn a_tombstone_is_reachable_and_says_why() {
        let stone = |replacement: Option<&str>| BeliefTombstoned {
            schema: 1,
            batch_id: None,
            idempotency_key: None,
            actor: Actor { id: "test".into() },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            replacement_id: replacement.map(str::to_string),
            reason_code: TombstoneReason::Duplicate,
        };
        assert!(stone(Some(OTHER)).validate().is_ok());
        assert!(stone(None).validate().is_ok());
        assert!(stone(Some(BELIEF)).validate().is_err());
    }
}
