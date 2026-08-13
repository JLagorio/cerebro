//! The corroboration-only window (M26.9b).
//!
//! §17's rule, as a fixture aimed at one specific wrong implementation: a
//! build that treats ANY second source as corroboration. That build passes
//! every obvious test — two sources really did say the same thing — and is
//! wrong in the way that matters, because `independence_unknown` never
//! strengthens anything. Corroboration is a PROVEN property, and the proof is
//! a committed `observation.independence_recorded` record.
//!
//! Two sources with one registration behind them are one origin. Two sources
//! where one derives from the other are one witness. Neither earns a proof,
//! and the honest outcome for both is that nothing is emitted at all — there
//! is no "weak corroboration" variant to fall back to, by construction.

use crate::ingest::independence::{proof_for, rules, Endpoint};
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{AssertionBasis, AuthorityCapability, AuthorityProvenance};

const REG_A: &str = "60000000000000000000000000000001";
const REG_B: &str = "60000000000000000000000000000002";
const OBS_A: &str = "20000000000000000000000000000001";
const OBS_B: &str = "20000000000000000000000000000002";

/// A firsthand human assertion under its own registration.
fn human(observation: &str, registration: &str, actor: &str) -> Endpoint {
    Endpoint {
        observation_event_id: observation.into(),
        source_registration_event_id: registration.into(),
        authority: Some(AuthorityProvenance::TrustedHumanCapture),
        assertion_basis: Some(AssertionBasis::Firsthand),
        registration_kind: "human_actor",
        capability: AuthorityCapability::HumanAssertion,
        bound_actor_id: Some(actor.into()),
        independence_domain_id: None,
        source_artifact_hash: None,
    }
}

#[test]
fn two_distinct_firsthand_origins_earn_a_proof() {
    // The positive control. Without it, every assertion below could be
    // explained by "the predicate never fires".
    let rules = rules().expect("the shipped rules");
    let state = EpistemicState::default();
    let proof = proof_for(
        &rules,
        &state,
        &human(OBS_A, REG_A, "human:ana"),
        &human(OBS_B, REG_B, "human:bo"),
    );
    assert!(
        proof.is_some(),
        "two people who each saw it themselves, under two registrations, corroborate"
    );
}

#[test]
fn a_second_source_is_not_corroboration_on_its_own() {
    // THE fixture. A build that counted sources would pass everything else
    // and fail here: these are two different observations, two different
    // actors, and one registration behind both — one origin wearing two
    // hats. §17: independence_unknown never strengthens.
    let rules = rules().expect("the shipped rules");
    let state = EpistemicState::default();
    let proof = proof_for(
        &rules,
        &state,
        &human(OBS_A, REG_A, "human:ana"),
        &human(OBS_B, REG_A, "human:bo"),
    );
    assert!(
        proof.is_none(),
        "two assertions under one registration are one origin, whatever else differs"
    );
}

#[test]
fn the_same_observation_twice_is_not_two_witnesses() {
    let rules = rules().expect("the shipped rules");
    let state = EpistemicState::default();
    assert!(proof_for(
        &rules,
        &state,
        &human(OBS_A, REG_A, "human:ana"),
        &human(OBS_A, REG_B, "human:ana"),
    )
    .is_none());
}

#[test]
fn a_failed_condition_emits_nothing_rather_than_something_weaker() {
    // There is no "weak" outcome to fall back to, and that absence is the
    // design: a build that emitted a downgraded proof would let a caller
    // that only checked for presence treat it as corroboration.
    let rules = rules().expect("the shipped rules");
    let state = EpistemicState::default();
    let mut inferred = human(OBS_B, REG_B, "human:bo");
    inferred.authority = Some(AuthorityProvenance::AgentInferred);
    inferred.assertion_basis = Some(AssertionBasis::Inferred);
    assert_eq!(
        proof_for(&rules, &state, &human(OBS_A, REG_A, "human:ana"), &inferred),
        None,
        "an inferred assertion is not a witness, and there is nothing weaker to return"
    );
}

#[test]
fn the_pair_is_unordered_and_mints_the_same_proof_either_way() {
    // Two callers who saw the same pair in opposite orders must produce the
    // same event, or the same corroboration gets recorded twice and a
    // count-based reader doubles it.
    let rules = rules().expect("the shipped rules");
    let state = EpistemicState::default();
    let left = human(OBS_A, REG_A, "human:ana");
    let right = human(OBS_B, REG_B, "human:bo");
    assert_eq!(
        proof_for(&rules, &state, &left, &right),
        proof_for(&rules, &state, &right, &left)
    );
}
