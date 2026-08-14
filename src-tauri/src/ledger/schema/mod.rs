//! Event schema v1 (M22.1): the ledger's permanent epistemic vocabulary.
//!
//! LOCATION CHOICE (the plan offered `ledger/schema.rs` or
//! `epistemic/schema.rs`): this lives under `ledger/` because the schema IS
//! the ledger's body vocabulary — the frame envelope stays in `frame.rs`,
//! bodies gain meaning here, and nothing outside the ledger module may
//! define event bodies. It is a directory module purely for file size; the
//! public surface is this `mod.rs`.
//!
//! THE STRUCT IS THE CANON, again: canonical body JSON is exactly what
//! serde emits for these types, fields in declaration order. `decode_body`
//! enforces it with a byte round-trip gate — parse typed, re-serialize,
//! compare — so unknown fields, reordered keys, duplicate keys, and
//! non-canonical number spellings are all refused at the door, including
//! inside the flattened unions where serde's `deny_unknown_fields` cannot
//! reach. A body this module did not (or would not) write is not schema-v1.
//!
//! Version discipline: the frame envelope stays `v: 0` (`FRAME_VERSION`);
//! event vocabulary versioning is the body field `schema: 1`. A plumbing
//! body without a `schema` key remains valid and indexable but creates no
//! epistemic entity state. Additive-only from here: no field is ever
//! renamed or repurposed; deprecation means stop emitting, keep reducing.

pub mod batch;
pub mod belief;
pub mod conflict;
pub mod contradiction;
pub mod coverage;
pub mod entity_merge;
pub mod freshness;
pub mod independence;
pub mod ingest;
pub mod lifecycle;
pub mod migration;
pub mod normalize;
pub mod observation;
pub mod ops;
pub mod projection;
pub mod proposal;
pub mod proposal_events;
pub mod reconciliation;
pub mod resolution;
pub mod risk;
pub mod semantic;
pub mod source;
pub mod subject;
pub mod value;

use serde::{Deserialize, Serialize};

pub use batch::BatchCommitted;
pub use belief::{
    derive_relation_id, BasisLink, BasisRole, BeliefAttested, BeliefBasis, BeliefCreated,
    BeliefRelation, BeliefRevised, EntityAliasAdded, PatchOp, RelationAction, RelationKind,
};
pub use conflict::{
    derive_comparison_id, derive_conflict_candidate_key, derive_value_hash, ordered_endpoints,
    ConflictCandidateDetected, ConflictCandidateEndpointV1, ConflictCandidateReason, StateStage,
};
pub use contradiction::{
    check_matrix, derive_contradiction_open_key, derive_declared_comparison_id,
    derive_declared_comparison_key, derive_edge_id, ordered_declared_endpoints, Classification,
    CloseDisposition, ConflictClassified, ConflictComparisonRegistered, ConflictEndpoint,
    ConflictReasonCode, ContradictionBackfillCompleted, ContradictionClosed, ContradictionOpened,
    DeclaredRelationEndpoint, EdgeKind, KnownScope, KnownStage, KnownValidTime, RelationOrigin,
};
pub use coverage::{
    AccessResult, ConnectionResult, CoverageAssessed, CoverageFactRecorded, CoverageGap,
    CoverageRestored, CoverageSubject, CurrentResult, Dimension, DimensionAssessment,
    DimensionState, Dimensions, Fact, GapCause, GapCauseKind, HealthResult, KnownResult,
    Limitation, Producer, ProducerKind, RetrievalReceipt, ACTOR_RETRIEVAL_ENGINE,
    ACTOR_VAULT_INDEXER,
};
pub use entity_merge::{derive_plan_id, EntityMerged, EntityReassignmentPlan, LiveAlias};
pub use freshness::{
    derive_freshness_dedupe_key, derive_freshness_transition_key, BeliefFacetKey, FacetPredicate,
    Freshness, FreshnessTransitioned,
};
pub use independence::{IndependenceProof, IndependenceRecorded};
pub use ingest::{
    derive_item_id, derive_receipt_id, Independence, IngestAssessed, MaterialDimension,
    PrefilterVerdict, Route,
};
pub use lifecycle::{
    BeliefContested, BeliefLifecycleChanged, BeliefQualificationChanged, BeliefTombstoned,
    ContestAction, FieldRole, Lifecycle, LifecycleCause, Qualification, QualificationCause,
    QualificationProfileRef, TombstoneReason,
};
pub use migration::{migrate_id, MigrationCompleted, MigrationStarted};
pub use normalize::normalize_alias_v1;
pub use observation::{
    derive_authority, AbsenceRecord, AssertionBasis, AssertionFields, AssertionKind,
    AuthorityProvenance, DerivedContentPayload, ExtractedAssertionPayload, HumanAssertionForm,
    HumanAssertionPayload, ObservationKind, ObservationPayload, ObservationRecorded, Provenance,
    RelationshipToSubject, Scope, SourceSnapshotPayload, Stage, SubjectRole, SystemEventPayload,
};
pub use ops::{
    AgentObservationDraft, ConflictOutcome, EquivalenceReceipt, EvidenceAssignment, ProposalOp,
    RelationRewrite, RewriteDisposition, RewriteReplacement, SplitOutput, SupersedePair,
    ValidInterval,
};
pub use projection::{
    validate_override_pointer, OverrideChange, OverrideOrigin, OverridePatchOp,
    ProjectionOverridden,
};
pub use proposal::{
    AddressedContradiction, AliasLeg, AuthorityRouteRef, CandidateDecision, CandidateSearchReceipt,
    ConsideredCandidate, ContestAddressing, ContradictionDisposition, ExactLeg, IntendedUse,
    IntendedUseKind, PostVersion, ProposalBasis, ProposalTarget, ProposalV1, RevertPlan,
    RevertStep, ScopedLeg, SemanticLeg, SemanticStatus, TargetClass, TransitionCause,
    PROPOSAL_SCHEMA,
};
pub use proposal_events::{
    Decision, ProposalApplied, ProposalDecisionRecorded, ProposalQueued, ProposalRejected,
    ProposalReverted, ProposalState, ProposalSubmitted, TargetVersion,
};
pub use reconciliation::{
    DivergenceSignal, LedgerDivergence, ReconciliationAction, ReconciliationResolved,
    ACTOR_RECONCILIATION,
};
pub use resolution::{ResolutionChange, ResolverTier, SubjectResolved};
pub use risk::Risk;
pub use semantic::{
    derive_m26_batch_key, derive_semantic_assessment_id, BlockedReason, ContentLabel,
    IngestSemanticAssessed, SemanticDisposition, SemanticOutcome,
};
pub use source::{
    derive_source_id, derive_source_key, AuthorityCapability, SourceRegistered, SourceRegistration,
};
pub use subject::{LineageEdge, LineageKind, SubjectRef};
pub use value::{validate_field_path, TypedValue};

