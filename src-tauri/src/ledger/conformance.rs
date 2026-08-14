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
/// A third Belief on the same entity — M27.3's second comparison needs a
/// genuinely different pair, not a re-run of the first.
const BELIEF_C: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/// A proposal id nothing ever submits — for the vectors that name one.
const UNSUBMITTED_PROPOSAL: &str = "abababababababababababababababab";

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
    // A later revision makes the attestation PREDATE: the projection now
    // renders the review notice ("verified at r1; current is r2 — …")
    // instead of silently forgetting the review (M23.4, D8).
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body(
            BELIEF,
            vec![PatchOp {
                field_path: "/fields/status".into(),
                before: TypedValue::string("active"),
                after: TypedValue::string("paused"),
            }],
            unsupported(),
        ),
    );
    (
        "attestation",
        "The id/hash pair must name one committed revision of the named Belief, hashed over its \
         byte-stable projection; a later revision renders the predating review notice, never \
         silence.",
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

    // --- `human_confirmed` (M27.2c) ------------------------------------
    //
    // Refused since M22 on a premise — "reserved until M24" — that stopped
    // being true when M24 shipped. The producer has been server-binding all
    // four of its fields since then; what was missing was the state check,
    // and a state check is exactly what needs a cross-language vector.
    //
    // The approval is what is checked, NOT `state == applied`: mutation
    // members fold BEFORE `proposal.applied` in the same batch, so demanding
    // the applied state would refuse the very batch that applies it.
    let confirmed = |proposal: &str, decision: &str| IndependenceProof::HumanConfirmed {
        left_source_registration_event_id: direct_a_reg.clone(),
        right_source_registration_event_id: direct_b_reg.clone(),
        proposal_id: proposal.into(),
        decision_event_id: decision.into(),
    };
    let confirm_proposal = "cccc0000cccc0000cccc0000cccc0001";
    let confirm_decision = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";

    // A proposal nobody submitted. Named ids are not confirmation.
    //
    // Two extractions off two DIFFERENT snapshots, so their ancestries are
    // disjoint and the reducer's `known_same_lineage` guard is not what
    // refuses them — the human-confirmation check is.
    let snap_a = b.push_body(
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
    let snap_b = b.push_body(
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
    let orphan_a = extract(
        &mut b,
        &direct_a,
        &direct_a_reg,
        vec![LineageEdge {
            edge: LineageKind::DerivedFrom,
            parent_observation_event_id: snap_a,
        }],
    );
    let orphan_b = extract(
        &mut b,
        &direct_b,
        &direct_b_reg,
        vec![LineageEdge {
            edge: LineageKind::DerivedFrom,
            parent_observation_event_id: snap_b,
        }],
    );
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(
            &orphan_a,
            &orphan_b,
            confirmed(confirm_proposal, confirm_decision),
        ),
    );

    // Submitted and queued, but undecided. Silence is not confirmation.
    let (schema_v, batch_id, idempotency_key, actor) = common("agent:run-1");
    b.push_body(
        schema::KIND_PROPOSAL_SUBMITTED,
        &schema::ProposalSubmitted {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal: Box::new(schema::ProposalV1 {
                schema: schema::PROPOSAL_SCHEMA,
                proposal_id: confirm_proposal.into(),
                run_id: "4444444444444444444444444444444a".into(),
                targets: vec![
                    schema::ProposalTarget {
                        target_id: orphan_a.clone(),
                        target_class: schema::TargetClass::Observation,
                        expected_version: None,
                    },
                    schema::ProposalTarget {
                        target_id: orphan_b.clone(),
                        target_class: schema::TargetClass::Observation,
                        expected_version: None,
                    },
                ],
                op: schema::ProposalOp::ConfirmObservationIndependence {
                    left_observation_event_id: orphan_a.clone(),
                    right_observation_event_id: orphan_b.clone(),
                    basis_event_ids: vec![orphan_a.clone(), orphan_b.clone()],
                    reason: "two systems, two domains, one claim".into(),
                },
                intended_use: schema::IntendedUse {
                    kind: schema::IntendedUseKind::ReversibleWork,
                    stakes: schema::Risk::Low,
                    predicate_class: None,
                },
                basis: schema::ProposalBasis {
                    transition_cause: schema::TransitionCause::Maintenance,
                    evidence_refs: vec![],
                    coverage_refs: vec![],
                    authority_refs: vec![],
                    authority_route_refs: vec![],
                    addressed_contradictions: vec![],
                    absence_claim: false,
                },
                declared_risk: schema::Risk::High,
                reason: "two systems, two domains, one claim".into(),
                candidate_search_receipt: None,
            }),
        },
    );
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(
            &orphan_a,
            &orphan_b,
            confirmed(confirm_proposal, confirm_decision),
        ),
    );

    // Queued at HIGH — a person was actually asked — and approved.
    let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
    b.push_body(
        schema::KIND_PROPOSAL_QUEUED,
        &schema::ProposalQueued {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: confirm_proposal.into(),
            commit_set_id: "5e75e75e75e75e75e75e75e75e75e75e".into(),
            member_proposal_ids: vec![confirm_proposal.into()],
            effective_risk: schema::Risk::High,
            policy_version: 1,
            target_versions: vec![],
            queued_at: STAMP.into(),
            queued_for: vec![],
        },
    );
    let (schema_v, batch_id, idempotency_key, actor) = common("human:josef");
    b.push_body(
        schema::KIND_PROPOSAL_DECISION_RECORDED,
        &schema::ProposalDecisionRecorded {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            decision_id: confirm_decision.into(),
            proposal_id: confirm_proposal.into(),
            decision: schema::Decision::Approve,
            reviewer: "human:josef".into(),
            decided_at: STAMP.into(),
            reason: None,
            reviewed_target_versions: vec![],
        },
    );
    // The approval names a DIFFERENT decision event: refused, because a
    // proof that a human confirmed this pair has to name the approval that
    // did.
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(
            &orphan_a,
            &orphan_b,
            confirmed(confirm_proposal, "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"),
        ),
    );
    // And the one that works.
    b.push_body(
        KIND_INDEPENDENCE_RECORDED,
        &independence_body(
            &orphan_a,
            &orphan_b,
            confirmed(confirm_proposal, confirm_decision),
        ),
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
    // Garbage claiming schema membership: an unknown field, a known kind
    // with a body missing its common fields (M24.3 defined this one, so it
    // is now a shape refusal rather than a reservation refusal), and a kind
    // no build has ever heard of.
    b.push(
        KIND_BELIEF_CREATED,
        serde_json::json!({ "schema": 1, "garbage": true }),
    );
    b.push("proposal.submitted", serde_json::json!({ "schema": 1 }));
    b.push("belief.teleported", serde_json::json!({ "schema": 1 }));
    (
        "plumbing",
        "Plumbing indexes with zero entity state; schema-claiming garbage, an incomplete body \
         under a known kind, and a kind outside the vocabulary are all deterministic anomalies, \
         never panics.",
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

/// A Belief that IS a projection: its subject's `.md` alias claims the
/// knowledge-relative path.
fn projection_belief_body(belief_id: &str, entity_id: &str, path: &str) -> BeliefCreated {
    let mut body = belief_body(belief_id, entity_id, unsupported());
    body.subject = SubjectRef::Resolved {
        entity_id: entity_id.into(),
        aliases: vec![path.into()],
    };
    body
}

fn override_body(
    belief_id: &str,
    path: &str,
    base: (u64, &str, &str),
    before_bytes: &str,
    after_bytes: &str,
    change: OverrideChange,
) -> ProjectionOverridden {
    let (schema, batch_id, idempotency_key, actor) = common("human:josef");
    ProjectionOverridden {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.into(),
        path: path.into(),
        base_belief_revision: base.0,
        base_belief_revision_event: base.1.into(),
        base_generating_event: base.2.into(),
        before_projection_hash: crate::ledger::sha256_hex(before_bytes.as_bytes()),
        after_projection_hash: crate::ledger::sha256_hex(after_bytes.as_bytes()),
        origin: OverrideOrigin::InApp,
        change,
    }
}

const BODY_V1: &str = "# Acme\n\nActive vendor.\n";
const BODY_V2: &str = "# Acme\n\nAn active vendor.\n";
const ACME_PATH: &str = "concepts/acme.md";

fn acme_projection(body: &str, title: Option<&str>) -> String {
    let mut fields = serde_json::Map::new();
    fields.insert("status".into(), serde_json::json!("active"));
    if let Some(title) = title {
        fields.insert("title".into(), serde_json::json!(title));
    }
    super::project::project(body, &serde_json::Value::Object(fields))
}

fn body_patch(before: &str, after: &str) -> Vec<OverridePatchOp> {
    vec![OverridePatchOp {
        field_path: "/body".into(),
        before: TypedValue::string(before),
        after: TypedValue::string(after),
    }]
}

fn scenario_overrides() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &projection_belief_body(BELIEF, ENTITY, ACME_PATH),
    );

    // Set #1: an editorial body rewrite over the canonical projection.
    let set1 = b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &created),
            &acme_projection(BODY_V1, None),
            &acme_projection(BODY_V2, None),
            OverrideChange::Set {
                patch: body_patch(BODY_V1, BODY_V2),
                supersedes_override_event_ids: vec![],
            },
        ),
    );

    // Set #2 SUPERSEDES #1: body returns to canon, a presentation title
    // appears instead. Its base head is set #1's event, not the revision.
    let set2 = b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &set1),
            &acme_projection(BODY_V2, None),
            &acme_projection(BODY_V1, Some("Acme (vendor)")),
            OverrideChange::Set {
                patch: vec![OverridePatchOp {
                    field_path: "/fields/title".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("Acme (vendor)"),
                }],
                supersedes_override_event_ids: vec![set1.clone()],
            },
        ),
    );

    // Wrong base: the projection head advanced (byte-identically or not);
    // a stale generating event is refused.
    b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &set1),
            &acme_projection(BODY_V1, Some("Acme (vendor)")),
            &acme_projection(BODY_V2, Some("Acme (vendor)")),
            OverrideChange::Set {
                patch: body_patch(BODY_V1, BODY_V2),
                supersedes_override_event_ids: vec![],
            },
        ),
    );

    // Before mismatch: right hashes shape, wrong op before-value.
    b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &set2),
            &acme_projection(BODY_V1, Some("Acme (vendor)")),
            &acme_projection(BODY_V2, Some("Acme (vendor)")),
            OverrideChange::Set {
                patch: body_patch("# Acme\n\nNever the projected body.\n", BODY_V2),
                supersedes_override_event_ids: vec![],
            },
        ),
    );

    // Illegal pointer: provenance is never an override target.
    b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &set2),
            &acme_projection(BODY_V1, Some("Acme (vendor)")),
            &acme_projection(BODY_V1, Some("Acme (vendor)")),
            OverrideChange::Set {
                patch: vec![OverridePatchOp {
                    field_path: "/fields/verified".into(),
                    before: TypedValue::Missing,
                    after: TypedValue::string("forged"),
                }],
                supersedes_override_event_ids: vec![],
            },
        ),
    );

    // Evidence exclusion: an override event can never be basis or lineage.
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(
            BELIEF_B,
            ENTITY_B,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: set2.clone(),
                    role: BasisRole::Context,
                }],
            },
        ),
    );

    // A Belief that is not a projection cannot be overridden.
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );
    b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF_B,
            "concepts/other.md",
            (1, &created, &created),
            BODY_V1,
            BODY_V2,
            OverrideChange::Set {
                patch: body_patch(BODY_V1, BODY_V2),
                supersedes_override_event_ids: vec![],
            },
        ),
    );

    // Clear #2: the canonical projection returns; history and the head
    // advance — an override clear is a projection-state transition.
    let clear = b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &set2),
            &acme_projection(BODY_V1, Some("Acme (vendor)")),
            &acme_projection(BODY_V1, None),
            OverrideChange::Clear {
                override_event_ids: vec![set2.clone()],
                reason: "maintenance retired the presentation tweak".into(),
            },
        ),
    );

    // Clearing something that is not active: refused.
    b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &clear),
            &acme_projection(BODY_V1, None),
            &acme_projection(BODY_V1, None),
            OverrideChange::Clear {
                override_event_ids: vec![set1.clone()],
                reason: "already gone".into(),
            },
        ),
    );

    // A fresh set, then a REVISION: the overlay stays active, marked stale.
    let set3 = b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &clear),
            &acme_projection(BODY_V1, None),
            &acme_projection(BODY_V2, None),
            OverrideChange::Set {
                patch: body_patch(BODY_V1, BODY_V2),
                supersedes_override_event_ids: vec![],
            },
        ),
    );
    let _ = set3;
    b.push_body(
        KIND_BELIEF_REVISED,
        &revised_body(
            BELIEF,
            vec![PatchOp {
                field_path: "/fields/status".into(),
                before: TypedValue::string("active"),
                after: TypedValue::string("paused"),
            }],
            unsupported(),
        ),
    );
    (
        "overrides",
        "Override set/supersede/clear mutate only the projection overlay and bump the Belief \
         version; wrong base, stale head, before mismatch, illegal pointers, non-projection \
         targets, and evidence use are refused; a revision marks the overlay stale, never \
         clears it.",
        b.frames,
    )
}

