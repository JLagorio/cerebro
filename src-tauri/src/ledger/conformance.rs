//! Conformance-vector generation (M22.4) — THE parity mechanism.
//!
//! Rust is the reference implementation: these tests build deterministic
//! event sequences, reduce them, and pin `{ events, expected_state,
//! expected_refusals }` into root `conformance/*.json`. The committed bytes
//! must match regeneration exactly (run with `UPDATE_CONFORMANCE=1` to
//! rewrite after an intentional semantic change). The minimal TS reducer in
//! `src/lib/epistemic/` replays the same files; no schema-v1 rule gets a
//! second hand-written implementation in mockIpc.
//!
//! Refusal identity across implementations is `(seq, event_id, batch_id,
//! code)`; `detail` is prose for humans.

use super::frame::{Frame, FRAME_VERSION};
use super::reduce::{reduce, vector_state};
use super::schema::{self, *};

const STORE: &str = "feedfacefeedfacefeedfacefeedface";
const STAMP: &str = "2026-08-07T12:00:00.000Z";

const ENTITY: &str = "cccccccccccccccccccccccccccccccc";
const ENTITY_B: &str = "dddddddddddddddddddddddddddddddd";
const BELIEF: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const BELIEF_B: &str = "ffffffffffffffffffffffffffffffff";

/// Deterministic frame builder: sequential ids, fixed clock, real chain.
struct Builder {
    frames: Vec<Frame>,
    prev: String,
}

impl Builder {
    fn new() -> Builder {
        Builder {
            frames: Vec::new(),
            prev: STORE.to_string(),
        }
    }

    fn push(&mut self, kind: &str, body: serde_json::Value) -> String {
        let seq = self.frames.len() as u64 + 1;
        let event_id = format!("{seq:032x}");
        let frame = Frame {
            v: FRAME_VERSION,
            seq,
            event_id: event_id.clone(),
            prev: self.prev.clone(),
            hash: String::new(),
            ingested_at: STAMP.to_string(),
            wall_clock_anomaly: false,
            kind: kind.to_string(),
            body,
        }
        .with_hash()
        .unwrap();
        self.prev = frame.hash.clone();
        self.frames.push(frame);
        event_id
    }

    fn push_body<T: serde::Serialize>(&mut self, kind: &str, body: &T) -> String {
        self.push(kind, serde_json::to_value(body).unwrap())
    }

