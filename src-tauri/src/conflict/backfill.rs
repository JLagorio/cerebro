//! The legacy `contradicts` backfill (M27.3d) — every declaration classified
//! before anything is gated on classification.
//!
//! **A declared relation is a claim with no evidence behind it.** Somebody
//! wrote "these two contradict" — a migration inherited it from an older
//! vault, or a person typed it before the pipeline existed — and there is no
//! assertion anywhere that says so. That is why this cannot reuse the ordinary
//! endpoint: fabricating an assertion to make the shape fit would put a claim
//! in the ledger that nobody made. Each side becomes a `declared_relation`
//! endpoint pinning the relation event, the belief revision current AT that
//! event, and whatever qualifiers the revision's own evidence happens to
//! carry — explicitly `known` or `unknown`, never defaulted.
//!
//! **Missing qualifiers never resolve a pair apart.** If a revision has no
//! assertions at all, or its assertions disagree about scope, the honest
//! answer is not "no conflict" — it is `partial`, with `relation_missing_*`
//! codes naming exactly what was absent, and an open edge. Silence about why
//! two things might not conflict is not a reason they do not.
//!
//! **What the qualifiers DO support runs the same gauntlet.** A declared
//! contradiction between an `planned` claim and a `shipping` one is stage lag
//! wearing a declaration, and the M27.4 gate must not fire on it.
//!
//! **Idempotent, and resumable by checkpoint.** Each relation's registration,
//! classification, and edge are one keyed batch; a relation already
//! classified is skipped and still counted, so the marker's arithmetic covers
//! the whole prefix rather than the part this run happened to do.

use std::collections::BTreeMap;

use crate::ledger::frame::Frame;
use crate::ledger::reduce::{BeliefState, EpistemicState, RevisionState};
use crate::ledger::schema::{
    self, derive_declared_comparison_id, ordered_declared_endpoints, Actor, BasisRole, BeliefBasis,
    Classification, ConflictClassified, ConflictComparisonRegistered, ConflictEndpoint,
    ConflictOutcome, ConflictReasonCode, ContradictionBackfillCompleted, ContradictionOpened,
    DeclaredRelationEndpoint, EdgeKind, KnownScope, KnownStage, KnownValidTime, RelationAction,
    RelationKind, RelationOrigin, Scope, ValidInterval, BODY_SCHEMA, KIND_CONFLICT_CLASSIFIED,
    KIND_CONFLICT_COMPARISON_REGISTERED, KIND_CONTRADICTION_BACKFILL_COMPLETED,
    KIND_CONTRADICTION_OPENED,
};

use super::detect::{qualifiers_overlap, stages_overlap, valid_times_overlap};

pub const BACKFILL_VERSION: &str = "contradiction-backfill-v1";

/// Who the backfill signs as. Not the migrator and not an agent: this is the
/// store classifying declarations it already held.
pub const ACTOR: &str = "system:contradiction-backfill";

/// One declared `contradicts` relation, as the backfill found it.
#[derive(Debug, Clone, PartialEq)]
pub struct Declaration {
    pub relation_event_id: String,
    pub relation_id: String,
    pub origin: RelationOrigin,
    /// The revisions current AT the relation event, by belief.
    pub from: (String, String),
    pub to: (String, String),
}

