//! The internal typed submit boundary (M24.3).
//!
//! **Agents stay off, mechanically.** This is the channel a proposal
//! travels — never stdout JSON, which `agent.rs` silently skips when it
//! cannot parse a line — and in M24 it is INTERNAL: no MCP tool is
//! registered for it on the live server or in the mock catalog, and
//! `no_proposal_tool_is_registered` proves that absence rather than
//! trusting anyone to remember. M26 owns the one explicit registration
//! phase, after semantic candidate search is live.
//!
//! The boundary returns a TYPED result, not an error string. That is the
//! AGENTS.md re-scope in one sentence: a queued HIGH-risk mutation is not
//! an error to toast away, and a `stale_target_version` rejection is a card
//! the user has to see. Collapsing either into `null` would discard the
//! whole point of typing them.
//!
//! What M24.3 wires here is the boundary and its table-decidable verdict.
//! M24.4 adds server-side accumulation, the commit-set protocol, and the
//! state-dependent predicates; M24.5 adds expected-version CAS.

use serde::{Deserialize, Serialize};

use super::rejection::Rejection;
use super::table::{PolicyTable, Risk};
use super::verdict::{table_verdict, ProposalFacts, Verdict};
use crate::ledger::schema::{ProposalV1, TargetVersion};

/// What a submission answers with. Every variant is actionable: `queued`
/// means a person must look, `rejected` says exactly which rule refused and
/// what it expected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SubmitResult {
    Applied {
        proposal_id: String,
        resulting_versions: Vec<TargetVersion>,
    },
    Queued {
        proposal_id: String,
        effective_risk: Risk,
        /// Which deterministic escalators raised it — a card must be able
        /// to say WHY a LOW-declared change is sitting in a queue.
        escalated_by: Vec<String>,
    },
    Rejected {
        proposal_id: String,
        #[serde(flatten)]
        rejection: Rejection,
    },
}

/// A refusal that happens BEFORE policy: the proposal did not parse, or its
/// structure is invalid. These never construct `proposal.rejected` — they
/// are transport failures with an operational destiny (D5).
#[derive(Debug, Clone, PartialEq)]
pub struct SubmitError {
    pub code: &'static str,
    pub detail: String,
}

impl SubmitError {
    pub(crate) fn schema_invalid(detail: impl Into<String>) -> SubmitError {
        SubmitError {
            code: "schema_invalid",
            detail: detail.into(),
        }
    }
}

/// Project a validated proposal into the facts a table verdict needs.
pub fn facts_of(table: &PolicyTable, proposal: &ProposalV1) -> Result<ProposalFacts, SubmitError> {
    let op = proposal.op.kind().to_string();
    let payload_conditions = proposal.op.payload_conditions();
    let transition = table
        .transition_for(&op, &payload_conditions)
        .ok_or_else(|| {
            SubmitError::schema_invalid(format!("{op}: the payload selects no transition"))
        })?;
    Ok(ProposalFacts {
        op,
        transition,
        declared_risk: proposal.declared_risk,
        target_classes: proposal
            .target_classes()
            .into_iter()
            .map(str::to_string)
            .collect(),
        transition_cause: proposal.basis.transition_cause.as_str().to_string(),
        payload_conditions,
        // Escalator signals are SERVER-DERIVED from reducer state, never
        // supplied by the caller. M24.4 computes them at the current head;
        // an empty map here escalates nothing, which is why the pre-append
        // revalidation and not this call is what a queue decision rests on.
        signals: Default::default(),
    })
}

