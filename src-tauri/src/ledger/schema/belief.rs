//! Belief bodies, explicit basis, relations, attestation, and alias
//! registration (M22.1, D8).
//!
//! "Attestation is not evidence": `belief.attested` is structurally
//! excluded from BeliefBasis and lineage — the enums here simply have no
//! place to put it, and the reducer refuses the reference.

use serde::{Deserialize, Serialize};

use super::normalize::normalize_alias_v1;
use super::subject::SubjectRef;
use super::value::{validate_field_path, TypedValue};
use super::{canonical_json, is_id128, is_sha256, schema_body, sha256_first128};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BasisRole {
    Supports,
    Opposes,
    Context,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BasisLink {
    pub observation_event_id: String,
    pub role: BasisRole,
}

/// Every revision declares its evidence state. `unsupported` is STATE with a
/// reason, never an empty list read as weak support.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BeliefBasis {
    Unsupported { reason: String },
    Linked { links: Vec<BasisLink> },
}

impl BeliefBasis {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            BeliefBasis::Unsupported { reason } => {
                if reason.is_empty() {
                    return Err("unsupported basis requires a non-empty reason".into());
                }
            }
            BeliefBasis::Linked { links } => {
                if links.is_empty() {
                    return Err(
                        "linked basis requires links — an empty list is not weak support, \
                         it is the unsupported state mis-spelled"
                            .into(),
                    );
                }
                let mut seen = std::collections::BTreeSet::new();
                for link in links {
                    if !is_id128(&link.observation_event_id) {
                        return Err(format!(
                            "basis link {:?} is not an event id",
                            link.observation_event_id
                        ));
                    }
                    if !seen.insert(link.observation_event_id.as_str()) {
                        return Err(format!(
                            "duplicate basis link {}",
                            link.observation_event_id
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

schema_body! {
    /// A new Belief (draft). The subject is always resolved — a Belief about
    /// nobody is not a Belief.
    pub struct BeliefCreated {
        pub belief_id: String,
        pub subject: SubjectRef,
        pub content: String,
        pub fields: serde_json::Value,
        pub basis: BeliefBasis,
    }
}

impl BeliefCreated {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        if !matches!(self.subject, SubjectRef::Resolved { .. }) {
            return Err("belief.created subject must be resolved".into());
        }
        self.subject.validate()?;
        if !self.fields.is_object() {
            return Err("belief fields must be a JSON object".into());
        }
        self.basis.validate()
    }
}

/// One revision patch operation: pointer plus typed before/after. `before`
/// must match prior committed state (reduce-time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchOp {
    pub field_path: String,
    pub before: TypedValue,
    pub after: TypedValue,
}

schema_body! {
    /// A content/field revision with an explicit basis state. An empty patch
    /// is legal ONLY when the canonical basis changes (the support-only
    /// revision); a total no-op is refused — both at reduce time, where the
    /// prior state lives.
    pub struct BeliefRevised {
        pub belief_id: String,
        pub patch: Vec<PatchOp>,
        pub basis: BeliefBasis,
    }
}

impl BeliefRevised {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for op in &self.patch {
            validate_field_path(&op.field_path)?;
            if !seen.insert(op.field_path.as_str()) {
                return Err(format!("duplicate patch pointer {}", op.field_path));
            }
            op.before.validate()?;
            op.after.validate()?;
        }
        self.basis.validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationAction {
    Add,
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    Supersedes,
    Refines,
    Contradicts,
}

impl RelationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RelationKind::Supersedes => "supersedes",
            RelationKind::Refines => "refines",
            RelationKind::Contradicts => "contradicts",
        }
    }
}

/// First 128 bits of `SHA-256("cerebro-relation-v1\0" +
/// canonical_json([from, to, relation]))`. Direction and array order are
/// significant; never substitute an implementation-defined hash.
pub fn derive_relation_id(from: &str, to: &str, relation: RelationKind) -> String {
    let tuple = canonical_json(&serde_json::json!([from, to, relation.as_str()]))
        .expect("three strings always serialize");
    let mut bytes = Vec::with_capacity("cerebro-relation-v1".len() + 1 + tuple.len());
    bytes.extend_from_slice(b"cerebro-relation-v1\0");
    bytes.extend_from_slice(tuple.as_bytes());
    sha256_first128(&bytes)
}

schema_body! {
    /// Add or remove one stable inter-belief relation. `add` refuses a live
    /// duplicate; `remove` requires the matching live relation and keeps its
    /// history; endpoints must name committed (or earlier-staged) Beliefs —
    /// all reduce-time, over the id this body pins.
    pub struct BeliefRelation {
        pub relation_id: String,
        pub action: RelationAction,
        pub from: String,
        pub to: String,
        pub relation: RelationKind,
    }
}

impl BeliefRelation {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.from) || !is_id128(&self.to) {
            return Err("relation endpoints must be stable belief ids".into());
        }
        let derived = derive_relation_id(&self.from, &self.to, self.relation);
        if self.relation_id != derived {
            return Err(format!(
                "relation_id {} does not match its derivation {derived}",
                self.relation_id
            ));
        }
        Ok(())
    }
}