/// Body vocabulary version this module speaks.
pub const BODY_SCHEMA: u64 = 1;

// The M22 kind namespace — additive from here on.
pub const KIND_BATCH_COMMITTED: &str = "batch.committed";
pub const KIND_SOURCE_REGISTERED: &str = "source.registered";
pub const KIND_OBSERVATION_RECORDED: &str = "observation.recorded";
pub const KIND_SUBJECT_RESOLVED: &str = "observation.subject_resolved";
pub const KIND_INDEPENDENCE_RECORDED: &str = "observation.independence_recorded";
pub const KIND_BELIEF_CREATED: &str = "belief.created";
pub const KIND_BELIEF_REVISED: &str = "belief.revised";
pub const KIND_BELIEF_RELATION: &str = "belief.relation";
pub const KIND_BELIEF_ATTESTED: &str = "belief.attested";
pub const KIND_ENTITY_ALIAS_ADDED: &str = "entity.alias_added";
pub const KIND_MIGRATION_STARTED: &str = "migration.started";
pub const KIND_MIGRATION_COMPLETED: &str = "migration.completed";
// The M23 additions — the frame envelope stays `v: 0`.
pub const KIND_PROJECTION_OVERRIDDEN: &str = "projection.overridden";
pub const KIND_LEDGER_DIVERGENCE: &str = "ledger.divergence";
pub const KIND_RECONCILIATION_RESOLVED: &str = "ledger.reconciliation_resolved";

// The M24 additions. `belief.tombstoned` was RESERVED by M22 — the name
// claimed, the body deliberately undefined — and this is that body arriving
// exactly as promised, additively, with the envelope still `v: 0`.
pub const KIND_BELIEF_QUALIFICATION_CHANGED: &str = "belief.qualification_changed";
pub const KIND_BELIEF_LIFECYCLE_CHANGED: &str = "belief.lifecycle_changed";
pub const KIND_BELIEF_TOMBSTONED: &str = "belief.tombstoned";
pub const KIND_BELIEF_CONTESTED: &str = "belief.contested";
pub const KIND_ENTITY_MERGED: &str = "entity.merged";
pub const KIND_PROPOSAL_SUBMITTED: &str = "proposal.submitted";
pub const KIND_PROPOSAL_QUEUED: &str = "proposal.queued";
pub const KIND_PROPOSAL_DECISION_RECORDED: &str = "proposal.decision_recorded";
pub const KIND_PROPOSAL_APPLIED: &str = "proposal.applied";
pub const KIND_PROPOSAL_REJECTED: &str = "proposal.rejected";
pub const KIND_PROPOSAL_REVERTED: &str = "proposal.reverted";

// The M25 additions. `ingest.assessed` is the PORTABLE processing receipt —
// telemetry-free by construction, and structurally excluded from evidence
// lineage and Support (see `ingest.rs`). The coverage vocabulary follows in
// M25.4.
pub const KIND_INGEST_ASSESSED: &str = "ingest.assessed";
pub const KIND_COVERAGE_FACT_RECORDED: &str = "coverage.fact_recorded";
pub const KIND_COVERAGE_ASSESSED: &str = "coverage.assessed";
pub const KIND_COVERAGE_GAP: &str = "coverage.gap";
pub const KIND_COVERAGE_RESTORED: &str = "coverage.restored";

// The M26 addition. `ingest.semantic_assessed` is the successor half of
// `ingest.assessed`: the receipt says an item was PARKED for a semantic
// run, and this says what that run concluded. Processing history on both
// sides of the seam — neither is evidence (see `semantic.rs`).
pub const KIND_INGEST_SEMANTIC_ASSESSED: &str = "ingest.semantic_assessed";

