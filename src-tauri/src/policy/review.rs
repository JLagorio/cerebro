//! The review surface's read model and its three human actions (M24.9).
//!
//! **Rebuilt from the ledger, never cached.** Every card here is derived
//! from reduced state at call time, so "the app forgot what it was waiting
//! for you to approve" is impossible rather than unlikely: wiping app-data
//! changes nothing, and a queued set survives a restart because the frozen
//! member order is durable on `proposal.queued`.
//!
//! **The card says why.** Operation, target versions, effective risk,
//! intended use, structured basis, and the codes holding it — all typed,
//! none of it prose. A reviewer approving a CRITICAL change is shown the
//! diff; a reviewer rejecting one must say why, and that reason is durable.
//!
//! **Revert is a new forward mutation.** History is never rewound. Only an
//! application whose op the table calls `revert: one_click` AND whose
//! `proposal.applied` stored a `RevertPlan` can offer the action at all;
//! anything else answers `revert_not_supported`, so a button that cannot
//! work is never rendered.

use std::path::Path;

use serde::Serialize;

use crate::ledger::reduce::{EpistemicState, ProposalRow};
use crate::ledger::schema::{self, Decision, ProposalState, ProposalV1, TargetClass};
use crate::ledger::writer::LedgerWriter;

use super::commit::{self, PendingSet};
use super::table::{PolicyTable, Revert, Risk};

/// One target's expected-versus-current version, as the card shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardTarget {
    pub target_class: String,
    pub target_id: String,
    pub expected_version: Option<u64>,
    pub current_version: Option<u64>,
    /// The world moved under this card. It can still be rejected; approving
    /// it will refuse with `stale_target_version` rather than apply.
    pub stale: bool,
}

/// What a reviewer is being asked about.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewCard {
    pub proposal_id: String,
    pub commit_set_id: String,
    pub run_id: String,
    pub actor: String,
    pub op: String,
    pub effective_risk: Risk,
    /// The `risk_ladder` rung's review mode — `diff` on the CRITICAL rung.
    pub review: Option<String>,
    /// Codes holding this beyond the ladder (M24.8), e.g. an unverified
    /// high-stakes route.
    pub queued_for: Vec<String>,
    pub intended_use_kind: String,
    pub intended_use_stakes: Risk,
    pub transition_cause: String,
    pub evidence_refs: Vec<String>,
    pub coverage_refs: Vec<String>,
    pub authority_refs: Vec<String>,
    pub targets: Vec<CardTarget>,
    /// Display text. Never a policy input — shown, never read by a rule.
    pub reason: String,
    /// The whole set moves together; a reviewer deciding one is deciding a
    /// member of this list.
    pub set_members: Vec<String>,
    /// Every member of this set has a decision, so it can be resolved.
    pub set_ready: bool,
}

/// An applied proposal a human may still undo.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RevertableApplication {
    pub proposal_id: String,
    pub op: String,
    /// The `proposal.applied` event the caller hands back, so the server
    /// can prove it is reverting the application it was shown.
    pub applied_event_id: String,
    pub reason: String,
}

fn card_of(
    table: &PolicyTable,
    state: &EpistemicState,
    row: &ProposalRow,
    set: &PendingSet,
    decided: &std::collections::BTreeSet<String>,
) -> ReviewCard {
    let proposal: &ProposalV1 = &row.proposal;
    let risk = row.queued_risk.unwrap_or(proposal.declared_risk);
    ReviewCard {
        proposal_id: proposal.proposal_id.clone(),
        commit_set_id: set.commit_set_id.clone(),
        run_id: set.run_id.clone(),
        actor: row.actor.clone(),
        op: proposal.op.kind().to_string(),
        effective_risk: risk,
        review: table
            .risk_ladder
            .get(&risk)
            .and_then(|rung| rung.review.clone()),
        queued_for: row.queued_for.clone(),
        intended_use_kind: format!("{:?}", proposal.intended_use.kind),
        intended_use_stakes: proposal.intended_use.stakes,
        transition_cause: proposal.basis.transition_cause.as_str().to_string(),
        evidence_refs: proposal.basis.evidence_refs.clone(),
        coverage_refs: proposal.basis.coverage_refs.clone(),
        authority_refs: proposal.basis.authority_refs.clone(),
        targets: proposal
            .targets
            .iter()
            .map(|target| {
                let current = state.version(target.target_class.as_str(), &target.target_id);
                CardTarget {
                    target_class: target.target_class.as_str().to_string(),
                    target_id: target.target_id.clone(),
                    expected_version: target.expected_version,
                    current_version: current,
                    stale: target.expected_version != current,
                }
            })
            .collect(),
        reason: proposal.reason.clone(),
        set_members: set.ordered_proposal_ids.clone(),
        set_ready: set
            .ordered_proposal_ids
            .iter()
            .all(|id| decided.contains(id)),
    }
}

