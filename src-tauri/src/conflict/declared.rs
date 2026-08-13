//! What a DECLARED contradiction is, and what one becomes (M27.3d, M27.4c).
//!
//! **A declared relation is a claim with no evidence behind it.** Somebody
//! wrote "these two contradict" — a migration inherited it from an older
//! vault, a person typed it before the pipeline existed, or an agent proposes
//! one now — and there is no assertion anywhere that says so. That is why
//! this cannot reuse the ordinary endpoint: fabricating an assertion to make
//! the shape fit would put a claim in the ledger that nobody made. Each side
//! becomes a `declared_relation` endpoint pinning the relation event, the
//! belief revision current AT that event, and whatever qualifiers the
//! revision's own evidence happens to carry — explicitly `known` or
//! `unknown`, never defaulted.
//!
//! **Missing qualifiers never resolve a pair apart.** If a revision has no
//! assertions at all, or its assertions disagree about scope, the honest
//! answer is not "no conflict" — it is `partial`, with `relation_missing_*`
//! codes naming exactly what was absent, and an open edge. Silence about why
//! two things might not conflict is not a reason they do not.
//!
//! **What the qualifiers DO support runs the same gauntlet.** A declared
//! contradiction between a `planned` claim and a `shipping` one is stage lag
//! wearing a declaration, and the M27.4 gate must not fire on it.
//!
//! This module is the RULE. [`super::backfill`] applies it to declarations
//! the store already held; the `edit_relation` expansion applies it to one
//! being authored right now, in the same batch as its own relation event.
//! The two differ in where the declaration comes from and in nothing else —
//! a second copy of the gauntlet for new declarations would be a second set
//! of verdicts to keep in step.

use crate::ledger::reduce::{BeliefState, EpistemicState, RevisionState};
use crate::ledger::schema::{
    self, derive_declared_comparison_id, ordered_declared_endpoints, Actor, BasisRole, BeliefBasis,
    Classification, ConflictClassified, ConflictComparisonRegistered, ConflictEndpoint,
    ConflictOutcome, ConflictReasonCode, DeclaredRelationEndpoint, EdgeKind, KnownScope,
    KnownStage, KnownValidTime, RelationOrigin, Scope, ValidInterval, BODY_SCHEMA,
    KIND_CONFLICT_CLASSIFIED, KIND_CONFLICT_COMPARISON_REGISTERED, KIND_CONTRADICTION_OPENED,
};

use super::detect::{qualifiers_overlap, stages_overlap, valid_times_overlap};

/// One declared `contradicts` relation and the revisions its endpoints sat on
/// when it was written.
#[derive(Debug, Clone, PartialEq)]
pub struct Declaration {
    pub relation_event_id: String,
    pub relation_id: String,
    pub origin: RelationOrigin,
    /// `(belief_id, revision_event_id)`.
    pub from: (String, String),
    pub to: (String, String),
}

/// What one declaration is, and what still has to be written for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub comparison_id: String,
    pub outcome: ConflictOutcome,
    /// Registration, classification, and — for an unresolved verdict — the
    /// open edge, in that order. EMPTY when the store already classified this
    /// comparison: the outcome above is then what it decided, not a re-decision.
    pub members: Vec<(String, serde_json::Value)>,
}

/// What one endpoint's evidence could say about its qualifiers, and what it
/// could not.
struct Qualifiers {
    scope: KnownScope,
    state_stage: KnownStage,
    valid_time: KnownValidTime,
    missing: Vec<ConflictReasonCode>,
}

/// Read the pinned revision's own supporting evidence for qualifiers.
///
/// A revision with no assertions has nothing to say — `relation_missing_
/// assertion`, and every qualifier unknown. Assertions that DISAGREE about a
/// qualifier are the same answer for a different reason: two scopes are not
/// one scope, and picking one would be inventing the endpoint's scope rather
/// than reading it.
fn qualifiers_of(state: &EpistemicState, revision: &RevisionState) -> Qualifiers {
    let BeliefBasis::Linked { links } = &revision.basis else {
        return Qualifiers {
            scope: KnownScope::Unknown,
            state_stage: KnownStage::Unknown,
            valid_time: KnownValidTime::Unknown,
            missing: vec![ConflictReasonCode::RelationMissingAssertion],
        };
    };
    let facets: Vec<_> = links
        .iter()
        .filter(|link| matches!(link.role, BasisRole::Supports | BasisRole::Opposes))
        .filter_map(|link| state.assertion_facets.get(&link.observation_event_id))
        .collect();
    if facets.is_empty() {
        return Qualifiers {
            scope: KnownScope::Unknown,
            state_stage: KnownStage::Unknown,
            valid_time: KnownValidTime::Unknown,
            missing: vec![ConflictReasonCode::RelationMissingAssertion],
        };
    }

    let mut missing = Vec::new();
    let scopes: Vec<&Scope> = facets.iter().map(|f| &f.scope).collect();
    let one_scope = scopes.windows(2).all(|pair| pair[0] == pair[1]);
    let scope = if one_scope {
        KnownScope::Known {
            value: scopes[0].clone(),
        }
    } else {
        missing.push(ConflictReasonCode::RelationMissingScope);
        KnownScope::Unknown
    };
    let state_stage = match (&scope, scopes[0].stage) {
        (KnownScope::Known { .. }, Some(stage)) => KnownStage::Known { value: stage },
        _ => {
            missing.push(ConflictReasonCode::RelationMissingStage);
            KnownStage::Unknown
        }
    };
    let times: Vec<&ValidInterval> = facets.iter().map(|f| &f.valid_time).collect();
    let valid_time = if times.windows(2).all(|pair| pair[0] == pair[1]) {
        KnownValidTime::Known {
            value: times[0].clone(),
        }
    } else {
        missing.push(ConflictReasonCode::RelationMissingValidTime);
        KnownValidTime::Unknown
    };

    missing.sort_unstable();
    missing.dedup();
    Qualifiers {
        scope,
        state_stage,
        valid_time,
        missing,
    }
}