    /// Append a stamped batch: bodies must already carry cross-references;
    /// this stamps batch_id/keys, appends members, then a marker built the
    /// way the writer builds it (or broken, when `sabotage` says so).
    fn push_batch(
        &mut self,
        batch_id: &str,
        members: Vec<(String, serde_json::Value)>,
        with_marker: bool,
        sabotage: Option<&str>,
    ) -> Vec<String> {
        let mut ids = Vec::new();
        let start = self.frames.len();
        for (kind, mut body) in members {
            body["batch_id"] = serde_json::json!(batch_id);
            ids.push(self.push(&kind, body));
        }
        if !with_marker {
            return ids;
        }
        let member_frames: Vec<Frame> = self.frames[start..].to_vec();
        let mut member_event_ids = ids.clone();
        let mut digest = super::members_digest(member_frames.iter()).unwrap();
        match sabotage {
            Some("order") => member_event_ids.reverse(),
            Some("count") => {
                member_event_ids.pop();
            }
            Some("digest") => digest = "0".repeat(64),
            _ => {}
        }
        let marker = BatchCommitted {
            schema: BODY_SCHEMA,
            batch_id: Some(batch_id.to_string()),
            idempotency_key: None,
            actor: Actor {
                id: ACTOR_LEDGER.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            member_count: member_event_ids.len() as u64,
            member_event_ids,
            members_digest: digest,
            operation_digest: crate::ledger::sha256_hex(b"conformance-plan"),
        };
        self.push_body(KIND_BATCH_COMMITTED, &marker);
        ids
    }
}

fn common(actor: &str) -> (u64, Option<String>, Option<String>, Actor) {
    (
        BODY_SCHEMA,
        None,
        None,
        Actor {
            id: actor.to_string(),
        },
    )
}

fn registration_body(registration: SourceRegistration) -> SourceRegistered {
    let mut registration = registration;
    let key = registration.derived_source_key().unwrap();
    match &mut registration {
        SourceRegistration::HumanActor { source_key, .. }
        | SourceRegistration::Connector { source_key, .. }
        | SourceRegistration::Builtin { source_key, .. }
        | SourceRegistration::CerebroRuntime { source_key, .. }
        | SourceRegistration::LegacyReference { source_key, .. } => *source_key = key.clone(),
    }
    let (schema, batch_id, idempotency_key, actor) = common(ACTOR_SOURCE_REGISTRY);
    SourceRegistered {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        source_id: derive_source_id(STORE, &key),
        registration,
    }
}

fn human_registration(actor_id: &str) -> SourceRegistered {
    registration_body(SourceRegistration::HumanActor {
        source_key: String::new(),
        actor_id: actor_id.to_string(),
        authority_capability: AuthorityCapability::HumanAssertion,
        independence_domain_id: None,
    })
}

fn direct_registration(instance: &str, domain: &str) -> SourceRegistered {
    registration_body(SourceRegistration::Connector {
        source_key: String::new(),
        connector_instance_id: instance.to_string(),
        logical_scope_id: "scope".to_string(),
        authority_capability: AuthorityCapability::DirectSystemArtifact,
        independence_domain_id: Some(domain.to_string()),
    })
}

fn content_registration(service: &str) -> SourceRegistered {
    registration_body(SourceRegistration::Builtin {
        source_key: String::new(),
        service_id: service.to_string(),
        authority_capability: AuthorityCapability::ContentOnly,
        independence_domain_id: None,
    })
}

fn assertion(authority: AuthorityProvenance, basis: AssertionBasis) -> AssertionFields {
    AssertionFields {
        assertion_kind: AssertionKind::Presence,
        predicate: "status".into(),
        value: TypedValue::string("active"),
        scope: Scope::empty(),
        relationship_to_subject: RelationshipToSubject {
            role: SubjectRole::Unknown,
        },
        assertion_basis: basis,
        authority_provenance: authority,
        absence: None,
    }
}

fn observation_body(
    kind: ObservationKind,
    source: &SourceRegistered,
    registration_event: &str,
    actor: &str,
    subject: SubjectRef,
    lineage: Vec<LineageEdge>,
    payload: serde_json::Value,
) -> ObservationRecorded {
    let (schema, batch_id, idempotency_key, actor) = common(actor);
    ObservationRecorded {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        observation_kind: kind,
        source_id: source.source_id.clone(),
        source_registration_event_id: registration_event.to_string(),
        subject,
        lineage,
        provenance: Provenance::empty(),
        payload,
    }
}

fn snapshot_payload() -> serde_json::Value {
    serde_json::to_value(SourceSnapshotPayload {
        source_artifact_hash: None,
        raw_pointer: "docs/a.md".into(),
    })
    .unwrap()
}

fn human_payload(basis: AssertionBasis) -> serde_json::Value {
    serde_json::to_value(HumanAssertionPayload {
        assertion: assertion(AuthorityProvenance::TrustedHumanCapture, basis),
        form: HumanAssertionForm::Standalone {
            intended_belief_id: None,
            corrects: None,
            reason: None,
        },
    })
    .unwrap()
}

fn extraction_payload(authority: AuthorityProvenance) -> serde_json::Value {
    serde_json::to_value(ExtractedAssertionPayload {
        assertion: assertion(authority, AssertionBasis::Reported),
        extracted_text: "status is active".into(),
        source_artifact_hash: "a".repeat(64),
        extractor_version: "x1".into(),
        raw_pointer: "mail/1".into(),
    })
    .unwrap()
}

fn derived_payload(sources: Option<Vec<String>>) -> serde_json::Value {
    serde_json::to_value(DerivedContentPayload {
        assertion: assertion(AuthorityProvenance::AgentInferred, AssertionBasis::Inferred),
        rendered_text: "Acme is active.".into(),
        generator_version: "g1".into(),
        source_belief_revision_event_ids: sources,
    })
    .unwrap()
}

fn belief_body(belief_id: &str, entity_id: &str, basis: BeliefBasis) -> BeliefCreated {
    let (schema, batch_id, idempotency_key, actor) = common("agent:run-1");
    BeliefCreated {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.into(),
        subject: SubjectRef::Resolved {
            entity_id: entity_id.into(),
            aliases: vec!["Acme Corp".into()],
        },
        content: "# Acme\n\nActive vendor.\n".into(),
        fields: serde_json::json!({ "status": "active" }),
        basis,
    }
}

fn unsupported() -> BeliefBasis {
    BeliefBasis::Unsupported {
        reason: "conformance fixture without observations".into(),
    }
}

fn resolve_body(observation_event_id: &str, change: ResolutionChange) -> SubjectResolved {
    let (schema, batch_id, idempotency_key, actor) = common("agent:resolver");
    SubjectResolved {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        observation_event_id: observation_event_id.into(),
        change,
    }
}

fn alias_body(entity_id: &str, alias: &str) -> EntityAliasAdded {
    let (schema, batch_id, idempotency_key, actor) = common("human:josef");
    EntityAliasAdded {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        entity_id: entity_id.into(),
        alias: alias.into(),
        normalized_alias: normalize_alias_v1(alias),
    }
}

fn revised_body(belief_id: &str, patch: Vec<PatchOp>, basis: BeliefBasis) -> BeliefRevised {
    let (schema, batch_id, idempotency_key, actor) = common("agent:run-1");
    BeliefRevised {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.into(),
        patch,
        basis,
    }
}

fn relation_body(
    from: &str,
    to: &str,
    relation: RelationKind,
    action: RelationAction,
) -> BeliefRelation {
    let (schema, batch_id, idempotency_key, actor) = common("agent:run-1");
    BeliefRelation {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        relation_id: derive_relation_id(from, to, relation),
        action,
        from: from.into(),
        to: to.into(),
        relation,
    }
}

fn independence_body(left: &str, right: &str, proof: IndependenceProof) -> IndependenceRecorded {
    let (schema, batch_id, idempotency_key, actor) = common("system:prefilter");
    IndependenceRecorded {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        left_observation_event_id: left.into(),
        right_observation_event_id: right.into(),
        proof,
        reason: "conformance proof".into(),
    }
}

// --- Scenarios -------------------------------------------------------------

fn scenario_sources() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    b.push_body(KIND_SOURCE_REGISTERED, &human_registration("human:josef"));
    b.push_body(
        KIND_SOURCE_REGISTERED,
        &direct_registration("conn-1", "domain-github"),
    );
    b.push_body(KIND_SOURCE_REGISTERED, &content_registration("svc.mail"));
    b.push_body(
        KIND_SOURCE_REGISTERED,
        &registration_body(SourceRegistration::CerebroRuntime {
            source_key: String::new(),
            service_id: "distiller".into(),
            authority_capability: AuthorityCapability::ContentOnly,
            independence_domain_id: None,
        }),
    );
    b.push_body(
        KIND_SOURCE_REGISTERED,
        &registration_body(SourceRegistration::LegacyReference {
            source_key: String::new(),
            resource: "/records/decisions/dec-1.md".into(),
            authority_capability: AuthorityCapability::ContentOnly,
            independence_domain_id: None,
        }),
    );
    // Duplicate re-registration: refused.
    b.push_body(KIND_SOURCE_REGISTERED, &human_registration("human:josef"));
    // Forged source id (right shape, wrong derivation): structural refusal.
    let mut forged = human_registration("human:maya");
    forged.source_id = "0123456789abcdef0123456789abcdef".into();
    b.push_body(KIND_SOURCE_REGISTERED, &forged);
    // Forged actor: only the registry appends registrations.
    let mut alien = human_registration("human:dana");
    alien.actor.id = "agent:sneaky".into();
    b.push_body(KIND_SOURCE_REGISTERED, &alien);
    (
        "sources",
        "Every registration variant registers once; duplicates, forged ids, and forged actors \
         are refused.",
        b.frames,
    )
}

