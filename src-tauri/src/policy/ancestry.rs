//! The preventive anti-self-ancestry gate (M26.3).
//!
//! **The failure this exists to prevent.** A Belief is revised. Something
//! derives a new Observation FROM that revision — a summary, a projection, a
//! restatement. That Observation is then offered as SUPPORT for revising the
//! same Belief again. Nothing has been learned; the base has read its own
//! handwriting back to itself and counted it as a second witness. Do that
//! twice and a claim nobody ever checked looks well-supported.
//!
//! **Preventive, not retrospective.** This runs at proposal apply, BEFORE the
//! mutation lands, and refuses regardless of risk — a LOW-risk auto-applying
//! op is exactly where a self-supporting loop would be invisible. M27
//! broadens lineage analysis; it does not retroactively supply the safety
//! prerequisite this milestone's flip depends on.
//!
//! **The walk is cycle-safe by construction.** A visited set, not a depth
//! limit: a depth limit would silently pass a loop one hop longer than the
//! number somebody picked.
//!
//! ## What counts as a hop
//!
//! Three kinds, all explicit — nothing here infers a dependency from
//! similarity or timing:
//!
//! 1. **Observation lineage.** `lineage_parents` says this Observation was
//!    derived from those.
//! 2. **Derived content.** `derived_belief_sources` is M22's reducer index of
//!    `derived_content.source_belief_revision_event_ids` — "this Observation
//!    was written FROM that belief revision".
//! 3. **A reached revision's own basis.** Landing on a revision means
//!    reaching every Observation that revision cited, because those are what
//!    it was built from.
//!
//! ## How it is bound (M26.3b)
//!
//! `shared/policy/policy.v2.json` (`format: 2`) registers `no_self_ancestry`
//! in the global closed predicate registry, requires it on every
//! belief-basis-changing op, and declares the binding once in a
//! `preventive_ancestry` block. `preconditions::check` dispatches on the op's
//! `requires` list like every other predicate, so which ops run the walk is
//! the artifact's answer rather than this module's.
//!
//! The ORDER mattered and this is the safe half of it. `PREDICATE_OWNERS`
//! exists because a predicate the table REQUIRES and nothing evaluates is a
//! rule that looks like protection — so the walk (M26.3a) landed first, with
//! nothing depending on it, and the requirement second. The dangerous order
//! would have been publishing the requirement and discovering the walk
//! afterwards.
//!
//! [`table_binding`] is the precondition live registration calls (M26.3c,
//! `mcp::registration_gate`). A build pointed at the frozen format-1 table
//! serves no proposal tool at all and says why: the binding is absent, not
//! the code unknown.

use std::collections::BTreeSet;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{BeliefBasis, ProposalOp, ProposalV1, TypedValue};

use super::preconditions::{PreconditionFailure, PreconditionResult};
use super::table::{PolicyTable, PreventiveAncestryRule};

/// The predicate name a refusal reports, and the table's binding.
pub const RULE: &str = "no_self_ancestry";
/// The ledger-destined rejection code. Registered (reserved) in the global
/// closed registry since policy.v1, so this binds a code that already exists
/// rather than inventing one.
pub const CODE: &str = "self_ancestry";

/// The op kinds whose payload carries a `BeliefBasis` — the only ones this
/// walk can ever refuse, and therefore the only ones the table may bind it
/// to. Binding it to more would be a rule that looks like protection; to
/// fewer, a hole.
///
/// This list is checked against the artifact by a tripwire below, and
/// [`basis_target`]'s match is exhaustive, so an op variant added later with
/// a basis in its payload cannot reach the table without passing through
/// here.
pub const BASIS_CHANGING_OPS: &[&str] = &["create_belief", "update_belief"];

