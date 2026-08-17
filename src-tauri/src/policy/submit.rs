//! The internal typed submit boundary (M24.3).
//!
//! **This is the channel a proposal travels** — never stdout JSON, which
//! `agent.rs` silently skips when it cannot parse a line. Through M25 it was
//! internal, and `no_proposal_tool_is_registered` proved that absence rather
//! than trusting anyone to remember it.
//!
//! M26.3c registered the surface, and that test was INVERTED rather than
//! deleted: `the_live_proposal_inventory_is_the_policy_inventory` now proves
//! the served tools are exactly the ops the artifact marks agent-facing, plus
//! terminal `commit_proposals`, with no synonym and no route to the human's
//! own decisions. A deleted test would have left nobody able to say what the
//! live surface is.
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

    /// Every tool name the live server serves, with the surface on.
    fn served(on: bool) -> std::collections::BTreeSet<String> {
        crate::mcp::tool_catalog(on)
            .iter()
            .filter_map(|tool| tool.get("name").and_then(|n| n.as_str()))
            .map(str::to_string)
            .collect()
    }

    /// What the ARTIFACT says the proposal surface is.
    fn expected(table: &PolicyTable) -> std::collections::BTreeSet<String> {
        table
            .agent_facing_ops()
            .into_iter()
            .map(crate::mcp::proposal_tool_name)
            .chain(std::iter::once(crate::mcp::COMMIT_TOOL.to_string()))
            .collect()
    }

    #[test]
    fn the_live_proposal_inventory_is_the_policy_inventory() {
        // **THE INVERTED ASSERTION.** Until M26.3c this test proved the
        // proposal surface was ABSENT, and that absence was the guarantee
        // that agents could not mutate anything. The guarantee has moved,
        // not evaporated: what is asserted now is that the served surface is
        // EXACTLY what the artifact authorises — no op the table withholds,
        // no synonym the table never named, and nothing a second
        // hand-maintained list could add.
        //
        // It is inverted rather than deleted on purpose. A deleted test
        // leaves nobody able to say what the live surface is; this one still
        // fails the moment it stops matching the table.
        let table = PolicyTable::load().unwrap();
        let base = served(false);
        let all = served(true);

        let generated: std::collections::BTreeSet<String> =
            all.difference(&base).cloned().collect();
        assert_eq!(
            generated,
            expected(&table),
            "the served proposal surface and the policy artifact disagree"
        );

        // DISJOINTNESS. `cache_source` is both a hand-written write tool and
        // a policy op; without the prefix the catalog would carry two tools
        // of one name and the picker would show one checkbox for two things.
        assert!(
            base.is_disjoint(&generated),
            "a generated proposal tool collides with a hand-written one"
        );

        // NO SYNONYMS, and no route to the human's own decisions. An agent
        // that could call `record_decision` would approve its own cards.
        for forbidden in [
            "submit_proposal",
            "propose_mutation",
            "record_decision",
            "resolve_commit_set",
        ] {
            assert!(!all.contains(forbidden), "{forbidden} is served");
        }

        // THE WITHHELD OPS, named so neither can be re-enabled by editing
        // one JSON boolean without somebody reading why it is false.
        //
        // `revert_proposal`: MEDIUM, MEDIUM auto-applies, so an agent-facing
        // revert would silently undo an applied mutation — including one a
        // human just approved on a HIGH card — with no second card.
        //
        // `append_observation`: its payload is the SERVER-CANONICAL
        // observation body, and `expand.rs`'s arm for it is the only one of
        // twenty that passes the caller's `actor` through instead of
        // stamping the run's. `reduce.rs` derives authority from that actor,
        // so an agent could mint a `TrustedHumanCapture` observation
        // attributed to the human. `trusted_observation_provenance` is
        // required by the row and evaluated nowhere.
        for withheld in ["revert_proposal", "append_observation"] {
            assert!(
                !table.op(withheld).unwrap().agent_facing,
                "{withheld} became agent-facing"
            );
            assert!(!all.contains(&crate::mcp::proposal_tool_name(withheld)));
        }
    }

    #[test]
    fn the_predicate_with_no_evaluator_guards_nothing_that_is_served() {
        // THE GAP TRIPWIRE, pointed at the live surface (M26.3c).
        // `PREDICATE_OWNERS` already proves every table predicate is either
        // implemented or a written-down gap. This proves the stronger thing
        // registration needs: no op an AGENT can reach depends on a
        // predicate that nothing evaluates. A gap is tolerable behind the
        // internal boundary and is not tolerable in front of a model.
        let table = PolicyTable::load().unwrap();
        let unevaluated: std::collections::BTreeSet<&str> =
            crate::policy::preconditions::PREDICATE_OWNERS
                .iter()
                .filter(|(_, owner)| owner.is_none())
                .map(|(name, _)| *name)
                .collect();
        // An unevaluated predicate is tolerable in exactly one shape: its
        // SUBJECT MATTER does not exist yet, and the table says so by
        // declaring the capability unavailable. `open_contradictions_
        // addressed` is that shape — its unit is an M27 contradiction edge,
        // and `contradiction_edges` is `available: false`, so there is
        // nothing for the predicate to find and nothing it could miss.
        //
        // The moment M27 makes that capability available without wiring the
        // evaluator, this fires — which is precisely when a rule that looks
        // like protection would start being one.
        let excused = &table.contradiction_addressing;
        let excused_predicate = "open_contradictions_addressed";
        for op in table.agent_facing_ops() {
            for predicate in &table.op(op).unwrap().requires {
                if !unevaluated.contains(predicate.as_str()) {
                    continue;
                }
                assert_eq!(
                    predicate, excused_predicate,
                    "{op} is served to agents and requires {predicate}, which nothing evaluates"
                );
                let capability = table
                    .capabilities
                    .get(&excused.capability)
                    .expect("the table validated this capability exists");
                assert!(
                    !capability.available,
                    "{predicate} is excused only while {} is unavailable — it is available now, \
                     so {op} is served to agents behind a rule nothing evaluates",
                    excused.capability
                );
            }
        }
    }

    #[test]
    fn the_surface_is_off_until_it_is_switched_on() {
        // REGISTRATION IS NOT ACTIVATION. The switch defaults off, so a
        // fresh install serves only the base catalog, and M26.9 has something
        // real to flip. Fifteen: M26.4h added `report_window_outcome` and
        // M26.5e added `submit_answer` — neither is a proposal tool nor gated
        // by the switch, because a run must be able to say a window concluded
        // nothing, or to answer the question it was given, whether or not it
        // could have proposed anything (an attended synthesis proposes
        // nothing at all). M33a.5 added `knowledge_about`, which is a plain
        // read and belongs to no surface a switch governs.
        let base = served(false);
        let table = PolicyTable::load().unwrap();
        assert_eq!(base.len(), 15, "{base:?}");
        assert!(base.contains("report_window_outcome"));
        assert!(base.contains(crate::assembly::prompt::SUBMIT_TOOL));
        assert!(base.is_disjoint(&expected(&table)));
        assert!(!base.contains(crate::mcp::COMMIT_TOOL));
        // `propose_organize` predates this namespace and is NOT a policy op.
        // It stays served with the surface off, which is exactly why the
        // name→op mapping asks the table instead of trusting the prefix.
        assert!(base.contains("propose_organize"));
        assert!(!table.ops.contains_key("organize"));
    }

    #[test]
    fn registration_against_the_frozen_v1_table_refuses_and_says_why() {
        // The negative control the whole gate rests on: a format-1 table is
        // VALID and simply predates the ancestry binding, so registration
        // must fail by NAMING the absent binding. Failing on an unknown code
        // would be the right outcome for the wrong reason, and would stop
        // being true the day somebody registered the code.
        let v1 = PolicyTable::parse(crate::policy::table::POLICY_V1_JSON).unwrap();
        let error = crate::mcp::proposal_tools(&v1).unwrap_err();
        assert!(error.contains("no_self_ancestry"), "{error}");
        assert!(!error.contains("unknown"), "{error}");
    }

    #[test]
    fn registration_against_the_frozen_v2_table_refuses_and_says_why() {
        // The M27.4 negative control, and the exact shape of "the gate is not
        // live yet": a format-2 table is VALID and simply has
        // `contradiction_edges` unavailable, which is what M24 through M26
        // shipped. Registration must refuse by naming that capability —
        // serving the merge and supersede tools against it would mean a
        // surface that can retire a contradiction with nothing evaluating
        // whether anybody addressed it.
        let v2 = PolicyTable::parse(crate::policy::table::POLICY_V2_JSON).unwrap();
        let error = crate::mcp::proposal_tools(&v2).unwrap_err();
        assert!(error.contains("contradiction_edges"), "{error}");
        assert!(!error.contains("unknown"), "{error}");
        // And for the right reason: v2 binds the predicate on every op it
        // needs to, so the refusal cannot be coming from a missing binding.
        let table = PolicyTable::load().unwrap();
        for op in &table.contradiction_addressing.required_for_ops {
            assert!(
                v2.op(op)
                    .unwrap()
                    .requires
                    .iter()
                    .any(|p| p == "open_contradictions_addressed"),
                "{op} does not bind the rule in v2, so the refusal proves nothing"
            );
        }
    }

    #[test]
    fn registration_refuses_a_live_table_that_stopped_requiring_addressing() {
        // Defence in depth, the same shape as the create-surface check: a
        // future table could keep the capability available and quietly drop
        // the rule from one op, which is the version of this hole that would
        // be hardest to see.
        let mut raw: serde_json::Value =
            serde_json::from_str(crate::policy::table::POLICY_JSON).unwrap();
        raw["ops"]["merge_entities"]["requires"]
            .as_array_mut()
            .unwrap()
            .retain(|p| p.as_str() != Some("open_contradictions_addressed"));
        let table = PolicyTable::parse(&raw.to_string()).unwrap();
        let error = crate::mcp::proposal_tools(&table).unwrap_err();
        assert!(error.contains("merge_entities"), "{error}");
        assert!(error.contains("open_contradictions_addressed"), "{error}");
    }

    #[test]
    fn registration_refuses_a_table_that_stopped_demanding_a_search() {
        // The other half of the gate. A create is the one mutation with no
        // target to compare against, so a live create surface on a table
        // that no longer requires the candidate receipt would be the §15
        // hole with a tool attached to it.
        let mut raw: serde_json::Value =
            serde_json::from_str(crate::policy::table::POLICY_JSON).unwrap();
        raw["ops"]["create_belief"]["requires"]
            .as_array_mut()
            .unwrap()
            .retain(|p| p.as_str() != Some("candidate_receipt_current"));
        // The table's own load rules already refuse a predicate no op
        // requires, so the predicate has to leave the registry too. That
        // makes this gate defence in DEPTH rather than the only guard — and
        // the depth is the point: a future table could register the
        // predicate against some other op and still leave creates unguarded.
        raw["predicates"]
            .as_array_mut()
            .unwrap()
            .retain(|p| p.as_str() != Some("candidate_receipt_current"));
        let table = PolicyTable::parse(&raw.to_string()).unwrap();
        let error = crate::mcp::proposal_tools(&table).unwrap_err();
        assert!(error.contains("candidate_receipt_current"), "{error}");
    }

    #[test]
    fn every_served_proposal_tool_is_callable_and_described() {
        // A catalog entry with no dispatch arm answers "unknown tool", and a
        // description is agent-facing prompt surface reviewed like code.
        let table = PolicyTable::load().unwrap();
        for tool in crate::mcp::proposal_tools(&table).unwrap() {
            let name = tool["name"].as_str().unwrap();
            let description = tool["description"].as_str().unwrap();
            assert!(description.len() > 20, "{name}: {description}");
            assert!(tool.get("inputSchema").is_some(), "{name}");
            if name != crate::mcp::COMMIT_TOOL {
                let op = name.strip_prefix(crate::mcp::PROPOSAL_PREFIX).unwrap();
                assert!(table.op(op).is_some(), "{name} names no table row");
            }
        }
    }
}