fn scenario_observations() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let human = human_registration("human:josef");
    let direct = direct_registration("conn-1", "domain-github");
    let content = content_registration("svc.mail");
    let human_reg = b.push_body(KIND_SOURCE_REGISTERED, &human);
    let direct_reg = b.push_body(KIND_SOURCE_REGISTERED, &direct);
    let content_reg = b.push_body(KIND_SOURCE_REGISTERED, &content);

    // Snapshot and system event carry no subject.
    let snapshot = observation_body(
        ObservationKind::SourceSnapshot,
        &direct,
        &direct_reg,
        "agent:run-1",
        SubjectRef::None,
        vec![],
        snapshot_payload(),
    );
    let snapshot_id = b.push_body(KIND_OBSERVATION_RECORDED, &snapshot);
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::SystemEvent,
            &content,
            &content_reg,
            "system:watcher",
            SubjectRef::None,
            vec![],
            serde_json::to_value(SystemEventPayload {
                event_type: "scan.completed".into(),
                detail: TypedValue::Number {
                    value: serde_json::Number::from(42),
                },
            })
            .unwrap(),
        ),
    );
    // A resolved-subject extraction first-registers its Entity.
    let lineage = vec![LineageEdge {
        edge: LineageKind::DerivedFrom,
        parent_observation_event_id: snapshot_id.clone(),
    }];
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::ExtractedAssertion,
            &direct,
            &direct_reg,
            "agent:run-1",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec!["Acme".into()],
            },
            lineage.clone(),
            extraction_payload(AuthorityProvenance::RegisteredDirectArtifact),
        ),
    );
    // An UNRESOLVED assertion is accepted and indexed unresolved.
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &human,
            &human_reg,
            "human:josef",
            SubjectRef::Unresolved {
                raw_ref: "Acme Corp".into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Firsthand),
        ),
    );
    // A subject-none assertion is refused (structural, at reduce).
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &human,
            &human_reg,
            "human:josef",
            SubjectRef::None,
            vec![],
            human_payload(AssertionBasis::Firsthand),
        ),
    );
    // A registration pin naming a non-registration event.
    let mut bad_pin = snapshot.clone();
    bad_pin.source_registration_event_id = snapshot_id.clone();
    b.push_body(KIND_OBSERVATION_RECORDED, &bad_pin);
    // Content-only upgraded to direct authority: refused.
    let mut upgraded = observation_body(
        ObservationKind::ExtractedAssertion,
        &content,
        &content_reg,
        "agent:run-1",
        SubjectRef::Resolved {
            entity_id: ENTITY.into(),
            aliases: vec![],
        },
        lineage.clone(),
        extraction_payload(AuthorityProvenance::RegisteredDirectArtifact),
    );
    b.push_body(KIND_OBSERVATION_RECORDED, &upgraded);
    // Direct-artifact content downgraded: refused (derivation is exact).
    upgraded.source_id = direct.source_id.clone();
    upgraded.source_registration_event_id = direct_reg.clone();
    upgraded.payload = extraction_payload(AuthorityProvenance::AgentInferred);
    b.push_body(KIND_OBSERVATION_RECORDED, &upgraded);
    // Wrong actor claiming trusted human capture: refused.
    let mut forged = observation_body(
        ObservationKind::HumanAssertion,
        &human,
        &human_reg,
        "agent:sneaky",
        SubjectRef::Resolved {
            entity_id: ENTITY.into(),
            aliases: vec![],
        },
        vec![],
        human_payload(AssertionBasis::Firsthand),
    );
    b.push_body(KIND_OBSERVATION_RECORDED, &forged);
    forged.observation_kind = ObservationKind::SourceSnapshot;
    (
        "observations",
        "All five payload kinds; subject boundaries; registration pins; authority derived from \
         registration with no caller upgrade or downgrade.",
        b.frames,
    )
}

fn scenario_lineage() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let direct = direct_registration("conn-1", "domain-github");
    let direct_reg = b.push_body(KIND_SOURCE_REGISTERED, &direct);
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec![],
    };
    let snap = |b: &mut Builder| {
        b.push_body(
            KIND_OBSERVATION_RECORDED,
            &observation_body(
                ObservationKind::SourceSnapshot,
                &direct,
                &direct_reg,
                "agent:run-1",
                SubjectRef::None,
                vec![],
                snapshot_payload(),
            ),
        )
    };
    let parent_a = snap(&mut b);
    let parent_b = snap(&mut b);
    // Every edge kind, ascending parent order.
    let edges = vec![
        LineageEdge {
            edge: LineageKind::ReportedBy,
            parent_observation_event_id: parent_a.clone(),
        },
        LineageEdge {
            edge: LineageKind::SummarizedFrom,
            parent_observation_event_id: parent_b.clone(),
        },
    ];
    let extraction = |lineage: Vec<LineageEdge>| {
        observation_body(
            ObservationKind::ExtractedAssertion,
            &direct,
            &direct_reg,
            "agent:run-1",
            subject.clone(),
            lineage,
            extraction_payload(AuthorityProvenance::RegisteredDirectArtifact),
        )
    };
    let mid = b.push_body(KIND_OBSERVATION_RECORDED, &extraction(edges.clone()));
    // derived_from + copied_from edges through the extraction.
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::DerivedContent,
            &direct,
            &direct_reg,
            "agent:run-1",
            subject.clone(),
            vec![
                LineageEdge {
                    edge: LineageKind::CopiedFrom,
                    parent_observation_event_id: parent_a.clone(),
                },
                LineageEdge {
                    edge: LineageKind::DerivedFrom,
                    parent_observation_event_id: mid.clone(),
                },
            ],
            derived_payload(None),
        ),
    );
    // Descending parent order: refused.
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &extraction(vec![
            LineageEdge {
                edge: LineageKind::ReportedBy,
                parent_observation_event_id: parent_b.clone(),
            },
            LineageEdge {
                edge: LineageKind::ReportedBy,
                parent_observation_event_id: parent_a.clone(),
            },
        ]),
    );
    // A parent that is no Observation.
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &extraction(vec![LineageEdge {
            edge: LineageKind::ReportedBy,
            parent_observation_event_id: direct_reg.clone(),
        }]),
    );
    // Extraction with no lineage: a fabrication (structural).
    b.push_body(KIND_OBSERVATION_RECORDED, &extraction(vec![]));
    (
        "lineage",
        "Every edge kind in canonical order; descending order, non-Observation parents, and \
         parentless extractions are refused.",
        b.frames,
    )
}

fn scenario_beliefs() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let human = human_registration("human:josef");
    let human_reg = b.push_body(KIND_SOURCE_REGISTERED, &human);
    let observation = observation_body(
        ObservationKind::HumanAssertion,
        &human,
        &human_reg,
        "human:josef",
        SubjectRef::Resolved {
            entity_id: ENTITY.into(),
            aliases: vec![],
        },
        vec![],
        human_payload(AssertionBasis::Firsthand),
    );
    let obs_id = b.push_body(KIND_OBSERVATION_RECORDED, &observation);
    let snapshot = observation_body(
        ObservationKind::SourceSnapshot,
        &human,
        &human_reg,
        "agent:run-1",
        SubjectRef::None,
        vec![],
        snapshot_payload(),
    );
    let snapshot_id = b.push_body(KIND_OBSERVATION_RECORDED, &snapshot);

    // Linked creation: supports→assertion plus context→snapshot.
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(
            BELIEF,
            ENTITY,
            BeliefBasis::Linked {
                links: vec![
                    BasisLink {
                        observation_event_id: obs_id.clone(),
                        role: BasisRole::Supports,
                    },
                    BasisLink {
                        observation_event_id: snapshot_id.clone(),
                        role: BasisRole::Context,
                    },
                ],
            },
        ),
    );
    // Duplicate belief id: refused.
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    // supports → snapshot: refused.
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(
            BELIEF_B,
            ENTITY_B,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: snapshot_id.clone(),
                    role: BasisRole::Supports,
                }],
            },
        ),
    );
    // basis → a non-Observation event (the creation itself): refused.
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(
            BELIEF_B,
            ENTITY_B,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: created.clone(),
                    role: BasisRole::Context,
                }],
            },
        ),
    );
    // A valid revision; then a stale one; then a total no-op; then a
    // support-only (empty patch, basis change to unsupported).
    let patch = vec![PatchOp {
        field_path: "/fields/status".into(),
        before: TypedValue::string("active"),
        after: TypedValue::string("paused"),
    }];
    let linked = BeliefBasis::Linked {
        links: vec![BasisLink {
            observation_event_id: obs_id.clone(),
            role: BasisRole::Supports,
        }],
    };
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body(BELIEF, patch.clone(), linked.clone()),
    );
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body(BELIEF, patch, linked.clone()),
    );
    b.push_body(KIND_BELIEF_REVISED, &revised_body(BELIEF, vec![], linked));
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body(BELIEF, vec![], unsupported()),
    );
    // Remove the field via Missing, and edit the body.
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body(
            BELIEF,
            vec![
                PatchOp {
                    field_path: "/fields/status".into(),
                    before: TypedValue::string("paused"),
                    after: TypedValue::Missing,
                },
                PatchOp {
                    field_path: "/body".into(),
                    before: TypedValue::string("# Acme\n\nActive vendor.\n"),
                    after: TypedValue::string("# Acme\n\nPaused vendor.\n"),
                },
            ],
            unsupported(),
        ),
    );
    // Revising a belief that does not exist.
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body("9999999999999999999999999999999a", vec![], unsupported()),
    );
    (
        "beliefs",
        "Creation with linked/unsupported basis; duplicate ids, wrong basis roles, and \
         non-Observation evidence refused; patches match prior state or die; support-only \
         revisions change the basis alone; total no-ops are refused.",
        b.frames,
    )
}

