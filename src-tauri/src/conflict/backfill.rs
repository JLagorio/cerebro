//! The legacy `contradicts` backfill (M27.3d) — every declaration classified
//! before anything is gated on classification.
//!
//! The rule this applies — what a declared endpoint is, what its missing
//! qualifiers mean, and which verdicts leave an edge behind — lives in
//! [`super::declared`], shared with the authoring path. What is HERE is the
//! sweep: finding the declarations a store already holds, and accounting for
//! all of them.
//!
//! **Position, not state.** Which revision an endpoint sat on is a question
//! about where in the ledger the relation event fell, and the reducer keeps no
//! event-to-position index — nor should it grow one for a pass that runs once.
//! So this walks frames.
//!
//! **Idempotent, and resumable by checkpoint.** Each relation's registration,
//! classification, and edge are one keyed batch; a relation already
//! classified is skipped and still counted, so the marker's arithmetic covers
//! the whole prefix rather than the part this run happened to do.

use std::collections::BTreeMap;

use crate::ledger::frame::Frame;
use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    self, Actor, ConflictOutcome, ContradictionBackfillCompleted, RelationAction, RelationKind,
    RelationOrigin, BODY_SCHEMA, KIND_CONTRADICTION_BACKFILL_COMPLETED,
};

use super::declared::{self, Declaration};

pub const BACKFILL_VERSION: &str = "contradiction-backfill-v1";

/// Who the backfill signs as. Not the migrator and not an agent: this is the
/// store classifying declarations it already held.
pub const ACTOR: &str = "system:contradiction-backfill";

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
    // The origin the STORE already recorded for a relation, where it has one.
    //
    // `relation_origin` is a field of the endpoint, so it is inside the bytes
    // the comparison id hashes — guessing a different one derives a different
    // comparison for the same relation. Before M27.5a this sweep guessed
    // `pre_activation_declared` for every non-migrator relation, including
    // ones the `edit_relation` expansion had ALREADY registered as
    // `post_activation_declared`: the store then held two comparisons, two
    // classifications, and two open edges for one declaration, and the
    // preservation gate demanded both be addressed.
    let known: BTreeMap<&str, RelationOrigin> = state
        .comparisons
        .values()
        .filter_map(|row| {
            let crate::ledger::reduce::ComparisonOrigin::Declared {
                source_relation_event_id,
                ..
            } = &row.origin
            else {
                return None;
            };
            let schema::ConflictEndpoint::DeclaredRelation { endpoint } = &row.left else {
                return None;
            };
            Some((source_relation_event_id.as_str(), endpoint.relation_origin))
        })
        .collect();

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
                    // What the store recorded beats what the actor suggests:
                    // a guess that disagrees mints a second comparison for
                    // one declaration.
                    origin: known.get(frame.event_id.as_str()).copied().unwrap_or(
                        if relation.actor.id == schema::ACTOR_MIGRATOR {
                            RelationOrigin::LegacyMigration
                        } else {
                            RelationOrigin::PreActivationDeclared
                        },
                    ),
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