fn scenario_projection_identity() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &projection_belief_body(BELIEF, ENTITY, ACME_PATH),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &projection_belief_body(BELIEF_B, ENTITY_B, "concepts/other.md"),
    );

    // Attestation: bytes identical, identity advances.
    let projected = acme_projection(BODY_V1, None);
    let (schema, batch_id, idempotency_key, actor) = common("human:josef");
    b.push_body(
        KIND_BELIEF_ATTESTED,
        &BeliefAttested {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            attested_belief_revision_event_id: created.clone(),
            attested_content_hash: schema::belief::attested_content_hash(projected.as_bytes()),
        },
    );
    // Relation add and remove: the FROM Belief's identity advances twice.
    b.push_body(
        KIND_BELIEF_RELATION,
        &relation_body(BELIEF, BELIEF_B, RelationKind::Refines, RelationAction::Add),
    );
    b.push_body(
        KIND_BELIEF_RELATION,
        &relation_body(
            BELIEF,
            BELIEF_B,
            RelationKind::Refines,
            RelationAction::Remove,
        ),
    );
    // Alias addition on the subject Entity: identity advances again.
    b.push_body(KIND_ENTITY_ALIAS_ADDED, &alias_body(ENTITY, "Acme Corp"));
    // Override set, then clear: bytes return to canon; identity does not.
    let head_after_alias = b.frames.last().unwrap().event_id.clone();
    let set = b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &head_after_alias),
            &acme_projection(BODY_V1, None),
            &acme_projection(BODY_V2, None),
            OverrideChange::Set {
                patch: body_patch(BODY_V1, BODY_V2),
                supersedes_override_event_ids: vec![],
            },
        ),
    );
    b.push_body(
        KIND_PROJECTION_OVERRIDDEN,
        &override_body(
            BELIEF,
            ACME_PATH,
            (1, &created, &set),
            &acme_projection(BODY_V2, None),
            &acme_projection(BODY_V1, None),
            OverrideChange::Clear {
                override_event_ids: vec![set.clone()],
                reason: "canon restored".into(),
            },
        ),
    );
    (
        "projection-identity",
        "Every projection-state transition — attestation, relation add/remove, alias addition, \
         override set/clear — advances the generating event and state digest, even when the \
         projected bytes are identical to an earlier state.",
        b.frames,
    )
}

fn path_digest(entries: &[(&str, &str)]) -> String {
    let list: Vec<serde_json::Value> = entries
        .iter()
        .map(|(path, bytes)| {
            serde_json::json!({
                "path": path,
                "content_hash": crate::ledger::sha256_hex(bytes.as_bytes()),
            })
        })
        .collect();
    crate::ledger::sha256_hex(serde_json::to_string(&list).unwrap().as_bytes())
}

fn scenario_reconciliation() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &projection_belief_body(BELIEF, ENTITY, ACME_PATH),
    );

    let divergence = |key: &[u8], signals: Vec<DivergenceSignal>| {
        let (schema, batch_id, idempotency_key, actor) = common(ACTOR_RECONCILIATION);
        LedgerDivergence {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            detection_key: crate::ledger::sha256_hex(key),
            signals,
            ledger_head: crate::ledger::sha256_hex(b"head"),
            git_anchored_head: None,
            remembered_head: Some(crate::ledger::sha256_hex(b"remembered")),
            manifest_digest: crate::ledger::sha256_hex(b"manifest"),
            reducer_projection_digest: crate::ledger::sha256_hex(b"reducer"),
            mismatch_count: 1,
            projection_count: 1,
            sample_paths: vec![ACME_PATH.into()],
        }
    };
    let resolution = |divergence_event: &str,
                      action: ReconciliationAction,
                      batch: Option<&str>,
                      digest: &str| {
        let (schema, _, idempotency_key, actor) = common(ACTOR_RECONCILIATION);
        ReconciliationResolved {
            schema,
            batch_id: batch.map(str::to_string),
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            divergence_event_id: divergence_event.into(),
            action,
            affected_paths: vec![ACME_PATH.into()],
            capture_batch_ids: batch.map(str::to_string).into_iter().collect(),
            accepted_files_digest: matches!(action, ReconciliationAction::AcceptCurrentFiles)
                .then(|| digest.to_string()),
            resulting_projection_digest: digest.to_string(),
        }
    };

    // Open the mode; the duplicate key is refused (append-once's reducer
    // half); a second detection key is ABSORBED, never a second mode.
    let first = b.push_body(
        KIND_LEDGER_DIVERGENCE,
        &divergence(
            b"condition-1",
            vec![DivergenceSignal::ManifestReducerDisagreement],
        ),
    );
    b.push_body(
        KIND_LEDGER_DIVERGENCE,
        &divergence(
            b"condition-1",
            vec![DivergenceSignal::MassProjectionMismatch],
        ),
    );
    let second = b.push_body(
        KIND_LEDGER_DIVERGENCE,
        &divergence(
            b"condition-2",
            vec![DivergenceSignal::MigrationSourceChanged],
        ),
    );
    let _ = second;

    // A resolution naming a non-divergence event: wrong, refused.
    let canon = acme_projection(BODY_V1, None);
    let canon_digest = path_digest(&[(ACME_PATH, &canon)]);
    b.push_body(
        KIND_RECONCILIATION_RESOLVED,
        &resolution(
            &created,
            ReconciliationAction::RestoreLedgerAuthority,
            None,
            &canon_digest,
        ),
    );
    // A digest that does not match the reducer projections: refused.
    b.push_body(
        KIND_RECONCILIATION_RESOLVED,
        &resolution(
            &first,
            ReconciliationAction::RestoreLedgerAuthority,
            None,
            &crate::ledger::sha256_hex(b"not the projections"),
        ),
    );
    // The valid restore: proves the reducer projections and closes the
    // whole mode — both detection keys resolve together.
    b.push_body(
        KIND_RECONCILIATION_RESOLVED,
        &resolution(
            &first,
            ReconciliationAction::RestoreLedgerAuthority,
            None,
            &canon_digest,
        ),
    );
    // Stale: the mode is closed; the same reference no longer resolves.
    b.push_body(
        KIND_RECONCILIATION_RESOLVED,
        &resolution(
            &first,
            ReconciliationAction::RestoreLedgerAuthority,
            None,
            &canon_digest,
        ),
    );

    // Accept-current-files: a new divergence, then ONE logical batch holding
    // the adoption override and the resolution whose digests match the
    // staged projection.
    let third = b.push_body(
        KIND_LEDGER_DIVERGENCE,
        &divergence(
            b"condition-3",
            vec![DivergenceSignal::MassProjectionMismatch],
        ),
    );
    let adopted = acme_projection(BODY_V2, None);
    let adopted_digest = path_digest(&[(ACME_PATH, &adopted)]);
    let batch_id = "beefbeefbeefbeefbeefbeefbeef0201";
    let adoption_override = override_body(
        BELIEF,
        ACME_PATH,
        (1, &created, &created),
        &canon,
        &adopted,
        OverrideChange::Set {
            patch: body_patch(BODY_V1, BODY_V2),
            supersedes_override_event_ids: vec![],
        },
    );
    b.push_batch(
        batch_id,
        vec![
            (
                KIND_PROJECTION_OVERRIDDEN.into(),
                serde_json::to_value(&adoption_override).unwrap(),
            ),
            (
                KIND_RECONCILIATION_RESOLVED.into(),
                serde_json::to_value(resolution(
                    &third,
                    ReconciliationAction::AcceptCurrentFiles,
                    Some(batch_id),
                    &adopted_digest,
                ))
                .unwrap(),
            ),
        ],
        true,
        None,
    );

    // Uncommitted: divergence and resolution members without a marker have
    // ZERO state effect — the mode stays closed.
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0202",
        vec![(
            KIND_LEDGER_DIVERGENCE.into(),
            serde_json::to_value(divergence(
                b"condition-4",
                vec![DivergenceSignal::GitAnchorRegression],
            ))
            .unwrap(),
        )],
        false,
        None,
    );
    (
        "reconciliation",
        "One divergence per detection key opens (or is absorbed into) the single reconciliation \
         mode; a resolution closes it only by referencing an active divergence with digests the \
         reducer projections prove; wrong, stale, mismatched, and uncommitted events have no \
         effect.",
        b.frames,
    )
}

fn scenario_capture() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &projection_belief_body(BELIEF, ENTITY, ACME_PATH),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &projection_belief_body(BELIEF_B, ENTITY_B, "concepts/other.md"),
    );
    let _ = created;

    // The M23.5 capture batch, exactly as the boundary builds it: the
    // FIRST-capture human registration rides its own source-register-v1
    // key; every effect gets one human assertion with UI-selected authority
    // (both fields defaulting to unknown) and CORE-derived provenance; one
    // revision carries the complete replacement basis; the exact paired
    // events follow.
    let human = human_registration("human:owner");
    let mut registration_value = serde_json::to_value(&human).unwrap();
    registration_value["idempotency_key"] =
        serde_json::json!(format!("source-register-v1:{STORE}:{}", human.source_id));
    let registration_ref = format!("{:032x}", b.frames.len() as u64 + 1);

    let capture_assertion =
        |predicate: &str, value: TypedValue, basis: AssertionBasis, form: HumanAssertionForm| {
            let mut body = observation_body(
                ObservationKind::HumanAssertion,
                &human,
                &registration_ref,
                "human:owner",
                SubjectRef::Resolved {
                    entity_id: ENTITY.into(),
                    aliases: vec![],
                },
                vec![],
                serde_json::to_value(HumanAssertionPayload {
                    assertion: AssertionFields {
                        assertion_kind: AssertionKind::Presence,
                        predicate: predicate.into(),
                        value,
                        scope: Scope::empty(),
                        relationship_to_subject: RelationshipToSubject {
                            role: SubjectRole::Unknown,
                        },
                        assertion_basis: basis,
                        authority_provenance: AuthorityProvenance::TrustedHumanCapture,
                        absence: None,
                    },
                    form,
                })
                .unwrap(),
            );
            body.actor.id = "human:owner".into();
            serde_json::to_value(&body).unwrap()
        };

    let field_assertion = capture_assertion(
        "/fields/status",
        TypedValue::string("paused"),
        AssertionBasis::Unknown,
        HumanAssertionForm::FieldChange {
            target_belief_id: BELIEF.into(),
            field_path: "/fields/status".into(),
            before: TypedValue::string("active"),
            after: TypedValue::string("paused"),
            corrects: None,
            reason: None,
        },
    );
    let relation_id = derive_relation_id(BELIEF, BELIEF_B, RelationKind::Refines);
    let relation_assertion = capture_assertion(
        "belief_relation",
        TypedValue::Object {
            value: [
                ("relation_id".to_string(), TypedValue::string(&relation_id)),
                ("action".to_string(), TypedValue::string("add")),
                ("from".to_string(), TypedValue::string(BELIEF)),
                ("to".to_string(), TypedValue::string(BELIEF_B)),
                ("relation".to_string(), TypedValue::string("refines")),
            ]
            .into_iter()
            .collect(),
        },
        AssertionBasis::Unknown,
        HumanAssertionForm::RelationChange {
            target_belief_id: BELIEF.into(),
            relation_id: relation_id.clone(),
            action: RelationAction::Add,
            from: BELIEF.into(),
            to: BELIEF_B.into(),
            relation: RelationKind::Refines,
            corrects: None,
            reason: None,
        },
    );
    let alias_assertion = capture_assertion(
        "entity_alias",
        TypedValue::Object {
            value: [
                ("entity_id".to_string(), TypedValue::string(ENTITY)),
                ("alias".to_string(), TypedValue::string("The Acme File")),
                (
                    "normalized_alias".to_string(),
                    TypedValue::string("the acme file"),
                ),
            ]
            .into_iter()
            .collect(),
        },
        AssertionBasis::Unknown,
        HumanAssertionForm::AliasAdd {
            target_belief_id: BELIEF.into(),
            entity_id: ENTITY.into(),
            alias: "The Acme File".into(),
            normalized_alias: "the acme file".into(),
            corrects: None,
            reason: None,
        },
    );
    // Member ids are seq-deterministic: registration m0, assertions m1-m3.
    let base = b.frames.len() as u64;
    let member_id = |offset: u64| format!("{:032x}", base + offset);
    let revised = revised_body(
        BELIEF,
        vec![PatchOp {
            field_path: "/fields/status".into(),
            before: TypedValue::string("active"),
            after: TypedValue::string("paused"),
        }],
        BeliefBasis::Linked {
            links: vec![
                BasisLink {
                    observation_event_id: member_id(2),
                    role: BasisRole::Supports,
                },
                BasisLink {
                    observation_event_id: member_id(3),
                    role: BasisRole::Supports,
                },
                BasisLink {
                    observation_event_id: member_id(4),
                    role: BasisRole::Supports,
                },
            ],
        },
    );
    let mut revised_value = serde_json::to_value(&revised).unwrap();
    revised_value["actor"]["id"] = serde_json::json!("human:owner");
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0301",
        vec![
            (KIND_SOURCE_REGISTERED.into(), registration_value),
            (KIND_OBSERVATION_RECORDED.into(), field_assertion),
            (KIND_OBSERVATION_RECORDED.into(), relation_assertion),
            (KIND_OBSERVATION_RECORDED.into(), alias_assertion),
            (KIND_BELIEF_REVISED.into(), revised_value),
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
            (
                KIND_ENTITY_ALIAS_ADDED.into(),
                serde_json::to_value(alias_body(ENTITY, "The Acme File")).unwrap(),
            ),
        ],
        true,
        None,
    );

    // A STALE capture: the before-value no longer holds — the whole batch
    // (assertion AND revision) has zero effect.
    let stale_assertion = capture_assertion(
        "/fields/status",
        TypedValue::string("archived"),
        AssertionBasis::Unknown,
        HumanAssertionForm::FieldChange {
            target_belief_id: BELIEF.into(),
            field_path: "/fields/status".into(),
            before: TypedValue::string("active"), // now "paused"
            after: TypedValue::string("archived"),
            corrects: None,
            reason: None,
        },
    );
    let stale_revised = revised_body(
        BELIEF,
        vec![PatchOp {
            field_path: "/fields/status".into(),
            before: TypedValue::string("active"),
            after: TypedValue::string("archived"),
        }],
        unsupported(),
    );
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0302",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), stale_assertion),
            (
                KIND_BELIEF_REVISED.into(),
                serde_json::to_value(&stale_revised).unwrap(),
            ),
        ],
        true,
        None,
    );

    // A FORGED capture: an agent actor claiming trusted human provenance —
    // authority derivation refuses it, killing the batch.
    let mut forged = capture_assertion(
        "/fields/status",
        TypedValue::string("forged"),
        AssertionBasis::Firsthand,
        HumanAssertionForm::FieldChange {
            target_belief_id: BELIEF.into(),
            field_path: "/fields/status".into(),
            before: TypedValue::string("paused"),
            after: TypedValue::string("forged"),
            corrects: None,
            reason: None,
        },
    );
    forged["actor"]["id"] = serde_json::json!("agent:sneaky");
    let forged_revised = revised_body(
        BELIEF,
        vec![PatchOp {
            field_path: "/fields/status".into(),
            before: TypedValue::string("paused"),
            after: TypedValue::string("forged"),
        }],
        unsupported(),
    );
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0303",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), forged),
            (
                KIND_BELIEF_REVISED.into(),
                serde_json::to_value(&forged_revised).unwrap(),
            ),
        ],
        true,
        None,
    );

    // The extracted-claim-text correction SHAPE: a field_change targeting
    // the body with corrects/reason — the closed union gains no new kind.
    let correction = capture_assertion(
        "/body",
        TypedValue::string("# Acme\n\nCorrected vendor.\n"),
        AssertionBasis::Unknown,
        HumanAssertionForm::FieldChange {
            target_belief_id: BELIEF.into(),
            field_path: "/body".into(),
            before: TypedValue::string("# Acme\n\nActive vendor.\n"),
            after: TypedValue::string("# Acme\n\nCorrected vendor.\n"),
            corrects: Some(member_id(2)),
            reason: Some("the extracted claim text was wrong".into()),
        },
    );
    // The complete-replacement rule again: every still-admissible prior
    // link survives and the correction Observation joins as support.
    let correction_obs_id = format!("{:032x}", b.frames.len() as u64 + 1);
    let correction_revised = revised_body(
        BELIEF,
        vec![PatchOp {
            field_path: "/body".into(),
            before: TypedValue::string("# Acme\n\nActive vendor.\n"),
            after: TypedValue::string("# Acme\n\nCorrected vendor.\n"),
        }],
        BeliefBasis::Linked {
            links: [member_id(2), member_id(3), member_id(4), correction_obs_id]
                .into_iter()
                .map(|observation_event_id| BasisLink {
                    observation_event_id,
                    role: BasisRole::Supports,
                })
                .collect(),
        },
    );
    let mut correction_revised_value = serde_json::to_value(&correction_revised).unwrap();
    correction_revised_value["actor"]["id"] = serde_json::json!("human:owner");
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0304",
        vec![
            (KIND_OBSERVATION_RECORDED.into(), correction),
            (KIND_BELIEF_REVISED.into(), correction_revised_value),
        ],
        true,
        None,
    );
    (
        "capture",
        "The M23.5 capture batch: first-source registration under its own key, one assertion per \
         effect with unknown-defaulted authority and core-derived provenance, the complete \
         replacement basis, and exact paired events — while stale and forged captures refuse \
         wholesale and corrections stay inside the closed field_change form.",
        b.frames,
    )
}