/// The M26.3 live-registration precondition: does the loaded table actually
/// BIND this walk?
///
/// The frozen format-1 table is a valid table that simply predates the gate,
/// so a build reading it must refuse to register the proposal tools by
/// naming the absent binding — not by tripping over an unknown code, which
/// would be the right outcome for the wrong reason and would stop being true
/// the moment somebody registered the code.
pub fn table_binding(table: &PolicyTable) -> Result<&PreventiveAncestryRule, String> {
    let Some(rule) = &table.preventive_ancestry else {
        return Err(format!(
            "the loaded policy table (format {}) binds no {RULE} predicate — live proposal \
             tools may not be registered against it",
            table.format
        ));
    };
    if rule.predicate != RULE || rule.rejection != CODE {
        return Err(format!(
            "the loaded policy table binds {:?}/{:?}, and this build evaluates {RULE}/{CODE}",
            rule.predicate, rule.rejection
        ));
    }
    Ok(rule)
}

/// What the walk found, when it found something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfAncestry {
    pub target_belief_id: String,
    pub reached_revision_event_id: String,
    pub support_observation_event_id: String,
}

/// Which Belief a proposal's basis is being attached to, and what supports
/// it. Returns `None` for ops that change no belief basis — those cannot
/// close a loop, and asking them to prove they do not would be noise.
///
/// **Exhaustive on purpose, with no wildcard arm.** An op variant added
/// later that carries a `BeliefBasis` would otherwise fall silently into
/// `None` and be exempt from a gate written to catch exactly that shape.
/// This way the compiler asks.
fn basis_target(proposal: &ProposalV1) -> Option<(&str, &BeliefBasis)> {
    match &proposal.op {
        ProposalOp::CreateBelief {
            belief_id, basis, ..
        } => Some((belief_id, basis)),
        ProposalOp::UpdateBelief {
            belief_id, basis, ..
        } => Some((belief_id, basis)),
        // No basis in the payload: these move, retire, relabel, or
        // redistribute what a Belief already rests on, and none of them can
        // introduce a support Observation.
        ProposalOp::AppendObservation { .. }
        | ProposalOp::CacheSource { .. }
        | ProposalOp::SupersedeBelief { .. }
        | ProposalOp::PromoteDraft { .. }
        | ProposalOp::EditRelation { .. }
        | ProposalOp::ContestBelief { .. }
        | ProposalOp::ClassifyConflict { .. }
        | ProposalOp::AddEntityAlias { .. }
        | ProposalOp::CorrectObservationSubject { .. }
        | ProposalOp::ConfirmObservationIndependence { .. }
        | ProposalOp::MergeBeliefsExact { .. }
        | ProposalOp::MergeEntities { .. }
        | ProposalOp::SplitBelief { .. }
        | ProposalOp::TombstoneBelief { .. }
        | ProposalOp::ArchiveBelief { .. }
        | ProposalOp::Deprecate { .. }
        | ProposalOp::MassSupersede { .. }
        | ProposalOp::RevertProposal { .. } => None,
    }
}

/// Every support Observation the basis names.
///
/// Only SUPPORT: an Observation cited as contradicting evidence is not
/// something the revision is built from, so it cannot make the revision its
/// own ancestor.
fn support_observations(basis: &BeliefBasis) -> Vec<String> {
    match basis {
        BeliefBasis::Linked { links } => links
            .iter()
            .filter(|link| link.role == crate::ledger::schema::BasisRole::Supports)
            .map(|link| link.observation_event_id.clone())
            .collect(),
        _ => Vec::new(),
    }
}

