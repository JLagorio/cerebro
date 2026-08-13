//! Resolver false-attach (M26.9b).
//!
//! The claim: an ambiguous mention must end UNRESOLVED, and a mention that
//! disagrees with a prior attachment must PARK. Both are aimed at the same
//! wrong implementation — one that picks the best candidate. That build is
//! right most of the time, which is exactly what makes it dangerous: a
//! confident wrong attachment puts one entity's evidence under another's
//! name, and nothing downstream can tell.
//!
//! `Attempt::validate` is the rule these exercise. It is structural rather
//! than advisory: a resolution that says "attached" without naming an entity,
//! or claims ambiguity while naming exactly one candidate, does not
//! round-trip.

use crate::ingest::resolver::{Attempt, Ineligible, Outcome, ReasonCode, Resolution};

const ONE: &str = "e0000000000000000000000000000001";
const TWO: &str = "e0000000000000000000000000000002";
const EVENT: &str = "90000000000000000000000000000001";

fn eligible(candidates: Vec<String>, resolution: Resolution) -> Attempt {
    Attempt::Eligible {
        normalized_mention_hashes: vec!["a".repeat(64)],
        target_count: 1,
        candidate_entity_ids: candidates,
        resolution,
    }
}

#[test]
fn an_ambiguous_mention_ends_unresolved_and_attaches_nothing() {
    let attempt = eligible(
        vec![ONE.into(), TWO.into()],
        Resolution::ParkedUnresolved {
            reason: ReasonCode::AmbiguousCandidates,
        },
    );
    attempt.validate().expect("a well-formed parked attempt");
    assert_eq!(attempt.outcome_str(), "unresolved");
    if let Attempt::Eligible { resolution, .. } = &attempt {
        assert_eq!(resolution.chosen_entity_id(), None, "nothing was attached");
        assert_eq!(resolution.attachment_state(), "parked");
    }
}

#[test]
fn picking_the_best_of_two_candidates_does_not_round_trip() {
    // The fixture aimed at the wrong implementation. A build that resolved
    // ambiguity by preference would produce exactly this, and the shape
    // refuses it: two candidates and an attachment is not a resolution, it
    // is a guess with a citation.
    let attempt = eligible(
        vec![ONE.into(), TWO.into()],
        Resolution::Attached {
            outcome: Outcome::NormalizedMatch,
            chosen_entity_id: ONE.into(),
        },
    );
    let detail = attempt
        .validate()
        .expect_err("attaching under ambiguity must not validate");
    assert!(!detail.is_empty());
}

#[test]
fn no_candidate_at_all_is_a_different_reason_from_too_many() {
    // Both park, and a surface that collapsed them would tell a person to
    // disambiguate something that has nothing to disambiguate.
    for reason in [ReasonCode::NoCandidate, ReasonCode::AmbiguousCandidates] {
        let candidates = match reason {
            ReasonCode::NoCandidate => vec![],
            _ => vec![ONE.into(), TWO.into()],
        };
        let attempt = eligible(candidates, Resolution::ParkedUnresolved { reason });
        attempt.validate().expect("both are legitimate parks");
        assert_eq!(attempt.outcome_str(), "unresolved");
    }
}

#[test]
fn disagreeing_with_a_prior_attachment_parks_and_names_what_it_disagreed_with() {
    // Never an automatic replacement: the prior attachment and the event
    // that made it are both pinned, because the correction that follows is
    // HIGH-risk and reaches a person who needs to see both sides.
    let attempt = eligible(
        vec![ONE.into()],
        Resolution::ParkedConflict {
            chosen_entity_id: ONE.into(),
            prior_entity_id: TWO.into(),
            prior_resolution_event_id: EVENT.into(),
        },
    );
    attempt.validate().expect("a well-formed conflict");
    assert_eq!(attempt.outcome_str(), "conflicting_attachment");
    if let Attempt::Eligible { resolution, .. } = &attempt {
        assert_eq!(resolution.attachment_state(), "parked");
        assert_eq!(
            resolution.reason_codes(),
            vec![ReasonCode::ConflictingAttachment]
        );
    }
}

#[test]
fn an_ineligible_attempt_reaches_no_outcome_to_borrow() {
    // "Already attached" is not a resolution and must not read as one; a
    // build that reported it as `exact_id` would inflate its own hit rate.
    let attempt = Attempt::Ineligible {
        reason: Ineligible::AlreadyAttached,
    };
    attempt
        .validate()
        .expect("a well-formed ineligible attempt");
    assert_eq!(attempt.outcome_str(), "ineligible");
}

#[test]
fn a_compound_mention_blocks_on_granularity_rather_than_choosing_one_target() {
    // Two independently attachable targets in one assertion: persisting one
    // would conflate them. It parks, and the reason says which failure it is.
    let attempt = Attempt::Eligible {
        normalized_mention_hashes: vec!["a".repeat(64), "b".repeat(64)],
        target_count: 2,
        candidate_entity_ids: vec![],
        resolution: Resolution::ParkedGranularity,
    };
    attempt.validate().expect("a well-formed granularity block");
    assert_eq!(attempt.outcome_str(), "claim_granularity_blocked");
    if let Attempt::Eligible { resolution, .. } = &attempt {
        assert_eq!(
            resolution.reason_codes(),
            vec![ReasonCode::CompoundAssertionTargets]
        );
    }
}