fn scenario_resolution() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let human = human_registration("human:josef");
    let human_reg = b.push_body(KIND_SOURCE_REGISTERED, &human);
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );
    let alias_event = b.push_body(KIND_ENTITY_ALIAS_ADDED, &alias_body(ENTITY, "Acme Corp"));
    let unresolved = |raw: &str, b: &mut Builder| {
        b.push_body(
            KIND_OBSERVATION_RECORDED,
            &observation_body(
                ObservationKind::HumanAssertion,
                &human,
                &human_reg,
                "human:josef",
                SubjectRef::Unresolved {
                    raw_ref: raw.into(),
                    aliases: vec![],
                },
                vec![],
                human_payload(AssertionBasis::Reported),
            ),
        )
    };
    let obs_alias = unresolved("ACME corp", &mut b);
    let obs_exact = unresolved(ENTITY, &mut b);
    let obs_norm = unresolved("acme  CORP", &mut b);
    let obs_relation = unresolved("whatever mention", &mut b);

    // known_alias attach — wrong entity refused, right one applies.
    b.push_body(
        KIND_SUBJECT_RESOLVED,
        &resolve_body(
            &obs_alias,
            ResolutionChange::Attach {
                entity_id: ENTITY_B.into(),
                resolver_tier: ResolverTier::KnownAlias,
                basis_event_ids: vec![alias_event.clone()],
            },
        ),
    );
    let attach = resolve_body(
        &obs_alias,
        ResolutionChange::Attach {
            entity_id: ENTITY.into(),
            resolver_tier: ResolverTier::KnownAlias,
            basis_event_ids: vec![alias_event.clone()],
        },
    );
    let attach_event = b.push_body(KIND_SUBJECT_RESOLVED, &attach);
    // Conflicting second attach.
    b.push_body(KIND_SUBJECT_RESOLVED, &attach);
    // exact_id attach: raw_ref equals the entity id, empty basis.
    b.push_body(
        KIND_SUBJECT_RESOLVED,
        &resolve_body(
            &obs_exact,
            ResolutionChange::Attach {
                entity_id: ENTITY.into(),
                resolver_tier: ResolverTier::ExactId,
                basis_event_ids: vec![],
            },
        ),
    );
    // normalized_match: the belief.created preserved alias "Acme Corp".
    b.push_body(
        KIND_SUBJECT_RESOLVED,
        &resolve_body(
            &obs_norm,
            ResolutionChange::Attach {
                entity_id: ENTITY.into(),
                resolver_tier: ResolverTier::NormalizedMatch,
                basis_event_ids: vec!["00000000000000000000000000000002".into()],
            },
        ),
    );
    // explicit_relation: a live relation whose to-Belief subject is B.
    let relation_add = b.push_body(
        KIND_BELIEF_RELATION,
        &relation_body(BELIEF, BELIEF_B, RelationKind::Refines, RelationAction::Add),
    );
    b.push_body(
        KIND_SUBJECT_RESOLVED,
        &resolve_body(
            &obs_relation,
            ResolutionChange::Attach {
                entity_id: ENTITY_B.into(),
                resolver_tier: ResolverTier::ExplicitRelation,
                basis_event_ids: vec![relation_add.clone()],
            },
        ),
    );
    // Correction: exact_id proof over B's registering event.
    let correct = resolve_body(
        &obs_alias,
        ResolutionChange::Correct {
            prior_resolution_event_id: attach_event.clone(),
            from_entity_id: ENTITY.into(),
            to_entity_id: ENTITY_B.into(),
            resolver_tier: ResolverTier::ExactId,
            basis_event_ids: vec!["00000000000000000000000000000003".into()],
            reason: "the mention names the subsidiary".into(),
        },
    );
    b.push_body(KIND_SUBJECT_RESOLVED, &correct);
    // Stale prior (pins the superseded attach) and correction-before-attach.
    b.push_body(KIND_SUBJECT_RESOLVED, &correct);
    let fresh = unresolved("never attached", &mut b);
    b.push_body(
        KIND_SUBJECT_RESOLVED,
        &resolve_body(
            &fresh,
            ResolutionChange::Correct {
                prior_resolution_event_id: attach_event.clone(),
                from_entity_id: ENTITY.into(),
                to_entity_id: ENTITY_B.into(),
                resolver_tier: ResolverTier::ExactId,
                basis_event_ids: vec!["00000000000000000000000000000003".into()],
                reason: "nothing to correct".into(),
            },
        ),
    );
    (
        "resolution",
        "All four tier proofs attach; corrections pin the current prior and preserve history; \
         wrong-entity proofs, conflicting attaches, stale priors, and correction-before-attach \
         are refused.",
        b.frames,
    )
}

fn scenario_relations() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );
    let rel = |action| relation_body(BELIEF, BELIEF_B, RelationKind::Supersedes, action);
    b.push_body(KIND_BELIEF_RELATION, &rel(RelationAction::Add));
    b.push_body(KIND_BELIEF_RELATION, &rel(RelationAction::Add));
    b.push_body(KIND_BELIEF_RELATION, &rel(RelationAction::Remove));
    b.push_body(KIND_BELIEF_RELATION, &rel(RelationAction::Remove));
    b.push_body(KIND_BELIEF_RELATION, &rel(RelationAction::Add));
    b.push_body(
        KIND_BELIEF_RELATION,
        &relation_body(
            BELIEF,
            "9999999999999999999999999999999a",
            RelationKind::Contradicts,
            RelationAction::Add,
        ),
    );
    (
        "relations",
        "Add, duplicate add, remove, dead remove, re-add — versions 1..3 — and a ghost endpoint \
         refusal.",
        b.frames,
    )
}

