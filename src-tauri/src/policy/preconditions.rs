//! The state-dependent predicates (M24.5) — expected-version CAS and the
//! pre-append re-resolution pass.
//!
//! **Approval is authorization, not a snapshot of the world.** A human who
//! approves a queued card is saying "yes, do that"; they are not freezing
//! the vault until they get around to clicking. So every predicate here runs
//! TWICE — once when the set is decided and again immediately before the
//! batch appends — and a set whose ground moved in between is rejected with
//! a code, not silently applied against a world nobody looked at.
//!
//! What that catches is exactly what target-id CAS alone cannot see: the
//! duplicate created while the card sat in the queue, and the evidence that
//! stopped resolving. Refreshing the immutable proposal in place would be
//! the tempting fix and the wrong one — the record would then say a human
//! approved something they never read.
//!
//! **Which predicates run is data.** The op's `requires` list in
//! `policy.v1.json` names them and fixes their precedence; this module
//! dispatches on those names. A predicate the table requires and nothing
//! evaluates would be a rule that looks like protection, so `PREDICATE_OWNERS`
//! names every one and the phase that implements it, and a tripwire proves
//! the two lists are the same set.

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{ProposalOp, ProposalV1, TypedValue};

use super::table::PolicyTable;

/// A precondition that no longer holds.
///
/// Boxed at every `Result` boundary: the failure carries two `TypedValue`s
/// so a card can say what it expected and what it found, which makes it far
/// larger than the `Ok` case that dominates every call.
pub type PreconditionResult = Result<(), Box<PreconditionFailure>>;

#[derive(Debug, Clone, PartialEq)]
pub struct PreconditionFailure {
    /// A `rejection_destinies` key.
    pub code: &'static str,
    /// The predicate that refused — a `predicates` entry, so the card can
    /// name the rule and not just the symptom.
    pub rule: &'static str,
    pub expected: TypedValue,
    pub actual: TypedValue,
}

/// Every predicate the table can require, and what evaluates it.
///
/// `None` means "declared, not yet evaluated" WITH the phase that owns it.
/// The point is that a gap is visible in one list rather than inferred from
/// the absence of a branch.
pub const PREDICATE_OWNERS: &[(&str, Option<&str>)] = &[
    ("absence_coverage_complete", None), // M24.8
    ("actor_matches_run", Some("M24.5")),
    ("alias_unbound", Some("M24.4")), // expand: alias_collision
    ("basis_refs_valid", Some("M24.5")),
    ("candidate_receipt_current", Some("M24.7")), // §15: mint, authorship, staleness
    ("conflict_capability_available", Some("M24.1")), // the table's capability stage
    ("exact_equivalence_proven", Some("M24.3")),  // EquivalenceReceipt::validate
    ("high_stakes_route_satisfied", None),        // M24.8
    ("independence_confirmable", Some("M24.4")),  // expand: server-bound proof
    ("open_contradictions_addressed", None),      // M27 (contradiction edges)
    ("qualification_roles_present", Some("M24.6")),
    ("revert_current_and_invertible", Some("M24.4")), // expand: revert_not_*
    ("silence_transition_allowed", Some("M24.1")),    // the table's silence stage
    ("subject_correction_current", Some("M24.4")),    // expand: subject_resolution_*
    ("target_set_exact", Some("M24.1")),              // the table's target-class stage
    ("trusted_observation_provenance", Some("M24.3")), // AgentObservationDraft
    ("versions_current", Some("M24.5")),
];

fn version_token(class: &str, id: &str, version: Option<u64>) -> TypedValue {
    match version {
        Some(version) => TypedValue::string(&format!("{class}/{id}@{version}")),
        None => TypedValue::string(&format!("{class}/{id}@absent")),
    }
}

/// Expected-version CAS over M22's `state_versions`.
///
/// A ledger-entity concept, never a file concept: `expected_version` is null
/// ONLY for something this proposal creates, and a null against a target that
/// already exists is a blind write wearing a compare-and-swap's clothes.
pub fn versions_current(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    for target in &proposal.targets {
        let class = target.target_class.as_str();
        let actual = state.version(class, &target.target_id);
        let agrees = match (target.expected_version, actual) {
            (Some(expected), Some(actual)) => expected == actual,
            // A creation: the target must not exist yet.
            (None, None) => true,
            _ => false,
        };
        if !agrees {
            return Err(Box::new(PreconditionFailure {
                code: "stale_target_version",
                rule: "versions_current",
                expected: version_token(class, &target.target_id, target.expected_version),
                actual: version_token(class, &target.target_id, actual),
            }));
        }
    }
    Ok(())
}