// --- Generation ------------------------------------------------------------

/// The M24 governed lifecycle: qualification, lifecycle, contest, and
/// tombstone, with the illegal edges refused beside the legal ones.
fn scenario_governance() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );

    let profile = schema::QualificationProfileRef {
        type_id: "Metric".into(),
        type_schema_hash: "f".repeat(64),
        required_roles: vec![schema::FieldRole::Evidence, schema::FieldRole::Owner],
    };
    let qualification = |belief: &str, from, to, cause| {
        let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
        schema::BeliefQualificationChanged {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief.into(),
            from,
            to,
            qualification_profile: profile.clone(),
            cause,
        }
    };
    // Promotion, then a same-state retry (refused), then the stored inverse.
    b.push_body(
        schema::KIND_BELIEF_QUALIFICATION_CHANGED,
        &qualification(
            BELIEF,
            schema::Qualification::Draft,
            schema::Qualification::Qualified,
            schema::QualificationCause::Promoted,
        ),
    );
    b.push_body(
        schema::KIND_BELIEF_QUALIFICATION_CHANGED,
        &qualification(
            BELIEF,
            schema::Qualification::Draft,
            schema::Qualification::Qualified,
            schema::QualificationCause::Promoted,
        ),
    );
    b.push_body(
        schema::KIND_BELIEF_QUALIFICATION_CHANGED,
        &qualification(
            BELIEF,
            schema::Qualification::Qualified,
            schema::Qualification::Draft,
            schema::QualificationCause::Reverted,
        ),
    );

    let lifecycle = |belief: &str, from, to, cause, replacement: Option<&str>| {
        let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
        schema::BeliefLifecycleChanged {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief.into(),
            from,
            to,
            cause,
            replacement_id: replacement.map(str::to_string),
        }
    };
    use schema::Lifecycle as L;
    use schema::LifecycleCause as C;
    // Supersede, its stored inverse, then archive.
    b.push_body(
        schema::KIND_BELIEF_LIFECYCLE_CHANGED,
        &lifecycle(
            BELIEF,
            L::Active,
            L::Superseded,
            C::Superseded,
            Some(BELIEF_B),
        ),
    );
    b.push_body(
        schema::KIND_BELIEF_LIFECYCLE_CHANGED,
        &lifecycle(BELIEF, L::Superseded, L::Active, C::Reverted, None),
    );
    // Un-archiving is not a v1 transition, and a state mismatch is refused.
    b.push_body(
        schema::KIND_BELIEF_LIFECYCLE_CHANGED,
        &lifecycle(BELIEF, L::Superseded, L::Active, C::Reverted, None),
    );
    b.push_body(
        schema::KIND_BELIEF_LIFECYCLE_CHANGED,
        &lifecycle(BELIEF, L::Active, L::Archived, C::Archived, None),
    );

    // A contest needs committed counterevidence; there is none in this
    // vector, so the open is refused — an opinion is not a challenge.
    let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
    b.push_body(
        schema::KIND_BELIEF_CONTESTED,
        &schema::BeliefContested {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF_B.into(),
            action: schema::ContestAction::Open,
            counterevidence_refs: vec!["0123456789abcdef0123456789abcdef".into()],
            addressed_by_event_id: None,
        },
    );

    // Tombstone is terminal: the transition after it is refused.
    let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
    b.push_body(
        schema::KIND_BELIEF_TOMBSTONED,
        &schema::BeliefTombstoned {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF_B.into(),
            replacement_id: None,
            reason_code: schema::TombstoneReason::Invalid,
        },
    );
    b.push_body(
        schema::KIND_BELIEF_LIFECYCLE_CHANGED,
        &lifecycle(BELIEF_B, L::Active, L::Archived, C::Archived, None),
    );

    (
        "governance",
        "Qualification and lifecycle move only along their exact edges; a same-state retry, a \
         state mismatch, an un-archive, an uncommitted contest, and any transition after a \
         tombstone are all refused. Each accepted transition advances the Belief once and moves \
         its projection head.",
        b.frames,
    )
}

/// One HIGH-risk `archive_belief` submission — the shape both the proposal
/// lifecycle vector and the semantic vector need a real proposal for.
fn archive_submission(id: &str) -> schema::ProposalSubmitted {
    let (schema_v, batch_id, idempotency_key, actor) = common("agent:run-1");
    schema::ProposalSubmitted {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        proposal: Box::new(schema::ProposalV1 {
            schema: schema::PROPOSAL_SCHEMA,
            proposal_id: id.into(),
            run_id: "4444444444444444444444444444444a".into(),
            targets: vec![schema::ProposalTarget {
                target_id: BELIEF.into(),
                target_class: schema::TargetClass::Belief,
                expected_version: Some(1),
            }],
            op: schema::ProposalOp::ArchiveBelief {
                belief_id: BELIEF.into(),
                replacement_id: None,
            },
            intended_use: schema::IntendedUse {
                kind: schema::IntendedUseKind::ReversibleWork,
                stakes: schema::Risk::Low,
                predicate_class: None,
            },
            basis: schema::ProposalBasis {
                transition_cause: schema::TransitionCause::Maintenance,
                evidence_refs: vec![],
                coverage_refs: vec![],
                authority_refs: vec![],
                authority_route_refs: vec![],
                addressed_contradictions: vec![],
                absence_claim: false,
            },
            declared_risk: schema::Risk::High,
            reason: "retire the stale record".into(),
            candidate_search_receipt: None,
        }),
    }
}

/// The proposal a semantic verdict names (M27.4d).
const SEMANTIC_PROPOSAL: &str = "1111111111111111111111111111111b";

/// One MEDIUM `classify_conflict` submission — the review an `agent_supplied`
/// classification claims to be the answer to.
fn classify_submission(
    id: &str,
    comparison_id: &str,
    outcome: schema::ConflictOutcome,
    basis: &str,
) -> schema::ProposalSubmitted {
    let (schema_v, batch_id, idempotency_key, actor) = common("agent:run-1");
    schema::ProposalSubmitted {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        proposal: Box::new(schema::ProposalV1 {
            schema: schema::PROPOSAL_SCHEMA,
            proposal_id: id.into(),
            run_id: "4444444444444444444444444444444a".into(),
            targets: vec![schema::ProposalTarget {
                target_id: comparison_id.to_string(),
                target_class: schema::TargetClass::Comparison,
                expected_version: Some(1),
            }],
            op: schema::ProposalOp::ClassifyConflict {
                comparison_id: comparison_id.to_string(),
                outcome,
                basis_refs: vec![basis.to_string()],
                model_id: "claude-opus-5".into(),
                prompt_version: "classify-conflict-v1".into(),
            },
            intended_use: schema::IntendedUse {
                kind: schema::IntendedUseKind::ReversibleWork,
                stakes: schema::Risk::Low,
                predicate_class: None,
            },
            basis: schema::ProposalBasis {
                transition_cause: schema::TransitionCause::Maintenance,
                evidence_refs: vec![],
                coverage_refs: vec![],
                authority_refs: vec![],
                authority_route_refs: vec![],
                addressed_contradictions: vec![],
                absence_claim: false,
            },
            declared_risk: schema::Risk::Medium,
            reason: "these two say the same thing".into(),
            candidate_search_receipt: None,
        }),
    }
}

/// The durable proposal lifecycle and its closed version effects.
fn scenario_proposals() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let proposal_a = "1111111111111111111111111111111a";
    let proposal_b = "1111111111111111111111111111111b";
    let commit_set = "5e75e75e75e75e75e75e75e75e75e75e";
    let decision_id = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0";

    b.push_body(
        schema::KIND_PROPOSAL_SUBMITTED,
        &archive_submission(proposal_a),
    );
    b.push_body(
        schema::KIND_PROPOSAL_SUBMITTED,
        &archive_submission(proposal_b),
    );
    // A second submission of the same proposal is refused.
    b.push_body(
        schema::KIND_PROPOSAL_SUBMITTED,
        &archive_submission(proposal_a),
    );

    let queue = |id: &str| {
        let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
        schema::ProposalQueued {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: id.into(),
            commit_set_id: commit_set.into(),
            member_proposal_ids: vec![proposal_a.into(), proposal_b.into()],
            effective_risk: schema::Risk::High,
            policy_version: 1,
            target_versions: vec![schema::TargetVersion {
                target_class: schema::TargetClass::Belief,
                target_id: BELIEF.into(),
                version: 1,
            }],
            queued_at: STAMP.into(),
            queued_for: vec!["high_stakes_verification_required".into()],
        }
    };
    b.push_body(schema::KIND_PROPOSAL_QUEUED, &queue(proposal_a));
    b.push_body(schema::KIND_PROPOSAL_QUEUED, &queue(proposal_b));

    let decide = |id: &str, proposal: &str, decision, reason: Option<&str>| {
        let (schema_v, batch_id, idempotency_key, actor) = common("human:josef");
        schema::ProposalDecisionRecorded {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            decision_id: id.into(),
            proposal_id: proposal.into(),
            decision,
            reviewer: "human:josef".into(),
            decided_at: STAMP.into(),
            reason: reason.map(str::to_string),
            reviewed_target_versions: vec![],
        }
    };
    b.push_body(
        schema::KIND_PROPOSAL_DECISION_RECORDED,
        &decide(decision_id, proposal_a, schema::Decision::Approve, None),
    );
    // A second decision on one proposal is refused.
    b.push_body(
        schema::KIND_PROPOSAL_DECISION_RECORDED,
        &decide(
            "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
            proposal_a,
            schema::Decision::Reject,
            Some("changed my mind"),
        ),
    );

    let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
    b.push_body(
        schema::KIND_PROPOSAL_APPLIED,
        &schema::ProposalApplied {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: proposal_a.into(),
            commit_set_id: commit_set.into(),
            effective_risk: schema::Risk::High,
            decision_id: Some(decision_id.into()),
            mutation_event_ids: vec!["0123456789abcdef0123456789abcdef".into()],
            resulting_versions: vec![],
            revert_plan: None,
        },
    );
    // Terminal is terminal: a rejection after an application is refused.
    let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
    b.push_body(
        schema::KIND_PROPOSAL_REJECTED,
        &schema::ProposalRejected {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: proposal_a.into(),
            commit_set_id: commit_set.into(),
            code: "human_rejected".into(),
            rule: "human_decision".into(),
            expected: schema::TypedValue::string("approve"),
            actual: schema::TypedValue::string("reject"),
            decision_id: None,
            refused_by_proposal_id: None,
        },
    );
    // The peer is rejected as an atomic casualty, naming what failed.
    let (schema_v, batch_id, idempotency_key, actor) = common("system:ledger");
    b.push_body(
        schema::KIND_PROPOSAL_REJECTED,
        &schema::ProposalRejected {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            proposal_id: proposal_b.into(),
            commit_set_id: commit_set.into(),
            code: "atomic_set_refused".into(),
            rule: "commit_set".into(),
            expected: schema::TypedValue::string("applied"),
            actual: schema::TypedValue::string("refused"),
            decision_id: None,
            refused_by_proposal_id: Some(proposal_a.into()),
        },
    );

    (
        "proposals",
        "The durable proposal lifecycle: submit, queue as an all-or-nothing set, one human \
         decision, apply, and an atomic peer rejection. A duplicate submission, a second \
         decision, and a terminal-state exit are all refused, and every accepted event advances \
         exactly its own proposal target once.",
        b.frames,
    )
}