fn scenario_attestation() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    let projected = super::project::project(
        "# Acme\n\nActive vendor.\n",
        &serde_json::json!({ "status": "active" }),
    );
    let good = schema::belief::attested_content_hash(projected.as_bytes());
    let attest = |hash: &str, revision_event: &str| {
        let (schema, batch_id, idempotency_key, actor) = common("human:josef");
        BeliefAttested {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            attested_belief_revision_event_id: revision_event.into(),
            attested_content_hash: hash.into(),
        }
    };
    // Wrong hash first, then the exact pair.
    b.push_body(KIND_BELIEF_ATTESTED, &attest(&"0".repeat(64), &created));
    b.push_body(KIND_BELIEF_ATTESTED, &attest(&good, &created));
    // A revision event that belongs to another Belief.
    let other = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );
    b.push_body(KIND_BELIEF_ATTESTED, &attest(&good, &other));
    // A non-revision event.
    b.push_body(
        KIND_BELIEF_ATTESTED,
        &attest(&good, "0123456789abcdef0123456789abcdef"),
    );
    (
        "attestation",
        "The id/hash pair must name one committed revision of the named Belief, hashed over its \
         byte-stable projection.",
        b.frames,
    )
}

fn scenario_aliases() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );
    b.push_body(KIND_ENTITY_ALIAS_ADDED, &alias_body(ENTITY, "Acme  Corp"));
    b.push_body(KIND_ENTITY_ALIAS_ADDED, &alias_body(ENTITY_B, "ACME CORP"));
    b.push_body(KIND_ENTITY_ALIAS_ADDED, &alias_body(ENTITY, "Acme Corp"));
    b.push_body(
        KIND_ENTITY_ALIAS_ADDED,
        &alias_body("1111111111111111111111111111111a", "Other"),
    );
    (
        "aliases",
        "Display bytes are preserved, the normalized key is the uniqueness domain, and an alias \
         never moves or re-registers.",
        b.frames,
    )
}

fn scenario_independence() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let josef = human_registration("human:josef");
    let maya = human_registration("human:maya");
    let direct_a = direct_registration("conn-1", "domain-a");
    let direct_b = direct_registration("conn-2", "domain-b");
    let josef_reg = b.push_body(KIND_SOURCE_REGISTERED, &josef);
    let maya_reg = b.push_body(KIND_SOURCE_REGISTERED, &maya);
    let direct_a_reg = b.push_body(KIND_SOURCE_REGISTERED, &direct_a);
    let direct_b_reg = b.push_body(KIND_SOURCE_REGISTERED, &direct_b);
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec![],
    };
    let human_obs = |b: &mut Builder, source: &SourceRegistered, reg: &str, actor: &str| {
        b.push_body(
            KIND_OBSERVATION_RECORDED,
            &observation_body(
                ObservationKind::HumanAssertion,
                source,
                reg,
                actor,
                subject.clone(),
                vec![],
                human_payload(AssertionBasis::Firsthand),
            ),
        )
    };
    let left = human_obs(&mut b, &josef, &josef_reg, "human:josef");
    let right = human_obs(&mut b, &maya, &maya_reg, "human:maya");
    let firsthand = |l: &str, r: &str| IndependenceProof::DistinctFirsthandOrigin {
        left_source_registration_event_id: l.into(),
        right_source_registration_event_id: r.into(),
        rule_version: "prefilter-v1".into(),
    };
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(&left, &right, firsthand(&josef_reg, &maya_reg)),
    );
    // Duplicate pair; same actor; wrong registration refs.
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(&left, &right, firsthand(&josef_reg, &maya_reg)),
    );
    let left2 = human_obs(&mut b, &josef, &josef_reg, "human:josef");
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(&left, &left2, firsthand(&josef_reg, &josef_reg)),
    );
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(&left, &right, firsthand(&maya_reg, &josef_reg)),
    );
    // System artifacts: shared parent refuses; disjoint pair with distinct
    // domains records.
    let parent = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::SourceSnapshot,
            &direct_a,
            &direct_a_reg,
            "agent:run-1",
            SubjectRef::None,
            vec![],
            snapshot_payload(),
        ),
    );
    let extract =
        |b: &mut Builder, source: &SourceRegistered, reg: &str, lineage: Vec<LineageEdge>| {
            b.push_body(
                KIND_OBSERVATION_RECORDED,
                &observation_body(
                    ObservationKind::ExtractedAssertion,
                    source,
                    reg,
                    "agent:run-1",
                    subject.clone(),
                    lineage,
                    extraction_payload(AuthorityProvenance::RegisteredDirectArtifact),
                ),
            )
        };
    let shared_edge = vec![LineageEdge {
        edge: LineageKind::DerivedFrom,
        parent_observation_event_id: parent.clone(),
    }];
    let sib_a = extract(&mut b, &direct_a, &direct_a_reg, shared_edge.clone());
    let sib_b = extract(&mut b, &direct_b, &direct_b_reg, shared_edge);
    let artifact = |l: &str, r: &str| IndependenceProof::IndependentSystemArtifact {
        left_source_registration_event_id: l.into(),
        right_source_registration_event_id: r.into(),
        rule_version: "prefilter-v1".into(),
    };
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(&sib_a, &sib_b, artifact(&direct_a_reg, &direct_b_reg)),
    );
    let parent_b_snap = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::SourceSnapshot,
            &direct_b,
            &direct_b_reg,
            "agent:run-1",
            SubjectRef::None,
            vec![],
            snapshot_payload(),
        ),
    );
    let solo_b = extract(
        &mut b,
        &direct_b,
        &direct_b_reg,
        vec![LineageEdge {
            edge: LineageKind::DerivedFrom,
            parent_observation_event_id: parent_b_snap.clone(),
        }],
    );
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(&sib_a, &solo_b, artifact(&direct_a_reg, &direct_b_reg)),
    );
    // Same domain on both ends.
    let solo_a2 = extract(
        &mut b,
        &direct_a,
        &direct_a_reg,
        vec![LineageEdge {
            edge: LineageKind::DerivedFrom,
            parent_observation_event_id: parent.clone(),
        }],
    );
    let _ = solo_a2;
    // human_confirmed is reserved until M24.
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(
            &left,
            &right,
            IndependenceProof::HumanConfirmed {
                left_source_registration_event_id: josef_reg.clone(),
                right_source_registration_event_id: maya_reg.clone(),
                proposal_id: "1111111111111111111111111111111a".into(),
                decision_event_id: "1111111111111111111111111111111b".into(),
            },
        ),
    );
    (
        "independence",
        "Positive firsthand and direct-artifact proofs record the unordered pair; shared \
         ancestry, same actors, mismatched refs, duplicates, and the reserved human proof are \
         refused; absence of any fact stays unknown.",
        b.frames,
    )
}

