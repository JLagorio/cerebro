//! The high-stakes stopping rule and the absence/coverage rules (M24.8).
//!
//! Both are class-(a) invariants and both read TYPED fields and referenced
//! records only. `reason` prose has no effect here and never will: a rule
//! that grepped a sentence for "no evidence" would be defeated by
//! rephrasing, which is the one thing a language model is guaranteed to be
//! good at.
//!
//! **There is no queue-or-reject implementation choice.** The table fixes
//! which outcome each shape gets: a structurally valid proposal whose
//! coverage or authority is absent or insufficient QUEUES with
//! `high_stakes.queue_rejection`; a malformed reference REJECTS with
//! `malformed_rejection`; one that resolved and then moved REJECTS with
//! `stale_rejection`. Reading those three from the artifact is what stops
//! the distinction from drifting into whichever branch an engine wrote
//! first.
//!
//! **What M24 can actually verify.** Route criteria are matched over the
//! dimensions the reducer exposes today — observation kind, authority
//! capability, assertion basis, and the source's registration kind. A
//! criterion that also demands a relationship ROLE cannot be settled from
//! reducer state until M25 registers sources with their roles, so it does
//! not match, and the proposal queues for a human. That direction is the
//! only safe one: an unverifiable route that counted as verified would make
//! the whole rule decorative.

use std::collections::BTreeSet;

use crate::ledger::reduce::CoverageAssessment;
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{AbsenceRecord, ProposalOp, ProposalV1, SubjectRef, TypedValue};

use super::authority::AuthorityRoute;
use super::preconditions::PreconditionFailure;
use super::table::PolicyTable;

impl CoverageAssessment {
    /// Field lookup BY THE TABLE'S NAME, so adding a fifth match field is a
    /// table edit rather than a new branch in two comparison functions.
    ///
    /// M25.4 moved these four strings onto the RETRIEVAL RECEIPT, where they
    /// belong: they describe a search that actually ran, and an assessment
    /// with no attempted retrieval has no search to describe. An assessment
    /// without a receipt therefore supplies none of them — which the join
    /// below reads as disagreement, not as a match, because two silences are
    /// not agreement.
    pub fn match_field(&self, name: &str) -> Option<&str> {
        let receipt = self.retrieval_receipt.as_ref()?;
        match name {
            "searched_domain" => Some(&receipt.searched_domain),
            "search_scope" => Some(&receipt.search_scope),
            "observation_window" => Some(&receipt.observation_window),
            "query_strategy" => Some(&receipt.query_strategy),
            _ => None,
        }
    }
}

/// The same lookup on the Observation's side of the join.
fn absence_field<'a>(record: &'a AbsenceRecord, name: &str) -> Option<&'a str> {
    match name {
        "searched_domain" => Some(&record.searched_domain),
        "search_scope" => Some(&record.search_scope),
        "observation_window" => Some(&record.observation_window),
        "query_strategy" => Some(&record.query_strategy),
        _ => None,
    }
}

fn failure(
    code: &'static str,
    rule: &'static str,
    expected: TypedValue,
    actual: TypedValue,
) -> Box<PreconditionFailure> {
    Box::new(PreconditionFailure {
        code,
        rule,
        expected,
        actual,
    })
}

/// `&'static str` for a code the table owns as an owned String. Only the
/// codes these two rules can name are here, and a table edit that renames
/// one fails this lookup loudly rather than silently refusing with the
/// wrong word.
fn code_of(table_code: &str) -> Result<&'static str, String> {
    match table_code {
        "absence_coverage_incomplete" => Ok("absence_coverage_incomplete"),
        "absence_coverage_mismatch" => Ok("absence_coverage_mismatch"),
        "high_stakes_verification_required" => Ok("high_stakes_verification_required"),
        "invalid_reference" => Ok("invalid_reference"),
        "policy_precondition_stale" => Ok("policy_precondition_stale"),
        other => Err(format!(
            "the table names {other:?} as an outcome of a coverage rule and this build has no \
             such code"
        )),
    }
}

// --- The high-stakes stopping rule (§52/§71) -------------------------------

