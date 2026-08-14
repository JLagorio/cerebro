//! The discriminated op payloads (M24.3).
//!
//! **No generic patch, no free-form payload, no JSON escape hatch.** Every
//! op in the D5 ladder gets its own serde struct, so there is nowhere for a
//! proposal to hide a target or a transition. That is the property the whole
//! governance skeleton rests on: if `targets[]` had to be trusted to be
//! complete because the payload could name anything, expected-version CAS
//! would be checking a set the mutation is free to exceed.
//!
//! The agent-facing DTO is separate and deliberately impoverished
//! ([`AgentObservationDraft`]). It cannot name a source, a registration, an
//! authority provenance, a relationship role, an assertion basis, an
//! artifact hash, or a raw pointer, and it cannot select `human_assertion`,
//! `source_snapshot`, or `system_event`. The server resolves its run context
//! to an M22 `source.registered` and canonicalizes the result as
//! `agent_inferred`. Only trusted internal constructors — M23 human capture,
//! M25 ingestion, runtime code — can produce the privileged bodies. An
//! attempt to reach one is `untrusted_provenance`, refused rather than
//! silently overwritten, because overwriting would teach the model that the
//! field is optional rather than forbidden.

use serde::{Deserialize, Serialize};

use super::belief::{BeliefBasis, PatchOp, RelationAction, RelationKind};
use super::entity_merge::EntityReassignmentPlan;
use super::lifecycle::{QualificationProfileRef, TombstoneReason};
use super::observation::ObservationRecorded;
use super::resolution::ResolverTier;
use super::subject::SubjectRef;
use super::value::TypedValue;
use super::{canonical_json, is_id128, is_sha256};

/// Sorted, unique, non-empty ids — the shape every plural payload field has,
/// so two spellings of one operation cannot both exist.
pub(crate) fn sorted_unique(label: &str, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err(format!("{label} is empty"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for id in ids {
        if !is_id128(id) {
            return Err(format!(
                "{label} entry {id:?} is not a stable 128-bit hex id"
            ));
        }
        if !seen.insert(id.as_str()) {
            return Err(format!("{label} repeats {id}"));
        }
    }
    if seen.into_iter().collect::<Vec<_>>() != ids.iter().map(String::as_str).collect::<Vec<_>>() {
        return Err(format!("{label} is not sorted"));
    }
    Ok(())
}

fn id(label: &str, value: &str) -> Result<(), String> {
    if is_id128(value) {
        Ok(())
    } else {
        Err(format!("{label} is not a stable 128-bit hex id"))
    }
}

fn non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} is empty"))
    } else {
        Ok(())
    }
}

// --- Nested payload structs, all closed -----------------------------------

