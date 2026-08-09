//! Shared fixtures + the cross-variant property tests (M22.1): every
//! schema-v1 body round-trips encode→decode→encode byte-identically, the
//! frame stays `v: 0` with `body.schema: 1`, and the decode gate refuses
//! what it must.

use super::observation::RelationshipToSubject;
use super::source::tests::{registered, STORE};
use super::subject::LineageKind;
use super::*;

pub(crate) const ID_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const ID_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub(crate) const ID_C: &str = "cccccccccccccccccccccccccccccccc";
pub(crate) const ID_D: &str = "dddddddddddddddddddddddddddddddd";
pub(crate) const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// `(schema, actor)` — the two common fields every fixture spells the same.
pub(crate) fn common(actor: &str) -> (u64, Actor) {
    (
        BODY_SCHEMA,
        Actor {
            id: actor.to_string(),
        },
    )
}

fn assertion_fields(authority: AuthorityProvenance) -> AssertionFields {
    AssertionFields {
        assertion_kind: AssertionKind::Presence,
        predicate: "status".into(),
        value: TypedValue::string("active"),
        scope: Scope::empty(),
        relationship_to_subject: RelationshipToSubject {
            role: SubjectRole::Unknown,
        },
        assertion_basis: AssertionBasis::Reported,
        authority_provenance: authority,
        absence: None,
    }
}

/// A valid `observation.recorded` fixture for each payload kind.
pub(crate) fn observation_recorded(kind: ObservationKind) -> ObservationRecorded {
    let (subject, lineage, actor, payload) = match kind {
        ObservationKind::SourceSnapshot => (
            SubjectRef::None,
            vec![],
            "agent:run-1",
            serde_json::to_value(SourceSnapshotPayload {
                source_artifact_hash: None,
                raw_pointer: "docs/source.md".into(),
            })
            .unwrap(),
        ),
        ObservationKind::SystemEvent => (
            SubjectRef::None,
            vec![],
            "system:watcher",
            serde_json::to_value(SystemEventPayload {
                event_type: "scan.completed".into(),
                detail: TypedValue::Number {
                    value: serde_json::Number::from(42),
                },
            })
            .unwrap(),
        ),
        ObservationKind::ExtractedAssertion => (
            SubjectRef::Resolved {
                entity_id: ID_B.into(),
                aliases: vec!["Acme".into()],
            },
            vec![LineageEdge {
                edge: LineageKind::ReportedBy,
                parent_observation_event_id: ID_C.into(),
            }],
            "agent:run-1",
            serde_json::to_value(ExtractedAssertionPayload {
                assertion: assertion_fields(AuthorityProvenance::AgentInferred),
                extracted_text: "status is active".into(),
                source_artifact_hash: SHA_A.into(),
                extractor_version: "extract-v1".into(),
                raw_pointer: "mail/123".into(),
            })
            .unwrap(),
        ),
        ObservationKind::DerivedContent => (
            SubjectRef::Resolved {
                entity_id: ID_B.into(),
                aliases: vec![],
            },
            vec![LineageEdge {
                edge: LineageKind::DerivedFrom,
                parent_observation_event_id: ID_C.into(),
            }],
            "agent:run-1",
            serde_json::to_value(DerivedContentPayload {
                assertion: assertion_fields(AuthorityProvenance::AgentInferred),
                rendered_text: "Acme is active.".into(),
                generator_version: "distill-v3".into(),
                source_belief_revision_event_ids: None,
            })
            .unwrap(),
        ),
        ObservationKind::HumanAssertion => (
            SubjectRef::Resolved {
                entity_id: ID_B.into(),
                aliases: vec![],
            },
            vec![],
            "human:josef",
            serde_json::to_value(HumanAssertionPayload {
                assertion: assertion_fields(AuthorityProvenance::TrustedHumanCapture),
                form: HumanAssertionForm::FieldChange {
                    target_belief_id: ID_A.into(),
                    field_path: "/fields/status".into(),
                    before: TypedValue::string("paused"),
                    after: TypedValue::string("active"),
                    corrects: None,
                    reason: None,
                },
            })
            .unwrap(),
        ),
    };
    let (schema, actor) = common(actor);
    ObservationRecorded {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: Some("2026-08-01T09:30:00Z".into()),
        valid_from: None,
        valid_to: None,
        observation_kind: kind,
        source_id: ID_D.into(),
        source_registration_event_id: ID_C.into(),
        subject,
        lineage,
        provenance: Provenance::empty(),
        payload,
    }
}

pub(crate) fn belief_created() -> BeliefCreated {
    let (schema, actor) = common("agent:run-1");
    BeliefCreated {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: ID_A.into(),
        subject: SubjectRef::Resolved {
            entity_id: ID_B.into(),
            aliases: vec!["Acme".into()],
        },
        content: "# Acme\n\nActive vendor.\n".into(),
        fields: serde_json::json!({ "status": "active" }),
        basis: BeliefBasis::Linked {
            links: vec![BasisLink {
                observation_event_id: ID_C.into(),
                role: BasisRole::Supports,
            }],
        },
    }
}