/// Every evidence and authority reference still resolves.
///
/// Evidence refs name committed Observations; authority refs are a subset of
/// them (the schema proves that inclusion). A pinned authority ROUTE must
/// still be readable by this build — a proposal that pinned an artifact no
/// build can load names a rule nothing can evaluate.
fn basis_refs_valid(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    for reference in &proposal.basis.evidence_refs {
        if !state.observations.contains_key(reference) {
            return Err(Box::new(PreconditionFailure {
                code: "invalid_reference",
                rule: "basis_refs_valid",
                expected: TypedValue::string("a committed observation"),
                actual: TypedValue::string(reference),
            }));
        }
    }
    let artifacts = super::authority::resolvable().map_err(|detail| PreconditionFailure {
        code: "invalid_reference",
        rule: "basis_refs_valid",
        expected: TypedValue::string("a loadable authority artifact"),
        actual: TypedValue::string(&detail),
    })?;
    for reference in &proposal.basis.authority_route_refs {
        if super::authority::AuthorityRoutesV1::resolve(&artifacts, reference).is_none() {
            return Err(Box::new(PreconditionFailure {
                code: "invalid_reference",
                rule: "basis_refs_valid",
                expected: TypedValue::string("a resolvable pinned authority route"),
                actual: TypedValue::string(&format!(
                    "{}@{}/{}",
                    reference.authority_route_id,
                    reference.authority_rule_version,
                    reference.artifact_hash
                )),
            }));
        }
    }
    Ok(())
}

/// §15 in one predicate: the candidate search, repeated at the CURRENT head
/// (M24.7).
///
/// A create is the one mutation with no target to compare against, so its
/// protection is a RECEIPT — proof the server looked for what already exists
/// before agreeing this is new. Four things can be wrong with one, and each
/// has its own code because they mean different things to whoever reads the
/// card:
///
/// - **missing** — created without looking. Ledger, not schema: "the agent
///   did not search" is exactly the epistemic history this milestone exists
///   to keep, and refusing it as a malformed argument would file it in the
///   operational log with the typos.
/// - **caller-authored** — the receipt asserts a search this server would
///   not produce. A caller cannot be prevented from writing JSON; what it
///   cannot do is make that JSON survive being recomputed here.
/// - **stale** — the world moved. Something now exists that the search never
///   saw, which is the window target-id CAS cannot see: a duplicate created
///   while the card sat in the queue.
/// - **unconsidered** — the search surfaced a candidate and the proposal
///   never says what it decided about it. Worse than no search: it looks
///   like diligence.
///
/// The immutable proposal is never silently refreshed — a re-minted receipt
/// under the old id would make the record say a human approved a search they
/// never saw.
fn candidate_receipt_current(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    let ProposalOp::CreateBelief { subject, .. } = &proposal.op else {
        return Ok(());
    };
    let refuse = |code: &'static str, expected: TypedValue, actual: TypedValue| {
        Box::new(PreconditionFailure {
            code,
            rule: "candidate_receipt_current",
            expected,
            actual,
        })
    };

    let Some(receipt) = &proposal.candidate_search_receipt else {
        return Err(refuse(
            "candidate_receipt_missing",
            TypedValue::string("a server-minted candidate search"),
            TypedValue::Missing,
        ));
    };
    let subject_id = match subject {
        crate::ledger::schema::SubjectRef::Resolved { entity_id, .. } => entity_id.clone(),
        // An unresolved subject cannot be searched for; the op's own
        // validation already refuses one on a create.
        _ => return Ok(()),
    };

    // AUTHORSHIP. The id is a digest of the legs, so recomputing it says
    // whether these legs and this id were ever minted together.
    let derived = super::candidates::derive_receipt_id(receipt).map_err(|detail| {
        refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string("a receipt this build can digest"),
            TypedValue::string(&detail),
        )
    })?;
    if derived != receipt.receipt_id {
        return Err(refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string(&derived),
            TypedValue::string(&receipt.receipt_id),
        ));
    }
    if receipt.search_version != super::candidates::SEARCH_VERSION {
        // A receipt from a search this build no longer runs is not a search
        // this build can vouch for.
        return Err(refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string(&super::candidates::SEARCH_VERSION.to_string()),
            TypedValue::string(&receipt.search_version.to_string()),
        ));
    }

    // The same search, run again, here.
    let fresh = super::candidates::mint(
        state,
        &receipt.index_head,
        &subject_id,
        &receipt.exact.query,
        &receipt.aliases.queries,
    )
    .map_err(|detail| {
        refuse(
            "candidate_receipt_stale",
            TypedValue::string("a repeatable search"),
            TypedValue::string(&detail),
        )
    })?;
    // A subject the receipt did not search under is a different search
    // wearing this one's clothes.
    if receipt.scoped.subject_id != subject_id {
        return Err(refuse(
            "candidate_receipt_caller_authored",
            TypedValue::string(&subject_id),
            TypedValue::string(&receipt.scoped.subject_id),
        ));
    }
    // A candidate the receipt claims and the index does not hold was never
    // returned by any search this server ran.
    let live: std::collections::BTreeSet<&str> = fresh.returned_candidates().into_iter().collect();
    for claimed in receipt.returned_candidates() {
        if !live.contains(claimed) {
            return Err(refuse(
                "candidate_receipt_caller_authored",
                TypedValue::string("a candidate the index returns"),
                TypedValue::string(claimed),
            ));
        }
    }

    let considered: std::collections::BTreeSet<&str> = receipt
        .considered
        .iter()
        .map(|c| c.candidate_id.as_str())
        .collect();
    let claimed: std::collections::BTreeSet<&str> =
        receipt.returned_candidates().into_iter().collect();
    for candidate in fresh.returned_candidates() {
        if !claimed.contains(candidate) {
            // The world moved: this exists now and the search never saw it.
            return Err(refuse(
                "candidate_receipt_stale",
                TypedValue::string("no candidate the search did not return"),
                TypedValue::string(candidate),
            ));
        }
        if !considered.contains(candidate) {
            // The search saw it and the proposal says nothing about it.
            return Err(refuse(
                "candidate_unconsidered",
                TypedValue::string("a disposition for every candidate"),
                TypedValue::string(candidate),
            ));
        }
    }
    Ok(())
}