/// Every live `contradicts` relation, with the revisions its endpoints were
/// on when it was written.
///
/// This walks FRAMES rather than reduced state because "current at the
/// relation event" is a question about position, and the reducer keeps no
/// event-to-position index — nor should it grow one for a pass that runs
/// once. Only relations that are still LIVE are returned: a declaration its
/// author took back is not a conflict anybody still holds, and the reducer
/// refuses to register one anyway.
pub fn declarations(frames: &[Frame], state: &EpistemicState) -> Vec<Declaration> {
    let mut current: BTreeMap<String, String> = BTreeMap::new();
    let mut found: Vec<Declaration> = Vec::new();

    for frame in frames {
        let Ok(Some(body)) = schema::decode_body(&frame.kind, &frame.body) else {
            continue;
        };
        match &body {
            schema::EventBody::BeliefCreated(created) => {
                current.insert(created.belief_id.clone(), frame.event_id.clone());
            }
            schema::EventBody::BeliefRevised(revised) => {
                current.insert(revised.belief_id.clone(), frame.event_id.clone());
            }
            schema::EventBody::BeliefRelation(relation) => {
                if relation.relation != RelationKind::Contradicts
                    || relation.action != RelationAction::Add
                {
                    continue;
                }
                let (Some(from), Some(to)) = (
                    current.get(&relation.from).cloned(),
                    current.get(&relation.to).cloned(),
                ) else {
                    // A relation whose endpoints have no committed revision
                    // cannot happen (the reducer refuses it), and guessing a
                    // revision would be worse than skipping.
                    continue;
                };
                found.push(Declaration {
                    relation_event_id: frame.event_id.clone(),
                    relation_id: relation.relation_id.clone(),
                    origin: if relation.actor.id == schema::ACTOR_MIGRATOR {
                        RelationOrigin::LegacyMigration
                    } else {
                        RelationOrigin::PreActivationDeclared
                    },
                    from: (relation.from.clone(), from),
                    to: (relation.to.clone(), to),
                });
            }
            _ => {}
        }
    }

    // Only the adds that are still the live one for their relation. A removed
    // and re-added relation keeps its LAST add, which is the declaration that
    // stands.
    found.retain(|declaration| {
        state
            .relations
            .get(&declaration.relation_id)
            .is_some_and(|row| row.live && row.last_add_event_id == declaration.relation_event_id)
    });
    found
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

/// One declaration's whole batch.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub comparison_id: String,
    pub outcome: ConflictOutcome,
    pub members: Vec<(String, serde_json::Value)>,
    pub operation_key: String,
}

/// What the backfill would write, and what it already accounts for.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sweep {
    pub plans: Vec<Plan>,
    /// Every live declared relation the sweep saw, planned or already done.
    pub source_relation_count: u64,
    pub resolved_count: u64,
    pub opened_count: u64,
    pub failed: Vec<(String, String)>,
}

/// Plan the whole prefix. Relations already classified are skipped and still
/// counted — the marker claims coverage of the LEDGER, not of this run.
pub fn sweep(
    frames: &[Frame],
    state: &EpistemicState,
    store_uuid: &str,
    classified_at: &str,
) -> Sweep {
    let mut out = Sweep::default();
    for declaration in declarations(frames, state) {
        match plan_one(state, &declaration, store_uuid, classified_at) {
            Ok(Some((plan, outcome))) => {
                out.source_relation_count += 1;
                if outcome.is_unresolved() {
                    out.opened_count += 1;
                } else {
                    out.resolved_count += 1;
                }
                if let Some(plan) = plan {
                    out.plans.push(plan);
                }
            }
            Ok(None) => {}
            Err(detail) => out
                .failed
                .push((declaration.relation_event_id.clone(), detail)),
        }
    }
    out
}

/// `Ok(None)` means this declaration cannot be classified at all — its
/// beliefs or revisions are gone — so it is neither planned nor counted, and
/// the marker's arithmetic stays honest.
#[allow(clippy::type_complexity)]
fn plan_one(
    state: &EpistemicState,
    declaration: &Declaration,
    store_uuid: &str,
    classified_at: &str,
) -> Result<Option<(Option<Plan>, ConflictOutcome)>, String> {
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

    // Already settled: counted from what the store decided, never re-decided.
    if let Some(existing) = state.conflict_classifications.get(&comparison_id) {
        return Ok(Some((None, existing.outcome)));
    }

    let (outcome, reason_codes) = verdict(&left, &right, missing);
    let actor = Actor {
        id: ACTOR.to_string(),
    };
    let mut members = Vec::new();
    // A comparison already registered means a previous run's batch committed
    // its registration; the classification is then member 0.
    let registered = state.comparisons.contains_key(&comparison_id);
    if !registered {
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
            rule_version: BACKFILL_VERSION.to_string(),
        };
        registration.validate()?;
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
            rule_version: BACKFILL_VERSION.to_string(),
        },
        evidence_event_ids: vec![],
        reason_codes,
        classified_at: classified_at.to_string(),
    };
    classified.validate()?;
    let classified_ordinal = members.len();
    members.push((
        KIND_CONFLICT_CLASSIFIED.to_string(),
        serde_json::to_value(&classified).map_err(|e| e.to_string())?,
    ));

    if let Some(kind) = EdgeKind::of(outcome) {
        let opened = ContradictionOpened {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor,
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
        // Not validated: `member_ref` is symbolic until the writer
        // substitutes it, so the reducer is what validates what lands.
        members.push((
            KIND_CONTRADICTION_OPENED.to_string(),
            serde_json::to_value(&opened).map_err(|e| e.to_string())?,
        ));
    }

    Ok(Some((
        Some(Plan {
            comparison_id: comparison_id.clone(),
            outcome,
            members,
            operation_key: format!("contradiction-backfill:{store_uuid}:{comparison_id}"),
        }),
        outcome,
    )))
}