/// Every card awaiting a human, oldest set first.
pub fn needs_review(table: &PolicyTable, state: &EpistemicState) -> Vec<ReviewCard> {
    let mut cards = Vec::new();
    for set in commit::pending_sets(state) {
        let decided: std::collections::BTreeSet<String> = set
            .ordered_proposal_ids
            .iter()
            .filter(|id| {
                state
                    .proposals
                    .get(*id)
                    .is_some_and(|row| row.decision.is_some())
            })
            .cloned()
            .collect();
        for id in &set.ordered_proposal_ids {
            if let Some(row) = state.proposals.get(id) {
                if row.state == ProposalState::Queued {
                    cards.push(card_of(table, state, row, &set, &decided));
                }
            }
        }
    }
    cards
}

/// Applications a human may undo: the table calls the op `one_click` AND
/// the application stored a plan. Both, or no button.
pub fn revertable(table: &PolicyTable, state: &EpistemicState) -> Vec<RevertableApplication> {
    state
        .proposals
        .values()
        .filter(|row| row.state == ProposalState::Applied)
        .filter(|row| {
            table
                .op(row.proposal.op.kind())
                .is_some_and(|rule| rule.revert == Revert::OneClick)
                && row.revert_plan.is_some()
        })
        .filter_map(|row| {
            Some(RevertableApplication {
                proposal_id: row.proposal.proposal_id.clone(),
                op: row.proposal.op.kind().to_string(),
                applied_event_id: row.applied_event_id.clone()?,
                reason: row.proposal.reason.clone(),
            })
        })
        .collect()
}

// --- The three actions -----------------------------------------------------

fn state_of(writer: &LedgerWriter, vault: &Path) -> Result<EpistemicState, String> {
    let read =
        crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault)).map_err(|e| e.to_string())?;
    Ok(crate::ledger::reduce::reduce(
        &read.frames,
        writer.store_id(),
    ))
}

/// Record a human decision, and resolve the set the moment its last member
/// has one.
///
/// Deciding and resolving are ONE call because a half-decided set is not a
/// state a user can act on: they clicked approve on the last card, and the
/// set either applies or says why it cannot. A rejection needs a reason —
/// "no" without one is the shape a reviewer cannot learn from later.
pub fn decide(
    writer: &mut LedgerWriter,
    vault: &Path,
    proposal_id: &str,
    approve: bool,
    reviewer: &str,
    reason: Option<&str>,
) -> Result<Option<commit::CommitOutcome>, String> {
    let decision = if approve {
        Decision::Approve
    } else {
        Decision::Reject
    };
    if !approve && reason.map(str::trim).unwrap_or("").is_empty() {
        return Err("a rejection needs a reason".to_string());
    }
    let table = PolicyTable::load()?;
    let decided_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    commit::record_decision(
        writer,
        vault,
        proposal_id,
        decision,
        reviewer,
        reason,
        &decided_at,
    )
    .map_err(|e| e.detail)?;

    // The set the decided proposal belongs to, and whether it is complete.
    let state = state_of(writer, vault)?;
    let Some(set) = commit::pending_sets(&state)
        .into_iter()
        .find(|set| set.ordered_proposal_ids.iter().any(|id| id == proposal_id))
    else {
        return Ok(None);
    };
    let complete = set.ordered_proposal_ids.iter().all(|id| {
        state
            .proposals
            .get(id)
            .is_some_and(|row| row.decision.is_some())
    });
    if !complete {
        return Ok(None);
    }
    commit::resolve_commit_set(
        &table,
        writer,
        vault,
        &set.run_id,
        &set.ordered_proposal_ids,
    )
    .map(Some)
    .map_err(|e| e.detail)
}