/// M25.3 — the portable processing receipt and its closed route matrix.
///
/// The vector exercises every route that this build can produce today, the
/// atomic Observation+receipt batch a changed item commits, the append-once
/// key that makes a rescan of identical bytes free, and each association
/// refusal: an unknown source, an Observation that does not exist, a
/// proposal whose state contradicts the route, and a successor superseding
/// something that was never queued.
/// The window `scenario_ingest` and `scenario_semantic` both park items on.
const WINDOW: &str = "batch-2026-08-09";

/// One `ingest.semantic_assessed` body on [`WINDOW`].
///
/// Dimensions follow the outcome, which is the whole shape of the event: a
/// decided window says what it looked at, a blocked one is not asked to.
fn semantic_outcome(
    outcome: SemanticOutcome,
    input_receipt_ids: Vec<String>,
    proposal_ids: Vec<String>,
    blocked_reason: Option<BlockedReason>,
) -> IngestSemanticAssessed {
    semantic_outcome_on(
        WINDOW,
        outcome,
        input_receipt_ids,
        proposal_ids,
        blocked_reason,
    )
}

fn semantic_outcome_on(
    window: &str,
    outcome: SemanticOutcome,
    mut input_receipt_ids: Vec<String>,
    proposal_ids: Vec<String>,
    blocked_reason: Option<BlockedReason>,
) -> IngestSemanticAssessed {
    let (schema, batch_id, idempotency_key, actor) = common("agent:m26-ingest");
    input_receipt_ids.sort();
    IngestSemanticAssessed {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        semantic_assessment_id: derive_semantic_assessment_id(STORE, window),
        m26_batch_key: window.to_string(),
        input_receipt_ids,
        outcome,
        disposition: match outcome {
            SemanticOutcome::Material => SemanticDisposition::ProposalsSubmitted,
            SemanticOutcome::NonMaterial => SemanticDisposition::ClosedNonMaterial,
            SemanticOutcome::Undetermined => SemanticDisposition::BlockedVisible,
        },
        evaluated_dimensions: match outcome {
            // A run that never started evaluated nothing, and says so rather
            // than claiming a look it did not take.
            SemanticOutcome::Undetermined => vec![],
            _ => vec![
                MaterialDimension::EvidenceState,
                MaterialDimension::WorldState,
            ],
        },
        material_dimensions: match outcome {
            // Corroboration only: zero fields moved and a second independent
            // source arrived. Material on evidence-state, which is the case
            // "no field changed → discard" would have thrown away.
            SemanticOutcome::Material => vec![MaterialDimension::EvidenceState],
            _ => vec![],
        },
        proposal_ids,
        blocked_reason,
        explanation: "the run's own words about this window".into(),
        content_label: ContentLabel::AgentSupplied,
    }
}

fn scenario_ingest() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let josef = human_registration("human:josef");
    let josef_reg = b.push_body(KIND_SOURCE_REGISTERED, &josef);
    let source_id = josef.source_id.clone();
    let item = derive_item_id(STORE, &source_id, "records/a.md");
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec![],
    };

    let receipt = |route: Route,
                   verdict: PrefilterVerdict,
                   observations: Vec<String>,
                   epoch: u64,
                   supersedes: Option<String>,
                   source: &str,
                   item_id: &str| {
        let (schema, batch_id, idempotency_key, actor) = common("system:prefilter");
        IngestAssessed {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            receipt_id: derive_receipt_id(
                STORE,
                source,
                item_id,
                &"a".repeat(64),
                "vault-entry-v1",
                epoch,
                route,
            ),
            item_id: item_id.to_string(),
            source_id: source.to_string(),
            source_record_id: None,
            artifact_hash: "a".repeat(64),
            normalized_snapshot_hash: "b".repeat(64),
            normalizer_version: "vault-entry-v1".into(),
            processing_epoch: epoch,
            assessed_against_chain_head: "c".repeat(64),
            prefilter_verdict: verdict,
            material_dimensions: match verdict {
                PrefilterVerdict::MaterialCandidate => vec![MaterialDimension::WorldState],
                _ => vec![],
            },
            independence: Independence::IndependenceUnknown,
            route,
            observation_event_ids: observations,
            proposal_ids: vec![],
            m26_batch_key: match route {
                Route::M26Queued | Route::M26Completed | Route::FailedVisible => {
                    Some(WINDOW.into())
                }
                _ => None,
            },
            m26_outcome_event_id: match route {
                Route::M26Completed | Route::FailedVisible => Some(ENTITY.into()),
                _ => None,
            },
            supersedes_receipt_id: supersedes,
        }
    };

    // A changed item commits its Observation and its first receipt as ONE
    // logical batch — the whole point of the association guarantee.
    let observation = observation_body(
        ObservationKind::HumanAssertion,
        &josef,
        &josef_reg,
        "human:josef",
        subject.clone(),
        vec![],
        human_payload(AssertionBasis::Firsthand),
    );
    // The batch's first member's event id, precomputed the way the writer
    // preallocates it — the receipt names the Observation it commits with.
    let observation_id = format!("{:032x}", b.frames.len() as u64 + 1);
    let queued = receipt(
        Route::M26Queued,
        PrefilterVerdict::NeedsSemanticJudgment,
        vec![observation_id.clone()],
        0,
        None,
        &source_id,
        &item,
    );
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0025",
        vec![
            (
                KIND_OBSERVATION_RECORDED.to_string(),
                serde_json::to_value(&observation).unwrap(),
            ),
            (
                KIND_INGEST_ASSESSED.to_string(),
                serde_json::to_value(&queued).unwrap(),
            ),
        ],
        true,
        None,
    );
    let queued_receipt_id = queued.receipt_id.clone();

    // The same bytes assessed again: refused, because a rescan must not
    // append a second receipt or charge a second time.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &receipt(
            Route::M26Queued,
            PrefilterVerdict::NeedsSemanticJudgment,
            vec![observation_id.clone()],
            0,
            None,
            &source_id,
            &item,
        ),
    );

    // M26.4: a successor receipt can only close on an outcome that exists and
    // agrees with it, so the window's semantic run is committed FIRST. This
    // vector used to name a fabricated outcome event id and apply anyway —
    // the seam M26.4a closed.
    let blocked = semantic_outcome(
        SemanticOutcome::Undetermined,
        vec![queued_receipt_id.clone()],
        vec![],
        Some(BlockedReason::RuntimeUnavailable),
    );
    let blocked_event = b.push_body(KIND_INGEST_SEMANTIC_ASSESSED, &blocked);

    // A visible failure closes the queued row out. Recovery restores it HELD.
    let mut failed = receipt(
        Route::FailedVisible,
        PrefilterVerdict::NeedsSemanticJudgment,
        vec![observation_id.clone()],
        0,
        Some(queued_receipt_id.clone()),
        &source_id,
        &item,
    );
    failed.m26_outcome_event_id = Some(blocked_event);
    b.push_body(KIND_INGEST_ASSESSED, &failed);
    // A second successor for the same queued receipt: refused.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &receipt(
            Route::M26Completed,
            PrefilterVerdict::NeedsSemanticJudgment,
            vec![observation_id.clone()],
            0,
            Some(queued_receipt_id),
            &source_id,
            &item,
        ),
    );

    // An unknown source: held or refused, never inferred from a path.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &receipt(
            Route::ClosedNoChange,
            PrefilterVerdict::NoChange,
            vec![],
            0,
            None,
            &"f".repeat(32),
            &item,
        ),
    );
    // An Observation that does not exist.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &receipt(
            Route::ClosedNonMaterial,
            PrefilterVerdict::NonMaterialChange,
            vec!["e".repeat(32)],
            0,
            None,
            &source_id,
            &item,
        ),
    );
    // A superseded receipt that was never queued.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &receipt(
            Route::M26Completed,
            PrefilterVerdict::NeedsSemanticJudgment,
            vec![observation_id.clone()],
            0,
            Some("d".repeat(32)),
            &source_id,
            &item,
        ),
    );

    // An explicit owner retry of unchanged bytes: a NEW epoch, a new chain,
    // and no collision with the failed one.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &receipt(
            Route::ClosedNoChange,
            PrefilterVerdict::NoChange,
            vec![observation_id],
            1,
            None,
            &source_id,
            &item,
        ),
    );

    (
        "ingest",
        "portable processing receipts: the closed route matrix, the atomic \
         Observation+receipt batch, append-once bytes, supersession, and every \
         association refusal",
        b.frames,
    )
}