/// Does `observation` reach any revision of `belief_id`?
///
/// Breadth-first over the three explicit hop kinds, with a visited set. The
/// FIRST revision reached is reported — a refusal that named the deepest one
/// would be describing the walk rather than the problem.
fn reaches_belief(state: &EpistemicState, observation: &str, belief_id: &str) -> Option<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: std::collections::VecDeque<String> =
        std::collections::VecDeque::from([observation.to_string()]);

    while let Some(current) = queue.pop_front() {
        if !seen.insert(current.clone()) {
            continue;
        }

        // Hop 2: this Observation was DERIVED FROM belief revisions.
        for (source_observation, revision_event) in &state.derived_belief_sources {
            if source_observation != &current {
                continue;
            }
            if let Some((reached_belief, _)) = state.belief_revision_events.get(revision_event) {
                if reached_belief == belief_id {
                    return Some(revision_event.clone());
                }
                // Hop 3: reaching a revision reaches everything IT cited.
                if let Some(belief) = state.beliefs.get(reached_belief) {
                    for revision in &belief.revisions {
                        if &revision.event_id != revision_event {
                            continue;
                        }
                        for id in support_observations(&revision.basis) {
                            queue.push_back(id);
                        }
                    }
                }
            }
        }

        // Hop 1: ordinary Observation lineage.
        if let Some(row) = state.observations.get(&current) {
            for (_, parent) in &row.lineage_parents {
                queue.push_back(parent.clone());
            }
        }
    }
    None
}

