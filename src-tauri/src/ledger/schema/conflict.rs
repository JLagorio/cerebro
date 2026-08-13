//! `conflict.candidate_detected` (M26.7): the deterministic signal that says
//! two pinned claims need CLASSIFYING — never that either is wrong.
//!
//! **It asserts no contradiction, and that is the whole discipline.** M27 owns
//! the seven-way classification (§50); this event owns the observation that a
//! pair is worth running through it. Nothing here reads a belief's meaning,
//! and nothing here is evidence: the reducer indexes it, creates one CAS
//! target, and stops.
//!
//! **Detection order can never duplicate a comparison.** Each endpoint is
//! serialized as canonical JSON, the two byte strings are sorted, and
//! `comparison_id` is a domain-separated digest over that ordered pair. The
//! same two claims found by a scan running backwards mint the same id.
//!
//! **The body carries them in that same sorted order**, which is a decision
//! rather than a formality. `comparison_id` alone is order-free, so a detector
//! that emitted `(b, a)` after `(a, b)` would present the writer with the same
//! idempotency key over different bytes — a hard conflict, refused, when what
//! actually happened was an exact retry. Pinning `left` to the
//! lexicographically-first tuple makes the body a FUNCTION of the pair, so an
//! exact retry is exactly a retry.
//!
//! **`state_stage` is `scope.stage` made total.** M27's gauntlet compares
//! stage as a closed value where "we do not know" is a real member, and a
//! `null` that means "unknown" cannot be compared without every reader
//! re-deciding what null meant. The two are checked against each other here so
//! the denormalization can never become a second source of truth.

use serde::{Deserialize, Serialize};

use super::{
    canonical_json, is_id128, is_sha256, schema_body, sha256_first128, Scope, Stage, TypedValue,
    ValidInterval,
};

/// Why a pair was put forward for classification. Closed, and every member is
/// a STRUCTURAL observation — none of them means "these disagree". `min_items
/// = 1`: a candidate with no reason is a detector that did not say why.
///
/// Declared in string-sorted order, so `Ord` and the wire spelling agree and
/// "sorted" means one thing in both implementations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictCandidateReason {
    /// A migrated or hand-declared `contradicts` belief-relation — someone
    /// already said these disagree, which is a claim to CHECK, not to trust.
    DeclaredContradictsRelation,
    /// Same subject and predicate, different value digests.
    IncompatibleValueHash,
    /// The scope qualifiers overlap, so scope does not separate them.
    OverlappingScope,
    /// The valid-time intervals overlap, so time does not separate them.
    OverlappingValidTime,
    /// Same subject and same predicate — the weakest reason there is, and on
    /// its own it means only "these two are about the same thing".
    SameSubjectPredicate,
    /// The two stages are not obviously disjoint, so a person or a later
    /// deterministic rule has to say whether "planned" and "shipping" are
    /// talking past each other.
    StageRequiresClassification,
}

impl ConflictCandidateReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ConflictCandidateReason::DeclaredContradictsRelation => "declared_contradicts_relation",
            ConflictCandidateReason::IncompatibleValueHash => "incompatible_value_hash",
            ConflictCandidateReason::OverlappingScope => "overlapping_scope",
            ConflictCandidateReason::OverlappingValidTime => "overlapping_valid_time",
            ConflictCandidateReason::SameSubjectPredicate => "same_subject_predicate",
            ConflictCandidateReason::StageRequiresClassification => "stage_requires_classification",
        }
    }

    pub const ALL: [ConflictCandidateReason; 6] = [
        ConflictCandidateReason::DeclaredContradictsRelation,
        ConflictCandidateReason::IncompatibleValueHash,
        ConflictCandidateReason::OverlappingScope,
        ConflictCandidateReason::OverlappingValidTime,
        ConflictCandidateReason::SameSubjectPredicate,
        ConflictCandidateReason::StageRequiresClassification,
    ];
}

/// `scope.stage` as a total value. `Unknown` is a member rather than an
/// absence, because "no stage was recorded" and "the stage is planned" are
/// different comparisons and a nullable field makes them one.
///
/// `Ord` follows the DECLARATION order, which is the lifecycle progression —
/// planned before shipping, unknown last. That is what M27's facet keys sort
/// by, and it is deliberately NOT the string order that
/// [`ConflictCandidateReason`] carries: nothing serializes a sorted list of
/// stages, so nothing has to agree across languages about it. A body that
/// ever does needs the same declaration-order-equals-wire-order test the
/// reason codes have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateStage {
    Planned,
    Approved,
    Implemented,
    Validated,
    Deployed,
    Shipping,
    Unknown,
}