/// Domain prefix for the attested-content hash — computed over the exact
/// byte-stable `project()` output of the pinned revision event.
pub fn attested_content_hash(projected: &[u8]) -> String {
    let mut bytes = Vec::with_capacity("cerebro-attested-content-v1".len() + 1 + projected.len());
    bytes.extend_from_slice(b"cerebro-attested-content-v1\0");
    bytes.extend_from_slice(projected);
    crate::ledger::sha256_hex(&bytes)
}

schema_body! {
    /// Human review attestation (D8 channel 1). Pins BOTH the generating
    /// revision event id and that revision's projected content hash; the
    /// pair must name the same committed revision (reduce-time), so a
    /// basis-only revision can never be confused with an earlier
    /// equal-content one. Never evidence, never a basis target.
    pub struct BeliefAttested {
        pub belief_id: String,
        pub attested_belief_revision_event_id: String,
        pub attested_content_hash: String,
    }
}

impl BeliefAttested {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.belief_id) {
            return Err("belief_id is not a stable 128-bit hex id".into());
        }
        if !is_id128(&self.attested_belief_revision_event_id) {
            return Err("attested_belief_revision_event_id is not an event id".into());
        }
        if !is_sha256(&self.attested_content_hash) {
            return Err("attested_content_hash is not SHA-256 hex".into());
        }
        Ok(())
    }
}

schema_body! {
    /// Explicit canonical alias registration (§84). `alias` preserves the
    /// display bytes; `normalized_alias` is the computed uniqueness key.
    pub struct EntityAliasAdded {
        pub entity_id: String,
        pub alias: String,
        pub normalized_alias: String,
    }
}