/// Evaluate one proposal against the table.
///
/// This is the boundary's decision function, deliberately separated from
/// the ledger write so the verdict can be tested without a vault — and so
/// M24.4 can wrap it with accumulation rather than reimplement it.
pub fn evaluate(table: &PolicyTable, proposal: &ProposalV1) -> Result<SubmitResult, SubmitError> {
    proposal.validate().map_err(SubmitError::schema_invalid)?;
    let facts = facts_of(table, proposal)?;
    let verdict =
        table_verdict(table, &facts).map_err(|e| SubmitError::schema_invalid(format!("{e:?}")))?;
    let proposal_id = proposal.proposal_id.clone();
    Ok(match verdict {
        Verdict::Applied { .. } => SubmitResult::Applied {
            proposal_id,
            // M24.4 fills these from the applied batch; a table-only
            // verdict knows the decision, not the resulting versions.
            resulting_versions: Vec::new(),
        },
        Verdict::Queued { risk, .. } => SubmitResult::Queued {
            proposal_id,
            effective_risk: risk.risk,
            escalated_by: risk.fired,
        },
        Verdict::Rejected { rejection, .. } => SubmitResult::Rejected {
            proposal_id,
            rejection: Rejection::new(
                table,
                &rejection.code,
                rule_for(&rejection.code),
                crate::ledger::schema::TypedValue::Missing,
                crate::ledger::schema::TypedValue::Missing,
            )
            .map_err(SubmitError::schema_invalid)?,
        },
    })
}

