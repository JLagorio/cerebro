//! The epistemic eval suite (M24.9) — five ways the base could be corrupted,
//! run as regression tests through the REAL interpreter.
//!
//! These ship with the mechanism rather than after it, because a governance
//! layer is only worth what it refuses, and the way a refusal quietly stops
//! working is that nothing was ever asserting it happened. Each scenario is
//! a synthetic world plus a proposal, decided by the same code path a live
//! agent would hit — no mocked verdicts, no hand-written expectations that
//! could drift from the table.
//!
//! One rule holds across all five: **nothing here may auto-apply.** A
//! scenario whose outcome moved from refused to queued is a design change to
//! argue about; one that moved to applied is a hole.

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::ledger::reduce::EpistemicState;
    use crate::ledger::schema::{
        self, BeliefBasis, PatchOp, ProposalOp, SubjectRef, TransitionCause, TypedValue,
    };
    use crate::ledger::writer::LedgerWriter;
    use crate::policy::commit::{commit_proposals, submit_proposal, CommitOutcome, TransitionCode};
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::submit::SubmitResult;
    use crate::policy::table::{PolicyTable, Risk};
    use crate::vault::testutil;

    const RUN: &str = "9111111111111111111111111111111f";
    const P1: &str = "0000000000000000000000000000000a";

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    fn actor() -> schema::Actor {
        schema::Actor {
            id: "agent:test".into(),
        }
    }

    fn seeded(name: &str) -> (std::path::PathBuf, LedgerWriter, String) {
        let vault = testutil::temp_vault(name);
        let mut writer = LedgerWriter::open(&vault, "1111111111111111111111111111111a").unwrap();
        let store = writer.store_id().to_string();
        let belief_id = schema::migrate_id(&store, "belief", "churn");
        let entity_id = schema::migrate_id(&store, "entity", "churn");
        let created = schema::BeliefCreated {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: actor(),
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.clone(),
            subject: SubjectRef::Resolved {
                entity_id,
                aliases: vec!["churn.md".into()],
            },
            content: "# churn\n".into(),
            fields: serde_json::json!({}),
            basis: BeliefBasis::Unsupported {
                reason: "seed".into(),
            },
        };
        writer
            .append(
                schema::KIND_BELIEF_CREATED,
                serde_json::to_value(&created).unwrap(),
            )
            .unwrap();
        (vault, writer, belief_id)
    }

    fn state(writer: &LedgerWriter, vault: &Path) -> EpistemicState {
        let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault)).unwrap();
        crate::ledger::reduce::reduce(&read.frames, writer.store_id())
    }

    /// Submit one proposal, commit it alone, and return what policy did.
    fn run(
        writer: &mut LedgerWriter,
        vault: &Path,
        proposal: &schema::ProposalV1,
    ) -> CommitOutcome {
        submit_proposal(&table(), writer, &actor(), proposal).unwrap();
        commit_proposals(
            &table(),
            writer,
            vault,
            &proposal.run_id,
            std::slice::from_ref(&proposal.proposal_id),
        )
        .unwrap()
    }

    fn refusal(outcome: &CommitOutcome) -> String {
        match &outcome.results[0] {
            SubmitResult::Rejected { rejection, .. } => rejection.code.as_str().to_string(),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    /// THE INVARIANT ALL FIVE SHARE.
    fn never_applied(outcome: &CommitOutcome) {
        assert_ne!(
            outcome.transition,
            TransitionCode::Apply,
            "an eval scenario auto-applied — that is a hole, not a design change"
        );
    }

    #[test]
    fn eval_false_creation_is_blocked() {
        // The agent decides something is new without looking. §15 (M24.7).
        let (vault, mut writer, _) = seeded("eval-false-creation");
        let fresh = "7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
        let p = proposal(
            P1,
            RUN,
            ProposalOp::CreateBelief {
                belief_id: fresh.into(),
                subject: SubjectRef::Resolved {
                    entity_id: "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e".into(),
                    aliases: vec!["churn.md".into()],
                },
                content: "# Churn\n".into(),
                fields: serde_json::json!({}),
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
                distinctness_reason: "I am confident this is new".into(),
            },
            vec![target(schema::TargetClass::Belief, fresh, None)],
            Risk::Low,
        );
        let outcome = run(&mut writer, &vault, &p);
        never_applied(&outcome);
        assert_eq!(refusal(&outcome), "candidate_receipt_missing");
        // Ledgered: the attempt is part of the record, not a log line.
        assert_eq!(
            state(&writer, &vault).proposals[P1].state,
            schema::ProposalState::Rejected
        );
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn eval_a_false_merge_is_never_automatic() {
        // Merging two identities is the least reversible thing the base can
        // do. The table puts entity merge on the CRITICAL rung, which means
        // a human card with a diff — never an auto-apply, whatever the agent
        // declares.
        let table = table();
        let rule = table.op("merge_entities").unwrap();
        assert_eq!(rule.base_risk, Risk::Critical);
        let rung = table.risk_ladder.get(&Risk::Critical).unwrap();
        assert_eq!(rung.apply, crate::policy::table::ApplyMode::QueuedHumanCard);
        assert_eq!(
            rung.review.as_deref(),
            Some("diff"),
            "a CRITICAL card without a diff is a yes/no button on an identity merge"
        );
        // And declaring it lower is refused rather than honoured. The plan
        // is properly sealed, so the refusal is about the RISK and not about
        // a fixture the validator would have rejected anyway.
        let (vault, mut writer, _) = seeded("eval-false-merge");
        let mut plan = schema::EntityReassignmentPlan {
            survivor_id: "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e".into(),
            merged_ids: vec!["8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e".into()],
            affected_belief_ids: vec![],
            live_aliases: vec![],
            affected_relation_ids: vec![],
            plan_digest: String::new(),
        };
        plan.plan_digest = plan.digest_of().unwrap();
        let p = proposal(
            P1,
            RUN,
            ProposalOp::MergeEntities {
                survivor_id: "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e".into(),
                merged_ids: vec!["8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e".into()],
                reassignment_plan: Box::new(plan),
            },
            vec![
                target(
                    schema::TargetClass::Entity,
                    "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e",
                    None,
                ),
                target(
                    schema::TargetClass::Entity,
                    "8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e",
                    None,
                ),
            ],
            Risk::Low,
        );
        let outcome = run(&mut writer, &vault, &p);
        never_applied(&outcome);
        assert_eq!(refusal(&outcome), "risk_lowered");
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn eval_silence_cannot_resolve_anything() {
        // "Nobody has mentioned it in 30 days, so it must be done." The
        // easiest regression a maintenance pass can introduce, and the one
        // the allowlist exists to make impossible.
        let (vault, mut writer, belief) = seeded("eval-silence");
        let mut p = proposal(
            P1,
            RUN,
            ProposalOp::TombstoneBelief {
                belief_id: belief.clone(),
                replacement_id: None,
                reason_code: schema::TombstoneReason::Invalid,
            },
            vec![target(schema::TargetClass::Belief, &belief, Some(1))],
            Risk::High,
        );
        p.basis.transition_cause = TransitionCause::ElapsedTime;
        let outcome = run(&mut writer, &vault, &p);
        never_applied(&outcome);
        assert_eq!(refusal(&outcome), "silence_transition_forbidden");
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn eval_an_agent_cannot_certify_its_own_high_stakes_claim() {
        // Self-certification: HIGH intended use, and the only thing standing
        // behind it is the agent saying so. It never auto-applies. In M24 it
        // waits for a human; when M25 registers coverage, the same code path
        // decides on evidence instead.
        let (vault, mut writer, belief) = seeded("eval-self-certification");
        let mut p = proposal(
            P1,
            RUN,
            ProposalOp::UpdateBelief {
                belief_id: belief.clone(),
                patch: vec![PatchOp {
                    field_path: "/fields/status".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("shipped"),
                }],
                basis: BeliefBasis::Unsupported {
                    reason: "I checked".into(),
                },
            },
            vec![target(schema::TargetClass::Belief, &belief, Some(1))],
            Risk::Medium,
        );
        p.intended_use.stakes = Risk::High;
        p.reason = "this is production-ready, I verified it myself".into();
        let outcome = run(&mut writer, &vault, &p);
        never_applied(&outcome);
        assert_eq!(outcome.transition, TransitionCode::InitialQueue);
        let state = state(&writer, &vault);
        assert_eq!(
            state.proposals[P1].queued_for,
            vec!["high_stakes_verification_required".to_string()],
            "and the card says why, in the table's words rather than the agent's"
        );
        assert_eq!(
            state.beliefs[&belief].current().revision,
            1,
            "nothing moved while it waits"
        );
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn eval_superseding_human_reviewed_work_waits_for_a_human() {
        // A belief a person has read and confirmed. An agent may still be
        // right about it — but not quietly, and not on its own say-so.
        let (vault, mut writer, belief) = seeded("eval-attested-supersede");
        crate::policy::commit::tests_support::attest(&mut writer, &vault, &belief);
        let successor = "7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
        let after_attestation = state(&writer, &vault)
            .version("belief", &belief)
            .expect("the belief exists");
        let p = proposal(
            P1,
            RUN,
            ProposalOp::UpdateBelief {
                belief_id: belief.clone(),
                patch: vec![PatchOp {
                    field_path: "/fields/note".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("actually, no"),
                }],
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            },
            vec![target(
                schema::TargetClass::Belief,
                &belief,
                Some(after_attestation),
            )],
            Risk::Medium,
        );
        let _ = successor;
        let outcome = run(&mut writer, &vault, &p);
        never_applied(&outcome);
        assert_eq!(outcome.transition, TransitionCode::InitialQueue);
        let SubmitResult::Queued { escalated_by, .. } = &outcome.results[0] else {
            panic!("expected a queue");
        };
        assert_eq!(escalated_by, &vec!["target_has_attestation".to_string()]);

        // The human says no, with a reason, and the refusal is durable.
        let outcome = crate::policy::review::decide(
            &mut writer,
            &vault,
            P1,
            false,
            "human:me",
            Some("I still think the original is right"),
        )
        .unwrap()
        .expect("a decided set resolves");
        assert_eq!(outcome.transition, TransitionCode::HumanReject);
        let state = state(&writer, &vault);
        assert_eq!(state.proposals[P1].state, schema::ProposalState::Rejected);
        assert_eq!(
            state.beliefs[&belief].current().revision,
            1,
            "the reviewed belief is untouched"
        );
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