// The M26.7 addition, and the one M27 was waiting for.
// `conflict.candidate_detected` is the deterministic signal that a pair needs
// CLASSIFYING; the classification vocabulary itself is M27's. It is the first
// event to create a `comparison` CAS target, which is why the target class
// has existed since M24 with nothing creating one.
pub const KIND_CONFLICT_CANDIDATE_DETECTED: &str = "conflict.candidate_detected";

// The M27 additions. `freshness.transitioned` is the first: a CROSSING
// recorded, never a clock read. Freshness itself is derived (D9); this event
// is how the moment it changed enters portable history, so a surface can say
// when and a rebuild lands on the same bytes.
pub const KIND_FRESHNESS_TRANSITIONED: &str = "freshness.transitioned";

// The resolution pipeline (M27.3). Five kinds, and the split between the
// first two is the milestone's point: a COMPARISON is a pair somebody thinks
// is worth classifying, and a CLASSIFICATION is what the gauntlet concluded
// about it — including the five conclusions that resolve the pair apart. Only
// the three unresolved ones reach `contradiction.opened`, which is why an
// edge is a much rarer thing than a candidate.
pub const KIND_CONFLICT_COMPARISON_REGISTERED: &str = "conflict.comparison_registered";
pub const KIND_CONFLICT_CLASSIFIED: &str = "conflict.classified";
pub const KIND_CONTRADICTION_OPENED: &str = "contradiction.opened";
pub const KIND_CONTRADICTION_CLOSED: &str = "contradiction.closed";
pub const KIND_CONTRADICTION_BACKFILL_COMPLETED: &str = "contradiction.backfill_completed";

/// Reserved vocabulary: names fixed so nothing else ever claims them, with
/// bodies deliberately undefined — a schema-v1 body under one of these is
/// refused, never guessed at.
///
/// M22 reserved seven. M24.3 defines `belief.tombstoned` and the six
/// `proposal.*` kinds, so the list is now empty and the reservation
/// mechanism stands ready for M27's conflict vocabulary.
pub const RESERVED_KINDS: [&str; 0] = [];

/// Fixed system actor ids the core stamps itself (never caller-supplied).
pub const ACTOR_LEDGER: &str = "system:ledger";
pub const ACTOR_SOURCE_REGISTRY: &str = "system:source-registry";
pub const ACTOR_MIGRATOR: &str = "system:migrator";

/// `{ "id": ... }` — who produced the event. Authority never derives from
/// this label alone (D11): the reducer checks it against registrations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    pub id: String,
}

/// Lowercase-hex check — event ids, batch ids, entity/belief/source ids are
/// 32 chars; SHA-256 digests are 64. Uppercase is not canonical anywhere.
pub(crate) fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn is_id128(s: &str) -> bool {
    is_lower_hex(s, 32)
}

pub(crate) fn is_sha256(s: &str) -> bool {
    is_lower_hex(s, 64)
}

/// First 128 bits of SHA-256 over `bytes`, lowercase hex — the shared shape
/// of every domain-separated derived id in the design.
pub(crate) fn sha256_first128(bytes: &[u8]) -> String {
    let full = super::sha256_hex(bytes);
    full[..32].to_string()
}

/// Canonical JSON = M21's serializer: serde_json, declaration order,
/// preserve_order maps. One definition, used by every digest in this module.
pub(crate) fn canonical_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// Structural checks shared by every schema-v1 body's common metadata.
pub(crate) fn validate_common_fields(
    schema: u64,
    batch_id: Option<&str>,
    idempotency_key: Option<&str>,
    actor: &Actor,
    occurred_at: Option<&str>,
    valid_from: Option<&str>,
    valid_to: Option<&str>,
) -> Result<(), String> {
    if schema != BODY_SCHEMA {
        return Err(format!("unsupported body schema {schema}"));
    }
    if let Some(batch_id) = batch_id {
        if !is_id128(batch_id) {
            return Err(format!("batch_id {batch_id:?} is not a 128-bit hex id"));
        }
    }
    if idempotency_key == Some("") {
        return Err("idempotency_key must be null or non-empty".to_string());
    }
    if actor.id.is_empty() {
        return Err("actor.id must be non-empty".to_string());
    }
    for (name, stamp) in [
        ("occurred_at", occurred_at),
        ("valid_from", valid_from),
        ("valid_to", valid_to),
    ] {
        if let Some(stamp) = stamp {
            if chrono::DateTime::parse_from_rfc3339(stamp).is_err() {
                return Err(format!(
                    "{name} {stamp:?} is not RFC3339 — null, never a guess"
                ));
            }
        }
    }
    Ok(())
}