impl EntityAliasAdded {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.entity_id) {
            return Err("entity_id is not a stable 128-bit hex id".into());
        }
        if self.alias.is_empty() {
            return Err("alias must preserve a non-empty source spelling".into());
        }
        let computed = normalize_alias_v1(&self.alias);
        if computed.is_empty() {
            return Err("alias normalizes to empty — not a registrable alias".into());
        }
        if self.normalized_alias != computed {
            return Err(format!(
                "normalized_alias {:?} does not equal normalize_alias_v1(alias) {computed:?}",
                self.normalized_alias
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{belief_created, belief_revised, common, ID_A, ID_B};
    use super::*;

    #[test]
    fn basis_states_are_explicit_never_an_empty_list() {
        BeliefBasis::Unsupported {
            reason: "migrated from OKF without observations".into(),
        }
        .validate()
        .unwrap();
        assert!(BeliefBasis::Unsupported { reason: "".into() }
            .validate()
            .is_err());
        assert!(BeliefBasis::Linked { links: vec![] }.validate().is_err());
        assert!(BeliefBasis::Linked {
            links: vec![
                BasisLink {
                    observation_event_id: ID_A.into(),
                    role: BasisRole::Supports
                },
                BasisLink {
                    observation_event_id: ID_A.into(),
                    role: BasisRole::Opposes
                },
            ]
        }
        .validate()
        .is_err());
    }

    #[test]
    fn belief_created_requires_a_resolved_subject_and_object_fields() {
        let event = belief_created();
        event.validate().unwrap();

        let mut unresolved = event.clone();
        unresolved.subject = SubjectRef::Unresolved {
            raw_ref: "someone".into(),
            aliases: vec![],
        };
        assert!(unresolved.validate().unwrap_err().contains("resolved"));

        let mut none = event.clone();
        none.subject = SubjectRef::None;
        assert!(none.validate().is_err());

        let mut bad_fields = event;
        bad_fields.fields = serde_json::json!("not an object");
        assert!(bad_fields.validate().is_err());
    }

    #[test]
    fn revision_pointers_are_unique_and_valid() {
        let event = belief_revised();
        event.validate().unwrap();

        let mut dup = event.clone();
        dup.patch.push(dup.patch[0].clone());
        assert!(dup.validate().unwrap_err().contains("duplicate"));

        let mut bad_path = event.clone();
        bad_path.patch[0].field_path = "/nowhere".into();
        assert!(bad_path.validate().is_err());

        // An empty patch is structurally legal (support-only revision); the
        // basis-change requirement is enforced against prior state.
        let mut support_only = event;
        support_only.patch.clear();
        support_only.validate().unwrap();
    }

    #[test]
    fn relation_ids_are_derived_directional_and_pinned() {
        let id = derive_relation_id(ID_A, ID_B, RelationKind::Supersedes);
        assert_eq!(id.len(), 32);
        assert_ne!(id, derive_relation_id(ID_B, ID_A, RelationKind::Supersedes));
        assert_ne!(id, derive_relation_id(ID_A, ID_B, RelationKind::Refines));
        // Pinned bytes: the canonical tuple is a JSON array of three strings.
        let tuple = format!(r#"["{ID_A}","{ID_B}","supersedes"]"#);
        let mut bytes = b"cerebro-relation-v1\0".to_vec();
        bytes.extend_from_slice(tuple.as_bytes());
        assert_eq!(id, crate::ledger::sha256_hex(&bytes)[..32]);
    }

    #[test]
    fn a_relation_with_a_forged_id_is_refused() {
        let (schema, actor) = common("agent:run-1");
        let mut event = BeliefRelation {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            relation_id: derive_relation_id(ID_A, ID_B, RelationKind::Contradicts),
            action: RelationAction::Add,
            from: ID_A.into(),
            to: ID_B.into(),
            relation: RelationKind::Contradicts,
        };
        event.validate().unwrap();
        event.relation = RelationKind::Refines;
        assert!(event.validate().unwrap_err().contains("derivation"));
    }

    #[test]
    fn attestation_pins_id_and_hash_shapes() {
        let (schema, actor) = common("human:josef");
        let mut event = BeliefAttested {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: ID_A.into(),
            attested_belief_revision_event_id: ID_B.into(),
            attested_content_hash: attested_content_hash(b"# Concept\n"),
        };
        event.validate().unwrap();
        event.attested_content_hash = "short".into();
        assert!(event.validate().is_err());
    }

    #[test]
    fn the_attested_hash_is_domain_separated() {
        let content = b"# Concept\n";
        assert_ne!(
            attested_content_hash(content),
            crate::ledger::sha256_hex(content),
            "a bare content hash must never verify as an attested-content hash"
        );
    }

    #[test]
    fn alias_bodies_pin_display_bytes_and_computed_key() {
        let (schema, actor) = common("human:josef");
        let mut event = EntityAliasAdded {
            schema,
            batch_id: None,
            idempotency_key: None,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            entity_id: ID_A.into(),
            alias: "Acme  Corp".into(),
            normalized_alias: "acme corp".into(),
        };
        event.validate().unwrap();
        event.normalized_alias = "acme  corp".into();
        assert!(event.validate().is_err());
        event.alias = " \t ".into();
        event.normalized_alias = String::new();
        assert!(event.validate().is_err(), "whitespace-only alias");
    }
}