/// Undo an applied change by appending a NEW forward mutation.
///
/// The caller hands back the applied event ids it was shown; the server
/// loads the stored plan and refuses anything it cannot invert. Nothing is
/// rewound — the original application stays in the ledger, and the revert is
/// another thing that happened.
pub fn revert(
    writer: &mut LedgerWriter,
    vault: &Path,
    proposal_id: &str,
    applied_event_ids: &[String],
    actor: &str,
) -> Result<commit::CommitOutcome, String> {
    let table = PolicyTable::load()?;
    let state = state_of(writer, vault)?;
    let row = state
        .proposals
        .get(proposal_id)
        .ok_or_else(|| format!("no applied proposal {proposal_id}"))?;
    let run_id = schema::sha256_first128(
        format!(
            "cerebro-revert-run-v1\0{proposal_id}\0{}",
            row.proposal.run_id
        )
        .as_bytes(),
    );
    let revert_id = schema::sha256_first128(
        format!(
            "cerebro-revert-op-v1\0{proposal_id}\0{}",
            applied_event_ids.join(",")
        )
        .as_bytes(),
    );
    let op = schema::ProposalOp::RevertProposal {
        applied_proposal_id: proposal_id.to_string(),
        applied_event_ids: applied_event_ids.to_vec(),
    };
    // The caller hands back what it was shown. If that is not the
    // application currently on record, it is reverting something else.
    if row.applied_event_id.as_deref() != applied_event_ids.first().map(String::as_str)
        || applied_event_ids.len() != 1
    {
        return Err("revert_not_current: this is not the application on record".to_string());
    }
    let base = table
        .op(op.kind())
        .ok_or_else(|| format!("{} is not in the policy table", op.kind()))?
        .base_risk;
    let mut proposal = fixtures_free::revert_proposal(&revert_id, &run_id, op, base);
    // The revert's targets are the application's own, re-pinned to now: the
    // plan restores exactly what it changed.
    proposal.targets = row
        .proposal
        .targets
        .iter()
        .map(|target| schema::ProposalTarget {
            target_id: target.target_id.clone(),
            target_class: target.target_class,
            expected_version: state.version(target.target_class.as_str(), &target.target_id),
        })
        // ...plus the application itself, which the revert also moves.
        .chain(std::iter::once(schema::ProposalTarget {
            target_id: proposal_id.to_string(),
            target_class: TargetClass::Proposal,
            expected_version: state.version("proposal", proposal_id),
        }))
        .collect();
    proposal.targets.sort_by(|a, b| {
        (a.target_class, a.target_id.as_str()).cmp(&(b.target_class, b.target_id.as_str()))
    });

    let actor = schema::Actor {
        id: actor.to_string(),
    };
    commit::submit_proposal(&table, writer, &actor, &proposal).map_err(|e| e.detail)?;
    commit::commit_proposals(&table, writer, vault, &run_id, &[revert_id]).map_err(|e| e.detail)
}

/// The one proposal this module builds. Kept beside the action that needs
/// it rather than in the test fixtures, because a revert is a real
/// server-authored proposal and not a synthetic one.
mod fixtures_free {
    use crate::ledger::schema::{
        IntendedUse, IntendedUseKind, ProposalBasis, ProposalOp, ProposalV1, TransitionCause,
        PROPOSAL_SCHEMA,
    };

    use crate::policy::table::Risk;

    pub fn revert_proposal(
        proposal_id: &str,
        run_id: &str,
        op: ProposalOp,
        declared_risk: Risk,
    ) -> ProposalV1 {
        ProposalV1 {
            schema: PROPOSAL_SCHEMA,
            proposal_id: proposal_id.to_string(),
            run_id: run_id.to_string(),
            targets: Vec::new(),
            op,
            intended_use: IntendedUse {
                kind: IntendedUseKind::ReversibleWork,
                stakes: Risk::Low,
                predicate_class: None,
            },
            basis: ProposalBasis {
                // The cause IS revert: a stored inverse is not new evidence,
                // and calling it that would let a revert masquerade as a
                // fresh finding in the record.
                transition_cause: TransitionCause::Revert,
                evidence_refs: vec![],
                coverage_refs: vec![],
                authority_refs: vec![],
                authority_route_refs: vec![],
                addressed_contradictions: vec![],
                absence_claim: false,
            },
            declared_risk,
            reason: "a human undid this from the review surface".to_string(),
            candidate_search_receipt: None,
        }
    }
}