/// Which rule a table-decidable rejection is attributed to.
///
/// The three table stages that can refuse map onto three rule codes. This
/// is a mapping between two of the artifact's own closed vocabularies, not
/// a policy decision — the DECISION is which stage refused, and the table's
/// `evaluation_order` owns that.
pub(crate) fn rule_for(code: &str) -> &'static str {
    match code {
        "risk_lowered" => "risk_ladder",
        "target_set_mismatch" => "target_set_exact",
        "silence_transition_forbidden" => "silence_transition_allowed",
        _ => "commit_set",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{
        IntendedUse, IntendedUseKind, ProposalBasis, ProposalOp, ProposalTarget, TargetClass,
        TransitionCause, PROPOSAL_SCHEMA,
    };

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const C: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    fn proposal(op: ProposalOp, targets: Vec<ProposalTarget>, risk: Risk) -> ProposalV1 {
        ProposalV1 {
            schema: PROPOSAL_SCHEMA,
            proposal_id: A.into(),
            run_id: B.into(),
            targets,
            op,
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
            declared_risk: risk,
            reason: "a synthetic proposal".into(),
            candidate_search_receipt: None,
        }
    }

    fn belief_target(id: &str) -> ProposalTarget {
        ProposalTarget {
            target_id: id.into(),
            target_class: TargetClass::Belief,
            expected_version: Some(1),
        }
    }

    #[test]
    fn a_medium_op_auto_applies() {
        let p = proposal(
            ProposalOp::ArchiveBelief {
                belief_id: C.into(),
                replacement_id: None,
            },
            vec![belief_target(C)],
            Risk::High,
        );
        // Archive is HIGH, so it queues rather than applying.
        assert!(matches!(
            evaluate(&table(), &p).unwrap(),
            SubmitResult::Queued { .. }
        ));
    }

    #[test]
    fn the_boundary_returns_a_typed_result_not_an_error_string() {
        // The AGENTS.md re-scope in one assertion: a queued proposal is a
        // RESULT the caller must read, not a failure to toast away.
        let p = proposal(
            ProposalOp::TombstoneBelief {
                belief_id: C.into(),
                replacement_id: None,
                reason_code: crate::ledger::schema::TombstoneReason::Invalid,
            },
            vec![belief_target(C)],
            Risk::High,
        );
        match evaluate(&table(), &p).unwrap() {
            SubmitResult::Queued {
                proposal_id,
                effective_risk,
                escalated_by,
            } => {
                assert_eq!(proposal_id, A);
                assert_eq!(effective_risk, Risk::High);
                assert!(escalated_by.is_empty());
            }
            other => panic!("expected queued, got {other:?}"),
        }
    }

    #[test]
    fn an_understated_risk_is_a_rejection_with_a_declared_destiny() {
        let p = proposal(
            ProposalOp::TombstoneBelief {
                belief_id: C.into(),
                replacement_id: None,
                reason_code: crate::ledger::schema::TombstoneReason::Invalid,
            },
            vec![belief_target(C)],
            Risk::Low,
        );
        let t = table();
        match evaluate(&t, &p).unwrap() {
            SubmitResult::Rejected { rejection, .. } => {
                assert_eq!(rejection.code.as_str(), "risk_lowered");
                assert_eq!(rejection.rule.as_str(), "risk_ladder");
                assert_eq!(rejection.destiny(&t), super::super::table::Destiny::Ledger);
            }
            other => panic!("expected rejected, got {other:?}"),
        }
    }

    #[test]
    fn silence_cannot_tombstone_through_the_boundary() {
        let mut p = proposal(
            ProposalOp::TombstoneBelief {
                belief_id: C.into(),
                replacement_id: None,
                reason_code: crate::ledger::schema::TombstoneReason::Invalid,
            },
            vec![belief_target(C)],
            Risk::High,
        );
        p.basis.transition_cause = TransitionCause::ElapsedTime;
        let t = table();
        match evaluate(&t, &p).unwrap() {
            SubmitResult::Rejected { rejection, .. } => {
                assert_eq!(rejection.code.as_str(), "silence_transition_forbidden");
                assert_eq!(rejection.destiny(&t), super::super::table::Destiny::Ledger);
            }
            other => panic!("expected rejected, got {other:?}"),
        }
    }

    #[test]
    fn a_structurally_invalid_proposal_never_reaches_policy() {
        // Transport failures return their own shape: they must not be able
        // to construct a `proposal.rejected` body (D5).
        let mut p = proposal(
            ProposalOp::ArchiveBelief {
                belief_id: C.into(),
                replacement_id: None,
            },
            vec![belief_target(C)],
            Risk::High,
        );
        p.reason = "   ".into();
        let err = evaluate(&table(), &p).unwrap_err();
        assert_eq!(err.code, "schema_invalid");
    }

    #[test]
    fn a_submit_result_round_trips_as_json() {
        // It is the wire shape the eventual MCP tool returns; if it cannot
        // serialize and come back identical it cannot be that surface.
        let t = table();
        let p = proposal(
            ProposalOp::TombstoneBelief {
                belief_id: C.into(),
                replacement_id: None,
                reason_code: crate::ledger::schema::TombstoneReason::Invalid,
            },
            vec![belief_target(C)],
            Risk::Low,
        );
        let result = evaluate(&t, &p).unwrap();
        let raw = serde_json::to_string(&result).unwrap();
        assert_eq!(
            serde_json::from_str::<SubmitResult>(&raw).unwrap(),
            result,
            "{raw}"
        );
        assert!(raw.contains("\"outcome\":\"rejected\""), "{raw}");
    }

    #[test]
    fn no_proposal_tool_is_registered_on_the_live_server() {
        // AGENTS STAY OFF, MECHANICALLY. The proposal boundary exists and
        // is exercised by these tests, but nothing serves it to a model.
        // M26 has one explicit registration phase, after semantic candidate
        // search is live and the preventive graph guards pass their
        // fixtures. Until then, this assertion is the guarantee — the TS
        // catalog mirror (`src/engine/tools.test.ts`) parses the same
        // function and holds the same absence from the other side.
        let mcp = include_str!("../mcp.rs");
        let start = mcp
            .find("fn tool_catalog()")
            .expect("mcp.rs still defines tool_catalog");
        let catalog = &mcp[start..];
        let end = catalog.find("\n}\n").expect("tool_catalog has an end");
        let catalog = &catalog[..end];
        for forbidden in [
            "submit_proposal",
            "commit_proposals",
            "propose_mutation",
            "revert_proposal",
        ] {
            assert!(
                !catalog.contains(forbidden),
                "{forbidden} is registered on the loopback MCP server — M24 keeps the proposal \
                 surface internal, and M26 owns turning it on"
            );
        }
    }
}