/// `ingest.semantic_assessed` — one semantic run per settled window (M26.4).
///
/// The receipt vector proves an item can be PARKED for a semantic run; this
/// proves what closing one out costs. A window is its inputs, so the second
/// run over the same window mints the same id and is refused — the "at most
/// one semantic run per settled window" rule as arithmetic rather than as a
/// note in a plan. The rest is association: inputs that exist, are queued,
/// are unclosed, and are on THIS window; proposals that were really
/// submitted; and a successor receipt whose route agrees with what the run
/// actually concluded.
///
/// The no-effect vector is the quiet one. An assessment advances nothing —
/// not its inputs, not its proposals, not itself — so a rebuild that replays
/// it lands on the same versions as one that has never seen it.
fn scenario_semantic() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let josef = human_registration("human:josef");
    let josef_reg = b.push_body(KIND_SOURCE_REGISTERED, &josef);
    let source_id = josef.source_id.clone();
    let item = derive_item_id(STORE, &source_id, "records/a.md");
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec![],
    };

    let queued_id = derive_receipt_id(
        STORE,
        &source_id,
        &item,
        &"a".repeat(64),
        "vault-entry-v1",
        0,
        Route::M26Queued,
    );
    let observation = observation_body(
        ObservationKind::HumanAssertion,
        &josef,
        &josef_reg,
        "human:josef",
        subject,
        vec![],
        human_payload(AssertionBasis::Firsthand),
    );
    let observation_id = format!("{:032x}", b.frames.len() as u64 + 1);
    let queued = {
        let (schema, batch_id, idempotency_key, actor) = common("system:prefilter");
        IngestAssessed {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            receipt_id: queued_id.clone(),
            item_id: item.clone(),
            source_id: source_id.clone(),
            source_record_id: None,
            artifact_hash: "a".repeat(64),
            normalized_snapshot_hash: "b".repeat(64),
            normalizer_version: "vault-entry-v1".into(),
            processing_epoch: 0,
            assessed_against_chain_head: "c".repeat(64),
            prefilter_verdict: PrefilterVerdict::NeedsSemanticJudgment,
            material_dimensions: vec![],
            independence: Independence::IndependenceUnknown,
            route: Route::M26Queued,
            observation_event_ids: vec![observation_id.clone()],
            proposal_ids: vec![],
            m26_batch_key: Some(WINDOW.into()),
            m26_outcome_event_id: None,
            supersedes_receipt_id: None,
        }
    };
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0026",
        vec![
            (
                KIND_OBSERVATION_RECORDED.to_string(),
                serde_json::to_value(&observation).unwrap(),
            ),
            (
                KIND_INGEST_ASSESSED.to_string(),
                serde_json::to_value(&queued).unwrap(),
            ),
        ],
        true,
        None,
    );

    // An input that was never committed.
    b.push_body(
        KIND_INGEST_SEMANTIC_ASSESSED,
        &semantic_outcome(
            SemanticOutcome::NonMaterial,
            vec!["e".repeat(32)],
            vec![],
            None,
        ),
    );
    // An input parked on a DIFFERENT window: a run closes what it read.
    b.push_body(
        KIND_INGEST_SEMANTIC_ASSESSED,
        &semantic_outcome_on(
            "batch-2026-08-10",
            SemanticOutcome::NonMaterial,
            vec![queued_id.clone()],
            vec![],
            None,
        ),
    );
    // A proposal nobody submitted.
    b.push_body(
        KIND_INGEST_SEMANTIC_ASSESSED,
        &semantic_outcome(
            SemanticOutcome::Material,
            vec![queued_id.clone()],
            vec![UNSUBMITTED_PROPOSAL.into()],
            None,
        ),
    );

    // The window closes NON-MATERIAL. Nothing changed that is worth
    // recording, and that is a verdict the pass is allowed to reach — it
    // still had to say which dimensions it evaluated to get there.
    let decided = semantic_outcome(
        SemanticOutcome::NonMaterial,
        vec![queued_id.clone()],
        vec![],
        None,
    );
    let decided_event = b.push_body(KIND_INGEST_SEMANTIC_ASSESSED, &decided);

    // A second run over the same settled window, reaching a DIFFERENT
    // conclusion: still refused. The id is derived from the window and not
    // from what the run decided, so a second opinion cannot append itself
    // beside the first — which is the point, since the second opinion is the
    // one that cost money nobody authorised.
    b.push_body(
        KIND_INGEST_SEMANTIC_ASSESSED,
        &semantic_outcome(
            SemanticOutcome::Undetermined,
            vec![queued_id.clone()],
            vec![],
            Some(BlockedReason::SemanticValidationFailed),
        ),
    );

    let successor = |route: Route, outcome_event: Option<String>| {
        let (schema, batch_id, idempotency_key, actor) = common("system:prefilter");
        IngestAssessed {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            receipt_id: derive_receipt_id(
                STORE,
                &source_id,
                &item,
                &"a".repeat(64),
                "vault-entry-v1",
                0,
                route,
            ),
            item_id: item.clone(),
            source_id: source_id.clone(),
            source_record_id: None,
            artifact_hash: "a".repeat(64),
            normalized_snapshot_hash: "b".repeat(64),
            normalizer_version: "vault-entry-v1".into(),
            processing_epoch: 0,
            assessed_against_chain_head: "c".repeat(64),
            prefilter_verdict: PrefilterVerdict::NeedsSemanticJudgment,
            material_dimensions: vec![],
            independence: Independence::IndependenceUnknown,
            route,
            observation_event_ids: vec![observation_id.clone()],
            proposal_ids: vec![],
            m26_batch_key: Some(WINDOW.into()),
            m26_outcome_event_id: outcome_event,
            supersedes_receipt_id: Some(queued_id.clone()),
        }
    };

    // A decided window cannot be closed as a visible failure: the route and
    // the outcome are two statements about the same event and must agree.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &successor(Route::FailedVisible, Some(decided_event.clone())),
    );
    // An outcome event that is not an outcome at all.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &successor(Route::M26Completed, Some(observation_id.clone())),
    );
    // The honest close.
    b.push_body(
        KIND_INGEST_ASSESSED,
        &successor(Route::M26Completed, Some(decided_event)),
    );

    // --- A second window, closed the way the runtime actually closes one ---
    //
    // The outcome and every successor receipt commit under ONE marker, so a
    // crash exposes either the queued rows or the whole terminal
    // association, and never a window whose outcome exists with nothing
    // pointing at it. Inside the batch the outcome comes FIRST: a successor
    // is checked against what its outcome concluded, and there is nothing to
    // check against until the outcome has been applied.
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    let proposal_id = "5555555555555555555555555555555a";
    b.push_body(
        schema::KIND_PROPOSAL_SUBMITTED,
        &archive_submission(proposal_id),
    );

    let item_b = derive_item_id(STORE, &source_id, "records/b.md");
    let window_b = "batch-2026-08-11";
    let queued_b_id = derive_receipt_id(
        STORE,
        &source_id,
        &item_b,
        &"a".repeat(64),
        "vault-entry-v1",
        0,
        Route::M26Queued,
    );
    let mut queued_b = queued.clone();
    queued_b.receipt_id = queued_b_id.clone();
    queued_b.item_id = item_b.clone();
    queued_b.m26_batch_key = Some(window_b.into());
    b.push_body(KIND_INGEST_ASSESSED, &queued_b);

    let mut completion = successor(Route::M26Completed, None);
    completion.item_id = item_b;
    completion.m26_batch_key = Some(window_b.into());
    completion.supersedes_receipt_id = Some(queued_b_id.clone());
    completion.proposal_ids = vec![proposal_id.into()];
    completion.receipt_id = derive_receipt_id(
        STORE,
        &source_id,
        &completion.item_id,
        &"a".repeat(64),
        "vault-entry-v1",
        0,
        Route::M26Completed,
    );
    // The outcome's event id, precomputed the way the writer preallocates it.
    completion.m26_outcome_event_id = Some(format!("{:032x}", b.frames.len() as u64 + 1));
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0027",
        vec![
            (
                KIND_INGEST_SEMANTIC_ASSESSED.to_string(),
                serde_json::to_value(semantic_outcome_on(
                    window_b,
                    SemanticOutcome::Material,
                    vec![queued_b_id],
                    vec![proposal_id.into()],
                    None,
                ))
                .unwrap(),
            ),
            (
                KIND_INGEST_ASSESSED.to_string(),
                serde_json::to_value(&completion).unwrap(),
            ),
        ],
        true,
        None,
    );

    // --- A MATERIAL CANDIDATE window, closed ---
    //
    // The common case, and the one that could not be closed at all until the
    // successor rule was written down: with no deterministic mapper in this
    // build every material candidate queues, the schema required a candidate
    // to name a dimension, and `outcome::close` clears the dimensions by
    // design because the deterministic finding is already on the receipt
    // being superseded and the SEMANTIC one is on the outcome. A successor is
    // governed by its outcome, exactly as its proposal list is — this vector
    // is what holds the two reducers to that.
    let item_c = derive_item_id(STORE, &source_id, "records/c.md");
    let window_c = "batch-2026-08-12";
    let queued_c_id = derive_receipt_id(
        STORE,
        &source_id,
        &item_c,
        &"a".repeat(64),
        "vault-entry-v1",
        0,
        Route::M26Queued,
    );
    let mut queued_c = queued.clone();
    queued_c.receipt_id = queued_c_id.clone();
    queued_c.item_id = item_c.clone();
    queued_c.m26_batch_key = Some(window_c.into());
    queued_c.prefilter_verdict = PrefilterVerdict::MaterialCandidate;
    queued_c.material_dimensions = vec![MaterialDimension::WorldState];
    b.push_body(KIND_INGEST_ASSESSED, &queued_c);

    let mut closed_c = successor(Route::M26Completed, None);
    closed_c.item_id = item_c;
    closed_c.m26_batch_key = Some(window_c.into());
    closed_c.supersedes_receipt_id = Some(queued_c_id.clone());
    // It restates the verdict — the same item's story — and NOT the
    // deterministic finding.
    closed_c.prefilter_verdict = PrefilterVerdict::MaterialCandidate;
    closed_c.material_dimensions = vec![];
    closed_c.receipt_id = derive_receipt_id(
        STORE,
        &source_id,
        &closed_c.item_id,
        &"a".repeat(64),
        "vault-entry-v1",
        0,
        Route::M26Completed,
    );
    closed_c.m26_outcome_event_id = Some(format!("{:032x}", b.frames.len() as u64 + 1));
    b.push_batch(
        "beefbeefbeefbeefbeefbeefbeef0028",
        vec![
            (
                KIND_INGEST_SEMANTIC_ASSESSED.to_string(),
                serde_json::to_value(semantic_outcome_on(
                    window_c,
                    SemanticOutcome::NonMaterial,
                    vec![queued_c_id],
                    vec![],
                    None,
                ))
                .unwrap(),
            ),
            (
                KIND_INGEST_ASSESSED.to_string(),
                serde_json::to_value(&closed_c).unwrap(),
            ),
        ],
        true,
        None,
    );

    (
        "semantic",
        "one semantic run per settled window: the derived assessment id that \
         refuses a second opinion, input association, a successor receipt that \
         has to agree with what the run concluded, the terminal close \
         committed as one batch, and a material candidate closed with the \
         dimensions its outcome governs",
        b.frames,
    )
}

/// `entity.merged` — the one M22-era kind with no vector until now.
///
/// The coverage tripwire caught it while M25.3 was extending that list, and
/// a kind whose Rust/TS parity is unproven is exactly what the tripwire is
/// for. Two entities with beliefs, aliases, and a relation collapse into a
/// survivor; a second merge naming a survivor that no longer exists is
/// refused.
fn scenario_entity_merge() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, unsupported()),
    );
    b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY_B, unsupported()),
    );

    let mut plan = EntityReassignmentPlan {
        survivor_id: ENTITY.into(),
        merged_ids: vec![ENTITY_B.into()],
        affected_belief_ids: vec![BELIEF_B.into()],
        live_aliases: vec![],
        affected_relation_ids: vec![],
        plan_digest: String::new(),
    };
    plan.plan_digest = plan.digest_of().unwrap();
    let merged = |plan: &EntityReassignmentPlan| {
        let (schema, batch_id, idempotency_key, actor) = common("system:ledger");
        EntityMerged {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            survivor_id: plan.survivor_id.clone(),
            merged_ids: plan.merged_ids.clone(),
            reassignment_plan: plan.clone(),
            reassignment_digest: plan.plan_digest.clone(),
        }
    };
    b.push_body(KIND_ENTITY_MERGED, &merged(&plan));
    // The same merge again: the merged entity is gone, so there is nothing
    // left to reassign.
    b.push_body(KIND_ENTITY_MERGED, &merged(&plan));

    (
        "entity-merge",
        "two entities collapse into a survivor with their beliefs reassigned; a repeat \
         merge of an entity that no longer exists is refused",
        b.frames,
    )
}

