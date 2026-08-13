//! The canonical op → event expansion (M24.4).
//!
//! **No interpreter branch may emit an unnamed mutation kind.** Every op in
//! `OP_INVENTORY` expands here, through one exhaustive match, into a closed
//! plan of schema-v1 bodies — and nowhere else does a proposal become
//! events. That is what makes "which mutations can policy authorize?"
//! answerable by reading one file, instead of trusting that no branch
//! anywhere assembles a body of its own.
//!
//! The plan is SYMBOLIC: same-batch references are `writer::member_ref`
//! ordinals, because member event ids do not exist until preallocation. The
//! operation digest hashes exactly this symbolic form, so a retry that
//! receives fresh physical ids still replays as the same operation.
//!
//! Two conventions carried from the design, both load-bearing:
//!
//! - **A replacement is always relation `from`, the replaced predecessor is
//!   `to`.** `supersede_members` is the shared subroutine; exact merge,
//!   split, and mass-supersede all call it rather than each spelling the
//!   pair and drifting.
//! - **Traversal order is fixed** (receipt order, output-id order, pair
//!   order). The digest hashes the ordered plan, so an expansion that
//!   iterated an unordered map would hash differently per process and
//!   idempotent retry would quietly stop working.

use serde::Serialize;

use crate::ledger::reduce::{BeliefState, EpistemicState};
use crate::ledger::schema::{
    self, Actor, BasisLink, BeliefBasis, ContestAction, ContestAddressing, IndependenceProof,
    Lifecycle, LifecycleCause, ProposalOp, Qualification, QualificationCause, RelationAction,
    RelationKind, ResolutionChange, RevertStep, RewriteDisposition, TargetClass,
};
use crate::ledger::writer::member_ref;

/// What one op becomes.
#[derive(Debug, Clone, PartialEq)]
pub struct Expansion {
    /// The symbolic member plan, in emission order.
    pub members: Vec<(String, serde_json::Value)>,
    /// Every target this plan advances whose identity exists BEFORE the
    /// batch — the CAS write set (M24.5) and the revert plan's post-version
    /// domain.
    ///
    /// A recorded Observation is the one target whose identity IS its own
    /// event id, so creating one cannot appear here. Those are creations
    /// with no prior version, no CAS to check, and no stored inverse.
    pub write_targets: Vec<(TargetClass, String)>,
    /// The stored inverse. Non-empty exactly for the ops whose table rule
    /// says `revert: one_click` — held to the table by a tripwire test
    /// rather than kept in sync by hand.
    pub revert_steps: Vec<RevertStep>,
}

/// What the server knows that the payload does not.
pub struct ExpansionContext<'a> {
    /// The run's actor. Every generated body commits under it; nothing an
    /// agent separately claims.
    pub actor: Actor,
    pub state: &'a EpistemicState,
    /// Where this op's first member sits in the whole batch, so same-batch
    /// references resolve to the right physical id.
    pub base_ordinal: usize,
    /// The approving decision, when a human authorized this application.
    pub decision_event_id: Option<String>,
    /// The proposal being expanded — its id binds server proofs that must
    /// name the proposal they came from.
    pub proposal_id: String,
    /// Beliefs and Entities EARLIER MEMBERS OF THIS SET create.
    ///
    /// A commit set is ordered, and "create a Belief, then link it to
    /// another" is the most ordinary thing an agent proposes. Without this
    /// the second op would refuse `invalid_reference` against a snapshot
    /// taken before its own set ran — which would make atomic sets useless
    /// for exactly the case they exist for.
    pub staged_beliefs: std::collections::BTreeSet<String>,
    pub staged_entities: std::collections::BTreeSet<String>,
    /// The open contradiction edges this proposal says it addressed (M27.4).
    ///
    /// It rides the CONTEXT rather than being read off the op, because the
    /// op does not carry it: addressing lives in `basis`, which is about the
    /// proposal rather than about the mutation. By the time expansion runs,
    /// `open_contradictions_addressed` has already proven every entry names
    /// an open edge over a Belief this op touches — so this list is a fact
    /// about the world, not a claim still to be checked.
    pub addressed_contradictions: Vec<schema::AddressedContradiction>,
    /// The physical event ids this batch will carry, once the writer has
    /// preallocated them (M27.4c).
    ///
    /// `None` is the symbolic pass — target binding, and the plan the
    /// operation digest hashes. Everything an expansion emits is the same in
    /// both passes except a body that carries a value DERIVED from a sibling
    /// event id, which `member_ref` cannot express (see `writer::BatchIds`).
    /// One such body exists: the registration for a `contradicts` relation
    /// being authored right now.
    pub member_ids: Option<&'a [String]>,
    /// When the store received the proposal — the submission frame's own
    /// stamp, and the ONLY time an expansion may date a generated body by.
    ///
    /// A wall clock read here would land in the plan, and the operation digest
    /// is over the plan: a retry after a lost acknowledgement would read as a
    /// different operation and apply the set a second time.
    pub submitted_at: String,
}

impl ExpansionContext<'_> {
    fn staged_belief(&self, belief_id: &str) -> bool {
        self.staged_beliefs.contains(belief_id)
    }

    /// The id of the batch member at `ordinal`: physical once the writer has
    /// allocated, symbolic before that.
    ///
    /// Out of range is this expansion being wrong about its own arithmetic,
    /// so it refuses. Falling back to a placeholder would derive an id from a
    /// string no reader can resolve.
    fn member_id(&self, ordinal: usize) -> Result<String, ExpandError> {
        match self.member_ids {
            Some(ids) => ids.get(ordinal).cloned().ok_or_else(|| {
                refuse(
                    "schema_invalid",
                    format!(
                        "batch member {ordinal} is out of range — this batch has {} members",
                        ids.len()
                    ),
                )
            }),
            None => Ok(member_ref(ordinal)),
        }
    }
}

/// The rule version a declaration authored through this path is classified
/// under. Distinct from the backfill's, because a reader asking "what decided
/// this?" is asking which pass wrote it, not which module the gates live in.
const DECLARED_RULE_VERSION: &str = "contradiction-declared-v1";

/// A refusal discovered during expansion, in table vocabulary. Every code
/// here is a `rejection_destinies` key, so a caller records it without
/// inventing a word.
#[derive(Debug, Clone, PartialEq)]
pub struct ExpandError {
    pub code: &'static str,
    pub detail: String,
}

fn refuse(code: &'static str, detail: impl Into<String>) -> ExpandError {
    ExpandError {
        code,
        detail: detail.into(),
    }
}

fn missing(what: &str, id: &str) -> ExpandError {
    refuse("invalid_reference", format!("{what} {id} does not exist"))
}

/// The common schema-v1 header every generated body carries: no batch id and
/// no key of its own — `append_batch` stamps both.
fn common(actor: &Actor) -> (u64, Option<String>, Option<String>, Actor) {
    (schema::BODY_SCHEMA, None, None, actor.clone())
}

/// How many members one stored revert step emits. Restoring a lifecycle
/// takes two (the relation removal and the transition); everything else
/// takes one. `expand` checks its own output against this, so a step that
/// grows an event later cannot silently shift the ordinal a symbolic
/// reference was computed from.
fn step_member_count(step: &RevertStep) -> usize {
    match step {
        RevertStep::LifecycleRestored { .. } => 2,
        _ => 1,
    }
}

struct Plan<'a> {
    ctx: &'a ExpansionContext<'a>,
    members: Vec<(String, serde_json::Value)>,
    write_targets: Vec<(TargetClass, String)>,
    revert_steps: Vec<RevertStep>,
    /// Beliefs THIS expansion creates. A split's outputs are superseded
    /// into by the same plan that made them, so an expansion must see its
    /// own creations exactly as a later set member sees an earlier one's.
    created: std::collections::BTreeSet<String>,
}