/// How a merge rewrites one relation incident to a merged Belief. Replacing
/// every merged endpoint with the survivor either collapses a self-edge,
/// lands on a tuple that is already live, or needs a new relation — and each
/// disposition fixes exactly whether `replacement` is present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationRewrite {
    pub prior_relation_id: String,
    pub prior_from: String,
    pub prior_to: String,
    pub relation: RelationKind,
    pub disposition: RewriteDisposition,
    pub replacement: Option<RewriteReplacement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewriteDisposition {
    CollapseSelf,
    ReuseExisting,
    AddReplacement,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RewriteReplacement {
    pub relation_id: String,
    pub from: String,
    pub to: String,
    pub relation: RelationKind,
}

impl RelationRewrite {
    pub fn validate(&self) -> Result<(), String> {
        id("prior_relation_id", &self.prior_relation_id)?;
        id("prior_from", &self.prior_from)?;
        id("prior_to", &self.prior_to)?;
        match (self.disposition, &self.replacement) {
            (RewriteDisposition::AddReplacement, Some(replacement)) => {
                id("replacement.relation_id", &replacement.relation_id)?;
                id("replacement.from", &replacement.from)?;
                id("replacement.to", &replacement.to)?;
                // The replacement's id must be M22's derived identity, or a
                // second identity for one relation tuple becomes possible.
                let derived = super::belief::derive_relation_id(
                    &replacement.from,
                    &replacement.to,
                    replacement.relation,
                );
                if derived != replacement.relation_id {
                    return Err(format!(
                        "replacement relation id {} is not the derived identity {derived}",
                        replacement.relation_id
                    ));
                }
                Ok(())
            }
            (RewriteDisposition::AddReplacement, None) => {
                Err("add_replacement without a replacement".into())
            }
            (_, Some(_)) => Err(format!(
                "{:?} carries a replacement — that disposition emits no add",
                self.disposition
            )),
            (_, None) => Ok(()),
        }
    }
}

/// Server-minted proof that two Beliefs are the SAME claim: same stable
/// subject, scope, temporal interval, and normalized content, with no
/// conflicting attestation. This is what makes `merge_beliefs_exact` LOW
/// while `merge_entities` is CRITICAL — one collapses duplicate records of
/// one claim, the other changes who something is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EquivalenceReceipt {
    pub receipt_id: String,
    pub index_head: String,
    pub belief_ids: Vec<String>,
    pub subject_id: String,
    pub scope_digest: String,
    pub valid_interval: Option<ValidInterval>,
    pub normalized_content_hash: String,
    pub attestation_conflict: bool,
    pub merged_basis: BeliefBasis,
    pub relation_rewrites: Vec<RelationRewrite>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidInterval {
    pub from: Option<String>,
    pub to: Option<String>,
}

impl EquivalenceReceipt {
    pub fn validate(&self) -> Result<(), String> {
        id("receipt_id", &self.receipt_id)?;
        id("index_head", &self.index_head)?;
        sorted_unique("equivalence_receipt.belief_ids", &self.belief_ids)?;
        if self.belief_ids.len() < 2 {
            return Err(
                "an equivalence receipt covering fewer than two beliefs proves nothing".into(),
            );
        }
        id("subject_id", &self.subject_id)?;
        if !is_sha256(&self.scope_digest) {
            return Err("scope_digest is not a sha256".into());
        }
        if !is_sha256(&self.normalized_content_hash) {
            return Err("normalized_content_hash is not a sha256".into());
        }
        // A conflicting attestation means two humans reviewed these records
        // and did not agree they were the same thing. That is not an exact
        // merge at any risk level.
        if self.attestation_conflict {
            return Err(
                "equivalence receipt reports an attestation conflict — exactness is not proven"
                    .into(),
            );
        }
        self.merged_basis.validate()?;
        let mut seen = std::collections::BTreeSet::new();
        for rewrite in &self.relation_rewrites {
            rewrite.validate()?;
            if !seen.insert(rewrite.prior_relation_id.as_str()) {
                return Err(format!(
                    "relation_rewrites names {} twice",
                    rewrite.prior_relation_id
                ));
            }
        }
        let given: Vec<&str> = self
            .relation_rewrites
            .iter()
            .map(|r| r.prior_relation_id.as_str())
            .collect();
        if seen.into_iter().collect::<Vec<_>>() != given {
            return Err("relation_rewrites is not in prior-relation-id order".into());
        }
        Ok(())
    }
}

/// One output of a split. It is a whole new Belief, so it carries what
/// `belief.created` carries — minus the basis, which is DERIVED from the
/// evidence assignment rather than declared, so no output can claim support
/// the split did not give it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SplitOutput {
    pub belief_id: String,
    pub subject: SubjectRef,
    pub content: String,
    pub fields: serde_json::Value,
}

impl SplitOutput {
    pub fn validate(&self) -> Result<(), String> {
        id("split output belief_id", &self.belief_id)?;
        if !matches!(self.subject, SubjectRef::Resolved { .. }) {
            return Err("a split output's subject must be resolved".into());
        }
        self.subject.validate()?;
        if !self.fields.is_object() {
            return Err("split output fields must be a JSON object".into());
        }
        Ok(())
    }
}

/// Which output inherits one of the predecessor's evidence links, and in
/// what role. Every prior link appears exactly once — assigning evidence is
/// the interpretive act that makes split HIGH.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceAssignment {
    pub observation_event_id: String,
    pub role: super::belief::BasisRole,
    pub output_belief_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupersedePair {
    pub belief_id: String,
    pub successor_id: String,
}

/// The conflict classifier's structured outcome (M27 computes it; M24 types
/// it). The first five are RESOLVED — the apparent disagreement was scope,
/// stage, time, or granularity — and the last three leave an edge open.
///
/// This is the ONE closed set, read by both the proposal that ASKS for a
/// classification and the [`super::ConflictClassified`] event that records
/// one. M27.3a briefly declared a second, identical enum for the event; two
/// spellings of one closed set is the mirrored rule this repo forbids, and it
/// would have needed a mapping function whose only job was to be wrong once.
/// Comparing the proposal's outcome with the event's is now `==`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictOutcome {
    SameMeaning,
    ResolvedTemporally,
    ResolvedByScope,
    ResolvedByStage,
    ResolvedByGranularity,
    GenuineDirect,
    Partial,
    Conditional,
}

impl ConflictOutcome {
    /// Does this outcome leave a contradiction edge open? Unresolved
    /// outcomes add a same-batch `contradiction.opened`.
    pub fn is_unresolved(&self) -> bool {
        matches!(
            self,
            ConflictOutcome::GenuineDirect
                | ConflictOutcome::Partial
                | ConflictOutcome::Conditional
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ConflictOutcome::SameMeaning => "same_meaning",
            ConflictOutcome::ResolvedTemporally => "resolved_temporally",
            ConflictOutcome::ResolvedByScope => "resolved_by_scope",
            ConflictOutcome::ResolvedByStage => "resolved_by_stage",
            ConflictOutcome::ResolvedByGranularity => "resolved_by_granularity",
            ConflictOutcome::GenuineDirect => "genuine_direct",
            ConflictOutcome::Partial => "partial",
            ConflictOutcome::Conditional => "conditional",
        }
    }