/// M25.4 — the coverage record, uncollapsed.
///
/// Seven dimensions carried by committed facts or by explicit limitations; a
/// runtime gap that cannot touch source health; a partial restoration that
/// narrows a gap without closing it; and every bootstrap refusal — a basis
/// staged beside the claim, a basis that is not a fact, a fact about a
/// different subject, and an assessment citing itself.
fn scenario_coverage() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let connector = direct_registration("conn-1", "domain-a");
    let connector_reg = b.push_body(KIND_SOURCE_REGISTERED, &connector);
    let source_id = connector.source_id.clone();
    // An entity to scope the subject to.
    let entity_obs = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::SourceSnapshot,
            &connector,
            &connector_reg,
            "connector:conn-1",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            snapshot_payload(),
        ),
    );
    let _ = &entity_obs;

    let subject = || CoverageSubject {
        entity_id: Some(ENTITY.into()),
        predicate_class: Some("status".into()),
        scope: Scope::empty(),
    };
    let receipt = || RetrievalReceipt {
        strategy_version: "retrieval-v1".into(),
        query_strategy: "alias-expansion".into(),
        query_fingerprint: "a".repeat(64),
        attempted_at: "2026-08-09T10:00:00Z".into(),
        searched_domain: "the vault".into(),
        search_scope: "records/".into(),
        observation_window: "2026-08-01/2026-08-09".into(),
        searched_aliases: vec!["Ada".into()],
        searched_scopes: vec![Scope::empty()],
    };
    let fact = |id: &str, variant: Fact, producer: ProducerKind, actor: &str| {
        let (schema, batch_id, idempotency_key, actor) = common(actor);
        CoverageFactRecorded {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            fact_id: id.to_string(),
            source_id: source_id.clone(),
            source_registration_event_id: connector_reg.clone(),
            subject: subject(),
            dimension: variant.dimension(),
            state: variant.state(),
            as_of: "2026-08-09T10:00:00Z".into(),
            producer: Producer {
                kind: producer,
                producer_version: "1".into(),
            },
            fact: variant,
        }
    };

    let facts = [
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f001",
            Fact::ConnectionProbe {
                result: ConnectionResult::Connected,
            },
            ProducerKind::ConnectorAdapter,
            "connector:conn-1",
        ),
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f002",
            Fact::HealthProbe {
                result: HealthResult::Healthy,
            },
            ProducerKind::ConnectorAdapter,
            "connector:conn-1",
        ),
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f003",
            Fact::ScopeDiscovery {
                scope_digest: "b".repeat(64),
                result: KnownResult::Known,
            },
            ProducerKind::ConnectorAdapter,
            "connector:conn-1",
        ),
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f004",
            Fact::AccessProbe {
                scope_digest: "b".repeat(64),
                result: AccessResult::Accessible,
            },
            ProducerKind::ConnectorAdapter,
            "connector:conn-1",
        ),
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f005",
            Fact::RetentionDiscovery {
                result: KnownResult::Known,
                retention_seconds: Some(2_592_000),
            },
            ProducerKind::ConnectorAdapter,
            "connector:conn-1",
        ),
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f006",
            Fact::IndexCheckpoint {
                index_head: "head-1".into(),
                source_revision: "rev-9".into(),
                result: CurrentResult::Current,
            },
            ProducerKind::VaultIndexer,
            ACTOR_VAULT_INDEXER,
        ),
        (
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f007",
            Fact::RetrievalExecution {
                retrieval_receipt: receipt(),
            },
            ProducerKind::RetrievalEngine,
            ACTOR_RETRIEVAL_ENGINE,
        ),
    ];
    for (id, variant, producer, actor) in facts.clone() {
        b.push_body(
            KIND_COVERAGE_FACT_RECORDED,
            &fact(id, variant, producer, actor),
        );
    }
    // A connector stamping an index checkpoint: refused. If it could, it
    // would be declaring its own index current.
    b.push_body(
        KIND_COVERAGE_FACT_RECORDED,
        &fact(
            "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f008",
            Fact::IndexCheckpoint {
                index_head: "head-2".into(),
                source_revision: "rev-9".into(),
                result: CurrentResult::Current,
            },
            ProducerKind::VaultIndexer,
            "connector:conn-1",
        ),
    );

    let yes = |id: &str| DimensionAssessment {
        state: DimensionState::Yes,
        basis_event_ids: vec![id.to_string()],
        as_of: "2026-08-09T10:00:00Z".into(),
    };
    let assessed = |id: &str,
                    dimensions: Dimensions,
                    limitations: Vec<Limitation>,
                    retrieval: Option<RetrievalReceipt>,
                    supersedes: Option<String>| {
        let (schema, batch_id, idempotency_key, actor) = common("system:coverage");
        CoverageAssessed {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            assessment_id: id.to_string(),
            subject: subject(),
            source_id: source_id.clone(),
            dimensions,
            retrieval_receipt: retrieval,
            limitations,
            supersedes_assessment_id: supersedes,
        }
    };
    let all_yes = || Dimensions {
        source_connected: yes(facts[0].0),
        source_healthy: yes(facts[1].0),
        scope_known: yes(facts[2].0),
        scope_accessible: yes(facts[3].0),
        retention_known: yes(facts[4].0),
        index_current: yes(facts[5].0),
        retrieval_attempted: yes(facts[6].0),
    };
    b.push_body(
        KIND_COVERAGE_ASSESSED,
        &assessed(
            "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a501",
            all_yes(),
            vec![],
            Some(receipt()),
            None,
        ),
    );
    // A basis that is not a committed fact.
    let mut forged = all_yes();
    forged.scope_known.basis_event_ids = vec!["c".repeat(32)];
    b.push_body(
        KIND_COVERAGE_ASSESSED,
        &assessed(
            "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a502",
            forged,
            vec![],
            Some(receipt()),
            None,
        ),
    );
    // A basis that establishes a DIFFERENT dimension.
    let mut crossed = all_yes();
    crossed.scope_known.basis_event_ids = vec![facts[1].0.to_string()];
    b.push_body(
        KIND_COVERAGE_ASSESSED,
        &assessed(
            "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a503",
            crossed,
            vec![],
            Some(receipt()),
            None,
        ),
    );

    // A later assessment supersedes the first, with retention unknown and a
    // limitation saying why.
    let mut narrowed = all_yes();
    narrowed.retention_known = DimensionAssessment {
        state: DimensionState::Unknown,
        basis_event_ids: vec![],
        as_of: "2026-08-09T10:00:00Z".into(),
    };
    b.push_body(
        KIND_COVERAGE_ASSESSED,
        &assessed(
            "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a504",
            narrowed,
            vec![Limitation {
                dimension: Dimension::RetentionKnown,
                reason: "the connector stopped reporting a retention policy".into(),
            }],
            Some(receipt()),
            Some("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a501".into()),
        ),
    );

    // A SOURCE gap over two dimensions, then a partial restoration that
    // narrows it, then the one that closes it.
    let gap = |id: &str, cause: GapCauseKind, dimensions: Vec<Dimension>| {
        let (schema, batch_id, idempotency_key, actor) = common("system:coverage");
        CoverageGap {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            gap_id: id.to_string(),
            subject: subject(),
            source_id: match cause {
                GapCauseKind::Source => Some(source_id.clone()),
                GapCauseKind::ReasoningRuntime => None,
            },
            responsibility_id: None,
            contract_version: None,
            contract_digest: None,
            cause: GapCause {
                kind: cause,
                component: match cause {
                    GapCauseKind::Source => None,
                    GapCauseKind::ReasoningRuntime => Some("claude-cli".into()),
                },
            },
            opened_at: "2026-08-09T11:00:00Z".into(),
            assessment_id: match cause {
                GapCauseKind::Source => Some("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a504".into()),
                GapCauseKind::ReasoningRuntime => None,
            },
            affected_dimensions: dimensions,
            pending_count_at_open: 12,
            reason: "blind past the threshold".into(),
        }
    };
    b.push_body(
        KIND_COVERAGE_GAP,
        &gap(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a01",
            GapCauseKind::Source,
            vec![Dimension::SourceHealthy, Dimension::RetentionKnown],
        ),
    );
    // A runtime gap, and one that tries to claim the source is unhealthy.
    b.push_body(
        KIND_COVERAGE_GAP,
        &gap(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a02",
            GapCauseKind::ReasoningRuntime,
            vec![Dimension::IndexCurrent],
        ),
    );
    b.push_body(
        KIND_COVERAGE_GAP,
        &gap(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a03",
            GapCauseKind::ReasoningRuntime,
            vec![Dimension::SourceHealthy],
        ),
    );

    let restored = |gap_id: &str, dimensions: Vec<Dimension>, assessment: Option<&str>| {
        let (schema, batch_id, idempotency_key, actor) = common("system:coverage");
        CoverageRestored {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            gap_id: gap_id.to_string(),
            restored_at: "2026-08-09T12:00:00Z".into(),
            assessment_id: assessment.map(str::to_string),
            restored_dimensions: dimensions,
            reason: "demonstrated recovery".into(),
        }
    };
    // Partial: source health is back, retention is not — the gap stays open.
    b.push_body(
        KIND_COVERAGE_RESTORED,
        &restored(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a01",
            vec![Dimension::SourceHealthy],
            Some("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a504"),
        ),
    );
    // Restoring something the gap no longer affects.
    b.push_body(
        KIND_COVERAGE_RESTORED,
        &restored(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a01",
            vec![Dimension::SourceHealthy],
            Some("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a504"),
        ),
    );
    // Claiming recovery the cited assessment does not show (retention is
    // `unknown` there, not `yes`).
    b.push_body(
        KIND_COVERAGE_RESTORED,
        &restored(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a01",
            vec![Dimension::RetentionKnown],
            Some("a5a5a5a5a5a5a5a5a5a5a5a5a5a5a504"),
        ),
    );
    // The runtime gap closes without an assessment: nothing about the source
    // changed, so there is nothing to demonstrate about it.
    b.push_body(
        KIND_COVERAGE_RESTORED,
        &restored(
            "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a02",
            vec![Dimension::IndexCurrent],
            None,
        ),
    );

    (
        "coverage",
        "seven dimensions carried by committed facts or explicit limitations; a runtime gap \
         that cannot touch source health; partial restoration that narrows without closing; \
         and every bootstrap refusal",
        b.frames,
    )
}

/// One endpoint over the conformance fixture's shapes.
fn endpoint(
    assertion_event: &str,
    belief_id: &str,
    revision_event: &str,
    subject: &str,
) -> ConflictCandidateEndpointV1 {
    ConflictCandidateEndpointV1 {
        assertion_event_id: assertion_event.into(),
        belief_id: belief_id.into(),
        belief_revision_event_id: revision_event.into(),
        subject_id: subject.into(),
        predicate: "status".into(),
        value_hash: derive_value_hash(&TypedValue::string("active")).unwrap(),
        scope: Scope::empty(),
        state_stage: StateStage::Unknown,
        valid_time: ValidInterval {
            from: None,
            to: None,
        },
    }
}

/// One candidate, with its endpoints put in the order the id sorted them —
/// which is what a real detector does, because the body is a function of the
/// pair rather than of the order they were found in.
fn candidate(
    left: ConflictCandidateEndpointV1,
    right: ConflictCandidateEndpointV1,
    reason_codes: Vec<ConflictCandidateReason>,
) -> ConflictCandidateDetected {
    let (first, _) = ordered_endpoints(&left, &right).unwrap();
    let (left, right) = if serde_json::to_string(&left).unwrap() == first {
        (left, right)
    } else {
        (right, left)
    };
    let (schema, batch_id, idempotency_key, actor) = common("system:conflict-detector");
    ConflictCandidateDetected {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        comparison_id: derive_comparison_id(&left, &right).unwrap(),
        left,
        right,
        detector_version: "conflict-detector-v1".into(),
        reason_codes,
    }
}

/// `conflict.candidate_detected` — the pairs handed to M27 (M26.7).
///
/// The first event to create a `comparison`, which is why this vector's job
/// is mostly to prove what a comparison may be MADE of. An endpoint claims
/// three things — an assertion was recorded, a Belief revision exists, and
/// that revision's basis used that assertion — and the last is the one worth
/// a vector: without it, any assertion could be pinned to any Belief and the
/// resulting `comparison_id` would be perfectly stable and completely
/// meaningless.
///
/// The duplicate vector is the deduplication half. An exact retry never
/// reaches the reducer — the writer's idempotency key returns the existing
/// receipt — so a second `conflict.candidate_detected` arriving here is a
/// duplicate append and is refused, and the comparison stays at v1.
fn scenario_conflict() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let josef = human_registration("human:josef");
    let josef_reg = b.push_body(KIND_SOURCE_REGISTERED, &josef);
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec!["Acme Corp".into()],
    };

    let one = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject.clone(),
            vec![],
            human_payload(AssertionBasis::Firsthand),
        ),
    );
    let two = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject.clone(),
            vec![],
            human_payload(AssertionBasis::Reported),
        ),
    );
    // A third assertion nothing ever rests a Belief on — the counterexample
    // the "basis never named it" refusal needs.
    let orphan = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject,
            vec![],
            human_payload(AssertionBasis::Inferred),
        ),
    );

    let linked = |observation: &str| BeliefBasis::Linked {
        links: vec![BasisLink {
            observation_event_id: observation.to_string(),
            role: BasisRole::Supports,
        }],
    };
    let first = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, linked(&one)),
    );
    let second = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY, linked(&two)),
    );

    let left = endpoint(&one, BELIEF, &first, ENTITY);
    let right = endpoint(&two, BELIEF_B, &second, ENTITY);
    let detected = candidate(
        left.clone(),
        right.clone(),
        vec![
            ConflictCandidateReason::IncompatibleValueHash,
            ConflictCandidateReason::SameSubjectPredicate,
        ],
    );
    b.push_body(KIND_CONFLICT_CANDIDATE_DETECTED, &detected);

    // A second event for the same pair. The comparison stays at v1.
    b.push_body(KIND_CONFLICT_CANDIDATE_DETECTED, &detected);

    // An id that does not follow from the endpoints it summarizes — refused
    // structurally, before any state is consulted.
    let mut forged = detected.clone();
    forged.comparison_id = "0".repeat(32);
    b.push_body(KIND_CONFLICT_CANDIDATE_DETECTED, &forged);

    // An assertion the store never recorded.
    b.push_body(
        KIND_CONFLICT_CANDIDATE_DETECTED,
        &candidate(
            endpoint(&"9".repeat(32), BELIEF, &first, ENTITY),
            right.clone(),
            vec![ConflictCandidateReason::SameSubjectPredicate],
        ),
    );

    // A revision that belongs to the other Belief.
    b.push_body(
        KIND_CONFLICT_CANDIDATE_DETECTED,
        &candidate(
            endpoint(&one, BELIEF, &second, ENTITY),
            right.clone(),
            vec![ConflictCandidateReason::SameSubjectPredicate],
        ),
    );

    // A subject that is not the entity the Belief is about.
    b.push_body(
        KIND_CONFLICT_CANDIDATE_DETECTED,
        &candidate(
            endpoint(&one, BELIEF, &first, ENTITY_B),
            right.clone(),
            vec![ConflictCandidateReason::SameSubjectPredicate],
        ),
    );

    // The load-bearing one: a real assertion, a real revision, and a basis
    // that never named it.
    b.push_body(
        KIND_CONFLICT_CANDIDATE_DETECTED,
        &candidate(
            endpoint(&orphan, BELIEF, &first, ENTITY),
            right,
            vec![ConflictCandidateReason::SameSubjectPredicate],
        ),
    );

    (
        "conflict",
        "detected comparisons: the pair created at v1, the duplicate append that leaves it \
         there, a forged id, and every endpoint that cannot earn its assertion, revision, \
         subject, or basis reference",
        b.frames,
    )
}

/// One `freshness.transitioned` body over a facet.
fn transition(
    belief_id: &str,
    revision_event: &str,
    predicate: FacetPredicate,
    state_stage: StateStage,
    from: Freshness,
    to: Freshness,
    effective_at: &str,
) -> FreshnessTransitioned {
    let (schema, batch_id, idempotency_key, actor) = common("system:freshness");
    let rule_version = "freshness-v1".to_string();
    let dedupe_key = derive_freshness_dedupe_key(
        revision_event,
        &predicate,
        state_stage,
        effective_at,
        &rule_version,
    )
    .unwrap();
    FreshnessTransitioned {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        facet: BeliefFacetKey {
            belief_id: belief_id.into(),
            belief_revision_event_id: revision_event.into(),
            predicate,
            state_stage,
        },
        from,
        to,
        effective_at: effective_at.into(),
        rule_version,
        dedupe_key,
    }
}

