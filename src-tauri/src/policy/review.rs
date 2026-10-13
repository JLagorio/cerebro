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
    /// The concept file a Belief target is (`knowledge/…`), so the card can
    /// name and open it (M50.3) — it showed the first eight hex of an id.
    /// `None` for every other class, and for a belief with no projection.
    pub path: Option<String>,
    /// For the relation an `edit_relation` card would add or remove: its two
    /// ends and its kind (M52.5). A relation has no file of its own, so the
    /// card read "Change a link" and named no concept at all. `None` for
    /// every other target.
    pub link: Option<CardLink>,
}

/// The link a relation target is, by the concepts at its ends.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardLink {
    /// `add` or `remove` — the op's own action.
    pub action: schema::RelationAction,
    /// `supersedes`, `refines` or `contradicts`.
    pub relation: schema::RelationKind,
    /// Each end's concept file, when the belief has one (`knowledge/…`).
    pub from_path: Option<String>,
    pub to_path: Option<String>,
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
    /// The concept it changed, by file (M52.5): the first belief target a
    /// file projects, as a card's target carries it. "Revise — corrected
    /// the churn definition" named no concept at all. `None` when no belief
    /// target has a file.
    pub path: Option<String>,
}

/// The concept file a belief projects to, when it has one (`knowledge/…`).
fn belief_path(state: &EpistemicState, belief_id: &str) -> Option<String> {
    state
        .projection_paths
        .iter()
        .find(|(_, belief)| belief.as_str() == belief_id)
        .map(|(krel, _)| format!("knowledge/{krel}"))
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
    let path_of = |belief_id: &str| belief_path(state, belief_id);
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
                    path: (target.target_class == TargetClass::Belief)
                        .then(|| path_of(&target.target_id))
                        .flatten(),
                    link: match &proposal.op {
                        schema::ProposalOp::EditRelation {
                            relation_id,
                            action,
                            from,
                            to,
                            relation,
                        } if target.target_class == TargetClass::Relation
                            && *relation_id == target.target_id =>
                        {
                            Some(CardLink {
                                action: *action,
                                relation: *relation,
                                from_path: path_of(from),
                                to_path: path_of(to),
                            })
                        }
                        _ => None,
                    },
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
                path: row
                    .proposal
                    .targets
                    .iter()
                    .filter(|target| target.target_class == TargetClass::Belief)
                    .find_map(|target| belief_path(state, &target.target_id)),
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
    let outcome = commit::resolve_commit_set(
        &table,
        writer,
        vault,
        &set.run_id,
        &set.ordered_proposal_ids,
    )
    .map_err(|e| e.detail)?;
    // The other half of the run's row (M49.9): submit time counted these
    // members as submitted and queued; the decision is what applies or
    // rejects them. A set's members all carry `set.run_id` — the commit
    // refuses a member from another run.
    outcome.book_decision(&set.run_id);
    Ok(Some(outcome))
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

    /// Its own run id: the sink is process-global, and every other test here
    /// decides under `RUN` — a shared id would let them book onto this row.
    const BOOKED_RUN: &str = "7b00ced0000000000000000000000001";

    /// Queue one HIGH proposal inside a metered run, booking the submit half
    /// exactly as the production callers (`write_concept_in_run_with`,
    /// `tool_commit_proposals`) do. The run's row is opened the way an
    /// attended spawn opens it (M49.9). The caller holds the sink lock.
    fn queued_in_a_run(name: &str) -> (std::path::PathBuf, LedgerWriter) {
        let (vault, mut writer, belief) = seeded(name);
        crate::runtime::sink::arm(&vault).unwrap();
        let started = chrono::DateTime::parse_from_rfc3339("2026-09-27T10:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        crate::runtime::sink::with_sink(|conn| {
            crate::runtime::dispatch::begin_attended(
                conn, BOOKED_RUN, None, None, None, None, started,
            )
        })
        .unwrap()
        .unwrap();
        let p = proposal(
            P1,
            BOOKED_RUN,
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
            commit_proposals(&table(), &mut writer, &vault, BOOKED_RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::InitialQueue);
        outcome.book(BOOKED_RUN);
        (vault, writer)
    }

    /// (submitted, applied, rejected) on the booked run's row.
    fn counters() -> (i64, i64, i64) {
        crate::runtime::sink::with_sink(|conn| {
            conn.query_row(
                "SELECT proposals_submitted, applied, rejected FROM runs WHERE run_id = ?1",
                [BOOKED_RUN],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap()
        .unwrap()
    }

    // M49.9: the human half of a queued run is booked. Before it, the
    // decision path never touched the row, so a run whose card was approved
    // or rejected read "1 still waiting on a decision" forever.
    #[test]
    fn approving_a_queued_set_books_it_applied_and_never_resubmits() {
        let _sink = crate::runtime::sink::test_lock();
        let (vault, mut writer) = queued_in_a_run("review-booked-approve");
        assert_eq!(counters(), (1, 0, 0), "submitted, and waiting");
        let outcome = decide(&mut writer, &vault, P1, true, REVIEWER, None)
            .unwrap()
            .unwrap();
        assert_eq!(outcome.transition, TransitionCode::Apply);
        assert_eq!(
            counters(),
            (1, 1, 0),
            "applied once; submitted is not counted twice"
        );
        crate::runtime::sink::disarm();
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn rejecting_a_queued_set_books_it_rejected_and_never_resubmits() {
        let _sink = crate::runtime::sink::test_lock();
        let (vault, mut writer) = queued_in_a_run("review-booked-reject");
        assert_eq!(counters(), (1, 0, 0));
        let outcome = decide(
            &mut writer,
            &vault,
            P1,
            false,
            REVIEWER,
            Some("still cited"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(outcome.transition, TransitionCode::HumanReject);
        assert_eq!(counters(), (1, 0, 1));
        // A second answer to a resolved set resolves nothing and books
        // nothing.
        assert!(decide(&mut writer, &vault, P1, true, REVIEWER, None)
            .unwrap()
            .is_none());
        assert_eq!(counters(), (1, 0, 1));
        crate::runtime::sink::disarm();
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
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
        // It names the concept it changed, by the file its belief projects.
        assert!(
            offered[0]
                .path
                .as_deref()
                .is_some_and(|path| path.starts_with("knowledge/")),
            "an application names its concept: {:?}",
            offered[0].path
        );

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

    #[test]
    fn a_link_card_names_both_of_its_ends() {
        // M52.5: a relation has no file, so its card read "Change a link"
        // and named no concept. The ends are the op's own, each named by the
        // file its belief projects to — or by nothing, when it has none.
        let (vault, mut writer, left) = seeded("review-link");
        let store = writer.store_id().to_string();
        let right = schema::migrate_id(&store, "belief", "other");
        let created = schema::BeliefCreated {
            schema: schema::BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: actor(),
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: right.clone(),
            subject: SubjectRef::Resolved {
                entity_id: schema::migrate_id(&store, "entity", "other"),
                aliases: vec!["other.md".into()],
            },
            content: "# other\n".into(),
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
        let relation_id = schema::derive_relation_id(&left, &right, schema::RelationKind::Refines);
        let mut targets = vec![
            target(TargetClass::Belief, &left, Some(1)),
            target(TargetClass::Belief, &right, Some(1)),
        ];
        targets.sort_by(|a, b| a.target_id.cmp(&b.target_id));
        targets.push(target(TargetClass::Relation, &relation_id, None));
        let p = proposal(
            P1,
            RUN,
            ProposalOp::EditRelation {
                relation_id: relation_id.clone(),
                action: schema::RelationAction::Add,
                from: left.clone(),
                to: right.clone(),
                relation: schema::RelationKind::Refines,
            },
            targets,
            Risk::High,
        );
        submit_proposal(&table(), &mut writer, &actor(), &p).unwrap();
        let outcome =
            commit_proposals(&table(), &mut writer, &vault, RUN, &[P1.to_string()]).unwrap();
        assert_eq!(outcome.transition, TransitionCode::InitialQueue);

        // One end projects to a file; the other is made to have none.
        let mut state = folded(&writer, &vault);
        state.projection_paths.retain(|_, belief| *belief != right);
        let left_path = state
            .projection_paths
            .iter()
            .find(|(_, belief)| **belief == left)
            .map(|(krel, _)| format!("knowledge/{krel}"));
        assert!(left_path.is_some(), "the seeded belief projects");
        let card = needs_review(&table(), &state).into_iter().next().unwrap();
        let link = card
            .targets
            .iter()
            .find(|t| t.target_class == "relation")
            .and_then(|t| t.link.clone())
            .expect("the relation target names its link");
        assert_eq!(link.action, schema::RelationAction::Add);
        assert_eq!(link.relation, schema::RelationKind::Refines);
        assert_eq!(link.from_path, left_path);
        // No projection is no name, never a guess.
        assert_eq!(link.to_path, None);
        assert!(card
            .targets
            .iter()
            .filter(|t| t.target_class != "relation")
            .all(|t| t.link.is_none()));
        // On the wire, as the surface reads it.
        let wire = serde_json::to_value(&card).unwrap();
        let relation = wire["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["target_class"] == "relation")
            .unwrap()
            .clone();
        assert_eq!(relation["link"]["action"], "add");
        assert_eq!(relation["link"]["relation"], "refines");
        drop(writer);
        let _ = std::fs::remove_dir_all(&vault);
    }
}