fn scenario_batches() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let human = human_registration("human:josef");
    let human_reg = b.push_body(KIND_SOURCE_REGISTERED, &human);
    let member_obs = || {
        serde_json::to_value(observation_body(
            ObservationKind::HumanAssertion,
            &human_registration("human:josef"),
            "00000000000000000000000000000001",
            "human:josef",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Firsthand),
        ))
        .unwrap()
    };
    let _ = &human_reg;
    // A valid two-member batch with a same-batch basis link: member 1 links
    // member 0 by its (preallocated, here just known) event id.
    let obs_value = member_obs();
    let next_id = |b: &Builder, offset: u64| format!("{:032x}", b.frames.len() as u64 + offset);
    let member0_id = next_id(&b, 1);
    let belief_value = serde_json::to_value(belief_body(
        BELIEF,
        ENTITY,
        BeliefBasis::Linked {
            links: vec![BasisLink {
                observation_event_id: member0_id.clone(),
                role: BasisRole::Supports,
            }],
        },
    ))
    .unwrap();
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0001",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), obs_value.clone()),
            (KIND_BELIEF_CREATED.into(), belief_value),
        ],
        true,
        None,
    );
    // No marker: orphan.
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0002",
        vec![(KIND_OBSERVATION_RECORDED.into(), member_obs())],
        false,
        None,
    );
    // Wrong order, wrong count, wrong digest.
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0003",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), member_obs()),
            (KIND_OBSERVATION_RECORDED.into(), member_obs()),
        ],
        true,
        Some("order"),
    );
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0004",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), member_obs()),
            (KIND_OBSERVATION_RECORDED.into(), member_obs()),
        ],
        true,
        Some("count"),
    );
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0005",
        vec![(KIND_OBSERVATION_RECORDED.into(), member_obs())],
        true,
        Some("digest"),
    );
    // One reduce-invalid member (ghost belief revision) kills the batch.
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0006",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), member_obs()),
            (
                KIND_BELIEF_REVISED.into(),
                serde_json::to_value(revised_body(
                    "9999999999999999999999999999999a",
                    vec![],
                    unsupported(),
                ))
                .unwrap(),
            ),
        ],
        true,
        None,
    );
    // Interleaving: a plumbing frame between member and marker.
    let start = b.frames.len();
    let mut inter = member_obs();
    inter["batch_id"] = serde_json::json!("beefbeefbeefbeefbeefbeefbeef0007");
    b.push(KIND_OBSERVATION_RECORDED, inter);
    b.push("vault.write", serde_json::json!({ "path": "between.md" }));
    let member_frames: Vec<Frame> = vec![b.frames[start].clone()];
    let marker = BatchCommitted {
        schema: BODY_SCHEMA,
        batch_id: Some("beefbeefbeefbeefbeefbeefbeef0007".into()),
        idempotency_key: None,
        actor: Actor {
            id: ACTOR_LEDGER.into(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        member_event_ids: vec![member_frames[0].event_id.clone()],
        member_count: 1,
        members_digest: super::members_digest(member_frames.iter()).unwrap(),
        operation_digest: crate::ledger::sha256_hex(b"conformance-plan"),
    };
    b.push_body(KIND_BATCH_COMMITTED, &marker);
    // Duplicate marker for the valid first batch.
    let first_marker = b
        .frames
        .iter()
        .find(|f| f.kind == KIND_BATCH_COMMITTED)
        .unwrap()
        .body
        .clone();
    b.push(KIND_BATCH_COMMITTED, first_marker);
    (
        "batches",
        "A valid two-member batch with a same-batch basis link applies atomically; orphans, \
         wrong order/count/digest, one invalid member, interleaving, and duplicate markers have \
         zero entity-state effect.",
        b.frames,
    )
}

fn scenario_human_forms() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let human = human_registration("human:josef");
    let human_reg = b.push_body(KIND_SOURCE_REGISTERED, &human);
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );

    let human_effect = |assertion: AssertionFields, form: HumanAssertionForm| {
        serde_json::to_value(observation_body(
            ObservationKind::HumanAssertion,
            &human_registration("human:josef"),
            &human_reg,
            "human:josef",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            serde_json::to_value(HumanAssertionPayload { assertion, form }).unwrap(),
        ))
        .unwrap()
    };
    let trusted = |predicate: &str, value: TypedValue| AssertionFields {
        predicate: predicate.into(),
        value,
        authority_provenance: AuthorityProvenance::TrustedHumanCapture,
        ..assertion(
            AuthorityProvenance::TrustedHumanCapture,
            AssertionBasis::Firsthand,
        )
    };

    // A field_change with its exact paired belief.revised patch: applies.
    let patch = PatchOp {
        field_path: "/fields/status".into(),
        before: TypedValue::string("active"),
        after: TypedValue::string("paused"),
    };
    let field_form = HumanAssertionForm::FieldChange {
        target_belief_id: BELIEF.into(),
        field_path: patch.field_path.clone(),
        before: patch.before.clone(),
        after: patch.after.clone(),
        corrects: None,
        reason: None,
    };
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0101",
        vec![
            (
                KIND_OBSERVATION_RECORDED.into(),
                human_effect(
                    trusted("status", TypedValue::string("paused")),
                    field_form.clone(),
                ),
            ),
            (
                KIND_BELIEF_REVISED.into(),
                serde_json::to_value(revised_body(BELIEF, vec![patch], unsupported())).unwrap(),
            ),
        ],
        true,
        None,
    );

    // A relation_change with its exact paired belief.relation event.
    let relation_id = derive_relation_id(BELIEF, BELIEF_B, RelationKind::Refines);
    let relation_value = TypedValue::Object {
        value: [
            ("relation_id".to_string(), TypedValue::string(&relation_id)),
            ("action".to_string(), TypedValue::string("add")),
            ("from".to_string(), TypedValue::string(BELIEF)),
            ("to".to_string(), TypedValue::string(BELIEF_B)),
            ("relation".to_string(), TypedValue::string("refines")),
        ]
        .into_iter()
        .collect(),
    };
    let relation_form = HumanAssertionForm::RelationChange {
        target_belief_id: BELIEF.into(),
        relation_id: relation_id.clone(),
        action: RelationAction::Add,
        from: BELIEF.into(),
        to: BELIEF_B.into(),
        relation: RelationKind::Refines,
        corrects: None,
        reason: None,
    };
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0102",
        vec![
            (
                KIND_OBSERVATION_RECORDED.into(),
                human_effect(trusted("belief_relation", relation_value), relation_form),
            ),
            (
                KIND_BELIEF_RELATION.into(),
                serde_json::to_value(relation_body(
                    BELIEF,
                    BELIEF_B,
                    RelationKind::Refines,
                    RelationAction::Add,
                ))
                .unwrap(),
            ),
        ],
        true,
        None,
    );

    // An alias_add with its exact paired entity.alias_added event.
    let alias_value = TypedValue::Object {
        value: [
            ("entity_id".to_string(), TypedValue::string(ENTITY)),
            ("alias".to_string(), TypedValue::string("Acme HQ")),
            (
                "normalized_alias".to_string(),
                TypedValue::string("acme hq"),
            ),
        ]
        .into_iter()
        .collect(),
    };
    let alias_form = HumanAssertionForm::AliasAdd {
        target_belief_id: BELIEF.into(),
        entity_id: ENTITY.into(),
        alias: "Acme HQ".into(),
        normalized_alias: "acme hq".into(),
        corrects: None,
        reason: None,
    };
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0103",
        vec![
            (
                KIND_OBSERVATION_RECORDED.into(),
                human_effect(
                    trusted("entity_alias", alias_value.clone()),
                    alias_form.clone(),
                ),
            ),
            (
                KIND_ENTITY_ALIAS_ADDED.into(),
                serde_json::to_value(alias_body(ENTITY, "Acme HQ")).unwrap(),
            ),
        ],
        true,
        None,
    );

    // A field_change WITHOUT its paired patch: the whole batch refuses.
    let orphan_form = HumanAssertionForm::FieldChange {
        target_belief_id: BELIEF.into(),
        field_path: "/fields/status".into(),
        before: TypedValue::string("paused"),
        after: TypedValue::string("archived"),
        corrects: None,
        reason: None,
    };
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0104",
        vec![(
            KIND_OBSERVATION_RECORDED.into(),
            human_effect(
                trusted("status", TypedValue::string("archived")),
                orphan_form.clone(),
            ),
        )],
        true,
        None,
    );
    // ...and SOLO, outside any batch: refused the same way.
    b.push(
        KIND_OBSERVATION_RECORDED,
        human_effect(
            trusted("status", TypedValue::string("archived")),
            orphan_form,
        ),
    );

    // alias_add whose entity is not the target Belief's subject: batch dies.
    let wrong_alias_value = TypedValue::Object {
        value: [
            ("entity_id".to_string(), TypedValue::string(ENTITY_B)),
            ("alias".to_string(), TypedValue::string("Acme Annex")),
            (
                "normalized_alias".to_string(),
                TypedValue::string("acme annex"),
            ),
        ]
        .into_iter()
        .collect(),
    };
    let wrong_alias_form = HumanAssertionForm::AliasAdd {
        target_belief_id: BELIEF.into(),
        entity_id: ENTITY_B.into(),
        alias: "Acme Annex".into(),
        normalized_alias: "acme annex".into(),
        corrects: None,
        reason: None,
    };
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0105",
        vec![
            (
                KIND_OBSERVATION_RECORDED.into(),
                human_effect(trusted("entity_alias", wrong_alias_value), wrong_alias_form),
            ),
            (
                KIND_ENTITY_ALIAS_ADDED.into(),
                serde_json::to_value(alias_body(ENTITY_B, "Acme Annex")).unwrap(),
            ),
        ],
        true,
        None,
    );

    // Alias REMOVAL has no event and no form: an unsupported transition.
    let mut removal = human_effect(trusted("entity_alias", alias_value), alias_form);
    removal["payload"]["assertion_form"] = serde_json::json!("alias_remove");
    b.push(KIND_OBSERVATION_RECORDED, removal);

    // A standalone whose same-batch basis use names the WRONG Belief.
    let standalone = human_effect(
        trusted("status", TypedValue::string("active")),
        HumanAssertionForm::Standalone {
            intended_belief_id: Some(BELIEF_B.into()),
            corrects: None,
            reason: None,
        },
    );
    let member0_id = format!("{:032x}", b.frames.len() as u64 + 1);
    let disagreeing = revised_body(
        BELIEF,
        vec![],
        BeliefBasis::Linked {
            links: vec![BasisLink {
                observation_event_id: member0_id,
                role: BasisRole::Supports,
            }],
        },
    );
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0106",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), standalone),
            (
                KIND_BELIEF_REVISED.into(),
                serde_json::to_value(disagreeing).unwrap(),
            ),
        ],
        true,
        None,
    );

    (
        "human-forms",
        "Human effect forms (field_change/relation_change/alias_add) pair one-to-one with the \
         exact event realizing them in the same logical batch; unpaired, solo, wrong-entity, \
         alias-removal, and intended-Belief-disagreeing uses are refused.",
        b.frames,
    )
}