/// Emits one schema-v1 body struct: the seven common metadata fields in
/// canonical order, then the variant's own fields. `deny_unknown_fields`
/// holds on every body this macro emits (no flatten at body level).
macro_rules! schema_body {
    (
        $(#[$smeta:meta])*
        pub struct $name:ident {
            $(
                $(#[$fmeta:meta])*
                pub $field:ident : $ty:ty,
            )*
        }
    ) => {
        $(#[$smeta])*
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            /// Always 1 in M22 — the frame envelope stays `v: 0`.
            pub schema: u64,
            /// Null for an immediately visible event; the shared 128-bit hex
            /// id for a logical-batch member or its commit marker.
            pub batch_id: Option<String>,
            /// Producer-scoped stable key. Reuse with different canonical
            /// content is a hard conflict, never a silent dedupe.
            pub idempotency_key: Option<String>,
            pub actor: crate::ledger::schema::Actor,
            /// Source-content event time (RFC3339) — labeled, never trusted
            /// for ordering (D3). Null when the source has no honest stamp.
            pub occurred_at: Option<String>,
            pub valid_from: Option<String>,
            pub valid_to: Option<String>,
            $( $(#[$fmeta])* pub $field : $ty, )*
        }

        impl $name {
            pub(crate) fn validate_common(&self) -> Result<(), String> {
                crate::ledger::schema::validate_common_fields(
                    self.schema,
                    self.batch_id.as_deref(),
                    self.idempotency_key.as_deref(),
                    &self.actor,
                    self.occurred_at.as_deref(),
                    self.valid_from.as_deref(),
                    self.valid_to.as_deref(),
                )
            }
        }
    };
}
pub(crate) use schema_body;

/// Every schema-v1 body this build can decode. Boxed where large so the
/// enum stays cheap to move through the reducer.
#[derive(Debug, Clone, PartialEq)]
pub enum EventBody {
    BatchCommitted(Box<BatchCommitted>),
    SourceRegistered(Box<SourceRegistered>),
    ObservationRecorded(Box<ObservationRecorded>),
    SubjectResolved(Box<SubjectResolved>),
    IndependenceRecorded(Box<IndependenceRecorded>),
    BeliefCreated(Box<BeliefCreated>),
    BeliefRevised(Box<BeliefRevised>),
    BeliefRelation(Box<BeliefRelation>),
    BeliefAttested(Box<BeliefAttested>),
    EntityAliasAdded(Box<EntityAliasAdded>),
    MigrationStarted(Box<MigrationStarted>),
    MigrationCompleted(Box<MigrationCompleted>),
    ProjectionOverridden(Box<ProjectionOverridden>),
    LedgerDivergence(Box<LedgerDivergence>),
    ReconciliationResolved(Box<ReconciliationResolved>),
    BeliefQualificationChanged(Box<BeliefQualificationChanged>),
    BeliefLifecycleChanged(Box<BeliefLifecycleChanged>),
    BeliefTombstoned(Box<BeliefTombstoned>),
    BeliefContested(Box<BeliefContested>),
    EntityMerged(Box<EntityMerged>),
    ProposalSubmitted(Box<ProposalSubmitted>),
    ProposalQueued(Box<ProposalQueued>),
    ProposalDecisionRecorded(Box<ProposalDecisionRecorded>),
    ProposalApplied(Box<ProposalApplied>),
    ProposalRejected(Box<ProposalRejected>),
    ProposalReverted(Box<ProposalReverted>),
    IngestAssessed(Box<IngestAssessed>),
    CoverageFactRecorded(Box<CoverageFactRecorded>),
    CoverageAssessed(Box<CoverageAssessed>),
    CoverageGap(Box<CoverageGap>),
    CoverageRestored(Box<CoverageRestored>),
    IngestSemanticAssessed(Box<IngestSemanticAssessed>),
    ConflictCandidateDetected(Box<ConflictCandidateDetected>),
    FreshnessTransitioned(Box<FreshnessTransitioned>),
    ConflictComparisonRegistered(Box<ConflictComparisonRegistered>),
    ConflictClassified(Box<ConflictClassified>),
    ContradictionOpened(Box<ContradictionOpened>),
    ContradictionClosed(Box<ContradictionClosed>),
    ContradictionBackfillCompleted(Box<ContradictionBackfillCompleted>),
}

impl EventBody {
    pub fn kind(&self) -> &'static str {
        match self {
            EventBody::BatchCommitted(_) => KIND_BATCH_COMMITTED,
            EventBody::SourceRegistered(_) => KIND_SOURCE_REGISTERED,
            EventBody::ObservationRecorded(_) => KIND_OBSERVATION_RECORDED,
            EventBody::SubjectResolved(_) => KIND_SUBJECT_RESOLVED,
            EventBody::IndependenceRecorded(_) => KIND_INDEPENDENCE_RECORDED,
            EventBody::BeliefCreated(_) => KIND_BELIEF_CREATED,
            EventBody::BeliefRevised(_) => KIND_BELIEF_REVISED,
            EventBody::BeliefRelation(_) => KIND_BELIEF_RELATION,
            EventBody::BeliefAttested(_) => KIND_BELIEF_ATTESTED,
            EventBody::EntityAliasAdded(_) => KIND_ENTITY_ALIAS_ADDED,
            EventBody::MigrationStarted(_) => KIND_MIGRATION_STARTED,
            EventBody::MigrationCompleted(_) => KIND_MIGRATION_COMPLETED,
            EventBody::ProjectionOverridden(_) => KIND_PROJECTION_OVERRIDDEN,
            EventBody::LedgerDivergence(_) => KIND_LEDGER_DIVERGENCE,
            EventBody::ReconciliationResolved(_) => KIND_RECONCILIATION_RESOLVED,
            EventBody::BeliefQualificationChanged(_) => KIND_BELIEF_QUALIFICATION_CHANGED,
            EventBody::BeliefLifecycleChanged(_) => KIND_BELIEF_LIFECYCLE_CHANGED,
            EventBody::BeliefTombstoned(_) => KIND_BELIEF_TOMBSTONED,
            EventBody::BeliefContested(_) => KIND_BELIEF_CONTESTED,
            EventBody::EntityMerged(_) => KIND_ENTITY_MERGED,
            EventBody::ProposalSubmitted(_) => KIND_PROPOSAL_SUBMITTED,
            EventBody::ProposalQueued(_) => KIND_PROPOSAL_QUEUED,
            EventBody::ProposalDecisionRecorded(_) => KIND_PROPOSAL_DECISION_RECORDED,
            EventBody::ProposalApplied(_) => KIND_PROPOSAL_APPLIED,
            EventBody::ProposalRejected(_) => KIND_PROPOSAL_REJECTED,
            EventBody::ProposalReverted(_) => KIND_PROPOSAL_REVERTED,
            EventBody::IngestAssessed(_) => KIND_INGEST_ASSESSED,
            EventBody::CoverageFactRecorded(_) => KIND_COVERAGE_FACT_RECORDED,
            EventBody::CoverageAssessed(_) => KIND_COVERAGE_ASSESSED,
            EventBody::CoverageGap(_) => KIND_COVERAGE_GAP,
            EventBody::CoverageRestored(_) => KIND_COVERAGE_RESTORED,
            EventBody::IngestSemanticAssessed(_) => KIND_INGEST_SEMANTIC_ASSESSED,
            EventBody::ConflictCandidateDetected(_) => KIND_CONFLICT_CANDIDATE_DETECTED,
            EventBody::FreshnessTransitioned(_) => KIND_FRESHNESS_TRANSITIONED,
            EventBody::ConflictComparisonRegistered(_) => KIND_CONFLICT_COMPARISON_REGISTERED,
            EventBody::ConflictClassified(_) => KIND_CONFLICT_CLASSIFIED,
            EventBody::ContradictionOpened(_) => KIND_CONTRADICTION_OPENED,
            EventBody::ContradictionClosed(_) => KIND_CONTRADICTION_CLOSED,
            EventBody::ContradictionBackfillCompleted(_) => KIND_CONTRADICTION_BACKFILL_COMPLETED,
        }
    }

    pub fn batch_id(&self) -> Option<&str> {
        match self {
            EventBody::BatchCommitted(b) => b.batch_id.as_deref(),
            EventBody::SourceRegistered(b) => b.batch_id.as_deref(),
            EventBody::ObservationRecorded(b) => b.batch_id.as_deref(),
            EventBody::SubjectResolved(b) => b.batch_id.as_deref(),
            EventBody::IndependenceRecorded(b) => b.batch_id.as_deref(),
            EventBody::BeliefCreated(b) => b.batch_id.as_deref(),
            EventBody::BeliefRevised(b) => b.batch_id.as_deref(),
            EventBody::BeliefRelation(b) => b.batch_id.as_deref(),
            EventBody::BeliefAttested(b) => b.batch_id.as_deref(),
            EventBody::EntityAliasAdded(b) => b.batch_id.as_deref(),
            EventBody::MigrationStarted(b) => b.batch_id.as_deref(),
            EventBody::MigrationCompleted(b) => b.batch_id.as_deref(),
            EventBody::ProjectionOverridden(b) => b.batch_id.as_deref(),
            EventBody::LedgerDivergence(b) => b.batch_id.as_deref(),
            EventBody::ReconciliationResolved(b) => b.batch_id.as_deref(),
            EventBody::BeliefQualificationChanged(b) => b.batch_id.as_deref(),
            EventBody::BeliefLifecycleChanged(b) => b.batch_id.as_deref(),
            EventBody::BeliefTombstoned(b) => b.batch_id.as_deref(),
            EventBody::BeliefContested(b) => b.batch_id.as_deref(),
            EventBody::EntityMerged(b) => b.batch_id.as_deref(),
            EventBody::ProposalSubmitted(b) => b.batch_id.as_deref(),
            EventBody::ProposalQueued(b) => b.batch_id.as_deref(),
            EventBody::ProposalDecisionRecorded(b) => b.batch_id.as_deref(),
            EventBody::ProposalApplied(b) => b.batch_id.as_deref(),
            EventBody::ProposalRejected(b) => b.batch_id.as_deref(),
            EventBody::ProposalReverted(b) => b.batch_id.as_deref(),
            EventBody::IngestAssessed(b) => b.batch_id.as_deref(),
            EventBody::CoverageFactRecorded(b) => b.batch_id.as_deref(),
            EventBody::CoverageAssessed(b) => b.batch_id.as_deref(),
            EventBody::CoverageGap(b) => b.batch_id.as_deref(),
            EventBody::CoverageRestored(b) => b.batch_id.as_deref(),
            EventBody::IngestSemanticAssessed(b) => b.batch_id.as_deref(),
            EventBody::ConflictCandidateDetected(b) => b.batch_id.as_deref(),
            EventBody::FreshnessTransitioned(b) => b.batch_id.as_deref(),
            EventBody::ConflictComparisonRegistered(b) => b.batch_id.as_deref(),
            EventBody::ConflictClassified(b) => b.batch_id.as_deref(),
            EventBody::ContradictionOpened(b) => b.batch_id.as_deref(),
            EventBody::ContradictionClosed(b) => b.batch_id.as_deref(),
            EventBody::ContradictionBackfillCompleted(b) => b.batch_id.as_deref(),
        }
    }

    pub fn idempotency_key(&self) -> Option<&str> {
        match self {
            EventBody::BatchCommitted(b) => b.idempotency_key.as_deref(),
            EventBody::SourceRegistered(b) => b.idempotency_key.as_deref(),
            EventBody::ObservationRecorded(b) => b.idempotency_key.as_deref(),
            EventBody::SubjectResolved(b) => b.idempotency_key.as_deref(),
            EventBody::IndependenceRecorded(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefCreated(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefRevised(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefRelation(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefAttested(b) => b.idempotency_key.as_deref(),
            EventBody::EntityAliasAdded(b) => b.idempotency_key.as_deref(),
            EventBody::MigrationStarted(b) => b.idempotency_key.as_deref(),
            EventBody::MigrationCompleted(b) => b.idempotency_key.as_deref(),
            EventBody::ProjectionOverridden(b) => b.idempotency_key.as_deref(),
            EventBody::LedgerDivergence(b) => b.idempotency_key.as_deref(),
            EventBody::ReconciliationResolved(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefQualificationChanged(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefLifecycleChanged(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefTombstoned(b) => b.idempotency_key.as_deref(),
            EventBody::BeliefContested(b) => b.idempotency_key.as_deref(),
            EventBody::EntityMerged(b) => b.idempotency_key.as_deref(),
            EventBody::ProposalSubmitted(b) => b.idempotency_key.as_deref(),
            EventBody::ProposalQueued(b) => b.idempotency_key.as_deref(),
            EventBody::ProposalDecisionRecorded(b) => b.idempotency_key.as_deref(),
            EventBody::ProposalApplied(b) => b.idempotency_key.as_deref(),
            EventBody::ProposalRejected(b) => b.idempotency_key.as_deref(),
            EventBody::ProposalReverted(b) => b.idempotency_key.as_deref(),
            EventBody::IngestAssessed(b) => b.idempotency_key.as_deref(),
            EventBody::CoverageFactRecorded(b) => b.idempotency_key.as_deref(),
            EventBody::CoverageAssessed(b) => b.idempotency_key.as_deref(),
            EventBody::CoverageGap(b) => b.idempotency_key.as_deref(),
            EventBody::CoverageRestored(b) => b.idempotency_key.as_deref(),
            EventBody::IngestSemanticAssessed(b) => b.idempotency_key.as_deref(),
            EventBody::ConflictCandidateDetected(b) => b.idempotency_key.as_deref(),
            EventBody::FreshnessTransitioned(b) => b.idempotency_key.as_deref(),
            EventBody::ConflictComparisonRegistered(b) => b.idempotency_key.as_deref(),
            EventBody::ConflictClassified(b) => b.idempotency_key.as_deref(),
            EventBody::ContradictionOpened(b) => b.idempotency_key.as_deref(),
            EventBody::ContradictionClosed(b) => b.idempotency_key.as_deref(),
            EventBody::ContradictionBackfillCompleted(b) => b.idempotency_key.as_deref(),
        }
    }

    /// Structural validation: everything checkable from the body alone.
    /// `store_uuid` is the store identity (source-id derivation pins to it).
    /// State-dependent rules — committed parents, registration lookups,
    /// staged batch members — belong to the reducer (M22.3), not here.
    pub fn validate(&self, store_uuid: &str) -> Result<(), String> {
        match self {
            EventBody::BatchCommitted(b) => b.validate(),
            EventBody::SourceRegistered(b) => b.validate(store_uuid),
            EventBody::ObservationRecorded(b) => b.validate().map(|_| ()),
            EventBody::SubjectResolved(b) => b.validate(),
            EventBody::IndependenceRecorded(b) => b.validate(),
            EventBody::BeliefCreated(b) => b.validate(),
            EventBody::BeliefRevised(b) => b.validate(),
            EventBody::BeliefRelation(b) => b.validate(),
            EventBody::BeliefAttested(b) => b.validate(),
            EventBody::EntityAliasAdded(b) => b.validate(),
            EventBody::MigrationStarted(b) => b.validate(),
            EventBody::MigrationCompleted(b) => b.validate(),
            EventBody::ProjectionOverridden(b) => b.validate(),
            EventBody::LedgerDivergence(b) => b.validate(),
            EventBody::ReconciliationResolved(b) => b.validate(),
            EventBody::BeliefQualificationChanged(b) => b.validate(),
            EventBody::BeliefLifecycleChanged(b) => b.validate(),
            EventBody::BeliefTombstoned(b) => b.validate(),
            EventBody::BeliefContested(b) => b.validate(),
            EventBody::EntityMerged(b) => b.validate(),
            EventBody::ProposalSubmitted(b) => b.validate(),
            EventBody::ProposalQueued(b) => b.validate(),
            EventBody::ProposalDecisionRecorded(b) => b.validate(),
            EventBody::ProposalApplied(b) => b.validate(),
            EventBody::ProposalRejected(b) => b.validate(),
            EventBody::ProposalReverted(b) => b.validate(),
            EventBody::IngestAssessed(b) => b.validate(),
            EventBody::CoverageFactRecorded(b) => b.validate(),
            EventBody::CoverageAssessed(b) => b.validate(),
            EventBody::CoverageGap(b) => b.validate(),
            EventBody::CoverageRestored(b) => b.validate(),
            EventBody::IngestSemanticAssessed(b) => b.validate(),
            EventBody::ConflictCandidateDetected(b) => b.validate(),
            EventBody::FreshnessTransitioned(b) => b.validate(),
            EventBody::ConflictComparisonRegistered(b) => b.validate(),
            EventBody::ConflictClassified(b) => b.validate(),
            EventBody::ContradictionOpened(b) => b.validate(),
            EventBody::ContradictionClosed(b) => b.validate(),
            EventBody::ContradictionBackfillCompleted(b) => b.validate(),
        }
    }

    /// The canonical body JSON value (what a frame carries).
    pub fn to_value(&self) -> Result<serde_json::Value, String> {
        let value = match self {
            EventBody::BatchCommitted(b) => serde_json::to_value(b),
            EventBody::SourceRegistered(b) => serde_json::to_value(b),
            EventBody::ObservationRecorded(b) => serde_json::to_value(b),
            EventBody::SubjectResolved(b) => serde_json::to_value(b),
            EventBody::IndependenceRecorded(b) => serde_json::to_value(b),
            EventBody::BeliefCreated(b) => serde_json::to_value(b),
            EventBody::BeliefRevised(b) => serde_json::to_value(b),
            EventBody::BeliefRelation(b) => serde_json::to_value(b),
            EventBody::BeliefAttested(b) => serde_json::to_value(b),
            EventBody::EntityAliasAdded(b) => serde_json::to_value(b),
            EventBody::MigrationStarted(b) => serde_json::to_value(b),
            EventBody::MigrationCompleted(b) => serde_json::to_value(b),
            EventBody::ProjectionOverridden(b) => serde_json::to_value(b),
            EventBody::LedgerDivergence(b) => serde_json::to_value(b),
            EventBody::ReconciliationResolved(b) => serde_json::to_value(b),
            EventBody::BeliefQualificationChanged(b) => serde_json::to_value(b),
            EventBody::BeliefLifecycleChanged(b) => serde_json::to_value(b),
            EventBody::BeliefTombstoned(b) => serde_json::to_value(b),
            EventBody::BeliefContested(b) => serde_json::to_value(b),
            EventBody::EntityMerged(b) => serde_json::to_value(b),
            EventBody::ProposalSubmitted(b) => serde_json::to_value(b),
            EventBody::ProposalQueued(b) => serde_json::to_value(b),
            EventBody::ProposalDecisionRecorded(b) => serde_json::to_value(b),
            EventBody::ProposalApplied(b) => serde_json::to_value(b),
            EventBody::ProposalRejected(b) => serde_json::to_value(b),
            EventBody::ProposalReverted(b) => serde_json::to_value(b),
            EventBody::IngestAssessed(b) => serde_json::to_value(b),
            EventBody::CoverageFactRecorded(b) => serde_json::to_value(b),
            EventBody::CoverageAssessed(b) => serde_json::to_value(b),
            EventBody::CoverageGap(b) => serde_json::to_value(b),
            EventBody::CoverageRestored(b) => serde_json::to_value(b),
            EventBody::IngestSemanticAssessed(b) => serde_json::to_value(b),
            EventBody::ConflictCandidateDetected(b) => serde_json::to_value(b),
            EventBody::FreshnessTransitioned(b) => serde_json::to_value(b),
            EventBody::ConflictComparisonRegistered(b) => serde_json::to_value(b),
            EventBody::ConflictClassified(b) => serde_json::to_value(b),
            EventBody::ContradictionOpened(b) => serde_json::to_value(b),
            EventBody::ContradictionClosed(b) => serde_json::to_value(b),
            EventBody::ContradictionBackfillCompleted(b) => serde_json::to_value(b),
        };
        value.map_err(|e| e.to_string())
    }
}

/// Decode one frame body. `Ok(None)` = a plumbing body (no `schema` key or
/// not an object) — valid, indexable, zero epistemic effect. `Ok(Some)` = a
/// canonical schema-v1 body. `Err` = a body that CLAIMS schema membership
/// but fails it; the reducer records a deterministic anomaly, never skips
/// silently.
pub fn decode_body(kind: &str, body: &serde_json::Value) -> Result<Option<EventBody>, String> {
    let Some(object) = body.as_object() else {
        return Ok(None);
    };
    let Some(schema) = object.get("schema") else {
        return Ok(None);
    };
    if schema.as_u64() != Some(BODY_SCHEMA) {
        return Err(format!("unsupported body schema {schema}"));
    }
    if RESERVED_KINDS.contains(&kind) {
        return Err(format!(
            "kind {kind} is reserved vocabulary — its body is defined in M24, not here"
        ));
    }

    // Parse typed, then the byte round-trip gate: what we would re-emit
    // must equal what arrived, or the body is not canonical schema-v1.
    fn gate<T: serde::de::DeserializeOwned + Serialize>(
        kind: &str,
        body: &serde_json::Value,
    ) -> Result<T, String> {
        let typed: T = serde_json::from_value(body.clone()).map_err(|e| format!("{kind}: {e}"))?;
        let reserialized = canonical_json(&typed)?;
        let original = canonical_json(body)?;
        if reserialized != original {
            return Err(format!(
                "{kind}: body is not canonical schema-v1 (unknown, reordered, or \
                 non-canonical fields survive a round trip only as different bytes)"
            ));
        }
        Ok(typed)
    }

    let decoded = match kind {
        KIND_BATCH_COMMITTED => EventBody::BatchCommitted(Box::new(gate(kind, body)?)),
        KIND_SOURCE_REGISTERED => EventBody::SourceRegistered(Box::new(gate(kind, body)?)),
        KIND_OBSERVATION_RECORDED => EventBody::ObservationRecorded(Box::new(gate(kind, body)?)),
        KIND_SUBJECT_RESOLVED => EventBody::SubjectResolved(Box::new(gate(kind, body)?)),
        KIND_INDEPENDENCE_RECORDED => EventBody::IndependenceRecorded(Box::new(gate(kind, body)?)),
        KIND_BELIEF_CREATED => EventBody::BeliefCreated(Box::new(gate(kind, body)?)),
        KIND_BELIEF_REVISED => EventBody::BeliefRevised(Box::new(gate(kind, body)?)),
        KIND_BELIEF_RELATION => EventBody::BeliefRelation(Box::new(gate(kind, body)?)),
        KIND_BELIEF_ATTESTED => EventBody::BeliefAttested(Box::new(gate(kind, body)?)),
        KIND_ENTITY_ALIAS_ADDED => EventBody::EntityAliasAdded(Box::new(gate(kind, body)?)),
        KIND_MIGRATION_STARTED => EventBody::MigrationStarted(Box::new(gate(kind, body)?)),
        KIND_MIGRATION_COMPLETED => EventBody::MigrationCompleted(Box::new(gate(kind, body)?)),
        KIND_PROJECTION_OVERRIDDEN => EventBody::ProjectionOverridden(Box::new(gate(kind, body)?)),
        KIND_LEDGER_DIVERGENCE => EventBody::LedgerDivergence(Box::new(gate(kind, body)?)),
        KIND_RECONCILIATION_RESOLVED => {
            EventBody::ReconciliationResolved(Box::new(gate(kind, body)?))
        }
        KIND_BELIEF_QUALIFICATION_CHANGED => {
            EventBody::BeliefQualificationChanged(Box::new(gate(kind, body)?))
        }
        KIND_BELIEF_LIFECYCLE_CHANGED => {
            EventBody::BeliefLifecycleChanged(Box::new(gate(kind, body)?))
        }
        KIND_BELIEF_TOMBSTONED => EventBody::BeliefTombstoned(Box::new(gate(kind, body)?)),
        KIND_BELIEF_CONTESTED => EventBody::BeliefContested(Box::new(gate(kind, body)?)),
        KIND_ENTITY_MERGED => EventBody::EntityMerged(Box::new(gate(kind, body)?)),
        KIND_PROPOSAL_SUBMITTED => EventBody::ProposalSubmitted(Box::new(gate(kind, body)?)),
        KIND_PROPOSAL_QUEUED => EventBody::ProposalQueued(Box::new(gate(kind, body)?)),
        KIND_PROPOSAL_DECISION_RECORDED => {
            EventBody::ProposalDecisionRecorded(Box::new(gate(kind, body)?))
        }
        KIND_PROPOSAL_APPLIED => EventBody::ProposalApplied(Box::new(gate(kind, body)?)),
        KIND_PROPOSAL_REJECTED => EventBody::ProposalRejected(Box::new(gate(kind, body)?)),
        KIND_PROPOSAL_REVERTED => EventBody::ProposalReverted(Box::new(gate(kind, body)?)),
        KIND_INGEST_ASSESSED => EventBody::IngestAssessed(Box::new(gate(kind, body)?)),
        KIND_COVERAGE_FACT_RECORDED => EventBody::CoverageFactRecorded(Box::new(gate(kind, body)?)),
        KIND_COVERAGE_ASSESSED => EventBody::CoverageAssessed(Box::new(gate(kind, body)?)),
        KIND_COVERAGE_GAP => EventBody::CoverageGap(Box::new(gate(kind, body)?)),
        KIND_COVERAGE_RESTORED => EventBody::CoverageRestored(Box::new(gate(kind, body)?)),
        KIND_INGEST_SEMANTIC_ASSESSED => {
            EventBody::IngestSemanticAssessed(Box::new(gate(kind, body)?))
        }
        KIND_CONFLICT_CANDIDATE_DETECTED => {
            EventBody::ConflictCandidateDetected(Box::new(gate(kind, body)?))
        }
        KIND_FRESHNESS_TRANSITIONED => {
            EventBody::FreshnessTransitioned(Box::new(gate(kind, body)?))
        }
        KIND_CONFLICT_COMPARISON_REGISTERED => {
            EventBody::ConflictComparisonRegistered(Box::new(gate(kind, body)?))
        }
        KIND_CONFLICT_CLASSIFIED => EventBody::ConflictClassified(Box::new(gate(kind, body)?)),
        KIND_CONTRADICTION_OPENED => EventBody::ContradictionOpened(Box::new(gate(kind, body)?)),
        KIND_CONTRADICTION_CLOSED => EventBody::ContradictionClosed(Box::new(gate(kind, body)?)),
        KIND_CONTRADICTION_BACKFILL_COMPLETED => {
            EventBody::ContradictionBackfillCompleted(Box::new(gate(kind, body)?))
        }
        other => {
            return Err(format!(
                "kind {other} carries a schema-v1 body but is not in this build's vocabulary"
            ))
        }
    };
    Ok(Some(decoded))
}

#[cfg(test)]
pub(crate) mod tests;