impl<'a> Plan<'a> {
    fn new(ctx: &'a ExpansionContext<'a>) -> Plan<'a> {
        Plan {
            ctx,
            members: Vec::new(),
            write_targets: Vec::new(),
            revert_steps: Vec::new(),
            created: Default::default(),
        }
    }

    /// Append one member and return the batch ordinal it landed on — what a
    /// same-batch reference to it must name.
    fn push<T: Serialize>(&mut self, kind: &str, body: &T) -> Result<usize, ExpandError> {
        let ordinal = self.ctx.base_ordinal + self.members.len();
        let value =
            serde_json::to_value(body).map_err(|e| refuse("schema_invalid", e.to_string()))?;
        self.members.push((kind.to_string(), value));
        Ok(ordinal)
    }

    /// Record a target this plan advances. Duplicates collapse: an op that
    /// touches one Belief twice still names it once, so the CAS set stays a
    /// set.
    fn touches(&mut self, class: TargetClass, id: &str) {
        let entry = (class, id.to_string());
        if !self.write_targets.contains(&entry) {
            self.write_targets.push(entry);
        }
    }

    fn finish(self) -> Expansion {
        Expansion {
            members: self.members,
            write_targets: self.write_targets,
            revert_steps: self.revert_steps,
        }
    }

    /// A Belief that exists and is not tombstoned.
    ///
    /// `None` means "created by an earlier member of this same set": it
    /// exists for reference purposes and is, by construction, active, draft,
    /// and uncontested — there has been no event since its creation for it
    /// to be anything else.
    fn belief(&self, belief_id: &str) -> Result<Option<&'a BeliefState>, ExpandError> {
        match self.ctx.state.beliefs.get(belief_id) {
            Some(belief) if belief.tombstoned_by.is_some() => Err(refuse(
                "illegal_transition",
                format!("belief {belief_id} is tombstoned — nothing follows a tombstone"),
            )),
            Some(belief) => Ok(Some(belief)),
            None if self.created.contains(belief_id) || self.ctx.staged_belief(belief_id) => {
                Ok(None)
            }
            None => Err(missing("belief", belief_id)),
        }
    }

    /// The committed Belief, refusing a same-set creation. Ops that read
    /// prior content (a revision needs the basis it replaces) cannot work
    /// from a Belief this set has not written yet.
    fn committed_belief(&self, belief_id: &str) -> Result<&'a BeliefState, ExpandError> {
        self.belief(belief_id)?.ok_or_else(|| {
            refuse(
                "illegal_transition",
                format!(
                    "belief {belief_id} is created by this same commit set — it has no \
                     prior state to read"
                ),
            )
        })
    }

    /// The shared complex-plan subroutine: the successor relation, then the
    /// predecessor's lifecycle transition. Both Beliefs must exist and
    /// differ, the predecessor must be active, and the generated relation
    /// must not already be live.
    fn supersede_members(&mut self, predecessor: &str, successor: &str) -> Result<(), ExpandError> {
        if predecessor == successor {
            return Err(refuse(
                "illegal_transition",
                "a Belief cannot supersede itself",
            ));
        }
        if let Some(state) = self.belief(predecessor)? {
            if state.lifecycle != Lifecycle::Active {
                return Err(refuse(
                    "illegal_transition",
                    format!(
                        "belief {predecessor} is {:?}, not active — it cannot be superseded again",
                        state.lifecycle
                    ),
                ));
            }
        }
        self.belief(successor)?;
        let relation_id =
            schema::derive_relation_id(successor, predecessor, RelationKind::Supersedes);
        if self
            .ctx
            .state
            .relations
            .get(&relation_id)
            .is_some_and(|r| r.live)
        {
            return Err(refuse(
                "illegal_transition",
                format!("the supersedes relation {relation_id} is already live"),
            ));
        }
        let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
        self.push(
            schema::KIND_BELIEF_RELATION,
            &schema::BeliefRelation {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                relation_id: relation_id.clone(),
                action: RelationAction::Add,
                from: successor.to_string(),
                to: predecessor.to_string(),
                relation: RelationKind::Supersedes,
            },
        )?;
        let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
        self.push(
            schema::KIND_BELIEF_LIFECYCLE_CHANGED,
            &schema::BeliefLifecycleChanged {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: predecessor.to_string(),
                from: Lifecycle::Active,
                to: Lifecycle::Superseded,
                cause: LifecycleCause::Superseded,
                replacement_id: Some(successor.to_string()),
            },
        )?;
        self.touches(TargetClass::Relation, &relation_id);
        self.touches(TargetClass::Belief, predecessor);
        // M27's sorted `contradiction.closed` members belong here, once
        // those bodies exist. M24 has no contradiction edges to close.
        Ok(())
    }

    /// The retirement pair — archive and deprecate differ only in cause and
    /// in whether a successor may be named.
    fn retire(
        &mut self,
        belief_id: &str,
        cause: LifecycleCause,
        replacement_id: Option<String>,
    ) -> Result<(), ExpandError> {
        if let Some(state) = self.belief(belief_id)? {
            if state.lifecycle != Lifecycle::Active {
                return Err(refuse(
                    "illegal_transition",
                    format!("belief {belief_id} is {:?}, not active", state.lifecycle),
                ));
            }
        }
        if let Some(replacement) = &replacement_id {
            self.belief(replacement)?;
        }
        let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
        self.push(
            schema::KIND_BELIEF_LIFECYCLE_CHANGED,
            &schema::BeliefLifecycleChanged {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: belief_id.to_string(),
                from: Lifecycle::Active,
                to: Lifecycle::Archived,
                cause,
                replacement_id,
            },
        )?;
        self.touches(TargetClass::Belief, belief_id);
        Ok(())
    }

    fn relation_member(
        &mut self,
        relation_id: &str,
        action: RelationAction,
        from: &str,
        to: &str,
        relation: RelationKind,
    ) -> Result<usize, ExpandError> {
        let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
        let ordinal = self.push(
            schema::KIND_BELIEF_RELATION,
            &schema::BeliefRelation {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                relation_id: relation_id.to_string(),
                action,
                from: from.to_string(),
                to: to.to_string(),
                relation,
            },
        )?;
        self.touches(TargetClass::Relation, relation_id);
        Ok(ordinal)
    }

    /// Register, classify, and — when nothing separates the pair — open the
    /// edge for a `contradicts` relation being authored in THIS batch
    /// (M27.4c).
    ///
    /// The gauntlet is [`crate::conflict::declared`], shared with the backfill
    /// that classified the declarations this store already held. A second copy
    /// of those verdicts for newly authored declarations would be a second set
    /// of answers to keep in step, and they would drift on exactly the case
    /// the gate must never fire on — stage lag wearing a declaration.
    ///
    /// The comparison id is `sha256(relation_event_id ‖ endpoints)`, and the
    /// relation event is `relation_ordinal` of this same batch. That is why
    /// `member_id` exists: a placeholder would derive an id from the string
    /// `cerebro-batch-member:0`, which no reader could resolve.
    ///
    /// The endpoints pin the revisions the pre-batch snapshot holds. A
    /// concurrent revision would make them stale — which is what declaring
    /// both Beliefs as CAS targets is for, and why `edit_relation` requires
    /// `versions_current`.
    fn declare_contradiction(
        &mut self,
        relation_id: &str,
        relation_ordinal: usize,
        from: &str,
        to: &str,
    ) -> Result<(), ExpandError> {
        let mut pinned = Vec::new();
        for belief_id in [from, to] {
            let belief = self.committed_belief(belief_id)?;
            let revision = belief.revisions.last().ok_or_else(|| {
                refuse(
                    "invalid_reference",
                    format!("belief {belief_id} has no revision to pin a declaration to"),
                )
            })?;
            pinned.push((belief_id.to_string(), revision.event_id.clone()));
        }
        let declaration = crate::conflict::declared::Declaration {
            relation_event_id: self.ctx.member_id(relation_ordinal)?,
            relation_id: relation_id.to_string(),
            // Authored now, through the pipeline, under a live gate.
            origin: schema::RelationOrigin::PostActivationDeclared,
            from: pinned[0].clone(),
            to: pinned[1].clone(),
        };
        let planned = crate::conflict::declared::plan(
            self.ctx.state,
            &declaration,
            &self.ctx.actor,
            DECLARED_RULE_VERSION,
            &self.ctx.submitted_at,
            self.ctx.base_ordinal + self.members.len(),
        )
        .map_err(|detail| refuse("schema_invalid", detail))?
        .ok_or_else(|| {
            // Unreachable behind `committed_belief` above, which already
            // refuses a Belief that does not exist.
            refuse(
                "invalid_reference",
                "a declaration between beliefs that exist could not be classified",
            )
        })?;
        if planned.members.is_empty() {
            // Only reachable if this exact comparison were already classified,
            // which needs the relation event id — an id this batch is about to
            // mint. Refusing rather than silently emitting nothing keeps that
            // reasoning checkable instead of assumed.
            return Err(refuse(
                "illegal_transition",
                format!(
                    "comparison {} is already classified — a relation event that does not exist \
                     yet cannot have been compared",
                    planned.comparison_id
                ),
            ));
        }
        self.members.extend(planned.members);
        // Server-derived, so the target-binding predicate skips it: the caller
        // could not have named an id that follows from an event this batch is
        // about to mint. It is still a target this plan advances.
        self.touches(TargetClass::Comparison, &planned.comparison_id);
        Ok(())
    }

    /// Close every contradiction edge this proposal addressed (M27.4).
    ///
    /// **There is no caller-authored close path, and this is why.** A close
    /// is emitted here, beside the mutation that addressed the edge, naming
    /// that mutation by its symbolic ordinal — so the two commit as one batch
    /// and the reducer can insist that a close travels with something. A tool
    /// that could append a close on its own would let an edge be retired by
    /// saying so.
    ///
    /// The mutation is the op's FIRST member. That holds for all five ops the
    /// table binds this rule to — supersede, mass supersede, both merges, and
    /// split all lead with the mutation and follow it with consequences — and
    /// an op that arrived without one would be an op with nothing to address
    /// the contradiction WITH, which the empty check below refuses rather
    /// than papers over.
    fn close_addressed_contradictions(
        &mut self,
        ctx: &ExpansionContext,
    ) -> Result<(), ExpandError> {
        let addressed = &ctx.addressed_contradictions;
        if addressed.is_empty() {
            return Ok(());
        }
        if self.members.is_empty() {
            return Err(refuse(
                "schema_invalid",
                "a proposal that addresses a contradiction expanded to no mutation — there would                  be nothing for the close to name",
            ));
        }
        let mutation = crate::ledger::writer::member_ref(ctx.base_ordinal);
        for entry in addressed {
            let Some(edge) = ctx.state.contradiction_edges.get(&entry.edge_id) else {
                // Unreachable behind the precondition, which refuses an
                // unknown edge as `contradiction_edge_stale` before the
                // expansion runs. Refusing rather than skipping keeps that
                // true if the two ever drift.
                return Err(refuse(
                    "invalid_reference",
                    format!("addressed edge {} does not exist", entry.edge_id),
                ));
            };
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            self.push(
                schema::KIND_CONTRADICTION_CLOSED,
                &schema::ContradictionClosed {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    edge_id: entry.edge_id.clone(),
                    comparison_id: entry.comparison_id.clone(),
                    // COPIED from the edge, never re-described from the
                    // proposal: the close says which edge closed, and a
                    // caller's second opinion about its endpoints would be a
                    // second chance to close the wrong one.
                    left_belief_id: edge.left_belief_id.clone(),
                    right_belief_id: edge.right_belief_id.clone(),
                    addressed_by_event_id: mutation.clone(),
                    evidence_event_ids: entry.evidence_refs.clone(),
                    disposition: match entry.disposition {
                        schema::ContradictionDisposition::ResolvedWithEvidence => {
                            schema::CloseDisposition::ResolvedWithEvidence
                        }
                        schema::ContradictionDisposition::SupersededWithAddressing => {
                            schema::CloseDisposition::SupersededWithAddressing
                        }
                    },
                },
            )?;
            // The comparison and both endpoint Beliefs advance through the
            // close, exactly as the version matrix says.
            self.touches(TargetClass::Comparison, &entry.comparison_id);
            self.touches(TargetClass::Belief, &edge.left_belief_id);
            self.touches(TargetClass::Belief, &edge.right_belief_id);
        }
        Ok(())
    }

    fn revised_member(
        &mut self,
        belief_id: &str,
        patch: Vec<schema::PatchOp>,
        basis: BeliefBasis,
    ) -> Result<usize, ExpandError> {
        let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
        let ordinal = self.push(
            schema::KIND_BELIEF_REVISED,
            &schema::BeliefRevised {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                belief_id: belief_id.to_string(),
                patch,
                basis,
            },
        )?;
        self.touches(TargetClass::Belief, belief_id);
        Ok(ordinal)
    }

    /// One stored revert step becomes its named forward event(s).
    /// `applied_ref` is the symbolic reference to the reverting
    /// application's own `proposal.applied` member — the only thing a
    /// contest close can honestly name as what addressed it.
    fn revert_step(&mut self, step: &RevertStep, applied_ref: &str) -> Result<(), ExpandError> {
        match step {
            RevertStep::BeliefRevised {
                belief_id,
                patch,
                basis,
            } => {
                self.belief(belief_id)?;
                self.revised_member(belief_id, patch.clone(), basis.clone())?;
            }
            RevertStep::LifecycleRestored {
                belief_id,
                from,
                to,
                relation_id,
                successor_id,
            } => {
                // Relation removal first, then the lifecycle restoration —
                // the exact inverse order of `supersede_members`.
                self.belief(belief_id)?;
                self.relation_member(
                    relation_id,
                    RelationAction::Remove,
                    successor_id,
                    belief_id,
                    RelationKind::Supersedes,
                )?;
                let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
                self.push(
                    schema::KIND_BELIEF_LIFECYCLE_CHANGED,
                    &schema::BeliefLifecycleChanged {
                        schema: schema_v,
                        batch_id,
                        idempotency_key: key,
                        actor,
                        occurred_at: None,
                        valid_from: None,
                        valid_to: None,
                        belief_id: belief_id.clone(),
                        from: *from,
                        to: *to,
                        cause: LifecycleCause::Reverted,
                        replacement_id: None,
                    },
                )?;
                self.touches(TargetClass::Belief, belief_id);
            }
            RevertStep::QualificationRestored {
                belief_id,
                from,
                to,
                qualification_profile,
            } => {
                self.belief(belief_id)?;
                let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
                self.push(
                    schema::KIND_BELIEF_QUALIFICATION_CHANGED,
                    &schema::BeliefQualificationChanged {
                        schema: schema_v,
                        batch_id,
                        idempotency_key: key,
                        actor,
                        occurred_at: None,
                        valid_from: None,
                        valid_to: None,
                        belief_id: belief_id.clone(),
                        from: *from,
                        to: *to,
                        qualification_profile: qualification_profile.clone(),
                        cause: QualificationCause::Reverted,
                    },
                )?;
                self.touches(TargetClass::Belief, belief_id);
            }
            RevertStep::RelationRestored {
                relation_id,
                action,
                from,
                to,
                relation,
            } => {
                self.relation_member(relation_id, *action, from, to, *relation)?;
            }
            RevertStep::ContestClosed {
                belief_id,
                open_contest_event_id,
                addressed_by: ContestAddressing::RevertApplication,
            } => {
                self.belief(belief_id)?;
                if self
                    .ctx
                    .state
                    .beliefs
                    .get(belief_id)
                    .and_then(|b| b.open_contest_event.as_deref())
                    != Some(open_contest_event_id.as_str())
                {
                    return Err(refuse(
                        "revert_not_current",
                        format!(
                            "belief {belief_id} no longer has contest {open_contest_event_id} open"
                        ),
                    ));
                }
                let (schema_v, batch_id, key, actor) = common(&self.ctx.actor);
                self.push(
                    schema::KIND_BELIEF_CONTESTED,
                    &schema::BeliefContested {
                        schema: schema_v,
                        batch_id,
                        idempotency_key: key,
                        actor,
                        occurred_at: None,
                        valid_from: None,
                        valid_to: None,
                        belief_id: belief_id.clone(),
                        action: ContestAction::Close,
                        counterevidence_refs: vec![],
                        addressed_by_event_id: Some(applied_ref.to_string()),
                    },
                )?;
                self.touches(TargetClass::Belief, belief_id);
            }
        }
        Ok(())
    }
}