/// `freshness.transitioned` — the crossing, recorded (M27.1).
///
/// The three properties that need a cross-language vector rather than a Rust
/// test, because a TypeScript reducer can get each of them wrong in a way
/// that looks right:
///
/// - **an exact retry changes NOTHING**, including the Belief version. The
///   timer and launch catch-up both emit every due transition, so this is the
///   ordinary case rather than an edge; an implementation that refused it
///   would fill a real ledger with anomalies, and one that re-applied it
///   would double-count every version.
/// - **the same dedupe key with a different `from`/`to` is a hard conflict.**
///   Those two fields are the only content the key does not cover, so a
///   disagreement about them is two producers disagreeing about what
///   happened — the one thing deduplication must not hide.
/// - **continuity**: a transition claiming to start from a state the facet
///   was not in is refused. The reducer does not derive freshness, so this
///   chain is the only thing keeping the recorded history honest.
///
/// A second facet on the SAME revision, at a different stage, proves the key
/// is the facet and not the belief: two rows, two independent histories, one
/// revision.
fn scenario_freshness() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let josef = human_registration("human:josef");
    let josef_reg = b.push_body(KIND_SOURCE_REGISTERED, &josef);
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec!["Acme Corp".into()],
    };
    let assertion = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject,
            vec![],
            human_payload(AssertionBasis::Firsthand),
        ),
    );
    let created = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(
            BELIEF,
            ENTITY,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: assertion,
                    role: BasisRole::Supports,
                }],
            },
        ),
    );

    let ci = FacetPredicate::Known {
        value: "ci_status".into(),
    };
    let went_stale = transition(
        BELIEF,
        &created,
        ci.clone(),
        StateStage::Implemented,
        Freshness::Fresh,
        Freshness::Stale,
        "2026-08-12T09:00:00.000Z",
    );
    // Belief v1 -> v2.
    b.push_body(KIND_FRESHNESS_TRANSITIONED, &went_stale);

    // The retry the design asks for: identical bytes, no effect at all. The
    // Belief stays at v2 and there is no refusal.
    b.push_body(KIND_FRESHNESS_TRANSITIONED, &went_stale);

    // The same key, a different story. Refused: dedupe covers what was DUE,
    // never what happened.
    let mut disagreeing = went_stale.clone();
    disagreeing.from = Freshness::Unknown;
    b.push_body(KIND_FRESHNESS_TRANSITIONED, &disagreeing);

    // Continuity: this facet is stale, and a transition that says it was
    // fresh does not meet the chain.
    b.push_body(
        KIND_FRESHNESS_TRANSITIONED,
        &transition(
            BELIEF,
            &created,
            ci.clone(),
            StateStage::Implemented,
            Freshness::Fresh,
            Freshness::Unknown,
            "2026-08-13T09:00:00.000Z",
        ),
    );

    // Newer evidence, so the same facet is fresh again — AT the new anchor,
    // which is EARLIER than the boundary it went stale on. Deliberate: a
    // retroactively-stamped source can do exactly this, and a monotonicity
    // rule would have to read the wall clock to forbid it.
    b.push_body(
        KIND_FRESHNESS_TRANSITIONED,
        &transition(
            BELIEF,
            &created,
            ci,
            StateStage::Implemented,
            Freshness::Stale,
            Freshness::Fresh,
            "2026-08-12T08:00:00.000Z",
        ),
    );

    // A second facet on the SAME revision: different stage, own history.
    b.push_body(
        KIND_FRESHNESS_TRANSITIONED,
        &transition(
            BELIEF,
            &created,
            FacetPredicate::Known {
                value: "ci_status".into(),
            },
            StateStage::Shipping,
            Freshness::Fresh,
            Freshness::Stale,
            "2026-08-12T09:00:00.000Z",
        ),
    );

    // A revision that belongs to no Belief at all.
    b.push_body(
        KIND_FRESHNESS_TRANSITIONED,
        &transition(
            BELIEF,
            &"9".repeat(32),
            FacetPredicate::Unknown,
            StateStage::Unknown,
            Freshness::Fresh,
            Freshness::Stale,
            "2026-08-12T09:00:00.000Z",
        ),
    );

    // A transition that changed nothing — refused structurally, before state
    // is consulted at all.
    b.push_body(
        KIND_FRESHNESS_TRANSITIONED,
        &transition(
            BELIEF,
            &created,
            FacetPredicate::Unknown,
            StateStage::Unknown,
            Freshness::Stale,
            Freshness::Stale,
            "2026-08-12T09:00:00.000Z",
        ),
    );

    // A dedupe key that does not follow from the body it summarizes.
    let mut forged = transition(
        BELIEF,
        &created,
        FacetPredicate::Unknown,
        StateStage::Unknown,
        Freshness::Fresh,
        Freshness::Stale,
        "2026-08-12T09:00:00.000Z",
    );
    forged.dedupe_key = "0".repeat(32);
    b.push_body(KIND_FRESHNESS_TRANSITIONED, &forged);

    (
        "freshness",
        "recorded freshness crossings: one facet going stale and coming back at an earlier \
         effective time, the exact retry that changes nothing, the same dedupe key telling a \
         different story, a broken chain, a second facet on the same revision, and every \
         structural refusal",
        b.frames,
    )
}

/// The resolution pipeline (M27.3) — five kinds, and the point of all five is
/// that most candidates are NOT contradictions.
///
/// What needs a cross-language vector rather than a Rust test:
///
/// - **a RESOLVED verdict opens nothing and advances only its comparison.**
///   An implementation that bumped the endpoint Beliefs here would drift every
///   CAS in the store by one on the ordinary path, since resolution is the
///   ordinary outcome.
/// - **an unresolved verdict and its edge are one batch.** The comparison
///   reaches v3 and each DISTINCT endpoint Belief advances once; a crash can
///   expose neither half alone.
/// - **the close travels with the mutation that addressed it.** A standalone
///   close refuses, because there is no caller-authored close path at all.
/// - **a closed edge never reopens**, and a comparison is classified once.
/// - **the outcome/provenance/reason matrix**, both ways round: a
///   deterministic rule may not claim `same_meaning`, and an agent may not
///   claim `resolved_by_stage`.
fn scenario_contradiction() -> (&'static str, &'static str, Vec<Frame>) {
    let mut b = Builder::new();
    let josef = human_registration("human:josef");
    let josef_reg = b.push_body(KIND_SOURCE_REGISTERED, &josef);
    let subject = SubjectRef::Resolved {
        entity_id: ENTITY.into(),
        aliases: vec!["Acme Corp".into()],
    };
    let assert_one = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject.clone(),
            vec![],
            human_payload(AssertionBasis::Firsthand),
        ),
    );
    let assert_two = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject.clone(),
            vec![],
            human_payload(AssertionBasis::Reported),
        ),
    );
    let assert_three = b.push_body(
        KIND_OBSERVATION_RECORDED,
        &observation_body(
            ObservationKind::HumanAssertion,
            &josef,
            &josef_reg,
            "human:josef",
            subject,
            vec![],
            human_payload(AssertionBasis::Inferred),
        ),
    );

    let linked = |observation: &str| BeliefBasis::Linked {
        links: vec![BasisLink {
            observation_event_id: observation.to_string(),
            role: BasisRole::Supports,
        }],
    };
    let first = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF, ENTITY, linked(&assert_one)),
    );
    let second = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_B, ENTITY, linked(&assert_two)),
    );
    // A third Belief on the same entity, so the second comparison is a
    // genuinely different pair rather than a re-run of the first.
    let third = b.push_body(
        KIND_BELIEF_CREATED,
        &belief_body(BELIEF_C, ENTITY, linked(&assert_three)),
    );

    let resolved_pair = candidate(
        endpoint(&assert_one, BELIEF, &first, ENTITY),
        endpoint(&assert_two, BELIEF_B, &second, ENTITY),
        vec![ConflictCandidateReason::SameSubjectPredicate],
    );
    let open_pair = candidate(
        endpoint(&assert_two, BELIEF_B, &second, ENTITY),
        endpoint(&assert_three, BELIEF_C, &third, ENTITY),
        vec![ConflictCandidateReason::IncompatibleValueHash],
    );
    // A third pair, so the agent-supplied control owns a comparison outright
    // rather than racing the deterministic verdicts above for one.
    let semantic_pair = candidate(
        endpoint(&assert_one, BELIEF, &first, ENTITY),
        endpoint(&assert_three, BELIEF_C, &third, ENTITY),
        vec![ConflictCandidateReason::SameSubjectPredicate],
    );
    b.push_body(KIND_CONFLICT_CANDIDATE_DETECTED, &resolved_pair);
    b.push_body(KIND_CONFLICT_CANDIDATE_DETECTED, &open_pair);
    b.push_body(KIND_CONFLICT_CANDIDATE_DETECTED, &semantic_pair);

    // --- the ordinary outcome: resolved apart, and nothing opens -----------
    let resolved = classified_body(
        &resolved_pair,
        ConflictOutcome::ResolvedByStage,
        Classification::Deterministic {
            rule_version: "gauntlet-v1".into(),
        },
        vec![ConflictReasonCode::StageDisjoint],
        vec![],
    );
    let resolved_event = b.push_body(KIND_CONFLICT_CLASSIFIED, &resolved);

    // A second verdict about the same comparison: refused. `edge_id` carries
    // the kind, so a reclassification would open a SECOND edge.
    b.push_body(
        KIND_CONFLICT_CLASSIFIED,
        &classified_body(
            &resolved_pair,
            ConflictOutcome::GenuineDirect,
            Classification::Deterministic {
                rule_version: "gauntlet-v1".into(),
            },
            vec![ConflictReasonCode::IncompatibleValues],
            vec![],
        ),
    );

    // An edge over a pair the gauntlet resolved apart — the crying-wolf
    // failure, refused at the reducer.
    b.push_body(
        KIND_CONTRADICTION_OPENED,
        &opened_body(&resolved_pair, EdgeKind::Partial, &resolved_event),
    );

    // A classification of a pair nobody put forward.
    let mut orphan = resolved.clone();
    orphan.comparison_id = "0".repeat(32);
    b.push_body(KIND_CONFLICT_CLASSIFIED, &orphan);

    // The same two endpoints, swapped: the same pair as a SET, and not the
    // comparison anybody registered.
    let mut swapped = classified_body(
        &open_pair,
        ConflictOutcome::ResolvedByScope,
        Classification::Deterministic {
            rule_version: "gauntlet-v1".into(),
        },
        vec![ConflictReasonCode::ScopeDisjoint],
        vec![],
    );
    std::mem::swap(&mut swapped.left, &mut swapped.right);
    b.push_body(KIND_CONFLICT_CLASSIFIED, &swapped);

    // --- the matrix, both ways round --------------------------------------
    // A deterministic rule claiming a semantic judgement.
    b.push_body(
        KIND_CONFLICT_CLASSIFIED,
        &classified_body(
            &open_pair,
            ConflictOutcome::SameMeaning,
            Classification::Deterministic {
                rule_version: "gauntlet-v1".into(),
            },
            vec![ConflictReasonCode::SemanticSameMeaning],
            vec![],
        ),
    );
    // An agent claiming a typed comparison over recorded qualifiers.
    b.push_body(
        KIND_CONFLICT_CLASSIFIED,
        &classified_body(
            &open_pair,
            ConflictOutcome::ResolvedByStage,
            Classification::AgentSupplied {
                proposal_id: "1111111111111111111111111111111a".into(),
                model_id: "claude-opus-5".into(),
                prompt_version: "classify-conflict-v1".into(),
            },
            vec![ConflictReasonCode::StageDisjoint],
            vec![assert_one.clone()],
        ),
    );

    // --- the verdict that DOES arrive through review (M27.4d) --------------
    // The control for everything above: an agent-supplied classification with
    // its proposal committed, its attribution matching, and its question the
    // one that was asked. Without this the refusals would all pass against an
    // engine that refused every semantic verdict.
    let credited = |model: &str| Classification::AgentSupplied {
        proposal_id: SEMANTIC_PROPOSAL.into(),
        model_id: model.into(),
        prompt_version: "classify-conflict-v1".into(),
    };
    b.push_body(
        KIND_PROPOSAL_SUBMITTED,
        &classify_submission(
            SEMANTIC_PROPOSAL,
            &semantic_pair.comparison_id,
            ConflictOutcome::SameMeaning,
            &assert_one,
        ),
    );
    // Crediting a different model keeps the review and loses the credit.
    b.push_body(
        KIND_CONFLICT_CLASSIFIED,
        &classified_body(
            &semantic_pair,
            ConflictOutcome::SameMeaning,
            credited("some-other-model"),
            vec![ConflictReasonCode::SemanticSameMeaning],
            vec![assert_one.clone()],
        ),
    );
    // Answering a question nobody asked.
    b.push_body(
        KIND_CONFLICT_CLASSIFIED,
        &classified_body(
            &semantic_pair,
            ConflictOutcome::GenuineDirect,
            credited("claude-opus-5"),
            vec![ConflictReasonCode::IncompatibleValues],
            vec![assert_one.clone()],
        ),
    );
    // And the one that applies: same question, same attribution, evidence
    // behind it. `same_meaning` is resolved, so no edge follows.
    b.push_body(
        KIND_CONFLICT_CLASSIFIED,
        &classified_body(
            &semantic_pair,
            ConflictOutcome::SameMeaning,
            credited("claude-opus-5"),
            vec![ConflictReasonCode::SemanticSameMeaning],
            vec![assert_one.clone()],
        ),
    );

    // --- the unresolved half: one batch, both events -----------------------
    let unresolved = classified_body(
        &open_pair,
        ConflictOutcome::GenuineDirect,
        Classification::Deterministic {
            rule_version: "gauntlet-v1".into(),
        },
        vec![ConflictReasonCode::IncompatibleValues],
        vec![],
    );
    let classify_event = format!("{:032x}", b.frames.len() + 1);
    let edge = opened_body(&open_pair, EdgeKind::GenuineDirect, &classify_event);
    b.push_batch(
        "b0000000000000000000000000000001",
        vec![
            (
                KIND_CONFLICT_CLASSIFIED.to_string(),
                serde_json::to_value(&unresolved).unwrap(),
            ),
            (
                KIND_CONTRADICTION_OPENED.to_string(),
                serde_json::to_value(&edge).unwrap(),
            ),
        ],
        true,
        None,
    );

    // A second open of the same edge: exact replay is deduplicated at the
    // door, so one reaching the reducer is a duplicate append.
    b.push_body(KIND_CONTRADICTION_OPENED, &edge);

    // --- closing, and the two ways it must not happen ----------------------
    let close = |addressed_by: &str| ContradictionClosed {
        schema: BODY_SCHEMA,
        batch_id: None,
        idempotency_key: None,
        actor: Actor {
            id: "agent:run-1".into(),
        },
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        edge_id: edge.edge_id.clone(),
        comparison_id: open_pair.comparison_id.clone(),
        left_belief_id: open_pair.left.belief_id.clone(),
        right_belief_id: open_pair.right.belief_id.clone(),
        addressed_by_event_id: addressed_by.into(),
        evidence_event_ids: vec![assert_two.clone()],
        disposition: CloseDisposition::ResolvedWithEvidence,
    };
    // Standalone: nothing addressed anything.
    b.push_body(KIND_CONTRADICTION_CLOSED, &close(&assert_one));

    // Batched with the mutation whose preallocated id it names.
    let addressing = format!("{:032x}", b.frames.len() + 1);
    b.push_batch(
        "b0000000000000000000000000000002",
        vec![
            (
                KIND_BELIEF_REVISED.to_string(),
                serde_json::to_value(addressing_revision("active", "retired")).unwrap(),
            ),
            (
                KIND_CONTRADICTION_CLOSED.to_string(),
                serde_json::to_value(close(&addressing)).unwrap(),
            ),
        ],
        true,
        None,
    );

    // And it never reopens.
    let reclose = format!("{:032x}", b.frames.len() + 1);
    b.push_batch(
        "b0000000000000000000000000000003",
        vec![
            (
                KIND_BELIEF_REVISED.to_string(),
                serde_json::to_value(addressing_revision("retired", "revived")).unwrap(),
            ),
            (
                KIND_CONTRADICTION_CLOSED.to_string(),
                serde_json::to_value(close(&reclose)).unwrap(),
            ),
        ],
        true,
        None,
    );

    // --- the declared road in ----------------------------------------------
    let supersedes = b.push_body(
        KIND_BELIEF_RELATION,
        &relation_body(
            BELIEF,
            BELIEF_C,
            RelationKind::Supersedes,
            RelationAction::Add,
        ),
    );
    let contradicts = b.push_body(
        KIND_BELIEF_RELATION,
        &relation_body(
            BELIEF,
            BELIEF_C,
            RelationKind::Contradicts,
            RelationAction::Add,
        ),
    );
    // A conflict nobody declared: the relation is a `supersedes`.
    b.push_body(
        KIND_CONFLICT_COMPARISON_REGISTERED,
        &registration_of(&supersedes, (BELIEF, &first), (BELIEF_C, &third)),
    );
    let declared = registration_of(&contradicts, (BELIEF, &first), (BELIEF_C, &third));
    b.push_body(KIND_CONFLICT_COMPARISON_REGISTERED, &declared);
    // Registered once: a second is a duplicate append.
    b.push_body(KIND_CONFLICT_COMPARISON_REGISTERED, &declared);

    // --- the checkpoint ----------------------------------------------------
    let marker =
        |through: &str, seen: u64, resolved: u64, opened: u64| ContradictionBackfillCompleted {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "system:contradiction-backfill".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            through_event_id: through.into(),
            source_relation_count: seen,
            resolved_count: resolved,
            opened_count: opened,
            rule_version: "contradiction-backfill-v1".into(),
        };
    b.push_body(
        KIND_CONTRADICTION_BACKFILL_COMPLETED,
        &marker(&contradicts, 4, 3, 1),
    );
    // The same coverage claimed twice.
    b.push_body(
        KIND_CONTRADICTION_BACKFILL_COMPLETED,
        &marker(&contradicts, 4, 3, 1),
    );
    // A marker that does not add up — refused structurally.
    b.push_body(
        KIND_CONTRADICTION_BACKFILL_COMPLETED,
        &marker(&supersedes, 9, 3, 1),
    );
    // A later checkpoint that saw FEWER relations: a run that lost its place.
    b.push_body(
        KIND_CONTRADICTION_BACKFILL_COMPLETED,
        &marker(&supersedes, 2, 2, 0),
    );
    // Progress.
    b.push_body(
        KIND_CONTRADICTION_BACKFILL_COMPLETED,
        &marker(&supersedes, 9, 7, 2),
    );

    (
        "contradiction",
        "the resolution pipeline: a resolved verdict that opens nothing, an unresolved one \
         batched with its edge, the close that must travel with its mutation, the matrix both \
         ways round, the declared road in, and a checkpoint that refuses the same coverage twice",
        b.frames,
    )
}