fn endpoint_of(
    belief: &BeliefState,
    revision: &RevisionState,
    relation_event_id: &str,
    origin: RelationOrigin,
    qualifiers: &Qualifiers,
) -> DeclaredRelationEndpoint {
    let projected = crate::ledger::project::project(&revision.content, &revision.fields);
    DeclaredRelationEndpoint {
        relation_event_id: relation_event_id.to_string(),
        belief_id: belief.belief_id.clone(),
        belief_revision_event_id: revision.event_id.clone(),
        relation_origin: origin,
        subject_id: belief.entity_id.clone(),
        // The revision's own projected bytes, through the formula attestation
        // already uses. A second content-hash domain would be a second thing
        // to keep in step for no reader's benefit.
        content_hash: schema::belief::attested_content_hash(projected.as_bytes()),
        scope: qualifiers.scope.clone(),
        state_stage: qualifiers.state_stage.clone(),
        valid_time: qualifiers.valid_time.clone(),
    }
}

/// The verdict for one declaration, from what its endpoints could say.
///
/// Anything missing is `partial` naming exactly what was absent. Everything
/// present runs the gauntlet's typed gates — and a declaration those gates
/// separate really is stage lag or succession wearing a declaration, which is
/// the case the preservation gate must never fire on. What survives is the
/// bare declaration itself: `partial`, reason `declared_contradicts_relation`,
/// with an edge.
fn verdict(
    left: &DeclaredRelationEndpoint,
    right: &DeclaredRelationEndpoint,
    missing: Vec<ConflictReasonCode>,
) -> (ConflictOutcome, Vec<ConflictReasonCode>) {
    if !missing.is_empty() {
        return (ConflictOutcome::Partial, missing);
    }
    if left.subject_id != right.subject_id {
        return (
            ConflictOutcome::ResolvedByScope,
            vec![ConflictReasonCode::ScopeDisjoint],
        );
    }
    let (KnownScope::Known { value: left_scope }, KnownScope::Known { value: right_scope }) =
        (&left.scope, &right.scope)
    else {
        // Unreachable: an unknown scope produced a missing code above.
        return (
            ConflictOutcome::Partial,
            vec![ConflictReasonCode::RelationMissingScope],
        );
    };
    if !qualifiers_overlap(left_scope, right_scope) {
        return (
            ConflictOutcome::ResolvedByScope,
            vec![ConflictReasonCode::ScopeDisjoint],
        );
    }
    if let (KnownValidTime::Known { value: a }, KnownValidTime::Known { value: b }) =
        (&left.valid_time, &right.valid_time)
    {
        if !valid_times_overlap(a, b) {
            return (
                ConflictOutcome::ResolvedTemporally,
                vec![ConflictReasonCode::TemporalDisjoint],
            );
        }
    }
    if !stages_overlap(left_scope, right_scope) {
        return (
            ConflictOutcome::ResolvedByStage,
            vec![ConflictReasonCode::StageDisjoint],
        );
    }
    (
        ConflictOutcome::Partial,
        vec![ConflictReasonCode::DeclaredContradictsRelation],
    )
}