impl StateStage {
    /// The one mapping. Used by the detector to fill the field and by
    /// `validate` to check it, so there is no way to write an endpoint whose
    /// stage disagrees with its own scope.
    pub fn of(stage: Option<Stage>) -> StateStage {
        match stage {
            Some(Stage::Planned) => StateStage::Planned,
            Some(Stage::Approved) => StateStage::Approved,
            Some(Stage::Implemented) => StateStage::Implemented,
            Some(Stage::Validated) => StateStage::Validated,
            Some(Stage::Deployed) => StateStage::Deployed,
            Some(Stage::Shipping) => StateStage::Shipping,
            None => StateStage::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StateStage::Planned => "planned",
            StateStage::Approved => "approved",
            StateStage::Implemented => "implemented",
            StateStage::Validated => "validated",
            StateStage::Deployed => "deployed",
            StateStage::Shipping => "shipping",
            StateStage::Unknown => "unknown",
        }
    }
}

/// One end of a comparison: an assertion, the Belief revision that rested on
/// it, and the facets a classifier needs. M27 aliases this shape byte for
/// byte as its `asserted` endpoint — the fields are pinned, not descriptive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConflictCandidateEndpointV1 {
    /// What the evidence asserted.
    pub assertion_event_id: String,
    pub belief_id: String,
    /// The revision whose basis USED that assertion. Pinned, so a comparison
    /// stays about what was believed then even after the Belief moves on.
    pub belief_revision_event_id: String,
    pub subject_id: String,
    pub predicate: String,
    /// [`derive_value_hash`] over the asserted value — the digest, never the
    /// value, because a comparison signal is not a place to copy claims into.
    pub value_hash: String,
    pub scope: Scope,
    pub state_stage: StateStage,
    pub valid_time: ValidInterval,
}

impl ConflictCandidateEndpointV1 {
    pub fn validate(&self, side: &str) -> Result<(), String> {
        for (name, id) in [
            ("assertion_event_id", &self.assertion_event_id),
            ("belief_id", &self.belief_id),
            ("belief_revision_event_id", &self.belief_revision_event_id),
            ("subject_id", &self.subject_id),
        ] {
            if !is_id128(id) {
                return Err(format!("{side}.{name} is not a 128-bit hex id"));
            }
        }
        if self.predicate.is_empty() {
            return Err(format!("{side}.predicate must be non-empty"));
        }
        if !is_sha256(&self.value_hash) {
            return Err(format!("{side}.value_hash is not a sha256 digest"));
        }
        if self.state_stage != StateStage::of(self.scope.stage) {
            return Err(format!(
                "{side}.state_stage is {}, but its own scope says {} — the stage is a \
                 denormalization of the scope, never a second opinion about it",
                self.state_stage.as_str(),
                StateStage::of(self.scope.stage).as_str()
            ));
        }
        for (name, stamp) in [("from", &self.valid_time.from), ("to", &self.valid_time.to)] {
            if let Some(stamp) = stamp {
                if chrono::DateTime::parse_from_rfc3339(stamp).is_err() {
                    return Err(format!("{side}.valid_time.{name} {stamp:?} is not RFC3339"));
                }
            }
        }
        if let (Some(from), Some(to)) = (&self.valid_time.from, &self.valid_time.to) {
            if from > to {
                return Err(format!("{side}.valid_time ends before it starts"));
            }
        }
        Ok(())
    }
}

/// The digest of an asserted value. Domain-separated like every other derived
/// id here, and taken over the canonical JSON so two spellings of the same
/// typed value cannot look like two different claims.
pub fn derive_value_hash(value: &TypedValue) -> Result<String, String> {
    let canonical = canonical_json(value)?;
    Ok(crate::ledger::sha256_hex(
        format!("cerebro-conflict-value-v1\0{canonical}").as_bytes(),
    ))
}