/// The mutation a close rides with. Any mutation will do at this layer — the
/// reducer's rule is that the close names a member of its own batch, and
/// M27.4 is what makes that member an ADDRESSING one.
fn addressing_revision(before: &str, after: &str) -> BeliefRevised {
    revised_body(
        BELIEF_B,
        vec![PatchOp {
            field_path: "/fields/status".into(),
            before: TypedValue::string(before),
            after: TypedValue::string(after),
        }],
        BeliefBasis::Unsupported {
            reason: "the addressing mutation this close rides with".into(),
        },
    )
}

/// One `conflict.classified` body over a detected pair.
fn classified_body(
    pair: &ConflictCandidateDetected,
    outcome: ConflictOutcome,
    classification: Classification,
    reason_codes: Vec<ConflictReasonCode>,
    evidence_event_ids: Vec<String>,
) -> ConflictClassified {
    let (schema, batch_id, idempotency_key, actor) = common("system:conflict-classifier");
    ConflictClassified {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        comparison_id: pair.comparison_id.clone(),
        left: ConflictEndpoint::Asserted {
            endpoint: pair.left.clone(),
        },
        right: ConflictEndpoint::Asserted {
            endpoint: pair.right.clone(),
        },
        outcome,
        classification,
        evidence_event_ids,
        reason_codes,
        classified_at: "2026-08-12T09:00:00.000Z".into(),
    }
}

fn opened_body(
    pair: &ConflictCandidateDetected,
    kind: EdgeKind,
    classified_event_id: &str,
) -> ContradictionOpened {
    let (schema, batch_id, idempotency_key, actor) = common("system:conflict-classifier");
    ContradictionOpened {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        edge_id: derive_edge_id(&pair.comparison_id, kind),
        comparison_id: pair.comparison_id.clone(),
        left: ConflictEndpoint::Asserted {
            endpoint: pair.left.clone(),
        },
        right: ConflictEndpoint::Asserted {
            endpoint: pair.right.clone(),
        },
        kind,
        classified_event_id: classified_event_id.into(),
    }
}

/// A declared registration over one relation event, endpoints in the order
/// the id sorted them.
fn registration_of(
    relation_event: &str,
    left: (&str, &str),
    right: (&str, &str),
) -> ConflictComparisonRegistered {
    let build = |belief: &str, revision: &str| DeclaredRelationEndpoint {
        relation_event_id: relation_event.to_string(),
        belief_id: belief.into(),
        belief_revision_event_id: revision.into(),
        relation_origin: RelationOrigin::LegacyMigration,
        subject_id: ENTITY.into(),
        content_hash: crate::ledger::sha256_hex(belief.as_bytes()),
        scope: KnownScope::Unknown,
        state_stage: KnownStage::Unknown,
        valid_time: KnownValidTime::Unknown,
    };
    let (left, right) = (build(left.0, left.1), build(right.0, right.1));
    let (first, _) = ordered_declared_endpoints(&left, &right).unwrap();
    let (left, right) = if serde_json::to_string(&left).unwrap() == first {
        (left, right)
    } else {
        (right, left)
    };
    let (schema, batch_id, idempotency_key, actor) = common("system:contradiction-backfill");
    ConflictComparisonRegistered {
        schema,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        comparison_id: derive_declared_comparison_id(relation_event, &left, &right).unwrap(),
        left,
        right,
        source_relation_event_id: relation_event.to_string(),
        reason: ConflictReasonCode::DeclaredContradictsRelation,
        rule_version: "contradiction-backfill-v1".into(),
    }
}

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
        scenario_overrides(),
        scenario_projection_identity(),
        scenario_reconciliation(),
        scenario_capture(),
        scenario_governance(),
        scenario_proposals(),
        scenario_entity_merge(),
        scenario_ingest(),
        scenario_semantic(),
        scenario_coverage(),
        scenario_conflict(),
        scenario_freshness(),
        scenario_contradiction(),
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
        KIND_PROJECTION_OVERRIDDEN,
        KIND_LEDGER_DIVERGENCE,
        KIND_RECONCILIATION_RESOLVED,
        // The M24 kinds. `governance.json` and `proposals.json` exercised
        // them from the day they shipped; the list simply had not been
        // extended, which made a test whose message says "all twelve M22
        // kinds plus the three M23 kinds" quietly stop meaning what it said.
        KIND_BELIEF_QUALIFICATION_CHANGED,
        KIND_BELIEF_LIFECYCLE_CHANGED,
        KIND_BELIEF_TOMBSTONED,
        KIND_BELIEF_CONTESTED,
        KIND_ENTITY_MERGED,
        KIND_PROPOSAL_SUBMITTED,
        KIND_PROPOSAL_QUEUED,
        KIND_PROPOSAL_DECISION_RECORDED,
        KIND_PROPOSAL_APPLIED,
        KIND_PROPOSAL_REJECTED,
        // M25.
        KIND_INGEST_ASSESSED,
        KIND_COVERAGE_FACT_RECORDED,
        KIND_COVERAGE_ASSESSED,
        KIND_COVERAGE_GAP,
        KIND_COVERAGE_RESTORED,
        // M26.
        KIND_INGEST_SEMANTIC_ASSESSED,
        // M26.7 — `conflict.json` has exercised this since it shipped; the
        // list had simply not been extended, which is the same quiet drift
        // the M24 note above records.
        KIND_CONFLICT_CANDIDATE_DETECTED,
        // M27.
        KIND_FRESHNESS_TRANSITIONED,
    ] {
        assert!(kinds.contains(kind), "no vector exercises {kind}");
    }
    // Gaps are WRITTEN DOWN, not inferred from a missing list entry — the
    // same rule `PREDICATE_OWNERS` follows in the policy layer. A kind here
    // is one whose Rust/TS parity is genuinely unproven, and the assertion
    // below makes the two lists together exhaustive, so a NEW kind cannot be
    // quietly omitted from both.
    for kind in KINDS_WITHOUT_VECTORS {
        assert!(
            !kinds.contains(kind),
            "{kind} now HAS a vector — take it off the gap list"
        );
    }
}

/// Kinds this build can decode and no vector exercises.
///
/// `proposal.reverted` is reachable only through the M24.9 review surface's
/// revert path, which builds its forward mutation from live reducer state; a
/// vector for it needs a whole applied-then-reverted commit set, and that is
/// M27's contradiction work's neighbourhood rather than M25's. Recorded here
/// so it is a known gap rather than an absence nobody noticed.
const KINDS_WITHOUT_VECTORS: [&str; 1] = [KIND_PROPOSAL_REVERTED];

/// Every kind is either exercised by a vector or named as a gap. This is the
/// assertion that keeps the list above honest as the vocabulary grows.
#[test]
fn every_kind_is_either_covered_or_a_named_gap() {
    let mut covered = std::collections::BTreeSet::new();
    for (_, _, frames) in scenarios() {
        for frame in &frames {
            covered.insert(frame.kind.clone());
        }
    }
    for kind in ALL_KINDS {
        assert!(
            covered.contains(*kind) || KINDS_WITHOUT_VECTORS.contains(kind),
            "{kind} has no vector and is not a declared gap"
        );
    }
}

/// The whole decodable vocabulary, in declaration order.
///
/// Hand-maintained, and that is the one gap this pair of tests cannot close:
/// a new kind added to `decode_body` and omitted HERE is invisible to both
/// assertions. Adding to this list is therefore part of adding a kind, not a
/// follow-up — the length is implicit so at least the count cannot drift out
/// of step with the entries.
const ALL_KINDS: &[&str] = &[
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
    KIND_PROJECTION_OVERRIDDEN,
    KIND_LEDGER_DIVERGENCE,
    KIND_RECONCILIATION_RESOLVED,
    KIND_BELIEF_QUALIFICATION_CHANGED,
    KIND_BELIEF_LIFECYCLE_CHANGED,
    KIND_BELIEF_TOMBSTONED,
    KIND_BELIEF_CONTESTED,
    KIND_ENTITY_MERGED,
    KIND_PROPOSAL_SUBMITTED,
    KIND_PROPOSAL_QUEUED,
    KIND_PROPOSAL_DECISION_RECORDED,
    KIND_PROPOSAL_APPLIED,
    KIND_PROPOSAL_REJECTED,
    KIND_PROPOSAL_REVERTED,
    KIND_INGEST_ASSESSED,
    KIND_COVERAGE_FACT_RECORDED,
    KIND_COVERAGE_ASSESSED,
    KIND_COVERAGE_GAP,
    KIND_COVERAGE_RESTORED,
    KIND_INGEST_SEMANTIC_ASSESSED,
];