/// Classify one declaration and plan what it still owes the ledger.
///
/// `base_ordinal` is where this plan's FIRST member sits in the whole batch,
/// so the open edge can name the classification that justified it by ordinal.
/// The backfill's declaration is the whole batch and passes 0; an authored one
/// rides behind its own relation event and passes the ordinal after it.
///
/// `Ok(None)` means the declaration cannot be classified at all — a belief or
/// the pinned revision is gone. It is neither planned nor counted, because a
/// count that included it would claim coverage nobody has.
pub fn plan(
    state: &EpistemicState,
    declaration: &Declaration,
    actor: &Actor,
    rule_version: &str,
    classified_at: &str,
    base_ordinal: usize,
) -> Result<Option<Planned>, String> {
    let mut endpoints = Vec::new();
    let mut missing = Vec::new();
    for (belief_id, revision_event) in [&declaration.from, &declaration.to] {
        let Some(belief) = state.beliefs.get(belief_id) else {
            return Ok(None);
        };
        let Some(revision) = belief
            .revisions
            .iter()
            .find(|r| &r.event_id == revision_event)
        else {
            return Ok(None);
        };
        let qualifiers = qualifiers_of(state, revision);
        missing.extend(qualifiers.missing.iter().copied());
        endpoints.push(endpoint_of(
            belief,
            revision,
            &declaration.relation_event_id,
            declaration.origin,
            &qualifiers,
        ));
    }
    missing.sort_unstable();
    missing.dedup();

    let (first, _) = ordered_declared_endpoints(&endpoints[0], &endpoints[1])?;
    let (left, right) = if serde_json::to_string(&endpoints[0]).map_err(|e| e.to_string())? == first
    {
        (endpoints[0].clone(), endpoints[1].clone())
    } else {
        (endpoints[1].clone(), endpoints[0].clone())
    };
    let comparison_id =
        derive_declared_comparison_id(&declaration.relation_event_id, &left, &right)?;

    // Already settled: reported from what the store decided, never re-decided.
    if let Some(existing) = state.conflict_classifications.get(&comparison_id) {
        return Ok(Some(Planned {
            comparison_id,
            outcome: existing.outcome,
            members: Vec::new(),
        }));
    }

    let (outcome, reason_codes) = verdict(&left, &right, missing);
    let planned_against_a_committed_relation = schema::is_id128(&declaration.relation_event_id);
    let mut members = Vec::new();
    // A comparison already registered means a previous attempt's batch
    // committed its registration; the classification is then member 0.
    if !state.comparisons.contains_key(&comparison_id) {
        let registration = ConflictComparisonRegistered {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: actor.clone(),
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            comparison_id: comparison_id.clone(),
            left: left.clone(),
            right: right.clone(),
            source_relation_event_id: declaration.relation_event_id.clone(),
            reason: ConflictReasonCode::DeclaredContradictsRelation,
            rule_version: rule_version.to_string(),
        };
        // Validated only when the relation event already exists. The
        // authoring path plans BEFORE the writer allocates, so its
        // `relation_event_id` is still a `member_ref` placeholder and every id
        // check here would refuse what the writer is about to make correct.
        // Whatever lands is validated by `append_batch` either way; this is
        // the earlier, better-worded refusal for the pass that can have one.
        if planned_against_a_committed_relation {
            registration.validate()?;
        }
        members.push((
            KIND_CONFLICT_COMPARISON_REGISTERED.to_string(),
            serde_json::to_value(&registration).map_err(|e| e.to_string())?,
        ));
    }

    let classified = ConflictClassified {
        schema: BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: actor.clone(),
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        comparison_id: comparison_id.clone(),
        left: ConflictEndpoint::DeclaredRelation {
            endpoint: left.clone(),
        },
        right: ConflictEndpoint::DeclaredRelation {
            endpoint: right.clone(),
        },
        outcome,
        classification: Classification::Deterministic {
            rule_version: rule_version.to_string(),
        },
        evidence_event_ids: vec![],
        reason_codes,
        classified_at: classified_at.to_string(),
    };
    if planned_against_a_committed_relation {
        classified.validate()?;
    }
    let classified_ordinal = base_ordinal + members.len();
    members.push((
        KIND_CONFLICT_CLASSIFIED.to_string(),
        serde_json::to_value(&classified).map_err(|e| e.to_string())?,
    ));

    if let Some(kind) = EdgeKind::of(outcome) {
        let opened = schema::ContradictionOpened {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: actor.clone(),
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            edge_id: schema::derive_edge_id(&comparison_id, kind),
            comparison_id: comparison_id.clone(),
            left: ConflictEndpoint::DeclaredRelation { endpoint: left },
            right: ConflictEndpoint::DeclaredRelation { endpoint: right },
            kind,
            classified_event_id: crate::ledger::writer::member_ref(classified_ordinal),
        };
        // Bodies here are NOT validated: `relation_event_id` and
        // `classified_event_id` may still be symbolic — the authoring path
        // plans before the writer substitutes — so the reducer is what
        // validates whatever actually lands.
        members.push((
            KIND_CONTRADICTION_OPENED.to_string(),
            serde_json::to_value(&opened).map_err(|e| e.to_string())?,
        ));
    }

    Ok(Some(Planned {
        comparison_id,
        outcome,
        members,
    }))
}