/// Expand one op into its closed plan.
/// The write set alone, for the M26.3d target-binding predicate.
///
/// **It calls `expand`.** It does not re-match on `ProposalOp`, because a
/// second twenty-arm match over the same union is exactly the hand-maintained
/// second inventory this milestone forbids — and the two copies would diverge
/// on the arms that are conditional (`merge_beliefs_exact` revises the
/// survivor only when the basis differs) or state-derived (`revert_proposal`
/// reads its steps out of the stored plan). One function, one answer.
///
/// The cost is expanding twice per commit — once to bind, once to apply.
/// That is real and it is the cheap side of the trade: the alternative is a
/// predicate that is allowed to disagree with what actually gets written.
pub fn write_targets_of(
    op: &ProposalOp,
    ctx: &ExpansionContext,
) -> Result<Vec<(TargetClass, String)>, ExpandError> {
    Ok(expand(op, ctx)?.write_targets)
}

pub fn expand(op: &ProposalOp, ctx: &ExpansionContext) -> Result<Expansion, ExpandError> {
    let mut plan = Plan::new(ctx);
    match op {
        // --- Observations ----------------------------------------------------
        ProposalOp::AppendObservation { observation } => {
            let mut body = (**observation).clone();
            body.batch_id = None;
            body.idempotency_key = None;
            let source_id = body.source_id.clone();
            plan.push(schema::KIND_OBSERVATION_RECORDED, &body)?;
            // As in `cache_source`: the Source advances, the Observation is
            // its own event id and so is not a CAS target.
            plan.touches(TargetClass::Source, &source_id);
            // The recorded Observation's identity IS its event id: a
            // creation with no prior version, deliberately absent from the
            // CAS set.
        }
        ProposalOp::CacheSource {
            source_id,
            artifact_hash,
            raw_pointer,
        } => {
            let source = ctx
                .state
                .sources
                .get(source_id)
                .ok_or_else(|| missing("source", source_id))?;
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_OBSERVATION_RECORDED,
                &schema::ObservationRecorded {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    observation_kind: schema::ObservationKind::SourceSnapshot,
                    source_id: source_id.clone(),
                    // The SERVER pins the registration. A caller-supplied
                    // one could claim provenance it never established.
                    source_registration_event_id: source.registration_event_id.clone(),
                    // A snapshot is about the artifact, not about a subject.
                    subject: schema::SubjectRef::None,
                    lineage: vec![],
                    provenance: schema::Provenance::empty(),
                    payload: serde_json::to_value(schema::SourceSnapshotPayload {
                        source_artifact_hash: Some(artifact_hash.clone()),
                        raw_pointer: raw_pointer.clone(),
                    })
                    .map_err(|e| refuse("schema_invalid", e.to_string()))?,
                },
            )?;
            // The SOURCE advances (reduce.rs bumps it on every recorded
            // observation), and until M26.3d it was the one write this plan
            // did not declare — so a binding rule over the write set would
            // have exempted `cache_source` entirely by matching against an
            // empty set. The Observation is deliberately NOT here: its
            // identity is its own event id, so it is a creation with no
            // prior version to compare against.
            plan.touches(TargetClass::Source, source_id);
        }
        ProposalOp::CorrectObservationSubject {
            observation_event_id,
            prior_resolution_event_id,
            from_entity_id,
            to_entity_id,
            resolver_tier,
            basis_event_ids,
            reason,
        } => {
            let observation = ctx
                .state
                .observations
                .get(observation_event_id)
                .ok_or_else(|| missing("observation", observation_event_id))?;
            // The correction must describe THIS Observation's current
            // attachment. Correcting from a stale reading is how two
            // corrections race and the later one wins by accident.
            match &observation.effective_resolution_event {
                Some(current) if current == prior_resolution_event_id => {}
                Some(current) => {
                    return Err(refuse(
                        "subject_resolution_stale",
                        format!(
                            "observation {observation_event_id} is resolved by {current}, not \
                             {prior_resolution_event_id}"
                        ),
                    ))
                }
                None => {
                    return Err(refuse(
                        "subject_resolution_mismatch",
                        format!("observation {observation_event_id} has no resolution to correct"),
                    ))
                }
            }
            if observation.effective_entity.as_deref() != Some(from_entity_id.as_str()) {
                return Err(refuse(
                    "subject_resolution_mismatch",
                    format!(
                        "observation {observation_event_id} is attached to {:?}, not \
                         {from_entity_id}",
                        observation.effective_entity
                    ),
                ));
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_SUBJECT_RESOLVED,
                &schema::SubjectResolved {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    observation_event_id: observation_event_id.clone(),
                    change: ResolutionChange::Correct {
                        prior_resolution_event_id: prior_resolution_event_id.clone(),
                        from_entity_id: from_entity_id.clone(),
                        to_entity_id: to_entity_id.clone(),
                        resolver_tier: *resolver_tier,
                        basis_event_ids: basis_event_ids.clone(),
                        reason: reason.clone(),
                    },
                },
            )?;
            // Only the Observation advances; both Entities are read.
            plan.touches(TargetClass::Observation, observation_event_id);
        }
        ProposalOp::ConfirmObservationIndependence {
            left_observation_event_id,
            right_observation_event_id,
            basis_event_ids: _,
            reason,
        } => {
            // The human-confirmed proof is SERVER-BOUND. All four of its
            // fields come from committed state and from the decision that
            // actually authorized this — none from the caller. That is what
            // makes the proof mean "a human confirmed THIS pair" rather than
            // "someone typed four ids".
            let left = ctx
                .state
                .observations
                .get(left_observation_event_id)
                .ok_or_else(|| missing("observation", left_observation_event_id))?;
            let right = ctx
                .state
                .observations
                .get(right_observation_event_id)
                .ok_or_else(|| missing("observation", right_observation_event_id))?;
            let Some(decision_event_id) = ctx.decision_event_id.clone() else {
                return Err(refuse(
                    "independence_not_confirmable",
                    "human_confirmed independence requires the approving decision event — a HIGH \
                     op is never auto-applied",
                ));
            };
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_INDEPENDENCE_RECORDED,
                &schema::IndependenceRecorded {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    left_observation_event_id: left_observation_event_id.clone(),
                    right_observation_event_id: right_observation_event_id.clone(),
                    proof: IndependenceProof::HumanConfirmed {
                        left_source_registration_event_id: left
                            .source_registration_event_id
                            .clone(),
                        right_source_registration_event_id: right
                            .source_registration_event_id
                            .clone(),
                        proposal_id: ctx.proposal_id.clone(),
                        decision_event_id,
                    },
                    reason: reason.clone(),
                },
            )?;
            plan.touches(TargetClass::Observation, left_observation_event_id);
            plan.touches(TargetClass::Observation, right_observation_event_id);
        }

        // --- Beliefs ----------------------------------------------------------
        ProposalOp::CreateBelief {
            belief_id,
            subject,
            content,
            fields,
            basis,
            distinctness_reason: _,
        } => {
            if ctx.state.beliefs.contains_key(belief_id) || ctx.staged_belief(belief_id) {
                return Err(refuse(
                    "illegal_transition",
                    format!("belief {belief_id} already exists — creation is not revision"),
                ));
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_BELIEF_CREATED,
                &schema::BeliefCreated {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    belief_id: belief_id.clone(),
                    subject: subject.clone(),
                    content: content.clone(),
                    fields: fields.clone(),
                    basis: basis.clone(),
                },
            )?;
            plan.touches(TargetClass::Belief, belief_id);
        }
        ProposalOp::UpdateBelief {
            belief_id,
            patch,
            basis,
        } => {
            let prior_basis = plan.committed_belief(belief_id)?.current().basis.clone();
            plan.revised_member(belief_id, patch.clone(), basis.clone())?;
            // The inverse of a patch is the same pointers with before and
            // after swapped, plus the basis this revision replaced.
            plan.revert_steps.push(RevertStep::BeliefRevised {
                belief_id: belief_id.clone(),
                patch: patch
                    .iter()
                    .map(|op| schema::PatchOp {
                        field_path: op.field_path.clone(),
                        before: op.after.clone(),
                        after: op.before.clone(),
                    })
                    .collect(),
                basis: prior_basis,
            });
        }
        ProposalOp::SupersedeBelief {
            belief_id,
            successor_id,
        } => {
            plan.supersede_members(belief_id, successor_id)?;
            plan.revert_steps.push(RevertStep::LifecycleRestored {
                belief_id: belief_id.clone(),
                from: Lifecycle::Superseded,
                to: Lifecycle::Active,
                relation_id: schema::derive_relation_id(
                    successor_id,
                    belief_id,
                    RelationKind::Supersedes,
                ),
                successor_id: successor_id.clone(),
            });
        }
        ProposalOp::PromoteDraft {
            belief_id,
            qualification_profile,
        } => {
            if plan.committed_belief(belief_id)?.qualification != Qualification::Draft {
                return Err(refuse(
                    "illegal_transition",
                    format!("belief {belief_id} is already qualified"),
                ));
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_BELIEF_QUALIFICATION_CHANGED,
                &schema::BeliefQualificationChanged {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    belief_id: belief_id.clone(),
                    from: Qualification::Draft,
                    to: Qualification::Qualified,
                    qualification_profile: qualification_profile.clone(),
                    cause: QualificationCause::Promoted,
                },
            )?;
            plan.touches(TargetClass::Belief, belief_id);
            plan.revert_steps.push(RevertStep::QualificationRestored {
                belief_id: belief_id.clone(),
                from: Qualification::Qualified,
                to: Qualification::Draft,
                qualification_profile: qualification_profile.clone(),
            });
        }
        ProposalOp::ContestBelief {
            belief_id,
            counterevidence_refs,
        } => {
            if plan
                .committed_belief(belief_id)?
                .open_contest_event
                .is_some()
            {
                return Err(refuse(
                    "illegal_transition",
                    format!("belief {belief_id} already has an open contest"),
                ));
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            let ordinal = plan.push(
                schema::KIND_BELIEF_CONTESTED,
                &schema::BeliefContested {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    belief_id: belief_id.clone(),
                    action: ContestAction::Open,
                    counterevidence_refs: counterevidence_refs.clone(),
                    addressed_by_event_id: None,
                },
            )?;
            plan.touches(TargetClass::Belief, belief_id);
            // The contest this inverse would close is the one THIS batch is
            // about to write: symbolic now, physical after preallocation.
            plan.revert_steps.push(RevertStep::ContestClosed {
                belief_id: belief_id.clone(),
                open_contest_event_id: member_ref(ordinal),
                addressed_by: ContestAddressing::RevertApplication,
            });
        }
        ProposalOp::TombstoneBelief {
            belief_id,
            replacement_id,
            reason_code,
        } => {
            plan.belief(belief_id)?;
            if let Some(replacement) = replacement_id {
                plan.belief(replacement)?;
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_BELIEF_TOMBSTONED,
                &schema::BeliefTombstoned {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    belief_id: belief_id.clone(),
                    replacement_id: replacement_id.clone(),
                    reason_code: *reason_code,
                },
            )?;
            plan.touches(TargetClass::Belief, belief_id);
        }
        ProposalOp::ArchiveBelief { belief_id, .. } => {
            plan.retire(belief_id, LifecycleCause::Archived, None)?;
        }
        ProposalOp::Deprecate {
            belief_id,
            replacement_id,
        } => {
            plan.retire(
                belief_id,
                LifecycleCause::Deprecated,
                replacement_id.clone(),
            )?;
        }

        // --- Relations and aliases ---------------------------------------------
        ProposalOp::EditRelation {
            relation_id,
            action,
            from,
            to,
            relation,
        } => {
            plan.belief(from)?;
            plan.belief(to)?;
            let live = ctx.state.relations.get(relation_id).is_some_and(|r| r.live);
            match (action, live) {
                (RelationAction::Add, true) => {
                    return Err(refuse(
                        "illegal_transition",
                        format!("relation {relation_id} is already live"),
                    ))
                }
                (RelationAction::Remove, false) => {
                    return Err(refuse(
                        "illegal_transition",
                        format!("relation {relation_id} is not live — there is nothing to remove"),
                    ))
                }
                _ => {}
            }
            let relation_ordinal =
                plan.relation_member(relation_id, *action, from, to, *relation)?;
            // A declared contradiction is classified in the batch that
            // declares it, or it is not declared (M27.4c). The alternative —
            // commit the relation now, classify later — is a window in which
            // the preservation gate sees an unclassified declaration it can
            // only refuse to compress over, which is the debt this whole
            // phase exists to stop accruing.
            if *action == RelationAction::Add && *relation == RelationKind::Contradicts {
                plan.declare_contradiction(relation_id, relation_ordinal, from, to)?;
            }
            plan.revert_steps.push(RevertStep::RelationRestored {
                relation_id: relation_id.clone(),
                action: match action {
                    RelationAction::Add => RelationAction::Remove,
                    RelationAction::Remove => RelationAction::Add,
                },
                from: from.clone(),
                to: to.clone(),
                relation: *relation,
            });
        }
        ProposalOp::AddEntityAlias { entity_id, alias } => {
            if !ctx.state.entities.contains_key(entity_id)
                && !ctx.staged_entities.contains(entity_id)
            {
                return Err(missing("entity", entity_id));
            }
            let normalized = schema::normalize_alias_v1(alias);
            // A normalized key already held by a DIFFERENT entity is the
            // collision the reducer would refuse. Naming it here gives the
            // card a code instead of an anomaly row.
            if let Some(existing) = ctx.state.alias_registry.get(&normalized) {
                if &existing.entity_id != entity_id {
                    return Err(refuse(
                        "alias_collision",
                        format!(
                            "normalized alias {normalized:?} already belongs to entity {}",
                            existing.entity_id
                        ),
                    ));
                }
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            plan.push(
                schema::KIND_ENTITY_ALIAS_ADDED,
                &schema::EntityAliasAdded {
                    schema: schema_v,
                    batch_id,
                    idempotency_key: key,
                    actor,
                    occurred_at: None,
                    valid_from: None,
                    valid_to: None,
                    entity_id: entity_id.clone(),
                    alias: alias.clone(),
                    normalized_alias: normalized,
                },
            )?;
            plan.touches(TargetClass::Entity, entity_id);
        }

        // --- Complex plans ------------------------------------------------------
        ProposalOp::MergeBeliefsExact {
            survivor_id,
            merged_ids,
            equivalence_receipt,
        } => {
            let survivor = plan.committed_belief(survivor_id)?;
            if survivor.lifecycle != Lifecycle::Active {
                return Err(refuse(
                    "illegal_transition",
                    format!("merge survivor {survivor_id} is not active"),
                ));
            }
            // 1. An empty-patch revision, exactly when the receipt's merged
            //    basis genuinely differs — the canonical support-only shape.
            let current_basis = survivor.current().basis.clone();
            if current_basis != equivalence_receipt.merged_basis {
                plan.revised_member(
                    survivor_id,
                    vec![],
                    equivalence_receipt.merged_basis.clone(),
                )?;
            }
            // 2. Relation rewrites in prior-id order: remove the prior live
            //    relation, then add a replacement only where one is named.
            for rewrite in &equivalence_receipt.relation_rewrites {
                let prior = ctx
                    .state
                    .relations
                    .get(&rewrite.prior_relation_id)
                    .ok_or_else(|| missing("relation", &rewrite.prior_relation_id))?;
                if !prior.live {
                    return Err(refuse(
                        "illegal_transition",
                        format!("relation {} is not live", rewrite.prior_relation_id),
                    ));
                }
                plan.relation_member(
                    &rewrite.prior_relation_id,
                    RelationAction::Remove,
                    &rewrite.prior_from,
                    &rewrite.prior_to,
                    rewrite.relation,
                )?;
                if rewrite.disposition == RewriteDisposition::AddReplacement {
                    let replacement = rewrite
                        .replacement
                        .as_ref()
                        .expect("validate() proved add_replacement carries one");
                    plan.relation_member(
                        &replacement.relation_id,
                        RelationAction::Add,
                        &replacement.from,
                        &replacement.to,
                        replacement.relation,
                    )?;
                }
            }
            // 3. Each merged id supersedes into the survivor, in order.
            for merged in merged_ids {
                plan.supersede_members(merged, survivor_id)?;
            }
        }
        ProposalOp::SplitBelief {
            belief_id,
            primary_output_id,
            outputs,
            evidence_assignment,
        } => {
            plan.belief(belief_id)?;
            // Outputs in belief-id order; each basis DERIVED from the
            // assignment and never declared, so an output cannot claim
            // support the split did not give it.
            let mut sorted: Vec<&schema::SplitOutput> = outputs.iter().collect();
            sorted.sort_by(|a, b| a.belief_id.cmp(&b.belief_id));
            for output in &sorted {
                let mut links: Vec<BasisLink> = evidence_assignment
                    .iter()
                    .filter(|a| a.output_belief_id == output.belief_id)
                    .map(|a| BasisLink {
                        observation_event_id: a.observation_event_id.clone(),
                        role: a.role,
                    })
                    .collect();
                links.sort_by(|a, b| a.observation_event_id.cmp(&b.observation_event_id));
                let basis = if links.is_empty() {
                    BeliefBasis::Unsupported {
                        reason: SPLIT_UNASSIGNED_REASON.to_string(),
                    }
                } else {
                    BeliefBasis::Linked { links }
                };
                let (schema_v, batch_id, key, actor) = common(&ctx.actor);
                plan.push(
                    schema::KIND_BELIEF_CREATED,
                    &schema::BeliefCreated {
                        schema: schema_v,
                        batch_id,
                        idempotency_key: key,
                        actor,
                        occurred_at: None,
                        valid_from: None,
                        valid_to: None,
                        belief_id: output.belief_id.clone(),
                        subject: output.subject.clone(),
                        content: output.content.clone(),
                        fields: output.fields.clone(),
                        basis,
                    },
                )?;
                plan.touches(TargetClass::Belief, &output.belief_id);
                plan.created.insert(output.belief_id.clone());
            }
            // One `refines` per output, from the output to the predecessor.
            for output in &sorted {
                let relation_id =
                    schema::derive_relation_id(&output.belief_id, belief_id, RelationKind::Refines);
                plan.relation_member(
                    &relation_id,
                    RelationAction::Add,
                    &output.belief_id,
                    belief_id,
                    RelationKind::Refines,
                )?;
            }
            // Last, the predecessor retires into the primary output.
            plan.supersede_members(belief_id, primary_output_id)?;
        }
        ProposalOp::MassSupersede { replacements } => {
            let mut pairs: Vec<&schema::SupersedePair> = replacements.iter().collect();
            pairs.sort_by(|a, b| {
                (a.belief_id.as_str(), a.successor_id.as_str())
                    .cmp(&(b.belief_id.as_str(), b.successor_id.as_str()))
            });
            for pair in pairs {
                plan.supersede_members(&pair.belief_id, &pair.successor_id)?;
            }
        }
        ProposalOp::MergeEntities {
            survivor_id,
            merged_ids,
            reassignment_plan,
        } => {
            if !ctx.state.entities.contains_key(survivor_id) {
                return Err(missing("entity", survivor_id));
            }
            for merged in merged_ids {
                if !ctx.state.entities.contains_key(merged) {
                    return Err(missing("entity", merged));
                }
            }
            let (schema_v, batch_id, key, actor) = common(&ctx.actor);
            let merged_event = schema::EntityMerged {
                schema: schema_v,
                batch_id,
                idempotency_key: key,
                actor,
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                survivor_id: survivor_id.clone(),
                merged_ids: merged_ids.clone(),
                reassignment_plan: (**reassignment_plan).clone(),
                reassignment_digest: reassignment_plan
                    .digest_of()
                    .map_err(|e| refuse("schema_invalid", e))?,
            };
            // The event performs every enumerated effect itself, so its own
            // write-target set is the CAS set — no hidden side event exists.
            let targets: Vec<(TargetClass, String)> = merged_event
                .write_targets()
                .into_iter()
                .map(|(class, id)| (class_of(class), id.to_string()))
                .collect();
            plan.push(schema::KIND_ENTITY_MERGED, &merged_event)?;
            for (class, id) in targets {
                plan.touches(class, &id);
            }
        }

        // --- Reverting -----------------------------------------------------------
        ProposalOp::RevertProposal {
            applied_proposal_id,
            applied_event_ids,
        } => {
            let row = ctx
                .state
                .proposals
                .get(applied_proposal_id)
                .ok_or_else(|| missing("proposal", applied_proposal_id))?;
            if row.state != schema::ProposalState::Applied {
                return Err(refuse(
                    "revert_not_current",
                    format!(
                        "proposal {applied_proposal_id} is {:?}, not applied",
                        row.state
                    ),
                ));
            }
            let Some(revert_plan) = row.revert_plan.clone() else {
                return Err(refuse(
                    "revert_not_supported",
                    format!("proposal {applied_proposal_id} stored no revert plan"),
                ));
            };
            if row.applied_event_id.as_ref().map(std::slice::from_ref)
                != Some(applied_event_ids.as_slice())
            {
                return Err(refuse(
                    "revert_not_current",
                    format!(
                        "proposal {applied_proposal_id} was applied by {:?}, not \
                         {applied_event_ids:?}",
                        row.applied_event_id
                    ),
                ));
            }
            // The reverting application's own `proposal.applied` follows
            // every forward member, so its ordinal is knowable before the
            // steps run — and the check below proves the arithmetic.
            let forward_len: usize = revert_plan.steps.iter().map(step_member_count).sum();
            let applied_ref = member_ref(ctx.base_ordinal + forward_len);
            for step in &revert_plan.steps {
                plan.revert_step(step, &applied_ref)?;
            }
            if plan.members.len() != forward_len {
                return Err(refuse(
                    "schema_invalid",
                    format!(
                        "revert plan emitted {} members where {forward_len} were reserved — a \
                         symbolic reference would point at the wrong event",
                        plan.members.len()
                    ),
                ));
            }
            // The original proposal advances through `proposal.reverted`,
            // which the commit protocol appends after the application.
            plan.touches(TargetClass::Proposal, applied_proposal_id);
        }

        // --- Not yet expressible --------------------------------------------------
        ProposalOp::ClassifyConflict { .. } => {
            // M27 owns `conflict.classified` and `contradiction.opened`. The
            // table gates this op behind an unavailable capability, so a
            // proposal is refused before it reaches here; this arm exists so
            // the match stays exhaustive and no later edit can reach a
            // silent fallthrough.
            return Err(refuse(
                "capability_unavailable",
                "classify_conflict expands to M27's classification events, which do not exist yet",
            ));
        }
    }
    plan.close_addressed_contradictions(ctx)?;
    Ok(plan.finish())
}