/// The gate. Refuses when any proposed support Observation reaches any
/// revision of the Belief the proposal is about.
pub fn no_self_ancestry(state: &EpistemicState, proposal: &ProposalV1) -> PreconditionResult {
    let Some((belief_id, basis)) = basis_target(proposal) else {
        return Ok(());
    };
    for observation in support_observations(basis) {
        if let Some(revision) = reaches_belief(state, &observation, belief_id) {
            let found = SelfAncestry {
                target_belief_id: belief_id.to_string(),
                reached_revision_event_id: revision,
                support_observation_event_id: observation,
            };
            return Err(Box::new(PreconditionFailure {
                code: CODE,
                rule: RULE,
                // The typed shapes the design fixes: a boolean the rule
                // wanted, and the exact triple that explains the refusal.
                expected: TypedValue::Boolean { value: true },
                actual: TypedValue::Object {
                    value: [
                        (
                            "target_belief_id".to_string(),
                            TypedValue::string(&found.target_belief_id),
                        ),
                        (
                            "reached_revision_event_id".to_string(),
                            TypedValue::string(&found.reached_revision_event_id),
                        ),
                        (
                            "support_observation_event_id".to_string(),
                            TypedValue::string(&found.support_observation_event_id),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                },
            }));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{BeliefState, ObservationState, RevisionState};
    use crate::ledger::schema::{
        BasisLink, BasisRole, IntendedUse, IntendedUseKind, LineageKind, ObservationKind,
        ProposalBasis, ProposalTarget, Risk, SubjectRef, TargetClass, TransitionCause,
    };

    const BELIEF: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const OTHER_BELIEF: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const ENTITY: &str = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
    const REV_1: &str = "11111111111111111111111111111111";
    const REV_2: &str = "22222222222222222222222222222222";
    const OBS_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OBS_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const OBS_C: &str = "cccccccccccccccccccccccccccccccc";
    const OBS_CLEAN: &str = "dddddddddddddddddddddddddddddddd";

    fn observation(id: &str, parents: Vec<&str>) -> ObservationState {
        ObservationState {
            event_id: id.to_string(),
            seq: 1,
            kind: ObservationKind::DerivedContent,
            source_id: "s".into(),
            source_registration_event_id: "r".into(),
            subject: SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            effective_entity: Some(ENTITY.into()),
            effective_resolution_event: None,
            authority: None,
            assertion_basis: None,
            absence: None,
            actor: "agent:claude".into(),
            lineage_parents: parents
                .into_iter()
                .map(|p| (LineageKind::DerivedFrom, p.to_string()))
                .collect(),
        }
    }

    fn revision(event_id: &str, supports: Vec<&str>) -> RevisionState {
        RevisionState {
            revision: 1,
            event_id: event_id.to_string(),
            content: String::new(),
            fields: serde_json::json!({}),
            basis: BeliefBasis::Linked {
                links: supports
                    .into_iter()
                    .map(|id| BasisLink {
                        observation_event_id: id.to_string(),
                        role: BasisRole::Supports,
                    })
                    .collect(),
            },
        }
    }

    /// A base with one Belief at one revision, and an Observation derived
    /// from that revision — the raw material of a loop.
    fn state() -> EpistemicState {
        let mut state = EpistemicState::default();
        let mut belief = BeliefState {
            belief_id: BELIEF.to_string(),
            entity_id: ENTITY.to_string(),
            created_event_id: REV_1.to_string(),
            revisions: vec![revision(REV_1, vec![])],
            attested: None,
            attestation_events: vec![],
            path: None,
            overrides: vec![],
            override_head_event: None,
            projection_head_event: REV_1.to_string(),
            qualification: crate::ledger::schema::Qualification::Draft,
            lifecycle: crate::ledger::schema::Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        };
        belief.revisions.push(revision(REV_2, vec![OBS_CLEAN]));
        state.beliefs.insert(BELIEF.to_string(), belief);
        state
            .belief_revision_events
            .insert(REV_1.to_string(), (BELIEF.to_string(), 1));
        state
            .belief_revision_events
            .insert(REV_2.to_string(), (BELIEF.to_string(), 2));
        for id in [OBS_A, OBS_B, OBS_C, OBS_CLEAN] {
            state
                .observations
                .insert(id.to_string(), observation(id, vec![]));
        }
        state
    }

    fn proposal(belief_id: &str, supports: Vec<&str>) -> ProposalV1 {
        ProposalV1 {
            schema: crate::ledger::schema::PROPOSAL_SCHEMA,
            proposal_id: "1".repeat(32),
            run_id: "2".repeat(32),
            targets: vec![ProposalTarget {
                target_class: TargetClass::Belief,
                target_id: belief_id.to_string(),
                expected_version: Some(1),
            }],
            op: ProposalOp::UpdateBelief {
                belief_id: belief_id.to_string(),
                patch: vec![],
                basis: BeliefBasis::Linked {
                    links: supports
                        .into_iter()
                        .map(|id| BasisLink {
                            observation_event_id: id.to_string(),
                            role: BasisRole::Supports,
                        })
                        .collect(),
                },
            },
            intended_use: IntendedUse {
                kind: IntendedUseKind::ReversibleWork,
                stakes: Risk::Low,
                predicate_class: None,
            },
            basis: ProposalBasis {
                transition_cause: TransitionCause::NewEvidence,
                evidence_refs: vec![],
                coverage_refs: vec![],
                authority_refs: vec![],
                authority_route_refs: vec![],
                addressed_contradictions: vec![],
                absence_claim: false,
            },
            declared_risk: Risk::Low,
            reason: "test".into(),
            candidate_search_receipt: None,
        }
    }

    fn refusal(state: &EpistemicState, proposal: &ProposalV1) -> Box<PreconditionFailure> {
        no_self_ancestry(state, proposal).unwrap_err()
    }

    #[test]
    fn evidence_with_no_relationship_to_the_belief_passes() {
        // The control. Without it a gate that refused everything would look
        // identical to one that works.
        assert_eq!(
            no_self_ancestry(&state(), &proposal(BELIEF, vec![OBS_A])),
            Ok(())
        );
    }

    #[test]
    fn a_direct_loop_is_refused() {
        // The Observation was written FROM this Belief's own revision, and is
        // now offered as support for revising it again. Nothing was learned.
        let mut state = state();
        state
            .derived_belief_sources
            .push((OBS_A.to_string(), REV_1.to_string()));
        let failure = refusal(&state, &proposal(BELIEF, vec![OBS_A]));
        assert_eq!(failure.code, CODE);
        assert_eq!(failure.rule, RULE);
        assert_eq!(failure.expected, TypedValue::Boolean { value: true });
        let TypedValue::Object { value: actual } = &failure.actual else {
            panic!("{:?}", failure.actual);
        };
        assert_eq!(
            actual.get("target_belief_id"),
            Some(&TypedValue::string(BELIEF))
        );
        assert_eq!(
            actual.get("reached_revision_event_id"),
            Some(&TypedValue::string(REV_1))
        );
        assert_eq!(
            actual.get("support_observation_event_id"),
            Some(&TypedValue::string(OBS_A))
        );
    }

    #[test]
    fn a_transitive_loop_through_lineage_is_refused() {
        // A restatement of a restatement is still the base's own handwriting.
        let mut state = state();
        state
            .observations
            .insert(OBS_B.to_string(), observation(OBS_B, vec![OBS_A]));
        state
            .derived_belief_sources
            .push((OBS_A.to_string(), REV_1.to_string()));
        let failure = refusal(&state, &proposal(BELIEF, vec![OBS_B]));
        assert_eq!(failure.code, CODE);
    }

    #[test]
    fn reaching_an_old_revision_still_refuses() {
        // Reaching ANY revision closes the loop. A base that only checked the
        // current one would accept evidence derived from the version it was
        // about to replace, which is the same circle one step behind.
        let mut state = state();
        state
            .derived_belief_sources
            .push((OBS_A.to_string(), REV_2.to_string()));
        assert_eq!(refusal(&state, &proposal(BELIEF, vec![OBS_A])).code, CODE);
    }

    #[test]
    fn a_reached_revisions_own_basis_is_reached_too() {
        // Landing on a revision reaches what that revision was built from, so
        // a loop that goes belief → its basis → back is caught.
        let mut state = state();
        // OBS_B derives from REV_2, whose basis cites OBS_CLEAN; and
        // OBS_CLEAN derives from REV_1. The path is three hops of two kinds.
        state
            .derived_belief_sources
            .push((OBS_B.to_string(), REV_2.to_string()));
        state
            .derived_belief_sources
            .push((OBS_CLEAN.to_string(), REV_1.to_string()));
        assert_eq!(refusal(&state, &proposal(BELIEF, vec![OBS_B])).code, CODE);
    }

    #[test]
    fn a_cycle_terminates_instead_of_hanging() {
        // Cycle-safe by a VISITED SET, not a depth limit — a depth limit
        // silently passes a loop one hop longer than the number somebody
        // picked.
        let mut state = state();
        state
            .observations
            .insert(OBS_A.to_string(), observation(OBS_A, vec![OBS_B]));
        state
            .observations
            .insert(OBS_B.to_string(), observation(OBS_B, vec![OBS_C]));
        state
            .observations
            .insert(OBS_C.to_string(), observation(OBS_C, vec![OBS_A]));
        assert_eq!(
            no_self_ancestry(&state, &proposal(BELIEF, vec![OBS_A])),
            Ok(()),
            "a cycle that never reaches the belief is not self-ancestry"
        );

        // And the same cycle, with one member derived from the belief, IS.
        state
            .derived_belief_sources
            .push((OBS_C.to_string(), REV_1.to_string()));
        assert_eq!(refusal(&state, &proposal(BELIEF, vec![OBS_A])).code, CODE);
    }

    #[test]
    fn evidence_derived_from_a_different_belief_is_not_self_ancestry() {
        // Building on what the base already believes about something ELSE is
        // ordinary reasoning, not a loop.
        let mut state = state();
        state.belief_revision_events.insert(
            "33333333333333333333333333333333".to_string(),
            (OTHER_BELIEF.to_string(), 1),
        );
        state.derived_belief_sources.push((
            OBS_A.to_string(),
            "33333333333333333333333333333333".to_string(),
        ));
        assert_eq!(
            no_self_ancestry(&state, &proposal(BELIEF, vec![OBS_A])),
            Ok(())
        );
    }

    #[test]
    fn opposing_evidence_cannot_close_a_loop() {
        // An Observation cited as OPPOSING is not something the revision is
        // built from, so it cannot make the revision its own ancestor. Only
        // `supports` links are walked.
        let mut state = state();
        state
            .derived_belief_sources
            .push((OBS_A.to_string(), REV_1.to_string()));
        let mut p = proposal(BELIEF, vec![]);
        p.op = ProposalOp::UpdateBelief {
            belief_id: BELIEF.to_string(),
            patch: vec![],
            basis: BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: OBS_A.to_string(),
                    role: BasisRole::Opposes,
                }],
            },
        };
        assert_eq!(no_self_ancestry(&state, &p), Ok(()));
    }

    #[test]
    fn an_op_that_changes_no_belief_basis_is_not_asked_to_prove_anything() {
        let mut state = state();
        state
            .derived_belief_sources
            .push((OBS_A.to_string(), REV_1.to_string()));
        let mut p = proposal(BELIEF, vec![OBS_A]);
        p.op = ProposalOp::AddEntityAlias {
            entity_id: ENTITY.to_string(),
            alias: "Falcon".into(),
        };
        assert_eq!(no_self_ancestry(&state, &p), Ok(()));
    }

    #[test]
    fn the_table_binds_the_walk_to_exactly_the_ops_it_can_refuse() {
        // THE BINDING TRIPWIRE. `basis_target` is exhaustive, so this list
        // cannot silently fall behind the op union; this asserts the other
        // edge — that the artifact and the evaluator agree about where the
        // gate runs. A table binding one more op would declare protection
        // the walk never provides; one fewer, a hole.
        let table = PolicyTable::load().unwrap();
        let rule = table_binding(&table).expect("the shipped table binds the walk");
        assert_eq!(rule.required_for_ops, BASIS_CHANGING_OPS);
        assert_eq!(rule.predicate, RULE);
        assert_eq!(rule.rejection, CODE);
    }

    #[test]
    fn registration_against_the_frozen_v1_table_refuses_by_naming_the_binding() {
        // The exact refusal the design fixes: v1 is a VALID table that
        // predates the gate, so the failure must be "nothing binds
        // no_self_ancestry" and not "unknown code". The distinction matters
        // because the wrong-reason failure would evaporate the day somebody
        // registered the code without wiring the walk.
        let v1 = PolicyTable::parse(crate::policy::table::POLICY_V1_JSON).unwrap();
        let err = table_binding(&v1).unwrap_err();
        assert!(err.contains(RULE), "{err}");
        assert!(!err.contains("unknown"), "{err}");
    }

    #[test]
    fn every_bound_op_declares_the_code_the_walk_refuses_with() {
        // The refusal has to be sayable by the op that produces it, and the
        // code has to reach the LEDGER — an epistemic refusal routed to the
        // operational log is invisible to the thing it exists to inform.
        let table = PolicyTable::load().unwrap();
        for name in BASIS_CHANGING_OPS {
            let op = table.op(name).unwrap();
            assert!(op.requires.iter().any(|p| p == RULE), "{name}");
            assert!(op.possible_rejections.iter().any(|c| c == CODE), "{name}");
        }
        assert_eq!(
            table.destiny(CODE),
            Some(crate::policy::table::Destiny::Ledger)
        );
    }

    #[test]
    fn the_refusal_does_not_depend_on_risk() {
        // A LOW-risk auto-applying op is exactly where a self-supporting loop
        // would be invisible, so the gate refuses regardless.
        let mut state = state();
        state
            .derived_belief_sources
            .push((OBS_A.to_string(), REV_1.to_string()));
        for risk in [Risk::Low, Risk::Medium, Risk::High, Risk::Critical] {
            let mut p = proposal(BELIEF, vec![OBS_A]);
            p.declared_risk = risk;
            assert_eq!(refusal(&state, &p).code, CODE, "{risk:?}");
        }
    }
}