pub(crate) fn belief_revised() -> BeliefRevised {
    let (schema, actor) = common("agent:run-1");
    BeliefRevised {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: ID_A.into(),
        patch: vec![PatchOp {
            field_path: "/fields/status".into(),
            before: TypedValue::string("active"),
            after: TypedValue::string("paused"),
        }],
        basis: BeliefBasis::Unsupported {
            reason: "owner said so out of band; no observation captured".into(),
        },
    }
}

/// One valid instance of EVERY M22-defined body (and every Observation
/// payload / registration variant), as `(kind, body)` pairs. The reserved
/// M24 kinds are deliberately absent — they have no bodies to instantiate.
pub(crate) fn all_bodies() -> Vec<EventBody> {
    let mut bodies: Vec<EventBody> = Vec::new();

    let (schema, actor) = common(ACTOR_LEDGER);
    bodies.push(EventBody::BatchCommitted(Box::new(BatchCommitted {
        schema,
        batch_id: Some("beefbeefbeefbeefbeefbeefbeefbeef".into()),
        idempotency_key: Some("op-key-1".into()),
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        member_event_ids: vec![ID_A.into(), ID_B.into()],
        member_count: 2,
        members_digest: crate::ledger::sha256_hex(b"members"),
        operation_digest: crate::ledger::sha256_hex(b"plan"),
    })));

    for kind in [
        "human_actor",
        "connector",
        "builtin",
        "cerebro_runtime",
        "legacy_reference",
    ] {
        bodies.push(EventBody::SourceRegistered(Box::new(registered(kind))));
    }

    for kind in [
        ObservationKind::SourceSnapshot,
        ObservationKind::SystemEvent,
        ObservationKind::ExtractedAssertion,
        ObservationKind::DerivedContent,
        ObservationKind::HumanAssertion,
    ] {
        bodies.push(EventBody::ObservationRecorded(Box::new(
            observation_recorded(kind),
        )));
    }

    let (schema, actor) = common("agent:resolver");
    bodies.push(EventBody::SubjectResolved(Box::new(SubjectResolved {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        observation_event_id: ID_A.into(),
        change: ResolutionChange::Attach {
            entity_id: ID_B.into(),
            resolver_tier: ResolverTier::KnownAlias,
            basis_event_ids: vec![ID_C.into()],
        },
    })));

    let (schema, actor) = common("system:prefilter");
    bodies.push(EventBody::IndependenceRecorded(Box::new(
        IndependenceRecorded {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            left_observation_event_id: ID_A.into(),
            right_observation_event_id: ID_B.into(),
            proof: IndependenceProof::DistinctFirsthandOrigin {
                left_source_registration_event_id: ID_C.into(),
                right_source_registration_event_id: ID_D.into(),
                rule_version: "prefilter-v1".into(),
            },
            reason: "distinct registered human reporters".into(),
        },
    )));

    bodies.push(EventBody::BeliefCreated(Box::new(belief_created())));
    bodies.push(EventBody::BeliefRevised(Box::new(belief_revised())));

    let (schema, actor) = common("agent:run-1");
    bodies.push(EventBody::BeliefRelation(Box::new(BeliefRelation {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        relation_id: derive_relation_id(ID_A, ID_B, RelationKind::Refines),
        action: RelationAction::Add,
        from: ID_A.into(),
        to: ID_B.into(),
        relation: RelationKind::Refines,
    })));

    let (schema, actor) = common("human:josef");
    bodies.push(EventBody::BeliefAttested(Box::new(BeliefAttested {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: ID_A.into(),
        attested_belief_revision_event_id: ID_C.into(),
        attested_content_hash: belief::attested_content_hash(b"# Acme\n"),
    })));

    let (schema, actor) = common("human:josef");
    bodies.push(EventBody::EntityAliasAdded(Box::new(EntityAliasAdded {
        schema,
        batch_id: None,
        idempotency_key: None,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        entity_id: ID_B.into(),
        alias: "Acme  Corp".into(),
        normalized_alias: "acme corp".into(),
    })));

    let digest = crate::ledger::sha256_hex(b"corpus");
    let (schema, actor) = common(ACTOR_MIGRATOR);
    bodies.push(EventBody::MigrationStarted(Box::new(MigrationStarted {
        schema,
        batch_id: None,
        idempotency_key: Some(format!("migrate-v1:{STORE}:started")),
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        store_uuid: STORE.into(),
        migration_schema: migration::MIGRATION_SCHEMA,
        source_digest: digest.clone(),
        planned_output_count: 12,
    })));

    let (schema, actor) = common(ACTOR_MIGRATOR);
    bodies.push(EventBody::MigrationCompleted(Box::new(
        MigrationCompleted {
            schema,
            batch_id: None,
            idempotency_key: Some(format!("migrate-v1:{STORE}:completed")),
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            store_uuid: STORE.into(),
            migration_schema: migration::MIGRATION_SCHEMA,
            source_digest: digest,
            output_count: 12,
            output_keys_digest: crate::ledger::sha256_hex(b"keys"),
        },
    )));

    bodies
}