/// What the stopping rule decided. `Queue` is not a soft rejection: it is
/// the table's declared outcome for "structurally valid, not yet verified",
/// and it carries the code a card shows.
#[derive(Debug, Clone, PartialEq)]
pub enum HighStakes {
    /// The stakes are below the rule's floor, or every route is satisfied.
    Cleared,
    /// Hold for a human, naming the table's `queue_rejection`.
    Queue(&'static str),
    /// A reference that is malformed, unknown, wrong-subject, or stale.
    Refuse(Box<PreconditionFailure>),
}

const HIGH_STAKES_RULE: &str = "high_stakes_route_satisfied";

/// The Entity a proposal is about, when the op names one.
fn subject_of(state: &EpistemicState, proposal: &ProposalV1) -> Option<String> {
    match &proposal.op {
        ProposalOp::CreateBelief {
            subject: SubjectRef::Resolved { entity_id, .. },
            ..
        } => Some(entity_id.clone()),
        ProposalOp::UpdateBelief { belief_id, .. }
        | ProposalOp::SupersedeBelief { belief_id, .. }
        | ProposalOp::PromoteDraft { belief_id, .. }
        | ProposalOp::ContestBelief { belief_id, .. }
        | ProposalOp::TombstoneBelief { belief_id, .. }
        | ProposalOp::ArchiveBelief { belief_id, .. }
        | ProposalOp::Deprecate { belief_id, .. }
        | ProposalOp::SplitBelief { belief_id, .. } => state
            .beliefs
            .get(belief_id)
            .map(|belief| belief.entity_id.clone()),
        _ => None,
    }
}

/// The stopping rule. HIGH/CRITICAL intended use must resolve its coverage
/// and be carried by an authority route that is live in the pinned artifact.
pub fn high_stakes(
    table: &PolicyTable,
    state: &EpistemicState,
    proposal: &ProposalV1,
) -> HighStakes {
    if !table
        .high_stakes
        .stakes
        .contains(&proposal.intended_use.stakes)
    {
        return HighStakes::Cleared;
    }
    let (malformed, stale, queue) = match (
        code_of(&table.high_stakes.malformed_rejection),
        code_of(&table.high_stakes.stale_rejection),
        code_of(&table.high_stakes.queue_rejection),
    ) {
        (Ok(m), Ok(s), Ok(q)) => (m, s, q),
        _ => {
            return HighStakes::Refuse(failure(
                "invalid_reference",
                HIGH_STAKES_RULE,
                TypedValue::string("a code this build can name"),
                TypedValue::string(&table.high_stakes.queue_rejection),
            ))
        }
    };

    // COVERAGE. Malformed first: a reference that is not an id was never
    // about anything, and calling that "unverified" would invite a retry.
    let subject = subject_of(state, proposal);
    for reference in &proposal.basis.coverage_refs {
        if !crate::ledger::schema::is_id128(reference) {
            return HighStakes::Refuse(failure(
                malformed,
                HIGH_STAKES_RULE,
                TypedValue::string("a coverage assessment id"),
                TypedValue::string(reference),
            ));
        }
        match state.coverage_assessments.get(reference) {
            None => return HighStakes::Queue(queue),
            Some(assessment) => {
                if assessment.superseded {
                    return HighStakes::Refuse(failure(
                        stale,
                        HIGH_STAKES_RULE,
                        TypedValue::string("a current coverage assessment"),
                        TypedValue::string(reference),
                    ));
                }
                if let Some(subject) = &subject {
                    // An assessment with no named subject covers nothing in
                    // particular, and coverage of a DIFFERENT subject proves
                    // nothing about this one. Both are the same refusal.
                    if assessment.subject_id.as_deref() != Some(subject.as_str()) {
                        return HighStakes::Refuse(failure(
                            malformed,
                            HIGH_STAKES_RULE,
                            TypedValue::string(subject),
                            TypedValue::string(
                                assessment.subject_id.as_deref().unwrap_or("(unscoped)"),
                            ),
                        ));
                    }
                }
            }
        }
    }
    if proposal.basis.coverage_refs.is_empty() {
        // High stakes with no coverage claim at all is the commonest shape
        // and the one the rule exists for.
        return HighStakes::Queue(queue);
    }

    // AUTHORITY. Every pinned route must still be selected by the live
    // artifact for this predicate class, every authority Observation must
    // match at least one supplied route, and every supplied route must be
    // used — an unused route is a rule the proposer displayed and did not
    // rely on.
    let Ok(artifacts) = super::authority::resolvable() else {
        return HighStakes::Refuse(failure(
            malformed,
            HIGH_STAKES_RULE,
            TypedValue::string("a loadable authority artifact"),
            TypedValue::Missing,
        ));
    };
    let mut routes: Vec<&AuthorityRoute> = Vec::new();
    for reference in &proposal.basis.authority_route_refs {
        match super::authority::AuthorityRoutesV1::resolve(&artifacts, reference) {
            None => {
                return HighStakes::Refuse(failure(
                    stale,
                    HIGH_STAKES_RULE,
                    TypedValue::string("a route the live artifact still selects"),
                    TypedValue::string(&reference.authority_route_id),
                ))
            }
            Some(route) => {
                if let Some(class) = &proposal.intended_use.predicate_class {
                    if !route.predicate_classes.contains(class) {
                        return HighStakes::Refuse(failure(
                            stale,
                            HIGH_STAKES_RULE,
                            TypedValue::string(class),
                            TypedValue::string(&route.predicate_classes.join(",")),
                        ));
                    }
                }
                routes.push(route);
            }
        }
    }
    if routes.is_empty() || proposal.basis.authority_refs.is_empty() {
        return HighStakes::Queue(queue);
    }
    let mut used: BTreeSet<&str> = BTreeSet::new();
    for reference in &proposal.basis.authority_refs {
        let matched = routes.iter().find(|route| {
            route
                .criteria
                .iter()
                .any(|criterion| super::authority::satisfies(state, reference, criterion))
        });
        match matched {
            None => return HighStakes::Queue(queue),
            Some(route) => {
                used.insert(route.authority_route_id.as_str());
            }
        }
    }
    if used.len() != routes.len() {
        return HighStakes::Queue(queue);
    }
    HighStakes::Cleared
}

// --- Absence (§53) ---------------------------------------------------------

const ABSENCE_RULE: &str = "absence_coverage_complete";

/// An absence claim must be backed by a current coverage assessment that
/// establishes every required dimension, and the Observation it rests on
/// must describe the SAME search that assessment describes.
///
/// "I looked and found nothing" is only worth anything alongside "and here
/// is what looking covered". Without the join, an absence assertion is
/// indistinguishable from not having looked.
pub fn absence_complete(
    table: &PolicyTable,
    state: &EpistemicState,
    proposal: &ProposalV1,
) -> Result<(), Box<PreconditionFailure>> {
    if !proposal.basis.absence_claim {
        return Ok(());
    }
    let incomplete = code_of(&table.absence.incomplete_rejection).map_err(|detail| {
        failure(
            "invalid_reference",
            ABSENCE_RULE,
            TypedValue::string("a code this build can name"),
            TypedValue::string(&detail),
        )
    })?;
    let mismatch = code_of(&table.absence.mismatch_rejection).map_err(|detail| {
        failure(
            "invalid_reference",
            ABSENCE_RULE,
            TypedValue::string("a code this build can name"),
            TypedValue::string(&detail),
        )
    })?;

    // The schema already refuses an absence claim with no coverage
    // reference; this resolves them.
    let mut established: BTreeSet<&str> = BTreeSet::new();
    let mut assessments = Vec::new();
    for reference in &proposal.basis.coverage_refs {
        let Some(assessment) = state.coverage_assessments.get(reference) else {
            return Err(failure(
                incomplete,
                ABSENCE_RULE,
                TypedValue::string("a current coverage assessment"),
                TypedValue::string(reference),
            ));
        };
        if assessment.superseded {
            return Err(failure(
                incomplete,
                ABSENCE_RULE,
                TypedValue::string("a current coverage assessment"),
                TypedValue::string(reference),
            ));
        }
        // M25.4: a dimension counts as established only when it says YES.
        // `unknown` and `not_applicable` are answers, and neither of them is
        // "we checked and it holds".
        for (dimension, _) in assessment.dimensions.each() {
            if assessment.establishes(dimension) {
                established.insert(dimension.as_str());
            }
        }
        assessments.push(assessment);
    }
    for dimension in &table.absence.required_coverage_dimensions {
        if !established.contains(dimension.as_str()) {
            return Err(failure(
                incomplete,
                ABSENCE_RULE,
                TypedValue::string(&table.absence.required_coverage_dimensions.join(",")),
                TypedValue::string(dimension),
            ));
        }
    }

    // THE JOIN. Every absence Observation the basis cites must describe the
    // same search some cited assessment describes. A coverage record about a
    // different window or a different query is coverage of something else.
    for reference in &proposal.basis.evidence_refs {
        let Some(record) = absence_record(state, reference) else {
            continue;
        };
        let agrees = assessments.iter().any(|assessment| {
            table.absence.receipt_match_fields.iter().all(|field| {
                match (absence_field(&record, field), assessment.match_field(field)) {
                    (Some(left), Some(right)) => left == right,
                    // A field the table names and neither side can supply is
                    // not agreement — it is two silences.
                    _ => false,
                }
            })
        });
        if !agrees {
            return Err(failure(
                mismatch,
                ABSENCE_RULE,
                TypedValue::string(&table.absence.receipt_match_fields.join(",")),
                TypedValue::string(reference),
            ));
        }
    }
    Ok(())
}

/// The structural absence record on a cited Observation, if it is one.
fn absence_record(state: &EpistemicState, event_id: &str) -> Option<AbsenceRecord> {
    state
        .observations
        .get(event_id)
        .and_then(|observation| observation.absence.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::Risk;

    const BELIEF: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const ENTITY: &str = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
    const ASSESSMENT: &str = "a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3";
    const SOURCE: &str = "50505050505050505050505050505050";

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    fn at_stakes(stakes: Risk) -> ProposalV1 {
        let mut p = proposal(
            BELIEF,
            ENTITY,
            ProposalOp::UpdateBelief {
                belief_id: BELIEF.into(),
                patch: vec![],
                basis: crate::ledger::schema::BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            },
            vec![target(
                crate::ledger::schema::TargetClass::Belief,
                BELIEF,
                Some(1),
            )],
            Risk::Medium,
        );
        p.intended_use.stakes = stakes;
        p
    }

    fn dimension_yes() -> crate::ledger::schema::DimensionAssessment {
        crate::ledger::schema::DimensionAssessment {
            state: crate::ledger::schema::DimensionState::Yes,
            basis_event_ids: vec![ASSESSMENT.into()],
            as_of: "2026-08-09T10:00:00Z".into(),
        }
    }

    fn assessment() -> CoverageAssessment {
        use crate::ledger::schema::{Dimensions, RetrievalReceipt, Scope};
        CoverageAssessment {
            assessment_id: ASSESSMENT.into(),
            subject_id: Some(ENTITY.into()),
            predicate_class: None,
            scope: Scope::empty(),
            source_id: SOURCE.into(),
            dimensions: Dimensions {
                source_connected: dimension_yes(),
                source_healthy: dimension_yes(),
                scope_known: dimension_yes(),
                scope_accessible: dimension_yes(),
                retention_known: dimension_yes(),
                index_current: dimension_yes(),
                retrieval_attempted: dimension_yes(),
            },
            retrieval_receipt: Some(RetrievalReceipt {
                strategy_version: "retrieval-v1".into(),
                query_strategy: "exact and alias".into(),
                query_fingerprint: "a".repeat(64),
                attempted_at: "2026-08-09T10:00:00Z".into(),
                searched_domain: "the vault".into(),
                search_scope: "knowledge/".into(),
                observation_window: "2026-01-01/2026-08-09".into(),
                searched_aliases: vec![],
                searched_scopes: vec![],
            }),
            superseded: false,
        }
    }

    #[test]
    fn low_stakes_never_meets_the_stopping_rule() {
        assert_eq!(
            high_stakes(&table(), &EpistemicState::default(), &at_stakes(Risk::Low)),
            HighStakes::Cleared
        );
    }

    #[test]
    fn high_stakes_with_no_coverage_claim_queues_for_a_human() {
        // The commonest shape and the one the rule exists for. Not a
        // rejection: the proposal is well-formed, it is just not verified.
        let table = table();
        assert_eq!(
            high_stakes(&table, &EpistemicState::default(), &at_stakes(Risk::High)),
            HighStakes::Queue("high_stakes_verification_required")
        );
        assert_eq!(
            high_stakes(
                &table,
                &EpistemicState::default(),
                &at_stakes(Risk::Critical)
            ),
            HighStakes::Queue("high_stakes_verification_required")
        );
    }

    #[test]
    fn a_coverage_reference_that_is_not_an_id_is_malformed_not_unverified() {
        // Calling a typo "unverified" would invite a retry against a
        // reference that was never about anything.
        let mut p = at_stakes(Risk::High);
        p.basis.coverage_refs = vec!["not-an-id".into()];
        let HighStakes::Refuse(failure) = high_stakes(&table(), &EpistemicState::default(), &p)
        else {
            panic!("expected a refusal");
        };
        assert_eq!(failure.code, "invalid_reference");
        assert_eq!(failure.rule, "high_stakes_route_satisfied");
    }

    #[test]
    fn a_coverage_reference_nothing_has_assessed_yet_queues() {
        let mut p = at_stakes(Risk::High);
        p.basis.coverage_refs = vec![ASSESSMENT.into()];
        assert_eq!(
            high_stakes(&table(), &EpistemicState::default(), &p),
            HighStakes::Queue("high_stakes_verification_required")
        );
    }

    #[test]
    fn a_superseded_assessment_is_stale_rather_than_absent() {
        let mut state = EpistemicState::default();
        let mut record = assessment();
        record.superseded = true;
        state
            .coverage_assessments
            .insert(ASSESSMENT.to_string(), record);
        let mut p = at_stakes(Risk::High);
        p.basis.coverage_refs = vec![ASSESSMENT.into()];
        let HighStakes::Refuse(failure) = high_stakes(&table(), &state, &p) else {
            panic!("expected a refusal");
        };
        assert_eq!(failure.code, "policy_precondition_stale");
    }

    #[test]
    fn coverage_of_another_subject_proves_nothing_about_this_one() {
        let mut state = EpistemicState::default();
        let mut record = assessment();
        record.subject_id = Some("f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4".into());
        state
            .coverage_assessments
            .insert(ASSESSMENT.to_string(), record);
        state.beliefs.insert(BELIEF.to_string(), belief());
        let mut p = at_stakes(Risk::High);
        p.basis.coverage_refs = vec![ASSESSMENT.into()];
        let HighStakes::Refuse(failure) = high_stakes(&table(), &state, &p) else {
            panic!("expected a refusal");
        };
        assert_eq!(failure.code, "invalid_reference");
    }

    fn belief() -> crate::ledger::reduce::BeliefState {
        crate::ledger::reduce::BeliefState {
            belief_id: BELIEF.into(),
            entity_id: ENTITY.into(),
            created_event_id: ENTITY.into(),
            revisions: vec![crate::ledger::reduce::RevisionState {
                event_id: ENTITY.into(),
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
            projection_head_event: ENTITY.into(),
            qualification: crate::ledger::schema::Qualification::Draft,
            lifecycle: crate::ledger::schema::Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        }
    }

    #[test]
    fn a_proposal_making_no_absence_claim_is_not_asked_about_coverage() {
        assert!(
            absence_complete(&table(), &EpistemicState::default(), &at_stakes(Risk::Low)).is_ok()
        );
    }

    #[test]
    fn an_absence_claim_with_nothing_assessed_is_incomplete() {
        // Until M25 emits assessments this is every absence claim — and
        // fail-closed is the only safe direction: "I looked and found
        // nothing" without "and here is what looking covered" is
        // indistinguishable from not having looked.
        let mut p = at_stakes(Risk::Low);
        p.basis.absence_claim = true;
        p.basis.coverage_refs = vec![ASSESSMENT.into()];
        let failure = absence_complete(&table(), &EpistemicState::default(), &p).unwrap_err();
        assert_eq!(failure.code, "absence_coverage_incomplete");
        assert_eq!(failure.rule, "absence_coverage_complete");
    }

    #[test]
    fn an_assessment_missing_one_dimension_names_the_one_it_is_missing() {
        let table = table();
        // "Missing" now means a dimension that does not say YES — M25.4's
        // shape has all seven always present, and `unknown` is an ANSWER
        // rather than an absence. Either way the rule names the one that
        // failed.
        let missing = table.absence.required_coverage_dimensions[0].clone();
        let mut record = assessment();
        let dimension = crate::ledger::schema::Dimension::parse(&missing).expect("a real name");
        let slot = match dimension {
            crate::ledger::schema::Dimension::SourceConnected => {
                &mut record.dimensions.source_connected
            }
            crate::ledger::schema::Dimension::SourceHealthy => {
                &mut record.dimensions.source_healthy
            }
            crate::ledger::schema::Dimension::ScopeKnown => &mut record.dimensions.scope_known,
            crate::ledger::schema::Dimension::ScopeAccessible => {
                &mut record.dimensions.scope_accessible
            }
            crate::ledger::schema::Dimension::RetentionKnown => {
                &mut record.dimensions.retention_known
            }
            crate::ledger::schema::Dimension::IndexCurrent => &mut record.dimensions.index_current,
            crate::ledger::schema::Dimension::RetrievalAttempted => {
                &mut record.dimensions.retrieval_attempted
            }
        };
        slot.state = crate::ledger::schema::DimensionState::Unknown;
        slot.basis_event_ids.clear();
        let mut state = EpistemicState::default();
        state
            .coverage_assessments
            .insert(ASSESSMENT.to_string(), record);
        let mut p = at_stakes(Risk::Low);
        p.basis.absence_claim = true;
        p.basis.coverage_refs = vec![ASSESSMENT.into()];
        let failure = absence_complete(&table, &state, &p).unwrap_err();
        assert_eq!(failure.code, "absence_coverage_incomplete");
        assert_eq!(failure.actual, TypedValue::string(&missing));
    }

    #[test]
    fn a_complete_assessment_satisfies_the_dimensions() {
        let mut state = EpistemicState::default();
        state
            .coverage_assessments
            .insert(ASSESSMENT.to_string(), assessment());
        let mut p = at_stakes(Risk::Low);
        p.basis.absence_claim = true;
        p.basis.coverage_refs = vec![ASSESSMENT.into()];
        assert!(absence_complete(&table(), &state, &p).is_ok());
    }

    #[test]
    fn every_field_the_table_names_is_one_both_sides_can_supply() {
        // A match field neither side can produce would compare two silences
        // and call it agreement. This binds the table's list to both
        // lookups.
        let table = table();
        let record = AbsenceRecord {
            searched_domain: "d".into(),
            search_scope: "s".into(),
            coverage_basis: "c".into(),
            observation_window: "w".into(),
            query_strategy: "q".into(),
            limitations: "l".into(),
        };
        for field in &table.absence.receipt_match_fields {
            assert!(
                absence_field(&record, field).is_some(),
                "{field} is named by the table and no Observation can supply it"
            );
            assert!(
                assessment().match_field(field).is_some(),
                "{field} is named by the table and no assessment can supply it"
            );
        }
    }

    #[test]
    fn silence_permits_exactly_two_transitions_and_refuses_every_other() {
        // The third M24.8 rule, and the one that is pure table data. Three
        // goldens name three examples; this is the exhaustive form, because
        // "quiet for 30 days → probably resolved" is the easiest regression
        // a future maintenance pass can introduce and an allowlist is only
        // protection if nothing quietly joins it.
        use crate::policy::verdict::{table_verdict, ProposalFacts, Verdict};
        let table = table();
        for cause in &table.silence.causes {
            for transition in &table.transitions {
                let facts = ProposalFacts {
                    // `update_belief` allows both silence transitions, so
                    // the transition under test is the only variable.
                    op: "update_belief".into(),
                    transition: transition.clone(),
                    declared_risk: Risk::Medium,
                    target_classes: vec!["belief".into()],
                    transition_cause: cause.clone(),
                    payload_conditions: Default::default(),
                    signals: Default::default(),
                };
                let Ok(verdict) = table_verdict(&table, &facts) else {
                    continue; // the op does not allow this transition at all
                };
                let allowed = table.silence.allowed_transitions.contains(transition);
                match verdict {
                    Verdict::Rejected { rejection, .. } => assert!(
                        !allowed,
                        "silence refused {transition}, which it permits ({})",
                        rejection.code
                    ),
                    _ => assert!(
                        allowed,
                        "{cause} was allowed to {transition} — silence never resolves"
                    ),
                }
            }
        }
    }

    #[test]
    fn every_code_these_rules_name_is_one_the_table_declares() {
        let table = table();
        for code in [
            &table.absence.incomplete_rejection,
            &table.absence.mismatch_rejection,
            &table.high_stakes.queue_rejection,
            &table.high_stakes.malformed_rejection,
            &table.high_stakes.stale_rejection,
        ] {
            let named = code_of(code).expect("the table names a code this build cannot spell");
            assert!(
                table.destiny(named).is_some(),
                "{named} has no declared destiny"
            );
        }
    }
}