/// Canonically order the two endpoints. Returns their serialized bytes,
/// lexicographically sorted — the input to both the id and the body's own
/// `left`/`right` ordering, so the two can never be derived differently.
pub fn ordered_endpoints(
    a: &ConflictCandidateEndpointV1,
    b: &ConflictCandidateEndpointV1,
) -> Result<(String, String), String> {
    let (a, b) = (canonical_json(a)?, canonical_json(b)?);
    if a <= b {
        Ok((a, b))
    } else {
        Ok((b, a))
    }
}

/// `sha256("cerebro-conflict-comparison-v1\0" + first + "\0" + second)`,
/// first 128 bits — where `first`/`second` are the sorted canonical endpoint
/// tuples. Order-free by construction.
pub fn derive_comparison_id(
    a: &ConflictCandidateEndpointV1,
    b: &ConflictCandidateEndpointV1,
) -> Result<String, String> {
    let (first, second) = ordered_endpoints(a, b)?;
    Ok(sha256_first128(
        format!("cerebro-conflict-comparison-v1\0{first}\0{second}").as_bytes(),
    ))
}

/// The server-side idempotency key. Store-scoped, so two vaults detecting the
/// structurally identical pair never collide.
pub fn derive_conflict_candidate_key(store_uuid: &str, comparison_id: &str) -> String {
    format!("conflict-candidate:{store_uuid}:{comparison_id}")
}

schema_body! {
    /// One pair put forward for classification.
    pub struct ConflictCandidateDetected {
        /// [`derive_comparison_id`] over the two endpoints. The reducer
        /// re-derives it: an id that does not follow from the bytes it
        /// claims to summarize is the one lie this event could tell.
        pub comparison_id: String,
        /// The lexicographically-first endpoint (see the module note).
        pub left: ConflictCandidateEndpointV1,
        pub right: ConflictCandidateEndpointV1,
        /// Which detector build found it, so a signal can be read against
        /// the rules that produced it.
        pub detector_version: String,
        /// Non-empty, sorted, duplicate-free.
        pub reason_codes: Vec<ConflictCandidateReason>,
    }
}