#[test]
fn every_variant_encodes_decodes_and_re_encodes_byte_identically() {
    let bodies = all_bodies();
    assert_eq!(
        bodies
            .iter()
            .map(EventBody::kind)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        12,
        "all twelve M22 kinds are exercised"
    );
    for body in bodies {
        let value = body.to_value().unwrap();
        let first = serde_json::to_string(&value).unwrap();
        let decoded = decode_body(body.kind(), &value)
            .unwrap_or_else(|e| panic!("{}: {e}", body.kind()))
            .expect("schema-v1 body decodes as Some");
        assert_eq!(decoded, body, "{}", body.kind());
        let second = serde_json::to_string(&decoded.to_value().unwrap()).unwrap();
        assert_eq!(first, second, "{}: canonical bytes drifted", body.kind());
        decoded
            .validate(STORE)
            .unwrap_or_else(|e| panic!("{}: {e}", body.kind()));
    }
}

#[test]
fn a_schema_v1_frame_keeps_envelope_v0() {
    // The tripwire the plan names: an accidental envelope bump fails here.
    let body = observation_recorded(ObservationKind::SourceSnapshot);
    let frame = crate::ledger::frame::tests::fixture(
        1,
        "anchor",
        KIND_OBSERVATION_RECORDED,
        serde_json::to_value(&body).unwrap(),
    );
    assert_eq!(crate::ledger::frame::FRAME_VERSION, 0);
    let line = frame.to_line().unwrap();
    assert!(line.starts_with("{\"v\":0,"), "{line}");
    assert!(line.contains("\"body\":{\"schema\":1,"), "{line}");
    let back = crate::ledger::frame::Frame::from_line(&line).unwrap();
    let decoded = decode_body(&back.kind, &back.body).unwrap().unwrap();
    assert_eq!(decoded, EventBody::ObservationRecorded(Box::new(body)));
}

#[test]
fn plumbing_bodies_stay_plumbing() {
    // No schema key, non-object bodies: valid, indexable, no entity state.
    assert_eq!(
        decode_body("vault.write", &serde_json::json!({ "path": "a.md" })).unwrap(),
        None
    );
    assert_eq!(
        decode_body("vault.write", &serde_json::json!(7)).unwrap(),
        None
    );
    // But a body CLAIMING schema membership must survive the gate.
    assert!(decode_body("vault.write", &serde_json::json!({ "schema": 1 })).is_err());
}

#[test]
fn reserved_kinds_and_unknown_schemas_are_refused() {
    for kind in RESERVED_KINDS {
        let err = decode_body(kind, &serde_json::json!({ "schema": 1 })).unwrap_err();
        assert!(err.contains("reserved"), "{kind}: {err}");
    }
    let err = decode_body(KIND_BELIEF_CREATED, &serde_json::json!({ "schema": 2 })).unwrap_err();
    assert!(err.contains("unsupported body schema"), "{err}");
}

#[test]
fn unknown_and_reordered_fields_fail_the_canonical_gate() {
    let body = belief_created();
    let mut value = serde_json::to_value(&body).unwrap();

    // An extra field at body level: refused (deny_unknown_fields).
    let object = value.as_object_mut().unwrap();
    object.insert("version".into(), serde_json::json!(9));
    assert!(decode_body(KIND_BELIEF_CREATED, &value).is_err());

    // The same fields in a different order: parses, but re-serializes to
    // different bytes — refused by the gate.
    let canonical = serde_json::to_value(&body).unwrap();
    let mut reordered = serde_json::Map::new();
    for key in canonical.as_object().unwrap().keys().rev() {
        reordered.insert(key.clone(), canonical[key].clone());
    }
    let err = decode_body(KIND_BELIEF_CREATED, &serde_json::Value::Object(reordered)).unwrap_err();
    assert!(err.contains("canonical"), "{err}");
}

#[test]
fn payload_smuggling_is_caught_at_validate_time() {
    // The wrapper keeps payload as raw JSON, so decode passes — the payload
    // gate in validate() is what refuses the smuggled field.
    let mut body = observation_recorded(ObservationKind::SourceSnapshot);
    let mut payload = body.payload.as_object().unwrap().clone();
    payload.insert("assertion_kind".into(), serde_json::json!("presence"));
    body.payload = serde_json::Value::Object(payload);
    let value = serde_json::to_value(&body).unwrap();
    let decoded = decode_body(KIND_OBSERVATION_RECORDED, &value)
        .unwrap()
        .unwrap();
    let err = decoded.validate(STORE).unwrap_err();
    assert!(
        err.contains("unknown field") || err.contains("canonical"),
        "{err}"
    );
}

#[test]
fn a_kind_outside_the_vocabulary_cannot_claim_schema_membership() {
    let err = decode_body("belief.merged", &serde_json::json!({ "schema": 1 })).unwrap_err();
    assert!(err.contains("vocabulary"), "{err}");
}