/// Read the review surface for a vault through the active writer.
pub fn cards(vault: &Path) -> Result<Vec<ReviewCard>, String> {
    let table = PolicyTable::load()?;
    crate::ledger::shadow::with_writer(vault, |writer| {
        let state = state_of(writer, vault)?;
        Ok(needs_review(&table, &state))
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
}

/// Read the revertable applications for a vault.
pub fn undoable(vault: &Path) -> Result<Vec<RevertableApplication>, String> {
    let table = PolicyTable::load()?;
    crate::ledger::shadow::with_writer(vault, |writer| {
        let state = state_of(writer, vault)?;
        Ok(revertable(&table, &state))
    })
    .unwrap_or_else(|| Err("no active ledger writer for this vault".to_string()))
}

/// The target-class vocabulary the card renders, so a UI never invents one.
pub fn target_classes() -> Vec<&'static str> {
    TargetClass::ALL.iter().map(|c| c.as_str()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{BeliefBasis, PatchOp, ProposalOp, SubjectRef, TypedValue};
    use crate::policy::commit::{commit_proposals, submit_proposal, TransitionCode};
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::submit::SubmitResult;
    use crate::vault::testutil;

    const RUN: &str = "9111111111111111111111111111111f";
    const P1: &str = "0000000000000000000000000000000a";
    const P2: &str = "0000000000000000000000000000000b";
    const REVIEWER: &str = "human:me";

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    fn actor() -> schema::Actor {
        schema::Actor {
            id: "agent:test".into(),
        }
    }

    /// A vault with one committed Belief.
    fn seeded(name: &str) -> (std::path::PathBuf, LedgerWriter, String) {
        let vault = testutil::temp_vault(name);
        let mut writer = LedgerWriter::open(&vault, "1111111111111111111111111111111a").unwrap();
        let store = writer.store_id().to_string();
        let belief_id = schema::migrate_id(&store, "belief", "seed");
        let entity_id = schema::migrate_id(&store, "entity", "seed");
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
                aliases: vec!["seed.md".into()],
            },
            content: "# seed\n".into(),
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

    fn update(belief: &str, value: &str) -> ProposalOp {
        ProposalOp::UpdateBelief {
            belief_id: belief.to_string(),
            patch: vec![PatchOp {
                field_path: "/fields/note".into(),
                before: TypedValue::Missing,
                after: TypedValue::string(value),
            }],
            basis: BeliefBasis::Unsupported {
                reason: "seed".into(),
            },
        }
    }

    fn folded(writer: &LedgerWriter, vault: &Path) -> EpistemicState {
        state_of(writer, vault).unwrap()
    }

    /// Queue one HIGH proposal and return the vault, writer, and belief.
    fn queued(name: &str) -> (std::path::PathBuf, LedgerWriter, String) {
        let (vault, mut writer, belief) = seeded(name);
        let p = proposal(
            P1,
            RUN,
            ProposalOp::TombstoneBelief {
                belief_id: belief.clone(),
                replacement_id: None,
                reason_code: schema::TombstoneReason::Invalid,
            },
            vec![target(TargetClass::Belief, &belief, Some(1))],
            Risk::High,
        );
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();
        let outcome =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::InitialQueue);
        (vault, writer, belief)
    }

    #[test]
    fn a_card_says_what_is_being_asked_and_survives_a_restart() {
        // NOTHING IS CACHED. The card is rebuilt from the ledger every
        // time, which is what makes "the app forgot what it was waiting for
        // you to approve" impossible rather than unlikely.
        let (vault, writer, belief) = queued("review-card");
        let cards = needs_review(&table(), &folded(&writer, &vault));
        assert_eq!(cards.len(), 1);
        let card = &cards[0];
        assert_eq!(card.op, "tombstone_belief");
        assert_eq!(card.effective_risk, Risk::High);
        assert_eq!(card.targets[0].target_id, belief);
        assert_eq!(card.targets[0].expected_version, Some(1));
        assert!(!card.targets[0].stale);
        assert!(!card.set_ready, "nobody has decided anything yet");

        // Drop the writer entirely and rebuild: same card.
        drop(writer);
        let writer = LedgerWriter::open(&vault, "1111111111111111111111111111111a").unwrap();
        assert_eq!(needs_review(&table(), &folded(&writer, &vault)), cards);
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn approving_the_last_member_resolves_the_set() {
        let (vault, mut writer, belief) = queued("review-approve");
        let outcome = decide(&mut writer, &vault, P1, true, REVIEWER, None)
            .unwrap()
            .expect("the last decision resolves");
        assert_eq!(outcome.transition, TransitionCode::Apply);
        let state = folded(&writer, &vault);
        assert!(state.beliefs[&belief].tombstoned_by.is_some());
        assert!(needs_review(&table(), &state).is_empty());
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_rejection_without_a_reason_is_refused_before_anything_is_written() {
        // "No" with no reason is the shape nobody can learn from later.
        let (vault, mut writer, _) = queued("review-reason");
        let before = folded(&writer, &vault).proposals[P1].clone();
        assert!(decide(&mut writer, &vault, P1, false, REVIEWER, None)
            .unwrap_err()
            .contains("reason"));
        assert!(
            decide(&mut writer, &vault, P1, false, REVIEWER, Some("   "))
                .unwrap_err()
                .contains("reason")
        );
        assert_eq!(folded(&writer, &vault).proposals[P1], before);

        let outcome = decide(
            &mut writer,
            &vault,
            P1,
            false,
            REVIEWER,
            Some("not while it is still cited"),
        )
        .unwrap()
        .expect("a decided set resolves");
        assert_eq!(outcome.transition, TransitionCode::HumanReject);
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_card_whose_world_moved_says_so_before_anyone_clicks() {
        // The stale card is VISIBLE with both versions, and approving it
        // refuses rather than applying against a world nobody looked at.
        let (vault, mut writer, belief) = queued("review-stale");
        // Something else revises the belief while the card waits.
        let p = proposal(
            P2,
            "8222222222222222222222222222222e",
            update(&belief, "moved"),
            vec![target(TargetClass::Belief, &belief, Some(1))],
            Risk::Medium,
        );
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();
        commit_proposals(
            &table(),
            &mut writer,
            &vault,
            "8222222222222222222222222222222e",
            &[P2.to_string()],
        )
        .unwrap();

        let card = needs_review(&table(), &folded(&writer, &vault))
            .into_iter()
            .next()
            .unwrap();
        assert!(card.targets[0].stale);
        assert_eq!(card.targets[0].expected_version, Some(1));
        assert_eq!(card.targets[0].current_version, Some(2));

        let outcome = decide(&mut writer, &vault, P1, true, REVIEWER, None)
            .unwrap()
            .unwrap();
        assert_eq!(outcome.transition, TransitionCode::StaleReject);
        let SubmitResult::Rejected { rejection, .. } = &outcome.results[0] else {
            panic!("expected a stale refusal");
        };
        assert_eq!(rejection.code.as_str(), "stale_target_version");
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn only_an_invertible_application_offers_the_button() {
        let (vault, mut writer, belief) = seeded("review-revert");
        let p = proposal(
            P1,
            RUN,
            update(&belief, "x"),
            vec![target(TargetClass::Belief, &belief, Some(1))],
            Risk::Medium,
        );
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();
        commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();

        let offered = revertable(&table(), &folded(&writer, &vault));
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].op, "update_belief");

        let outcome = revert(
            &mut writer,
            &vault,
            P1,
            &[offered[0].applied_event_id.clone()],
            REVIEWER,
        )
        .unwrap();
        assert_eq!(outcome.transition, TransitionCode::Apply);
        let state = folded(&writer, &vault);
        // A NEW forward mutation: revision 3 undoes revision 2, and nothing
        // was rewound.
        assert_eq!(state.beliefs[&belief].current().revision, 3);
        assert!(
            revertable(&table(), &state)
                .iter()
                .all(|r| r.proposal_id != P1),
            "an application already reverted is not offered again"
        );
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn reverting_something_other_than_the_application_on_record_is_refused() {
        let (vault, mut writer, belief) = seeded("review-revert-wrong");
        let p = proposal(
            P1,
            RUN,
            update(&belief, "x"),
            vec![target(TargetClass::Belief, &belief, Some(1))],
            Risk::Medium,
        );
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();
        commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        let error = revert(&mut writer, &vault, P1, &["0".repeat(32)], REVIEWER).unwrap_err();
        assert!(error.contains("revert_not_current"), "{error}");
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_non_invertible_op_is_never_offered() {
        // The table decides, not the UI: a tombstone stores no inverse, so
        // no button exists and there is nothing to click by mistake.
        let (vault, mut writer, _) = queued("review-noninvertible");
        decide(&mut writer, &vault, P1, true, REVIEWER, None).unwrap();
        let state = folded(&writer, &vault);
        assert_eq!(state.proposals[P1].state, ProposalState::Applied);
        assert!(state.proposals[P1].revert_plan.is_none());
        assert!(revertable(&table(), &state).is_empty());
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