    pub const ALL: [ConflictOutcome; 8] = [
        ConflictOutcome::SameMeaning,
        ConflictOutcome::ResolvedTemporally,
        ConflictOutcome::ResolvedByScope,
        ConflictOutcome::ResolvedByStage,
        ConflictOutcome::ResolvedByGranularity,
        ConflictOutcome::GenuineDirect,
        ConflictOutcome::Partial,
        ConflictOutcome::Conditional,
    ];
}

/// The ONLY observation shape an agent may author (M26's wire type, typed
/// here so M24 goldens can prove every escalation attempt is refused).
///
/// Note what is absent and cannot be added: source id, registration event,
/// authority provenance, relationship role, assertion basis, artifact hash,
/// raw pointer. Note also which observation kinds are unreachable:
/// `human_assertion`, `source_snapshot`, `system_event`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentObservationDraft {
    AgentExtractedAssertion {
        ingest_context_id: String,
        assertion_kind: super::observation::AssertionKind,
        predicate: String,
        value: TypedValue,
        scope: super::observation::Scope,
        extracted_text: String,
        extractor_version: String,
    },
    AgentDerivedContent {
        source_observation_event_ids: Vec<String>,
        assertion_kind: super::observation::AssertionKind,
        predicate: String,
        value: TypedValue,
        scope: super::observation::Scope,
        rendered_text: String,
        generator_version: String,
    },
}

impl AgentObservationDraft {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            AgentObservationDraft::AgentExtractedAssertion {
                ingest_context_id,
                predicate,
                value,
                extracted_text,
                extractor_version,
                ..
            } => {
                non_empty("ingest_context_id", ingest_context_id)?;
                non_empty("predicate", predicate)?;
                value.validate()?;
                non_empty("extracted_text", extracted_text)?;
                non_empty("extractor_version", extractor_version)
            }
            AgentObservationDraft::AgentDerivedContent {
                source_observation_event_ids,
                predicate,
                value,
                rendered_text,
                generator_version,
                ..
            } => {
                sorted_unique("source_observation_event_ids", source_observation_event_ids)?;
                non_empty("predicate", predicate)?;
                value.validate()?;
                non_empty("rendered_text", rendered_text)?;
                non_empty("generator_version", generator_version)
            }
        }
    }
}

// --- The op union ---------------------------------------------------------

/// Every op the D5 ladder governs, one struct each.
///
/// The variant names are the `OP_INVENTORY` strings, and the tripwire in
/// `policy::mod` asserts this union, that inventory, and the policy table
/// name exactly the same set — so an op cannot ship ungoverned, and the
/// table cannot carry a row for something nothing constructs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum ProposalOp {
    AppendObservation {
        observation: Box<ObservationRecorded>,
    },
    CacheSource {
        source_id: String,
        artifact_hash: String,
        raw_pointer: String,
    },
    CreateBelief {
        belief_id: String,
        subject: SubjectRef,
        content: String,
        fields: serde_json::Value,
        basis: BeliefBasis,
        distinctness_reason: String,
    },
    UpdateBelief {
        belief_id: String,
        patch: Vec<PatchOp>,
        basis: BeliefBasis,
    },
    SupersedeBelief {
        belief_id: String,
        successor_id: String,
    },
    PromoteDraft {
        belief_id: String,
        qualification_profile: QualificationProfileRef,
    },
    EditRelation {
        relation_id: String,
        action: RelationAction,
        from: String,
        to: String,
        relation: RelationKind,
    },
    ContestBelief {
        belief_id: String,
        counterevidence_refs: Vec<String>,
    },
    ClassifyConflict {
        comparison_id: String,
        outcome: ConflictOutcome,
        basis_refs: Vec<String>,
        /// WHICH model reached this, and under which prompt (M27.4d).
        ///
        /// Supplied rather than server-observed, because the server cannot
        /// see either: the proposer is the only party that knows what
        /// produced the judgement. That is also why a semantic verdict is
        /// stamped `agent_supplied` — the ledger records whose opinion it is,
        /// never that it is true.
        model_id: String,
        prompt_version: String,
    },
    AddEntityAlias {
        entity_id: String,
        alias: String,
    },
    CorrectObservationSubject {
        observation_event_id: String,
        prior_resolution_event_id: String,
        from_entity_id: String,
        to_entity_id: String,
        resolver_tier: ResolverTier,
        basis_event_ids: Vec<String>,
        reason: String,
    },
    ConfirmObservationIndependence {
        left_observation_event_id: String,
        right_observation_event_id: String,
        basis_event_ids: Vec<String>,
        reason: String,
    },
    MergeBeliefsExact {
        survivor_id: String,
        merged_ids: Vec<String>,
        equivalence_receipt: Box<EquivalenceReceipt>,
    },
    MergeEntities {
        survivor_id: String,
        merged_ids: Vec<String>,
        reassignment_plan: Box<EntityReassignmentPlan>,
    },
    SplitBelief {
        belief_id: String,
        primary_output_id: String,
        outputs: Vec<SplitOutput>,
        evidence_assignment: Vec<EvidenceAssignment>,
    },
    TombstoneBelief {
        belief_id: String,
        replacement_id: Option<String>,
        reason_code: TombstoneReason,
    },
    ArchiveBelief {
        belief_id: String,
        /// Always null. Archive is the deliberate no-replacement retirement;
        /// the field exists so the payload shape is uniform and a caller
        /// that means "deprecate" cannot express it here by accident.
        replacement_id: Option<String>,
    },
    Deprecate {
        belief_id: String,
        replacement_id: Option<String>,
    },
    MassSupersede {
        replacements: Vec<SupersedePair>,
    },
    RevertProposal {
        applied_proposal_id: String,
        applied_event_ids: Vec<String>,
    },
}