fn scenario_derived_sources() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let content = content_registration("svc.distill");
    let content_reg = b.push_body(KIND_SOURCE_REGISTERED, &content);
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec![],
    };
    // Valid: derived content naming the committed creation (no lineage).
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::DerivedContent,
            &content,
            &content_reg,
            "agent:run-1",
            subject.clone(),
            vec![],
            derived_payload(Some(vec![created.clone()])),
        ),
    );
    // Invalid: naming a non-revision event (the registration).
    b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::DerivedContent,
            &content,
            &content_reg,
            "agent:run-1",
            subject.clone(),
            vec![],
            derived_payload(Some(vec![content_reg.clone()])),
        ),
    );
    (
        "derived-sources",
        "Belief-revision inputs must name earlier committed creations/revisions; the reducer \
         indexes them read-only with no version effect on the Belief.",
        b.frames,
    )
}

fn scenario_plumbing() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    b.push("vault.write", serde_json::json!({ "path": "a.md" }));
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push("vault.delete", serde_json::json!({ "path": "a.md" }));
    // Garbage claiming schema membership, and a reserved kind.
    b.push(
        KIND_BELIEF_CREATED,
        serde_json::json!({ "schema": 1, "garbage": true }),
    );
    b.push("proposal.submitted", serde_json::json!({ "schema": 1 }));
    (
        "plumbing",
        "Plumbing indexes with zero entity state; schema-claiming garbage and reserved kinds are \
         deterministic anomalies, never panics.",
        b.frames,
    )
}

fn scenario_migration() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let digest = crate::ledger::sha256_hex(b"corpus");
    let (schema_v, batch_id, idempotency_key, actor) = common(ACTOR_MIGRATOR);
    let started = MigrationStarted {
        schema: schema_v,
        batch_id: batch_id.clone(),
        idempotency_key: idempotency_key.clone(),
        actor: actor.clone(),
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        store_uuid: STORE.into(),
        migration_schema: migration::MIGRATION_SCHEMA,
        source_digest: digest.clone(),
        planned_output_count: 2,
    };
    b.push_body(KIND_MIGRATION_STARTED, &started);
    // A different-digest re-start mid-epoch: reconciliation, refused.
    let mut restarted = started.clone();
    restarted.source_digest = crate::ledger::sha256_hex(b"other corpus");
    b.push_body(KIND_MIGRATION_STARTED, &restarted);
    // Completion disagreeing with the plan, then agreeing.
    let completed = MigrationCompleted {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        store_uuid: STORE.into(),
        migration_schema: migration::MIGRATION_SCHEMA,
        source_digest: digest,
        output_count: 3,
        output_keys_digest: crate::ledger::sha256_hex(b"keys"),
    };
    b.push_body(KIND_MIGRATION_COMPLETED, &completed);
    let mut agreed = completed.clone();
    agreed.output_count = 2;
    b.push_body(KIND_MIGRATION_COMPLETED, &agreed);
    (
        "migration-brackets",
        "Brackets pin the epoch identity: mid-epoch digest changes and disagreeing completions \
         are refused; brackets have no version effect.",
        b.frames,
    )
}