/// Every member of a commit set was submitted by the same actor.
///
/// A run has one actor; a set that mixed two would let one producer commit
/// another's work under a set id neither agreed to. Operational destiny —
/// it is a plumbing mistake, not a claim about the world.
pub fn actor_matches_run(actors: &[String]) -> PreconditionResult {
    let Some(first) = actors.first() else {
        return Ok(());
    };
    match actors.iter().find(|actor| *actor != first) {
        Some(other) => Err(Box::new(PreconditionFailure {
            code: "run_actor_mismatch",
            rule: "actor_matches_run",
            expected: TypedValue::string(first),
            actual: TypedValue::string(other),
        })),
        None => Ok(()),
    }
}

/// Run every predicate the op's table row requires, in the order the table
/// lists them — so precedence between preconditions is the artifact's, not
/// whichever branch happens to come first here.
pub fn check(
    table: &PolicyTable,
    state: &EpistemicState,
    catalog: &super::qualification::Catalog,
    proposal: &ProposalV1,
) -> PreconditionResult {
    let Some(rule) = table.op(proposal.op.kind()) else {
        return Ok(()); // the tripwire already proves this cannot happen
    };
    for predicate in &rule.requires {
        match predicate.as_str() {
            "versions_current" => versions_current(state, proposal)?,
            "basis_refs_valid" => basis_refs_valid(state, proposal)?,
            "candidate_receipt_current" => candidate_receipt_current(state, proposal)?,
            "qualification_roles_present" => {
                super::qualification::roles_present(catalog, state, proposal)?
            }
            // Everything else is evaluated elsewhere or owned by a later
            // phase; `PREDICATE_OWNERS` is where that is written down.
            _ => {}
        }
    }
    Ok(())
}