impl ProposalOp {
    /// Every kind this union can spell, sorted. The tripwire in
    /// `policy::mod` asserts this equals `OP_INVENTORY` and the table's op
    /// rows exactly — so a variant added here without a table row fails the
    /// suite instead of shipping ungoverned.
    pub const ALL_KINDS: [&'static str; 20] = [
        "add_entity_alias",
        "append_observation",
        "archive_belief",
        "cache_source",
        "classify_conflict",
        "confirm_observation_independence",
        "contest_belief",
        "correct_observation_subject",
        "create_belief",
        "deprecate",
        "edit_relation",
        "mass_supersede",
        "merge_beliefs_exact",
        "merge_entities",
        "promote_draft",
        "revert_proposal",
        "split_belief",
        "supersede_belief",
        "tombstone_belief",
        "update_belief",
    ];

    /// The `OP_INVENTORY` / policy-table name for this variant.
    pub fn kind(&self) -> &'static str {
        match self {
            ProposalOp::AppendObservation { .. } => "append_observation",
            ProposalOp::CacheSource { .. } => "cache_source",
            ProposalOp::CreateBelief { .. } => "create_belief",
            ProposalOp::UpdateBelief { .. } => "update_belief",
            ProposalOp::SupersedeBelief { .. } => "supersede_belief",
            ProposalOp::PromoteDraft { .. } => "promote_draft",
            ProposalOp::EditRelation { .. } => "edit_relation",
            ProposalOp::ContestBelief { .. } => "contest_belief",
            ProposalOp::ClassifyConflict { .. } => "classify_conflict",
            ProposalOp::AddEntityAlias { .. } => "add_entity_alias",
            ProposalOp::CorrectObservationSubject { .. } => "correct_observation_subject",
            ProposalOp::ConfirmObservationIndependence { .. } => "confirm_observation_independence",
            ProposalOp::MergeBeliefsExact { .. } => "merge_beliefs_exact",
            ProposalOp::MergeEntities { .. } => "merge_entities",
            ProposalOp::SplitBelief { .. } => "split_belief",
            ProposalOp::TombstoneBelief { .. } => "tombstone_belief",
            ProposalOp::ArchiveBelief { .. } => "archive_belief",
            ProposalOp::Deprecate { .. } => "deprecate",
            ProposalOp::MassSupersede { .. } => "mass_supersede",
            ProposalOp::RevertProposal { .. } => "revert_proposal",
        }
    }

    /// Payload discriminators the policy table's `conditional_capabilities`
    /// and `transition_selector` may match on. String leaves only — a
    /// condition can never depend on a nested object.
    pub fn payload_conditions(&self) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        if let ProposalOp::EditRelation {
            action, relation, ..
        } = self
        {
            out.insert(
                "action".to_string(),
                match action {
                    RelationAction::Add => "add".to_string(),
                    RelationAction::Remove => "remove".to_string(),
                },
            );
            out.insert("relation".to_string(), relation.as_str().to_string());
        }
        out
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            // `ObservationRecorded::validate` returns the derived authority
            // it computed; the op only needs to know it was derivable.
            ProposalOp::AppendObservation { observation } => observation.validate().map(|_| ()),
            ProposalOp::CacheSource {
                source_id,
                artifact_hash,
                raw_pointer,
            } => {
                id("source_id", source_id)?;
                if !is_sha256(artifact_hash) {
                    return Err("artifact_hash is not a sha256".into());
                }
                non_empty("raw_pointer", raw_pointer)
            }
            ProposalOp::CreateBelief {
                belief_id,
                subject,
                fields,
                basis,
                distinctness_reason,
                ..
            } => {
                id("belief_id", belief_id)?;
                if !matches!(subject, SubjectRef::Resolved { .. }) {
                    return Err("a created Belief's subject must be resolved".into());
                }
                subject.validate()?;
                if !fields.is_object() {
                    return Err("belief fields must be a JSON object".into());
                }
                basis.validate()?;
                // §15: creating requires saying why this is not one of the
                // things that already exists.
                non_empty("distinctness_reason", distinctness_reason)
            }
            ProposalOp::UpdateBelief {
                belief_id,
                patch,
                basis,
            } => {
                id("belief_id", belief_id)?;
                let mut seen = std::collections::BTreeSet::new();
                for op in patch {
                    super::value::validate_field_path(&op.field_path)?;
                    if !seen.insert(op.field_path.as_str()) {
                        return Err(format!("duplicate patch pointer {}", op.field_path));
                    }
                    op.before.validate()?;
                    op.after.validate()?;
                }
                // An EMPTY patch is legal here and only here: it is the
                // canonical support-only revision, where independent
                // corroboration changes the basis with no field diff. That
                // the basis actually changed is a reduce-time check, where
                // the prior state lives.
                basis.validate()
            }
            ProposalOp::SupersedeBelief {
                belief_id,
                successor_id,
            } => {
                id("belief_id", belief_id)?;
                id("successor_id", successor_id)?;
                if belief_id == successor_id {
                    return Err("a Belief cannot supersede itself".into());
                }
                Ok(())
            }
            ProposalOp::PromoteDraft {
                belief_id,
                qualification_profile,
            } => {
                id("belief_id", belief_id)?;
                qualification_profile.validate()
            }
            ProposalOp::EditRelation {
                relation_id,
                from,
                to,
                relation,
                ..
            } => {
                id("relation_id", relation_id)?;
                id("from", from)?;
                id("to", to)?;
                if from == to {
                    return Err("a relation from a Belief to itself is not a relation".into());
                }
                // The caller's id must BE M22's derived identity, so one
                // relation tuple can never acquire a second identity.
                let derived = super::belief::derive_relation_id(from, to, *relation);
                if &derived != relation_id {
                    return Err(format!(
                        "relation_id {relation_id} is not the derived identity {derived}"
                    ));
                }
                Ok(())
            }
            ProposalOp::ContestBelief {
                belief_id,
                counterevidence_refs,
            } => {
                id("belief_id", belief_id)?;
                sorted_unique("counterevidence_refs", counterevidence_refs)
            }
            ProposalOp::ClassifyConflict {
                comparison_id,
                basis_refs,
                model_id,
                prompt_version,
                ..
            } => {
                id("comparison_id", comparison_id)?;
                // A semantic judgement with no evidence is an opinion, and an
                // opinion with no attribution is a rumour. Both refuse here
                // rather than at the reducer, so the card can say which.
                if basis_refs.is_empty() {
                    return Err(
                        "basis_refs must name the evidence this judgement rests on".to_string()
                    );
                }
                non_empty("model_id", model_id)?;
                non_empty("prompt_version", prompt_version)?;
                sorted_unique("basis_refs", basis_refs)
            }
            ProposalOp::AddEntityAlias { entity_id, alias } => {
                id("entity_id", entity_id)?;
                // The DISPLAY spelling is what a caller supplies; the server
                // computes the normalized key. A caller-supplied
                // normalization could otherwise claim a key it did not earn.
                non_empty("alias", alias)?;
                if super::normalize::normalize_alias_v1(alias).is_empty() {
                    return Err("alias normalizes to nothing".into());
                }
                Ok(())
            }
            ProposalOp::CorrectObservationSubject {
                observation_event_id,
                prior_resolution_event_id,
                from_entity_id,
                to_entity_id,
                basis_event_ids,
                reason,
                ..
            } => {
                id("observation_event_id", observation_event_id)?;
                id("prior_resolution_event_id", prior_resolution_event_id)?;
                id("from_entity_id", from_entity_id)?;
                id("to_entity_id", to_entity_id)?;
                if from_entity_id == to_entity_id {
                    return Err("a correction that changes nothing is not a correction".into());
                }
                sorted_unique("basis_event_ids", basis_event_ids)?;
                non_empty("reason", reason)
            }
            ProposalOp::ConfirmObservationIndependence {
                left_observation_event_id,
                right_observation_event_id,
                basis_event_ids,
                reason,
            } => {
                id("left_observation_event_id", left_observation_event_id)?;
                id("right_observation_event_id", right_observation_event_id)?;
                if left_observation_event_id == right_observation_event_id {
                    return Err("an Observation is not independent of itself".into());
                }
                sorted_unique("basis_event_ids", basis_event_ids)?;
                non_empty("reason", reason)
            }
            ProposalOp::MergeBeliefsExact {
                survivor_id,
                merged_ids,
                equivalence_receipt,
            } => {
                id("survivor_id", survivor_id)?;
                sorted_unique("merged_ids", merged_ids)?;
                if merged_ids.contains(survivor_id) {
                    return Err("survivor_id appears in merged_ids".into());
                }
                equivalence_receipt.validate()?;
                // The receipt must cover EXACTLY this merge, or it is proof
                // about some other pair of records.
                let mut expected: Vec<String> = merged_ids.clone();
                expected.push(survivor_id.clone());
                expected.sort();
                if equivalence_receipt.belief_ids != expected {
                    return Err(
                        "equivalence receipt does not cover exactly the survivor and merged ids"
                            .into(),
                    );
                }
                Ok(())
            }
            ProposalOp::MergeEntities {
                survivor_id,
                merged_ids,
                reassignment_plan,
            } => {
                id("survivor_id", survivor_id)?;
                sorted_unique("merged_ids", merged_ids)?;
                reassignment_plan.validate()?;
                if &reassignment_plan.survivor_id != survivor_id
                    || &reassignment_plan.merged_ids != merged_ids
                {
                    return Err("reassignment plan does not describe this merge".into());
                }
                Ok(())
            }
            ProposalOp::SplitBelief {
                belief_id,
                primary_output_id,
                outputs,
                evidence_assignment,
            } => {
                id("belief_id", belief_id)?;
                if outputs.len() < 2 {
                    return Err("a split into fewer than two outputs is a revision".into());
                }
                let mut output_ids = Vec::new();
                for output in outputs {
                    output.validate()?;
                    output_ids.push(output.belief_id.clone());
                }
                sorted_unique("split outputs", &output_ids)?;
                if !output_ids.contains(primary_output_id) {
                    return Err("primary_output_id names no declared output".into());
                }
                if output_ids.contains(belief_id) {
                    return Err("a split output cannot be the predecessor".into());
                }
                let mut seen = std::collections::BTreeSet::new();
                for assignment in evidence_assignment {
                    id("evidence assignment", &assignment.observation_event_id)?;
                    if !output_ids.contains(&assignment.output_belief_id) {
                        return Err(format!(
                            "evidence assigned to {}, which is not a declared output",
                            assignment.output_belief_id
                        ));
                    }
                    // Every prior link appears exactly ONCE; evidence in two
                    // places is how a split invents support.
                    if !seen.insert(assignment.observation_event_id.as_str()) {
                        return Err(format!(
                            "evidence {} is assigned to more than one output",
                            assignment.observation_event_id
                        ));
                    }
                }
                Ok(())
            }
            ProposalOp::TombstoneBelief {
                belief_id,
                replacement_id,
                ..
            }
            | ProposalOp::Deprecate {
                belief_id,
                replacement_id,
            } => {
                id("belief_id", belief_id)?;
                if let Some(replacement) = replacement_id {
                    id("replacement_id", replacement)?;
                    if replacement == belief_id {
                        return Err("a Belief cannot replace itself".into());
                    }
                }
                Ok(())
            }
            ProposalOp::ArchiveBelief {
                belief_id,
                replacement_id,
            } => {
                id("belief_id", belief_id)?;
                if replacement_id.is_some() {
                    return Err(
                        "archive takes no replacement — a retirement that names a successor is a \
                         deprecation, and the two are different lifecycle facts"
                            .into(),
                    );
                }
                Ok(())
            }
            ProposalOp::MassSupersede { replacements } => {
                if replacements.is_empty() {
                    return Err("mass_supersede with no replacements".into());
                }
                let mut predecessors = Vec::new();
                for pair in replacements {
                    id("supersede pair belief_id", &pair.belief_id)?;
                    id("supersede pair successor_id", &pair.successor_id)?;
                    if pair.belief_id == pair.successor_id {
                        return Err("a Belief cannot supersede itself".into());
                    }
                    predecessors.push(pair.belief_id.clone());
                }
                // Predecessors are distinct (one supersede each); successors
                // may be shared, which is how several records collapse into
                // one replacement.
                sorted_unique("mass_supersede predecessors", &predecessors)
            }
            ProposalOp::RevertProposal {
                applied_proposal_id,
                applied_event_ids,
            } => {
                id("applied_proposal_id", applied_proposal_id)?;
                sorted_unique("applied_event_ids", applied_event_ids)
            }
        }
    }

    /// Canonical bytes, for the symbolic operation digest.
    pub fn canonical(&self) -> Result<String, String> {
        canonical_json(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    #[test]
    fn all_kinds_lists_exactly_what_kind_can_return() {
        // `ALL_KINDS` is what the tripwire compares against the policy
        // table, so it must not be able to drift from the enum it claims to
        // describe. `kind()`'s match is exhaustive by the compiler; this
        // reads the strings out of that match, which is the same
        // parse-the-source discipline `tools.test.ts` uses to hold the MCP
        // catalog to mcp.rs.
        let source = include_str!("ops.rs");
        let start = source
            .find("pub fn kind(&self) -> &'static str {")
            .expect("kind() is still defined");
        let body = &source[start..];
        let end = body.find("\n    }\n").expect("kind() has an end");
        // Every string literal in the body, not every `=> "…"` line:
        // rustfmt wraps a long arm onto its own line, and a parser that
        // only saw the one-line shape would silently miss exactly the
        // longest op names.
        let mut returned: Vec<&str> = body[..end].split('"').skip(1).step_by(2).collect();
        returned.sort_unstable();
        returned.dedup();
        assert_eq!(
            returned,
            ProposalOp::ALL_KINDS.to_vec(),
            "ALL_KINDS and kind() disagree — a variant is ungoverned or a row is dead"
        );
    }

    #[test]
    fn every_variant_names_itself_and_the_names_are_unique() {
        // The kind strings are the contract with OP_INVENTORY and the table.
        let kinds = [
            ProposalOp::SupersedeBelief {
                belief_id: A.into(),
                successor_id: B.into(),
            }
            .kind(),
            ProposalOp::ArchiveBelief {
                belief_id: A.into(),
                replacement_id: None,
            }
            .kind(),
        ];
        assert_eq!(kinds, ["supersede_belief", "archive_belief"]);
    }

    #[test]
    fn archive_refuses_the_replacement_deprecate_accepts() {
        // Two different lifecycle facts. Letting archive carry a successor
        // would make "was this replaced?" unanswerable from the record.
        assert!(ProposalOp::ArchiveBelief {
            belief_id: A.into(),
            replacement_id: Some(B.into()),
        }
        .validate()
        .unwrap_err()
        .contains("archive takes no replacement"));
        assert!(ProposalOp::ArchiveBelief {
            belief_id: A.into(),
            replacement_id: None,
        }
        .validate()
        .is_ok());
        assert!(ProposalOp::Deprecate {
            belief_id: A.into(),
            replacement_id: Some(B.into()),
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn a_relation_id_must_be_the_derived_identity() {
        let derived = super::super::belief::derive_relation_id(A, B, RelationKind::Supersedes);
        assert!(ProposalOp::EditRelation {
            relation_id: derived.clone(),
            action: RelationAction::Add,
            from: A.into(),
            to: B.into(),
            relation: RelationKind::Supersedes,
        }
        .validate()
        .is_ok());
        // A caller-chosen id would let one tuple have two identities.
        assert!(ProposalOp::EditRelation {
            relation_id: "0".repeat(32),
            action: RelationAction::Add,
            from: A.into(),
            to: B.into(),
            relation: RelationKind::Supersedes,
        }
        .validate()
        .unwrap_err()
        .contains("derived identity"));
    }

    #[test]
    fn the_edit_relation_payload_exposes_the_conditions_the_table_matches_on() {
        let derived = super::super::belief::derive_relation_id(A, B, RelationKind::Contradicts);
        let op = ProposalOp::EditRelation {
            relation_id: derived,
            action: RelationAction::Add,
            from: A.into(),
            to: B.into(),
            relation: RelationKind::Contradicts,
        };
        let conditions = op.payload_conditions();
        assert_eq!(conditions.get("action").map(String::as_str), Some("add"));
        assert_eq!(
            conditions.get("relation").map(String::as_str),
            Some("contradicts")
        );
        // An op with no discriminators offers none, rather than inventing a
        // default that a condition could accidentally match.
        assert!(ProposalOp::ArchiveBelief {
            belief_id: A.into(),
            replacement_id: None,
        }
        .payload_conditions()
        .is_empty());
    }

    #[test]
    fn a_split_needs_two_outputs_a_named_primary_and_singly_assigned_evidence() {
        let output = |id: &str| SplitOutput {
            belief_id: id.into(),
            subject: SubjectRef::Resolved {
                entity_id: A.into(),
                aliases: vec![],
            },
            content: "c".into(),
            fields: serde_json::json!({}),
        };
        let c = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
        let d = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
        let evidence = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";

        let split = |outputs: Vec<SplitOutput>, assignment: Vec<EvidenceAssignment>| {
            ProposalOp::SplitBelief {
                belief_id: A.into(),
                primary_output_id: c.into(),
                outputs,
                evidence_assignment: assignment,
            }
        };
        let assign = |output: &str| EvidenceAssignment {
            observation_event_id: evidence.into(),
            role: super::super::belief::BasisRole::Supports,
            output_belief_id: output.into(),
        };

        assert!(split(vec![output(c), output(d)], vec![assign(c)])
            .validate()
            .is_ok());
        assert!(split(vec![output(c)], vec![])
            .validate()
            .unwrap_err()
            .contains("fewer than two outputs"));
        // Evidence in two places is how a split invents support.
        assert!(
            split(vec![output(c), output(d)], vec![assign(c), assign(d)])
                .validate()
                .unwrap_err()
                .contains("more than one output")
        );
    }

    #[test]
    fn an_exact_merge_receipt_must_cover_exactly_this_merge() {
        let receipt = |ids: Vec<&str>| EquivalenceReceipt {
            receipt_id: A.into(),
            index_head: B.into(),
            belief_ids: ids.into_iter().map(str::to_string).collect(),
            subject_id: A.into(),
            scope_digest: "1".repeat(64),
            valid_interval: None,
            normalized_content_hash: "2".repeat(64),
            attestation_conflict: false,
            merged_basis: BeliefBasis::Unsupported {
                reason: "test".into(),
            },
            relation_rewrites: vec![],
        };
        let merge = |receipt: EquivalenceReceipt| ProposalOp::MergeBeliefsExact {
            survivor_id: A.into(),
            merged_ids: vec![B.into()],
            equivalence_receipt: Box::new(receipt),
        };
        assert!(merge(receipt(vec![A, B])).validate().is_ok());
        let c = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
        assert!(merge(receipt(vec![A, c]))
            .validate()
            .unwrap_err()
            .contains("does not cover exactly"));
    }

    #[test]
    fn an_attestation_conflict_means_exactness_is_not_proven() {
        // Two humans reviewed these and did not agree they were one claim.
        // That is not a LOW-risk collapse at any declared risk.
        let mut receipt = EquivalenceReceipt {
            receipt_id: A.into(),
            index_head: B.into(),
            belief_ids: vec![A.into(), B.into()],
            subject_id: A.into(),
            scope_digest: "1".repeat(64),
            valid_interval: None,
            normalized_content_hash: "2".repeat(64),
            attestation_conflict: true,
            merged_basis: BeliefBasis::Unsupported {
                reason: "test".into(),
            },
            relation_rewrites: vec![],
        };
        assert!(receipt
            .validate()
            .unwrap_err()
            .contains("exactness is not proven"));
        receipt.attestation_conflict = false;
        assert!(receipt.validate().is_ok());
    }

    #[test]
    fn mass_supersede_allows_shared_successors_but_not_repeated_predecessors() {
        let c = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
        let pair = |from: &str, to: &str| SupersedePair {
            belief_id: from.into(),
            successor_id: to.into(),
        };
        // Several records collapsing into one replacement is the point.
        assert!(ProposalOp::MassSupersede {
            replacements: vec![pair(A, c), pair(B, c)],
        }
        .validate()
        .is_ok());
        // Superseding one Belief twice in one op has no meaning.
        assert!(ProposalOp::MassSupersede {
            replacements: vec![pair(A, B), pair(A, c)],
        }
        .validate()
        .is_err());
    }

    #[test]
    fn an_empty_update_patch_is_legal_because_corroboration_has_no_field_diff() {
        assert!(ProposalOp::UpdateBelief {
            belief_id: A.into(),
            patch: vec![],
            basis: BeliefBasis::Unsupported {
                reason: "test".into()
            },
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn the_agent_draft_cannot_spell_a_privileged_observation() {
        // The escalation attempts M26 will actually see. serde refuses them
        // at the door rather than the server overwriting them, so the model
        // learns the field is forbidden and not merely optional.
        for attempt in [
            serde_json::json!({ "kind": "human_assertion", "predicate": "p" }),
            serde_json::json!({ "kind": "source_snapshot", "predicate": "p" }),
            serde_json::json!({ "kind": "system_event", "predicate": "p" }),
            serde_json::json!({
                "kind": "agent_extracted_assertion",
                "ingest_context_id": "c", "assertion_kind": "presence", "predicate": "p",
                "value": { "type": "string", "value": "v" },
                "scope": { "stage": null, "revision": null, "environment": null, "geography": null },
                "extracted_text": "t", "extractor_version": "1",
                "authority_provenance": "trusted_human_capture"
            }),
            serde_json::json!({
                "kind": "agent_extracted_assertion",
                "ingest_context_id": "c", "assertion_kind": "presence", "predicate": "p",
                "value": { "type": "string", "value": "v" },
                "scope": { "stage": null, "revision": null, "environment": null, "geography": null },
                "extracted_text": "t", "extractor_version": "1",
                "source_id": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
            }),
        ] {
            assert!(
                serde_json::from_value::<AgentObservationDraft>(attempt.clone()).is_err(),
                "an agent draft accepted {attempt}"
            );
        }
    }

    #[test]
    fn a_legal_agent_draft_parses_and_validates() {
        let draft = serde_json::json!({
            "kind": "agent_extracted_assertion",
            "ingest_context_id": "run-7", "assertion_kind": "presence", "predicate": "soc",
            "value": { "type": "string", "value": "AMD" },
            "scope": { "stage": null, "revision": null, "environment": null, "geography": null },
            "extracted_text": "we moved to AMD", "extractor_version": "distill/1"
        });
        let parsed: AgentObservationDraft = serde_json::from_value(draft).unwrap();
        assert!(parsed.validate().is_ok());
    }
}