// --- Generation ------------------------------------------------------------

fn scenarios() -> Vec<(&'static str, &'static str, Vec<Frame>)> {
    vec![
        scenario_sources(),
        scenario_observations(),
        scenario_lineage(),
        scenario_beliefs(),
        scenario_resolution(),
        scenario_relations(),
        scenario_attestation(),
        scenario_human_forms(),
        scenario_aliases(),
        scenario_independence(),
        scenario_batches(),
        scenario_derived_sources(),
        scenario_plumbing(),
        scenario_migration(),
    ]
}

fn vector_json(name: &str, description: &str, frames: &[Frame]) -> serde_json::Value {
    let state = reduce(frames, STORE);
    serde_json::json!({
        "name": name,
        "description": description,
        "store_id": STORE,
        "events": frames
            .iter()
            .map(|f| serde_json::to_value(f).unwrap())
            .collect::<Vec<_>>(),
        "expected_state": vector_state(&state),
        "expected_refusals": state
            .anomalies
            .iter()
            .map(|a| serde_json::json!({
                "seq": a.seq,
                "event_id": a.event_id,
                "batch_id": a.batch_id,
                "code": a.code,
                "detail": a.detail,
            }))
            .collect::<Vec<_>>(),
    })
}

/// The shared derivation/normalization data vectors — pure functions both
/// toolchains must compute identically.
fn data_vectors() -> Vec<(&'static str, serde_json::Value)> {
    let normalize_inputs = [
        "Acme Corp",
        "  spaced\u{00a0}\u{2003}out\tname \n",
        "ﬁle SYSTEM",
        "Ⅸ legion",
        "ΟΔΥΣΣΕΥΣ",
        "Straße",
        "１２３ ｆｕｌｌwidth",
        "e\u{301}",
        "İstanbul",
        "A  B",
    ];
    let normalize: Vec<serde_json::Value> = normalize_inputs
        .iter()
        .map(|input| serde_json::json!({ "input": input, "normalized": normalize_alias_v1(input) }))
        .collect();

    let relations: Vec<serde_json::Value> = [
        (ENTITY, ENTITY_B, RelationKind::Supersedes),
        (ENTITY_B, ENTITY, RelationKind::Supersedes),
        (ENTITY, ENTITY_B, RelationKind::Refines),
        (ENTITY, ENTITY_B, RelationKind::Contradicts),
    ]
    .iter()
    .map(|(from, to, kind)| {
        serde_json::json!({
            "from": from, "to": to, "relation": kind.as_str(),
            "relation_id": derive_relation_id(from, to, *kind),
        })
    })
    .collect();

    let sources: Vec<serde_json::Value> = [
        human_registration("human:josef"),
        direct_registration("conn-1", "domain-github"),
        content_registration("svc.mail"),
    ]
    .iter()
    .map(|r| {
        serde_json::json!({
            "kind": r.registration.kind_str(),
            "source_key": r.registration.source_key(),
            "source_id": r.source_id,
        })
    })
    .collect();

    let migrate_ids = serde_json::json!([
        {
            "class": "belief",
            "identity": "systems/offline-guarantee.md",
            "id": migrate_id(STORE, "belief", "systems/offline-guarantee.md"),
        },
        {
            "class": "entity",
            "identity": "systems/offline-guarantee.md",
            "id": migrate_id(STORE, "entity", "systems/offline-guarantee.md"),
        },
    ]);

    let attested = serde_json::json!([{
        "content": "# Acme\n",
        "fields": { "type": "Reference" },
        "projected": super::project::project("# Acme\n", &serde_json::json!({ "type": "Reference" })),
        "hash": schema::belief::attested_content_hash(
            super::project::project("# Acme\n", &serde_json::json!({ "type": "Reference" })).as_bytes()
        ),
    }]);

    vec![(
        "derivations",
        serde_json::json!({
            "store_id": STORE,
            "normalize_alias_v1": normalize,
            "relation_ids": relations,
            "sources": sources,
            "migrate_ids": migrate_ids,
            "attested_content": attested,
        }),
    )]
}

fn conformance_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance")
}

#[test]
fn conformance_vectors_are_committed_and_current() {
    let update = std::env::var("UPDATE_CONFORMANCE").is_ok();
    let dir = conformance_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let mut files: Vec<(String, String)> = Vec::new();
    for (name, description, frames) in scenarios() {
        let json = vector_json(name, description, &frames);
        files.push((
            format!("{name}.json"),
            serde_json::to_string_pretty(&json).unwrap() + "\n",
        ));
    }
    for (name, json) in data_vectors() {
        files.push((
            format!("{name}.json"),
            serde_json::to_string_pretty(&json).unwrap() + "\n",
        ));
    }
    for (file, bytes) in files {
        let path = dir.join(&file);
        if update {
            std::fs::write(&path, &bytes).unwrap();
            continue;
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!("{file} is not committed — run UPDATE_CONFORMANCE=1 cargo test conformance")
        });
        assert_eq!(
            committed, bytes,
            "{file}: committed vector differs from regeneration — a semantic change must be \
             intentional (UPDATE_CONFORMANCE=1 to accept)"
        );
    }
}

/// Every M22-defined kind appears in at least one vector, and refusal
/// coverage is non-trivial in every scenario that promises it.
#[test]
fn the_vector_suite_covers_every_kind() {
    let mut kinds = std::collections::BTreeSet::new();
    for (_, _, frames) in scenarios() {
        for frame in &frames {
            kinds.insert(frame.kind.clone());
        }
    }
    for kind in [
        KIND_BATCH_COMMITTED,
        KIND_SOURCE_REGISTERED,
        KIND_OBSERVATION_RECORDED,
        KIND_SUBJECT_RESOLVED,
        KIND_INDEPENDENCE_RECORDED,
        KIND_BELIEF_CREATED,
        KIND_BELIEF_REVISED,
        KIND_BELIEF_RELATION,
        KIND_BELIEF_ATTESTED,
        KIND_ENTITY_ALIAS_ADDED,
        KIND_MIGRATION_STARTED,
        KIND_MIGRATION_COMPLETED,
    ] {
        assert!(kinds.contains(kind), "no vector exercises {kind}");
    }
}