/// What one backfill pass did.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Ran {
    pub classified: usize,
    pub already_done: usize,
    pub marker: Option<String>,
    pub failed: Vec<(String, String)>,
}

/// Run the sweep and, when the whole prefix is accounted for, checkpoint it.
///
/// The marker names the head the sweep READ, not the head after its own
/// writes: it claims coverage of the pre-activation ledger, and the batches
/// it just appended are that coverage rather than more work to do.
pub fn run<C, A>(
    frames: &[Frame],
    state: &EpistemicState,
    store_uuid: &str,
    classified_at: &str,
    committer: &C,
    appender: &A,
) -> Ran
where
    C: crate::ingest::pass::Commit,
    A: super::emit::Append,
{
    let sweep = sweep(frames, state, store_uuid, classified_at);
    let mut out = Ran {
        already_done: sweep.source_relation_count as usize - sweep.plans.len(),
        failed: sweep.failed,
        ..Ran::default()
    };
    let mut wrote_everything = true;
    for plan in &sweep.plans {
        match committer.append_batch(plan.members.clone(), &plan.operation_key) {
            Ok(()) => out.classified += 1,
            Err(detail) => {
                wrote_everything = false;
                out.failed.push((plan.comparison_id.clone(), detail));
            }
        }
    }
    if !wrote_everything {
        // A marker over a prefix this run could not finish would let
        // activation proceed on a base that still holds unclassified
        // declarations — exactly what the checkpoint exists to prevent.
        return out;
    }

    let Some(head) = frames.last().map(|frame| frame.event_id.clone()) else {
        return out;
    };
    if state
        .contradiction_backfill
        .as_ref()
        .is_some_and(|checkpoint| checkpoint.through_event_id == head)
    {
        return out;
    }
    let marker = ContradictionBackfillCompleted {
        schema: BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: Actor {
            id: ACTOR.to_string(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        through_event_id: head.clone(),
        source_relation_count: sweep.source_relation_count,
        resolved_count: sweep.resolved_count,
        opened_count: sweep.opened_count,
        rule_version: BACKFILL_VERSION.to_string(),
    };
    match marker
        .validate()
        .and_then(|()| serde_json::to_value(&marker).map_err(|e| e.to_string()))
    {
        Ok(value) => {
            let key = format!("contradiction-backfill-marker:{store_uuid}:{head}");
            match appender.append_once(&key, KIND_CONTRADICTION_BACKFILL_COMPLETED, value) {
                Ok(_) => out.marker = Some(head),
                Err(detail) => out.failed.push((head, detail)),
            }
        }
        Err(detail) => out.failed.push((head, detail)),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::reduce;
    use crate::ledger::schema::{
        derive_relation_id, AssertionKind, AuthorityProvenance, BasisLink, BeliefCreated,
        BeliefRelation, HumanAssertionForm, HumanAssertionPayload, ObservationKind,
        ObservationRecorded, Provenance, RelationshipToSubject, SourceRegistered,
        SourceRegistration, Stage, SubjectRef, SubjectRole, TypedValue,
    };
    use crate::ledger::writer::LedgerWriter;
    use crate::ledger::{ledger_dir, read_ledger, store};
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    const ENTITY: &str = "cccccccccccccccccccccccccccccccc";
    const BELIEF: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const BELIEF_B: &str = "ffffffffffffffffffffffffffffffff";
    const AS_OF: &str = "2026-08-12T09:00:00.000Z";

    struct Rig {
        vault: std::path::PathBuf,
        writer: LedgerWriter,
        store_id: String,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    /// Collects what the seams were handed, so a test can assert the SHAPE of
    /// a batch without a filesystem.
    #[derive(Default)]
    struct Spy {
        batches: std::cell::RefCell<Vec<(String, Vec<String>)>>,
        solo: std::cell::RefCell<Vec<(String, String)>>,
    }

    impl crate::ingest::pass::Commit for Spy {
        fn append_batch(
            &self,
            events: Vec<(String, serde_json::Value)>,
            operation_key: &str,
        ) -> Result<(), String> {
            self.batches.borrow_mut().push((
                operation_key.to_string(),
                events.into_iter().map(|(kind, _)| kind).collect(),
            ));
            Ok(())
        }
    }

    impl super::super::emit::Append for Spy {
        fn append_once(
            &self,
            key: &str,
            kind: &str,
            _body: serde_json::Value,
        ) -> Result<super::super::emit::Wrote, String> {
            self.solo
                .borrow_mut()
                .push((key.to_string(), kind.to_string()));
            Ok(super::super::emit::Wrote::Appended)
        }
    }

    impl Rig {
        fn new(label: &str) -> Rig {
            let vault = testutil::temp_vault(label);
            let writer = LedgerWriter::open(&vault, WRITER).unwrap();
            let store_id = store::load(&ledger_dir(&vault)).unwrap().unwrap().store_id;
            Rig {
                vault,
                writer,
                store_id,
            }
        }

        fn append<T: serde::Serialize>(&mut self, kind: &str, body: &T) -> String {
            self.writer
                .append(kind, serde_json::to_value(body).unwrap())
                .unwrap()
                .event_id
        }

        fn frames(&self) -> Vec<Frame> {
            read_ledger(&ledger_dir(&self.vault)).unwrap().frames
        }

        fn state(&self) -> EpistemicState {
            reduce(&self.frames(), &self.store_id)
        }
    }

    fn human_source(rig: &mut Rig) -> (String, String) {
        let mut registration = SourceRegistration::HumanActor {
            source_key: String::new(),
            actor_id: "human:josef".into(),
            authority_capability: schema::AuthorityCapability::HumanAssertion,
            independence_domain_id: None,
        };
        let key = registration.derived_source_key().unwrap();
        if let SourceRegistration::HumanActor { source_key, .. } = &mut registration {
            *source_key = key.clone();
        }
        let source_id = schema::derive_source_id(&rig.store_id, &key);
        let body = SourceRegistered {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: schema::ACTOR_SOURCE_REGISTRY.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            source_id: source_id.clone(),
            registration,
        };
        let event = rig.append(schema::KIND_SOURCE_REGISTERED, &body);
        (source_id, event)
    }

    fn assertion(rig: &mut Rig, source: &(String, String), stage: Option<Stage>) -> String {
        let payload = serde_json::to_value(HumanAssertionPayload {
            assertion: schema::AssertionFields {
                assertion_kind: AssertionKind::Presence,
                predicate: "gpu_supplier".into(),
                value: TypedValue::string("amd"),
                scope: Scope {
                    stage,
                    revision: None,
                    environment: None,
                    geography: None,
                },
                relationship_to_subject: RelationshipToSubject {
                    role: SubjectRole::Unknown,
                },
                assertion_basis: schema::AssertionBasis::Firsthand,
                authority_provenance: AuthorityProvenance::TrustedHumanCapture,
                absence: None,
            },
            form: HumanAssertionForm::Standalone {
                intended_belief_id: None,
                corrects: None,
                reason: None,
            },
        })
        .unwrap();
        let body = ObservationRecorded {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "human:josef".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            observation_kind: ObservationKind::HumanAssertion,
            source_id: source.0.clone(),
            source_registration_event_id: source.1.clone(),
            subject: SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            lineage: vec![],
            provenance: Provenance::empty(),
            payload,
        };
        rig.append(schema::KIND_OBSERVATION_RECORDED, &body)
    }

    fn belief(rig: &mut Rig, belief_id: &str, basis: BeliefBasis) -> String {
        let body = BeliefCreated {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "agent:run-1".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.into(),
            subject: SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            content: format!("# {belief_id}\n"),
            fields: serde_json::json!({}),
            basis,
        };
        rig.append(schema::KIND_BELIEF_CREATED, &body)
    }

    fn contradicts(rig: &mut Rig, actor: &str) -> String {
        let body = BeliefRelation {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: actor.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            relation_id: derive_relation_id(BELIEF, BELIEF_B, RelationKind::Contradicts),
            from: BELIEF.into(),
            to: BELIEF_B.into(),
            relation: RelationKind::Contradicts,
            action: RelationAction::Add,
        };
        rig.append(schema::KIND_BELIEF_RELATION, &body)
    }

    fn linked(observation: &str) -> BeliefBasis {
        BeliefBasis::Linked {
            links: vec![BasisLink {
                observation_event_id: observation.into(),
                role: BasisRole::Supports,
            }],
        }
    }

    fn unsupported() -> BeliefBasis {
        BeliefBasis::Unsupported {
            reason: "migrated without observations".into(),
        }
    }

    #[test]
    fn a_declaration_with_no_evidence_opens_a_partial_edge_naming_what_was_missing() {
        // The conservative case, and the one that must never silently
        // resolve: two beliefs a migration said contradict, with nothing
        // behind either of them.
        let mut rig = Rig::new("m27-backfill-bare");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, schema::ACTOR_MIGRATOR);

        let frames = rig.frames();
        let state = rig.state();
        let found = declarations(&frames, &state);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].origin, RelationOrigin::LegacyMigration);

        let sweep = sweep(&frames, &state, &rig.store_id, AS_OF);
        assert_eq!(sweep.source_relation_count, 1);
        assert_eq!(sweep.opened_count, 1);
        assert_eq!(sweep.resolved_count, 0);
        assert_eq!(sweep.plans.len(), 1);
        assert_eq!(sweep.plans[0].outcome, ConflictOutcome::Partial);
        // Registration, classification, edge — in that order, one batch.
        let kinds: Vec<&str> = sweep.plans[0]
            .members
            .iter()
            .map(|(kind, _)| kind.as_str())
            .collect();
        assert_eq!(
            kinds,
            [
                KIND_CONFLICT_COMPARISON_REGISTERED,
                KIND_CONFLICT_CLASSIFIED,
                KIND_CONTRADICTION_OPENED
            ]
        );
        let body: ConflictClassified =
            serde_json::from_value(sweep.plans[0].members[1].1.clone()).unwrap();
        assert_eq!(
            body.reason_codes,
            [ConflictReasonCode::RelationMissingAssertion]
        );
    }

    #[test]
    fn a_declaration_across_two_stages_is_lag_and_resolves() {
        // Stage lag wearing a declaration. The gate must never fire on it.
        let mut rig = Rig::new("m27-backfill-stage");
        let source = human_source(&mut rig);
        let planned = assertion(&mut rig, &source, Some(Stage::Planned));
        let shipping = assertion(&mut rig, &source, Some(Stage::Shipping));
        belief(&mut rig, BELIEF, linked(&planned));
        belief(&mut rig, BELIEF_B, linked(&shipping));
        contradicts(&mut rig, "human:josef");

        let frames = rig.frames();
        let state = rig.state();
        let sweep = sweep(&frames, &state, &rig.store_id, AS_OF);
        assert_eq!(sweep.resolved_count, 1);
        assert_eq!(sweep.opened_count, 0);
        assert_eq!(sweep.plans[0].outcome, ConflictOutcome::ResolvedByStage);
        // No edge: two members only.
        assert_eq!(sweep.plans[0].members.len(), 2);
        assert_eq!(
            declarations(&frames, &state)[0].origin,
            RelationOrigin::PreActivationDeclared,
            "a person wrote this one"
        );
    }

    #[test]
    fn a_declaration_nothing_separates_stands_as_the_bare_declaration() {
        let mut rig = Rig::new("m27-backfill-stands");
        let source = human_source(&mut rig);
        let one = assertion(&mut rig, &source, Some(Stage::Shipping));
        let two = assertion(&mut rig, &source, Some(Stage::Shipping));
        belief(&mut rig, BELIEF, linked(&one));
        belief(&mut rig, BELIEF_B, linked(&two));
        contradicts(&mut rig, "human:josef");

        let state = rig.state();
        let sweep = sweep(&rig.frames(), &state, &rig.store_id, AS_OF);
        assert_eq!(sweep.opened_count, 1);
        let body: ConflictClassified =
            serde_json::from_value(sweep.plans[0].members[1].1.clone()).unwrap();
        assert_eq!(body.outcome, ConflictOutcome::Partial);
        assert_eq!(
            body.reason_codes,
            [ConflictReasonCode::DeclaredContradictsRelation]
        );
    }

    #[test]
    fn a_withdrawn_declaration_is_not_backfilled() {
        let mut rig = Rig::new("m27-backfill-withdrawn");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, "human:josef");
        let removal = BeliefRelation {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "human:josef".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            relation_id: derive_relation_id(BELIEF, BELIEF_B, RelationKind::Contradicts),
            from: BELIEF.into(),
            to: BELIEF_B.into(),
            relation: RelationKind::Contradicts,
            action: RelationAction::Remove,
        };
        rig.append(schema::KIND_BELIEF_RELATION, &removal);

        let state = rig.state();
        let sweep = sweep(&rig.frames(), &state, &rig.store_id, AS_OF);
        assert_eq!(sweep.source_relation_count, 0, "a declaration taken back");
        assert!(sweep.plans.is_empty());
    }

    #[test]
    fn the_run_writes_every_batch_and_then_one_marker() {
        let mut rig = Rig::new("m27-backfill-run");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, schema::ACTOR_MIGRATOR);

        let frames = rig.frames();
        let state = rig.state();
        let spy = Spy::default();
        let ran = run(&frames, &state, &rig.store_id, AS_OF, &spy, &spy);
        assert_eq!(ran.classified, 1);
        assert!(ran.failed.is_empty(), "{:?}", ran.failed);
        assert_eq!(
            ran.marker.as_deref(),
            frames.last().map(|f| f.event_id.as_str()),
            "the marker covers the head the sweep READ"
        );
        assert_eq!(spy.batches.borrow().len(), 1);
        assert!(spy.batches.borrow()[0]
            .0
            .starts_with("contradiction-backfill:"));
        assert_eq!(spy.solo.borrow().len(), 1);
        assert_eq!(
            spy.solo.borrow()[0].1,
            KIND_CONTRADICTION_BACKFILL_COMPLETED
        );
    }

    #[test]
    fn the_whole_pass_is_idempotent_end_to_end() {
        // Sweep, commit for real, re-fold, sweep again: nothing left to do,
        // and the counts still cover the relation.
        let mut rig = Rig::new("m27-backfill-idempotent");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, schema::ACTOR_MIGRATOR);

        let first = sweep(&rig.frames(), &rig.state(), &rig.store_id, AS_OF);
        assert_eq!(first.plans.len(), 1);
        rig.writer
            .append_batch(
                first.plans[0].members.clone(),
                Some(&first.plans[0].operation_key),
            )
            .unwrap();

        let state = rig.state();
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(state.comparisons.len(), 1);
        assert_eq!(state.conflict_classifications.len(), 1);
        assert_eq!(state.contradiction_edges.len(), 1);

        let second = sweep(&rig.frames(), &state, &rig.store_id, AS_OF);
        assert!(
            second.plans.is_empty(),
            "a classified declaration is not classified twice"
        );
        assert_eq!(
            second.source_relation_count, 1,
            "and it still counts toward the marker"
        );
        assert_eq!(second.opened_count, 1);
    }
}
