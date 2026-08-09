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
pub mod independence;
pub mod migration;
pub mod normalize;
pub mod observation;
pub mod resolution;
pub mod source;
pub mod subject;
pub mod value;

use serde::{Deserialize, Serialize};

pub use batch::BatchCommitted;
pub use belief::{
    derive_relation_id, BasisLink, BasisRole, BeliefAttested, BeliefBasis, BeliefCreated,
    BeliefRelation, BeliefRevised, EntityAliasAdded, PatchOp, RelationAction, RelationKind,
};
pub use independence::{IndependenceProof, IndependenceRecorded};
pub use migration::{migrate_id, MigrationCompleted, MigrationStarted};
pub use normalize::normalize_alias_v1;
pub use observation::{
    derive_authority, AbsenceRecord, AssertionBasis, AssertionFields, AssertionKind,
    AuthorityProvenance, DerivedContentPayload, ExtractedAssertionPayload, HumanAssertionForm,
    HumanAssertionPayload, ObservationKind, ObservationPayload, ObservationRecorded, Provenance,
    Scope, SourceSnapshotPayload, Stage, SubjectRole, SystemEventPayload,
};
pub use resolution::{ResolutionChange, ResolverTier, SubjectResolved};
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

/// Reserved M24 lifecycle vocabulary: the kinds are fixed NOW so nothing
/// else ever claims the names, but their bodies are deliberately undefined —
/// a schema-v1 body under one of these is refused, never guessed at.
pub const RESERVED_KINDS: [&str; 7] = [
    "belief.tombstoned",
    "proposal.submitted",
    "proposal.queued",
    "proposal.decision_recorded",
    "proposal.applied",
    "proposal.rejected",
    "proposal.reverted",
];

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