/// One declaration's plan, and the outcome it counts toward.
///
/// `Ok(None)` means this declaration cannot be classified at all — its
/// beliefs or revisions are gone — so it is neither planned nor counted, and
/// the marker's arithmetic stays honest.
fn plan_one(
    state: &EpistemicState,
    declaration: &Declaration,
    store_uuid: &str,
    classified_at: &str,
) -> Result<Option<(Option<Plan>, ConflictOutcome)>, String> {
    let actor = Actor {
        id: ACTOR.to_string(),
    };
    // Ordinal 0: a backfill declaration's plan IS its whole batch. The
    // relation event it classifies committed long ago.
    let Some(planned) = declared::plan(
        state,
        declaration,
        &actor,
        BACKFILL_VERSION,
        classified_at,
        0,
    )?
    else {
        return Ok(None);
    };
    if planned.members.is_empty() {
        return Ok(Some((None, planned.outcome)));
    }
    Ok(Some((
        Some(Plan {
            operation_key: format!(
                "contradiction-backfill:{store_uuid}:{}",
                planned.comparison_id
            ),
            comparison_id: planned.comparison_id,
            outcome: planned.outcome,
            members: planned.members,
        }),
        planned.outcome,
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
    // THE FIXED POINT, and it cannot be positional. A marker naming
    // `frames.last()` BECOMES the last frame, so "is the stored checkpoint's
    // head the current head?" is false on every tick after the first — and
    // the pass would append one checkpoint every 300 seconds, forever, into
    // an append-only in-vault ledger.
    //
    // What a checkpoint claims is coverage: this many live declarations, this
    // many resolved, this many left open, under this rule version. A run that
    // would claim exactly what the store already claims has nothing to say,
    // whatever the head has moved to since. The head check stays as the
    // cheaper half of the same question.
    let already_claimed = state
        .contradiction_backfill
        .as_ref()
        .is_some_and(|checkpoint| {
            checkpoint.through_event_id == head
                || (checkpoint.rule_version == BACKFILL_VERSION
                    && checkpoint.source_relation_count == sweep.source_relation_count
                    && checkpoint.resolved_count == sweep.resolved_count
                    && checkpoint.opened_count == sweep.opened_count)
        });
    if already_claimed {
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
        derive_relation_id, AssertionKind, AuthorityProvenance, BasisLink, BasisRole, BeliefBasis,
        BeliefCreated, BeliefRelation, ConflictClassified, ConflictReasonCode, HumanAssertionForm,
        HumanAssertionPayload, ObservationKind, ObservationRecorded, Provenance,
        RelationshipToSubject, Scope, SourceRegistered, SourceRegistration, Stage, SubjectRef,
        SubjectRole, TypedValue, KIND_CONFLICT_CLASSIFIED, KIND_CONFLICT_COMPARISON_REGISTERED,
        KIND_CONTRADICTION_OPENED,
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

    /// One ambient tick against a REAL writer: re-read the ledger, re-fold,
    /// run. The spy-backed tests cannot see this class of bug, because the
    /// marker only becomes the head when it is actually written.
    fn tick(rig: &mut Rig) -> Ran {
        let frames = rig.frames();
        let store_id = rig.store_id.clone();
        let state = reduce(&frames, &store_id);
        let commit = Direct {
            writer: std::cell::RefCell::new(&mut rig.writer),
        };
        run(&frames, &state, &store_id, AS_OF, &commit, &commit)
    }

    /// A `Commit`/`Append` pair that writes to a real ledger, so the marker
    /// this run appends is the head the next run reads.
    struct Direct<'a> {
        writer: std::cell::RefCell<&'a mut LedgerWriter>,
    }

    impl crate::ingest::pass::Commit for Direct<'_> {
        fn append_batch(
            &self,
            events: Vec<(String, serde_json::Value)>,
            operation_key: &str,
        ) -> Result<(), String> {
            self.writer
                .borrow_mut()
                .append_batch(events, Some(operation_key))
                .map(|_| ())
        }
    }

    impl super::super::emit::Append for Direct<'_> {
        fn append_once(
            &self,
            key: &str,
            kind: &str,
            body: serde_json::Value,
        ) -> Result<super::super::emit::Wrote, String> {
            self.writer
                .borrow_mut()
                .append_once(key, kind, body)
                .map(|_| super::super::emit::Wrote::Appended)
        }
    }

    #[test]
    fn a_relation_the_store_already_classified_is_not_classified_a_second_way() {
        // M27.5a. `relation_origin` sits inside the bytes the comparison id
        // hashes, so guessing an origin the store has already recorded
        // differently mints a SECOND comparison, verdict, and open edge for
        // one declaration — and the preservation gate then demands both be
        // addressed.
        let mut rig = Rig::new("m27-backfill-origin");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, "agent:run-1");

        // Classify it the way the AUTHORING path does — post-activation.
        let frames = rig.frames();
        let state = rig.state();
        let mut declaration = declarations(&frames, &state)[0].clone();
        assert_eq!(declaration.origin, RelationOrigin::PreActivationDeclared);
        declaration.origin = RelationOrigin::PostActivationDeclared;
        let planned = declared::plan(
            &state,
            &declaration,
            &Actor {
                id: "agent:run-1".into(),
            },
            "contradiction-declared-v1",
            AS_OF,
            0,
        )
        .unwrap()
        .unwrap();
        rig.writer
            .append_batch(planned.members.clone(), Some("op:authored"))
            .unwrap();

        let state = rig.state();
        assert_eq!(state.comparisons.len(), 1);
        assert_eq!(state.contradiction_edges.len(), 1);

        // The sweep now reads the origin the store recorded instead of
        // guessing, derives the SAME comparison, and finds it settled.
        let sweep = sweep(&rig.frames(), &state, &rig.store_id, AS_OF);
        assert!(
            sweep.plans.is_empty(),
            "a classified declaration is not classified a second way: {:?}",
            sweep.plans
        );
        assert_eq!(sweep.source_relation_count, 1, "and it still counts");
        assert_eq!(sweep.opened_count, 1);
        assert_eq!(
            declarations(&rig.frames(), &state)[0].origin,
            RelationOrigin::PostActivationDeclared
        );
    }

    #[test]
    fn the_checkpoint_reaches_a_fixed_point_instead_of_one_marker_per_tick() {
        // THE BUG THIS EXISTS FOR (M27.5a): the marker names `frames.last()`
        // and then BECOMES `frames.last()`, so a positional skip is false on
        // every tick after the first. The ambient pass runs every 300s
        // unconditionally, so the ledger grew by one frame forever.
        let mut rig = Rig::new("m27-backfill-fixed-point");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, schema::ACTOR_MIGRATOR);

        let first = tick(&mut rig);
        assert_eq!(first.classified, 1);
        assert!(first.marker.is_some(), "the first run checkpoints");
        let markers = |rig: &Rig| {
            rig.frames()
                .iter()
                .filter(|f| f.kind == KIND_CONTRADICTION_BACKFILL_COMPLETED)
                .count()
        };
        assert_eq!(markers(&rig), 1);

        for _ in 0..4 {
            let again = tick(&mut rig);
            assert_eq!(again.classified, 0);
            assert_eq!(again.already_done, 1);
            assert!(again.failed.is_empty(), "{:?}", again.failed);
            assert!(
                again.marker.is_none(),
                "a run that claims what the store already claims writes nothing"
            );
        }
        assert_eq!(markers(&rig), 1, "one marker, however many ticks");
        assert!(reduce(&rig.frames(), &rig.store_id).anomalies.is_empty());
    }

    #[test]
    fn withdrawing_a_declaration_does_not_wedge_the_checkpoint() {
        // The second half of the same bug (M27.5a). `source_relation_count`
        // counts LIVE relations, so a withdrawal legitimately shrinks it —
        // and the reducer used to refuse every later marker on that ground,
        // freezing coverage at a number the store had moved past.
        let mut rig = Rig::new("m27-backfill-withdrawn-checkpoint");
        belief(&mut rig, BELIEF, unsupported());
        belief(&mut rig, BELIEF_B, unsupported());
        contradicts(&mut rig, schema::ACTOR_MIGRATOR);
        tick(&mut rig);
        assert_eq!(
            reduce(&rig.frames(), &rig.store_id)
                .contradiction_backfill
                .unwrap()
                .source_relation_count,
            1
        );

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

        let after = tick(&mut rig);
        assert!(after.failed.is_empty(), "{:?}", after.failed);
        assert!(
            after.marker.is_some(),
            "the shrink is a real coverage claim"
        );
        let state = reduce(&rig.frames(), &rig.store_id);
        assert!(state.anomalies.is_empty(), "{:?}", state.anomalies);
        assert_eq!(
            state.contradiction_backfill.unwrap().source_relation_count,
            0
        );
        // ...and it settles again rather than re-checkpointing forever.
        assert!(tick(&mut rig).marker.is_none());
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
