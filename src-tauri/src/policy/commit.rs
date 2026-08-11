//! The commit-set protocol (M24.4): accumulation keyed by run, and five
//! all-or-nothing transitions.
//!
//! **A commit set is a unit of trust, not a convenience.** An agent that
//! proposes "supersede A, then create B that refines A" means both or
//! neither; applying the LOW half while the HIGH half waits for a human
//! would leave the vault in a state nobody proposed and nobody approved.
//! So every member of a mixed-risk set is queued, one refusal refuses all,
//! and each transition is exactly one M22 logical batch — members are
//! reducer-invisible until the `batch.committed` marker is fsynced, which is
//! what makes "no crash can expose a partial commit-set state" a property of
//! the write protocol rather than a hope about timing.
//!
//! Accumulation needs no process-global registry: `proposal.submitted`
//! stores the proposal whole, and a run's members are the submitted
//! proposals carrying its `run_id`. A run that dies before its terminal
//! commit therefore applies nothing — its proposals simply sit in
//! `submitted` forever, inspectable, having mutated nothing.
//!
//! Which refusals can appear here is settled by destiny, not by taste. A
//! refusal with OPERATIONAL destiny (a capability gap, malformed arguments)
//! happens at SUBMIT time and never becomes a durable proposal; by the time
//! a proposal is in a commit set, every refusal it can earn is ledger-bound.
//! That is why `commit_proposals` never has to ask whether a rejection
//! belongs in the vault's history.

use std::path::Path;

use crate::ledger::reduce::{reduce, EpistemicState};
use crate::ledger::schema::sha256_first128;
use crate::ledger::schema::{
    self, Actor, Decision, ProposalApplied, ProposalDecisionRecorded, ProposalQueued,
    ProposalRejected, ProposalReverted, ProposalState, ProposalSubmitted, ProposalV1, RevertPlan,
    TargetClass, TargetVersion, TypedValue,
};
use crate::ledger::writer::{member_ref, operation_digest, LedgerWriter};
use crate::ledger::{ledger_dir, read_ledger};

use super::expand::{expand, ExpandError, ExpansionContext};
use super::interpreter::facts_at;
use super::preconditions::{self, PreconditionFailure};
use super::qualification;
use super::rejection::{OperationalRefusal, Rejection};
use super::submit::{rule_for, SubmitError, SubmitResult};
use super::table::{Destiny, PolicyTable, Revert};
use super::verdict::{table_verdict, Verdict};

/// The five transitions a commit set can make. Each is one `append_batch`
/// under its own stable operation key, so an acknowledgement-loss retry
/// replays the exact transition it lost rather than inventing a new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionCode {
    InitialQueue,
    InitialReject,
    HumanReject,
    StaleReject,
    Apply,
}

impl TransitionCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TransitionCode::InitialQueue => "initial_queue",
            TransitionCode::InitialReject => "initial_reject",
            TransitionCode::HumanReject => "human_reject",
            TransitionCode::StaleReject => "stale_reject",
            TransitionCode::Apply => "apply",
        }
    }

    pub const ALL: [TransitionCode; 5] = [
        TransitionCode::InitialQueue,
        TransitionCode::InitialReject,
        TransitionCode::HumanReject,
        TransitionCode::StaleReject,
        TransitionCode::Apply,
    ];
}

/// What a terminal commit did.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitOutcome {
    pub commit_set_id: String,
    pub transition: TransitionCode,
    /// One typed result per member, in set order.
    pub results: Vec<SubmitResult>,
    pub batch_id: String,
    /// True when this call replayed an already committed transition — an
    /// acknowledgement-loss retry, answered from the ledger.
    pub replayed: bool,
}

/// The commit set's identity: the run plus the frozen ordered member list.
/// Two different orders are two different sets, because the apply batch's
/// member order is the order proposals were committed in.
pub fn derive_commit_set_id(run_id: &str, ordered: &[String]) -> String {
    let tuple = serde_json::to_string(&serde_json::json!([run_id, ordered]))
        .expect("strings always serialize");
    let mut bytes = Vec::with_capacity(b"cerebro-commit-set-v1\0".len() + tuple.len());
    bytes.extend_from_slice(b"cerebro-commit-set-v1\0");
    bytes.extend_from_slice(tuple.as_bytes());
    sha256_first128(&bytes)
}

/// The stable operation key for one transition of one set.
///
/// The causal decision ids are what make a human transition distinguishable
/// from a machine one over the same set: rejecting after review is not the
/// same operation as refusing at submission, even though both refuse every
/// member. They are sorted so the key does not depend on the order decisions
/// happened to be read in.
pub fn operation_key(
    commit_set_id: &str,
    transition: TransitionCode,
    causal_decision_ids: &[String],
) -> String {
    let mut decisions: Vec<&str> = causal_decision_ids.iter().map(String::as_str).collect();
    decisions.sort_unstable();
    decisions.dedup();
    let tuple = serde_json::to_string(&serde_json::json!([
        commit_set_id,
        transition.as_str(),
        decisions
    ]))
    .expect("strings always serialize");
    let mut bytes = Vec::with_capacity(b"cerebro-commit-op-v1\0".len() + tuple.len());
    bytes.extend_from_slice(b"cerebro-commit-op-v1\0");
    bytes.extend_from_slice(tuple.as_bytes());
    format!("commit-set-v1:{}", sha256_first128(&bytes))
}

fn state_of(writer: &LedgerWriter, vault: &Path) -> Result<EpistemicState, SubmitError> {
    let read = read_ledger(&ledger_dir(vault)).map_err(|e| SubmitError {
        code: "malformed_arguments",
        detail: e.to_string(),
    })?;
    Ok(reduce(&read.frames, writer.store_id()))
}

fn internal(detail: impl Into<String>) -> SubmitError {
    SubmitError {
        code: "malformed_arguments",
        detail: detail.into(),
    }
}

fn common(actor: &Actor) -> (u64, Option<String>, Option<String>, Actor) {
    (schema::BODY_SCHEMA, None, None, actor.clone())
}

/// The system actor every protocol event commits under. A queue, a
/// rejection, and an application are the LEDGER's acts; the human's act is
/// the decision, and that one carries a reviewer.
fn protocol_actor() -> Actor {
    Actor {
        id: "system:policy".to_string(),
    }
}

// --- Submission ------------------------------------------------------------

/// Durably submit one proposal into its run.
///
/// The table-only verdict runs FIRST, and an operational-destiny refusal
/// returns here without appending anything: a capability this build does not
/// have is a fact about the build, not an epistemic event, and writing it
/// into the vault's permanent history would be exactly the "when in doubt,
/// operational" rule inverted.
pub fn submit_proposal(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    actor: &Actor,
    proposal: &ProposalV1,
) -> Result<String, SubmitError> {
    proposal.validate().map_err(SubmitError::schema_invalid)?;
    let facts = super::submit::facts_of(table, proposal)?;
    if let Verdict::Rejected { rejection, .. } =
        table_verdict(table, &facts).map_err(|e| internal(format!("{e:?}")))?
    {
        if rejection.destiny == Destiny::Operational {
            let refusal = OperationalRefusal::new(
                table,
                &rejection.code,
                "policy::submit",
                format!("{} refused {}", proposal.op.kind(), rejection.code),
            )
            .map_err(internal)?;
            crate::runtime::sink::record(
                &refusal,
                &crate::runtime::operational::LogEntry::in_store(writer.store_id()),
            );
            return Err(SubmitError {
                code: leaked(&rejection.code),
                detail: format!(
                    "{}: {} — refused before submission, operational destiny",
                    proposal.op.kind(),
                    rejection.code
                ),
            });
        }
    }
    // The SUBMITTER's actor, so the mutations this proposal eventually
    // performs are attributed to whoever proposed them.
    let (schema_v, batch_id, key, actor) = common(actor);
    let body = ProposalSubmitted {
        schema: schema_v,
        batch_id,
        idempotency_key: key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        proposal: Box::new(proposal.clone()),
    };
    writer
        .append_once(
            &proposal.proposal_id,
            schema::KIND_PROPOSAL_SUBMITTED,
            serde_json::to_value(&body).map_err(|e| internal(e.to_string()))?,
        )
        .map_err(internal)?;
    Ok(proposal.proposal_id.clone())
}

/// `SubmitError.code` is `&'static str`; the table's codes are owned. Only
/// the operational ones can reach here, and they are a closed set.
fn leaked(code: &str) -> &'static str {
    match code {
        "capability_unavailable" => "capability_unavailable",
        "idempotency_key_reused" => "idempotency_key_reused",
        "internal_cas_race" => "internal_cas_race",
        "run_actor_mismatch" => "run_actor_mismatch",
        "schema_invalid" => "schema_invalid",
        _ => "malformed_arguments",
    }
}

// --- The terminal commit ----------------------------------------------------

/// Freeze a run's ordered members and decide the whole set against ONE
/// reducer snapshot.
pub fn commit_proposals(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    vault: &Path,
    run_id: &str,
    ordered_proposal_ids: &[String],
) -> Result<CommitOutcome, SubmitError> {
    if ordered_proposal_ids.is_empty() {
        return Err(internal("a commit set with no members is not a set"));
    }
    let state = state_of(writer, vault)?;
    let commit_set_id = derive_commit_set_id(run_id, ordered_proposal_ids);

    let mut members: Vec<ProposalV1> = Vec::with_capacity(ordered_proposal_ids.len());
    let mut actors: Vec<Actor> = Vec::with_capacity(ordered_proposal_ids.len());
    for id in ordered_proposal_ids {
        let row = state
            .proposals
            .get(id)
            .ok_or_else(|| internal(format!("proposal {id} was never submitted")))?;
        if row.proposal.run_id != run_id {
            // A proposal from another run in this set would let one run
            // commit another's work under a set id neither agreed to.
            return Err(SubmitError {
                code: "run_actor_mismatch",
                detail: format!("proposal {id} belongs to run {}", row.proposal.run_id),
            });
        }
        if row.state != ProposalState::Submitted {
            return Err(internal(format!(
                "proposal {id} is {:?} — only a submitted proposal can enter a commit set",
                row.state
            )));
        }
        members.push((*row.proposal).clone());
        actors.push(Actor {
            id: row.actor.clone(),
        });
    }

    // A run has one actor; a set that mixed two would let one producer
    // commit another's work under a set id neither agreed to.
    if let Err(failure) =
        preconditions::actor_matches_run(&actors.iter().map(|a| a.id.clone()).collect::<Vec<_>>())
    {
        return Err(SubmitError {
            code: "run_actor_mismatch",
            detail: format!("{:?} != {:?}", failure.expected, failure.actual),
        });
    }

    // ONE snapshot decides the whole set: the table verdict first, then the
    // state-dependent predicates the table's `requires` list names.
    let catalog = qualification::Catalog::new(vault, writer.store_id());
    let mut verdicts = Vec::with_capacity(members.len());
    let mut failure: Option<(usize, Box<PreconditionFailure>)> = None;
    // The target-binding predicate expands each member to learn what it
    // WRITES, so it needs the same staged sets the real expansion gets —
    // accumulated in member order, after each member's own turn, so a create
    // does not see itself staged.
    let mut staged_beliefs: std::collections::BTreeSet<String> = Default::default();
    let mut staged_entities: std::collections::BTreeSet<String> = Default::default();
    for (index, proposal) in members.iter().enumerate() {
        let facts = facts_at(table, &state, proposal)?;
        let verdict = table_verdict(table, &facts).map_err(|e| internal(format!("{e:?}")))?;
        if verdict.rejection().is_none() && failure.is_none() {
            let binding = preconditions::TargetBinding {
                actor: &actors[index],
                staged_beliefs: &staged_beliefs,
                staged_entities: &staged_entities,
                decision_event_id: None,
            };
            if let Err(precondition) =
                preconditions::check(table, &state, &catalog, proposal, &binding)
            {
                failure = Some((index, precondition));
            }
        }
        stage_created(&proposal.op, &mut staged_beliefs, &mut staged_entities);
        verdicts.push(verdict);
    }
    if let Some((culprit, precondition)) = failure {
        return reject_precondition(
            table,
            writer,
            &commit_set_id,
            &members,
            culprit,
            *precondition,
            TransitionCode::InitialReject,
        );
    }

    if verdicts.iter().any(|v| v.rejection().is_some()) {
        return reject_set(
            table,
            writer,
            &commit_set_id,
            &members,
            &verdicts,
            TransitionCode::InitialReject,
            None,
            None,
        );
    }
    // THE HIGH-STAKES STOPPING RULE (M24.8). Its refusals already ran as a
    // precondition; what is left is its third outcome, which is a QUEUE and
    // therefore a verdict. Applying it here — where verdicts are decided —
    // is what makes "structurally valid but unverified" one answer instead
    // of a branch each call site picks.
    let queued_for = stopping_rule(table, &state, &members, &mut verdicts);

    if verdicts.iter().any(|v| matches!(v, Verdict::Queued { .. })) {
        return queue_set(
            table,
            writer,
            &state,
            &commit_set_id,
            &members,
            &verdicts,
            &queued_for,
        );
    }
    apply_set(
        table,
        writer,
        vault,
        &state,
        &commit_set_id,
        &members,
        &actors,
        &verdicts,
        TransitionCode::Apply,
    )
}