impl ConflictCandidateDetected {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.comparison_id) {
            return Err("comparison_id must be a 128-bit hex id".into());
        }
        if self.detector_version.is_empty() {
            return Err("detector_version must be non-empty".into());
        }
        self.left.validate("left")?;
        self.right.validate("right")?;

        if self.reason_codes.is_empty() {
            return Err(
                "reason_codes must name at least one reason — a candidate that cannot say why \
                 it was raised is not a signal"
                    .into(),
            );
        }
        if !self.reason_codes.windows(2).all(|pair| pair[0] < pair[1]) {
            return Err("reason_codes must be sorted and duplicate-free".into());
        }

        let (first, second) = ordered_endpoints(&self.left, &self.right)?;
        if first == second {
            return Err(
                "left and right are the same endpoint — a claim does not need classifying \
                 against itself"
                    .into(),
            );
        }
        if canonical_json(&self.left)? != first {
            return Err(
                "left must be the lexicographically-first endpoint — the body is a function of \
                 the pair, so an exact retry is exactly a retry"
                    .into(),
            );
        }
        let derived = derive_comparison_id(&self.left, &self.right)?;
        if derived != self.comparison_id {
            return Err(format!(
                "comparison_id {} does not follow from these endpoints (expected {derived})",
                self.comparison_id
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{Actor, BODY_SCHEMA};

    const A: &str = "11111111111111111111111111111111";
    const B: &str = "22222222222222222222222222222222";
    const C: &str = "33333333333333333333333333333333";
    const D: &str = "44444444444444444444444444444444";
    const SUBJECT: &str = "cccccccccccccccccccccccccccccccc";

    fn endpoint(assertion: &str, belief: &str, predicate: &str) -> ConflictCandidateEndpointV1 {
        ConflictCandidateEndpointV1 {
            assertion_event_id: assertion.into(),
            belief_id: belief.into(),
            belief_revision_event_id: belief.into(),
            subject_id: SUBJECT.into(),
            predicate: predicate.into(),
            value_hash: derive_value_hash(&TypedValue::String {
                value: predicate.into(),
            })
            .unwrap(),
            scope: Scope::empty(),
            state_stage: StateStage::Unknown,
            valid_time: ValidInterval {
                from: None,
                to: None,
            },
        }
    }

    fn detected(
        left: ConflictCandidateEndpointV1,
        right: ConflictCandidateEndpointV1,
    ) -> ConflictCandidateDetected {
        let (first, _) = ordered_endpoints(&left, &right).unwrap();
        let (left, right) = if canonical_json(&left).unwrap() == first {
            (left, right)
        } else {
            (right, left)
        };
        ConflictCandidateDetected {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:conflict-detector".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            comparison_id: derive_comparison_id(&left, &right).unwrap(),
            left,
            right,
            detector_version: "conflict-detector-v1".into(),
            reason_codes: vec![ConflictCandidateReason::SameSubjectPredicate],
        }
    }

    #[test]
    fn detection_order_cannot_duplicate_a_comparison() {
        // The property the whole id formula exists for: a scan running the
        // other way finds the same comparison, not a second one.
        let one = endpoint(A, C, "ships_on");
        let two = endpoint(B, D, "ships_on");
        assert_eq!(
            derive_comparison_id(&one, &two).unwrap(),
            derive_comparison_id(&two, &one).unwrap()
        );
    }

    #[test]
    fn the_body_carries_the_endpoints_in_the_order_the_id_sorted_them() {
        // Not a formality: the same key over different bytes is a hard
        // conflict at the writer, so a swapped retry would be refused as a
        // contradiction of itself.
        let mut body = detected(endpoint(A, C, "ships_on"), endpoint(B, D, "ships_on"));
        body.validate().unwrap();
        std::mem::swap(&mut body.left, &mut body.right);
        let detail = body.validate().unwrap_err();
        assert!(detail.contains("lexicographically-first"), "{detail}");
    }

    #[test]
    fn an_id_that_does_not_follow_from_its_endpoints_is_refused() {
        let mut body = detected(endpoint(A, C, "ships_on"), endpoint(B, D, "ships_on"));
        body.comparison_id = "0".repeat(32);
        let detail = body.validate().unwrap_err();
        assert!(
            detail.contains("does not follow from these endpoints"),
            "{detail}"
        );
    }

    #[test]
    fn nothing_is_compared_against_itself() {
        let one = endpoint(A, C, "ships_on");
        let body = detected(one.clone(), one);
        let detail = body.validate().unwrap_err();
        assert!(
            detail.contains("does not need classifying against itself"),
            "{detail}"
        );
    }

    #[test]
    fn a_candidate_has_to_say_why_it_was_raised() {
        let mut body = detected(endpoint(A, C, "ships_on"), endpoint(B, D, "ships_on"));
        body.reason_codes.clear();
        assert!(body.validate().unwrap_err().contains("at least one reason"));
        body.reason_codes = vec![
            ConflictCandidateReason::SameSubjectPredicate,
            ConflictCandidateReason::IncompatibleValueHash,
        ];
        assert!(body.validate().unwrap_err().contains("sorted"));
        body.reason_codes = vec![
            ConflictCandidateReason::SameSubjectPredicate,
            ConflictCandidateReason::SameSubjectPredicate,
        ];
        assert!(body.validate().unwrap_err().contains("sorted"));
    }

    #[test]
    fn the_stage_cannot_disagree_with_the_scope_it_was_read_from() {
        let mut left = endpoint(A, C, "ships_on");
        left.state_stage = StateStage::Shipping;
        let detail = left.validate("left").unwrap_err();
        assert!(detail.contains("never a second opinion"), "{detail}");

        let mut right = endpoint(B, D, "ships_on");
        right.scope.stage = Some(Stage::Shipping);
        right.state_stage = StateStage::Shipping;
        right.validate("right").unwrap();
    }

    #[test]
    fn the_reason_spelling_and_the_sort_order_are_the_same_order() {
        // `reason_codes` sorts by the enum's ordinal and the wire carries
        // strings; a TS reducer sorting the strings has to agree.
        let mut spellings: Vec<&str> = ConflictCandidateReason::ALL
            .iter()
            .map(|r| r.as_str())
            .collect();
        let declared = spellings.clone();
        spellings.sort_unstable();
        assert_eq!(spellings, declared);
    }

    #[test]
    fn the_idempotency_key_is_store_scoped() {
        assert_eq!(
            derive_conflict_candidate_key("feedface", "abc"),
            "conflict-candidate:feedface:abc"
        );
    }
}