/// Prepare a fresh proposal from a stale one: the same intent, re-pinned to
/// what is true now.
///
/// This is the server half of "offer preparation of an updated proposal". It
/// is a NEW proposal with a new id — never an edit of the immutable one,
/// because a refreshed proposal under the old id would make the approval
/// record a lie.
pub fn prepare_updated(state: &EpistemicState, stale: &ProposalV1) -> ProposalV1 {
    let mut updated = stale.clone();
    updated.proposal_id = crate::ledger::schema::sha256_first128(
        format!(
            "cerebro-prepared-updated-v1\0{}\0{}",
            stale.proposal_id,
            state.versions.len()
        )
        .as_bytes(),
    );
    for target in &mut updated.targets {
        target.expected_version = state.version(target.target_class.as_str(), &target.target_id);
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::TargetClass;
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::Risk;

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    fn op() -> ProposalOp {
        ProposalOp::UpdateBelief {
            belief_id: A.into(),
            patch: vec![],
            basis: crate::ledger::schema::BeliefBasis::Unsupported {
                reason: "fixture".into(),
            },
        }
    }

    fn with_targets(targets: Vec<crate::ledger::schema::ProposalTarget>) -> ProposalV1 {
        proposal(A, B, op(), targets, Risk::Medium)
    }

    /// A world where `belief/A` sits at the given version.
    fn at_version(version: Option<u64>) -> EpistemicState {
        let mut state = EpistemicState::default();
        if let Some(version) = version {
            state
                .versions
                .insert(("belief".into(), A.into()), (version, B.into()));
        }
        state
    }

    #[test]
    fn a_matching_version_passes_and_a_moved_one_does_not() {
        let proposal = with_targets(vec![target(TargetClass::Belief, A, Some(3))]);
        assert!(versions_current(&at_version(Some(3)), &proposal).is_ok());
        let failure = versions_current(&at_version(Some(4)), &proposal).unwrap_err();
        assert_eq!(failure.code, "stale_target_version");
        assert_eq!(failure.rule, "versions_current");
        // The card stays inspectable: it says what it expected and what it
        // found, in the same breath.
        assert_eq!(
            failure.expected,
            TypedValue::string(&format!("belief/{A}@3"))
        );
        assert_eq!(failure.actual, TypedValue::string(&format!("belief/{A}@4")));
    }

    #[test]
    fn a_null_expected_version_means_creation_and_nothing_else() {
        // A null against something that already exists is a blind write
        // wearing a compare-and-swap's clothes.
        let creating = with_targets(vec![target(TargetClass::Belief, A, None)]);
        assert!(versions_current(&at_version(None), &creating).is_ok());
        assert_eq!(
            versions_current(&at_version(Some(1)), &creating)
                .unwrap_err()
                .code,
            "stale_target_version"
        );
        // ...and a version against something that does not exist is equally
        // a claim about a world that is not there.
        let updating = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        assert_eq!(
            versions_current(&at_version(None), &updating)
                .unwrap_err()
                .code,
            "stale_target_version"
        );
    }

    #[test]
    fn one_stale_target_refuses_the_whole_proposal() {
        // Never a partial apply: the mismatch is on the second target and
        // the first one's agreement does not rescue it.
        let mut state = at_version(Some(1));
        state
            .versions
            .insert(("entity".into(), B.into()), (9, B.into()));
        let proposal = with_targets(vec![
            target(TargetClass::Belief, A, Some(1)),
            target(TargetClass::Entity, B, Some(2)),
        ]);
        let failure = versions_current(&state, &proposal).unwrap_err();
        assert_eq!(failure.actual, TypedValue::string(&format!("entity/{B}@9")));
    }

    #[test]
    fn evidence_that_stopped_resolving_is_an_invalid_reference() {
        let mut proposal = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        proposal.basis.evidence_refs = vec![B.to_string()];
        let failure = basis_refs_valid(&at_version(Some(1)), &proposal).unwrap_err();
        assert_eq!(failure.code, "invalid_reference");
        assert_eq!(failure.rule, "basis_refs_valid");
    }

    #[test]
    fn a_pinned_route_no_build_can_read_names_a_rule_nothing_can_evaluate() {
        let mut proposal = with_targets(vec![target(TargetClass::Belief, A, Some(1))]);
        proposal.basis.authority_route_refs = vec![crate::ledger::schema::AuthorityRouteRef {
            authority_route_id: "shipping_soc".into(),
            authority_rule_version: 1,
            artifact_hash: "0".repeat(64),
        }];
        assert_eq!(
            basis_refs_valid(&at_version(Some(1)), &proposal)
                .unwrap_err()
                .code,
            "invalid_reference"
        );
    }

    #[test]
    fn a_run_has_one_actor() {
        assert!(actor_matches_run(&["agent:a".into(), "agent:a".into()]).is_ok());
        let failure = actor_matches_run(&["agent:a".into(), "agent:b".into()]).unwrap_err();
        assert_eq!(failure.code, "run_actor_mismatch");
        // Operational: a plumbing mistake, not a claim about the world.
        let table = PolicyTable::load().unwrap();
        assert_eq!(
            table.destiny(failure.code),
            Some(super::super::table::Destiny::Operational)
        );
    }

    #[test]
    fn preparing_an_updated_proposal_re_pins_versions_under_a_new_id() {
        // Never an edit of the immutable one: a refreshed proposal under the
        // old id would make the approval record a lie.
        let stale = with_targets(vec![target(TargetClass::Belief, A, Some(3))]);
        let updated = prepare_updated(&at_version(Some(7)), &stale);
        assert_ne!(updated.proposal_id, stale.proposal_id);
        assert_eq!(updated.targets[0].expected_version, Some(7));
        assert_eq!(updated.op, stale.op, "the intent is unchanged");
        assert!(versions_current(&at_version(Some(7)), &updated).is_ok());
    }

    // --- §15: the create receipt (M24.7) --------------------------------

    /// A world holding one Belief about `B`, projected at `churn.md`.
    fn base_with_a_belief() -> EpistemicState {
        use crate::ledger::reduce::{BeliefState, RevisionState};
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            A.to_string(),
            BeliefState {
                belief_id: A.into(),
                entity_id: B.into(),
                created_event_id: B.into(),
                revisions: vec![RevisionState {
                    event_id: B.into(),
                    revision: 1,
                    content: String::new(),
                    fields: serde_json::json!({}),
                    basis: crate::ledger::schema::BeliefBasis::Unsupported {
                        reason: "fixture".into(),
                    },
                }],
                attested: None,
                attestation_events: vec![],
                path: None,
                overrides: vec![],
                override_head_event: None,
                projection_head_event: B.into(),
                qualification: crate::ledger::schema::Qualification::Draft,
                lifecycle: crate::ledger::schema::Lifecycle::Active,
                tombstoned_by: None,
                open_contest_event: None,
                qualification_head_event: None,
                lifecycle_head_event: None,
                contest_head_event: None,
                entity_merge_event_ids: vec![],
            },
        );
        state
            .projection_paths
            .insert("churn.md".to_string(), A.to_string());
        state
    }

    const NEW_BELIEF: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

    fn creation(receipt: Option<crate::ledger::schema::CandidateSearchReceipt>) -> ProposalV1 {
        let mut p = proposal(
            A,
            B,
            ProposalOp::CreateBelief {
                belief_id: NEW_BELIEF.into(),
                subject: crate::ledger::schema::SubjectRef::Resolved {
                    entity_id: B.into(),
                    aliases: vec!["churn.md".into()],
                },
                content: "# Churn\n".into(),
                fields: serde_json::json!({}),
                basis: crate::ledger::schema::BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
                distinctness_reason: "nothing matched".into(),
            },
            vec![target(TargetClass::Belief, NEW_BELIEF, None)],
            Risk::Low,
        );
        p.candidate_search_receipt = receipt;
        p
    }

    fn minted(state: &EpistemicState) -> crate::ledger::schema::CandidateSearchReceipt {
        super::super::candidates::mint(
            state,
            super::super::candidates::EMPTY_INDEX_HEAD,
            B,
            "churn.md",
            &["churn.md".to_string()],
        )
        .unwrap()
    }

    #[test]
    fn a_search_this_server_ran_and_nothing_moved_passes() {
        let empty = EpistemicState::default();
        assert!(candidate_receipt_current(&empty, &creation(Some(minted(&empty)))).is_ok());
    }

    #[test]
    fn creating_without_looking_is_a_ledger_refusal_not_a_schema_error() {
        // The whole reason this check is here and not in the schema layer:
        // "the agent created without searching" is epistemic history. Filing
        // it as `schema_invalid` would put it in the operational log with
        // the typos.
        let failure =
            candidate_receipt_current(&EpistemicState::default(), &creation(None)).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_missing");
        assert_eq!(failure.rule, "candidate_receipt_current");
        let table = PolicyTable::load().unwrap();
        assert_eq!(
            table.destiny(failure.code),
            Some(super::super::table::Destiny::Ledger)
        );
    }

    #[test]
    fn a_receipt_whose_id_does_not_match_its_legs_was_not_minted_here() {
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.receipt_id = "f".repeat(32);
        assert_eq!(
            candidate_receipt_current(&empty, &creation(Some(receipt)))
                .unwrap_err()
                .code,
            "candidate_receipt_caller_authored"
        );
    }

    #[test]
    fn a_receipt_claiming_a_candidate_the_index_never_returned_is_forged() {
        // A caller cannot be stopped from writing JSON. What it cannot do is
        // make that JSON survive the search being run again here.
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.exact.candidate_ids = vec![A.to_string()];
        receipt.considered = vec![crate::ledger::schema::ConsideredCandidate {
            candidate_id: A.to_string(),
            decision: crate::ledger::schema::CandidateDecision::Distinct,
            reason: "invented".into(),
        }];
        receipt.receipt_id = super::super::candidates::derive_receipt_id(&receipt).unwrap();
        let failure = candidate_receipt_current(&empty, &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_caller_authored");
        assert_eq!(failure.actual, TypedValue::string(A));
    }

    #[test]
    fn a_receipt_from_a_search_this_build_no_longer_runs_is_refused() {
        let empty = EpistemicState::default();
        let mut receipt = minted(&empty);
        receipt.search_version = super::super::candidates::SEARCH_VERSION + 1;
        receipt.receipt_id = super::super::candidates::derive_receipt_id(&receipt).unwrap();
        assert_eq!(
            candidate_receipt_current(&empty, &creation(Some(receipt)))
                .unwrap_err()
                .code,
            "candidate_receipt_caller_authored"
        );
    }

    #[test]
    fn a_duplicate_that_appeared_after_the_search_makes_the_receipt_stale() {
        // The window target-id CAS cannot see: while the card waited,
        // something else created the very thing it calls new.
        let receipt = minted(&EpistemicState::default());
        let failure =
            candidate_receipt_current(&base_with_a_belief(), &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_receipt_stale");
        assert_eq!(failure.actual, TypedValue::string(A));
    }

    #[test]
    fn a_candidate_the_search_returned_and_the_proposal_ignored_is_unconsidered() {
        // Reachable ONLY because the receipt id digests the legs and not the
        // dispositions: stripping the judgement leaves the search intact, so
        // this is not forgery — it is a search that surfaced a duplicate and
        // then said nothing about it, which looks like diligence.
        let state = base_with_a_belief();
        let mut receipt = minted(&state);
        assert_eq!(receipt.returned_candidates(), vec![A]);
        receipt.considered.clear();
        let failure = candidate_receipt_current(&state, &creation(Some(receipt))).unwrap_err();
        assert_eq!(failure.code, "candidate_unconsidered");
        assert_eq!(failure.actual, TypedValue::string(A));
    }

    #[test]
    fn a_proposer_may_disagree_with_the_servers_default_disposition() {
        // Similarity alone never forces a merge. The server says "this
        // exists, revise it"; a proposer may say "distinct, and here is why"
        // and the ledger holds them to it.
        let state = base_with_a_belief();
        let mut receipt = minted(&state);
        receipt.considered[0].decision = crate::ledger::schema::CandidateDecision::Distinct;
        receipt.considered[0].reason = "a different reporting scope".into();
        assert!(candidate_receipt_current(&state, &creation(Some(receipt))).is_ok());
    }

    #[test]
    fn every_code_this_predicate_names_is_one_create_belief_declares() {
        let table = PolicyTable::load().unwrap();
        let rule = table.op("create_belief").unwrap();
        for code in [
            "candidate_receipt_missing",
            "candidate_receipt_caller_authored",
            "candidate_receipt_stale",
            "candidate_unconsidered",
        ] {
            assert!(
                rule.possible_rejections.iter().any(|r| r == code),
                "{code} is refused by §15 and not declared by create_belief"
            );
        }
    }

    #[test]
    fn every_predicate_the_table_requires_is_named_by_an_owner() {
        // THE GAP TRIPWIRE. A predicate the table requires and nothing
        // evaluates is a rule that looks like protection. This does not
        // demand that all of them be implemented — it demands that every gap
        // be WRITTEN DOWN with the phase that closes it.
        let table = PolicyTable::load().unwrap();
        let declared: std::collections::BTreeSet<&str> =
            table.predicates.iter().map(String::as_str).collect();
        let owned: std::collections::BTreeSet<&str> =
            PREDICATE_OWNERS.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            declared, owned,
            "policy.v1.json's predicates and PREDICATE_OWNERS disagree"
        );
        // Every predicate any op requires must be in the registry too.
        for rule in table.ops.values() {
            for predicate in &rule.requires {
                assert!(
                    owned.contains(predicate.as_str()),
                    "{predicate} is required by an op and has no owner"
                );
            }
        }
    }

    #[test]
    fn the_owner_list_is_sorted_and_unique() {
        let names: Vec<&str> = PREDICATE_OWNERS.iter().map(|(name, _)| *name).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, names);
    }
}