/// The high-stakes stopping rule, applied to a decided set.
///
/// Returns, per member, the table codes holding it — and upgrades an
/// otherwise-applying verdict to a queue. It never downgrades: a member
/// already queued or rejected keeps its verdict, because the stopping rule
/// adds a reason to wait, never a reason to proceed.
fn stopping_rule(
    table: &PolicyTable,
    state: &EpistemicState,
    members: &[ProposalV1],
    verdicts: &mut [Verdict],
) -> Vec<Vec<String>> {
    let mut reasons = vec![Vec::new(); members.len()];
    for (index, proposal) in members.iter().enumerate() {
        let super::coverage::HighStakes::Queue(code) =
            super::coverage::high_stakes(table, state, proposal)
        else {
            continue;
        };
        reasons[index] = vec![code.to_string()];
        if let Verdict::Applied { risk } = &verdicts[index] {
            verdicts[index] = Verdict::Queued {
                risk: risk.clone(),
                // The rung's own review mode, so a card forced to wait by
                // the stopping rule renders the same way as one the ladder
                // queued at that risk.
                review: table
                    .risk_ladder
                    .get(&risk.risk)
                    .and_then(|rung| rung.review.clone()),
            };
        }
    }
    reasons
}

/// A queued set, as the review surface finds it after a restart.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingSet {
    pub commit_set_id: String,
    pub run_id: String,
    /// The frozen order the set's id was derived from.
    pub ordered_proposal_ids: Vec<String>,
}

/// Every commit set currently awaiting decisions, rebuilt from the ledger.
///
/// This is what makes "the app forgot what it was waiting for you to
/// approve" impossible rather than unlikely: nothing here consults the
/// runtime DB, so a wiped app-data directory changes nothing.
pub fn pending_sets(state: &EpistemicState) -> Vec<PendingSet> {
    let mut sets: Vec<PendingSet> = Vec::new();
    for row in state.proposals.values() {
        if row.state != ProposalState::Queued {
            continue;
        }
        let Some(commit_set_id) = row.commit_set_id.clone() else {
            continue;
        };
        if sets.iter().any(|set| set.commit_set_id == commit_set_id) {
            continue;
        }
        sets.push(PendingSet {
            commit_set_id,
            run_id: row.proposal.run_id.clone(),
            ordered_proposal_ids: row.queued_members.clone(),
        });
    }
    sets
}