/// The basis a split output gets when the assignment gave it no evidence.
/// Saying so explicitly beats an empty link list, which reads as weak
/// support rather than as none.
pub const SPLIT_UNASSIGNED_REASON: &str = "split output with no assigned evidence";

fn class_of(name: &str) -> TargetClass {
    match name {
        "belief" => TargetClass::Belief,
        "entity" => TargetClass::Entity,
        "observation" => TargetClass::Observation,
        "proposal" => TargetClass::Proposal,
        "relation" => TargetClass::Relation,
        "source" => TargetClass::Source,
        other => unreachable!("{other} is not a version class the reducer maintains"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{BeliefState, RelationState, RevisionState};
    use crate::ledger::schema::{
        BasisRole, EvidenceAssignment, ProposalOp, SplitOutput, SubjectRef, SupersedePair,
    };

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    const C: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
    const D: &str = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
    const E: &str = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";
    /// The proposal's durable submission stamp — the only clock an expansion
    /// sees, and a fixed one, because a plan that moved with the wall clock
    /// would stop replaying under its own operation key.
    const SUBMITTED_AT: &str = "2026-08-12T09:00:00.000Z";

    fn belief(id: &str) -> BeliefState {
        BeliefState {
            belief_id: id.into(),
            entity_id: E.into(),
            created_event_id: E.into(),
            revisions: vec![RevisionState {
                event_id: E.into(),
                revision: 1,
                content: String::new(),
                fields: serde_json::json!({}),
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            }],
            attested: None,
            attestation_events: vec![],
            path: None,
            overrides: vec![],
            override_head_event: None,
            projection_head_event: E.into(),
            qualification: Qualification::Draft,
            lifecycle: Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        }
    }

    fn world(ids: &[&str]) -> EpistemicState {
        let mut state = EpistemicState::default();
        for id in ids {
            state.beliefs.insert((*id).to_string(), belief(id));
        }
        state
    }

    fn ctx(state: &EpistemicState) -> ExpansionContext<'_> {
        ExpansionContext {
            actor: Actor {
                id: "agent:test".into(),
            },
            state,
            base_ordinal: 0,
            decision_event_id: None,
            proposal_id: A.into(),
            staged_beliefs: Default::default(),
            staged_entities: Default::default(),
            addressed_contradictions: Vec::new(),
            member_ids: None,
            submitted_at: SUBMITTED_AT.into(),
        }
    }

    fn kinds(expansion: &Expansion) -> Vec<&str> {
        expansion
            .members
            .iter()
            .map(|(kind, _)| kind.as_str())
            .collect()
    }

    fn contradicts_add() -> ProposalOp {
        ProposalOp::EditRelation {
            relation_id: schema::derive_relation_id(B, C, RelationKind::Contradicts),
            action: RelationAction::Add,
            from: B.into(),
            to: C.into(),
            relation: RelationKind::Contradicts,
        }
    }

    #[test]
    fn a_declared_contradiction_is_classified_in_the_batch_that_declares_it() {
        // The whole point of M27.4c: there is no window in which a
        // `contradicts` relation is durable and unclassified, because the
        // preservation gate can only refuse to compress over one of those.
        let state = world(&[B, C]);
        let expansion = expand(&contradicts_add(), &ctx(&state)).unwrap();
        assert_eq!(
            kinds(&expansion),
            [
                "belief.relation",
                "conflict.comparison_registered",
                "conflict.classified",
                "contradiction.opened",
            ]
        );
        // Neither fixture belief has evidence, so nothing can separate the
        // pair — `partial`, naming what was absent, with an edge. A verdict
        // that resolved silence into "no conflict" would be the failure this
        // milestone is built to prevent.
        let classified: schema::ConflictClassified =
            serde_json::from_value(expansion.members[2].1.clone()).unwrap();
        assert_eq!(classified.outcome, schema::ConflictOutcome::Partial);
        assert_eq!(
            classified.reason_codes,
            [schema::ConflictReasonCode::RelationMissingAssertion]
        );
        // The Comparison is a target this plan advances, and a server-derived
        // one: it follows from an event the batch has not written yet, so no
        // caller could have named it in `targets`.
        assert!(expansion
            .write_targets
            .contains(&(TargetClass::Comparison, classified.comparison_id.clone())));

        // A relation the gauntlet has nothing to say about is one event, as
        // it always was.
        let refines = expand(
            &ProposalOp::EditRelation {
                relation_id: schema::derive_relation_id(B, C, RelationKind::Refines),
                action: RelationAction::Add,
                from: B.into(),
                to: C.into(),
                relation: RelationKind::Refines,
            },
            &ctx(&state),
        )
        .unwrap();
        assert_eq!(kinds(&refines), ["belief.relation"]);
    }

    #[test]
    fn the_comparison_id_follows_from_the_relation_event_this_batch_will_write() {
        // The reason `member_id` exists. A comparison id is
        // `sha256(relation_event_id ‖ endpoints)`, and substitution cannot
        // re-hash what was computed from a placeholder — so an expansion that
        // reached for `member_ref` here would mint an id derived from the
        // string "cerebro-batch-member:0" and commit it.
        let state = world(&[B, C]);
        let physical = [
            "1".repeat(32),
            "2".repeat(32),
            "3".repeat(32),
            "4".repeat(32),
        ];
        let mut context = ctx(&state);
        context.member_ids = Some(&physical);
        let expansion = expand(&contradicts_add(), &context).unwrap();

        let registration: schema::ConflictComparisonRegistered =
            serde_json::from_value(expansion.members[1].1.clone()).unwrap();
        assert_eq!(registration.source_relation_event_id, physical[0]);
        assert_eq!(registration.left.relation_event_id, physical[0]);
        assert_eq!(registration.right.relation_event_id, physical[0]);
        assert_eq!(
            registration.comparison_id,
            schema::derive_declared_comparison_id(
                &physical[0],
                &registration.left,
                &registration.right
            )
            .unwrap()
        );
        // Which is exactly what the schema insists on, so the physical pass
        // validates where a symbolic one could not.
        registration.validate().unwrap();

        // The edge names the classification by ORDINAL, because that one is a
        // plain reference the writer substitutes.
        let opened: schema::ContradictionOpened =
            serde_json::from_value(expansion.members[3].1.clone()).unwrap();
        assert_eq!(opened.classified_event_id, member_ref(2));
        assert_eq!(opened.comparison_id, registration.comparison_id);
        assert_eq!(
            opened.edge_id,
            schema::derive_edge_id(&registration.comparison_id, schema::EdgeKind::Partial)
        );

        // And the symbolic pass — the one the operation digest hashes — is the
        // SAME plan with the placeholder in place of the id.
        let symbolic: schema::ConflictComparisonRegistered = serde_json::from_value(
            expand(&contradicts_add(), &ctx(&state)).unwrap().members[1]
                .1
                .clone(),
        )
        .unwrap();
        assert_eq!(symbolic.source_relation_event_id, member_ref(0));
        assert_ne!(symbolic.comparison_id, registration.comparison_id);
    }

    #[test]
    fn a_declaration_riding_behind_other_members_still_names_its_own_relation() {
        // `base_ordinal` is where this op's first member lands in a multi-op
        // commit set. Getting it wrong would derive the comparison from a
        // sibling proposal's event — a plausible off-by-one that every
        // single-op test would miss.
        let state = world(&[B, C]);
        let physical: Vec<String> = (0..8).map(|i| format!("{i}").repeat(32)).collect();
        let mut context = ctx(&state);
        context.base_ordinal = 3;
        context.member_ids = Some(&physical);
        let expansion = expand(&contradicts_add(), &context).unwrap();
        let registration: schema::ConflictComparisonRegistered =
            serde_json::from_value(expansion.members[1].1.clone()).unwrap();
        assert_eq!(registration.source_relation_event_id, physical[3]);
        let opened: schema::ContradictionOpened =
            serde_json::from_value(expansion.members[3].1.clone()).unwrap();
        assert_eq!(opened.classified_event_id, member_ref(5));
    }

    #[test]
    fn a_supersede_names_the_successor_as_from_and_the_predecessor_as_to() {
        // THE REPLACEMENT CONVENTION, in one assertion. Every complex plan
        // routes through `supersede_members`, so getting this backwards once
        // would invert merge, split, and mass-supersede at the same time.
        let state = world(&[B, C]);
        let expansion = expand(
            &ProposalOp::SupersedeBelief {
                belief_id: B.into(),
                successor_id: C.into(),
            },
            &ctx(&state),
        )
        .unwrap();
        assert_eq!(
            kinds(&expansion),
            ["belief.relation", "belief.lifecycle_changed"]
        );
        let (_, relation) = &expansion.members[0];
        assert_eq!(relation["from"], C, "the replacement is `from`");
        assert_eq!(relation["to"], B, "the replaced predecessor is `to`");
        assert_eq!(relation["relation"], "supersedes");
        let (_, lifecycle) = &expansion.members[1];
        assert_eq!(lifecycle["belief_id"], B);
        assert_eq!(lifecycle["replacement_id"], C);
        assert_eq!(lifecycle["to"], "superseded");
        // Both the predecessor and the generated relation advance.
        assert_eq!(
            expansion.write_targets,
            vec![
                (
                    TargetClass::Relation,
                    schema::derive_relation_id(C, B, RelationKind::Supersedes)
                ),
                (TargetClass::Belief, B.to_string()),
            ]
        );
    }

    #[test]
    fn nothing_follows_a_tombstone() {
        let mut state = world(&[B, C]);
        state.beliefs.get_mut(B).unwrap().tombstoned_by = Some(E.into());
        let err = expand(
            &ProposalOp::SupersedeBelief {
                belief_id: B.into(),
                successor_id: C.into(),
            },
            &ctx(&state),
        )
        .unwrap_err();
        assert_eq!(err.code, "illegal_transition");
        assert!(err.detail.contains("tombstoned"));
    }

    #[test]
    fn a_belief_already_superseded_cannot_be_superseded_again() {
        let mut state = world(&[B, C]);
        state.beliefs.get_mut(B).unwrap().lifecycle = Lifecycle::Superseded;
        let err = expand(
            &ProposalOp::SupersedeBelief {
                belief_id: B.into(),
                successor_id: C.into(),
            },
            &ctx(&state),
        )
        .unwrap_err();
        assert_eq!(err.code, "illegal_transition");
    }

    #[test]
    fn a_relation_that_is_already_live_is_not_added_twice() {
        let mut state = world(&[B, C]);
        let relation_id = schema::derive_relation_id(B, C, RelationKind::Refines);
        state.relations.insert(
            relation_id.clone(),
            RelationState {
                relation_id: relation_id.clone(),
                from: B.into(),
                to: C.into(),
                relation: RelationKind::Refines,
                live: true,
                last_add_event_id: E.into(),
                last_event_id: E.into(),
            },
        );
        let err = expand(
            &ProposalOp::EditRelation {
                relation_id,
                action: RelationAction::Add,
                from: B.into(),
                to: C.into(),
                relation: RelationKind::Refines,
            },
            &ctx(&state),
        )
        .unwrap_err();
        assert_eq!(err.code, "illegal_transition");
    }

    #[test]
    fn a_split_derives_each_basis_from_the_assignment_and_never_from_a_claim() {
        // Evidence assigned to one output is support for THAT output only;
        // an output with none says so explicitly rather than carrying an
        // empty link list that reads as weak support.
        let state = world(&[B]);
        let outputs = vec![
            SplitOutput {
                belief_id: D.into(),
                subject: SubjectRef::Resolved {
                    entity_id: E.into(),
                    aliases: vec![],
                },
                content: "d".into(),
                fields: serde_json::json!({}),
            },
            SplitOutput {
                belief_id: C.into(),
                subject: SubjectRef::Resolved {
                    entity_id: E.into(),
                    aliases: vec![],
                },
                content: "c".into(),
                fields: serde_json::json!({}),
            },
        ];
        let expansion = expand(
            &ProposalOp::SplitBelief {
                belief_id: B.into(),
                primary_output_id: C.into(),
                outputs,
                evidence_assignment: vec![EvidenceAssignment {
                    observation_event_id: A.into(),
                    role: BasisRole::Supports,
                    output_belief_id: C.into(),
                }],
            },
            &ctx(&state),
        )
        .unwrap();
        // Outputs first in BELIEF-ID order (not the order given), then one
        // refines each, then the predecessor's supersede pair.
        assert_eq!(
            kinds(&expansion),
            [
                "belief.created",
                "belief.created",
                "belief.relation",
                "belief.relation",
                "belief.relation",
                "belief.lifecycle_changed",
            ]
        );
        assert_eq!(expansion.members[0].1["belief_id"], C, "c sorts before d");
        assert_eq!(expansion.members[0].1["basis"]["state"], "linked");
        assert_eq!(
            expansion.members[0].1["basis"]["links"][0]["observation_event_id"],
            A
        );
        assert_eq!(expansion.members[1].1["belief_id"], D);
        assert_eq!(expansion.members[1].1["basis"]["state"], "unsupported");
        assert_eq!(
            expansion.members[1].1["basis"]["reason"],
            SPLIT_UNASSIGNED_REASON
        );
        // The predecessor retires into the PRIMARY output.
        let (_, lifecycle) = expansion.members.last().unwrap();
        assert_eq!(lifecycle["belief_id"], B);
        assert_eq!(lifecycle["replacement_id"], C);
    }

    #[test]
    fn mass_supersede_is_ordered_by_pair_and_never_interleaves() {
        // The digest hashes the ordered plan, so an expansion whose order
        // depended on input order would hash differently per caller and
        // idempotent retry would quietly stop working.
        let state = world(&[B, C, D]);
        let plan = |pairs: Vec<(&str, &str)>| ProposalOp::MassSupersede {
            replacements: pairs
                .into_iter()
                .map(|(from, to)| SupersedePair {
                    belief_id: from.into(),
                    successor_id: to.into(),
                })
                .collect(),
        };
        let forwards = expand(&plan(vec![(B, D), (C, D)]), &ctx(&state)).unwrap();
        let backwards = expand(&plan(vec![(C, D), (B, D)]), &ctx(&state)).unwrap();
        assert_eq!(forwards, backwards, "input order does not reach the plan");
        // Each pair's two members are adjacent — never interleaved.
        assert_eq!(forwards.members[0].1["to"], B);
        assert_eq!(forwards.members[1].1["belief_id"], B);
        assert_eq!(forwards.members[2].1["to"], C);
        assert_eq!(forwards.members[3].1["belief_id"], C);
    }

    #[test]
    fn an_exact_merge_revises_the_survivor_only_when_the_basis_actually_changed() {
        let state = world(&[B, C]);
        let receipt = |basis: BeliefBasis| schema::EquivalenceReceipt {
            receipt_id: A.into(),
            index_head: E.into(),
            belief_ids: {
                let mut ids = vec![B.to_string(), C.to_string()];
                ids.sort();
                ids
            },
            subject_id: E.into(),
            scope_digest: "1".repeat(64),
            valid_interval: None,
            normalized_content_hash: "2".repeat(64),
            attestation_conflict: false,
            merged_basis: basis,
            relation_rewrites: vec![],
        };
        let merge = |basis: BeliefBasis| ProposalOp::MergeBeliefsExact {
            survivor_id: B.into(),
            merged_ids: vec![C.to_string()],
            equivalence_receipt: Box::new(receipt(basis)),
        };
        // Identical basis: no empty-patch revision, just the supersede pair.
        let unchanged = expand(
            &merge(BeliefBasis::Unsupported {
                reason: "fixture".into(),
            }),
            &ctx(&state),
        )
        .unwrap();
        assert_eq!(
            kinds(&unchanged),
            ["belief.relation", "belief.lifecycle_changed"]
        );
        // A different merged basis IS the support-only revision shape.
        let changed = expand(
            &merge(BeliefBasis::Unsupported {
                reason: "merged".into(),
            }),
            &ctx(&state),
        )
        .unwrap();
        assert_eq!(
            kinds(&changed),
            [
                "belief.revised",
                "belief.relation",
                "belief.lifecycle_changed"
            ]
        );
        assert_eq!(
            changed.members[0].1["patch"],
            serde_json::json!([]),
            "an empty patch with a changed basis"
        );
    }

    #[test]
    fn a_same_set_creation_is_reachable_by_a_later_member() {
        // "Create a Belief, then link it" is the most ordinary thing an
        // agent proposes; refusing it against a snapshot taken before the
        // set ran would make atomic sets useless for their main case.
        let state = world(&[C]);
        let mut context = ctx(&state);
        context.staged_beliefs.insert(B.to_string());
        let expansion = expand(
            &ProposalOp::EditRelation {
                relation_id: schema::derive_relation_id(B, C, RelationKind::Refines),
                action: RelationAction::Add,
                from: B.into(),
                to: C.into(),
                relation: RelationKind::Refines,
            },
            &context,
        )
        .unwrap();
        assert_eq!(kinds(&expansion), ["belief.relation"]);
        // But an op that must READ prior state cannot work from one.
        let err = expand(
            &ProposalOp::UpdateBelief {
                belief_id: B.into(),
                patch: vec![],
                basis: BeliefBasis::Unsupported { reason: "x".into() },
            },
            &context,
        )
        .unwrap_err();
        assert_eq!(err.code, "illegal_transition");
        assert!(err.detail.contains("no prior state"), "{}", err.detail);
    }

    #[test]
    fn human_confirmed_independence_needs_the_decision_that_authorized_it() {
        // The proof is SERVER-BOUND. Without an approving decision there is
        // no human to name, and a HIGH op is never auto-applied — so the
        // absence is a refusal, not a null field.
        let state = EpistemicState::default();
        let op = ProposalOp::ConfirmObservationIndependence {
            left_observation_event_id: B.into(),
            right_observation_event_id: C.into(),
            basis_event_ids: vec![A.into()],
            reason: "distinct reporters".into(),
        };
        // The Observations must exist first; missing ones refuse earlier.
        let err = expand(&op, &ctx(&state)).unwrap_err();
        assert_eq!(err.code, "invalid_reference");
    }

    #[test]
    fn classify_conflict_is_the_only_op_expansion_cannot_spell() {
        // The table gates it behind an unavailable capability, so policy
        // refuses first; this arm exists so no later edit reaches a silent
        // fallthrough.
        let state = world(&[B]);
        let err = expand(
            &ProposalOp::ClassifyConflict {
                comparison_id: B.into(),
                outcome: schema::ConflictOutcome::GenuineDirect,
                basis_refs: vec![A.into()],
            },
            &ctx(&state),
        )
        .unwrap_err();
        assert_eq!(err.code, "capability_unavailable");

        let table = crate::policy::table::PolicyTable::load().unwrap();
        let gated: Vec<&str> = table
            .ops
            .iter()
            .filter(|(name, _)| table.blocking_capability(name).is_some())
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            gated,
            ["classify_conflict"],
            "an op became capability-gated without an expansion arm to match"
        );
    }

    #[test]
    fn every_expansion_refusal_names_a_code_the_table_declares() {
        // A refusal with a word the table does not know could never be
        // recorded, logged, or explained to anyone.
        let table = crate::policy::table::PolicyTable::load().unwrap();
        let source = include_str!("expand.rs");
        for line in source.lines() {
            let Some(rest) = line.trim().strip_prefix("refuse(\"") else {
                continue;
            };
            let Some(code) = rest.split('"').next() else {
                continue;
            };
            assert!(
                table.destiny(code).is_some(),
                "expand.rs refuses with {code:?}, which policy.v1.json does not declare"
            );
        }
    }
}