/// Record one human decision. Idempotent per proposal: the same reviewer
/// answering twice returns the first decision rather than recording a second.
pub fn record_decision(
    writer: &mut LedgerWriter,
    vault: &Path,
    proposal_id: &str,
    decision: Decision,
    reviewer: &str,
    reason: Option<&str>,
    decided_at: &str,
) -> Result<String, SubmitError> {
    let state = state_of(writer, vault)?;
    let row = state
        .proposals
        .get(proposal_id)
        .ok_or_else(|| internal(format!("proposal {proposal_id} was never submitted")))?;
    if let Some((existing, _)) = &row.decision {
        return Ok(existing.clone());
    }
    // The decision id is derived, not minted: a retry after a lost
    // acknowledgement produces the same id and replays through the same key.
    let decision_id = sha256_first128(
        format!("cerebro-decision-v1\0{proposal_id}\0{reviewer}\0{decided_at}").as_bytes(),
    );
    let reviewed_target_versions = target_versions(&state, &row.proposal);
    let (schema_v, batch_id, key, _) = common(&protocol_actor());
    let body = ProposalDecisionRecorded {
        schema: schema_v,
        batch_id,
        idempotency_key: key,
        // A decision is the HUMAN's act, so it carries the human.
        actor: Actor {
            id: reviewer.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        decision_id: decision_id.clone(),
        proposal_id: proposal_id.to_string(),
        decision,
        reviewer: reviewer.to_string(),
        decided_at: decided_at.to_string(),
        reason: reason.map(str::to_string),
        reviewed_target_versions,
    };
    body.validate().map_err(SubmitError::schema_invalid)?;
    writer
        .append_once(
            &format!("decision-v1:{decision_id}"),
            schema::KIND_PROPOSAL_DECISION_RECORDED,
            serde_json::to_value(&body).map_err(|e| internal(e.to_string()))?,
        )
        .map_err(internal)?;
    Ok(decision_id)
}

/// Apply — or terminally reject — a queued set, once its decisions exist.
pub fn resolve_commit_set(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    vault: &Path,
    run_id: &str,
    ordered_proposal_ids: &[String],
) -> Result<CommitOutcome, SubmitError> {
    let state = state_of(writer, vault)?;
    let commit_set_id = derive_commit_set_id(run_id, ordered_proposal_ids);
    let mut members = Vec::with_capacity(ordered_proposal_ids.len());
    let mut actors: Vec<Actor> = Vec::with_capacity(ordered_proposal_ids.len());
    let mut decisions = Vec::new();
    for id in ordered_proposal_ids {
        let row = state
            .proposals
            .get(id)
            .ok_or_else(|| internal(format!("proposal {id} was never submitted")))?;
        if row.state != ProposalState::Queued {
            return Err(internal(format!(
                "proposal {id} is {:?}, not queued — there is nothing to resolve",
                row.state
            )));
        }
        if row.commit_set_id.as_deref() != Some(commit_set_id.as_str()) {
            return Err(internal(format!(
                "proposal {id} is queued under a different commit set"
            )));
        }
        members.push((*row.proposal).clone());
        actors.push(Actor {
            id: row.actor.clone(),
        });
        decisions.push(row.decision.clone());
    }

    // One rejection rejects the set, and it is the HUMAN transition — a
    // different operation key from the same set refused at submission.
    if let Some(position) = decisions
        .iter()
        .position(|d| matches!(d, Some((_, Decision::Reject))))
    {
        let (decision_id, _) = decisions[position].clone().expect("just matched");
        let mut verdicts = Vec::with_capacity(members.len());
        for (index, proposal) in members.iter().enumerate() {
            verdicts.push(if index == position {
                Verdict::Rejected {
                    rejection: super::verdict::Rejection {
                        code: "human_rejected".to_string(),
                        destiny: Destiny::Ledger,
                    },
                    risk: None,
                }
            } else {
                let facts = facts_at(table, &state, proposal)?;
                table_verdict(table, &facts).map_err(|e| internal(format!("{e:?}")))?
            });
        }
        return reject_set(
            table,
            writer,
            &commit_set_id,
            &members,
            &verdicts,
            TransitionCode::HumanReject,
            Some((position, decision_id)),
            None,
        );
    }

    // Every member that needed a decision must have an approval.
    let mut approvals: Vec<Option<String>> = Vec::with_capacity(members.len());
    for (index, proposal) in members.iter().enumerate() {
        match &decisions[index] {
            Some((id, Decision::Approve)) => approvals.push(Some(id.clone())),
            Some((_, Decision::Reject)) => unreachable!("handled above"),
            None => {
                return Err(internal(format!(
                    "proposal {} is still awaiting a decision",
                    proposal.proposal_id
                )))
            }
        }
    }

    // PRE-APPEND REVALIDATION. Approval AUTHORIZES; it does not freeze the
    // world. Re-run every policy predicate at the CURRENT head, and if a
    // member no longer passes — or would now be MORE DANGEROUS than the card
    // the human actually read — the whole set is rejected as stale rather
    // than applied against a world that moved underneath the decision.
    //
    // The risk comparison is what makes this reachable today: with only
    // table-decidable predicates a re-run cannot start refusing, but a
    // target that gained an attestation between the queue and the click
    // turns a MEDIUM card into a HIGH change. Approving MEDIUM is not
    // approving HIGH. M24.5 adds target CAS and evidence/coverage
    // re-resolution to this same pass.
    let mut verdicts = Vec::with_capacity(members.len());
    let mut stale_reason: Option<(usize, CulpritDetail)> = None;
    // A precondition names its own code (`stale_target_version`,
    // `invalid_reference`, `candidate_receipt_stale`); a risk that merely
    // rose is `policy_precondition_stale`.
    let mut stale_code: Option<&'static str> = None;
    let catalog = qualification::Catalog::new(vault, writer.store_id());
    let mut staged_beliefs: std::collections::BTreeSet<String> = Default::default();
    let mut staged_entities: std::collections::BTreeSet<String> = Default::default();
    for (index, proposal) in members.iter().enumerate() {
        let facts = facts_at(table, &state, proposal)?;
        let verdict = table_verdict(table, &facts).map_err(|e| internal(format!("{e:?}")))?;
        let binding = preconditions::TargetBinding {
            actor: &actors[index],
            staged_beliefs: &staged_beliefs,
            staged_entities: &staged_entities,
            // THE PASS THAT MATTERS for an op whose expansion needs an
            // approval: at set-decision time there is none, so it binds
            // here, immediately before the batch appends.
            decision_event_id: approvals.get(index).cloned().flatten(),
        };
        let bound = if stale_reason.is_none() {
            preconditions::check(table, &state, &catalog, proposal, &binding)
        } else {
            Ok(())
        };
        // AFTER this member's own check, for the same reason the expansion
        // loop stages after its own expansion.
        stage_created(&proposal.op, &mut staged_beliefs, &mut staged_entities);
        if stale_reason.is_none() {
            if let Err(precondition) = bound {
                // The window target-id CAS alone cannot see: a duplicate
                // created while the card waited, evidence that stopped
                // resolving, a version that moved after approval.
                stale_code = Some(precondition.code);
                stale_reason = Some((index, CulpritDetail::of(&precondition)));
            } else if let Some(rejection) = verdict.rejection() {
                stale_reason = Some((
                    index,
                    CulpritDetail {
                        rule: None,
                        expected: TypedValue::string("passes policy"),
                        actual: TypedValue::string(&rejection.code),
                    },
                ));
            } else if let (Some(now), Some(queued)) = (
                verdict.effective_risk(),
                state.proposals[&proposal.proposal_id].queued_risk,
            ) {
                if now > queued {
                    // The card said one thing; the world now says another.
                    stale_reason = Some((
                        index,
                        CulpritDetail {
                            rule: Some("risk_ladder"),
                            expected: TypedValue::string(queued.as_str()),
                            actual: TypedValue::string(now.as_str()),
                        },
                    ));
                }
            }
        }
        verdicts.push(verdict);
    }
    if let Some((culprit, detail)) = stale_reason {
        let stale: Vec<Verdict> = verdicts
            .iter()
            .enumerate()
            .map(|(index, verdict)| {
                if index == culprit {
                    Verdict::Rejected {
                        rejection: super::verdict::Rejection {
                            code: stale_code
                                .unwrap_or("policy_precondition_stale")
                                .to_string(),
                            destiny: Destiny::Ledger,
                        },
                        risk: None,
                    }
                } else {
                    verdict.clone()
                }
            })
            .collect();
        return reject_set(
            table,
            writer,
            &commit_set_id,
            &members,
            &stale,
            TransitionCode::StaleReject,
            None,
            Some(detail),
        );
    }

    apply_with_decisions(
        table,
        writer,
        vault,
        &state,
        &commit_set_id,
        &members,
        &actors,
        &verdicts,
        &approvals,
        TransitionCode::Apply,
    )
}

// --- The three batch shapes --------------------------------------------------

/// Every member's target versions at this snapshot, in canonical order.
fn target_versions(state: &EpistemicState, proposal: &ProposalV1) -> Vec<TargetVersion> {
    let mut versions: Vec<TargetVersion> = proposal
        .targets
        .iter()
        .map(|target| TargetVersion {
            target_class: target.target_class,
            target_id: target.target_id.clone(),
            version: state
                .version(target.target_class.as_str(), &target.target_id)
                .unwrap_or(0),
        })
        .collect();
    versions.sort_by(|a, b| {
        (a.target_class.as_str(), a.target_id.as_str())
            .cmp(&(b.target_class.as_str(), b.target_id.as_str()))
    });
    versions.dedup_by(|a, b| a.target_class == b.target_class && a.target_id == b.target_id);
    versions
}

/// One batch of `proposal.rejected`, one per member. The offending member
/// carries its own code; every peer carries `atomic_set_refused` naming it,
/// so a card points at the cause instead of saying "something else went
/// wrong".
/// What the culprit's refusal expected and got, and which rule said so —
/// for the refusals a caller knows more about than the table-only detail can
/// reconstruct.
///
/// `rule` carries the PREDICATE that refused. A `RuleCode` may be a
/// predicate name, and naming the predicate is the difference between a card
/// that says "something in this commit set" and one that says
/// `qualification_roles_present`. The code→rule fallback stays for
/// table-decidable refusals, which have no predicate to name.
struct CulpritDetail {
    rule: Option<&'static str>,
    expected: TypedValue,
    actual: TypedValue,
}

impl CulpritDetail {
    fn of(precondition: &PreconditionFailure) -> CulpritDetail {
        CulpritDetail {
            rule: Some(precondition.rule),
            expected: precondition.expected.clone(),
            actual: precondition.actual.clone(),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn reject_set(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    commit_set_id: &str,
    members: &[ProposalV1],
    verdicts: &[Verdict],
    transition: TransitionCode,
    human: Option<(usize, String)>,
    detail_override: Option<CulpritDetail>,
) -> Result<CommitOutcome, SubmitError> {
    let culprit = verdicts
        .iter()
        .position(|v| v.rejection().is_some())
        .expect("reject_set is only reached with a rejection");
    let mut events = Vec::with_capacity(members.len());
    let mut results = Vec::with_capacity(members.len());
    for (index, proposal) in members.iter().enumerate() {
        let (code, rule, expected, actual, refused_by, decision_id) = if index == culprit {
            let rejection = verdicts[index].rejection().expect("checked");
            let (expected, actual) = match &detail_override {
                Some(detail) => (detail.expected.clone(), detail.actual.clone()),
                None => detail_of(table, proposal, &rejection.code),
            };
            (
                rejection.code.clone(),
                detail_override
                    .as_ref()
                    .and_then(|detail| detail.rule)
                    .unwrap_or_else(|| rule_for(&rejection.code)),
                expected,
                actual,
                None,
                human.as_ref().map(|(_, id)| id.clone()),
            )
        } else {
            (
                "atomic_set_refused".to_string(),
                rule_for("atomic_set_refused"),
                TypedValue::string("applied"),
                TypedValue::string("refused"),
                Some(members[culprit].proposal_id.clone()),
                None,
            )
        };
        // Only ledger-destined codes reach a batch: operational refusals
        // never became durable proposals in the first place.
        let rejection = Rejection::new(table, &code, rule, expected, actual).map_err(internal)?;
        if rejection.destiny(table) != Destiny::Ledger {
            return Err(internal(format!(
                "{code} has operational destiny and cannot enter the ledger"
            )));
        }
        let (schema_v, batch_id, key, actor) = common(&protocol_actor());
        let body = ProposalRejected {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: proposal.proposal_id.clone(),
            commit_set_id: commit_set_id.to_string(),
            code: rejection.code.as_str().to_string(),
            rule: rejection.rule.as_str().to_string(),
            expected: rejection.expected.clone(),
            actual: rejection.actual.clone(),
            decision_id,
            refused_by_proposal_id: refused_by,
        };
        events.push((
            schema::KIND_PROPOSAL_REJECTED.to_string(),
            serde_json::to_value(&body).map_err(|e| internal(e.to_string()))?,
        ));
        results.push(SubmitResult::Rejected {
            proposal_id: proposal.proposal_id.clone(),
            rejection,
        });
    }
    let decisions: Vec<String> = human.into_iter().map(|(_, id)| id).collect();
    let key = operation_key(commit_set_id, transition, &decisions);
    let receipt = writer.append_batch(events, Some(&key)).map_err(internal)?;
    crate::crash::crash_point(&format!("commit-set-{}-acked", transition.as_str()));
    Ok(CommitOutcome {
        commit_set_id: commit_set_id.to_string(),
        transition,
        results,
        batch_id: receipt.batch_id,
        replayed: receipt.replayed,
    })
}

/// A precondition failure refuses the whole set: the culprit carries the
/// predicate's own code and detail, every peer carries `atomic_set_refused`.
#[allow(clippy::too_many_arguments)]
fn reject_precondition(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    commit_set_id: &str,
    members: &[ProposalV1],
    culprit: usize,
    precondition: PreconditionFailure,
    transition: TransitionCode,
) -> Result<CommitOutcome, SubmitError> {
    let verdicts: Vec<Verdict> = (0..members.len())
        .map(|index| {
            if index == culprit {
                Verdict::Rejected {
                    rejection: super::verdict::Rejection {
                        code: precondition.code.to_string(),
                        destiny: Destiny::Ledger,
                    },
                    risk: None,
                }
            } else {
                Verdict::Applied {
                    risk: super::risk::EffectiveRisk {
                        risk: crate::ledger::schema::Risk::Low,
                        base: crate::ledger::schema::Risk::Low,
                        declared: crate::ledger::schema::Risk::Low,
                        fired: vec![],
                    },
                }
            }
        })
        .collect();
    reject_set(
        table,
        writer,
        commit_set_id,
        members,
        &verdicts,
        transition,
        None,
        Some(CulpritDetail::of(&precondition)),
    )
}

/// What a table-decidable refusal expected and what it got. These come off
/// the table and the proposal, so a card can say "MEDIUM, you declared LOW"
/// instead of "risk_lowered".
fn detail_of(table: &PolicyTable, proposal: &ProposalV1, code: &str) -> (TypedValue, TypedValue) {
    match code {
        "risk_lowered" => match table.op(proposal.op.kind()) {
            Some(rule) => (
                TypedValue::string(rule.base_risk.as_str()),
                TypedValue::string(proposal.declared_risk.as_str()),
            ),
            None => (TypedValue::Missing, TypedValue::Missing),
        },
        "target_set_mismatch" => match table.op(proposal.op.kind()) {
            Some(rule) => (
                TypedValue::string(&rule.target_classes.join(",")),
                TypedValue::string(
                    &proposal
                        .target_classes()
                        .into_iter()
                        .collect::<Vec<_>>()
                        .join(","),
                ),
            ),
            None => (TypedValue::Missing, TypedValue::Missing),
        },
        "silence_transition_forbidden" => (
            TypedValue::string(&table.silence.allowed_transitions.join(",")),
            TypedValue::string(proposal.basis.transition_cause.as_str()),
        ),
        _ => (TypedValue::Missing, TypedValue::Missing),
    }
}

/// One batch of `proposal.queued`, one per member — including the LOW and
/// MEDIUM peers that would have applied alone.
fn queue_set(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    state: &EpistemicState,
    commit_set_id: &str,
    members: &[ProposalV1],
    verdicts: &[Verdict],
    // Per member, the table codes holding it beyond the risk ladder.
    queued_for: &[Vec<String>],
) -> Result<CommitOutcome, SubmitError> {
    // The FROZEN order, not a sorted copy: it is what the commit-set id was
    // derived from, and a queued card must be resolvable after a restart
    // without guessing which permutation the set was committed in.
    let member_ids: Vec<String> = members.iter().map(|p| p.proposal_id.clone()).collect();
    let queued_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut events = Vec::with_capacity(members.len());
    let mut results = Vec::with_capacity(members.len());
    for (index, proposal) in members.iter().enumerate() {
        let risk = verdicts[index]
            .effective_risk()
            .ok_or_else(|| internal("a queued verdict always resolved a risk"))?;
        let (schema_v, batch_id, key, actor) = common(&protocol_actor());
        let body = ProposalQueued {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: proposal.proposal_id.clone(),
            commit_set_id: commit_set_id.to_string(),
            member_proposal_ids: member_ids.clone(),
            effective_risk: risk,
            policy_version: table.artifact_version,
            target_versions: target_versions(state, proposal),
            queued_at: queued_at.clone(),
            queued_for: queued_for.get(index).cloned().unwrap_or_default(),
        };
        events.push((
            schema::KIND_PROPOSAL_QUEUED.to_string(),
            serde_json::to_value(&body).map_err(|e| internal(e.to_string()))?,
        ));
        results.push(SubmitResult::Queued {
            proposal_id: proposal.proposal_id.clone(),
            effective_risk: risk,
            escalated_by: verdicts[index].escalated_by(),
        });
    }
    let key = operation_key(commit_set_id, TransitionCode::InitialQueue, &[]);
    let receipt = writer.append_batch(events, Some(&key)).map_err(internal)?;
    crate::crash::crash_point("commit-set-initial_queue-acked");
    Ok(CommitOutcome {
        commit_set_id: commit_set_id.to_string(),
        transition: TransitionCode::InitialQueue,
        results,
        batch_id: receipt.batch_id,
        replayed: receipt.replayed,
    })
}

#[allow(clippy::too_many_arguments)]
fn apply_set(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    vault: &Path,
    state: &EpistemicState,
    commit_set_id: &str,
    members: &[ProposalV1],
    actors: &[Actor],
    verdicts: &[Verdict],
    transition: TransitionCode,
) -> Result<CommitOutcome, SubmitError> {
    let approvals = vec![None; members.len()];
    apply_with_decisions(
        table,
        writer,
        vault,
        state,
        commit_set_id,
        members,
        actors,
        verdicts,
        &approvals,
        transition,
    )
}

/// The apply batch: every member's mutations followed by its
/// `proposal.applied`, contiguous, under one `batch_id`. Nothing is visible
/// to the reducer until the marker validates, so a crash anywhere in here
/// leaves the set exactly as it was.
#[allow(clippy::too_many_arguments)]
fn apply_with_decisions(
    table: &PolicyTable,
    writer: &mut LedgerWriter,
    vault: &Path,
    state: &EpistemicState,
    commit_set_id: &str,
    members: &[ProposalV1],
    actors: &[Actor],
    verdicts: &[Verdict],
    approvals: &[Option<String>],
    transition: TransitionCode,
) -> Result<CommitOutcome, SubmitError> {
    let protocol = protocol_actor();
    let mut events: Vec<(String, serde_json::Value)> = Vec::new();
    let mut results = Vec::with_capacity(members.len());
    // What earlier members of THIS set create, so "create a Belief, then
    // link it" works inside one atomic set instead of refusing against a
    // snapshot taken before the set ran.
    let mut staged_beliefs: std::collections::BTreeSet<String> = Default::default();
    let mut staged_entities: std::collections::BTreeSet<String> = Default::default();

    for (index, proposal) in members.iter().enumerate() {
        let rule = table
            .op(proposal.op.kind())
            .ok_or_else(|| internal(format!("{} is not in the table", proposal.op.kind())))?;
        let ctx = ExpansionContext {
            // The MUTATION is the proposer's act...
            actor: actors[index].clone(),
            state,
            base_ordinal: events.len(),
            decision_event_id: approvals[index].clone(),
            proposal_id: proposal.proposal_id.clone(),
            staged_beliefs: staged_beliefs.clone(),
            staged_entities: staged_entities.clone(),
        };
        let expansion = expand(&proposal.op, &ctx).map_err(|e| expand_error(table, e))?;
        // AFTER its own expansion: a create must not see itself staged, or
        // it would refuse as a duplicate of the thing it is creating.
        stage_created(&proposal.op, &mut staged_beliefs, &mut staged_entities);
        if expansion.members.is_empty() {
            return Err(internal(format!(
                "{} expanded to nothing — an application that changes nothing is not one",
                proposal.op.kind()
            )));
        }
        let mutation_refs: Vec<String> = (0..expansion.members.len())
            .map(|offset| member_ref(events.len() + offset))
            .collect();
        let applied_ordinal = events.len() + expansion.members.len();
        events.extend(expansion.members.clone());

        // The stored inverse exists for exactly the ops the table calls
        // one_click — which is what the UI keys its Revert action off, never
        // the op name.
        let revert_plan = if rule.revert == Revert::OneClick {
            let digest = operation_digest(&expansion.members).map_err(internal)?;
            Some(RevertPlan {
                source_operation_digest: digest,
                expected_post_versions: expansion
                    .write_targets
                    .iter()
                    .map(|(class, id)| schema::PostVersion {
                        target_class: *class,
                        target_id: id.clone(),
                        version: state.version(class.as_str(), id).unwrap_or(0) + 1,
                    })
                    .collect(),
                steps: expansion.revert_steps.clone(),
            })
        } else {
            None
        };
        if revert_plan.is_none() && !expansion.revert_steps.is_empty() {
            return Err(internal(format!(
                "{} produced an inverse the table does not call one_click",
                proposal.op.kind()
            )));
        }

        let risk = verdicts[index]
            .effective_risk()
            .ok_or_else(|| internal("an applied verdict always resolved a risk"))?;
        // ...but the APPLICATION is the ledger's own record of authorizing
        // it, so it commits under the protocol actor.
        let (schema_v, batch_id, key, body_actor) = common(&protocol);
        let applied = ProposalApplied {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor: body_actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: proposal.proposal_id.clone(),
            commit_set_id: commit_set_id.to_string(),
            effective_risk: risk,
            decision_id: approvals[index].clone(),
            mutation_event_ids: mutation_refs,
            resulting_versions: post_versions(state, proposal, &expansion.write_targets),
            revert_plan,
        };
        events.push((
            schema::KIND_PROPOSAL_APPLIED.to_string(),
            serde_json::to_value(&applied).map_err(|e| internal(e.to_string()))?,
        ));

        // A revert names what it undid, in the same batch, right after the
        // application that performed it. Neither record is erased.
        if let schema::ProposalOp::RevertProposal {
            applied_proposal_id,
            applied_event_ids,
        } = &proposal.op
        {
            let forward: Vec<String> = (ctx.base_ordinal..applied_ordinal)
                .map(member_ref)
                .collect();
            let (schema_v, batch_id, key, body_actor) = common(&protocol);
            let reverted = ProposalReverted {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor: body_actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                proposal_id: applied_proposal_id.clone(),
                reverted_by_proposal_id: proposal.proposal_id.clone(),
                prior_applied_event_ids: applied_event_ids.clone(),
                forward_event_ids: forward,
                resulting_versions: vec![],
            };
            events.push((
                schema::KIND_PROPOSAL_REVERTED.to_string(),
                serde_json::to_value(&reverted).map_err(|e| internal(e.to_string()))?,
            ));
        }

        results.push(SubmitResult::Applied {
            proposal_id: proposal.proposal_id.clone(),
            resulting_versions: applied.resulting_versions.clone(),
        });
    }

    let decisions: Vec<String> = approvals.iter().flatten().cloned().collect();
    let key = operation_key(commit_set_id, transition, &decisions);
    let receipt = writer.append_batch(events, Some(&key)).map_err(internal)?;
    crate::crash::crash_point("commit-set-apply-committed");

    // Only after the marker is durable does the projection follow — and a
    // crash here is repaired from the committed ledger, never from a
    // half-written file.
    project_applied(writer, vault)?;
    crate::crash::crash_point("commit-set-apply-acked");
    Ok(CommitOutcome {
        commit_set_id: commit_set_id.to_string(),
        transition,
        results,
        batch_id: receipt.batch_id,
        replayed: receipt.replayed,
    })
}

/// The version each declared target is left at. Targets this plan advances
/// go up by one; targets it only reads keep their version, which is what
/// makes a read target legible as a read.
fn post_versions(
    state: &EpistemicState,
    proposal: &ProposalV1,
    write_targets: &[(TargetClass, String)],
) -> Vec<TargetVersion> {
    let mut versions = target_versions(state, proposal);
    for version in &mut versions {
        if write_targets
            .iter()
            .any(|(class, id)| *class == version.target_class && id == &version.target_id)
        {
            version.version += 1;
        }
    }
    versions
}

/// Re-project every knowledge Belief the new head CHANGED, through M23's
/// manifest-first protocol.
///
/// "Changed" means the manifest's recorded tuple no longer matches the
/// reducer's — content hash, projection-state digest, or generating head.
/// A Belief the batch did not touch is skipped entirely, so applying one
/// proposal does not rewrite the manifest once per file in the vault. A
/// crash mid-loop leaves the remaining files ledger-ahead, which is the M23
/// class recovery already repairs from the committed ledger.
fn project_applied(writer: &LedgerWriter, vault: &Path) -> Result<(), SubmitError> {
    let state = state_of(writer, vault)?;
    let manifest = crate::ledger::manifest::load(vault).map_err(internal)?;
    for (path, belief_id) in &state.projection_paths {
        let projection =
            crate::ledger::reduce::project_belief(&state, belief_id).map_err(internal)?;
        let rel = format!("knowledge/{path}");
        let unchanged = manifest
            .as_ref()
            .and_then(|m| m.entries.get(&rel))
            .is_some_and(|entry| {
                entry.content_hash == projection.content_hash
                    && entry.projection_state_digest == projection.projection_state_digest
                    && entry.generating_event == projection.generating_event
                    && entry.write_state == crate::ledger::manifest::WriteState::Complete
            });
        if unchanged {
            continue;
        }
        crate::ledger::manifest::write_projection(vault, &rel, &projection).map_err(internal)?;
        crate::vault::watcher::note_own_write(&vault.join(&rel));
    }
    Ok(())
}

/// An expansion refusal becomes a submit error whose code the table knows.
/// A LEDGER-destined expansion refusal is a defect at this point — policy
/// already accepted the proposal — so it surfaces loudly instead of being
/// written into history as if it had been foreseen.
/// What a member CREATES, staged for the members after it.
///
/// Shared by the real expansion loop and the target-binding predicate, so the
/// world the binding check expands against is the world the application will
/// expand against. Two copies of this accumulation would disagree exactly
/// when a set creates a Belief and then links it — the case atomic sets
/// exist for.
fn stage_created(
    op: &schema::ProposalOp,
    beliefs: &mut std::collections::BTreeSet<String>,
    entities: &mut std::collections::BTreeSet<String>,
) {
    match op {
        schema::ProposalOp::CreateBelief {
            belief_id, subject, ..
        } => {
            beliefs.insert(belief_id.clone());
            if let schema::SubjectRef::Resolved { entity_id, .. } = subject {
                entities.insert(entity_id.clone());
            }
        }
        schema::ProposalOp::SplitBelief { outputs, .. } => {
            for output in outputs {
                beliefs.insert(output.belief_id.clone());
                if let schema::SubjectRef::Resolved { entity_id, .. } = &output.subject {
                    entities.insert(entity_id.clone());
                }
            }
        }
        _ => {}
    }
}

fn expand_error(table: &PolicyTable, error: ExpandError) -> SubmitError {
    match table.destiny(error.code) {
        Some(Destiny::Operational) | None => SubmitError {
            code: leaked(error.code),
            detail: error.detail,
        },
        Some(Destiny::Ledger) => SubmitError {
            code: "malformed_arguments",
            detail: format!(
                "{}: {} — a ledger-destined refusal reached expansion, which policy should have \
                 caught first",
                error.code, error.detail
            ),
        },
    }
}

/// Fixtures the commit tests and the crash-scenario children share, so a
/// child process seeds exactly the world its parent staged.
#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    use crate::ledger::reduce::project_belief;
    use crate::ledger::schema::{BeliefBasis, ProposalOp, SubjectRef, TombstoneReason};
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::Risk;

    pub const RUN: &str = "9111111111111111111111111111111f";
    pub const AGENT: &str = "agent:test";
    pub const P1: &str = "0000000000000000000000000000000a";
    pub const P2: &str = "0000000000000000000000000000000b";

    pub fn actor() -> Actor {
        Actor { id: AGENT.into() }
    }

    /// A human verifies the Belief — the world moving under a queued card.
    pub fn attest(writer: &mut LedgerWriter, vault: &Path, belief_id: &str) {
        let state = state_of(writer, vault).unwrap();
        let projection = project_belief(&state, belief_id).unwrap();
        let (schema_v, batch_id, key, body_actor) = common(&Actor {
            id: "human:me".into(),
        });
        let attested = schema::BeliefAttested {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor: body_actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.to_string(),
            attested_belief_revision_event_id: projection.belief_revision_event.clone(),
            attested_content_hash: schema::belief::attested_content_hash(
                projection.bytes.as_bytes(),
            ),
        };
        writer
            .append(
                schema::KIND_BELIEF_ATTESTED,
                serde_json::to_value(&attested).unwrap(),
            )
            .unwrap();
    }

    /// A live `refines` edge from one Belief to another — fan-in, without
    /// touching the target's own version.
    pub fn add_relation(writer: &mut LedgerWriter, from: &str, to: &str) {
        let (schema_v, batch_id, key, body_actor) = common(&actor());
        let relation = schema::BeliefRelation {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor: body_actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            relation_id: schema::derive_relation_id(from, to, schema::RelationKind::Refines),
            action: schema::RelationAction::Add,
            from: from.to_string(),
            to: to.to_string(),
            relation: schema::RelationKind::Refines,
        };
        writer
            .append(
                schema::KIND_BELIEF_RELATION,
                serde_json::to_value(&relation).unwrap(),
            )
            .unwrap();
    }

    /// Register a display alias on an Entity — how a duplicate becomes
    /// findable by the alias leg without sharing a path-derived id.
    pub fn add_alias(writer: &mut LedgerWriter, entity_id: &str, alias: &str) {
        let (schema_v, batch_id, key, body_actor) = common(&actor());
        let body = schema::EntityAliasAdded {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor: body_actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            entity_id: entity_id.to_string(),
            alias: alias.to_string(),
            normalized_alias: schema::normalize_alias_v1(alias),
        };
        writer
            .append(
                schema::KIND_ENTITY_ALIAS_ADDED,
                serde_json::to_value(&body).unwrap(),
            )
            .unwrap();
    }

    pub fn seed_belief(writer: &mut LedgerWriter, slug: &str) -> String {
        seed_belief_with(writer, slug, serde_json::json!({}))
    }

    pub fn seed_belief_with(
        writer: &mut LedgerWriter,
        slug: &str,
        fields: serde_json::Value,
    ) -> String {
        let store = writer.store_id().to_string();
        let belief_id = schema::migrate_id(&store, "belief", slug);
        let entity_id = schema::migrate_id(&store, "entity", slug);
        let (schema_v, batch_id, key, body_actor) = common(&actor());
        let created = schema::BeliefCreated {
            schema: schema_v,
            batch_id,
            idempotency_key: key,
            actor: body_actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.clone(),
            subject: SubjectRef::Resolved {
                entity_id,
                aliases: vec![format!("{slug}.md")],
            },
            content: format!("# {slug}\n"),
            fields,
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
        belief_id
    }

    pub fn update_op(belief_id: &str, value: &str) -> ProposalOp {
        ProposalOp::UpdateBelief {
            belief_id: belief_id.to_string(),
            patch: vec![schema::PatchOp {
                field_path: "/fields/note".into(),
                before: TypedValue::Missing,
                after: TypedValue::string(value),
            }],
            basis: BeliefBasis::Unsupported {
                reason: "seed".into(),
            },
        }
    }

    pub fn tombstone_op(belief_id: &str) -> ProposalOp {
        ProposalOp::TombstoneBelief {
            belief_id: belief_id.to_string(),
            replacement_id: None,
            reason_code: TombstoneReason::Invalid,
        }
    }

    pub fn submit(
        writer: &mut LedgerWriter,
        id: &str,
        op: ProposalOp,
        belief_id: &str,
        risk: Risk,
    ) -> String {
        let p = proposal(
            id,
            RUN,
            op,
            vec![target(TargetClass::Belief, belief_id, Some(1))],
            risk,
        );
        submit_proposal(&PolicyTable::load().unwrap(), writer, &actor(), &p).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::*;
    use super::*;
    use crate::ledger::schema::ProposalOp;
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::Risk;
    use crate::vault::testutil;

    fn table() -> PolicyTable {
        PolicyTable::load().unwrap()
    }

    /// A vault with one committed Belief, returned with its id.
    fn seeded(name: &str) -> (std::path::PathBuf, LedgerWriter, String) {
        let vault = testutil::temp_vault(name);
        let mut writer = LedgerWriter::open(&vault, "1111111111111111111111111111111a").unwrap();
        let belief_id = seed_belief(&mut writer, "seed");
        (vault, writer, belief_id)
    }

    fn state(writer: &LedgerWriter, vault: &Path) -> EpistemicState {
        state_of(writer, vault).unwrap()
    }

    #[test]
    fn a_mixed_risk_set_queues_every_member_including_the_cheap_one() {
        // THE ATOMICITY RULE. The MEDIUM update would auto-apply alone;
        // riding with a HIGH tombstone it waits, because applying half of an
        // atomic set is exactly the partial state the protocol prevents.
        let (vault, mut writer, belief) = seeded("commit-mixed");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        submit(&mut writer, P2, tombstone_op(&belief), &belief, Risk::High);
        let outcome = commit_proposals(
            &table(),
            &mut writer,
            &vault,
            RUN,
            &[P1.to_string(), P2.to_string()],
        )
        .unwrap();

        assert_eq!(outcome.transition, TransitionCode::InitialQueue);
        assert!(outcome
            .results
            .iter()
            .all(|r| matches!(r, SubmitResult::Queued { .. })));
        let state = state(&writer, &vault);
        for id in [P1, P2] {
            let row = &state.proposals[id];
            assert_eq!(row.state, ProposalState::Queued);
            assert_eq!(
                row.commit_set_id.as_deref(),
                Some(outcome.commit_set_id.as_str())
            );
            // The frozen order, durably — a restart can resolve this set
            // without guessing which permutation it was committed in.
            assert_eq!(row.queued_members, vec![P1.to_string(), P2.to_string()]);
        }
        // NOTHING applied: the Belief is untouched at revision 1.
        assert_eq!(state.beliefs[&belief].current().revision, 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn one_refusal_refuses_every_peer_and_names_the_cause() {
        let (vault, mut writer, belief) = seeded("commit-refuse");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        // Declaring a HIGH op as LOW is `risk_lowered` — a ledger refusal.
        submit(&mut writer, P2, tombstone_op(&belief), &belief, Risk::Low);
        let outcome = commit_proposals(
            &table(),
            &mut writer,
            &vault,
            RUN,
            &[P1.to_string(), P2.to_string()],
        )
        .unwrap();

        assert_eq!(outcome.transition, TransitionCode::InitialReject);
        let state = state(&writer, &vault);
        assert_eq!(state.proposals[P1].state, ProposalState::Rejected);
        assert_eq!(state.proposals[P2].state, ProposalState::Rejected);

        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let rejections: Vec<&crate::ledger::frame::Frame> = read
            .frames
            .iter()
            .filter(|f| f.kind == schema::KIND_PROPOSAL_REJECTED)
            .collect();
        assert_eq!(rejections.len(), 2, "one per member, one batch");
        // The peer points at the culprit instead of saying "something else
        // went wrong", and the culprit says what it expected.
        let peer = rejections
            .iter()
            .find(|f| f.body["proposal_id"] == serde_json::json!(P1))
            .unwrap();
        assert_eq!(peer.body["code"], "atomic_set_refused");
        assert_eq!(peer.body["refused_by_proposal_id"], serde_json::json!(P2));
        let culprit = rejections
            .iter()
            .find(|f| f.body["proposal_id"] == serde_json::json!(P2))
            .unwrap();
        assert_eq!(culprit.body["code"], "risk_lowered");
        assert_eq!(culprit.body["expected"]["value"], "HIGH");
        assert_eq!(culprit.body["actual"]["value"], "LOW");
        // Both rode ONE batch: a crash cannot terminally reject only half.
        assert_eq!(peer.body["batch_id"], culprit.body["batch_id"]);
        assert_eq!(state.beliefs[&belief].current().revision, 1);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_capability_gap_never_becomes_a_durable_proposal() {
        // `capability_unavailable` is OPERATIONAL by declaration, so it is
        // refused at submission and the vault's history never mentions it.
        let (vault, mut writer, belief) = seeded("commit-capability");
        let p = proposal(
            P1,
            RUN,
            ProposalOp::ClassifyConflict {
                comparison_id: belief.clone(),
                outcome: schema::ConflictOutcome::GenuineDirect,
                basis_refs: vec![belief.clone()],
            },
            vec![target(TargetClass::Comparison, &belief, Some(1))],
            Risk::Medium,
        );
        let err = submit_proposal(&table(), &mut writer, &actor(), &p).unwrap_err();
        assert_eq!(err.code, "capability_unavailable");
        assert!(
            state(&writer, &vault).proposals.is_empty(),
            "no proposal.submitted was written"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_human_rejection_rejects_the_set_and_names_the_decision() {
        let (vault, mut writer, belief) = seeded("commit-human-reject");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        submit(&mut writer, P2, tombstone_op(&belief), &belief, Risk::High);
        let ordered = [P1.to_string(), P2.to_string()];
        commit_proposals(&table(), &mut writer, &vault, RUN, &ordered).unwrap();

        let decision = record_decision(
            &mut writer,
            &vault,
            P2,
            Decision::Reject,
            "human:me",
            Some("not this one"),
            "2026-08-09T10:00:00Z",
        )
        .unwrap();
        let outcome = resolve_commit_set(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        assert_eq!(outcome.transition, TransitionCode::HumanReject);

        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let rejected: Vec<&crate::ledger::frame::Frame> = read
            .frames
            .iter()
            .filter(|f| f.kind == schema::KIND_PROPOSAL_REJECTED)
            .collect();
        assert_eq!(rejected.len(), 2);
        let human = rejected
            .iter()
            .find(|f| f.body["proposal_id"] == serde_json::json!(P2))
            .unwrap();
        assert_eq!(human.body["code"], "human_rejected");
        assert_eq!(human.body["decision_id"], serde_json::json!(decision));
        // A rejection is a recorded ACT with a reason, not the absence of an
        // approval — the Skeptic reads it.
        let recorded = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_PROPOSAL_DECISION_RECORDED)
            .unwrap();
        assert_eq!(recorded.body["reason"], "not this one");
        assert_eq!(recorded.body["actor"]["id"], "human:me");
        assert_eq!(
            state(&writer, &vault).beliefs[&belief].current().revision,
            1
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn approval_is_authorization_not_a_snapshot_of_the_world() {
        // THE CAS RULE, after approval. A human said yes to version 1;
        // between the click and the append the target moved. Applying now
        // would write over something nobody looked at.
        let (vault, mut writer, belief) = seeded("commit-stale-cas");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        submit(&mut writer, P2, tombstone_op(&belief), &belief, Risk::High);
        let ordered = [P1.to_string(), P2.to_string()];
        commit_proposals(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        for id in &ordered {
            record_decision(
                &mut writer,
                &vault,
                id,
                Decision::Approve,
                "human:me",
                None,
                "2026-08-09T10:00:00Z",
            )
            .unwrap();
        }

        // The world moves: a human verifies the target, which advances the
        // Belief's version.
        attest(&mut writer, &vault, &belief);

        let outcome = resolve_commit_set(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        assert_eq!(outcome.transition, TransitionCode::StaleReject);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let stale = read
            .frames
            .iter()
            .find(|f| {
                f.kind == schema::KIND_PROPOSAL_REJECTED && f.body["code"] == "stale_target_version"
            })
            .unwrap();
        // The card stays inspectable: it says WHICH target moved, from what
        // to what — never a bare "something changed".
        assert_eq!(
            stale.body["expected"]["value"],
            format!("belief/{belief}@1")
        );
        assert_eq!(stale.body["actual"]["value"], format!("belief/{belief}@2"));
        assert_eq!(
            state(&writer, &vault).beliefs[&belief].current().revision,
            1,
            "state untouched"
        );

        // ...and the server can offer a proposal that IS current, under a
        // NEW id, rather than silently refreshing the one a human read.
        let current = state(&writer, &vault);
        let prepared = crate::policy::preconditions::prepare_updated(
            &current,
            &current.proposals[P1].proposal,
        );
        assert_ne!(prepared.proposal_id, P1);
        assert!(crate::policy::preconditions::versions_current(&current, &prepared).is_ok());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn approving_medium_is_not_approving_high() {
        // THE RISK-ROSE RULE, which CAS alone cannot see: the target itself
        // never moved. What changed is how much depends on it — fan-in rose
        // past the threshold while the card sat in the queue, and the same
        // edit is now a HIGH one. Approving MEDIUM is not approving HIGH.
        let (vault, mut writer, belief) = seeded("commit-stale-risk");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        // A HIGH peer keeps the set queued, so there is a decision to outlive.
        submit(&mut writer, P2, tombstone_op(&belief), &belief, Risk::High);
        let ordered = [P1.to_string(), P2.to_string()];
        commit_proposals(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        for id in &ordered {
            record_decision(
                &mut writer,
                &vault,
                id,
                Decision::Approve,
                "human:me",
                None,
                "2026-08-09T10:00:00Z",
            )
            .unwrap();
        }

        // Other Beliefs come to depend on the target. None of that touches
        // the target's OWN version, so CAS still agrees.
        let table = table();
        let threshold = table.threshold("lineage_fan_in_high").unwrap();
        for index in 0..=threshold {
            let dependent = seed_belief(&mut writer, &format!("dependent-{index}"));
            add_relation(&mut writer, &dependent, &belief);
        }
        let current = state(&writer, &vault);
        assert!(
            crate::policy::preconditions::versions_current(
                &current,
                &current.proposals[P1].proposal
            )
            .is_ok(),
            "the target itself never moved"
        );

        let outcome = resolve_commit_set(&table, &mut writer, &vault, RUN, &ordered).unwrap();
        assert_eq!(outcome.transition, TransitionCode::StaleReject);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let stale = read
            .frames
            .iter()
            .find(|f| {
                f.kind == schema::KIND_PROPOSAL_REJECTED
                    && f.body["code"] == "policy_precondition_stale"
            })
            .unwrap();
        assert_eq!(stale.body["expected"]["value"], "MEDIUM");
        assert_eq!(stale.body["actual"]["value"], "HIGH");
        assert_eq!(
            state(&writer, &vault).beliefs[&belief].current().revision,
            1,
            "state untouched"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_approved_set_applies_as_one_batch_with_its_mutations() {
        let (vault, mut writer, belief) = seeded("commit-apply");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        let ordered = [P1.to_string()];
        // A lone MEDIUM auto-applies — no human in the loop at all.
        let outcome = commit_proposals(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        assert_eq!(outcome.transition, TransitionCode::Apply);

        let state = state(&writer, &vault);
        assert_eq!(state.beliefs[&belief].current().revision, 2);
        assert_eq!(state.proposals[P1].state, ProposalState::Applied);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let applied = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_PROPOSAL_APPLIED)
            .unwrap();
        let revised = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_BELIEF_REVISED)
            .unwrap();
        // Mutation and application are contiguous members of ONE batch, and
        // the application names the exact events it performed.
        assert_eq!(applied.body["batch_id"], revised.body["batch_id"]);
        assert_eq!(
            applied.body["mutation_event_ids"],
            serde_json::json!([revised.event_id])
        );
        assert_eq!(applied.body["decision_id"], serde_json::Value::Null);
        // The MUTATION is the proposer's act; the APPLICATION is the
        // ledger's record of authorizing it.
        assert_eq!(revised.body["actor"]["id"], AGENT);
        assert_eq!(applied.body["actor"]["id"], "system:policy");
        // update_belief is `revert: one_click`, so the inverse is stored.
        assert!(applied.body["revert_plan"].is_object());
        assert_eq!(
            applied.body["revert_plan"]["steps"][0]["kind"],
            "belief_revised"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_duplicate_created_while_the_card_waited_rejects_the_whole_set() {
        // THE WINDOW TARGET-ID CAS CANNOT SEE. A create names no existing
        // target, so no version can move under it — but the very thing it
        // claims is new can appear while it sits in the queue. Repeating the
        // search at the current head is what closes that.
        let (vault, mut writer, existing) = seeded("commit-candidate-stale");
        let store = writer.store_id().to_string();
        let new_id = schema::migrate_id(&store, "belief", "fresh");
        let entity_id = schema::migrate_id(&store, "entity", "fresh");
        let receipt = crate::policy::candidates::mint(
            &state(&writer, &vault),
            crate::policy::candidates::EMPTY_INDEX_HEAD,
            &entity_id,
            "fresh.md",
            &["Fresh Thing".to_string()],
            // The prose the create below proposes. Minting against anything
            // else refuses at submit on the M26.2 fingerprint check, which is
            // what that check is for.
            "# fresh\n",
        )
        .unwrap();
        assert!(
            receipt.considered.is_empty(),
            "nothing held that identity when the search ran"
        );

        let mut create = proposal(
            P1,
            RUN,
            ProposalOp::CreateBelief {
                belief_id: new_id.clone(),
                subject: schema::SubjectRef::Resolved {
                    entity_id,
                    aliases: vec!["fresh.md".into()],
                },
                content: "# fresh\n".into(),
                fields: serde_json::json!({}),
                basis: schema::BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
                distinctness_reason: "nothing holds fresh.md".into(),
            },
            vec![target(TargetClass::Belief, &new_id, None)],
            Risk::Low,
        );
        create.candidate_search_receipt = Some(receipt);
        submit_proposal(&table(), &mut writer, &actor(), &create).unwrap();
        // A HIGH peer keeps the set queued so a human is in the loop.
        submit(
            &mut writer,
            P2,
            tombstone_op(&existing),
            &existing,
            Risk::High,
        );
        let ordered = [P1.to_string(), P2.to_string()];
        commit_proposals(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        for id in &ordered {
            record_decision(
                &mut writer,
                &vault,
                id,
                Decision::Approve,
                "human:me",
                None,
                "2026-08-09T10:00:00Z",
            )
            .unwrap();
        }

        // Someone else makes an existing record answer to that name. The
        // create's own id is path-derived and still free, so no version
        // moved — only the SEARCH now returns something.
        add_alias(
            &mut writer,
            &schema::migrate_id(&store, "entity", "seed"),
            "Fresh Thing",
        );

        let outcome = resolve_commit_set(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        assert_eq!(outcome.transition, TransitionCode::StaleReject);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let stale = read
            .frames
            .iter()
            .find(|f| {
                f.kind == schema::KIND_PROPOSAL_REJECTED
                    && f.body["code"] == "candidate_receipt_stale"
            })
            .unwrap();
        assert_eq!(stale.body["proposal_id"], serde_json::json!(P1));
        // The immutable proposal was NOT refreshed in place: the record must
        // not say a human approved a search they never saw.
        assert!(
            !state(&writer, &vault).beliefs.contains_key(&new_id),
            "nothing was created"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_revert_is_a_new_forward_mutation_that_erases_nothing() {
        // Reverting is never a deletion: the original application and this
        // reversion both stand, and the ledger is not rewound.
        let (vault, mut writer, belief) = seeded("commit-revert");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        let applied_state = state(&writer, &vault);
        assert_eq!(applied_state.beliefs[&belief].current().revision, 2);
        let applied_event = applied_state.proposals[P1]
            .applied_event_id
            .clone()
            .unwrap();
        assert!(applied_state.proposals[P1].revert_plan.is_some());

        // The revert is its own proposal, in its own run.
        const REVERT_RUN: &str = "7333333333333333333333333333333c";
        const P3: &str = "0000000000000000000000000000000c";
        let revert = proposal(
            P3,
            REVERT_RUN,
            ProposalOp::RevertProposal {
                applied_proposal_id: P1.into(),
                applied_event_ids: vec![applied_event.clone()],
            },
            vec![
                target(TargetClass::Belief, &belief, Some(2)),
                target(
                    TargetClass::Proposal,
                    P1,
                    applied_state.version("proposal", P1),
                ),
            ],
            Risk::Medium,
        );
        submit_proposal(&table(), &mut writer, &actor(), &revert).unwrap();
        let outcome =
            commit_proposals(&table(), &mut writer, &vault, REVERT_RUN, &[P3.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::Apply);

        let after = state(&writer, &vault);
        // The inverse ran forward: revision 3 undoes what revision 2 did.
        assert_eq!(after.beliefs[&belief].current().revision, 3);
        assert_eq!(
            after.beliefs[&belief].current().fields,
            serde_json::json!({}),
            "the patch was inverted, not deleted"
        );
        // Both records stand.
        assert_eq!(after.proposals[P1].state, schema::ProposalState::Reverted);
        assert_eq!(after.proposals[P3].state, schema::ProposalState::Applied);
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let reverted = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_PROPOSAL_REVERTED)
            .unwrap();
        assert_eq!(reverted.body["proposal_id"], serde_json::json!(P1));
        assert_eq!(
            reverted.body["reverted_by_proposal_id"],
            serde_json::json!(P3)
        );
        assert_eq!(
            reverted.body["prior_applied_event_ids"],
            serde_json::json!([applied_event])
        );
        // The original application is still on disk, untouched.
        assert!(read
            .frames
            .iter()
            .any(|f| f.event_id == applied_event && f.kind == schema::KIND_PROPOSAL_APPLIED));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_revert_of_something_the_table_calls_non_invertible_is_refused() {
        let (vault, mut writer, belief) = seeded("commit-revert-unsupported");
        // Tombstone is `revert: none`, so its application stores no plan.
        submit(&mut writer, P1, tombstone_op(&belief), &belief, Risk::High);
        commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        record_decision(
            &mut writer,
            &vault,
            P1,
            Decision::Approve,
            "human:me",
            None,
            "2026-08-09T10:00:00Z",
        )
        .unwrap();
        resolve_commit_set(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        let applied = state(&writer, &vault);
        assert!(applied.proposals[P1].revert_plan.is_none());

        const REVERT_RUN: &str = "7333333333333333333333333333333c";
        const P3: &str = "0000000000000000000000000000000c";
        let revert = proposal(
            P3,
            REVERT_RUN,
            ProposalOp::RevertProposal {
                applied_proposal_id: P1.into(),
                applied_event_ids: vec![applied.proposals[P1].applied_event_id.clone().unwrap()],
            },
            vec![target(
                TargetClass::Proposal,
                P1,
                applied.version("proposal", P1),
            )],
            Risk::Medium,
        );
        submit_proposal(&table(), &mut writer, &actor(), &revert).unwrap();
        let err = commit_proposals(&table(), &mut writer, &vault, REVERT_RUN, &[P3.to_string()])
            .unwrap_err();
        assert!(err.detail.contains("revert_not_supported"), "{err:?}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_stored_inverse_exists_exactly_where_the_table_says_one_click() {
        // A tripwire, not a spot check: what `expand` produces and what the
        // table promises must be the same set, or the UI would offer Revert
        // on something with no inverse (or hide it on something with one).
        let table = table();
        let with_steps: std::collections::BTreeSet<&str> = table
            .ops
            .iter()
            .filter(|(_, rule)| rule.revert == Revert::OneClick)
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            with_steps,
            std::collections::BTreeSet::from([
                "contest_belief",
                "edit_relation",
                "promote_draft",
                "supersede_belief",
                "update_belief",
            ]),
            "the one_click set changed — expand.rs must gain or lose an inverse to match"
        );
    }

    #[test]
    fn a_lost_acknowledgement_replays_instead_of_duplicating() {
        // The retry contract: same set, same transition, same key → the
        // already-committed receipt, not a second application.
        let (vault, mut writer, belief) = seeded("commit-replay");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        let ordered = [P1.to_string()];
        let first = commit_proposals(&table(), &mut writer, &vault, RUN, &ordered).unwrap();
        assert!(!first.replayed);
        let head = writer.head();

        // The caller never saw the answer and asks again. `commit_proposals`
        // refuses a non-submitted member, so the retry enters through the
        // same door the writer offers: the operation key.
        let key = operation_key(&first.commit_set_id, TransitionCode::Apply, &[]);
        let again = writer
            .append_batch(
                vec![(
                    schema::KIND_PROPOSAL_APPLIED.to_string(),
                    serde_json::json!({}),
                )],
                Some(&key),
            )
            .unwrap_err();
        assert!(
            again.contains("different logical plan"),
            "same key + different bytes is refused, never silently deduped: {again}"
        );
        assert_eq!(writer.head(), head, "the refused retry wrote nothing");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_dead_run_before_the_terminal_commit_applies_nothing() {
        let (vault, mut writer, belief) = seeded("commit-dead-run");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        submit(&mut writer, P2, tombstone_op(&belief), &belief, Risk::High);
        // The run dies here. Both proposals are durable and inspectable...
        let state = state(&writer, &vault);
        assert_eq!(state.proposals.len(), 2);
        assert!(state
            .proposals
            .values()
            .all(|row| row.state == ProposalState::Submitted));
        // ...and nothing whatsoever happened to the world.
        assert_eq!(state.beliefs[&belief].current().revision, 1);
        assert!(state.beliefs[&belief].tombstoned_by.is_none());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_proposal_from_another_run_cannot_join_this_set() {
        let (vault, mut writer, belief) = seeded("commit-foreign-run");
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        let other = proposal(
            P2,
            "8222222222222222222222222222222e",
            tombstone_op(&belief),
            vec![target(TargetClass::Belief, &belief, Some(1))],
            Risk::High,
        );
        submit_proposal(&table(), &mut writer, &actor(), &other).unwrap();
        let err = commit_proposals(
            &table(),
            &mut writer,
            &vault,
            RUN,
            &[P1.to_string(), P2.to_string()],
        )
        .unwrap_err();
        assert_eq!(err.code, "run_actor_mismatch");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn every_transition_has_its_own_operation_key() {
        // Rejecting after review is not the same operation as refusing at
        // submission, even though both refuse every member — so a retry of
        // one can never replay as the other.
        let set = "5e75e75e75e75e75e75e75e75e75e75e";
        let keys: std::collections::BTreeSet<String> = TransitionCode::ALL
            .iter()
            .map(|t| operation_key(set, *t, &[]))
            .collect();
        assert_eq!(keys.len(), TransitionCode::ALL.len());
        // The causal decisions are part of the key, and their order is not.
        let a = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0".to_string();
        let b = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1".to_string();
        assert_eq!(
            operation_key(set, TransitionCode::Apply, &[a.clone(), b.clone()]),
            operation_key(set, TransitionCode::Apply, &[b, a.clone()])
        );
        assert_ne!(
            operation_key(set, TransitionCode::Apply, &[]),
            operation_key(set, TransitionCode::Apply, &[a])
        );
    }

    #[test]
    fn the_commit_set_id_binds_the_run_and_the_frozen_order() {
        let a = "0000000000000000000000000000000a".to_string();
        let b = "0000000000000000000000000000000b".to_string();
        assert_ne!(
            derive_commit_set_id(RUN, &[a.clone(), b.clone()]),
            derive_commit_set_id(RUN, &[b.clone(), a.clone()]),
            "order is identity: it is the order the apply batch runs in"
        );
        assert_ne!(
            derive_commit_set_id(RUN, std::slice::from_ref(&a)),
            derive_commit_set_id("8222222222222222222222222222222e", &[a]),
            "two runs proposing the same thing are two sets"
        );
    }

    /// A type doc whose field names deliberately say nothing a policy rule
    /// could pattern-match on: the roles do all the work.
    const METRIC_TYPE_DOC: &str = "---\ntype: Type\nfields:\n  status: { kind: status }\n  \
         steward: { kind: text, role: owner }\n  \
         breaks_when: { kind: text, role: failure_condition }\n---\n\n# Metric\n";

    const P3: &str = "0000000000000000000000000000000c";

    #[test]
    fn a_high_stakes_change_waits_and_the_ledger_says_what_it_is_waiting_for() {
        // M24.8 END TO END. The op is a MEDIUM update that would auto-apply
        // on its own; declaring HIGH intended use holds it, and the queued
        // event carries the reason. A card that cannot say why it is waiting
        // is a card nobody can act on — and "why" is not recomputable later,
        // because the world moves.
        let (vault, mut writer, belief) = seeded("commit-high-stakes");
        let mut p = proposal(
            P1,
            RUN,
            update_op(&belief, "x"),
            vec![target(TargetClass::Belief, &belief, Some(1))],
            Risk::Medium,
        );
        p.intended_use.stakes = Risk::High;
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();

        let outcome =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::InitialQueue);
        assert!(matches!(outcome.results[0], SubmitResult::Queued { .. }));

        let state = state(&writer, &vault);
        assert_eq!(state.proposals[P1].state, ProposalState::Queued);
        assert_eq!(
            state.proposals[P1].queued_for,
            vec!["high_stakes_verification_required".to_string()],
            "the ledger, not a recomputation, is what says why"
        );
        // The risk ladder did not move: this is a MEDIUM change being held
        // by a stopping rule, not a HIGH one.
        assert_eq!(state.proposals[P1].queued_risk, Some(Risk::Medium));
        assert_eq!(
            state.beliefs[&belief].current().revision,
            1,
            "nothing applied while it waits"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn creating_without_a_search_becomes_a_refusal_the_vault_keeps() {
        // §15 END TO END, and the reason the check moved out of the schema
        // layer in M24.7: a create with no receipt is a DURABLE proposal
        // that is then refused in the ledger. "The agent created without
        // looking" is epistemic history; refusing it as a malformed argument
        // would have filed it in the operational log with the typos, where
        // no Skeptic will ever read it.
        let (vault, mut writer, _) = seeded("commit-no-receipt");
        let fresh = "7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
        let entity = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";
        let create = ProposalOp::CreateBelief {
            belief_id: fresh.into(),
            subject: crate::ledger::schema::SubjectRef::Resolved {
                entity_id: entity.into(),
                aliases: vec!["untouched.md".into()],
            },
            content: "# Untouched\n".into(),
            fields: serde_json::json!({}),
            basis: crate::ledger::schema::BeliefBasis::Unsupported {
                reason: "fixture".into(),
            },
            distinctness_reason: "asserted, never searched".into(),
        };
        let p = proposal(
            P1,
            RUN,
            create,
            vec![target(TargetClass::Belief, fresh, None)],
            Risk::Low,
        );
        // It submits: the refusal is ledger-destined, and a ledger refusal
        // needs a proposal to point at.
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();

        let outcome =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::InitialReject);
        let SubmitResult::Rejected { rejection, .. } = &outcome.results[0] else {
            panic!("expected a refusal, got {:?}", outcome.results[0]);
        };
        assert_eq!(rejection.code.as_str(), "candidate_receipt_missing");
        assert_eq!(rejection.rule.as_str(), "candidate_receipt_current");
        assert_eq!(rejection.code.destiny(&table()), Destiny::Ledger);

        let state = state(&writer, &vault);
        assert_eq!(state.proposals[P1].state, ProposalState::Rejected);
        assert!(
            !state.beliefs.contains_key(fresh),
            "nothing was created — the refusal is the whole effect"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unqualified_promotion_parks_visibly_and_clears_when_the_roles_arrive() {
        // THE WHOLE PHASE, END TO END, through the vault's real YAML: the
        // gate refuses, the refusal leaves a worklist entry naming exactly
        // what is missing, and filling those fields both promotes the item
        // and closes the entry. A gate that only said "no" would be a wall.
        let _sink = crate::runtime::sink::test_lock();
        let vault = testutil::temp_vault("commit-park");
        std::fs::create_dir_all(vault.join("types")).unwrap();
        std::fs::write(vault.join("types/metric.md"), METRIC_TYPE_DOC).unwrap();
        crate::runtime::sink::arm(&vault).unwrap();

        let mut writer = LedgerWriter::open(&vault, "1111111111111111111111111111111a").unwrap();
        let store = writer.store_id().to_string();
        let belief = seed_belief_with(
            &mut writer,
            "pick-a-metric",
            serde_json::json!({ "type": "Metric" }),
        );
        // The profile an honest caller must pin is the one the type doc
        // implies — derived here from the file on disk, not hand-written.
        let profile = crate::policy::qualification::read_types(&vault).unwrap()["Metric"]
            .profile()
            .unwrap();
        let promote = |id: &str, version: u64| {
            proposal(
                id,
                RUN,
                ProposalOp::PromoteDraft {
                    belief_id: belief.clone(),
                    qualification_profile: profile.clone(),
                },
                vec![target(TargetClass::Belief, &belief, Some(version))],
                Risk::Medium,
            )
        };

        submit_proposal(&table(), &mut writer, &actor(), &promote(P1, 1)).unwrap();
        let outcome =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::InitialReject);
        let SubmitResult::Rejected { rejection, .. } = &outcome.results[0] else {
            panic!("expected a refusal, got {:?}", outcome.results[0]);
        };
        assert_eq!(rejection.code.as_str(), "qualification_missing");
        assert_eq!(rejection.rule.as_str(), "qualification_roles_present");
        // The card can say what was wanted and what was there.
        assert_eq!(
            rejection.expected,
            TypedValue::string("failure_condition,owner")
        );
        // Ledger destiny: "this item is not ready" is epistemic history, not
        // a plumbing mistake.
        assert_eq!(rejection.code.destiny(&table()), Destiny::Ledger);

        let parked = |store: &str| {
            crate::runtime::sink::with_sink(|conn| {
                crate::runtime::parked::open_rows(conn, store).unwrap()
            })
            .unwrap()
        };
        let rows = parked(&store);
        assert_eq!(rows.len(), 1, "the refusal must leave a visible trace");
        assert_eq!(rows[0].belief_id, belief);
        assert_eq!(rows[0].type_id, "Metric");
        assert_eq!(rows[0].missing_roles, vec!["failure_condition", "owner"]);

        // Fill the two fields the roles point at. An UPDATE is not gated —
        // only promotion is.
        let fill = ProposalOp::UpdateBelief {
            belief_id: belief.clone(),
            patch: vec![
                schema::PatchOp {
                    field_path: "/fields/steward".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("[[Ada]]"),
                },
                schema::PatchOp {
                    field_path: "/fields/breaks_when".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("the pipeline stops emitting"),
                },
            ],
            basis: crate::ledger::schema::BeliefBasis::Unsupported {
                reason: "seed".into(),
            },
        };
        submit(&mut writer, P2, fill, &belief, Risk::Medium);
        let filled =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P2.to_string()]).unwrap();
        assert_eq!(filled.transition, TransitionCode::Apply);
        assert_eq!(
            parked(&store).len(),
            1,
            "filling the fields is not itself a promotion — the item stays parked until one"
        );

        submit_proposal(&table(), &mut writer, &actor(), &promote(P3, 2)).unwrap();
        let promoted =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P3.to_string()]).unwrap();
        assert_eq!(promoted.transition, TransitionCode::Apply);
        assert_eq!(
            state(&writer, &vault).beliefs[&belief].qualification,
            crate::ledger::schema::Qualification::Qualified
        );
        assert!(
            parked(&store).is_empty(),
            "the debt lane must let go once the roles pass"
        );
        // Closed, not deleted: the lane can still say how long it sat.
        // Scoped to this store: the sink is process-global, so a unit test
        // running in parallel may hold a row of its own in this database.
        let total = crate::runtime::sink::with_sink(|conn| {
            conn.query_row(
                "SELECT count(*) FROM parked_promotions WHERE store_id = ?1",
                [&store],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        })
        .unwrap();
        assert_eq!(total, 1);

        crate::runtime::sink::disarm();
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_unqualified_item_is_still_editable_and_still_tombstonable() {
        // NEVER BLOCKING CAPTURE. The gate fires on promotion and nowhere
        // else, so an item missing every required role is still an ordinary
        // record that can be edited, corrected, and retired.
        let vault = testutil::temp_vault("commit-park-free");
        std::fs::create_dir_all(vault.join("types")).unwrap();
        std::fs::write(vault.join("types/metric.md"), METRIC_TYPE_DOC).unwrap();
        let mut writer = LedgerWriter::open(&vault, "1111111111111111111111111111111a").unwrap();
        let belief = seed_belief_with(
            &mut writer,
            "rough-note",
            serde_json::json!({ "type": "Metric" }),
        );

        submit(
            &mut writer,
            P1,
            update_op(&belief, "still thinking"),
            &belief,
            Risk::Medium,
        );
        let outcome =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::Apply);
        assert_eq!(
            state(&writer, &vault).beliefs[&belief].current().revision,
            2
        );
        let _ = std::fs::remove_dir_all(&vault);
    }
}

/// Crash-scenario children and the all-or-nothing matrix (M24.4).
///
/// Every set transition is proved twice: killed among the batch members
/// (durable frames, no marker) it must have ZERO effect, and killed after
/// the marker's fsync it must be COMPLETE. The parent performs the setup and
/// drops its writer, so the child process reaches exactly the transition
/// under test and the shared writer kill points are unambiguous.
#[cfg(test)]
mod crash_tests {
    use super::tests_support::*;
    use super::*;
    use crate::ledger::reduce::reduce;
    use crate::policy::table::Risk;
    use crate::vault::testutil;

    fn child_writer(vault: &Path) -> LedgerWriter {
        LedgerWriter::open(vault, "1111111111111111111111111111111a").unwrap()
    }

    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_initial_commit() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = std::path::PathBuf::from(vault);
        let mut writer = child_writer(&vault);
        let _ = commit_proposals(
            &PolicyTable::load().unwrap(),
            &mut writer,
            &vault,
            RUN,
            &[P1.to_string(), P2.to_string()],
        );
    }

    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_resolve_commit() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        let vault = std::path::PathBuf::from(vault);
        let mut writer = child_writer(&vault);
        let _ = resolve_commit_set(
            &PolicyTable::load().unwrap(),
            &mut writer,
            &vault,
            RUN,
            &[P1.to_string(), P2.to_string()],
        );
    }

    /// Fold the vault's ledger without holding a writer.
    fn folded(vault: &Path) -> EpistemicState {
        let read = read_ledger(&ledger_dir(vault)).unwrap();
        reduce(&read.frames, &read.store.store_id)
    }

    /// Set up a vault to the point where `child` performs exactly the
    /// transition under test, then release the writer.
    fn staged(name: &str, transition: TransitionCode) -> (std::path::PathBuf, String) {
        let vault = testutil::temp_vault(name);
        let mut writer = child_writer(&vault);
        let belief = seed_belief(&mut writer, "seed");
        let table = PolicyTable::load().unwrap();

        // `initial_reject` needs a member the table refuses; every other
        // transition needs a set that passes.
        let second_risk = if transition == TransitionCode::InitialReject {
            Risk::Low
        } else {
            Risk::High
        };
        submit(
            &mut writer,
            P1,
            update_op(&belief, "x"),
            &belief,
            Risk::Medium,
        );
        submit(&mut writer, P2, tombstone_op(&belief), &belief, second_risk);

        let ordered = [P1.to_string(), P2.to_string()];
        match transition {
            TransitionCode::InitialQueue | TransitionCode::InitialReject => {}
            TransitionCode::HumanReject => {
                commit_proposals(&table, &mut writer, &vault, RUN, &ordered).unwrap();
                record_decision(
                    &mut writer,
                    &vault,
                    P2,
                    Decision::Reject,
                    "human:me",
                    Some("no"),
                    "2026-08-09T10:00:00Z",
                )
                .unwrap();
            }
            TransitionCode::Apply | TransitionCode::StaleReject => {
                commit_proposals(&table, &mut writer, &vault, RUN, &ordered).unwrap();
                for id in &ordered {
                    record_decision(
                        &mut writer,
                        &vault,
                        id,
                        Decision::Approve,
                        "human:me",
                        None,
                        "2026-08-09T10:00:00Z",
                    )
                    .unwrap();
                }
                if transition == TransitionCode::StaleReject {
                    attest(&mut writer, &vault, &belief);
                }
            }
        }
        drop(writer); // release the single-writer lock for the child
        (vault, belief)
    }

    fn scenario(transition: TransitionCode) -> &'static str {
        match transition {
            TransitionCode::InitialQueue | TransitionCode::InitialReject => {
                "policy::commit::crash_tests::crash_scenario_initial_commit"
            }
            _ => "policy::commit::crash_tests::crash_scenario_resolve_commit",
        }
    }

    /// The state each transition leaves behind when it COMPLETES.
    fn completed(transition: TransitionCode) -> ProposalState {
        match transition {
            TransitionCode::InitialQueue => ProposalState::Queued,
            TransitionCode::Apply => ProposalState::Applied,
            _ => ProposalState::Rejected,
        }
    }

    /// The state the set is in BEFORE each transition runs.
    fn before(transition: TransitionCode) -> ProposalState {
        match transition {
            TransitionCode::InitialQueue | TransitionCode::InitialReject => {
                ProposalState::Submitted
            }
            _ => ProposalState::Queued,
        }
    }

    #[test]
    fn no_crash_can_expose_a_partial_commit_set() {
        // THE ALL-OR-NOTHING PROOF, for every transition. Killed among the
        // members the durable frames have zero reducer effect; killed after
        // the marker's fsync the transition is whole. There is no kill point
        // that leaves half a set decided.
        for transition in TransitionCode::ALL {
            let name = format!("commit-crash-{}", transition.as_str());

            // (1) Killed after the first member is durable, before the
            //     marker: the frames exist and mean NOTHING.
            let (vault, belief) = staged(&format!("{name}-partial"), transition);
            let status = testutil::run_crash_scenario(
                scenario(transition),
                "ledger-batch-member-0-written",
                &vault,
            );
            assert!(!status.success(), "{transition:?}: the child died");
            let state = folded(&vault);
            for id in [P1, P2] {
                assert_eq!(
                    state.proposals[id].state,
                    before(transition),
                    "{transition:?}: a member moved without a marker"
                );
            }
            assert_eq!(
                state.beliefs[&belief].current().revision,
                1,
                "{transition:?}: a mutation escaped an uncommitted batch"
            );
            assert!(state.beliefs[&belief].tombstoned_by.is_none());
            let _ = std::fs::remove_dir_all(&vault);

            // (2) Killed after the marker's fsync, before the acknowledgement:
            //     the transition is COMPLETE for every member.
            let (vault, _) = staged(&format!("{name}-durable"), transition);
            let status =
                testutil::run_crash_scenario(scenario(transition), "ledger-batch-synced", &vault);
            assert!(!status.success(), "{transition:?}: the child died");
            let state = folded(&vault);
            for id in [P1, P2] {
                assert_eq!(
                    state.proposals[id].state,
                    completed(transition),
                    "{transition:?}: a durable marker left a member behind"
                );
            }
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    #[test]
    fn a_crash_before_projection_leaves_the_ledger_ahead_and_recoverable() {
        // The marker is durable and the apply is real, but no file was
        // written yet. M23's protocol repairs that from the committed
        // ledger — never by inventing an assertion from the crash.
        let (vault, belief) = staged("commit-crash-projection", TransitionCode::Apply);
        let status = testutil::run_crash_scenario(
            scenario(TransitionCode::Apply),
            "commit-set-apply-committed",
            &vault,
        );
        assert!(!status.success());
        let state = folded(&vault);
        assert_eq!(state.proposals[P1].state, ProposalState::Applied);
        assert!(
            state.beliefs[&belief].tombstoned_by.is_some(),
            "the whole set applied"
        );
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert!(
            !read
                .frames
                .iter()
                .any(|f| f.kind == schema::KIND_OBSERVATION_RECORDED),
            "zero human assertions fabricated from the crash"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }
}
